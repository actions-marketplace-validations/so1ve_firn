import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import manifest from "../../package.json" with { type: "json" };
import type { NixPathInfo } from "../cli/push.ts";
import { groupByDependencyOrder } from "../cli/push.ts";
import { resolveEnvWithFiles, startNodeServer } from "../entry/node.ts";
import { createWebApp } from "../entry/web.ts";
import { MAIN_SCOPE } from "../shared/format.ts";
import { SigningKeyPair, unixNow } from "../shared/nix-format.ts";
import { OciClient } from "../shared/oci.ts";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { normalizeLibsqlHttpUrl, openLibsql } from "./db/libsql.ts";
import {
  applyMigrations,
  loadMigrations,
  openNodeSqlite,
} from "./db/sqlite.ts";
import {
  cacheBlobVersionIds,
  cacheStats,
  commitEntries,
  deleteBlobIfUnreferenced,
  deleteStorePaths,
  evictStaleMainPaths,
  getNarInfo,
  listStorePaths,
  listUnreferencedBlobs,
} from "./db.ts";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = path.resolve(import.meta.dirname, "../cli/index.ts");

describe("portable Firn server & database adapters", () => {
  it("loads SQL migrations directly from migrations/*.sql", () => {
    const migrations = loadMigrations();

    expect(migrations.map((m) => m.name)).toEqual([
      "0001_init.sql",
      "0002_blob_version_id.sql",
      "0003_query_indexes.sql",
    ]);
    expect(migrations.every((m) => m.statements.length > 0)).toBeTruthy();
  });

  it("runs full SQLite migrations, DB queries, and Hono app on Node 24 node:sqlite", async () => {
    const db = openNodeSqlite(":memory:");
    try {
      const firstRun = await applyMigrations(db);
      const secondRun = await applyMigrations(db);

      expect(firstRun).toEqual(loadMigrations().map((m) => m.name));
      expect(secondRun).toEqual([]);

      const mainKey = await SigningKeyPair.generate("cache.local-1");
      const prKey = await SigningKeyPair.generate("cache.local-pr-1");
      const config = await loadConfig(
        {
          PUBLIC_BASE_URL: "https://cache.local",
          OWNERS_JSON: JSON.stringify([
            { name: "so1ve", owner_type: "user", github_owner_id: 58_381_667 },
          ]),
          MAIN_SIGNING_KEY: mainKey.secretString(),
          PR_SIGNING_KEY: prKey.secretString(),
          ADMIN_TOKEN: "secret-admin-token",
        },
        { defaultMaxGcSubrequests: 10_000 },
      );

      expect(config.gc.maxSubrequests).toBe(10_000);

      const now = unixNow();
      const hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const manifestDigest = `sha256:${"a".repeat(64)}`;
      await commitEntries(db, [
        {
          ownerId: "so1ve",
          scope: MAIN_SCOPE,
          prInfo: null,
          ghcrPackage: "demo-cache",
          manifestDigest,
          blobDigest: "b".repeat(64),
          fileSize: 4096,
          storeHash: hash,
          storePath: `/nix/store/${hash}-demo-1.0`,
          narHash:
            "sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73",
          narSize: 8192,
          fileHash:
            "sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73",
          deriver: "demo-1.0.drv",
          references: [],
          signature: "cache.local-1:sig",
          now,
        },
      ]);

      await expect(cacheStats(db)).resolves.toEqual({
        mainPaths: 1,
        prPaths: 0,
        activePrs: 0,
      });
      await expect(listStorePaths(db, "so1ve", null, 10)).resolves.toHaveLength(
        1,
      );

      const app = createApp(() => ({ db, config }));

      const dashRes = await app.fetch(new Request("https://cache.local/"));

      expect(dashRes.status).toBe(200);

      const dashHtml = await dashRes.text();

      expect(dashHtml).toContain("demo-1.0");
      expect(dashHtml).toContain("cache.local");

      const narinfoRes = await app.fetch(
        new Request(`https://cache.local/${hash}.narinfo`),
      );

      expect(narinfoRes.status).toBe(200);
      await expect(narinfoRes.text()).resolves.toContain(
        `StorePath: /nix/store/${hash}-demo-1.0`,
      );

      const statusRes = await app.fetch(
        new Request("https://cache.local/api/v1/admin/status", {
          headers: { Authorization: "Bearer secret-admin-token" },
        }),
      );

      expect(statusRes.status).toBe(200);

      await expect(
        cacheBlobVersionIds(
          db,
          "so1ve",
          "demo-cache",
          new Map([[manifestDigest, 4242]]),
        ),
      ).resolves.toBe(1);
      await expect(
        deleteStorePaths(db, {
          ownerId: "so1ve",
          scope: MAIN_SCOPE,
          storeHash: hash,
          query: null,
        }),
      ).resolves.toBe(1);
      await expect(getNarInfo(db, MAIN_SCOPE, hash)).resolves.toBeNull();

      const unref = await listUnreferencedBlobs(db, "so1ve");

      expect(unref).toHaveLength(1);
      expect(unref[0]?.ghcrVersionId).toBe(4242);
      await expect(
        deleteBlobIfUnreferenced(db, unref[0].id),
      ).resolves.toBeTruthy();
      await expect(evictStaleMainPaths(db, now + 100, false)).resolves.toBe(0);
    } finally {
      db.close();
    }
  });

  it("normalizes libsql URLs and executes queries + batches over Hrana HTTP", async () => {
    expect(normalizeLibsqlHttpUrl("libsql://firn-org.turso.io")).toBe(
      "https://firn-org.turso.io",
    );
    expect(normalizeLibsqlHttpUrl("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080",
    );

    const backing = openNodeSqlite(":memory:");
    let pipelineRequests = 0;

    const hranaFetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (new URL(req.url).pathname !== "/v2/pipeline") {
        return new Response("not found", { status: 404 });
      }
      pipelineRequests += 1;

      const body = await req.json<{
        requests: (
          | {
              type: "execute";
              stmt: {
                sql: string;
                args?: { type: string; value?: string }[];
                want_rows?: boolean;
              };
            }
          | {
              type: "batch";
              batch: {
                steps: {
                  stmt: {
                    sql: string;
                    args?: { type: string; value?: string }[];
                  };
                }[];
              };
            }
          | { type: "close" }
        )[];
      }>();

      const decodeArg = (arg: { type: string; value?: string }) =>
        arg.type === "null"
          ? null
          : arg.type === "integer" || arg.type === "float"
            ? Number(arg.value)
            : (arg.value ?? "");

      function encodeVal(val: unknown) {
        if (val === null || val === undefined) {
          return { type: "null" };
        }
        if (typeof val === "number") {
          return Number.isInteger(val)
            ? { type: "integer", value: String(val) }
            : { type: "float", value: val };
        }

        return { type: "text", value: String(val) };
      }

      async function execSql(
        sql: string,
        args: { type: string; value?: string }[] = [],
        wantRows = false,
      ) {
        const params = args.map(decodeArg);
        const trimmed = sql.trim().toUpperCase();
        if (
          trimmed === "BEGIN IMMEDIATE" ||
          trimmed === "COMMIT" ||
          trimmed === "ROLLBACK"
        ) {
          return {
            cols: [],
            rows: [],
            affected_row_count: 0,
            last_insert_rowid: null,
          };
        }
        if (wantRows || trimmed.startsWith("SELECT")) {
          const rows = await backing.all<Record<string, unknown>>(sql, params);
          const cols =
            rows.length > 0
              ? Object.keys(rows[0]).map((name) => ({ name, decltype: null }))
              : [];

          return {
            cols,
            rows: rows.map((row) => cols.map((c) => encodeVal(row[c.name]))),
            affected_row_count: 0,
            last_insert_rowid: null,
          };
        }
        const res = await backing.run(sql, params);

        return {
          cols: [],
          rows: [],
          affected_row_count: res.changes,
          last_insert_rowid: null,
        };
      }

      const results = [];
      for (const item of body.requests) {
        if (item.type === "close") {
          results.push({ type: "ok", response: { type: "close" } });
        } else if (item.type === "execute") {
          results.push({
            type: "ok",
            response: {
              type: "execute",
              result: await execSql(
                item.stmt.sql,
                item.stmt.args,
                item.stmt.want_rows,
              ),
            },
          });
        } else {
          const stepResults = [];
          for (const step of item.batch.steps) {
            stepResults.push(
              step.stmt.sql.trim().toUpperCase() === "ROLLBACK"
                ? null
                : await execSql(step.stmt.sql, step.stmt.args),
            );
          }
          results.push({
            type: "ok",
            response: {
              type: "batch",
              result: {
                step_results: stepResults,
                step_errors: stepResults.map(() => null),
              },
            },
          });
        }
      }

      return Response.json({ baton: null, base_url: null, results });
    }) as typeof globalThis.fetch;

    const mainKey = await SigningKeyPair.generate("cache.turso-1");
    const prKey = await SigningKeyPair.generate("cache.turso-pr-1");
    const libsql = openLibsql(
      "libsql://mock.turso.test",
      "test-jwt",
      hranaFetch,
    );
    try {
      const applied = await applyMigrations(libsql);

      expect(applied).toEqual(loadMigrations().map((m) => m.name));
      expect(pipelineRequests).toBeGreaterThan(0);

      const webApp = createWebApp(
        {
          LIBSQL_URL: "libsql://mock.turso.test",
          LIBSQL_AUTH_TOKEN: "test-jwt",
          PUBLIC_BASE_URL: "https://cache.turso",
          OWNERS_JSON: JSON.stringify([
            { name: "so1ve", owner_type: "user", github_owner_id: 1 },
          ]),
          MAIN_SIGNING_KEY: mainKey.secretString(),
          PR_SIGNING_KEY: prKey.secretString(),
        },
        hranaFetch,
      );
      try {
        const res = await webApp.fetch(
          new Request("https://cache.turso/api/v1/public-keys"),
        );

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({
          main_public_key: mainKey.publicString(),
          pr_public_key: prKey.publicString(),
        });
      } finally {
        webApp.close();
      }
    } finally {
      libsql.close();
      backing.close();
    }
  });

  it("loads *_FILE secrets and boots the self-hosted Node server cleanly", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "firn-node-test-"));
    try {
      const mainKey = await SigningKeyPair.generate("cache.self-1");
      const prKey = await SigningKeyPair.generate("cache.self-pr-1");
      const mainKeyFile = path.join(tmpDir, "main.key");
      const prKeyFile = path.join(tmpDir, "pr.key");
      fs.writeFileSync(mainKeyFile, `${mainKey.secretString()}\n`);
      fs.writeFileSync(prKeyFile, `${prKey.secretString()}\n`);

      const resolved = resolveEnvWithFiles({
        MAIN_SIGNING_KEY_FILE: mainKeyFile,
        PR_SIGNING_KEY_FILE: prKeyFile,
      });

      expect(resolved.MAIN_SIGNING_KEY).toBe(mainKey.secretString());
      expect(resolved.PR_SIGNING_KEY).toBe(prKey.secretString());

      const running = await startNodeServer({
        host: "127.0.0.1",
        port: 0,
        dbPath: path.join(tmpDir, "firn.db"),
        gcIntervalMinutes: 0,
        env: {
          PUBLIC_BASE_URL: "http://127.0.0.1",
          OWNERS_JSON: JSON.stringify([
            { name: "so1ve", owner_type: "user", github_owner_id: 1 },
          ]),
          MAIN_SIGNING_KEY_FILE: mainKeyFile,
          PR_SIGNING_KEY_FILE: prKeyFile,
        },
      });
      try {
        const base = `http://127.0.0.1:${running.port}`;
        const health = await fetch(`${base}/healthz`);

        expect(health.status).toBe(200);
        await expect(health.text()).resolves.toBe("ok\n");

        const keys = await fetch(`${base}/api/v1/public-keys`);

        expect(keys.status).toBe(200);
        await expect(keys.json()).resolves.toEqual({
          main_public_key: mainKey.publicString(),
          pr_public_key: prKey.publicString(),
        });

        const css = await fetch(`${base}/styles.css`);

        expect(css.status).toBe(200);
        expect(css.headers.get("content-type")).toContain("text/css");
        await expect(css.text()).resolves.toContain("--accent:");

        const js = await fetch(`${base}/app.js`);

        expect(js.status).toBe(200);
        expect(js.headers.get("content-type")).toContain("javascript");
        await expect(js.text()).resolves.toContain("firn_admin_token");

        const icon = await fetch(`${base}/favicon.svg`);

        expect(icon.status).toBe(200);
        expect(icon.headers.get("content-type")).toContain("image/svg+xml");
        await expect(icon.text()).resolves.toContain("<svg");
      } finally {
        await running.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("executes CLI help, completions, keygen, migrate, and flag validation", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "firn-cli-test-"));
    try {
      const secretPath = path.join(tmpDir, "secret.key");
      const publicPath = path.join(tmpDir, "public.key");
      const dbPath = path.join(tmpDir, "cli.db");

      const [versionOut, helpOut, prHelpOut, zshComp, keygenOut, migrateOut] =
        await Promise.all([
          execFileAsync(process.execPath, [CLI_ENTRY, "--version"]),
          execFileAsync(process.execPath, [CLI_ENTRY, "--help"]),
          execFileAsync(process.execPath, [CLI_ENTRY, "pr"]),
          execFileAsync(process.execPath, [CLI_ENTRY, "completions", "zsh"]),
          execFileAsync(process.execPath, [
            CLI_ENTRY,
            "keygen",
            "cache.cli-test-1",
            "-s",
            secretPath,
            "-p",
            publicPath,
          ]),
          execFileAsync(process.execPath, [
            CLI_ENTRY,
            "migrate",
            "--db",
            dbPath,
          ]),
        ]);

      expect(versionOut.stdout.trim()).toBe(`firn v${manifest.version}`);
      expect(helpOut.stdout).toContain("CACHE");
      expect(helpOut.stdout).toContain("ADMINISTRATION");
      expect(helpOut.stdout).toContain("SERVER");
      expect(helpOut.stdout).toContain("FIRN_SERVER");
      expect(prHelpOut.stdout).toContain("ls");
      expect(prHelpOut.stdout).toContain("rm");
      expect(zshComp.stdout).toContain("#compdef firn");
      expect(keygenOut.stdout).toContain("cache.cli-test-1");
      expect(fs.readFileSync(publicPath, "utf8").trim()).toMatch(
        /^cache\.cli-test-1:/,
      );
      expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
      expect(migrateOut.stdout).toContain("Applied 3 migration(s)");

      const runCliError = (
        args: string[],
        envOverrides: Record<string, string>,
      ) =>
        execFileAsync(process.execPath, [CLI_ENTRY, ...args], {
          env: {
            ...process.env,
            NO_COLOR: "1",
            ...envOverrides,
          },
        }).catch(
          (error: unknown) => error as { code?: number; stderr?: string },
        );

      const [missingFlagError, pushNoInputError, pushConflictError, jobsError] =
        await Promise.all([
          runCliError(["status"], { FIRN_SERVER: "", FIRN_ADMIN_TOKEN: "" }),
          runCliError(["push"], { FIRN_SERVER: "https://cache.local" }),
          runCliError(
            [
              "push",
              "--include-upstream",
              "--skip-signed-by",
              "foo:",
              "./result",
            ],
            { FIRN_SERVER: "https://cache.local" },
          ),
          runCliError(["push", "--jobs", "0", "./result"], {
            FIRN_SERVER: "https://cache.local",
          }),
        ]);

      expect(missingFlagError).toMatchObject({ code: 2 });
      expect(
        "stderr" in missingFlagError ? missingFlagError.stderr : "",
      ).toContain("FIRN_SERVER");
      expect(pushNoInputError).toMatchObject({ code: 2 });
      expect(
        "stderr" in pushNoInputError ? pushNoInputError.stderr : "",
      ).toContain("at least one");
      expect(pushConflictError).toMatchObject({ code: 2 });
      expect(
        "stderr" in pushConflictError ? pushConflictError.stderr : "",
      ).toContain("cannot be used together");
      expect(jobsError).toMatchObject({ code: 2 });
      expect("stderr" in jobsError ? jobsError.stderr : "").toContain(">= 1");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("streams OCI blobs in chunks, respects OCI-Chunk-Min-Length, recovers on retry, and cancels on error", async () => {
    const sha256Hex = (data: Uint8Array) =>
      createHash("sha256").update(data).digest("hex");

    async function* yieldSlices(
      data: Uint8Array,
      sliceSizes: readonly number[],
      failAfter?: number,
    ): AsyncGenerator<Uint8Array> {
      let pos = 0;
      let i = 0;
      while (pos < data.byteLength) {
        const size = sliceSizes[i % sliceSizes.length];
        i += 1;
        yield data.subarray(pos, Math.min(pos + size, data.byteLength));
        pos += size;
        if (failAfter !== undefined && pos >= failAfter) {
          throw new Error("simulated dump failure");
        }
      }
    }

    const originalFetch = globalThis.fetch;
    try {
      // 1. Small stream (< chunkSize): monolithic HEAD + POST + PUT, zero PATCH.
      {
        const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
        const digestHex = sha256Hex(payload);
        const methods: string[] = [];
        let uploadedBody: Uint8Array | null = null;
        let uploadedDigest: string | null = null;
        let manifestSize = -1;

        vi.stubGlobal(
          "fetch",
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const req = new Request(input, init);
            const url = new URL(req.url);
            methods.push(`${req.method} ${url.pathname}`);

            if (req.method === "HEAD") {
              // Empty config already exists; NAR blob does not.
              return new Response(null, {
                status: url.pathname.endsWith(digestHex) ? 404 : 200,
              });
            }
            if (req.method === "POST" && url.pathname.endsWith("/uploads/")) {
              return new Response(null, {
                status: 202,
                headers: { Location: "/v2/so1ve/demo/blobs/uploads/mono-1" },
              });
            }
            if (req.method === "PUT" && url.pathname.includes("/uploads/")) {
              uploadedDigest = url.searchParams.get("digest");
              uploadedBody = new Uint8Array(await req.arrayBuffer());

              return new Response(null, { status: 201 });
            }
            if (req.method === "PUT" && url.pathname.includes("/manifests/")) {
              const manifestJson = await req.json<{
                layers: { size: number; digest: string }[];
              }>();
              manifestSize = manifestJson.layers[0].size;

              return new Response(null, {
                status: 201,
                headers: {
                  "docker-content-digest": `sha256:${"1".repeat(64)}`,
                },
              });
            }

            throw new Error(`unexpected ${req.method} ${req.url}`);
          },
        );

        const oci = new OciClient("https://ghcr.mock");
        const result = await oci.uploadNarStream(
          "so1ve/demo",
          "tok",
          yieldSlices(payload, [3, 4]),
          () => digestHex,
          16,
        );

        expect(result).toEqual({
          manifestDigest: `sha256:${"1".repeat(64)}`,
          fileSize: payload.byteLength,
        });
        expect(uploadedDigest).toBe(`sha256:${digestHex}`);
        expect(uploadedBody).toEqual(payload);
        expect(manifestSize).toBe(payload.byteLength);
        expect(methods.some((m) => m.startsWith("PATCH"))).toBeFalsy();
      }

      // 2. Large stream (> chunkSize) with OCI-Chunk-Min-Length, 429 retry, 503->416 GET recovery, and token rotation.
      {
        const payload = Uint8Array.from({ length: 37 }, (_, i) => i + 1);
        const digestHex = sha256Hex(payload);
        const received: number[] = [];
        const patchRanges: string[] = [];
        const seenTokens = new Set<string>();
        let tokenCounter = 0;
        let patchStep = 0;
        let firstChunkFailedOnce = false;
        let secondChunkGhostAccepted = false;
        let finalPutLength: string | null = null;
        let finalPutDigest: string | null = null;
        let finalPutBodyBytes = -1;
        let allPatchLengthsMatched = true;
        let finalManifestSize = -1;

        vi.stubGlobal(
          "fetch",
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const req = new Request(input, init);
            const url = new URL(req.url);
            const auth = req.headers.get("authorization");
            if (auth) {
              seenTokens.add(auth);
            }

            if (req.method === "HEAD") {
              return new Response(null, { status: 200 });
            }
            if (req.method === "POST" && url.pathname.endsWith("/uploads/")) {
              return new Response(null, {
                status: 202,
                headers: {
                  "Location": "/v2/so1ve/demo/blobs/uploads/sess-0",
                  "OCI-Chunk-Min-Length": "16",
                },
              });
            }
            if (req.method === "PATCH") {
              const range = req.headers.get("content-range")!;
              const body = new Uint8Array(await req.arrayBuffer());
              if (
                req.headers.get("content-length") !== String(body.byteLength)
              ) {
                allPatchLengthsMatched = false;
              }

              if (range === "0-15" && !firstChunkFailedOnce) {
                firstChunkFailedOnce = true;

                return new Response("retry-after: 1ms", { status: 429 });
              }
              if (range === "16-31") {
                if (!secondChunkGhostAccepted) {
                  secondChunkGhostAccepted = true;
                  received.push(...body);
                  patchRanges.push(range);
                  patchStep += 1;

                  return new Response("gateway timeout", { status: 503 });
                }

                return new Response("range already uploaded", { status: 416 });
              }

              received.push(...body);
              patchRanges.push(range);
              patchStep += 1;

              return new Response(null, {
                status: 202,
                headers: {
                  Location: `/v2/so1ve/demo/blobs/uploads/sess-${patchStep}`,
                  Range: `0-${received.length - 1}`,
                },
              });
            }
            if (req.method === "GET" && url.pathname.includes("/uploads/")) {
              return new Response(null, {
                status: 204,
                headers: {
                  Location: `/v2/so1ve/demo/blobs/uploads/sess-${patchStep}`,
                  Range: `0-${received.length - 1}`,
                },
              });
            }
            if (req.method === "PUT" && url.pathname.includes("/uploads/")) {
              finalPutLength = req.headers.get("content-length");
              finalPutDigest = url.searchParams.get("digest");
              finalPutBodyBytes = (await req.arrayBuffer()).byteLength;

              return new Response(null, { status: 201 });
            }
            if (req.method === "PUT" && url.pathname.includes("/manifests/")) {
              const manifestJson = await req.json<{
                layers: { size: number }[];
              }>();
              finalManifestSize = manifestJson.layers[0].size;

              return new Response(null, {
                status: 201,
                headers: {
                  "docker-content-digest": `sha256:${"2".repeat(64)}`,
                },
              });
            }

            throw new Error(`unexpected ${req.method} ${req.url}`);
          },
        );

        const oci = new OciClient("https://ghcr.mock");
        const result = await oci.uploadNarStream(
          "so1ve/demo",
          async () => {
            tokenCounter += 1;

            return `tok-${tokenCounter}`;
          },
          yieldSlices(payload, [5, 7, 3]),
          () => digestHex,
          8,
        );

        expect(result).toEqual({
          manifestDigest: `sha256:${"2".repeat(64)}`,
          fileSize: payload.byteLength,
        });
        expect(new Uint8Array(received)).toEqual(payload);
        expect(patchRanges).toEqual(["0-15", "16-31", "32-36"]);
        expect(allPatchLengthsMatched).toBeTruthy();
        expect(finalPutLength).toBe("0");
        expect(finalPutDigest).toBe(`sha256:${digestHex}`);
        expect(finalPutBodyBytes).toBe(0);
        expect(finalManifestSize).toBe(payload.byteLength);
        expect(seenTokens.size).toBeGreaterThan(3);
      }

      // 3. Exact chunk boundary (20 bytes with chunkSize 10) + mid-stream cancellation.
      {
        const payload = Uint8Array.from({ length: 20 }, (_, i) => i);
        const digestHex = sha256Hex(payload);
        const exactRanges: string[] = [];

        vi.stubGlobal(
          "fetch",
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const req = new Request(input, init);
            const url = new URL(req.url);
            if (req.method === "HEAD") {
              return new Response(null, { status: 200 });
            }
            if (req.method === "POST") {
              return new Response(null, {
                status: 202,
                headers: { Location: "/v2/so1ve/demo/blobs/uploads/exact" },
              });
            }
            if (req.method === "PATCH") {
              exactRanges.push(req.headers.get("content-range")!);

              return new Response(null, {
                status: 202,
                headers: { Location: "/v2/so1ve/demo/blobs/uploads/exact" },
              });
            }
            if (req.method === "PUT" && url.pathname.includes("/uploads/")) {
              return new Response(null, { status: 201 });
            }
            if (req.method === "PUT" && url.pathname.includes("/manifests/")) {
              return new Response(null, {
                status: 201,
                headers: {
                  "docker-content-digest": `sha256:${"3".repeat(64)}`,
                },
              });
            }

            throw new Error(`unexpected ${req.method} ${req.url}`);
          },
        );

        const oci = new OciClient("https://ghcr.mock");
        const exact = await oci.uploadNarStream(
          "so1ve/demo",
          "tok",
          yieldSlices(payload, [10, 10]),
          () => digestHex,
          10,
        );

        expect(exact.fileSize).toBe(20);
        expect(exactRanges).toEqual(["0-9", "10-19"]);

        // Now verify mid-stream failure sends DELETE and never finalizes PUT.
        let cancelledUrl: string | null = null;
        let putCalled = false;
        vi.stubGlobal(
          "fetch",
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const req = new Request(input, init);
            if (req.method === "POST") {
              return new Response(null, {
                status: 202,
                headers: { Location: "/v2/so1ve/demo/blobs/uploads/abort-1" },
              });
            }
            if (req.method === "PATCH") {
              return new Response(null, {
                status: 202,
                headers: { Location: "/v2/so1ve/demo/blobs/uploads/abort-2" },
              });
            }
            if (req.method === "DELETE") {
              cancelledUrl = req.url;

              return new Response(null, { status: 204 });
            }
            if (req.method === "PUT") {
              putCalled = true;

              return new Response(null, { status: 201 });
            }

            throw new Error(`unexpected ${req.method} ${req.url}`);
          },
        );

        await expect(
          oci.uploadNarStream(
            "so1ve/demo",
            "tok",
            yieldSlices(payload, [12, 8], 12),
            () => digestHex,
            10,
          ),
        ).rejects.toThrow("simulated dump failure");
        expect(cancelledUrl).toBe(
          "https://ghcr.mock/v2/so1ve/demo/blobs/uploads/abort-2",
        );
        expect(putCalled).toBeFalsy();
      }
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("orders commit batches in dependency order and keeps mutual reference cycles atomic", () => {
    function makeInfo(
      id: string,
      name: string,
      refs: readonly string[] = [],
    ): NixPathInfo {
      const hash = id.padStart(32, "0");

      return {
        path: `/nix/store/${hash}-${name}`,
        storeHash: hash,
        narSize: 100,
        deriver: null,
        ca: null,
        references: [...refs],
        signatures: [],
      };
    }

    const ref = (id: string, name: string) => `${id.padStart(32, "0")}-${name}`;

    // Intentionally give dependents lexicographically smaller hashes than dependencies.
    const app = makeInfo("1", "app", [
      ref("1", "app"), // self-reference
      ref("2", "lib"),
      ref("999", "already-cached"), // external reference
    ]);
    const lib = makeInfo("2", "lib", [ref("3", "cyc-a"), ref("4", "cyc-b")]);
    const cycA = makeInfo("3", "cyc-a", [ref("4", "cyc-b"), ref("5", "leaf")]);
    const cycB = makeInfo("4", "cyc-b", [ref("3", "cyc-a")]);
    const leaf = makeInfo("5", "leaf");

    const batches = groupByDependencyOrder([app, lib, cycA, cycB, leaf], 2);

    // Every dependency must appear in an earlier or equal batch.
    const batchOf = new Map<string, number>();
    for (const [idx, batch] of batches.entries()) {
      for (const item of batch) {
        batchOf.set(item.storeHash, idx);
      }
    }

    expect(batchOf.get(leaf.storeHash)!).toBeLessThan(
      batchOf.get(cycA.storeHash)!,
    );
    // Mutual cycle must never be split across batches.
    expect(batchOf.get(cycA.storeHash)).toBe(batchOf.get(cycB.storeHash));
    expect(batchOf.get(cycA.storeHash)!).toBeLessThan(
      batchOf.get(lib.storeHash)!,
    );
    expect(batchOf.get(lib.storeHash)!).toBeLessThanOrEqual(
      batchOf.get(app.storeHash)!,
    );

    // Deep linear chain (1500 nodes) runs iteratively without stack overflow.
    const deep: NixPathInfo[] = [];
    for (let i = 0; i < 1500; i += 1) {
      const id = String(i + 1);
      const nextId = String(i + 2);
      deep.push(
        makeInfo(id, `pkg-${i}`, i < 1499 ? [ref(nextId, `pkg-${i + 1}`)] : []),
      );
    }
    const deepBatches = groupByDependencyOrder(deep, 15);

    expect(deepBatches).toHaveLength(100);

    const flatHashes = deepBatches.flat().map((item) => item.storeHash);

    expect(flatHashes[0]).toBe("1500".padStart(32, "0"));
    expect(flatHashes.at(-1)).toBe("1".padStart(32, "0"));
  });
});
