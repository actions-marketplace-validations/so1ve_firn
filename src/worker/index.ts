import { Hono } from "hono";

import { loadConfig } from "./config.ts";
import { runGc } from "./gc.ts";
import {
  handleAdminDeletePr,
  handleAdminGc,
  handleAdminListPaths,
  handleAdminListPrs,
  handleAdminStatus,
} from "./routes/admin.ts";
import type { AppBindings } from "./routes/cache.ts";
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
import { handleUploadCommit, handleUploadPlan } from "./routes/upload.ts";
import { handleWebhook } from "./routes/webhook.ts";
import { FAVICON_SVG } from "./ui/logo.ts";

function createApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get("/healthz", (c) => c.text("ok\n"));
  app.get("/nix-cache-info", () => handleMainCacheInfo());
  app.get(
    "/favicon.svg",
    () =>
      new Response(FAVICON_SVG, {
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        },
      }),
  );

  app.use("*", async (c, next) => {
    const config = await loadConfig(c.env);
    c.set("config", config);
    await next();
  });

  app.get("/", handleDashboard);
  app.get("/api/v1/public-keys", handlePublicKeys);
  app.get("/api/v1/public/paths", handlePublicPaths);
  app.post("/api/v1/uploads/plan", handleUploadPlan);
  app.post("/api/v1/uploads/commit", handleUploadCommit);
  app.post("/api/v1/webhooks/github", handleWebhook);

  app.get("/api/v1/admin/status", handleAdminStatus);
  app.get("/api/v1/admin/paths", handleAdminListPaths);
  app.get("/api/v1/admin/prs", handleAdminListPrs);
  app.delete("/api/v1/admin/prs/:owner/:repo/:number", handleAdminDeletePr);
  app.post("/api/v1/admin/gc", handleAdminGc);

  app.get("/pr/:owner/:repo/:number/nix-cache-info", handlePrCacheInfo);
  app.get("/pr/:owner/:repo/:number/nar/:file", handlePrNar);
  app.get("/pr/:owner/:repo/:number/:narinfo", handlePrNarInfo);

  app.get("/nar/:file", handleMainNar);
  app.get("/:narinfo", handleMainNarInfo);

  app.onError((error, c) => {
    const message = error instanceof Error ? error.message : String(error);
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

const app = createApp();

export default {
  fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const config = await loadConfig(env);
        await runGc(env.DB, config, false);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
