import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import manifest from "../../package.json" with { type: "json" };
import { resolveEnvWithFiles, startNodeServer } from "../entry/node.ts";
import { createWebApp } from "../entry/web.ts";
import { SigningKeyPair, unixNow } from "../shared/nix-format.ts";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { normalizeLibsqlHttpUrl, openLibsql } from "./db/libsql.ts";
import {
  applyMigrations,
  loadMigrations,
  openNodeSqlite,
} from "./db/sqlite.ts";
import {
  MAIN_SCOPE,
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
});
