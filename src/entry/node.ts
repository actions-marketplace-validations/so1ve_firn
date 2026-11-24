import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import { createApp } from "../server/app.ts";
import { loadConfig } from "../server/config.ts";
import { openLibsql } from "../server/db/libsql.ts";
import { applyMigrations, openNodeSqlite } from "../server/db/sqlite.ts";
import type { CloseableSqlDatabase } from "../server/db.ts";
import { runGc } from "../server/gc.ts";
import { errorMessage } from "../shared/format.ts";

const DEFAULT_PUBLIC_DIR = path.resolve(import.meta.dirname, "../../public");
const STATIC_ASSET_PATHS = ["/styles.css", "/app.js", "/favicon.svg"] as const;

const FILE_BACKED_ENV_KEYS = [
  "OWNERS_JSON",
  "MAIN_SIGNING_KEY",
  "PR_SIGNING_KEY",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_PACKAGES_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "MANUAL_TOKENS_JSON",
  "ADMIN_TOKEN",
  "LIBSQL_AUTH_TOKEN",
] as const;

export interface DatabaseOptions {
  dbPath?: string | undefined;
  libsqlUrl?: string | undefined;
  libsqlAuthToken?: string | undefined;
  env?: Record<string, string | undefined>;
}

export interface NodeServerOptions extends DatabaseOptions {
  host?: string | undefined;
  port?: number | undefined;
  gcIntervalMinutes?: number | undefined;
}

export interface RunningNodeServer {
  host: string;
  port: number;
  close: () => Promise<void>;
}

export function resolveEnvWithFiles(
  rawEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const resolved = { ...rawEnv };
  for (const key of FILE_BACKED_ENV_KEYS) {
    if (!resolved[key]?.trim()) {
      const filePath = resolved[`${key}_FILE`]?.trim();
      if (filePath) {
        resolved[key] = fs.readFileSync(filePath, "utf8").trim();
      }
    }
  }

  return resolved;
}

export function openConfiguredDatabase(options: DatabaseOptions): {
  db: CloseableSqlDatabase;
  storage: string;
} {
  const env = resolveEnvWithFiles(options.env ?? process.env);
  const libsqlUrl = options.libsqlUrl?.trim() || env.LIBSQL_URL?.trim();
  if (libsqlUrl) {
    return {
      db: openLibsql(
        libsqlUrl,
        options.libsqlAuthToken?.trim() || env.LIBSQL_AUTH_TOKEN?.trim(),
      ),
      storage: "libsql",
    };
  }
  const dbPath =
    options.dbPath?.trim() || env.FIRN_DB_PATH?.trim() || "./firn.db";

  return { db: openNodeSqlite(dbPath), storage: `sqlite:${dbPath}` };
}

export async function runDatabaseMigrations(
  options: DatabaseOptions,
): Promise<{ applied: string[]; storage: string }> {
  const { db, storage } = openConfiguredDatabase(options);
  try {
    return { applied: await applyMigrations(db), storage };
  } finally {
    db.close();
  }
}

export async function startNodeServer(
  options: NodeServerOptions = {},
): Promise<RunningNodeServer> {
  const env = resolveEnvWithFiles(options.env ?? process.env);
  const host = options.host ?? env.HOST?.trim() ?? "127.0.0.1";
  const port = options.port ?? Number.parseInt(env.PORT ?? "8787", 10);
  const gcIntervalMinutes =
    options.gcIntervalMinutes ??
    Number.parseInt(env.GC_INTERVAL_MINUTES ?? "30", 10);

  const config = await loadConfig(env, { defaultMaxGcSubrequests: 10_000 });
  const { db, storage } = openConfiguredDatabase({ ...options, env });

  const applied = await applyMigrations(db);
  if (applied.length > 0) {
    console.log(
      JSON.stringify({ message: "applied database migrations", applied }),
    );
  }

  const app = new Hono();
  const staticHandler = serveStatic({ root: DEFAULT_PUBLIC_DIR });
  for (const assetPath of STATIC_ASSET_PATHS) {
    app.use(assetPath, staticHandler);
  }
  app.route(
    "/",
    createApp(() => ({ db, config })),
  );

  let gcTimer: ReturnType<typeof setInterval> | undefined;
  let gcInFlight = false;
  if (gcIntervalMinutes > 0) {
    gcTimer = setInterval(() => {
      if (gcInFlight) {
        return;
      }
      gcInFlight = true;
      void runGc(db, config, false)
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              message: "scheduled GC failed",
              error: errorMessage(error),
            }),
          );
        })
        .finally(() => {
          gcInFlight = false;
        });
    }, gcIntervalMinutes * 60_000);
    gcTimer.unref();
  }

  const server = await new Promise<ReturnType<typeof serve>>(
    (resolve, reject) => {
      const instance = serve({ fetch: app.fetch, hostname: host, port }, () =>
        resolve(instance),
      );
      instance.once("error", reject);
    },
  );

  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;

  console.log(
    JSON.stringify({
      message: "firn server listening",
      host,
      port: actualPort,
      storage,
      gc_interval_minutes: gcIntervalMinutes,
      public_base_url: config.publicBaseUrl,
    }),
  );

  return {
    host,
    port: actualPort,
    close: () => {
      clearInterval(gcTimer);

      return new Promise((resolve, reject) => {
        server.close((error) => {
          db.close();
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        if ("closeAllConnections" in server) {
          server.closeAllConnections();
        }
      });
    },
  };
}
