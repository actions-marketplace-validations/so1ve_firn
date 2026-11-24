#!/usr/bin/env node
import fs from "node:fs";

import { completionsPlugin } from "@clerc/plugin-completions";
import type { FlagsDefinition, TypeFunction } from "clerc";
import { Types, clerc } from "clerc";

import manifest from "../../package.json" with { type: "json" };
import { runDatabaseMigrations, startNodeServer } from "../entry/node.ts";
import { SigningKeyPair, unixNow } from "../shared/nix-format.ts";
import type {
  AdminStatusResponse,
  GcReport,
  OwnerStatusSummary,
  PrScopeSummary,
  StorePathSummary,
} from "../shared/protocol.ts";
import {
  formatAge,
  formatBytes,
  formatRemainingTtl,
  formatScope,
  formatStorePath,
  renderBanner,
  renderKv,
  renderSection,
  renderTable,
} from "./format.ts";
import { runPush } from "./push.ts";

const ServerUrl: TypeFunction<string> = Object.assign(
  (raw: string): string => {
    const server = raw.trim().replace(/\/+$/, "");
    if (!server) {
      throw new Error("expected a non-empty server URL");
    }

    return server;
  },
  { display: "url" },
);

const AdminToken: TypeFunction<string> = Object.assign(
  (raw: string): string => {
    const token = raw.trim();
    if (!token) {
      throw new Error("expected a non-empty token");
    }

    return token;
  },
  { display: "token" },
);

async function adminRequest<T>(
  flags: { server: string; token: string },
  method: string,
  apiPath: string,
): Promise<T> {
  const url = `${flags.server}${apiPath}`;
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${flags.token}` },
  });
  if (!response.ok) {
    throw new Error(
      `admin request ${method} ${url} failed (${response.status}): ${await response.text().catch(() => "")}`,
    );
  }

  return await response.json();
}

const adminAuthFlags = {
  server: {
    type: ServerUrl,
    env: "FIRN_SERVER",
    required: true,
    description: "Base URL of the Firn server",
  },
  token: {
    type: AdminToken,
    env: "FIRN_ADMIN_TOKEN",
    required: true,
    description: "Admin Bearer token",
  },
} as const satisfies FlagsDefinition;

const jsonFlag = {
  json: {
    type: Boolean,
    description: "Output raw JSON",
  },
} as const satisfies FlagsDefinition;

const dbFlags = {
  db: {
    type: String,
    env: "FIRN_DB_PATH",
    default: "./firn.db",
    description: "Local SQLite database path",
  },
  libsqlUrl: {
    type: String,
    env: "LIBSQL_URL",
    description: "Remote Turso/libSQL URL (overrides --db)",
  },
} as const satisfies FlagsDefinition;

const cli = clerc({
  name: "firn",
  description: manifest.description,
  version: manifest.version,
  notes: [
    "Environment variables:",
    "  FIRN_SERVER       Base URL of the Firn server",
    "  FIRN_TOKEN        Static Bearer token for manual pushes",
    "  FIRN_OWNER        GitHub owner name for manual pushes",
    "  FIRN_ADMIN_TOKEN  Admin Bearer token for status / ls / pr / gc",
  ],
})
  .groups({
    commands: {
      cache: "Cache",
      admin: "Administration",
      server: "Server",
    },
  })
  .use(completionsPlugin())
  .command("push [paths...]", {
    description: "Push Nix store paths and their closures to a Firn server",
    group: "cache",
    args: {
      paths: {
        description: "Nix store paths or symlinks to push",
      },
    },
    flags: {
      server: adminAuthFlags.server,
      owner: {
        type: String,
        env: "FIRN_OWNER",
        description: "GitHub owner name",
      },
      token: {
        type: String,
        env: "FIRN_TOKEN",
        description: "Manual push Bearer token",
      },
      stdin: {
        type: Boolean,
        description: "Read newline-separated store paths from stdin",
      },
      includeUpstream: {
        type: Boolean,
        description: "Upload paths even if signed by cache.nixos.org",
      },
      skipSignedBy: {
        type: String,
        multiple: true,
        default: ["cache.nixos.org-1:"],
        description: "Signature key prefix to skip (repeatable)",
      },
      jobs: {
        type: Types.Integer,
        default: 4,
        description: "Concurrent NAR uploads",
      },
      zstdLevel: {
        type: Types.Range(1, 22),
        default: 3,
        description: "Zstandard compression level",
      },
    },
    async run(ctx) {
      await runPush({ ...ctx.flags, ...ctx.args, log: ctx.log });
    },
  })
  .command("keygen <name>", {
    description: "Generate a Nix Ed25519 signing key pair",
    group: "cache",
    args: {
      name: {
        description: "Signing key name (e.g. cache.example.com-1)",
      },
    },
    flags: {
      secretOut: {
        type: String,
        short: "s",
        description: "Write secret key to file (mode 0600)",
      },
      publicOut: {
        type: String,
        short: "p",
        description: "Write public key to file",
      },
    },
    async run(ctx) {
      const { theme } = ctx.log;
      const pair = await SigningKeyPair.generate(ctx.args.name);
      const [secret, pub] = [pair.secretString(), pair.publicString()];
      if (ctx.flags.secretOut) {
        fs.writeFileSync(ctx.flags.secretOut, `${secret}\n`, { mode: 0o600 });
      }
      if (ctx.flags.publicOut) {
        fs.writeFileSync(ctx.flags.publicOut, `${pub}\n`);
      }

      ctx.log
        .success(`Generated Ed25519 key pair ${theme.bold(ctx.args.name)}`)
        .line(
          `Secret key  ${ctx.flags.secretOut ? `${theme.success("wrote")} ${ctx.flags.secretOut}` : theme.warn(secret)}`,
          `Public key  ${ctx.flags.publicOut ? `${theme.success("wrote")} ${ctx.flags.publicOut}` : theme.success(pub)}`,
        );
    },
  })
  .command("status", {
    description: "Show cache keys, usage, and GC-blocked blobs",
    group: "admin",
    flags: { ...adminAuthFlags, ...jsonFlag },
    async run(ctx) {
      const { theme } = ctx.log;
      const data = await adminRequest<AdminStatusResponse>(
        ctx.flags,
        "GET",
        "/api/v1/admin/status",
      );
      if (ctx.flags.json) {
        ctx.terminal.stdout(JSON.stringify(data, null, 2));

        return;
      }

      const totalBlobs = data.owners.reduce((sum, o) => sum + o.total_blobs, 0);
      const totalBytes = data.owners.reduce((sum, o) => sum + o.total_bytes, 0);
      const blockedEntries = data.owners.flatMap((owner) =>
        owner.blocked_blobs.map((blob) => ({ owner: owner.name, ...blob })),
      );

      ctx.terminal.stdout(
        renderBanner(theme, "Firn Cache", data.public_base_url),
      );
      ctx.terminal.stdout(renderSection(theme, "Overview"));
      ctx.terminal.stdout(
        renderKv(theme, [
          [
            "Policy",
            `PR TTL ${theme.bold(`${data.gc.pr_ttl_days}d`)}, Main LRU ${theme.bold(`${data.gc.main_lru_days}d`)}`,
          ],
          [
            "Store paths",
            `${theme.bold(theme.success(String(data.main_paths)))} main, ${theme.bold(theme.accent(String(data.pr_paths)))} pr ${theme.muted(`(${data.active_prs} active PRs)`)}`,
          ],
          [
            "Storage",
            `${theme.bold(String(totalBlobs))} blobs (${theme.bold(formatBytes(totalBytes))})${
              blockedEntries.length > 0
                ? `, ${theme.bold(theme.warn(`${blockedEntries.length} gc-blocked`))}`
                : ""
            }`,
          ],
          ["Main key", theme.muted(data.main_public_key)],
          ["PR key", theme.muted(data.pr_public_key)],
        ]),
      );

      ctx.terminal.stdout(
        renderSection(
          theme,
          "Owners & GHCR Storage",
          `(${data.owners.length} configured)`,
        ),
      );
      if (data.owners.length === 0) {
        ctx.terminal.stdout(`  ${theme.muted("No owners configured.")}`);
      } else {
        ctx.terminal.stdout(
          renderTable<OwnerStatusSummary>(
            theme,
            [
              { header: "OWNER", value: (o) => theme.bold(o.name) },
              { header: "TYPE", value: (o) => theme.muted(o.owner_type) },
              {
                header: "BLOBS",
                align: "right",
                value: (o) => String(o.total_blobs),
              },
              {
                header: "SIZE",
                align: "right",
                value: (o) => formatBytes(o.total_bytes),
              },
              {
                header: "UNREF",
                align: "right",
                value: (o) =>
                  o.unreferenced_blobs > 0
                    ? theme.warn(String(o.unreferenced_blobs))
                    : theme.muted("0"),
              },
              {
                header: "ACTIVE PRS",
                align: "right",
                value: (o) =>
                  o.active_prs > 0
                    ? theme.accent(String(o.active_prs))
                    : theme.muted("0"),
              },
              {
                header: "GC-BLOCKED",
                align: "right",
                value: (o) =>
                  o.blocked_blobs.length > 0
                    ? theme.bold(theme.warn(String(o.blocked_blobs.length)))
                    : theme.muted("0"),
              },
            ],
            data.owners,
          ),
        );
      }

      if (blockedEntries.length > 0) {
        ctx.terminal.stdout(
          renderSection(
            theme,
            "GC-Blocked Blobs",
            theme.warn(`(${blockedEntries.length} blocked by GHCR)`),
          ),
        );
        for (const item of blockedEntries) {
          ctx.terminal.stdout(
            `  ${theme.warn("!")} ${theme.bold(`${item.owner}/${item.ghcr_package}`)} ${theme.muted(`${item.manifest_digest.slice(0, 19)}…`)}\n    ${theme.muted(item.reason)}`,
          );
        }
      }
    },
  })
  .command("ls", {
    description: "List cached store paths ordered by recent access",
    group: "admin",
    flags: {
      ...adminAuthFlags,
      owner: { type: String, description: "Filter by GitHub owner" },
      scope: {
        type: String,
        description: "Filter by scope (main or pr:<owner>:<repo>:<n>)",
      },
      query: {
        type: String,
        short: "q",
        description: "Filter store paths by substring",
      },
      limit: {
        type: Types.Range(1, 500),
        default: 50,
        description: "Maximum rows to return",
      },
      ...jsonFlag,
    },
    async run(ctx) {
      const { theme } = ctx.log;
      const params = new URLSearchParams({ limit: String(ctx.flags.limit) });
      if (ctx.flags.owner) {
        params.set("owner", ctx.flags.owner);
      }
      if (ctx.flags.scope) {
        params.set("scope", ctx.flags.scope);
      }
      if (ctx.flags.query) {
        params.set("q", ctx.flags.query);
      }

      const items = await adminRequest<StorePathSummary[]>(
        ctx.flags,
        "GET",
        `/api/v1/admin/paths?${params.toString()}`,
      );
      if (ctx.flags.json) {
        ctx.terminal.stdout(JSON.stringify(items, null, 2));

        return;
      }

      const filters = [
        ctx.flags.owner && `owner=${ctx.flags.owner}`,
        ctx.flags.scope && `scope=${ctx.flags.scope}`,
        ctx.flags.query && `q=${ctx.flags.query}`,
      ].filter(Boolean);
      ctx.terminal.stdout(
        renderBanner(
          theme,
          "Store Paths",
          [
            `${items.length} shown`,
            filters.length > 0 ? `(${filters.join(", ")})` : "",
          ]
            .filter(Boolean)
            .join(" "),
        ),
      );
      if (items.length === 0) {
        ctx.terminal.stdout(
          `\n  ${theme.muted("No cached store paths found.")}`,
        );

        return;
      }

      const now = unixNow();
      ctx.terminal.stdout("");
      ctx.terminal.stdout(
        renderTable<StorePathSummary>(
          theme,
          [
            { header: "OWNER", value: (item) => theme.muted(item.owner_id) },
            {
              header: "SCOPE",
              value: (item) => formatScope(theme, item.scope),
            },
            {
              header: "SIZE",
              align: "right",
              value: (item) => formatBytes(item.file_size),
            },
            {
              header: "ACCESSED",
              align: "right",
              value: (item) =>
                theme.muted(formatAge(now, item.last_accessed_at)),
            },
            {
              header: "STORE PATH",
              value: (item) => formatStorePath(theme, item.store_path),
            },
          ],
          items,
        ),
      );
    },
  })
  .command("pr", {
    description: "Inspect and manage PR cache overlays",
    group: "admin",
  })
  .command("pr ls", {
    description: "List active PR overlays and remaining TTL",
    flags: {
      ...adminAuthFlags,
      owner: { type: String, description: "Filter by GitHub owner" },
      ...jsonFlag,
    },
    async run(ctx) {
      const { theme } = ctx.log;
      const prsPath = `/api/v1/admin/prs${ctx.flags.owner ? `?owner=${encodeURIComponent(ctx.flags.owner)}` : ""}`;
      if (ctx.flags.json) {
        ctx.terminal.stdout(
          JSON.stringify(
            await adminRequest<PrScopeSummary[]>(ctx.flags, "GET", prsPath),
            null,
            2,
          ),
        );

        return;
      }

      const [status, prs] = await Promise.all([
        adminRequest<AdminStatusResponse>(
          ctx.flags,
          "GET",
          "/api/v1/admin/status",
        ),
        adminRequest<PrScopeSummary[]>(ctx.flags, "GET", prsPath),
      ]);

      ctx.terminal.stdout(
        renderBanner(
          theme,
          "Active PR Overlays",
          `${prs.length} active (TTL ${status.gc.pr_ttl_days}d)`,
        ),
      );
      if (prs.length === 0) {
        ctx.terminal.stdout(`\n  ${theme.muted("No active PR overlays.")}`);

        return;
      }

      const now = unixNow();
      ctx.terminal.stdout("");
      ctx.terminal.stdout(
        renderTable<PrScopeSummary>(
          theme,
          [
            {
              header: "REPOSITORY",
              value: (pr) => theme.bold(`${pr.owner_id}/${pr.repo}`),
            },
            {
              header: "PR",
              align: "right",
              value: (pr) => theme.accent(`#${pr.pr_number}`),
            },
            {
              header: "PATHS",
              align: "right",
              value: (pr) => String(pr.path_count),
            },
            {
              header: "UPDATED",
              align: "right",
              value: (pr) => theme.muted(formatAge(now, pr.updated_at)),
            },
            {
              header: "TTL",
              value: (pr) => {
                const ttl = formatRemainingTtl(
                  now,
                  pr.updated_at,
                  status.gc.pr_ttl_days,
                );

                return ttl.state === "expired"
                  ? theme.error(ttl.text)
                  : ttl.state === "warn"
                    ? theme.warn(ttl.text)
                    : theme.success(ttl.text);
              },
            },
            {
              header: "OVERLAY URL",
              value: (pr) =>
                theme.muted(
                  `${status.public_base_url}/pr/${pr.owner_id}/${pr.repo}/${pr.pr_number}`,
                ),
            },
          ],
          prs,
        ),
      );
    },
  })
  .command("pr rm <owner> <repo> <number>", {
    description: "Delete a PR overlay immediately",
    args: {
      owner: { description: "GitHub owner name" },
      repo: { description: "Repository name" },
      number: { type: Types.Integer, description: "Pull request number" },
    },
    flags: adminAuthFlags,
    async run(ctx) {
      const { theme } = ctx.log;
      const { owner, repo, number } = ctx.args;
      const res = await adminRequest<{ removed: number }>(
        ctx.flags,
        "DELETE",
        `/api/v1/admin/prs/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(String(number))}`,
      );
      ctx.log
        .success(
          `Removed PR overlay ${theme.bold(`${owner}/${repo}#${String(number)}`)} ${theme.muted(`(${res.removed} store paths deleted)`)}`,
        )
        .line("Unreferenced GHCR blobs will be cleaned on the next GC pass.");
    },
  })
  .command("gc", {
    description: "Trigger garbage collection (auto-drains until complete)",
    group: "admin",
    flags: {
      ...adminAuthFlags,
      dryRun: {
        type: Boolean,
        description: "Report what would be deleted without deleting anything",
      },
      ...jsonFlag,
    },
    async run(ctx) {
      const { theme } = ctx.log;
      const report: GcReport = {
        pr_paths_removed: 0,
        main_paths_removed: 0,
        blobs_deleted: 0,
        blobs_blocked: 0,
        blobs_skipped: 0,
        blob_errors: 0,
      };
      const apiPath = ctx.flags.dryRun
        ? "/api/v1/admin/gc?dry_run=true"
        : "/api/v1/admin/gc";
      let rounds = 0;

      while (true) {
        rounds += 1;
        const step = await adminRequest<GcReport>(ctx.flags, "POST", apiPath);
        report.pr_paths_removed += step.pr_paths_removed;
        report.main_paths_removed += step.main_paths_removed;
        report.blobs_deleted += step.blobs_deleted;
        report.blobs_blocked += step.blobs_blocked;
        report.blobs_skipped = step.blobs_skipped;
        report.blob_errors += step.blob_errors;
        if (step.last_error) {
          report.last_error = step.last_error;
        }

        const madeProgress =
          step.blobs_deleted > 0 ||
          step.blobs_blocked > 0 ||
          step.pr_paths_removed > 0 ||
          step.main_paths_removed > 0;
        if (ctx.flags.dryRun || step.blobs_skipped === 0 || !madeProgress) {
          break;
        }
        if (!ctx.flags.json) {
          ctx.terminal.stderr(
            `  ${theme.muted(`▸ round ${rounds}: ${report.blobs_deleted} blobs deleted (+${step.blobs_deleted})`)}`,
          );
        }
      }

      if (ctx.flags.json) {
        ctx.terminal.stdout(JSON.stringify(report, null, 2));

        return;
      }

      ctx.terminal.stdout(
        renderBanner(
          theme,
          "Garbage Collection",
          ctx.flags.dryRun
            ? theme.warn("dry-run")
            : theme.success(
                rounds > 1 ? `completed (${rounds} rounds)` : "completed",
              ),
        ),
      );
      ctx.terminal.stdout("");
      ctx.terminal.stdout(
        renderKv(theme, [
          ["PR paths removed", theme.bold(String(report.pr_paths_removed))],
          ["Main paths removed", theme.bold(String(report.main_paths_removed))],
          [
            "Blobs deleted",
            report.blobs_deleted > 0
              ? theme.bold(theme.success(String(report.blobs_deleted)))
              : theme.muted("0"),
          ],
          [
            "Blobs blocked",
            report.blobs_blocked > 0
              ? theme.bold(theme.warn(String(report.blobs_blocked)))
              : theme.muted("0"),
          ],
          [
            "Blobs skipped",
            report.blobs_skipped > 0
              ? theme.warn(String(report.blobs_skipped))
              : theme.muted("0"),
          ],
          [
            "Blob errors",
            report.blob_errors > 0
              ? theme.error(String(report.blob_errors))
              : theme.success("0"),
          ],
          ...(report.last_error
            ? [
                ["Last error", theme.error(report.last_error)] as [
                  string,
                  string,
                ],
              ]
            : []),
        ]),
      );
    },
  })
  .command("serve", {
    description: "Run a self-hosted Firn server (Node SQLite or libSQL)",
    group: "server",
    flags: {
      host: {
        type: String,
        env: "HOST",
        default: "127.0.0.1",
        description: "Bind address",
      },
      port: {
        type: Types.Integer,
        env: "PORT",
        default: 8787,
        description: "Bind port",
      },
      ...dbFlags,
      gcInterval: {
        type: Types.Integer,
        env: "GC_INTERVAL_MINUTES",
        default: 30,
        description: "Periodic GC interval in minutes (0 disables)",
      },
    },
    async run(ctx) {
      const running = await startNodeServer({
        host: ctx.flags.host,
        port: ctx.flags.port,
        dbPath: ctx.flags.db,
        libsqlUrl: ctx.flags.libsqlUrl,
        gcIntervalMinutes: ctx.flags.gcInterval,
        env: { ...ctx.terminal.env },
      });

      function shutdown(signal: string) {
        ctx.terminal.stdout(
          JSON.stringify({ message: "shutting down firn server", signal }),
        );
        void running.close().finally(() => process.exit(0));
      }

      process.once("SIGINT", () => shutdown("SIGINT"));
      process.once("SIGTERM", () => shutdown("SIGTERM"));
    },
  })
  .command("migrate", {
    description: "Apply SQL migrations to a SQLite or Turso/libSQL database",
    group: "server",
    flags: dbFlags,
    async run(ctx) {
      const { applied, storage } = await runDatabaseMigrations({
        dbPath: ctx.flags.db,
        libsqlUrl: ctx.flags.libsqlUrl,
        env: { ...ctx.terminal.env },
      });

      if (applied.length === 0) {
        ctx.log.info(`Database (${storage}) is already up to date.`);
      } else {
        ctx.log.success(
          `Applied ${applied.length} migration(s) to ${storage}: ${applied.join(", ")}`,
        );
      }
    },
  });

await cli.runMain();
