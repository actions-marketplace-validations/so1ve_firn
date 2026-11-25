import { MAIN_SCOPE, prScope } from "../shared/format.ts";
import { storePathBasename } from "../shared/nix-format.ts";
import type {
  BlockedBlob,
  OwnerStatusSummary,
  PrScopeSummary,
  StorePathSummary,
} from "../shared/protocol.ts";
import type { LoadedOwner } from "./config.ts";

export const TOUCH_THROTTLE_SECONDS = 86_400;

const SQL_BIND_CHUNK = 80;
const PR_SCOPE_EXPR = "'pr:' || owner_id || ':' || repo || ':' || pr_number";
const BLOB_SELECT =
  "b.id, b.owner_id AS ownerId, b.ghcr_package AS ghcrPackage, b.manifest_digest AS manifestDigest, b.blob_digest AS blobDigest, b.ghcr_version_id AS ghcrVersionId";

export type SqlParam = string | number | null;
export interface SqlStatement {
  sql: string;
  params?: readonly SqlParam[];
}
export interface SqlRunResult {
  changes: number;
}

export interface SqlDatabase {
  first: <T>(sql: string, params?: readonly SqlParam[]) => Promise<T | null>;
  all: <T>(sql: string, params?: readonly SqlParam[]) => Promise<T[]>;
  run: (sql: string, params?: readonly SqlParam[]) => Promise<SqlRunResult>;
  batch: (
    statements: readonly SqlStatement[],
  ) => Promise<readonly SqlRunResult[]>;
}

export interface CloseableSqlDatabase extends SqlDatabase {
  close: () => void;
}

export type D1Queryable = Pick<D1Database, "prepare" | "batch">;

export function d1Adapter(db: D1Queryable): SqlDatabase {
  const prepare = (sql: string, params: readonly SqlParam[] = []) =>
    params.length > 0 ? db.prepare(sql).bind(...params) : db.prepare(sql);

  return {
    first: <T>(sql: string, params?: readonly SqlParam[]) =>
      prepare(sql, params).first<T>(),
    all: async <T>(sql: string, params?: readonly SqlParam[]): Promise<T[]> =>
      (await prepare(sql, params).all<T>()).results,
    run: async (sql: string, params?: readonly SqlParam[]) => ({
      changes: (await prepare(sql, params).run()).meta.changes ?? 0,
    }),
    async batch(statements: readonly SqlStatement[]) {
      if (statements.length === 0) {
        return [];
      }
      const results = await db.batch(
        statements.map((s) => prepare(s.sql, s.params)),
      );

      return results.map((res) => ({ changes: res.meta.changes ?? 0 }));
    },
  };
}

export interface BlobRecord {
  id: number;
  ownerId: string;
  ghcrPackage: string;
  manifestDigest: string;
  blobDigest: string;
  ghcrVersionId: number | null;
}

export interface StoredNarInfo {
  id: number;
  storePath: string;
  narHash: string;
  narSize: number;
  fileHash: string;
  fileSize: number;
  blobDigest: string;
  deriver: string | null;
  references: string[];
  signature: string;
  lastAccessedAt: number;
}

export interface CommitRecord {
  ownerId: string;
  scope: string;
  prInfo: { repo: string; number: number } | null;
  ghcrPackage: string;
  manifestDigest: string;
  blobDigest: string;
  fileSize: number;
  storeHash: string;
  storePath: string;
  narHash: string;
  narSize: number;
  fileHash: string;
  deriver: string | null;
  references: string[];
  signature: string;
  now: number;
}

export interface CacheStats {
  mainPaths: number;
  prPaths: number;
  activePrs: number;
}

function chunks<T>(items: readonly T[], size = SQL_BIND_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }

  return out;
}

const placeholders = (count: number, offset = 1): string =>
  Array.from({ length: count }, (_, i) => `?${i + offset}`).join(", ");

export async function existingStoreHashes(
  db: SqlDatabase,
  scope: string,
  hashes: readonly string[],
): Promise<Set<string>> {
  const present = new Set<string>();
  const isMain = scope === MAIN_SCOPE;
  for (const chunk of chunks(hashes)) {
    const rows = await db.all<{ store_hash: string }>(
      isMain
        ? `SELECT store_hash FROM store_paths
           WHERE scope = 'main' AND store_hash IN (${placeholders(chunk.length)})`
        : `SELECT DISTINCT store_hash FROM store_paths
           WHERE scope IN (?1, 'main') AND store_hash IN (${placeholders(chunk.length, 2)})`,
      isMain ? chunk : [scope, ...chunk],
    );
    for (const row of rows) {
      present.add(row.store_hash);
    }
  }

  return present;
}

export async function commitEntries(
  db: SqlDatabase,
  records: readonly CommitRecord[],
): Promise<number> {
  if (records.length === 0) {
    return 0;
  }

  const statements: SqlStatement[] = [];
  const prUpserts = new Map<string, SqlStatement>();

  for (const r of records) {
    statements.push(
      {
        sql: `INSERT INTO blobs (owner_id, ghcr_package, manifest_digest, blob_digest, file_size, created_at)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6)
              ON CONFLICT(owner_id, ghcr_package, blob_digest) DO UPDATE SET
                manifest_digest = excluded.manifest_digest,
                file_size = excluded.file_size,
                gc_blocked = 0,
                gc_block_reason = NULL`,
        params: [
          r.ownerId,
          r.ghcrPackage,
          r.manifestDigest,
          r.blobDigest,
          r.fileSize,
          r.now,
        ],
      },
      {
        sql: `INSERT INTO store_paths (
                scope, store_hash, store_path, nar_hash, nar_size,
                file_hash, blob_id, deriver, references_json, signature,
                created_at, last_accessed_at
              ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                (SELECT id FROM blobs WHERE owner_id = ?7 AND ghcr_package = ?8 AND blob_digest = ?9),
                ?10, ?11, ?12, ?13, ?13
              )
              ON CONFLICT(scope, store_hash) DO UPDATE SET
                store_path = excluded.store_path,
                nar_hash = excluded.nar_hash,
                nar_size = excluded.nar_size,
                file_hash = excluded.file_hash,
                blob_id = excluded.blob_id,
                deriver = excluded.deriver,
                references_json = excluded.references_json,
                signature = excluded.signature,
                last_accessed_at = excluded.last_accessed_at`,
        params: [
          r.scope,
          r.storeHash,
          r.storePath,
          r.narHash,
          r.narSize,
          r.fileHash,
          r.ownerId,
          r.ghcrPackage,
          r.blobDigest,
          r.deriver,
          JSON.stringify(r.references),
          r.signature,
          r.now,
        ],
      },
    );

    if (r.prInfo) {
      prUpserts.set(r.scope, {
        sql: `INSERT INTO pr_scopes (owner_id, repo, pr_number, updated_at)
              VALUES (?1, ?2, ?3, ?4)
              ON CONFLICT(owner_id, repo, pr_number) DO UPDATE SET
                updated_at = excluded.updated_at`,
        params: [r.ownerId, r.prInfo.repo, r.prInfo.number, r.now],
      });
    }
  }

  statements.push(...prUpserts.values());
  await db.batch(statements);

  return records.length;
}

export async function getNarInfo(
  db: SqlDatabase,
  scope: string,
  storeHash: string,
): Promise<StoredNarInfo | null> {
  const isMain = scope === MAIN_SCOPE;
  const row = await db.first<
    Omit<StoredNarInfo, "references"> & { references_json: string }
  >(
    `SELECT sp.id, sp.store_path AS storePath, sp.nar_hash AS narHash,
            sp.nar_size AS narSize, sp.file_hash AS fileHash,
            b.file_size AS fileSize, b.blob_digest AS blobDigest,
            sp.deriver, sp.references_json, sp.signature,
            sp.last_accessed_at AS lastAccessedAt
     FROM store_paths sp
     JOIN blobs b ON b.id = sp.blob_id
     WHERE ${
       isMain
         ? "sp.scope = 'main' AND sp.store_hash = ?1"
         : "sp.scope IN (?1, 'main') AND sp.store_hash = ?2 ORDER BY CASE WHEN sp.scope = ?1 THEN 0 ELSE 1 END"
     }
     LIMIT 1`,
    isMain ? [storeHash] : [scope, storeHash],
  );
  if (!row) {
    return null;
  }

  const { references_json, ...rest } = row;

  return { ...rest, references: JSON.parse(references_json) as string[] };
}

export function getBlobForDownload(
  db: SqlDatabase,
  scope: string,
  blobDigest: string,
): Promise<BlobRecord | null> {
  const isMain = scope === MAIN_SCOPE;

  return db.first<BlobRecord>(
    `SELECT ${BLOB_SELECT}
     FROM blobs b
     WHERE b.blob_digest = ?1
       AND EXISTS (
         SELECT 1 FROM store_paths sp
         WHERE sp.blob_id = b.id AND ${isMain ? "sp.scope = 'main'" : "sp.scope IN (?2, 'main')"}
       )
     LIMIT 1`,
    isMain ? [blobDigest] : [blobDigest, scope],
  );
}

export async function touchAccessedThrottled(
  db: SqlDatabase,
  id: number,
  now: number,
): Promise<void> {
  await db.run(
    `UPDATE store_paths SET last_accessed_at = ?1
     WHERE id = ?2 AND last_accessed_at < ?3`,
    [now, id, now - TOUCH_THROTTLE_SECONDS],
  );
}

export async function deletePrScope(
  db: SqlDatabase,
  ownerId: string,
  repo: string,
  prNumber: number,
): Promise<number> {
  const [pathsRes] = await db.batch([
    {
      sql: "DELETE FROM store_paths WHERE scope = ?1",
      params: [prScope(ownerId, repo, prNumber)],
    },
    {
      sql: "DELETE FROM pr_scopes WHERE owner_id = ?1 AND repo = ?2 AND pr_number = ?3",
      params: [ownerId, repo, prNumber],
    },
  ]);

  return pathsRes?.changes ?? 0;
}

export async function evictExpiredPrScopes(
  db: SqlDatabase,
  cutoffTs: number,
  dryRun: boolean,
): Promise<number> {
  const expiredScopesSql = `SELECT ${PR_SCOPE_EXPR} FROM pr_scopes WHERE updated_at < ?1`;
  if (dryRun) {
    const row = await db.first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM store_paths WHERE scope IN (${expiredScopesSql})`,
      [cutoffTs],
    );

    return row?.count ?? 0;
  }

  const [pathsRes] = await db.batch([
    {
      sql: `DELETE FROM store_paths WHERE scope IN (${expiredScopesSql})`,
      params: [cutoffTs],
    },
    {
      sql: "DELETE FROM pr_scopes WHERE updated_at < ?1",
      params: [cutoffTs],
    },
  ]);

  return pathsRes?.changes ?? 0;
}

export async function evictStaleMainPaths(
  db: SqlDatabase,
  cutoffTs: number,
  dryRun: boolean,
): Promise<number> {
  const rows = await db.all<{
    id: number;
    store_path: string;
    last_accessed_at: number;
    references_json: string;
  }>(
    "SELECT id, store_path, last_accessed_at, references_json FROM store_paths WHERE scope = 'main'",
  );

  const nodes = rows.map((row) => ({
    id: row.id,
    basename: storePathBasename(row.store_path),
    lastAccessedAt: row.last_accessed_at,
    references: JSON.parse(row.references_json) as string[],
  }));

  const byBasename = new Map(nodes.map((node, i) => [node.basename, i]));
  const live = new Uint8Array(nodes.length);
  const queue: number[] = [];

  for (const [i, node] of nodes.entries()) {
    if (node.lastAccessedAt >= cutoffTs) {
      live[i] = 1;
      queue.push(i);
    }
  }
  for (const idx of queue) {
    for (const ref of nodes[idx].references) {
      const depIdx = byBasename.get(ref);
      if (depIdx !== undefined && live[depIdx] === 0) {
        live[depIdx] = 1;
        queue.push(depIdx);
      }
    }
  }

  const victimIds = nodes.filter((_, i) => live[i] === 0).map((n) => n.id);
  if (dryRun || victimIds.length === 0) {
    return victimIds.length;
  }

  await db.batch(
    chunks(victimIds).map((chunk) => ({
      sql: `DELETE FROM store_paths WHERE id IN (${placeholders(chunk.length)})`,
      params: chunk,
    })),
  );

  return victimIds.length;
}

export const listUnreferencedBlobs = (
  db: SqlDatabase,
  ownerId: string,
): Promise<BlobRecord[]> =>
  db.all<BlobRecord>(
    `SELECT ${BLOB_SELECT}
     FROM blobs b
     WHERE b.owner_id = ?1
       AND b.gc_blocked = 0
       AND NOT EXISTS (SELECT 1 FROM store_paths sp WHERE sp.blob_id = b.id)`,
    [ownerId],
  );

export async function listKnownManifestsByPackage(
  db: SqlDatabase,
  ownerId: string,
): Promise<Map<string, Set<string>>> {
  const rows = await db.all<{ ghcr_package: string; manifest_digest: string }>(
    "SELECT ghcr_package, manifest_digest FROM blobs WHERE owner_id = ?1 ORDER BY ghcr_package",
    [ownerId],
  );

  return new Map(
    [...Map.groupBy(rows, (r) => r.ghcr_package)].map(([pkg, items]) => [
      pkg,
      new Set(items.map((r) => r.manifest_digest)),
    ]),
  );
}

export async function cacheBlobVersionIds(
  db: SqlDatabase,
  ownerId: string,
  ghcrPackage: string,
  versions: ReadonlyMap<string, number>,
): Promise<number> {
  if (versions.size === 0) {
    return 0;
  }

  const rows = await db.all<{ id: number; manifest_digest: string }>(
    `SELECT id, manifest_digest FROM blobs
     WHERE owner_id = ?1 AND ghcr_package = ?2 AND ghcr_version_id IS NULL`,
    [ownerId, ghcrPackage],
  );

  const statements: SqlStatement[] = [];
  for (const row of rows) {
    const versionId = versions.get(row.manifest_digest);
    if (versionId !== undefined) {
      statements.push({
        sql: "UPDATE blobs SET ghcr_version_id = ?1 WHERE id = ?2",
        params: [versionId, row.id],
      });
    }
  }

  for (const chunk of chunks(statements)) {
    await db.batch(chunk);
  }

  return statements.length;
}

export async function deleteBlobIfUnreferenced(
  db: SqlDatabase,
  blobId: number,
): Promise<boolean> {
  const result = await db.run(
    `DELETE FROM blobs
     WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM store_paths WHERE blob_id = ?1)`,
    [blobId],
  );

  return result.changes > 0;
}

export async function markBlobGcBlocked(
  db: SqlDatabase,
  blobId: number,
  reason: string,
): Promise<void> {
  await db.run(
    "UPDATE blobs SET gc_blocked = 1, gc_block_reason = ?2 WHERE id = ?1",
    [blobId, reason],
  );
}

export async function cacheStats(db: SqlDatabase): Promise<CacheStats> {
  const row = await db.first<CacheStats>(
    `SELECT
       (SELECT COUNT(*) FROM store_paths WHERE scope = 'main') AS mainPaths,
       (SELECT COUNT(*) FROM store_paths WHERE scope != 'main') AS prPaths,
       (SELECT COUNT(*) FROM pr_scopes) AS activePrs`,
  );

  return row ?? { mainPaths: 0, prPaths: 0, activePrs: 0 };
}

export async function listOwnerSummaries(
  db: SqlDatabase,
  owners: Iterable<LoadedOwner>,
): Promise<OwnerStatusSummary[]> {
  const sorted = [...owners].sort((a, b) => a.name.localeCompare(b.name));
  if (sorted.length === 0) {
    return [];
  }

  const [prRows, blobRows, blockedRows] = await Promise.all([
    db.all<{ owner_id: string; count: number }>(
      "SELECT owner_id, COUNT(*) AS count FROM pr_scopes GROUP BY owner_id",
    ),
    db.all<{
      owner_id: string;
      total_blobs: number;
      total_bytes: number;
      unreferenced_blobs: number;
    }>(
      `SELECT
         b.owner_id,
         COUNT(*) AS total_blobs,
         COALESCE(SUM(b.file_size), 0) AS total_bytes,
         COALESCE(SUM(CASE
           WHEN b.gc_blocked = 0
             AND NOT EXISTS (SELECT 1 FROM store_paths sp WHERE sp.blob_id = b.id)
           THEN 1 ELSE 0
         END), 0) AS unreferenced_blobs
       FROM blobs b
       GROUP BY b.owner_id`,
    ),
    db.all<BlockedBlob & { owner_id: string }>(
      `SELECT owner_id, ghcr_package, manifest_digest, COALESCE(gc_block_reason, '') AS reason
       FROM blobs WHERE gc_blocked = 1
       ORDER BY ghcr_package, manifest_digest`,
    ),
  ]);

  const prsByOwner = new Map(prRows.map((r) => [r.owner_id, r.count]));
  const blobsByOwner = new Map(blobRows.map((r) => [r.owner_id, r]));
  const blockedByOwner = Map.groupBy(blockedRows, (r) => r.owner_id);

  return sorted.map((owner) => {
    const totals = blobsByOwner.get(owner.name);

    return {
      name: owner.name,
      owner_type: owner.ownerType,
      active_prs: prsByOwner.get(owner.name) ?? 0,
      total_blobs: totals?.total_blobs ?? 0,
      total_bytes: totals?.total_bytes ?? 0,
      unreferenced_blobs: totals?.unreferenced_blobs ?? 0,
      blocked_blobs: (blockedByOwner.get(owner.name) ?? []).map(
        ({ owner_id: _, ...blob }) => blob,
      ),
    };
  });
}

function buildWhere(clauses: readonly [sql: string, value: SqlParam][]): {
  where: string;
  params: SqlParam[];
} {
  const active: string[] = [];
  const params: SqlParam[] = [];
  for (const [sql, value] of clauses) {
    if (value !== null) {
      params.push(value);
      active.push(sql.replaceAll("?", `?${params.length}`));
    }
  }

  return {
    where: active.length > 0 ? `WHERE ${active.join(" AND ")}` : "",
    params,
  };
}

export type StorePathSort = "accessed" | "size";

export async function listStorePaths(
  db: SqlDatabase,
  ownerId: string | null,
  scope: string | null,
  limit: number,
  query: string | null = null,
  sort: StorePathSort = "accessed",
): Promise<StorePathSummary[]> {
  const { where, params } = buildWhere([
    ["b.owner_id = ?", ownerId],
    ["sp.scope = ?", scope],
    ["sp.store_path LIKE ?", query ? `%${query}%` : null],
  ]);
  params.push(limit);

  return db.all<StorePathSummary>(
    `SELECT b.owner_id, sp.scope, sp.store_path, b.file_size, sp.last_accessed_at
     FROM store_paths sp
     JOIN blobs b ON b.id = sp.blob_id
     ${where}
     ORDER BY ${sort === "size" ? "b.file_size DESC" : "sp.last_accessed_at DESC"}, sp.id DESC
     LIMIT ?${params.length}`,
    params,
  );
}

export async function deleteStorePaths(
  db: SqlDatabase,
  filters: {
    ownerId: string | null;
    scope: string | null;
    storeHash: string | null;
    query: string | null;
  },
): Promise<number> {
  const { where, params } = buildWhere([
    ["blob_id IN (SELECT id FROM blobs WHERE owner_id = ?)", filters.ownerId],
    ["scope = ?", filters.scope],
    ["store_hash = ?", filters.storeHash],
    ["store_path LIKE ?", filters.query ? `%${filters.query}%` : null],
  ]);

  return (await db.run(`DELETE FROM store_paths ${where}`, params)).changes;
}

export async function listPrScopes(
  db: SqlDatabase,
  ownerId: string | null,
): Promise<PrScopeSummary[]> {
  const { where, params } = buildWhere([["owner_id = ?", ownerId]]);

  return db.all<PrScopeSummary>(
    `SELECT owner_id, repo, pr_number, updated_at,
            (SELECT COUNT(*) FROM store_paths sp
             WHERE sp.scope = ${PR_SCOPE_EXPR}) AS path_count
     FROM pr_scopes
     ${where}
     ORDER BY updated_at DESC`,
    params,
  );
}
