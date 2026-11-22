#!/usr/bin/env node
import fs from "node:fs";
import { parseArgs } from "node:util";

import manifest from "../../package.json" with { type: "json" };
import { SigningKeyPair, unixNow } from "../shared/nix-format.ts";
import type {
  AdminStatusResponse,
  GcReport,
  PrScopeSummary,
  StorePathSummary,
} from "../shared/protocol.ts";
import { runPush } from "./push.ts";

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * 60;
const SECONDS_PER_DAY = 24 * 60 * 60;

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx + 1 < units.length) {
    value /= 1024;
    idx += 1;
  }

  return idx === 0 ? `${bytes} B` : `${value.toFixed(2)} ${units[idx]}`;
}

function formatAge(now: number, timestamp: number): string {
  const delta = Math.max(0, now - timestamp);
  if (delta < SECONDS_PER_MINUTE) {
    return `${delta}s ago`;
  }
  if (delta < SECONDS_PER_HOUR) {
    return `${Math.floor(delta / SECONDS_PER_MINUTE)}m ago`;
  }
  if (delta < SECONDS_PER_DAY) {
    return `${Math.floor(delta / SECONDS_PER_HOUR)}h ago`;
  }

  return `${Math.floor(delta / SECONDS_PER_DAY)}d ago`;
}

function formatRemainingTtl(
  now: number,
  updatedAt: number,
  ttlDays: number,
): string {
  const remaining = updatedAt + ttlDays * SECONDS_PER_DAY - now;
  if (remaining <= 0) {
    return "expired";
  }
  if (remaining < SECONDS_PER_HOUR) {
    return `${Math.max(1, Math.floor(remaining / SECONDS_PER_MINUTE))}m left`;
  }
  if (remaining < SECONDS_PER_DAY) {
    return `${Math.floor(remaining / SECONDS_PER_HOUR)}h left`;
  }

  return `${Math.floor(remaining / SECONDS_PER_DAY)}d left`;
}

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

async function handleKeygen(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "secret-out": { type: "string", short: "s" },
      "public-out": { type: "string", short: "p" },
      "help": { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help || positionals.length !== 1) {
    console.log("Usage: firn keygen <NAME> [-s FILE] [-p FILE]");
    if (!values.help) {
      process.exit(1);
    }

    return;
  }

  const pair = await SigningKeyPair.generate(positionals[0]);
  const secret = pair.secretString();
  const pub = pair.publicString();

  if (values["secret-out"]) {
    fs.writeFileSync(values["secret-out"], `${secret}\n`, { mode: 0o600 });
    console.log(`Wrote secret key to ${values["secret-out"]}`);
  } else {
    console.log(`Secret key: ${secret}`);
  }

  if (values["public-out"]) {
    fs.writeFileSync(values["public-out"], `${pub}\n`);
    console.log(`Wrote public key to ${values["public-out"]}`);
  } else {
    console.log(`Public key: ${pub}`);
  }
}

async function handlePush(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "server": { type: "string" },
      "owner": { type: "string" },
      "token": { type: "string" },
      "stdin": { type: "boolean", default: false },
      "include-upstream": { type: "boolean", default: false },
      "skip-signed-by": { type: "string", multiple: true },
      "jobs": { type: "string", default: "4" },
      "zstd-level": { type: "string", default: "3" },
      "help": { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`Usage: firn push --server <URL> [options] [PATHS...]

Options:
  --server <URL>           Base URL of the Firn server (env: FIRN_SERVER)
  --owner <NAME>           GitHub owner name (env: FIRN_OWNER)
  --token <TOKEN>          Manual push Bearer token (env: FIRN_TOKEN)
  --stdin                  Read newline-separated store paths from stdin
  --include-upstream       Upload paths even if signed by cache.nixos.org
  --skip-signed-by <KEY>   Signature key prefix to skip (repeatable)
  --jobs <N>               Concurrent NAR uploads (default: 4)
  --zstd-level <N>         Zstandard compression level (default: 3)`);

    return;
  }

  const server = requireServer(values.server);
  const skipSignedBy =
    values["skip-signed-by"] && values["skip-signed-by"].length > 0
      ? values["skip-signed-by"]
      : ["cache.nixos.org-1:"];

  await runPush({
    server,
    owner: values.owner ?? process.env.FIRN_OWNER,
    token: values.token ?? process.env.FIRN_TOKEN,
    stdin: values.stdin,
    includeUpstream: values["include-upstream"],
    skipSignedBy,
    jobs: Number.parseInt(values.jobs, 10) || 4,
    zstdLevel: Number.parseInt(values["zstd-level"], 10) || 3,
    paths: positionals,
  });
}

async function handleStatus(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      server: { type: "string" },
      token: { type: "string" },
    },
    strict: true,
  });

  const data = await adminRequest<AdminStatusResponse>(
    requireServer(values.server),
    requireAdminToken(values.token),
    "GET",
    "/api/v1/admin/status",
  );

  console.log(`Public URL:  ${data.public_base_url}`);
  console.log(
    `GC policy:   pr_ttl=${data.gc.pr_ttl_days}d, main_lru=${data.gc.main_lru_days}d`,
  );
  console.log(`Main key:    ${data.main_public_key}`);
  console.log(`PR key:      ${data.pr_public_key}`);
  console.log(
    `Store paths: ${data.main_paths} main, ${data.pr_paths} pr (${data.active_prs} active PRs)`,
  );

  for (const owner of data.owners) {
    console.log(`\n[${owner.name}] (${owner.owner_type})`);
    console.log(`  active PRs:   ${owner.active_prs}`);
    console.log(
      `  blobs:        ${owner.total_blobs} total (${formatBytes(owner.total_bytes)}), ${owner.unreferenced_blobs} unreferenced, ${owner.blocked_blobs.length} gc-blocked`,
    );
    for (const blocked of owner.blocked_blobs) {
      console.log(
        `  blocked:      ${blocked.ghcr_package} ${blocked.manifest_digest} (${blocked.reason})`,
      );
    }
  }
}

async function handleLs(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      server: { type: "string" },
      token: { type: "string" },
      owner: { type: "string" },
      scope: { type: "string" },
      limit: { type: "string", default: "50" },
    },
    strict: true,
  });

  const params = new URLSearchParams({ limit: values.limit });
  if (values.owner) {
    params.set("owner", values.owner);
  }
  if (values.scope) {
    params.set("scope", values.scope);
  }

  const items = await adminRequest<StorePathSummary[]>(
    requireServer(values.server),
    requireAdminToken(values.token),
    "GET",
    `/api/v1/admin/paths?${params.toString()}`,
  );

  if (items.length === 0) {
    console.log("No cached store paths found.");

    return;
  }

  const now = unixNow();
  console.log(
    `${"OWNER".padEnd(12)} ${"SCOPE".padEnd(24)} ${"SIZE".padStart(10)} ${"ACCESSED".padStart(10)}  STORE PATH`,
  );
  for (const item of items) {
    console.log(
      `${item.owner_id.padEnd(12)} ${item.scope.padEnd(24)} ${formatBytes(item.file_size).padStart(10)} ${formatAge(now, item.last_accessed_at).padStart(10)}  ${item.store_path}`,
    );
  }
}

async function handlePr(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "ls") {
    const { values } = parseArgs({
      args: rest,
      options: {
        server: { type: "string" },
        token: { type: "string" },
        owner: { type: "string" },
      },
      strict: true,
    });
    const server = requireServer(values.server);
    const token = requireAdminToken(values.token);
    const status = await adminRequest<AdminStatusResponse>(
      server,
      token,
      "GET",
      "/api/v1/admin/status",
    );
    const query = values.owner
      ? `?owner=${encodeURIComponent(values.owner)}`
      : "";
    const prs = await adminRequest<PrScopeSummary[]>(
      server,
      token,
      "GET",
      `/api/v1/admin/prs${query}`,
    );

    if (prs.length === 0) {
      console.log("No active PR overlays.");

      return;
    }

    const now = unixNow();
    console.log(
      `${"OWNER".padEnd(12)} ${"REPO".padEnd(24)} ${"PR".padStart(6)} ${"PATHS".padStart(7)} ${"UPDATED".padStart(10)}  TTL`,
    );
    for (const pr of prs) {
      console.log(
        `${pr.owner_id.padEnd(12)} ${pr.repo.padEnd(24)} ${`#${pr.pr_number}`.padStart(6)} ${String(pr.path_count).padStart(7)} ${formatAge(now, pr.updated_at).padStart(10)}  ${formatRemainingTtl(now, pr.updated_at, status.gc.pr_ttl_days)}`,
      );
    }

    return;
  }

  if (sub === "rm") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        server: { type: "string" },
        token: { type: "string" },
      },
      strict: true,
    });
    if (positionals.length !== 3) {
      throw new Error("Usage: firn pr rm <OWNER> <REPO> <NUMBER>");
    }
    const [owner, repo, number] = positionals as [string, string, string];
    const res = await adminRequest<{ removed: number }>(
      requireServer(values.server),
      requireAdminToken(values.token),
      "DELETE",
      `/api/v1/admin/prs/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(number)}`,
    );
    console.log(
      `Removed PR overlay ${owner}/${repo}#${number} (${res.removed} store paths deleted; unreferenced blobs will be cleaned on next GC)`,
    );

    return;
  }

  throw new Error("Usage: firn pr <ls|rm> [options]");
}

async function handleGc(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "server": { type: "string" },
      "token": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });
  const query = values["dry-run"] ? "?dry_run=true" : "";
  const report = await adminRequest<GcReport>(
    requireServer(values.server),
    requireAdminToken(values.token),
    "POST",
    `/api/v1/admin/gc${query}`,
  );
  console.log(
    `GC finished (dry_run=${values["dry-run"]}): pr_paths_removed=${report.pr_paths_removed}, main_paths_removed=${report.main_paths_removed}, blobs_deleted=${report.blobs_deleted}, blobs_protected=${report.blobs_protected}, blobs_skipped=${report.blobs_skipped}, blob_errors=${report.blob_errors}`,
  );
}

function printHelp(): void {
  console.log(`firn ${manifest.version}

Stateful Nix binary cache backed by GHCR and Cloudflare Workers + D1.

Usage:
  firn <command> [options]

Commands:
  push      Push Nix store paths and their closures to a Firn server
  keygen    Generate a Nix Ed25519 signing key pair
  status    Show cache keys, usage, and GC-blocked blobs
  ls        List cached store paths ordered by recent access
  pr ls     List active PR overlays and remaining TTL
  pr rm     Delete a PR overlay immediately
  gc        Trigger a garbage collection pass

Environment variables:
  FIRN_SERVER       Base URL of the Firn server
  FIRN_TOKEN        Static Bearer token for manual pushes
  FIRN_OWNER        GitHub owner name for manual pushes
  FIRN_ADMIN_TOKEN  Admin Bearer token for status/ls/pr/gc`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") {
    printHelp();

    return;
  }
  if (command === "-V" || command === "--version") {
    console.log(manifest.version);

    return;
  }

  switch (command) {
    case "push": {
      await handlePush(rest);

      break;
    }
    case "keygen": {
      await handleKeygen(rest);

      break;
    }
    case "status": {
      await handleStatus(rest);

      break;
    }
    case "ls": {
      await handleLs(rest);

      break;
    }
    case "pr": {
      await handlePr(rest);

      break;
    }
    case "gc": {
      await handleGc(rest);

      break;
    }
    default: {
      throw new Error(`unknown command '${command}'. Run 'firn --help'.`);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
