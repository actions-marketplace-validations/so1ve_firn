import { createApp } from "../server/app.ts";
import type { ServerRuntimeEnv } from "../server/config.ts";
import { loadConfig } from "../server/config.ts";
import { d1Adapter } from "../server/db.ts";
import { runGc } from "../server/gc.ts";

export interface CloudflareWorkerEnv extends ServerRuntimeEnv {
  DB: D1Database;
}

const app = createApp<CloudflareWorkerEnv>(async (c) => ({
  db: d1Adapter(c.env.DB),
  readDb: d1Adapter(
    typeof c.env.DB.withSession === "function"
      ? c.env.DB.withSession("first-unconstrained")
      : c.env.DB,
  ),
  edgeCache: caches.default,
  config: await loadConfig(c.env, { defaultMaxGcSubrequests: 40 }),
  waitUntil: (promise) => {
    c.executionCtx.waitUntil(promise);
  },
}));

export default {
  fetch: (request: Request, env: CloudflareWorkerEnv, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),

  scheduled(
    _controller: ScheduledController,
    env: CloudflareWorkerEnv,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(
      loadConfig(env, { defaultMaxGcSubrequests: 40 }).then((config) =>
        runGc(d1Adapter(env.DB), config, false),
      ),
    );
  },
} satisfies ExportedHandler<CloudflareWorkerEnv>;
