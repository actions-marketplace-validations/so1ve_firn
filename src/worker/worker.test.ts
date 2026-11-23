import {
  applyD1Migrations,
  createExecutionContext,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SigningKeyPair,
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
import {
  MAIN_SCOPE,
  commitEntries,
  evictStaleMainPaths,
  getNarInfo,
  listUnreferencedBlobs,
} from "./db.ts";
import worker from "./index.ts";

interface MockStore {
  blobs: Map<string, Uint8Array>;
  manifests: Map<string, Uint8Array>;
  versions: Map<string, { id: number; name: string }[]>;
  blockedPackages: Set<string>;
  deletedVersions: number[];
  deletedPackages: string[];
  nextVersionId: number;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function toPem(der: Uint8Array, label: string): string {
  let binary = "";
  for (const byte of der) {
    binary += String.fromCharCode(byte);
  }
  const b64 = btoa(binary);
  const lines = b64.match(/.{1,64}/g) ?? [];

  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

interface TestJwk extends JsonWebKey {
  kid: string;
}

async function generateRsaPair(): Promise<{
  privateKey: CryptoKey;
  pkcs8Pem: string;
  jwk: TestJwk;
}> {
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
    new TextEncoder().encode(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-kid-1" }),
    ),
  );
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const input = `${header}.${payload}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      new TextEncoder().encode(input),
    ),
  );

  return `${input}.${base64UrlEncode(sig)}`;
}

async function signWebhook(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );

  return `sha256=${encodeHex(mac)}`;
}

const createMockFetch =
  (jwk: JsonWebKey, store: MockStore): typeof globalThis.fetch =>
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const reqUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const url = new URL(reqUrl);

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
      if (method === "HEAD") {
        return new Response(null, { status: 200 });
      }

      return new Response(null, {
        status: 307,
        headers: { Location: `https://cdn.example/cdn/${key}` },
      });
    }

    const manifestMatch = /^\/v2\/([^/]+)\/([^/]+)\/manifests\/(.+)$/.exec(
      url.pathname,
    );
    if (manifestMatch) {
      const key = `${manifestMatch[1]}/${manifestMatch[2]}/${manifestMatch[3]}`;
      const found = store.manifests.get(key);
      if (!found) {
        return new Response("not found", { status: 404 });
      }

      return new Response(found as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.oci.image.manifest.v1+json",
        },
      });
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
      const key = `${versionsListMatch[1]}/${versionsListMatch[2]}`;

      return Response.json(store.versions.get(key) ?? []);
    }

    const versionDeleteMatch =
      /^\/users\/([^/]+)\/packages\/container\/([^/]+)\/versions\/(\d+)$/.exec(
        url.pathname,
      );
    if (versionDeleteMatch && method === "DELETE") {
      const key = `${versionDeleteMatch[1]}/${versionDeleteMatch[2]}`;
      const vid = Number.parseInt(versionDeleteMatch[3], 10);
      if (store.blockedPackages.has(key)) {
        return Response.json(
          {
            message:
              "You cannot delete a public package version that has more than 5000 downloads.",
          },
          { status: 400 },
        );
      }
      const list = store.versions.get(key) ?? [];
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

    throw new Error(`unhandled mock fetch ${method} ${reqUrl}`);
  };

describe("firn worker", () => {
  let mainKey: SigningKeyPair;
  let prKey: SigningKeyPair;
  let rsa: Awaited<ReturnType<typeof generateRsaPair>>;
  let store: MockStore;
  let testEnv: Env;

  async function callWorker(request: Request): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    return response;
  }

  async function seedMockOciArtifact(
    repo: string,
    payload: Uint8Array,
  ): Promise<{ blobHex: string; manifestDigest: string; fileHash: string }> {
    const digestBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", payload),
    );
    const blobHex = encodeHex(digestBytes);
    const blobDigest = `sha256:${blobHex}`;
    store.blobs.set(`${repo}/${blobDigest}`, payload);

    const manifestBytes = new TextEncoder().encode(
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
  ): Promise<{ narHash: string; blobHex: string }> {
    const bytes = new TextEncoder().encode(content);
    const narDigest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes),
    );
    const narHash = formatSha256NixBase32(narDigest);
    const { blobHex, manifestDigest, fileHash } = await seedMockOciArtifact(
      repo,
      bytes,
    );

    const commitRes = await callWorker(
      new Request("https://cache.so1ve.dev/api/v1/uploads/commit", {
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
      }),
    );

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
    const prTarget = await signJwt(rsa.privateKey, {
      iss: "https://oidc.mock",
      aud: "https://cache.so1ve.dev",
      exp: unixNow() + 300,
      repository_owner_id: "58381667",
      repository: "so1ve/latchshot",
      ref: "refs/heads/main",
      event_name: "pull_request_target",
    });
    const feature = await signJwt(rsa.privateKey, {
      iss: "https://oidc.mock",
      aud: "https://cache.so1ve.dev",
      exp: unixNow() + 300,
      repository_owner_id: "58381667",
      repository: "so1ve/latchshot",
      ref: "refs/heads/feature",
      event_name: "push",
    });

    for (const [jwt, expectedCode] of [
      [prTarget, null],
      [feature, "non-main-ref"],
    ] as const) {
      const res = await callWorker(
        new Request("https://cache.so1ve.dev/api/v1/uploads/plan", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${jwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ store_paths: [] } satisfies PlanRequest),
        }),
      );

      expect(res.status).toBe(403);
      expect(res.headers.get("x-firn-error")).toBe(expectedCode);
    }
  });

  it("serves public keys, main narinfo, and 302 CDN redirects after OIDC push", async () => {
    const keysRes = await callWorker(
      new Request("https://cache.so1ve.dev/api/v1/public-keys"),
    );

    expect(keysRes.status).toBe(200);
    await expect(keysRes.json()).resolves.toEqual({
      main_public_key: mainKey.publicString(),
      pr_public_key: prKey.publicString(),
    });

    const infoRes = await callWorker(
      new Request("https://cache.so1ve.dev/nix-cache-info"),
    );

    await expect(infoRes.text()).resolves.toContain("Priority: 41");

    const jwt = await signJwt(rsa.privateKey, {
      iss: "https://oidc.mock",
      aud: "https://cache.so1ve.dev",
      exp: unixNow() + 300,
      repository_owner_id: "58381667",
      repository: "so1ve/latchshot",
      ref: "refs/heads/main",
      event_name: "push",
    });
    const hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const storePath = `/nix/store/${hash}-hello`;

    const planRes = await callWorker(
      new Request("https://cache.so1ve.dev/api/v1/uploads/plan", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          store_paths: [storePath],
        } satisfies PlanRequest),
      }),
    );

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

    const narinfoRes = await callWorker(
      new Request(`https://cache.so1ve.dev/${hash}.narinfo`),
    );

    expect(narinfoRes.status).toBe(200);

    const text = await narinfoRes.text();

    expect(text).toContain("\nReferences: \n");

    const sig = text
      .split("\n")
      .find((line) => line.startsWith("Sig: "))
      ?.slice("Sig: ".length);

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

    const narRes = await callWorker(
      new Request(`https://cache.so1ve.dev/nar/${blobHex}.nar.zst`),
    );

    expect(narRes.status).toBe(302);
    expect(narRes.headers.get("location")).toContain(
      "/cdn/so1ve/latchshot-cache/sha256:",
    );
  });

  it("isolates PR overlays and signs them with PR key while falling back to main", async () => {
    const mainJwt = await signJwt(rsa.privateKey, {
      iss: "https://oidc.mock",
      aud: "https://cache.so1ve.dev",
      exp: unixNow() + 300,
      repository_owner_id: "58381667",
      repository: "so1ve/latchshot",
      ref: "refs/heads/main",
      event_name: "push",
    });
    const prJwt = await signJwt(rsa.privateKey, {
      iss: "https://oidc.mock",
      aud: "https://cache.so1ve.dev",
      exp: unixNow() + 300,
      repository_owner_id: "58381667",
      repository: "so1ve/latchshot",
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
      (
        await callWorker(
          new Request(
            `https://cache.so1ve.dev/pr/so1ve/latchshot/7/${mainHash}.narinfo`,
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await callWorker(
          new Request(`https://cache.so1ve.dev/${prHash}.narinfo`),
        )
      ).status,
    ).toBe(404);

    const prRes = await callWorker(
      new Request(
        `https://cache.so1ve.dev/pr/so1ve/latchshot/7/${prHash}.narinfo`,
      ),
    );
    const prText = await prRes.text();
    const prSig = prText
      .split("\n")
      .find((line) => line.startsWith("Sig: "))!
      .slice("Sig: ".length);
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
    const manualRes = await callWorker(
      new Request("https://cache.so1ve.dev/api/v1/uploads/plan", {
        method: "POST",
        headers: {
          "Authorization": "Bearer manual-secret-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ store_paths: [] } satisfies PlanRequest),
      }),
    );

    expect(manualRes.status).toBe(200);

    const manualPlan = await manualRes.json<PlanResponse>();

    expect(manualPlan.ghcr_repository).toBe("so1ve/manual-cache");
    expect(manualPlan.ghcr_token).toBe("mock-oci-token");

    // Upload an ephemeral PR path, close PR via webhook, run GC -> last-version fallback deletes package.
    const prJwt = await signJwt(rsa.privateKey, {
      iss: "https://oidc.mock",
      aud: "https://cache.so1ve.dev",
      exp: unixNow() + 300,
      repository_owner_id: "58381667",
      repository: "so1ve/latchshot",
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
    const webhookRes = await callWorker(
      new Request("https://cache.so1ve.dev/api/v1/webhooks/github", {
        method: "POST",
        headers: {
          "X-GitHub-Event": "pull_request",
          "X-Hub-Signature-256": await signWebhook("whsec_test", webhookBody),
        },
        body: webhookBody,
      }),
    );

    expect(webhookRes.status).toBe(204);

    const gcRes = await callWorker(
      new Request("https://cache.so1ve.dev/api/v1/admin/gc", {
        method: "POST",
        headers: { Authorization: "Bearer admin-secret-token" },
      }),
    );

    expect(gcRes.status).toBe(200);

    const report = await gcRes.json<GcReport>();

    expect(report.blobs_deleted).toBe(1);
    expect(store.deletedPackages).toEqual(["so1ve/latchshot-cache"]);

    // Public >5000 downloads rejection marks gc_blocked and stops retrying.
    const popJwt = await signJwt(rsa.privateKey, {
      iss: "https://oidc.mock",
      aud: "https://cache.so1ve.dev",
      exp: unixNow() + 300,
      repository_owner_id: "58381667",
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

    const delPrRes = await callWorker(
      new Request("https://cache.so1ve.dev/api/v1/admin/prs/so1ve/popular/10", {
        method: "DELETE",
        headers: { Authorization: "Bearer admin-secret-token" },
      }),
    );

    expect(delPrRes.status).toBe(200);

    const firstGc = await (
      await callWorker(
        new Request("https://cache.so1ve.dev/api/v1/admin/gc", {
          method: "POST",
          headers: { Authorization: "Bearer admin-secret-token" },
        }),
      )
    ).json<GcReport>();

    expect(firstGc.blobs_blocked).toBe(1);
    expect(firstGc.blob_errors).toBe(0);

    const statusRes = await callWorker(
      new Request("https://cache.so1ve.dev/api/v1/admin/status", {
        headers: { Authorization: "Bearer admin-secret-token" },
      }),
    );
    const status = await statusRes.json<AdminStatusResponse>();

    expect(status.owners[0]?.blocked_blobs).toHaveLength(1);

    // Admin store path deletion: require at least one filter, then delete matching paths.
    const bareDelete = await callWorker(
      new Request("https://cache.so1ve.dev/api/v1/admin/paths", {
        method: "DELETE",
        headers: { Authorization: "Bearer admin-secret-token" },
      }),
    );

    expect(bareDelete.status).toBe(400);

    const mainJwt = await signJwt(rsa.privateKey, {
      iss: "https://oidc.mock",
      aud: "https://cache.so1ve.dev",
      exp: unixNow() + 300,
      repository_owner_id: "58381667",
      repository: "so1ve/latchshot",
      ref: "refs/heads/main",
      event_name: "push",
    });
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

    const delMatching = await callWorker(
      new Request("https://cache.so1ve.dev/api/v1/admin/paths?q=.patch", {
        method: "DELETE",
        headers: { Authorization: "Bearer admin-secret-token" },
      }),
    );

    expect(delMatching.status).toBe(200);
    await expect(delMatching.json()).resolves.toEqual({ removed: 1 });
    await expect(
      getNarInfo(env.DB, MAIN_SCOPE, "11111111111111111111111111111111"),
    ).resolves.toBeNull();
    await expect(
      getNarInfo(env.DB, MAIN_SCOPE, "22222222222222222222222222222222"),
    ).resolves.not.toBeNull();
  });

  it("preserves transitive dependencies during closure-safe main LRU eviction", async () => {
    const depHash = "11111111111111111111111111111111";
    const liveHash = "22222222222222222222222222222222";
    const orphanHash = "33333333333333333333333333333333";

    await commitEntries(env.DB, [
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
        narHash: "sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73",
        narSize: 200,
        fileHash: "sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73",
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
        narHash: "sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73",
        narSize: 200,
        fileHash: "sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73",
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
        narHash: "sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73",
        narSize: 200,
        fileHash: "sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73",
        deriver: null,
        references: [],
        signature: "cache.so1ve.dev-1:sig",
        now: 100,
      },
    ]);

    await expect(evictStaleMainPaths(env.DB, 300, false)).resolves.toBe(1);
    await expect(
      getNarInfo(env.DB, MAIN_SCOPE, depHash),
    ).resolves.not.toBeNull();
    await expect(
      getNarInfo(env.DB, MAIN_SCOPE, liveHash),
    ).resolves.not.toBeNull();
    await expect(
      getNarInfo(env.DB, MAIN_SCOPE, orphanHash),
    ).resolves.toBeNull();

    const unref = await listUnreferencedBlobs(env.DB, "so1ve");

    expect(unref).toHaveLength(1);
    expect(unref[0]?.blobDigest).toBe("3".repeat(64));
  });

  it("renders dashboard HTML and filters public store paths", async () => {
    const mainJwt = await signJwt(rsa.privateKey, {
      iss: "https://oidc.mock",
      aud: "https://cache.so1ve.dev",
      exp: unixNow() + 300,
      repository_owner_id: "58381667",
      repository: "so1ve/latchshot",
      ref: "refs/heads/main",
      event_name: "push",
    });
    const prJwt = await signJwt(rsa.privateKey, {
      iss: "https://oidc.mock",
      aud: "https://cache.so1ve.dev",
      exp: unixNow() + 300,
      repository_owner_id: "58381667",
      repository: "so1ve/latchshot",
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

    const htmlRes = await callWorker(new Request("https://cache.so1ve.dev/"));

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
      new Request(
        "https://cache.so1ve.dev/api/v1/public/paths?q=preview&scope=pr:so1ve:latchshot:42",
      ),
    );

    expect(filteredRes.status).toBe(200);

    const filtered = await filteredRes.json<StorePathSummary[]>();

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.store_path).toContain("pr-preview");

    const bySizeRes = await callWorker(
      new Request("https://cache.so1ve.dev/api/v1/public/paths?sort=size"),
    );

    expect(bySizeRes.status).toBe(200);

    const bySize = await bySizeRes.json<StorePathSummary[]>();

    expect(bySize.map((item) => item.store_path)).toEqual([
      "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-hello-world",
      "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-pr-preview",
    ]);

    const byAccessedRes = await callWorker(
      new Request("https://cache.so1ve.dev/api/v1/public/paths?sort=accessed"),
    );

    expect(byAccessedRes.status).toBe(200);

    const byAccessed = await byAccessedRes.json<StorePathSummary[]>();

    expect(byAccessed.map((item) => item.store_path)).toEqual([
      "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-pr-preview",
      "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-hello-world",
    ]);

    const badSortRes = await callWorker(
      new Request("https://cache.so1ve.dev/api/v1/public/paths?sort=bogus"),
    );

    expect(badSortRes.status).toBe(400);

    const unknownOwnerRes = await callWorker(
      new Request("https://cache.so1ve.dev/api/v1/public/paths?owner=nobody"),
    );

    expect(unknownOwnerRes.status).toBe(400);
  });

  it("retries OCI manifest pushes on GHCR 429 rate limits", async () => {
    let manifestAttempts = 0;
    let emptyConfigHeads = 0;

    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const reqUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const method = (init?.method ?? "GET").toUpperCase();
        const url = new URL(reqUrl);

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

        throw new Error(`unexpected ${method} ${reqUrl}`);
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
        const reqUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const url = new URL(reqUrl);
        if (url.pathname === "/token") {
          const headers = new Headers(
            init?.headers ?? (input instanceof Request ? input.headers : {}),
          );
          if (!headers.get("authorization")) {
            return Response.json(
              {
                errors: [
                  { code: "UNAUTHORIZED", message: "authentication required" },
                ],
              },
              { status: tokenStatus },
            );
          }
        }
        if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
          installTokenCalls += 1;
        }

        return baseFetch(input, init);
      },
    );

    const jwt = await signJwt(rsa.privateKey, {
      iss: "https://oidc.mock",
      aud: "https://cache.so1ve.dev",
      exp: unixNow() + 300,
      repository_owner_id: "58381667",
      repository: "so1ve/private-repo",
      ref: "refs/heads/main",
      event_name: "push",
    });
    const hash = "ffffffffffffffffffffffffffffffff";
    const { blobHex } = await uploadAndCommit(
      jwt,
      "so1ve/private-repo-cache",
      `/nix/store/${hash}-priv`,
      "private-nar-payload",
    );

    const narRes = await callWorker(
      new Request(`https://cache.so1ve.dev/nar/${blobHex}.nar.zst`),
    );

    expect(narRes.status).toBe(302);
    expect(narRes.headers.get("location")).toContain(
      "/cdn/so1ve/private-repo-cache/sha256:",
    );
    expect(installTokenCalls).toBe(2);

    // Non-auth errors (e.g. 404) must bubble up without minting an installation token.
    tokenStatus = 404;
    const failedRes = await callWorker(
      new Request(`https://cache.so1ve.dev/nar/${blobHex}.nar.zst`),
    );

    expect(failedRes.status).toBe(500);
    expect(installTokenCalls).toBe(2);
  });
});
