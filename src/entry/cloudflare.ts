import { createApp } from "../server/app.ts";
import type { ServerRuntimeEnv } from "../server/config.ts";
import { loadConfig } from "../server/config.ts";
import { d1Adapter } from "../server/db/d1.ts";
import { runGc } from "../server/gc.ts";

export interface CloudflareWorkerEnv extends ServerRuntimeEnv {
  DB: D1Database;
}

const app = createApp<CloudflareWorkerEnv>(async (c) => ({
  db: d1Adapter(c.env.DB),
  config: await loadConfig(c.env, { defaultMaxGcSubrequests: 40 }),
  waitUntil: (promise) => {
    c.executionCtx.waitUntil(promise);
  },
}));

export default {
  fetch(
    request: Request,
    env: CloudflareWorkerEnv,
    ctx: ExecutionContext,
  ): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async scheduled(
    _controller: ScheduledController,
    env: CloudflareWorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const config = await loadConfig(env, { defaultMaxGcSubrequests: 40 });
        await runGc(d1Adapter(env.DB), config, false);
      })(),
    );
  },
} satisfies ExportedHandler<CloudflareWorkerEnv>;
