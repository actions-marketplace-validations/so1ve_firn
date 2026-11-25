import type { Context } from "hono";

import { unixNow } from "../../shared/nix-format.ts";
import type { AppBindings } from "../app.ts";
import type { SqlDatabase } from "../db.ts";
import {
  cacheStats,
  listOwnerSummaries,
  listPrScopes,
  listStorePaths,
} from "../db.ts";
import { renderDashboardPage } from "../ui/page.ts";

export async function handleDashboard(
  c: Context<AppBindings>,
): Promise<Response> {
  const config = c.get("config");
  const db = c.get("readDb");
  const [cache, owners, prs, paths] = await Promise.all([
    cacheStats(db),
    listOwnerSummaries(db, config.ownersByName.values()),
    listPrScopes(db, null),
    listStorePaths(db, null, null, 50),
  ]);

  return c.html(
    renderDashboardPage({
      publicBaseUrl: config.publicBaseUrl,
      mainPublicKey: config.mainKey.publicString(),
      prPublicKey: config.prKey.publicString(),
      adminEnabled: config.adminToken !== null,
      gc: config.gc,
      mainPaths: cache.mainPaths,
      prPaths: cache.prPaths,
      activePrs: cache.activePrs,
      owners,
      prs,
      paths,
      now: unixNow(),
    }),
  );
}

export async function respondWithStorePaths(
  c: Context<AppBindings>,
  maxLimit: number,
  db: SqlDatabase = c.get("db"),
): Promise<Response> {
  const owner = c.req.query("owner") || null;
  if (owner && !c.get("config").ownersByName.has(owner)) {
    return c.text(`unknown owner '${owner}'`, 400);
  }
  const scope = c.req.query("scope") || null;
  const query = c.req.query("q")?.trim() || null;
  const sort = c.req.query("sort") || "accessed";
  if (sort !== "accessed" && sort !== "size") {
    return c.text(`invalid sort '${sort}'`, 400);
  }
  const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, maxLimit)
      : 50;

  return c.json(await listStorePaths(db, owner, scope, limit, query, sort));
}

export const handlePublicPaths = (c: Context<AppBindings>): Promise<Response> =>
  respondWithStorePaths(c, 200, c.get("readDb"));
