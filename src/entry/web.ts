import { createApp } from "../server/app.ts";
import type { LoadedConfig, ServerRuntimeEnv } from "../server/config.ts";
import { loadConfig } from "../server/config.ts";
import { openLibsql } from "../server/db/libsql.ts";
import type { CloseableSqlDatabase } from "../server/db.ts";
import { runGc } from "../server/gc.ts";
import type { GcReport } from "../shared/protocol.ts";

export interface WebRuntimeEnv extends ServerRuntimeEnv {
  LIBSQL_URL?: string;
  LIBSQL_AUTH_TOKEN?: string;
}

export interface WebAppHandler {
  fetch: (request: Request) => Promise<Response>;
  runScheduledGc: () => Promise<GcReport>;
  close: () => void;
}

function readProcessEnv(): WebRuntimeEnv {
  const globalObj = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    Deno?: { env?: { toObject: () => Record<string, string | undefined> } };
  };

  return globalObj.Deno?.env
    ? globalObj.Deno.env.toObject()
    : (globalObj.process?.env ?? {});
}

export function createWebApp(
  env: WebRuntimeEnv = readProcessEnv(),
  customFetch?: typeof globalThis.fetch,
): WebAppHandler {
  let dbInstance: CloseableSqlDatabase | null = null;
  let initialized: Promise<{
    db: CloseableSqlDatabase;
    config: LoadedConfig;
  }> | null = null;

  function ensureInitialized() {
    initialized ??= (async () => {
      const libsqlUrl = env.LIBSQL_URL?.trim();
      if (!libsqlUrl) {
        throw new Error(
          "LIBSQL_URL is required for the Web/serverless entry (e.g. libsql://<db>.turso.io)",
        );
      }
      const config = await loadConfig(env, { defaultMaxGcSubrequests: 200 });
      dbInstance = openLibsql(
        libsqlUrl,
        env.LIBSQL_AUTH_TOKEN?.trim(),
        customFetch,
      );

      return { db: dbInstance, config };
    })();

    return initialized;
  }

  const app = createApp(() => ensureInitialized());

  return {
    fetch: async (request: Request) => app.fetch(request),
    runScheduledGc: async () => {
      const { db, config } = await ensureInitialized();

      return runGc(db, config, false);
    },
    close(): void {
      dbInstance?.close();
      dbInstance = null;
      initialized = null;
    },
  };
}

let defaultHandler: WebAppHandler | null = null;

export default {
  fetch(request: Request): Promise<Response> {
    defaultHandler ??= createWebApp();

    return defaultHandler.fetch(request);
  },
};
