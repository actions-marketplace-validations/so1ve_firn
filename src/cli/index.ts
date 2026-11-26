#!/usr/bin/env node
import fs from "node:fs";

import { completionsPlugin } from "@clerc/plugin-completions";
import type { Logger, Theme } from "clerc";
import { ClercError, Complete, Types, clerc } from "clerc";

import manifest from "../../package.json" with { type: "json" };
import { runDatabaseMigrations, startNodeServer } from "../entry/node.ts";
import { readBody, stripTrailingSlash } from "../shared/format.ts";
import { SigningKeyPair, unixNow } from "../shared/nix-format.ts";
import type {
  AdminStatusResponse,
  GcReport,
  OwnerStatusSummary,
  PrScopeSummary,
  StorePathSummary,
} from "../shared/protocol.ts";
import {
  col,
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

const nonEmptyString = Types.String({ trim: true, nonEmpty: true });

const serverFlag = {
  type: nonEmptyString,
  placeholder: "<url>",
  env: "FIRN_SERVER",
  required: true,
  group: "auth",
  description: "Base URL of the Firn server",
} as const;

const jsonFlag = {
  type: Boolean,
  group: "output",
  description: "Output raw JSON",
} as const;

const styledCount = (
  value: number,
  theme: Theme,
  highlight: (text: string) => string,
): string => (value > 0 ? highlight(String(value)) : theme.muted("0"));

const printJson = (log: Logger, data: unknown): void =>
  log.raw(JSON.stringify(data, null, 2));

async function drainGc(
  adminRequest: <T>(method: string, apiPath: string) => Promise<T>,
  dryRun: boolean,
  onProgress?: (rounds: number, deletedTotal: number, added: number) => void,
): Promise<{ report: GcReport; rounds: number }> {
  const report: GcReport = {
    pr_paths_removed: 0,
    main_paths_removed: 0,
    blobs_deleted: 0,
    blobs_blocked: 0,
    blobs_skipped: 0,
    blob_errors: 0,
  };
  const apiPath = dryRun ? "/api/v1/admin/gc?dry_run=true" : "/api/v1/admin/gc";
  let rounds = 0;

  while (true) {
    rounds += 1;
    const step = await adminRequest<GcReport>("POST", apiPath);
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
    if (dryRun || step.blobs_skipped === 0 || !madeProgress) {
      return { report, rounds };
    }
    onProgress?.(rounds, report.blobs_deleted, step.blobs_deleted);
  }
}

const cli = clerc({
  name: "firn",
  description: manifest.description,
  version: manifest.version,
  examples: [
    ["$ firn push ./result", "Push a build output and its closure"],
    [
      "$ nix build --print-out-paths | firn push --stdin",
      "Push build outputs piped from stdin",
    ],
    ["$ firn status", "Show cache keys, usage, and GC-blocked blobs"],
    ["$ firn pr ls", "List active PR overlays and remaining TTL"],
    ["$ firn serve --host 0.0.0.0 --port 8787", "Run a self-hosted server"],
  ],
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
    flags: {
      auth: "Authentication",
      filter: "Filters",
      output: "Output",
      database: "Database",
    },
  })
  .use(completionsPlugin());

const cache = cli.scope({ group: "cache" });

cache.command("push [paths...]", {
  description: "Push Nix store paths and their closures to a Firn server",
  args: {
    paths: {
      description: "Nix store paths or symlinks to push",
      complete: Complete.file(),
    },
  },
  flags: {
    server: serverFlag,
    owner: {
      type: nonEmptyString,
      placeholder: "<name>",
      env: "FIRN_OWNER",
      group: "auth",
      description: "GitHub owner name",
    },
    token: {
      type: nonEmptyString,
      placeholder: "<token>",
      env: "FIRN_TOKEN",
      group: "auth",
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
      type: nonEmptyString,
      placeholder: "<prefix>",
      multiple: true,
      unique: true,
      default: ["cache.nixos.org-1:"],
      complete: Complete.list([
        {
          value: "cache.nixos.org-1:",
          description: "Official NixOS binary cache",
        },
      ]),
      description: "Signature key prefix to skip (repeatable)",
    },
    jobs: {
      type: Types.Integer({ min: 1 }),
      default: 4,
      description: "Concurrent NAR uploads",
    },
    zstdLevel: {
      type: Types.Integer({ min: 1, max: 22 }),
      default: 3,
      description: "Zstandard compression level",
    },
  },
  rules: (r) => [
    r.atLeastOne([r.arg("paths"), r.flag("stdin")], {
      hints: ["pass one or more <paths...> or use '--stdin'"],
    }),
    r.exclusive(r.flag("includeUpstream"), r.flag("skipSignedBy")),
  ],
  async run(ctx) {
    await runPush({
      ...ctx.flags,
      ...ctx.args,
      readStdin: ctx.terminal.readStdin,
      log: ctx.log,
    });
  },
});

cache.command("keygen <name>", {
  description: "Generate a Nix Ed25519 signing key pair",
  args: {
    name: {
      type: nonEmptyString,
      description: "Signing key name (e.g. cache.example.com-1)",
    },
  },
  flags: {
    secretOut: {
      type: nonEmptyString,
      placeholder: "<path>",
      short: "s",
      complete: Complete.file(),
      description: "Write secret key to file (mode 0600)",
    },
    publicOut: {
      type: nonEmptyString,
      placeholder: "<path>",
      short: "p",
      complete: Complete.file(),
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
});

const admin = cli
  .scope({ group: "admin" })
  .flags({
    server: serverFlag,
    token: {
      type: nonEmptyString,
      placeholder: "<token>",
      env: "FIRN_ADMIN_TOKEN",
      required: true,
      group: "auth",
      description: "Admin Bearer token",
    },
  })
  .middleware((ctx, next) => {
    const baseUrl = stripTrailingSlash(ctx.flags.server);
    const { token } = ctx.flags;

    return next({
      adminRequest: async <T>(method: string, apiPath: string): Promise<T> => {
        const url = `${baseUrl}${apiPath}`;
        const response = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${token}` },
          signal: ctx.signal,
        });
        if (!response.ok) {
          throw new ClercError(
            `Admin request ${method} ${apiPath} failed (${response.status})`,
            {
              code: "ERR_ADMIN_REQUEST",
              detail: await readBody(response),
              hints:
                response.status === 401 || response.status === 403
                  ? [
                      "Check --token / FIRN_ADMIN_TOKEN against the server's ADMIN_TOKEN",
                    ]
                  : [`Verify the Firn server is reachable at ${baseUrl}`],
            },
          );
        }

        return await response.json();
      },
    });
  });

const adminJson = admin.scope().flags({ json: jsonFlag });

adminJson.command("status", {
  description: "Show cache keys, usage, and GC-blocked blobs",
  async run(ctx) {
    const { theme } = ctx.log;
    const data = await ctx.state.adminRequest<AdminStatusResponse>(
      "GET",
      "/api/v1/admin/status",
    );
    if (ctx.flags.json) {
      printJson(ctx.log, data);

      return;
    }

    const totalBlobs = data.owners.reduce((sum, o) => sum + o.total_blobs, 0);
    const totalBytes = data.owners.reduce((sum, o) => sum + o.total_bytes, 0);
    const blocked = data.owners.flatMap((owner) =>
      owner.blocked_blobs.map((blob) => ({ owner: owner.name, ...blob })),
    );

    const lines = [
      renderBanner(theme, "Firn Cache", data.public_base_url),
      renderSection(theme, "Overview"),
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
            blocked.length > 0
              ? `, ${theme.bold(theme.warn(`${blocked.length} gc-blocked`))}`
              : ""
          }`,
        ],
        ["Main key", theme.muted(data.main_public_key)],
        ["PR key", theme.muted(data.pr_public_key)],
      ]),
      renderSection(
        theme,
        "Owners & GHCR Storage",
        `(${data.owners.length} configured)`,
      ),
      data.owners.length === 0
        ? `  ${theme.muted("No owners configured.")}`
        : renderTable<OwnerStatusSummary>(
            theme,
            [
              col("OWNER", (o) => theme.bold(o.name)),
              col("TYPE", (o) => theme.muted(o.owner_type)),
              col("BLOBS", (o) => String(o.total_blobs), "right"),
              col("SIZE", (o) => formatBytes(o.total_bytes), "right"),
              col(
                "UNREF",
                (o) => styledCount(o.unreferenced_blobs, theme, theme.warn),
                "right",
              ),
              col(
                "ACTIVE PRS",
                (o) => styledCount(o.active_prs, theme, theme.accent),
                "right",
              ),
              col(
                "GC-BLOCKED",
                (o) =>
                  styledCount(o.blocked_blobs.length, theme, (s) =>
                    theme.bold(theme.warn(s)),
                  ),
                "right",
              ),
            ],
            data.owners,
          ),
    ];

    if (blocked.length > 0) {
      lines.push(
        renderSection(
          theme,
          "GC-Blocked Blobs",
          theme.warn(`(${blocked.length} blocked by GHCR)`),
        ),
        ...blocked.map(
          (item) =>
            `  ${theme.warn("!")} ${theme.bold(`${item.owner}/${item.ghcr_package}`)} ${theme.muted(`${item.manifest_digest.slice(0, 19)}…`)}\n    ${theme.muted(item.reason)}`,
        ),
      );
    }

    ctx.log.raw(lines.join("\n"));
  },
});

adminJson.command("ls", {
  description: "List cached store paths ordered by recent access",
  flags: {
    owner: {
      type: nonEmptyString,
      placeholder: "<name>",
      group: "filter",
      description: "Filter by GitHub owner",
    },
    scope: {
      type: nonEmptyString,
      placeholder: "<scope>",
      group: "filter",
      complete: Complete.list([
        { value: "main", description: "Main branch cache" },
      ]),
      description: "Filter by scope (main or pr:<owner>:<repo>:<n>)",
    },
    query: {
      type: nonEmptyString,
      placeholder: "<text>",
      short: "q",
      group: "filter",
      description: "Filter store paths by substring",
    },
    limit: {
      type: Types.Integer({ min: 1, max: 500 }),
      default: 50,
      group: "filter",
      description: "Maximum rows to return",
    },
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

    const items = await ctx.state.adminRequest<StorePathSummary[]>(
      "GET",
      `/api/v1/admin/paths?${params.toString()}`,
    );
    if (ctx.flags.json) {
      printJson(ctx.log, items);

      return;
    }

    const filters = [
      ctx.flags.owner && `owner=${ctx.flags.owner}`,
      ctx.flags.scope && `scope=${ctx.flags.scope}`,
      ctx.flags.query && `q=${ctx.flags.query}`,
    ].filter(Boolean);
    const subtitle =
      filters.length > 0
        ? `${items.length} shown (${filters.join(", ")})`
        : `${items.length} shown`;

    if (items.length === 0) {
      ctx.log.raw(
        `${renderBanner(theme, "Store Paths", subtitle)}\n\n  ${theme.muted("No cached store paths found.")}`,
      );

      return;
    }

    const now = unixNow();
    ctx.log.raw(
      [
        renderBanner(theme, "Store Paths", subtitle),
        "",
        renderTable<StorePathSummary>(
          theme,
          [
            col("OWNER", (item) => theme.muted(item.owner_id)),
            col("SCOPE", (item) => formatScope(theme, item.scope)),
            col("SIZE", (item) => formatBytes(item.file_size), "right"),
            col(
              "ACCESSED",
              (item) => theme.muted(formatAge(now, item.last_accessed_at)),
              "right",
            ),
            col("STORE PATH", (item) =>
              formatStorePath(theme, item.store_path),
            ),
          ],
          items,
        ),
      ].join("\n"),
    );
  },
});

const pr = admin.subcommand("pr", {
  description: "Inspect and manage PR cache overlays",
});

pr.command("ls", {
  description: "List active PR overlays and remaining TTL",
  flags: {
    owner: {
      type: nonEmptyString,
      placeholder: "<name>",
      group: "filter",
      description: "Filter by GitHub owner",
    },
    json: jsonFlag,
  },
  async run(ctx) {
    const { theme } = ctx.log;
    const prsPath = `/api/v1/admin/prs${ctx.flags.owner ? `?owner=${encodeURIComponent(ctx.flags.owner)}` : ""}`;
    if (ctx.flags.json) {
      printJson(
        ctx.log,
        await ctx.state.adminRequest<PrScopeSummary[]>("GET", prsPath),
      );

      return;
    }

    const [status, prs] = await Promise.all([
      ctx.state.adminRequest<AdminStatusResponse>(
        "GET",
        "/api/v1/admin/status",
      ),
      ctx.state.adminRequest<PrScopeSummary[]>("GET", prsPath),
    ]);
    const banner = renderBanner(
      theme,
      "Active PR Overlays",
      `${prs.length} active (TTL ${status.gc.pr_ttl_days}d)`,
    );
    if (prs.length === 0) {
      ctx.log.raw(`${banner}\n\n  ${theme.muted("No active PR overlays.")}`);

      return;
    }

    const now = unixNow();
    ctx.log.raw(
      [
        banner,
        "",
        renderTable<PrScopeSummary>(
          theme,
          [
            col("REPOSITORY", (item) =>
              theme.bold(`${item.owner_id}/${item.repo}`),
            ),
            col("PR", (item) => theme.accent(`#${item.pr_number}`), "right"),
            col("PATHS", (item) => String(item.path_count), "right"),
            col(
              "UPDATED",
              (item) => theme.muted(formatAge(now, item.updated_at)),
              "right",
            ),
            col("TTL", (item) => {
              const ttl = formatRemainingTtl(
                now,
                item.updated_at,
                status.gc.pr_ttl_days,
              );
              const color =
                ttl.state === "expired"
                  ? theme.error
                  : ttl.state === "warn"
                    ? theme.warn
                    : theme.success;

              return color(ttl.text);
            }),
            col("OVERLAY URL", (item) =>
              theme.muted(
                `${status.public_base_url}/pr/${item.owner_id}/${item.repo}/${item.pr_number}`,
              ),
            ),
          ],
          prs,
        ),
      ].join("\n"),
    );
  },
});

pr.command("rm <owner> <repo> <number>", {
  description: "Delete a PR overlay immediately",
  args: {
    owner: { type: nonEmptyString, description: "GitHub owner name" },
    repo: { type: nonEmptyString, description: "Repository name" },
    number: {
      type: Types.Integer({ min: 1 }),
      description: "Pull request number",
    },
  },
  async run(ctx) {
    const { theme } = ctx.log;
    const { owner, repo, number } = ctx.args;
    const res = await ctx.state.adminRequest<{ removed: number }>(
      "DELETE",
      `/api/v1/admin/prs/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`,
    );
    ctx.log
      .success(
        `Removed PR overlay ${theme.bold(`${owner}/${repo}#${number}`)} ${theme.muted(`(${res.removed} store paths deleted)`)}`,
      )
      .line("Unreferenced GHCR blobs will be cleaned on the next GC pass.");
  },
});

adminJson.command("gc", {
  description: "Trigger garbage collection (auto-drains until complete)",
  flags: {
    dryRun: {
      type: Boolean,
      description: "Report what would be deleted without deleting anything",
    },
  },
  async run(ctx) {
    const { theme } = ctx.log;
    const spinner = ctx.flags.json
      ? null
      : ctx.log.spinner({ signal: ctx.signal });
    spinner?.start(
      ctx.flags.dryRun
        ? "Running garbage collection dry-run..."
        : "Running garbage collection...",
    );

    let result: { report: GcReport; rounds: number };
    try {
      result = await drainGc(
        ctx.state.adminRequest,
        ctx.flags.dryRun,
        (rounds, total, added) => {
          spinner?.message(
            `round ${rounds}: ${total} blobs deleted (+${added})`,
          );
        },
      );
    } finally {
      spinner?.clear();
    }

    const { report, rounds } = result;
    if (ctx.flags.json) {
      printJson(ctx.log, report);

      return;
    }

    const rows: [string, string][] = [
      ["PR paths removed", theme.bold(String(report.pr_paths_removed))],
      ["Main paths removed", theme.bold(String(report.main_paths_removed))],
      [
        "Blobs deleted",
        styledCount(report.blobs_deleted, theme, (s) =>
          theme.bold(theme.success(s)),
        ),
      ],
      [
        "Blobs blocked",
        styledCount(report.blobs_blocked, theme, (s) =>
          theme.bold(theme.warn(s)),
        ),
      ],
      ["Blobs skipped", styledCount(report.blobs_skipped, theme, theme.warn)],
      [
        "Blob errors",
        report.blob_errors > 0
          ? theme.error(String(report.blob_errors))
          : theme.success("0"),
      ],
    ];
    if (report.last_error) {
      rows.push(["Last error", theme.error(report.last_error)]);
    }

    ctx.log.raw(
      [
        renderBanner(
          theme,
          "Garbage Collection",
          ctx.flags.dryRun
            ? theme.warn("dry-run")
            : theme.success(
                rounds > 1 ? `completed (${rounds} rounds)` : "completed",
              ),
        ),
        "",
        renderKv(theme, rows),
      ].join("\n"),
    );
  },
});

const server = cli.scope({ group: "server" }).flags({
  db: {
    type: nonEmptyString,
    placeholder: "<path>",
    env: "FIRN_DB_PATH",
    default: "./firn.db",
    group: "database",
    complete: Complete.file(),
    description: "Local SQLite database path",
  },
  libsqlUrl: {
    type: nonEmptyString,
    placeholder: "<url>",
    env: "LIBSQL_URL",
    group: "database",
    description: "Remote Turso/libSQL URL (overrides --db)",
  },
});

server.command("serve", {
  description: "Run a self-hosted Firn server (Node SQLite or libSQL)",
  flags: {
    host: {
      type: nonEmptyString,
      placeholder: "<addr>",
      env: "HOST",
      default: "127.0.0.1",
      description: "Bind address",
    },
    port: {
      type: Types.Integer({ min: 0, max: 65_535 }),
      env: "PORT",
      default: 8787,
      description: "Bind port",
    },
    gcInterval: {
      type: Types.Integer({ min: 0 }),
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

    const { signal } = ctx;
    if (!signal) {
      return;
    }

    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
      } else {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }
    });

    ctx.terminal.stdout(
      JSON.stringify({
        message: "shutting down firn server",
        reason:
          signal.reason instanceof Error ? signal.reason.message : "aborted",
      }),
    );
    await running.close();
  },
});

server.command("migrate", {
  description: "Apply SQL migrations to a SQLite or Turso/libSQL database",
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
