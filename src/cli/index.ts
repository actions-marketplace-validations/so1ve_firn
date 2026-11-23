#!/usr/bin/env node
import fs from "node:fs";

import {
  Clerc,
  completionsPlugin,
  friendlyErrorPlugin,
  helpPlugin,
  notFoundPlugin,
  strictFlagsPlugin,
  versionPlugin,
} from "clerc";

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
  err,
  formatAge,
  formatBytes,
  formatRemainingTtl,
  formatScope,
  formatStorePath,
  out,
  renderBanner,
  renderKv,
  renderSection,
  renderTable,
} from "./format.ts";
import { runPush } from "./push.ts";

function requireServer(value: string | undefined): string {
  const server = (value ?? process.env.FIRN_SERVER ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!server) {
    throw new Error("--server (or FIRN_SERVER) is required");
  }

  return server;
}

function requireAdminToken(value: string | undefined): string {
  const token = (value ?? process.env.FIRN_ADMIN_TOKEN ?? "").trim();
  if (!token) {
    throw new Error("--token (or FIRN_ADMIN_TOKEN) is required");
  }

  return token;
}

async function adminRequest<T>(
  server: string,
  token: string,
  method: string,
  apiPath: string,
): Promise<T> {
  const url = `${server}${apiPath}`;
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");

    throw new Error(
      `admin request ${method} ${url} failed (${response.status}): ${body}`,
    );
  }

  return await response.json();
}

const adminAuthFlags = {
  server: {
    type: String,
    description: "Base URL of the Firn server (env: FIRN_SERVER)",
  },
  token: {
    type: String,
    description: "Admin Bearer token (env: FIRN_ADMIN_TOKEN)",
  },
} as const;

const cli = Clerc.create({
  scriptName: "firn",
  description: manifest.description,
  version: manifest.version,
})
  .use(versionPlugin())
  .use(
    helpPlugin({
      groups: {
        commands: [
          ["cache", "Cache"],
          ["admin", "Administration"],
        ],
      },
      notes: [
        "Environment variables:",
        "  FIRN_SERVER       Base URL of the Firn server",
        "  FIRN_TOKEN        Static Bearer token for manual pushes",
        "  FIRN_OWNER        GitHub owner name for manual pushes",
        "  FIRN_ADMIN_TOKEN  Admin Bearer token for status / ls / pr / gc",
      ],
    }),
  )
  .use(completionsPlugin())
  .use(strictFlagsPlugin())
  .use(notFoundPlugin())
  .use(friendlyErrorPlugin())
  .errorHandler((error) => {
    console.error(
      `${err.boldRed("✗ Error:")} ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  })
  .command("push", "Push Nix store paths and their closures to a Firn server", {
    help: { group: "cache" },
    parameters: ["[paths...]"],
    flags: {
      server: {
        type: String,
        description: "Base URL of the Firn server (env: FIRN_SERVER)",
      },
      owner: {
        type: String,
        description: "GitHub owner name (env: FIRN_OWNER)",
      },
      token: {
        type: String,
        description: "Manual push Bearer token (env: FIRN_TOKEN)",
      },
      stdin: {
        type: Boolean,
        default: false,
        description: "Read newline-separated store paths from stdin",
      },
      includeUpstream: {
        type: Boolean,
        default: false,
        description: "Upload paths even if signed by cache.nixos.org",
      },
      skipSignedBy: {
        type: [String],
        description: "Signature key prefix to skip (repeatable)",
      },
      jobs: {
        type: Number,
        default: 4,
        description: "Concurrent NAR uploads",
      },
      zstdLevel: {
        type: Number,
        default: 3,
        description: "Zstandard compression level",
      },
    },
  })
  .on("push", async (ctx) => {
    const server = requireServer(ctx.flags.server);
    const skipSignedBy =
      ctx.flags.skipSignedBy.length > 0
        ? ctx.flags.skipSignedBy
        : ["cache.nixos.org-1:"];

    await runPush({
      server,
      owner: ctx.flags.owner ?? process.env.FIRN_OWNER,
      token: ctx.flags.token ?? process.env.FIRN_TOKEN,
      stdin: ctx.flags.stdin,
      includeUpstream: ctx.flags.includeUpstream,
      skipSignedBy,
      jobs: ctx.flags.jobs || 4,
      zstdLevel: ctx.flags.zstdLevel || 3,
      paths: ctx.parameters.paths,
    });
  })
  .command("keygen", "Generate a Nix Ed25519 signing key pair", {
    help: { group: "cache" },
    parameters: ["<name>"],
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
  })
  .on("keygen", async (ctx) => {
    const pair = await SigningKeyPair.generate(ctx.parameters.name);
    const secret = pair.secretString();
    const pub = pair.publicString();

    const entries: [string, string][] = [];
    if (ctx.flags.secretOut) {
      fs.writeFileSync(ctx.flags.secretOut, `${secret}\n`, { mode: 0o600 });
      entries.push([
        "Secret key",
        `${out.green("wrote")} ${ctx.flags.secretOut}`,
      ]);
    } else {
      entries.push(["Secret key", out.yellow(secret)]);
    }

    if (ctx.flags.publicOut) {
      fs.writeFileSync(ctx.flags.publicOut, `${pub}\n`);
      entries.push([
        "Public key",
        `${out.green("wrote")} ${ctx.flags.publicOut}`,
      ]);
    } else {
      entries.push(["Public key", out.green(pub)]);
    }

    console.log(
      `${out.boldGreen("✓")} Generated Ed25519 key pair ${out.bold(ctx.parameters.name)}`,
    );
    console.log(renderKv(entries));
  })
  .command("status", "Show cache keys, usage, and GC-blocked blobs", {
    help: { group: "admin" },
    flags: {
      ...adminAuthFlags,
      json: {
        type: Boolean,
        default: false,
        description: "Output raw JSON",
      },
    },
  })
  .on("status", async (ctx) => {
    const data = await adminRequest<AdminStatusResponse>(
      requireServer(ctx.flags.server),
      requireAdminToken(ctx.flags.token),
      "GET",
      "/api/v1/admin/status",
    );

    if (ctx.flags.json) {
      console.log(JSON.stringify(data, null, 2));

      return;
    }

    const totalBlobs = data.owners.reduce((sum, o) => sum + o.total_blobs, 0);
    const totalBytes = data.owners.reduce((sum, o) => sum + o.total_bytes, 0);
    const totalBlocked = data.owners.reduce(
      (sum, o) => sum + o.blocked_blobs.length,
      0,
    );

    console.log(renderBanner("Firn Cache", data.public_base_url));
    console.log(renderSection("Overview"));
    console.log(
      renderKv([
        [
          "Policy",
          `PR TTL ${out.bold(`${data.gc.pr_ttl_days}d`)}, Main LRU ${out.bold(`${data.gc.main_lru_days}d`)}`,
        ],
        [
          "Store paths",
          `${out.boldGreen(String(data.main_paths))} main, ${out.boldCyan(String(data.pr_paths))} pr ${out.dim(`(${data.active_prs} active PRs)`)}`,
        ],
        [
          "Storage",
          `${out.bold(String(totalBlobs))} blobs (${out.bold(formatBytes(totalBytes))})${
            totalBlocked > 0
              ? `, ${out.boldYellow(`${totalBlocked} gc-blocked`)}`
              : ""
          }`,
        ],
        ["Main key", out.dim(data.main_public_key)],
        ["PR key", out.dim(data.pr_public_key)],
      ]),
    );

    console.log(
      renderSection(
        "Owners & GHCR Storage",
        `(${data.owners.length} configured)`,
      ),
    );
    if (data.owners.length === 0) {
      console.log(`  ${out.dim("No owners configured.")}`);
    } else {
      console.log(
        renderTable<OwnerStatusSummary>(
          [
            { header: "OWNER", value: (o) => out.bold(o.name) },
            { header: "TYPE", value: (o) => out.dim(o.owner_type) },
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
                  ? out.yellow(String(o.unreferenced_blobs))
                  : out.dim("0"),
            },
            {
              header: "ACTIVE PRS",
              align: "right",
              value: (o) =>
                o.active_prs > 0
                  ? out.cyan(String(o.active_prs))
                  : out.dim("0"),
            },
            {
              header: "GC-BLOCKED",
              align: "right",
              value: (o) =>
                o.blocked_blobs.length > 0
                  ? out.boldYellow(String(o.blocked_blobs.length))
                  : out.dim("0"),
            },
          ],
          data.owners,
        ),
      );
    }

    const blockedEntries = data.owners.flatMap((owner) =>
      owner.blocked_blobs.map((blob) => ({ owner: owner.name, ...blob })),
    );
    if (blockedEntries.length > 0) {
      console.log(
        renderSection(
          "GC-Blocked Blobs",
          out.yellow(`(${blockedEntries.length} blocked by GHCR)`),
        ),
      );
      for (const item of blockedEntries) {
        console.log(
          `  ${out.yellow("!")} ${out.bold(`${item.owner}/${item.ghcr_package}`)} ${out.dim(`${item.manifest_digest.slice(0, 19)}…`)}`,
        );
        console.log(`    ${out.dim(item.reason)}`);
      }
    }
  })
  .command("ls", "List cached store paths ordered by recent access", {
    help: { group: "admin" },
    flags: {
      ...adminAuthFlags,
      owner: {
        type: String,
        description: "Filter by GitHub owner",
      },
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
        type: Number,
        default: 50,
        description: "Maximum rows to return (max: 500)",
      },
      json: {
        type: Boolean,
        default: false,
        description: "Output raw JSON",
      },
    },
  })
  .on("ls", async (ctx) => {
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
      requireServer(ctx.flags.server),
      requireAdminToken(ctx.flags.token),
      "GET",
      `/api/v1/admin/paths?${params.toString()}`,
    );

    if (ctx.flags.json) {
      console.log(JSON.stringify(items, null, 2));

      return;
    }

    const filters = [
      ctx.flags.owner ? `owner=${ctx.flags.owner}` : null,
      ctx.flags.scope ? `scope=${ctx.flags.scope}` : null,
      ctx.flags.query ? `q=${ctx.flags.query}` : null,
    ].filter(Boolean);
    const subtitle = [
      `${items.length} shown`,
      ...(filters.length > 0 ? [`(${filters.join(", ")})`] : []),
    ].join(" ");

    console.log(renderBanner("Store Paths", subtitle));
    if (items.length === 0) {
      console.log(`\n  ${out.dim("No cached store paths found.")}`);

      return;
    }

    const now = unixNow();
    console.log("");
    console.log(
      renderTable<StorePathSummary>(
        [
          { header: "OWNER", value: (item) => out.dim(item.owner_id) },
          { header: "SCOPE", value: (item) => formatScope(item.scope) },
          {
            header: "SIZE",
            align: "right",
            value: (item) => formatBytes(item.file_size),
          },
          {
            header: "ACCESSED",
            align: "right",
            value: (item) => out.dim(formatAge(now, item.last_accessed_at)),
          },
          {
            header: "STORE PATH",
            value: (item) => formatStorePath(item.store_path),
          },
        ],
        items,
      ),
    );
  })
  .command("pr ls", "List active PR overlays and remaining TTL", {
    help: { group: "admin" },
    flags: {
      ...adminAuthFlags,
      owner: {
        type: String,
        description: "Filter by GitHub owner",
      },
      json: {
        type: Boolean,
        default: false,
        description: "Output raw JSON",
      },
    },
  })
  .on("pr ls", async (ctx) => {
    const server = requireServer(ctx.flags.server);
    const token = requireAdminToken(ctx.flags.token);
    const [status, prs] = await Promise.all([
      adminRequest<AdminStatusResponse>(
        server,
        token,
        "GET",
        "/api/v1/admin/status",
      ),
      adminRequest<PrScopeSummary[]>(
        server,
        token,
        "GET",
        `/api/v1/admin/prs${ctx.flags.owner ? `?owner=${encodeURIComponent(ctx.flags.owner)}` : ""}`,
      ),
    ]);

    if (ctx.flags.json) {
      console.log(JSON.stringify(prs, null, 2));

      return;
    }

    console.log(
      renderBanner(
        "Active PR Overlays",
        `${prs.length} active (TTL ${status.gc.pr_ttl_days}d)`,
      ),
    );
    if (prs.length === 0) {
      console.log(`\n  ${out.dim("No active PR overlays.")}`);

      return;
    }

    const now = unixNow();
    console.log("");
    console.log(
      renderTable<PrScopeSummary>(
        [
          {
            header: "REPOSITORY",
            value: (pr) => out.bold(`${pr.owner_id}/${pr.repo}`),
          },
          {
            header: "PR",
            align: "right",
            value: (pr) => out.cyan(`#${pr.pr_number}`),
          },
          {
            header: "PATHS",
            align: "right",
            value: (pr) => String(pr.path_count),
          },
          {
            header: "UPDATED",
            align: "right",
            value: (pr) => out.dim(formatAge(now, pr.updated_at)),
          },
          {
            header: "TTL",
            value: (pr) => {
              const ttl = formatRemainingTtl(
                now,
                pr.updated_at,
                status.gc.pr_ttl_days,
              );
              if (ttl.state === "expired") {
                return out.red(ttl.text);
              }
              if (ttl.state === "warn") {
                return out.yellow(ttl.text);
              }

              return out.green(ttl.text);
            },
          },
          {
            header: "OVERLAY URL",
            value: (pr) =>
              out.dim(
                `${status.public_base_url}/pr/${pr.owner_id}/${pr.repo}/${pr.pr_number}`,
              ),
          },
        ],
        prs,
      ),
    );
  })
  .command("pr rm", "Delete a PR overlay immediately", {
    help: { group: "admin" },
    parameters: ["<owner>", "<repo>", "<number>"],
    flags: adminAuthFlags,
  })
  .on("pr rm", async (ctx) => {
    const { owner, repo, number } = ctx.parameters;
    const res = await adminRequest<{ removed: number }>(
      requireServer(ctx.flags.server),
      requireAdminToken(ctx.flags.token),
      "DELETE",
      `/api/v1/admin/prs/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(number)}`,
    );
    console.log(
      `${out.boldGreen("✓")} Removed PR overlay ${out.bold(`${owner}/${repo}#${number}`)} ${out.dim(`(${res.removed} store paths deleted)`)}`,
    );
    console.log(
      `  ${out.dim("Unreferenced GHCR blobs will be cleaned on the next GC pass.")}`,
    );
  })
  .command("gc", "Trigger a garbage collection pass", {
    help: { group: "admin" },
    flags: {
      ...adminAuthFlags,
      dryRun: {
        type: Boolean,
        default: false,
        description: "Report what would be deleted without deleting anything",
      },
      json: {
        type: Boolean,
        default: false,
        description: "Output raw JSON",
      },
    },
  })
  .on("gc", async (ctx) => {
    const query = ctx.flags.dryRun ? "?dry_run=true" : "";
    const report = await adminRequest<GcReport>(
      requireServer(ctx.flags.server),
      requireAdminToken(ctx.flags.token),
      "POST",
      `/api/v1/admin/gc${query}`,
    );

    if (ctx.flags.json) {
      console.log(JSON.stringify(report, null, 2));

      return;
    }

    console.log(
      renderBanner(
        "Garbage Collection",
        ctx.flags.dryRun ? out.yellow("dry-run") : out.green("completed"),
      ),
    );
    console.log("");
    console.log(
      renderKv([
        ["PR paths removed", out.bold(String(report.pr_paths_removed))],
        ["Main paths removed", out.bold(String(report.main_paths_removed))],
        [
          "Blobs deleted",
          report.blobs_deleted > 0
            ? out.boldGreen(String(report.blobs_deleted))
            : out.dim("0"),
        ],
        [
          "Blobs blocked",
          report.blobs_blocked > 0
            ? out.boldYellow(String(report.blobs_blocked))
            : out.dim("0"),
        ],
        [
          "Blobs skipped",
          report.blobs_skipped > 0
            ? out.yellow(String(report.blobs_skipped))
            : out.dim("0"),
        ],
        [
          "Blob errors",
          report.blob_errors > 0
            ? out.boldRed(String(report.blob_errors))
            : out.green("0"),
        ],
      ]),
    );
  })
  .command("serve", "Run a self-hosted Firn server (Node SQLite or libSQL)", {
    flags: {
      host: {
        type: String,
        description: "Bind address (default: HOST env or 127.0.0.1)",
      },
      port: {
        type: Number,
        description: "Bind port (default: PORT env or 8787)",
      },
      db: {
        type: String,
        description:
          "Local SQLite database path (default: FIRN_DB_PATH env or ./firn.db)",
      },
      libsqlUrl: {
        type: String,
        description:
          "Remote Turso/libSQL URL (overrides --db; default: LIBSQL_URL env)",
      },
      gcInterval: {
        type: Number,
        description:
          "Periodic GC interval in minutes; 0 disables (default: GC_INTERVAL_MINUTES env or 30)",
      },
    },
  })
  .on("serve", async (ctx) => {
    const running = await startNodeServer({
      ...(ctx.flags.host === undefined ? {} : { host: ctx.flags.host }),
      ...(ctx.flags.port === undefined ? {} : { port: ctx.flags.port }),
      ...(ctx.flags.db === undefined ? {} : { dbPath: ctx.flags.db }),
      ...(ctx.flags.libsqlUrl === undefined
        ? {}
        : { libsqlUrl: ctx.flags.libsqlUrl }),
      ...(ctx.flags.gcInterval === undefined
        ? {}
        : { gcIntervalMinutes: ctx.flags.gcInterval }),
    });

    function shutdown(signal: string) {
      console.log(
        JSON.stringify({ message: "shutting down firn server", signal }),
      );
      void running.close().finally(() => {
        process.exit(0);
      });
    }

    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  })
  .command(
    "migrate",
    "Apply SQL migrations to a SQLite or Turso/libSQL database",
    {
      flags: {
        db: {
          type: String,
          description:
            "Local SQLite database path (default: FIRN_DB_PATH env or ./firn.db)",
        },
        libsqlUrl: {
          type: String,
          description:
            "Remote Turso/libSQL URL (overrides --db; default: LIBSQL_URL env)",
        },
      },
    },
  )
  .on("migrate", async (ctx) => {
    const { applied, storage } = await runDatabaseMigrations({
      ...(ctx.flags.db === undefined ? {} : { dbPath: ctx.flags.db }),
      ...(ctx.flags.libsqlUrl === undefined
        ? {}
        : { libsqlUrl: ctx.flags.libsqlUrl }),
    });

    if (applied.length === 0) {
      console.log(`Database (${storage}) is already up to date.`);
    } else {
      console.log(
        `Applied ${applied.length} migration(s) to ${storage}: ${applied.join(", ")}`,
      );
    }
  });

await cli.parse();
