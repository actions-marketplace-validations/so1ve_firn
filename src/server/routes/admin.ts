import type { Context } from "hono";

import { validateStoreHash } from "../../shared/nix-format.ts";
import type {
  AdminStatusResponse,
  OwnerStatusSummary,
} from "../../shared/protocol.ts";
import type { AppBindings } from "../app.ts";
import type { StorePathSort } from "../db.ts";
import {
  cacheStats,
  deletePrScope,
  deleteStorePaths,
  listPrScopes,
  listStorePaths,
  ownerStats,
} from "../db.ts";
import { runGc } from "../gc.ts";
import { timingSafeEqualString } from "../github.ts";

async function requireAdmin(c: Context<AppBindings>): Promise<Response | null> {
  const adminToken = c.get("config").adminToken;
  if (!adminToken) {
    return c.text("admin API is not enabled (ADMIN_TOKEN not set)", 404);
  }

  const authHeader = c.req.header("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return c.text("missing or invalid Bearer Authorization header", 401);
  }
  const candidate = authHeader.slice("Bearer ".length).trim();
  if (!(await timingSafeEqualString(adminToken, candidate))) {
    return c.text("invalid admin token", 401);
  }

  return null;
}

export async function handleAdminStatus(
  c: Context<AppBindings>,
): Promise<Response> {
  const denied = await requireAdmin(c);
  if (denied) {
    return denied;
  }

  const config = c.get("config");
  const cache = await cacheStats(c.get("db"));
  const sortedOwners = [...config.ownersByName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const owners: OwnerStatusSummary[] = await Promise.all(
    sortedOwners.map(async (owner) => {
      const stats = await ownerStats(c.get("db"), owner.name);

      return {
        name: owner.name,
        owner_type: owner.ownerType,
        active_prs: stats.activePrs,
        total_blobs: stats.totalBlobs,
        total_bytes: stats.totalBytes,
        unreferenced_blobs: stats.unreferencedBlobs,
        blocked_blobs: stats.blockedBlobs,
      };
    }),
  );

  const payload: AdminStatusResponse = {
    public_base_url: config.publicBaseUrl,
    gc: {
      pr_ttl_days: config.gc.prTtlDays,
      main_lru_days: config.gc.mainLruDays,
    },
    main_public_key: config.mainKey.publicString(),
    pr_public_key: config.prKey.publicString(),
    main_paths: cache.mainPaths,
    pr_paths: cache.prPaths,
    active_prs: cache.activePrs,
    owners,
  };

  return c.json(payload);
}

export async function handleAdminListPaths(
  c: Context<AppBindings>,
): Promise<Response> {
  const denied = await requireAdmin(c);
  if (denied) {
    return denied;
  }

  const owner = c.req.query("owner") || null;
  if (owner && !c.get("config").ownersByName.has(owner)) {
    return c.text(`unknown owner '${owner}'`, 400);
  }
  const scope = c.req.query("scope") || null;
  const query = c.req.query("q")?.trim() || null;
  const sortRaw = c.req.query("sort") || "accessed";
  if (sortRaw !== "accessed" && sortRaw !== "size") {
    return c.text(`invalid sort '${sortRaw}'`, 400);
  }
  const sort: StorePathSort = sortRaw;
  const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;

  const paths = await listStorePaths(
    c.get("db"),
    owner,
    scope,
    limit,
    query,
    sort,
  );

  return c.json(paths);
}

export async function handleAdminDeletePaths(
  c: Context<AppBindings>,
): Promise<Response> {
  const denied = await requireAdmin(c);
  if (denied) {
    return denied;
  }

  const owner = c.req.query("owner") || null;
  if (owner && !c.get("config").ownersByName.has(owner)) {
    return c.text(`unknown owner '${owner}'`, 400);
  }
  const scope = c.req.query("scope") || null;
  const query = c.req.query("q")?.trim() || null;
  const hash = c.req.query("hash")?.trim() || null;
  if (hash) {
    try {
      validateStoreHash(hash);
    } catch {
      return c.text(`invalid store hash '${hash}'`, 400);
    }
  }

  if (!owner && !scope && !query && !hash) {
    return c.text(
      "at least one filter (owner, scope, q, or hash) is required",
      400,
    );
  }

  const removed = await deleteStorePaths(c.get("db"), {
    ownerId: owner,
    scope,
    storeHash: hash,
    query,
  });

  return c.json({ removed });
}

export async function handleAdminListPrs(
  c: Context<AppBindings>,
): Promise<Response> {
  const denied = await requireAdmin(c);
  if (denied) {
    return denied;
  }

  const owner = c.req.query("owner") || null;
  if (owner && !c.get("config").ownersByName.has(owner)) {
    return c.text(`unknown owner '${owner}'`, 400);
  }

  const prs = await listPrScopes(c.get("db"), owner);

  return c.json(prs);
}

export async function handleAdminDeletePr(
  c: Context<AppBindings>,
): Promise<Response> {
  const denied = await requireAdmin(c);
  if (denied) {
    return denied;
  }

  const owner = c.req.param("owner") ?? "";
  if (!c.get("config").ownersByName.has(owner)) {
    return c.text(`unknown owner '${owner}'`, 404);
  }
  const repo = c.req.param("repo") ?? "";
  const prNumber = Number.parseInt(c.req.param("number") ?? "", 10);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return c.text("invalid pull request number", 400);
  }

  const removed = await deletePrScope(c.get("db"), owner, repo, prNumber);

  return c.json({ owner, repo, pr_number: prNumber, removed });
}

export async function handleAdminGc(
  c: Context<AppBindings>,
): Promise<Response> {
  const denied = await requireAdmin(c);
  if (denied) {
    return denied;
  }

  const dryRun = c.req.query("dry_run") === "true";
  const report = await runGc(c.get("db"), c.get("config"), dryRun);

  return c.json(report);
}
