import { describe, expect, it } from "vitest";

import { mergeWranglerConfig, rebaseWranglerPaths } from "./deploy-worker.ts";

describe("deploy-worker config merge", () => {
  it("merges local overrides and env vars without dropping upstream bindings", () => {
    const base = {
      name: "firn",
      main: "src/entry/cloudflare.ts",
      keep_vars: true,
      triggers: { crons: ["*/30 * * * *"] },
      assets: { directory: "./public" },
      d1_databases: [
        {
          binding: "DB",
          database_name: "firn",
          migrations_dir: "migrations",
        },
      ],
    };

    const merged = mergeWranglerConfig(
      base,
      {
        d1_databases: [{ binding: "DB", database_id: "local-id" }],
        vars: { GC_PR_TTL_DAYS: "7" },
      },
      {
        FIRN_WORKER_NAME: "my-firn",
        FIRN_D1_DATABASE_ID: "env-id",
        FIRN_CUSTOM_DOMAIN: "https://cache.example.com/",
        FIRN_OWNERS_JSON: '[{"name":"so1ve"}]',
        FIRN_GC_MAX_SUBREQUESTS: "800",
      },
    );

    expect(merged.name).toBe("my-firn");
    expect(merged.keep_vars).toBeTruthy();
    expect(merged.triggers).toEqual(base.triggers);
    expect(merged.assets).toEqual(base.assets);
    expect(merged.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: "firn",
        migrations_dir: "migrations",
        database_id: "env-id",
      },
    ]);
    expect(merged.routes).toEqual([
      { pattern: "cache.example.com", custom_domain: true },
    ]);
    expect(merged.vars).toEqual({
      GC_PR_TTL_DAYS: "7",
      PUBLIC_BASE_URL: "https://cache.example.com",
      OWNERS_JSON: '[{"name":"so1ve"}]',
      GC_MAX_SUBREQUESTS: "800",
    });
  });

  it("rebases relative paths for generated .wrangler/deploy.json", () => {
    const rebased = rebaseWranglerPaths(
      {
        $schema: "node_modules/wrangler/config-schema.json",
        main: "src/entry/cloudflare.ts",
        assets: { directory: "./public" },
        d1_databases: [{ binding: "DB", migrations_dir: "migrations" }],
      },
      "/repo",
      "/repo/.wrangler",
    );

    expect(rebased.$schema).toBeUndefined();
    expect(rebased.main).toBe("../src/entry/cloudflare.ts");
    expect(rebased.assets?.directory).toBe("../public");
    expect(rebased.d1_databases?.[0]?.migrations_dir).toBe("../migrations");
  });
});
