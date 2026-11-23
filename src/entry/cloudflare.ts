import { createApp } from "../server/app.ts";
import type { ServerRuntimeEnv } from "../server/config.ts";
import { loadConfig } from "../server/config.ts";
import { d1Adapter } from "../server/db/d1.ts";
import { runGc } from "../server/gc.ts";

export interface CloudflareWorkerEnv extends ServerRuntimeEnv {
  DB: D1Database;
}

export default {
  async fetch(
    request: Request,
    env: CloudflareWorkerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const config = await loadConfig(env, { defaultMaxGcSubrequests: 40 });
    const db = d1Adapter(env.DB);
    const app = createApp(() => ({
      db,
      config,
      waitUntil: (promise) => {
        ctx.waitUntil(promise);
      },
    }));

    return app.fetch(request);
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
