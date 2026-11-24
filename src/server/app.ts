import type { Context } from "hono";
import { Hono } from "hono";

import { errorMessage } from "../shared/format.ts";
import type { LoadedConfig } from "./config.ts";
import type { SqlDatabase } from "./db.ts";
import {
  handleAdminDeletePaths,
  handleAdminDeletePr,
  handleAdminGc,
  handleAdminListPaths,
  handleAdminListPrs,
  handleAdminStatus,
  requireAdmin,
} from "./routes/admin.ts";
import {
  handleMainCacheInfo,
  handleMainNar,
  handleMainNarInfo,
  handlePrCacheInfo,
  handlePrNar,
  handlePrNarInfo,
  handlePublicKeys,
} from "./routes/cache.ts";
import { handleDashboard, handlePublicPaths } from "./routes/ui.ts";
import {
  HttpError,
  handleUploadCommit,
  handleUploadPlan,
} from "./routes/upload.ts";
import { handleWebhook } from "./routes/webhook.ts";

export interface AppContext {
  db: SqlDatabase;
  config: LoadedConfig;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface AppBindings<E extends object = object> {
  Bindings: E;
  Variables: {
    db: SqlDatabase;
    config: LoadedConfig;
    waitUntil: (promise: Promise<unknown>) => void;
  };
}

export type AppContextResolver<E extends object = object> = (
  c: Context<AppBindings<E>>,
) => AppContext | Promise<AppContext>;

function defaultWaitUntil(promise: Promise<unknown>): void {
  void promise.catch((error: unknown) => {
    console.error(
      JSON.stringify({
        message: "background task failed",
        error: errorMessage(error),
      }),
    );
  });
}

export function createApp<E extends object = object>(
  resolveContext: AppContextResolver<E>,
): Hono<AppBindings<E>> {
  const app = new Hono<AppBindings<E>>();

  app.get("/healthz", (c) => c.text("ok\n"));
  app.get("/nix-cache-info", () => handleMainCacheInfo());

  app.use("*", async (c, next) => {
    const resolved = await resolveContext(c);
    c.set("db", resolved.db);
    c.set("config", resolved.config);
    c.set("waitUntil", resolved.waitUntil ?? defaultWaitUntil);
    await next();
  });

  app.use("/api/v1/admin/*", requireAdmin);

  app.get("/", handleDashboard);
  app.get("/api/v1/public-keys", handlePublicKeys);
  app.get("/api/v1/public/paths", handlePublicPaths);
  app.post("/api/v1/uploads/plan", handleUploadPlan);
  app.post("/api/v1/uploads/commit", handleUploadCommit);
  app.post("/api/v1/webhooks/github", handleWebhook);

  app.get("/api/v1/admin/status", handleAdminStatus);
  app.get("/api/v1/admin/paths", handleAdminListPaths);
  app.delete("/api/v1/admin/paths", handleAdminDeletePaths);
  app.get("/api/v1/admin/prs", handleAdminListPrs);
  app.delete("/api/v1/admin/prs/:owner/:repo/:number", handleAdminDeletePr);
  app.post("/api/v1/admin/gc", handleAdminGc);

  app.get("/pr/:owner/:repo/:number/nix-cache-info", handlePrCacheInfo);
  app.get("/pr/:owner/:repo/:number/nar/:file", handlePrNar);
  app.get("/pr/:owner/:repo/:number/:narinfo", handlePrNarInfo);

  app.get("/nar/:file", handleMainNar);
  app.get("/:narinfo", handleMainNarInfo);

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.text(
        error.message,
        error.status,
        error.code ? { "X-Firn-Error": error.code } : undefined,
      );
    }
    const message = errorMessage(error);
    console.error(
      JSON.stringify({
        message: "unhandled server error",
        method: c.req.method,
        path: c.req.path,
        error: message,
      }),
    );

    return c.text(message, 500);
  });

  return app;
}
