import type { Context } from "hono";

import { unixNow } from "../../shared/nix-format.ts";
import type { OwnerStatusSummary } from "../../shared/protocol.ts";
import type { AppBindings } from "../app.ts";
import type { StorePathSort } from "../db.ts";
import { cacheStats, listPrScopes, listStorePaths, ownerStats } from "../db.ts";
import { renderDashboardPage } from "../ui/page.ts";

export async function handleDashboard(
  c: Context<AppBindings>,
): Promise<Response> {
  const config = c.get("config");
  const db = c.get("db");
  const sortedOwners = [...config.ownersByName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const [cache, owners, prs, paths] = await Promise.all([
    cacheStats(db),
    Promise.all(
      sortedOwners.map(async (owner): Promise<OwnerStatusSummary> => {
        const stats = await ownerStats(db, owner.name);

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
    ),
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
): Promise<Response> {
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
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, maxLimit)
      : 50;

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

export const handlePublicPaths = (c: Context<AppBindings>): Promise<Response> =>
  respondWithStorePaths(c, 200);
