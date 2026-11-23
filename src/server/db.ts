import type { NarInfo } from "../shared/nix-format.ts";
import { storePathBasename } from "../shared/nix-format.ts";
import type {
  BlockedBlob,
  PrScopeSummary,
  StorePathSummary,
} from "../shared/protocol.ts";
import type { SqlDatabase, SqlStatement } from "./db/types.ts";

export const MAIN_SCOPE = "main";

const TOUCH_THROTTLE_SECONDS = 24 * 60 * 60;
const SQL_BIND_CHUNK = 80;

export const prScope = (
  ownerId: string,
  repo: string,
  prNumber: number,
): string => `pr:${ownerId}:${repo}:${prNumber}`;

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

export interface OwnerStats {
  activePrs: number;
  totalBlobs: number;
  totalBytes: number;
  unreferencedBlobs: number;
  blockedBlobs: BlockedBlob[];
}

export const storedToNarInfo = (stored: StoredNarInfo): NarInfo => ({
  storePath: stored.storePath,
  url: `nar/${stored.blobDigest}.nar.zst`,
  fileHash: stored.fileHash,
  fileSize: stored.fileSize,
  narHash: stored.narHash,
  narSize: stored.narSize,
  references: stored.references,
  deriver: stored.deriver,
  sig: stored.signature,
});

interface NarInfoRow {
  id: number;
  store_path: string;
  nar_hash: string;
  nar_size: number;
  file_hash: string;
  file_size: number;
  blob_digest: string;
  deriver: string | null;
  references_json: string;
  signature: string;
}

interface BlobRow {
  id: number;
  owner_id: string;
  ghcr_package: string;
  manifest_digest: string;
  blob_digest: string;
  ghcr_version_id: number | null;
}

const mapBlobRow = (row: BlobRow): BlobRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  ghcrPackage: row.ghcr_package,
  manifestDigest: row.manifest_digest,
  blobDigest: row.blob_digest,
  ghcrVersionId: row.ghcr_version_id,
});

async function queryNarInfoInScope(
  db: SqlDatabase,
  scope: string,
  storeHash: string,
): Promise<StoredNarInfo | null> {
  const row = await db.first<NarInfoRow>(
    `SELECT sp.id, sp.store_path, sp.nar_hash, sp.nar_size, sp.file_hash,
            b.file_size, b.blob_digest, sp.deriver, sp.references_json, sp.signature
     FROM store_paths sp
     JOIN blobs b ON b.id = sp.blob_id
     WHERE sp.scope = ?1 AND sp.store_hash = ?2`,
    [scope, storeHash],
  );

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    storePath: row.store_path,
    narHash: row.nar_hash,
    narSize: row.nar_size,
    fileHash: row.file_hash,
    fileSize: row.file_size,
    blobDigest: row.blob_digest,
    deriver: row.deriver,
    references: JSON.parse(row.references_json) as string[],
    signature: row.signature,
  };
}

export async function existingStoreHashes(
  db: SqlDatabase,
  scope: string,
  hashes: readonly string[],
): Promise<Set<string>> {
  const present = new Set<string>();
  for (let i = 0; i < hashes.length; i += SQL_BIND_CHUNK) {
    const chunk = hashes.slice(i, i + SQL_BIND_CHUNK);
    const placeholders = chunk.map((_, idx) => `?${idx + 2}`).join(", ");
    const rows = await db.all<{ store_hash: string }>(
      `SELECT DISTINCT store_hash
       FROM store_paths
       WHERE (scope = ?1 OR scope = 'main')
         AND store_hash IN (${placeholders})`,
      [scope, ...chunk],
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
  for (const record of records) {
    statements.push(
      {
        sql: `INSERT INTO blobs (
                owner_id, ghcr_package, manifest_digest, blob_digest, file_size, created_at
              ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
              ON CONFLICT(owner_id, ghcr_package, blob_digest) DO UPDATE SET
                manifest_digest = excluded.manifest_digest,
                file_size = excluded.file_size,
                gc_blocked = 0,
                gc_block_reason = NULL`,
        params: [
          record.ownerId,
          record.ghcrPackage,
          record.manifestDigest,
          record.blobDigest,
          record.fileSize,
          record.now,
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
          record.scope,
          record.storeHash,
          record.storePath,
          record.narHash,
          record.narSize,
          record.fileHash,
          record.ownerId,
          record.ghcrPackage,
          record.blobDigest,
          record.deriver,
          JSON.stringify(record.references),
          record.signature,
          record.now,
        ],
      },
    );

    if (record.prInfo) {
      statements.push({
        sql: `INSERT INTO pr_scopes (owner_id, repo, pr_number, updated_at)
              VALUES (?1, ?2, ?3, ?4)
              ON CONFLICT(owner_id, repo, pr_number) DO UPDATE SET
                updated_at = excluded.updated_at`,
        params: [
          record.ownerId,
          record.prInfo.repo,
          record.prInfo.number,
          record.now,
        ],
      });
    }
  }

  await db.batch(statements);

  return records.length;
}

export async function getNarInfo(
  db: SqlDatabase,
  scope: string,
  storeHash: string,
): Promise<StoredNarInfo | null> {
  if (scope !== MAIN_SCOPE) {
    const found = await queryNarInfoInScope(db, scope, storeHash);
    if (found) {
      return found;
    }
  }

  return queryNarInfoInScope(db, MAIN_SCOPE, storeHash);
}

export async function getBlobForDownload(
  db: SqlDatabase,
  scope: string,
  blobDigest: string,
): Promise<BlobRecord | null> {
  const row = await db.first<BlobRow>(
    `SELECT b.id, b.owner_id, b.ghcr_package, b.manifest_digest, b.blob_digest, b.ghcr_version_id
     FROM blobs b
     JOIN store_paths sp ON sp.blob_id = b.id
     WHERE b.blob_digest = ?1
       AND (sp.scope = ?2 OR sp.scope = 'main')
     LIMIT 1`,
    [blobDigest, scope],
  );

  return row ? mapBlobRow(row) : null;
}

export async function touchAccessedThrottled(
  db: SqlDatabase,
  id: number,
  now: number,
): Promise<void> {
  const threshold = now - TOUCH_THROTTLE_SECONDS;
  await db.run(
    `UPDATE store_paths
     SET last_accessed_at = ?1
     WHERE id = ?2 AND last_accessed_at < ?3`,
    [now, id, threshold],
  );
}

export async function deletePrScope(
  db: SqlDatabase,
  ownerId: string,
  repo: string,
  prNumber: number,
): Promise<number> {
  const scope = prScope(ownerId, repo, prNumber);
  const [pathsRes] = await db.batch([
    { sql: "DELETE FROM store_paths WHERE scope = ?1", params: [scope] },
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
  if (dryRun) {
    const row = await db.first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM store_paths
       WHERE scope IN (
         SELECT 'pr:' || owner_id || ':' || repo || ':' || pr_number
         FROM pr_scopes
         WHERE updated_at < ?1
       )`,
      [cutoffTs],
    );

    return row?.count ?? 0;
  }

  const [pathsRes] = await db.batch([
    {
      sql: `DELETE FROM store_paths
            WHERE scope IN (
              SELECT 'pr:' || owner_id || ':' || repo || ':' || pr_number
              FROM pr_scopes
              WHERE updated_at < ?1
            )`,
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
    `SELECT id, store_path, last_accessed_at, references_json
     FROM store_paths
     WHERE scope = 'main'`,
  );

  const nodes = rows.map((row) => ({
    id: row.id,
    basename: storePathBasename(row.store_path),
    lastAccessedAt: row.last_accessed_at,
    references: JSON.parse(row.references_json) as string[],
  }));

  const indexByBasename = new Map<string, number>();
  for (const [i, node] of nodes.entries()) {
    indexByBasename.set(node.basename, i);
  }

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
      const depIdx = indexByBasename.get(ref);
      if (depIdx !== undefined && live[depIdx] === 0) {
        live[depIdx] = 1;
        queue.push(depIdx);
      }
    }
  }

  const victimIds: number[] = [];
  for (const [i, node] of nodes.entries()) {
    if (live[i] === 0) {
      victimIds.push(node.id);
    }
  }

  if (dryRun || victimIds.length === 0) {
    return victimIds.length;
  }

  const statements: SqlStatement[] = [];
  for (let i = 0; i < victimIds.length; i += SQL_BIND_CHUNK) {
    const chunk = victimIds.slice(i, i + SQL_BIND_CHUNK);
    const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(", ");
    statements.push({
      sql: `DELETE FROM store_paths WHERE id IN (${placeholders})`,
      params: chunk,
    });
  }
  await db.batch(statements);

  return victimIds.length;
}

export async function listUnreferencedBlobs(
  db: SqlDatabase,
  ownerId: string,
): Promise<BlobRecord[]> {
  const rows = await db.all<BlobRow>(
    `SELECT b.id, b.owner_id, b.ghcr_package, b.manifest_digest, b.blob_digest, b.ghcr_version_id
     FROM blobs b
     WHERE b.owner_id = ?1
       AND b.gc_blocked = 0
       AND NOT EXISTS (SELECT 1 FROM store_paths sp WHERE sp.blob_id = b.id)`,
    [ownerId],
  );

  return rows.map(mapBlobRow);
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
    `SELECT id, manifest_digest
     FROM blobs
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

  for (let i = 0; i < statements.length; i += SQL_BIND_CHUNK) {
    await db.batch(statements.slice(i, i + SQL_BIND_CHUNK));
  }

  return statements.length;
}

export async function deleteBlobIfUnreferenced(
  db: SqlDatabase,
  blobId: number,
): Promise<boolean> {
  const result = await db.run(
    `DELETE FROM blobs
     WHERE id = ?1
       AND NOT EXISTS (SELECT 1 FROM store_paths WHERE blob_id = ?1)`,
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
  const [mainRow, prRow, activePrRow] = await Promise.all([
    db.first<{ count: number }>(
      "SELECT COUNT(*) AS count FROM store_paths WHERE scope = 'main'",
    ),
    db.first<{ count: number }>(
      "SELECT COUNT(*) AS count FROM store_paths WHERE scope != 'main'",
    ),
    db.first<{ count: number }>("SELECT COUNT(*) AS count FROM pr_scopes"),
  ]);

  return {
    mainPaths: mainRow?.count ?? 0,
    prPaths: prRow?.count ?? 0,
    activePrs: activePrRow?.count ?? 0,
  };
}

export async function ownerStats(
  db: SqlDatabase,
  ownerId: string,
): Promise<OwnerStats> {
  const [activePrRow, blobTotalsRow, unrefRow, blockedRows] = await Promise.all(
    [
      db.first<{ count: number }>(
        "SELECT COUNT(*) AS count FROM pr_scopes WHERE owner_id = ?1",
        [ownerId],
      ),
      db.first<{ total_blobs: number; total_bytes: number }>(
        "SELECT COUNT(*) AS total_blobs, COALESCE(SUM(file_size), 0) AS total_bytes FROM blobs WHERE owner_id = ?1",
        [ownerId],
      ),
      db.first<{ count: number }>(
        `SELECT COUNT(*) AS count FROM blobs b
         WHERE b.owner_id = ?1
           AND b.gc_blocked = 0
           AND NOT EXISTS (SELECT 1 FROM store_paths sp WHERE sp.blob_id = b.id)`,
        [ownerId],
      ),
      db.all<BlockedBlob>(
        `SELECT ghcr_package, manifest_digest, COALESCE(gc_block_reason, '') AS reason
         FROM blobs
         WHERE owner_id = ?1 AND gc_blocked = 1
         ORDER BY ghcr_package, manifest_digest`,
        [ownerId],
      ),
    ],
  );

  return {
    activePrs: activePrRow?.count ?? 0,
    totalBlobs: blobTotalsRow?.total_blobs ?? 0,
    totalBytes: blobTotalsRow?.total_bytes ?? 0,
    unreferencedBlobs: unrefRow?.count ?? 0,
    blockedBlobs: blockedRows,
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
  const likePattern = query ? `%${query}%` : null;
  const orderBy =
    sort === "size"
      ? "b.file_size DESC, sp.id DESC"
      : "sp.last_accessed_at DESC, sp.id DESC";

  return db.all<StorePathSummary>(
    `SELECT b.owner_id, sp.scope, sp.store_path, b.file_size, sp.last_accessed_at
     FROM store_paths sp
     JOIN blobs b ON b.id = sp.blob_id
     WHERE (?1 IS NULL OR b.owner_id = ?1)
       AND (?2 IS NULL OR sp.scope = ?2)
       AND (?3 IS NULL OR sp.store_path LIKE ?3)
     ORDER BY ${orderBy}
     LIMIT ?4`,
    [ownerId, scope, likePattern, limit],
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
  const likePattern = filters.query ? `%${filters.query}%` : null;
  const result = await db.run(
    `DELETE FROM store_paths
     WHERE (?1 IS NULL OR blob_id IN (SELECT id FROM blobs WHERE owner_id = ?1))
       AND (?2 IS NULL OR scope = ?2)
       AND (?3 IS NULL OR store_hash = ?3)
       AND (?4 IS NULL OR store_path LIKE ?4)`,
    [filters.ownerId, filters.scope, filters.storeHash, likePattern],
  );

  return result.changes;
}

export const listPrScopes = async (
  db: SqlDatabase,
  ownerId: string | null,
): Promise<PrScopeSummary[]> =>
  db.all<PrScopeSummary>(
    `SELECT p.owner_id, p.repo, p.pr_number, p.updated_at,
            (SELECT COUNT(*) FROM store_paths sp
             WHERE sp.scope = 'pr:' || p.owner_id || ':' || p.repo || ':' || p.pr_number) AS path_count
     FROM pr_scopes p
     WHERE (?1 IS NULL OR p.owner_id = ?1)
     ORDER BY p.updated_at DESC`,
    [ownerId],
  );
