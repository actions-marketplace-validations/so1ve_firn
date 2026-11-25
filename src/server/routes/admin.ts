import type { Context, Next } from "hono";

import { validateStoreHash } from "../../shared/nix-format.ts";
import type { AdminStatusResponse } from "../../shared/protocol.ts";
import type { AppBindings } from "../app.ts";
import { HttpError, parseOwnerQuery, parsePrParams } from "../app.ts";
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
    throw new HttpError(404, "admin API is not enabled (ADMIN_TOKEN not set)");
  }
  const candidate = extractBearerToken(c.req.header("authorization"));
  if (!candidate) {
    throw new HttpError(401, "missing or invalid Bearer Authorization header");
  }
  if (!(await timingSafeEqualString(adminToken, candidate))) {
    throw new HttpError(401, "invalid admin token");
  }
  await next();
}

export const handleAdminListPaths = (c: Context<AppBindings>) =>
  respondWithStorePaths(c, 500);

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
  const owner = parseOwnerQuery(c);
  const scope = c.req.query("scope") || null;
  const query = c.req.query("q")?.trim() || null;
  const hash = c.req.query("hash")?.trim() || null;
  if (hash) {
    try {
      validateStoreHash(hash);
    } catch {
      throw new HttpError(400, `invalid store hash '${hash}'`);
    }
  }
  if (!owner && !scope && !query && !hash) {
    throw new HttpError(
      400,
      "at least one filter (owner, scope, q, or hash) is required",
    );
  }

  return c.json({
    removed: await deleteStorePaths(c.get("db"), {
      ownerId: owner,
      scope,
      storeHash: hash,
      query,
    }),
  });
}

export const handleAdminListPrs = async (
  c: Context<AppBindings>,
): Promise<Response> =>
  c.json(await listPrScopes(c.get("db"), parseOwnerQuery(c)));

export async function handleAdminDeletePr(
  c: Context<AppBindings>,
): Promise<Response> {
  const { owner, repo, prNumber } = parsePrParams(c, 400);
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
