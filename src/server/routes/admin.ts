import type { Context, Next } from "hono";

import { validateStoreHash } from "../../shared/nix-format.ts";
import type { AdminStatusResponse } from "../../shared/protocol.ts";
import type { AppBindings } from "../app.ts";
import {
  cacheStats,
  deletePrScope,
  deleteStorePaths,
  listOwnerSummaries,
  listPrScopes,
} from "../db.ts";
import { runGc } from "../gc.ts";
import { extractBearerToken, timingSafeEqualString } from "../github.ts";
import { respondWithStorePaths } from "./ui.ts";

export async function requireAdmin(
  c: Context<AppBindings>,
  next: Next,
): Promise<Response | void> {
  const adminToken = c.get("config").adminToken;
  if (!adminToken) {
    return c.text("admin API is not enabled (ADMIN_TOKEN not set)", 404);
  }
  const candidate = extractBearerToken(c.req.header("authorization"));
  if (!candidate) {
    return c.text("missing or invalid Bearer Authorization header", 401);
  }
  if (!(await timingSafeEqualString(adminToken, candidate))) {
    return c.text("invalid admin token", 401);
  }
  await next();
}

export const handleAdminListPaths = (
  c: Context<AppBindings>,
): Promise<Response> => respondWithStorePaths(c, 500);

export async function handleAdminStatus(
  c: Context<AppBindings>,
): Promise<Response> {
  const config = c.get("config");
  const db = c.get("db");
  const [cache, owners] = await Promise.all([
    cacheStats(db),
    listOwnerSummaries(db, config.ownersByName.values()),
  ]);

  return c.json({
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
  } satisfies AdminStatusResponse);
}

export async function handleAdminDeletePaths(
  c: Context<AppBindings>,
): Promise<Response> {
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
  const owner = c.req.query("owner") || null;
  if (owner && !c.get("config").ownersByName.has(owner)) {
    return c.text(`unknown owner '${owner}'`, 400);
  }

  return c.json(await listPrScopes(c.get("db"), owner));
}

export async function handleAdminDeletePr(
  c: Context<AppBindings>,
): Promise<Response> {
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

export const handleAdminGc = async (
  c: Context<AppBindings>,
): Promise<Response> =>
  c.json(
    await runGc(
      c.get("db"),
      c.get("config"),
      c.req.query("dry_run") === "true",
    ),
  );
