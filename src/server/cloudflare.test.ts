import {
  applyD1Migrations,
  createExecutionContext,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CloudflareWorkerEnv } from "../entry/cloudflare.ts";
import worker from "../entry/cloudflare.ts";
import {
  SigningKeyPair,
  bytesToBase64,
  encodeHex,
  fingerprint,
  formatSha256NixBase32,
  unixNow,
  verifySignature,
} from "../shared/nix-format.ts";
import { OciClient } from "../shared/oci.ts";
import type {
  AdminStatusResponse,
  CommitRequest,
  GcReport,
  PlanRequest,
  PlanResponse,
  StorePathSummary,
} from "../shared/protocol.ts";
import { loadConfig } from "./config.ts";
import {
  MAIN_SCOPE,
  commitEntries,
  d1Adapter,
  evictStaleMainPaths,
  getNarInfo,
  listUnreferencedBlobs,
} from "./db.ts";

interface MockVersion {
  id: number;
  name: string;
  created_at?: string;
  updated_at?: string;
  metadata?: { container?: { tags?: string[] } };
}

interface MockStore {
  blobs: Map<string, Uint8Array>;
  manifests: Map<string, Uint8Array>;
  versions: Map<string, MockVersion[]>;
  blockedPackages: Set<string>;
  deletedVersions: number[];
  deletedPackages: string[];
  nextVersionId: number;
}

const encoder = new TextEncoder();

const base64UrlEncode = (bytes: Uint8Array): string =>
  bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

function toPem(der: Uint8Array, label: string): string {
  const lines = bytesToBase64(der).match(/.{1,64}/g) ?? [];

  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

async function generateRsaPair() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const jwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as JsonWebKey;

  return {
    privateKey: pair.privateKey,
    pkcs8Pem: toPem(pkcs8, "PRIVATE KEY"),
    jwk: { ...jwk, kid: "test-kid-1", alg: "RS256", use: "sig" },
  };
}

async function signJwt(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
): Promise<string> {
  const header = base64UrlEncode(
    encoder.encode(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-kid-1" }),
    ),
  );
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const input = `${header}.${payload}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      encoder.encode(input),
    ),
  );

  return `${input}.${base64UrlEncode(sig)}`;
}

async function signWebhook(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(body)),
  );

  return `sha256=${encodeHex(mac)}`;
}

const createMockFetch =
  (jwk: JsonWebKey, store: MockStore): typeof globalThis.fetch =>
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const method = req.method.toUpperCase();
    const url = new URL(req.url);

    if (url.pathname === "/.well-known/jwks") {
      return Response.json({ keys: [jwk] });
    }
    if (url.pathname === "/token") {
      return Response.json({ token: "mock-oci-token" });
    }

    const blobMatch =
      /^\/v2\/([^/]+)\/([^/]+)\/blobs\/(sha256:[0-9a-f]{64})$/.exec(
        url.pathname,
      );
    if (blobMatch) {
      const key = `${blobMatch[1]}/${blobMatch[2]}/${blobMatch[3]}`;
      if (!store.blobs.has(key)) {
        return new Response("not found", { status: 404 });
      }

      return method === "HEAD"
        ? new Response(null, { status: 200 })
        : new Response(null, {
            status: 307,
            headers: { Location: `https://cdn.example/cdn/${key}` },
          });
    }

    const manifestMatch = /^\/v2\/([^/]+)\/([^/]+)\/manifests\/(.+)$/.exec(
      url.pathname,
    );
    if (manifestMatch) {
      const found = store.manifests.get(
        `${manifestMatch[1]}/${manifestMatch[2]}/${manifestMatch[3]}`,
      );

      return found
        ? new Response(found as BodyInit, {
            status: 200,
            headers: {
              "Content-Type": "application/vnd.oci.image.manifest.v1+json",
            },
          })
        : new Response("not found", { status: 404 });
    }

    if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return Response.json(
        { token: "ghs_mock_install_token" },
        { status: 201 },
      );
    }

    const versionsListMatch =
      /^\/users\/([^/]+)\/packages\/container\/([^/]+)\/versions$/.exec(
        url.pathname,
      );
    if (versionsListMatch && method === "GET") {
      const all =
        store.versions.get(`${versionsListMatch[1]}/${versionsListMatch[2]}`) ??
        [];
      const perPage = Number.parseInt(
        url.searchParams.get("per_page") ?? "100",
        10,
      );
      const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
      const start = (page - 1) * perPage;

      return Response.json(all.slice(start, start + perPage));
    }

    const versionItemMatch =
      /^\/users\/([^/]+)\/packages\/container\/([^/]+)\/versions\/(\d+)$/.exec(
        url.pathname,
      );
    if (versionItemMatch) {
      const key = `${versionItemMatch[1]}/${versionItemMatch[2]}`;
      const vid = Number.parseInt(versionItemMatch[3], 10);
      const list = store.versions.get(key) ?? [];

      if (method === "GET") {
        const found = list.find((item) => item.id === vid);

        return found
          ? Response.json(found)
          : Response.json({ message: "Not Found" }, { status: 404 });
      }
      if (method === "DELETE") {
        if (store.blockedPackages.has(key)) {
          return Response.json(
            {
              message:
                "You cannot delete a public package version that has more than 5000 downloads.",
            },
            { status: 400 },
          );
        }
        if (list.length === 1) {
          return Response.json(
            {
              message:
                "You cannot delete the last version of a package. You must delete the package instead.",
            },
            { status: 400 },
          );
        }
        store.versions.set(
          key,
          list.filter((item) => item.id !== vid),
        );
        store.deletedVersions.push(vid);

        return new Response(null, { status: 204 });
      }
    }

    const pkgDeleteMatch =
      /^\/users\/([^/]+)\/packages\/container\/([^/]+)$/.exec(url.pathname);
    if (pkgDeleteMatch && method === "DELETE") {
      const key = `${pkgDeleteMatch[1]}/${pkgDeleteMatch[2]}`;
      if (store.blockedPackages.has(key)) {
        return Response.json(
          {
            message:
              "You cannot delete a public package that has more than 5000 downloads.",
          },
          { status: 400 },
        );
      }
      store.versions.delete(key);
      store.deletedPackages.push(key);

      return new Response(null, { status: 204 });
    }

    throw new Error(`unhandled mock fetch ${method} ${req.url}`);
  };

describe("firn worker", () => {
  let mainKey: SigningKeyPair;
  let prKey: SigningKeyPair;
  let rsa: Awaited<ReturnType<typeof generateRsaPair>>;
  let store: MockStore;
  let testEnv: CloudflareWorkerEnv;

  async function callWorker(
    input: Request | string,
    init?: RequestInit,
  ): Promise<Response> {
    const ctx = createExecutionContext();
    const req =
      typeof input === "string"
        ? new Request(`https://cache.so1ve.dev${input}`, init)
        : input;
    const response = await worker.fetch(req, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    return response;
  }

  const callAdmin = (path: string, method = "GET") =>
    callWorker(path, {
      method,
      headers: { Authorization: "Bearer admin-secret-token" },
    });

  const issueOidcJwt = (overrides: {
    repository?: string;
    ref?: string;
    event_name?: string;
  }) =>
    signJwt(rsa.privateKey, {
      iss: "https://oidc.mock",
      aud: "https://cache.so1ve.dev",
      exp: unixNow() + 300,
      repository_owner_id: "58381667",
      repository: "so1ve/latchshot",
      ref: "refs/heads/main",
      event_name: "push",
      ...overrides,
    });

  async function seedMockOciArtifact(repo: string, payload: Uint8Array) {
    const digestBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", payload),
    );
    const blobHex = encodeHex(digestBytes);
    const blobDigest = `sha256:${blobHex}`;
    store.blobs.set(`${repo}/${blobDigest}`, payload);

    const manifestBytes = encoder.encode(
      JSON.stringify({
        schemaVersion: 2,
        layers: [{ digest: blobDigest, size: payload.length }],
      }),
    );
    const manifestHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", manifestBytes),
    );
    const manifestDigest = `sha256:${encodeHex(manifestHash)}`;
    store.manifests.set(`${repo}/${manifestDigest}`, manifestBytes);

    store.nextVersionId += 1;
    const versions = store.versions.get(repo) ?? [];
    versions.push({ id: store.nextVersionId, name: manifestDigest });
    store.versions.set(repo, versions);

    return {
      blobHex,
      manifestDigest,
      fileHash: formatSha256NixBase32(digestBytes),
    };
  }

  async function uploadAndCommit(
    bearer: string,
    repo: string,
    storePath: string,
    content: string,
  ) {
    const bytes = encoder.encode(content);
    const narDigest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes),
    );
    const narHash = formatSha256NixBase32(narDigest);
    const { blobHex, manifestDigest, fileHash } = await seedMockOciArtifact(
      repo,
      bytes,
    );

    const commitRes = await callWorker("/api/v1/uploads/commit", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entries: [
          {
            store_path: storePath,
            nar_hash: narHash,
            nar_size: bytes.length,
            file_hash: fileHash,
            file_size: bytes.length,
            manifest_digest: manifestDigest,
            blob_digest: blobHex,
            references: [],
          },
        ],
      } satisfies CommitRequest),
    });

    expect(commitRes.status).toBe(200);

    return { narHash, blobHex };
  }

  beforeEach(async () => {
    await applyD1Migrations(
      env.DB,
      (
        env as unknown as {
          TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
        }
      ).TEST_MIGRATIONS,
    );
    mainKey = await SigningKeyPair.generate("cache.so1ve.dev-1");
    prKey = await SigningKeyPair.generate("cache.so1ve.dev-pr-1");
    rsa = await generateRsaPair();
    store = {
      blobs: new Map(),
      manifests: new Map(),
      versions: new Map(),
      blockedPackages: new Set(),
      deletedVersions: [],
      deletedPackages: [],
      nextVersionId: 0,
    };

    vi.stubGlobal("fetch", createMockFetch(rsa.jwk, store));

    testEnv = Object.assign({}, env, {
      PUBLIC_BASE_URL: "https://cache.so1ve.dev",
      GC_PR_TTL_DAYS: "3",
      GC_MAIN_LRU_DAYS: "15",
      GITHUB_APP_ID: "1",
      OWNERS_JSON: JSON.stringify([
        {
          name: "so1ve",
          owner_type: "user",
          github_owner_id: 58_381_667,
          github_installation_id: 99,
        },
      ]),
      MAIN_SIGNING_KEY: mainKey.secretString(),
      PR_SIGNING_KEY: prKey.secretString(),
      GITHUB_APP_PRIVATE_KEY: rsa.pkcs8Pem,
      GITHUB_WEBHOOK_SECRET: "whsec_test",
      MANUAL_TOKENS_JSON: JSON.stringify({ so1ve: ["manual-secret-token"] }),
      ADMIN_TOKEN: "admin-secret-token",
      GHCR_REGISTRY_URL: "https://ghcr.mock",
      GITHUB_API_URL: "https://api.github.mock",
      GITHUB_OIDC_ISSUER: "https://oidc.mock",
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await reset();
  });

  it("matches official NixBase32 empty SHA-256 vector and verifies Ed25519 signatures", async () => {
    const emptyDigest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array()),
    );

    expect(formatSha256NixBase32(emptyDigest)).toBe(
      "sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73",
    );

    const parsed = await SigningKeyPair.parseSecret(mainKey.secretString());

    expect(parsed.publicString()).toBe(mainKey.publicString());

    const fp = fingerprint(
      "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-test",
      "sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73",
      0,
      [],
    );
    const sig = await parsed.signFingerprint(fp);

    await expect(
      verifySignature(mainKey.publicString(), fp, sig),
    ).resolves.toBeTruthy();
  });

  it("rejects pull_request_target and non-main branch pushes", async () => {
    const prTarget = await issueOidcJwt({ event_name: "pull_request_target" });
    const feature = await issueOidcJwt({ ref: "refs/heads/feature" });

    for (const [jwt, expectedCode] of [
      [prTarget, null],
      [feature, "non-main-ref"],
    ] as const) {
      const res = await callWorker("/api/v1/uploads/plan", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ store_paths: [] } satisfies PlanRequest),
      });

      expect(res.status).toBe(403);
      expect(res.headers.get("x-firn-error")).toBe(expectedCode);
    }
  });

  it("serves public keys, main narinfo, and 302 CDN redirects after OIDC push", async () => {
    const keysRes = await callWorker("/api/v1/public-keys");

    expect(keysRes.status).toBe(200);
    await expect(keysRes.json()).resolves.toEqual({
      main_public_key: mainKey.publicString(),
      pr_public_key: prKey.publicString(),
    });

    const infoRes = await callWorker("/nix-cache-info");

    await expect(infoRes.text()).resolves.toContain("Priority: 41");

    const jwt = await issueOidcJwt({});
    const hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const storePath = `/nix/store/${hash}-hello`;

    const planRes = await callWorker("/api/v1/uploads/plan", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ store_paths: [storePath] } satisfies PlanRequest),
    });

    expect(planRes.status).toBe(200);

    const plan = await planRes.json<PlanResponse>();

    expect(plan.ghcr_repository).toBe("so1ve/latchshot-cache");
    expect(plan.missing).toEqual([hash]);

    const { narHash, blobHex } = await uploadAndCommit(
      jwt,
      plan.ghcr_repository,
      storePath,
      "fake-nar-content-main",
    );

    const narinfoRes = await callWorker(`/${hash}.narinfo`);

    expect(narinfoRes.status).toBe(200);

    const text = await narinfoRes.text();

    expect(text).toContain("\nReferences: \n");

    const sig = text
      .split("\n")
      .find((line) => line.startsWith("Sig: "))
      ?.slice(5);

    expect(sig).toBeDefined();

    const fp = fingerprint(
      storePath,
      narHash,
      "fake-nar-content-main".length,
      [],
    );

    await expect(
      verifySignature(mainKey.publicString(), fp, sig!),
    ).resolves.toBeTruthy();

    const narRes = await callWorker(`/nar/${blobHex}.nar.zst`);

    expect(narRes.status).toBe(302);
    expect(narRes.headers.get("location")).toContain(
      "/cdn/so1ve/latchshot-cache/sha256:",
    );
  });

  it("isolates PR overlays and signs them with PR key while falling back to main", async () => {
    const mainJwt = await issueOidcJwt({});
    const prJwt = await issueOidcJwt({
      ref: "refs/pull/7/merge",
      event_name: "pull_request",
    });

    const mainHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const prHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await uploadAndCommit(
      mainJwt,
      "so1ve/latchshot-cache",
      `/nix/store/${mainHash}-base`,
      "main-nar",
    );
    const { narHash: prNarHash } = await uploadAndCommit(
      prJwt,
      "so1ve/latchshot-cache",
      `/nix/store/${prHash}-pr`,
      "pr-nar",
    );

    expect(
      (await callWorker(`/pr/so1ve/latchshot/7/${mainHash}.narinfo`)).status,
    ).toBe(200);
    expect((await callWorker(`/${prHash}.narinfo`)).status).toBe(404);

    const prRes = await callWorker(`/pr/so1ve/latchshot/7/${prHash}.narinfo`);
    const prText = await prRes.text();
    const prSig = prText
      .split("\n")
      .find((line) => line.startsWith("Sig: "))!
      .slice(5);
    const prFp = fingerprint(
      `/nix/store/${prHash}-pr`,
      prNarHash,
      "pr-nar".length,
      [],
    );

    await expect(
      verifySignature(prKey.publicString(), prFp, prSig),
    ).resolves.toBeTruthy();
    await expect(
      verifySignature(mainKey.publicString(), prFp, prSig),
    ).resolves.toBeFalsy();
  });

  it("handles manual token exchange, webhook PR cleanup, GC fallbacks, and admin API", async () => {
    const manualRes = await callWorker("/api/v1/uploads/plan", {
      method: "POST",
      headers: {
        "Authorization": "Bearer manual-secret-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ store_paths: [] } satisfies PlanRequest),
    });

    expect(manualRes.status).toBe(200);

    const manualPlan = await manualRes.json<PlanResponse>();

    expect(manualPlan.ghcr_repository).toBe("so1ve/manual-cache");
    expect(manualPlan.ghcr_token).toBe("mock-oci-token");

    const prJwt = await issueOidcJwt({
      ref: "refs/pull/9/merge",
      event_name: "pull_request",
    });
    await uploadAndCommit(
      prJwt,
      "so1ve/latchshot-cache",
      "/nix/store/cccccccccccccccccccccccccccccccc-ephemeral",
      "ephemeral-nar",
    );

    const webhookBody = JSON.stringify({
      action: "closed",
      repository: { name: "latchshot", owner: { id: 58_381_667 } },
      pull_request: { number: 9 },
    });
    const webhookRes = await callWorker("/api/v1/webhooks/github", {
      method: "POST",
      headers: {
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": await signWebhook("whsec_test", webhookBody),
      },
      body: webhookBody,
    });

    expect(webhookRes.status).toBe(204);

    const gcRes = await callAdmin("/api/v1/admin/gc", "POST");

    expect(gcRes.status).toBe(200);

    const report = await gcRes.json<GcReport>();

    expect(report.blobs_deleted).toBe(1);
    expect(store.deletedPackages).toEqual(["so1ve/latchshot-cache"]);

    const popJwt = await issueOidcJwt({
      repository: "so1ve/popular",
      ref: "refs/pull/10/merge",
      event_name: "pull_request",
    });
    await uploadAndCommit(
      popJwt,
      "so1ve/popular-cache",
      "/nix/store/dddddddddddddddddddddddddddddddd-popular",
      "popular-nar",
    );
    store.blockedPackages.add("so1ve/popular-cache");

    expect(
      (await callAdmin("/api/v1/admin/prs/so1ve/popular/10", "DELETE")).status,
    ).toBe(200);

    const firstGc = await (
      await callAdmin("/api/v1/admin/gc", "POST")
    ).json<GcReport>();

    expect(firstGc.blobs_blocked).toBe(1);
    expect(firstGc.blob_errors).toBe(0);

    const status = await (
      await callAdmin("/api/v1/admin/status")
    ).json<AdminStatusResponse>();

    expect(status.owners[0]?.blocked_blobs).toHaveLength(1);

    expect((await callAdmin("/api/v1/admin/paths", "DELETE")).status).toBe(400);

    const mainJwt = await issueOidcJwt({});
    await uploadAndCommit(
      mainJwt,
      "so1ve/latchshot-cache",
      "/nix/store/11111111111111111111111111111111-junk.patch",
      "junk-patch-nar",
    );
    await uploadAndCommit(
      mainJwt,
      "so1ve/latchshot-cache",
      "/nix/store/22222222222222222222222222222222-real-app",
      "real-app-nar",
    );

    const delMatching = await callAdmin(
      "/api/v1/admin/paths?q=.patch",
      "DELETE",
    );

    expect(delMatching.status).toBe(200);
    await expect(delMatching.json()).resolves.toEqual({ removed: 1 });
    await expect(
      getNarInfo(
        d1Adapter(env.DB),
        MAIN_SCOPE,
        "11111111111111111111111111111111",
      ),
    ).resolves.toBeNull();
    await expect(
      getNarInfo(
        d1Adapter(env.DB),
        MAIN_SCOPE,
        "22222222222222222222222222222222",
      ),
    ).resolves.not.toBeNull();
  });

  it("preserves transitive dependencies during closure-safe main LRU eviction", async () => {
    const depHash = "11111111111111111111111111111111";
    const liveHash = "22222222222222222222222222222222";
    const orphanHash = "33333333333333333333333333333333";
    const zeroNarHash =
      "sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73";

    const db = d1Adapter(env.DB);
    await commitEntries(db, [
      {
        ownerId: "so1ve",
        scope: MAIN_SCOPE,
        prInfo: null,
        ghcrPackage: "pkg-cache",
        manifestDigest: `sha256:${"a".repeat(64)}`,
        blobDigest: "1".repeat(64),
        fileSize: 100,
        storeHash: depHash,
        storePath: `/nix/store/${depHash}-dep`,
        narHash: zeroNarHash,
        narSize: 200,
        fileHash: zeroNarHash,
        deriver: null,
        references: [],
        signature: "cache.so1ve.dev-1:sig",
        now: 100,
      },
      {
        ownerId: "so1ve",
        scope: MAIN_SCOPE,
        prInfo: null,
        ghcrPackage: "pkg-cache",
        manifestDigest: `sha256:${"b".repeat(64)}`,
        blobDigest: "2".repeat(64),
        fileSize: 100,
        storeHash: liveHash,
        storePath: `/nix/store/${liveHash}-app`,
        narHash: zeroNarHash,
        narSize: 200,
        fileHash: zeroNarHash,
        deriver: null,
        references: [`${depHash}-dep`],
        signature: "cache.so1ve.dev-1:sig",
        now: 500,
      },
      {
        ownerId: "so1ve",
        scope: MAIN_SCOPE,
        prInfo: null,
        ghcrPackage: "pkg-cache",
        manifestDigest: `sha256:${"c".repeat(64)}`,
        blobDigest: "3".repeat(64),
        fileSize: 100,
        storeHash: orphanHash,
        storePath: `/nix/store/${orphanHash}-old`,
        narHash: zeroNarHash,
        narSize: 200,
        fileHash: zeroNarHash,
        deriver: null,
        references: [],
        signature: "cache.so1ve.dev-1:sig",
        now: 100,
      },
    ]);

    await expect(evictStaleMainPaths(db, 300, false)).resolves.toBe(1);
    await expect(getNarInfo(db, MAIN_SCOPE, depHash)).resolves.not.toBeNull();
    await expect(getNarInfo(db, MAIN_SCOPE, liveHash)).resolves.not.toBeNull();
    await expect(getNarInfo(db, MAIN_SCOPE, orphanHash)).resolves.toBeNull();

    const unref = await listUnreferencedBlobs(db, "so1ve");

    expect(unref).toHaveLength(1);
    expect(unref[0]?.blobDigest).toBe("3".repeat(64));
  });

  it("renders dashboard HTML and filters public store paths", async () => {
    const mainJwt = await issueOidcJwt({});
    const prJwt = await issueOidcJwt({
      ref: "refs/pull/42/merge",
      event_name: "pull_request",
    });

    await uploadAndCommit(
      mainJwt,
      "so1ve/latchshot-cache",
      "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-hello-world",
      "hello-nar-larger-payload",
    );
    await uploadAndCommit(
      prJwt,
      "so1ve/latchshot-cache",
      "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-pr-preview",
      "pr-nar",
    );

    const htmlRes = await callWorker("/");

    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("content-type")).toContain("text/html");

    const body = await htmlRes.text();

    expect(body).toContain("<!doctype html>");
    expect(body).toContain(mainKey.publicString());
    expect(body).toContain(prKey.publicString());
    expect(body).toContain("hello-world");
    expect(body).toContain("pr-preview");
    expect(body).toContain("so1ve/latchshot");
    expect(body).toContain("#42");

    const filteredRes = await callWorker(
      "/api/v1/public/paths?q=preview&scope=pr:so1ve:latchshot:42",
    );

    expect(filteredRes.status).toBe(200);

    const filtered = await filteredRes.json<StorePathSummary[]>();

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.store_path).toContain("pr-preview");

    const bySize = await (
      await callWorker("/api/v1/public/paths?sort=size")
    ).json<StorePathSummary[]>();

    expect(bySize.map((item) => item.store_path)).toEqual([
      "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-hello-world",
      "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-pr-preview",
    ]);

    const byAccessed = await (
      await callWorker("/api/v1/public/paths?sort=accessed")
    ).json<StorePathSummary[]>();

    expect(byAccessed.map((item) => item.store_path)).toEqual([
      "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-pr-preview",
      "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-hello-world",
    ]);

    expect((await callWorker("/api/v1/public/paths?sort=bogus")).status).toBe(
      400,
    );
    expect((await callWorker("/api/v1/public/paths?owner=nobody")).status).toBe(
      400,
    );
  });

  it("retries OCI manifest pushes on GHCR 429 rate limits", async () => {
    let manifestAttempts = 0;
    let emptyConfigHeads = 0;

    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const method = req.method.toUpperCase();
        const url = new URL(req.url);

        if (method === "HEAD" && url.pathname.includes("/blobs/")) {
          if (
            url.pathname.endsWith(
              "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            )
          ) {
            emptyConfigHeads += 1;
          }

          return new Response(null, { status: 200 });
        }
        if (method === "PUT" && url.pathname.includes("/manifests/")) {
          manifestAttempts += 1;
          if (manifestAttempts === 1) {
            return Response.json(
              {
                errors: [
                  {
                    code: "TOOMANYREQUESTS",
                    message: "retry-after: 2.565145ms, allowed: 2000/minute",
                  },
                ],
              },
              { status: 429 },
            );
          }

          return new Response(null, {
            status: 201,
            headers: {
              "docker-content-digest": `sha256:${"e".repeat(64)}`,
            },
          });
        }

        throw new Error(`unexpected ${method} ${req.url}`);
      },
    );

    const oci = new OciClient("https://ghcr.mock");
    const first = await oci.uploadNarBlob(
      "so1ve/nur-packages-cache",
      "tok",
      new Uint8Array([1, 2, 3]),
      "a".repeat(64),
    );
    const second = await oci.uploadNarBlob(
      "so1ve/nur-packages-cache",
      "tok",
      new Uint8Array([4, 5, 6]),
      "b".repeat(64),
    );

    expect(first).toBe(`sha256:${"e".repeat(64)}`);
    expect(second).toBe(`sha256:${"e".repeat(64)}`);
    expect(manifestAttempts).toBe(3);
    expect(emptyConfigHeads).toBe(1);
  });

  it("falls back to GitHub App pull token only on 401/403 for private GHCR packages", async () => {
    const baseFetch = createMockFetch(rsa.jwk, store);
    let tokenStatus = 401;
    let installTokenCalls = 0;

    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (url.pathname === "/token" && !req.headers.get("authorization")) {
          return Response.json(
            {
              errors: [
                { code: "UNAUTHORIZED", message: "authentication required" },
              ],
            },
            { status: tokenStatus },
          );
        }
        if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
          installTokenCalls += 1;
        }

        return baseFetch(input, init);
      },
    );

    const jwt = await issueOidcJwt({ repository: "so1ve/private-repo" });
    const { blobHex } = await uploadAndCommit(
      jwt,
      "so1ve/private-repo-cache",
      "/nix/store/ffffffffffffffffffffffffffffffff-priv",
      "private-nar-payload",
    );

    const narRes = await callWorker(`/nar/${blobHex}.nar.zst`);

    expect(narRes.status).toBe(302);
    expect(narRes.headers.get("location")).toContain(
      "/cdn/so1ve/private-repo-cache/sha256:",
    );
    expect(installTokenCalls).toBe(2);

    tokenStatus = 404;
    const failedRes = await callWorker(`/nar/${blobHex}.nar.zst`);

    expect(failedRes.status).toBe(500);
    expect(installTokenCalls).toBe(2);
  });

  it("stops GHCR version listing early and reuses cached ghcr_version_id across GC rounds", async () => {
    const baseFetch = createMockFetch(rsa.jwk, store);
    let versionsListCalls = 0;

    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (
          new URL(new Request(input, init).url).pathname.endsWith("/versions")
        ) {
          versionsListCalls += 1;
        }

        return baseFetch(input, init);
      },
    );

    const prJwt = await issueOidcJwt({
      repository: "so1ve/paged",
      ref: "refs/pull/12/merge",
      event_name: "pull_request",
    });

    await uploadAndCommit(
      prJwt,
      "so1ve/paged-cache",
      "/nix/store/11111111111111111111111111111111-first",
      "first-nar",
    );
    await uploadAndCommit(
      prJwt,
      "so1ve/paged-cache",
      "/nix/store/22222222222222222222222222222222-second",
      "second-nar",
    );
    await uploadAndCommit(
      prJwt,
      "so1ve/paged-cache",
      "/nix/store/33333333333333333333333333333333-third",
      "third-nar",
    );

    const existing = store.versions.get("so1ve/paged-cache") ?? [];
    for (let i = 0; i < 120; i += 1) {
      existing.push({
        id: 1000 + i,
        name: `sha256:${String(i).padStart(64, "0")}`,
      });
    }
    store.versions.set("so1ve/paged-cache", existing);

    expect(
      (await callAdmin("/api/v1/admin/prs/so1ve/paged/12", "DELETE")).status,
    ).toBe(200);

    testEnv.GC_MAX_SUBREQUESTS = "4";
    const round1 = await (
      await callAdmin("/api/v1/admin/gc", "POST")
    ).json<GcReport>();

    expect(versionsListCalls).toBe(1);
    expect(round1.blobs_deleted).toBe(1);
    expect(round1.blobs_skipped).toBe(2);

    testEnv.GC_MAX_SUBREQUESTS = "5";
    const round2 = await (
      await callAdmin("/api/v1/admin/gc", "POST")
    ).json<GcReport>();

    expect(versionsListCalls).toBe(1);
    expect(round2.blobs_deleted).toBe(2);
    expect(round2.blobs_skipped).toBe(0);
    await expect(
      listUnreferencedBlobs(d1Adapter(env.DB), "so1ve"),
    ).resolves.toEqual([]);
  });

  it("sweeps aged untracked nar-* GHCR orphans while protecting live, recent, and non-Firn versions", async () => {
    const mainJwt = await issueOidcJwt({ repository: "so1ve/orphan-test" });
    await uploadAndCommit(
      mainJwt,
      "so1ve/orphan-test-cache",
      "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-live-pkg",
      "live-pkg-nar",
    );

    const oldIso = new Date((unixNow() - 7200) * 1000).toISOString();
    const recentIso = new Date((unixNow() - 300) * 1000).toISOString();
    const existing = store.versions.get("so1ve/orphan-test-cache") ?? [];
    existing[0].updated_at = oldIso;
    existing[0].metadata = { container: { tags: ["nar-live"] } };

    existing.push(
      {
        id: 2001,
        name: `sha256:${"1".repeat(64)}`,
        updated_at: oldIso,
        metadata: { container: { tags: ["nar-orphan-1"] } },
      },
      {
        id: 2002,
        name: `sha256:${"2".repeat(64)}`,
        updated_at: oldIso,
        metadata: { container: { tags: ["nar-orphan-2"] } },
      },
      {
        id: 2003,
        name: `sha256:${"3".repeat(64)}`,
        updated_at: oldIso,
        metadata: { container: { tags: ["nar-orphan-3"] } },
      },
      {
        id: 2004,
        name: `sha256:${"4".repeat(64)}`,
        updated_at: recentIso,
        metadata: { container: { tags: ["nar-inflight"] } },
      },
      {
        id: 2005,
        name: `sha256:${"5".repeat(64)}`,
        updated_at: oldIso,
        metadata: { container: { tags: ["latest"] } },
      },
    );
    store.versions.set("so1ve/orphan-test-cache", existing);

    testEnv.GC_MAX_SUBREQUESTS = "5";
    const round1 = await (
      await callAdmin("/api/v1/admin/gc", "POST")
    ).json<GcReport>();

    expect(round1.blobs_deleted).toBe(2);
    expect(round1.blobs_skipped).toBe(1);
    expect(round1.blob_errors).toBe(0);

    const round2 = await (
      await callAdmin("/api/v1/admin/gc", "POST")
    ).json<GcReport>();

    expect(round2.blobs_deleted).toBe(1);
    expect(round2.blobs_skipped).toBe(0);
    expect(round2.blob_errors).toBe(0);

    expect(store.deletedVersions).toEqual([2001, 2002, 2003]);
    expect(
      (store.versions.get("so1ve/orphan-test-cache") ?? []).map((v) => v.id),
    ).toEqual([1, 2004, 2005]);
  });

  it("reports an error instead of faking deletion when GHCR masks DELETE permission denial as 404", async () => {
    const baseFetch = createMockFetch(rsa.jwk, store);
    let deleteCalls = 0;

    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        if (
          req.method.toUpperCase() === "DELETE" &&
          new URL(req.url).pathname.includes("/versions/")
        ) {
          deleteCalls += 1;

          return Response.json(
            { message: "Package not found." },
            { status: 404 },
          );
        }

        return baseFetch(input, init);
      },
    );

    const mainJwt = await issueOidcJwt({ repository: "so1ve/denied" });
    await uploadAndCommit(
      mainJwt,
      "so1ve/denied-cache",
      "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-live",
      "live-nar",
    );

    const oldIso = new Date((unixNow() - 7200) * 1000).toISOString();
    const existing = store.versions.get("so1ve/denied-cache") ?? [];
    existing.push(
      {
        id: 3001,
        name: `sha256:${"7".repeat(64)}`,
        updated_at: oldIso,
        metadata: { container: { tags: ["nar-orphan-a"] } },
      },
      {
        id: 3002,
        name: `sha256:${"8".repeat(64)}`,
        updated_at: oldIso,
        metadata: { container: { tags: ["nar-orphan-b"] } },
      },
    );
    store.versions.set("so1ve/denied-cache", existing);

    const report = await (
      await callAdmin("/api/v1/admin/gc", "POST")
    ).json<GcReport>();

    expect(report.blobs_deleted).toBe(0);
    expect(report.blob_errors).toBe(1);
    expect(report.last_error).toContain("404");
    expect(report.last_error).toContain("Package not found.");
    expect(deleteCalls).toBe(1);
  });

  it("uses GITHUB_PACKAGES_TOKEN directly for GC without a GitHub App installation", async () => {
    const baseFetch = createMockFetch(rsa.jwk, store);
    let installTokenCalls = 0;
    const authHeaders: string[] = [];

    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
          installTokenCalls += 1;
        }
        if (url.pathname.includes("/packages/container/")) {
          authHeaders.push(req.headers.get("authorization") ?? "");
        }

        return baseFetch(input, init);
      },
    );

    const mainJwt = await issueOidcJwt({ repository: "so1ve/pat-gc" });
    await uploadAndCommit(
      mainJwt,
      "so1ve/pat-gc-cache",
      "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-kept",
      "kept-nar",
    );

    const oldIso = new Date((unixNow() - 7200) * 1000).toISOString();
    const existing = store.versions.get("so1ve/pat-gc-cache") ?? [];
    existing.push({
      id: 4001,
      name: `sha256:${"9".repeat(64)}`,
      updated_at: oldIso,
      metadata: { container: { tags: ["nar-orphan-pat"] } },
    });
    store.versions.set("so1ve/pat-gc-cache", existing);

    testEnv.GITHUB_APP_ID = "";
    testEnv.GITHUB_APP_PRIVATE_KEY = "";
    testEnv.GITHUB_PACKAGES_TOKEN = "ghp_test_classic_pat";

    const report = await (
      await callAdmin("/api/v1/admin/gc", "POST")
    ).json<GcReport>();

    expect(report.blobs_deleted).toBe(1);
    expect(report.blob_errors).toBe(0);
    expect(installTokenCalls).toBe(0);
    expect(authHeaders).toEqual([
      "Bearer ghp_test_classic_pat",
      "Bearer ghp_test_classic_pat",
    ]);
    expect(store.deletedVersions).toEqual([4001]);
  });

  it("overrides GHCR package per repository via repo_packages and validates config", async () => {
    testEnv.OWNERS_JSON = JSON.stringify([
      {
        name: "so1ve",
        owner_type: "user",
        github_owner_id: 58_381_667,
        github_installation_id: 99,
        repo_packages: { latchshot: "Custom-Cache" },
      },
    ]);

    const overriddenJwt = await issueOidcJwt({ repository: "so1ve/latchshot" });
    const defaultJwt = await issueOidcJwt({ repository: "so1ve/other" });

    const overriddenPlan = await (
      await callWorker("/api/v1/uploads/plan", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${overriddenJwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ store_paths: [] } satisfies PlanRequest),
      })
    ).json<PlanResponse>();
    const defaultPlan = await (
      await callWorker("/api/v1/uploads/plan", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${defaultJwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ store_paths: [] } satisfies PlanRequest),
      })
    ).json<PlanResponse>();

    expect(overriddenPlan.ghcr_repository).toBe("so1ve/custom-cache");
    expect(defaultPlan.ghcr_repository).toBe("so1ve/other-cache");

    const { blobHex } = await uploadAndCommit(
      overriddenJwt,
      "so1ve/custom-cache",
      "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-custom",
      "custom-pkg-nar",
    );
    const narRes = await callWorker(`/nar/${blobHex}.nar.zst`);

    expect(narRes.status).toBe(302);
    expect(narRes.headers.get("location")).toContain(
      "/cdn/so1ve/custom-cache/sha256:",
    );

    const invalidPackageEnv = {
      ...testEnv,
      OWNERS_JSON: JSON.stringify([
        {
          name: "so1ve",
          owner_type: "user",
          github_owner_id: 58_381_667,
          repo_packages: { latchshot: "../escape" },
        },
      ]),
    };

    await expect(loadConfig(invalidPackageEnv)).rejects.toThrow(
      /invalid GHCR package name/,
    );

    const unlistedRepoEnv = {
      ...testEnv,
      OWNERS_JSON: JSON.stringify([
        {
          name: "so1ve",
          owner_type: "user",
          github_owner_id: 58_381_667,
          allowed_repos: ["other"],
          repo_packages: { latchshot: "custom-cache" },
        },
      ]),
    };

    await expect(loadConfig(unlistedRepoEnv)).rejects.toThrow(
      /not listed in allowed_repos/,
    );
  });
});
