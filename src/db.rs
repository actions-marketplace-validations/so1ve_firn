use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};

use crate::nix_format::{NarInfo, store_path_basename};

pub const MAIN_SCOPE: &str = "main";

#[must_use]
pub fn pr_scope(repo: &str, pr_number: u64) -> String {
    format!("pr:{repo}:{pr_number}")
}

#[derive(Debug, Clone)]
pub struct BlobRecord {
    pub id: i64,
    pub ghcr_package: String,
    pub manifest_digest: String,
    pub blob_digest: String,
}

#[derive(Debug, Clone)]
pub struct BlockedBlob {
    pub ghcr_package: String,
    pub manifest_digest: String,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct OwnerStats {
    pub main_paths: usize,
    pub pr_paths: usize,
    pub active_prs: usize,
    pub total_blobs: usize,
    pub total_bytes: u64,
    pub unreferenced_blobs: usize,
    pub blocked_blobs: Vec<BlockedBlob>,
}

#[derive(Debug, Clone)]
pub struct StorePathSummary {
    pub owner_id: String,
    pub scope: String,
    pub store_path: String,
    pub file_size: u64,
    pub last_accessed_at: i64,
}

#[derive(Debug, Clone)]
pub struct PrScopeSummary {
    pub owner_id: String,
    pub repo: String,
    pub pr_number: u64,
    pub path_count: usize,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct StoredNarInfo {
    pub id: i64,
    pub store_path: String,
    pub nar_hash: String,
    pub nar_size: u64,
    pub file_hash: String,
    pub file_size: u64,
    pub blob_digest: String,
    pub deriver: Option<String>,
    pub references: Vec<String>,
    pub signature: String,
}

impl StoredNarInfo {
    #[must_use]
    pub fn to_narinfo(&self) -> NarInfo {
        NarInfo {
            store_path: self.store_path.clone(),
            url: format!("nar/{}.nar.zst", self.blob_digest),
            file_hash: self.file_hash.clone(),
            file_size: self.file_size,
            nar_hash: self.nar_hash.clone(),
            nar_size: self.nar_size,
            references: self.references.clone(),
            deriver: self.deriver.clone(),
            sig: self.signature.clone(),
        }
    }
}

pub struct CommitRecord<'a> {
    pub owner_id: &'a str,
    pub scope: &'a str,
    pub pr_info: Option<(&'a str, u64)>,
    pub ghcr_package: &'a str,
    pub manifest_digest: &'a str,
    pub blob_digest: &'a str,
    pub file_size: u64,
    pub store_hash: &'a str,
    pub store_path: &'a str,
    pub nar_hash: &'a str,
    pub nar_size: u64,
    pub file_hash: &'a str,
    pub deriver: Option<&'a str>,
    pub references: &'a [String],
    pub signature: &'a str,
    pub now: i64,
}

struct MainNode {
    id: i64,
    basename: String,
    last_accessed_at: i64,
    references: Vec<String>,
}

fn map_blob_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BlobRecord> {
    Ok(BlobRecord {
        id: row.get(0)?,
        ghcr_package: row.get(1)?,
        manifest_digest: row.get(2)?,
        blob_digest: row.get(3)?,
    })
}

fn load_main_nodes(conn: &Connection, owner_id: &str) -> Result<Vec<MainNode>> {
    let mut stmt = conn.prepare(
        "SELECT id, store_path, last_accessed_at, references_json
         FROM store_paths
         WHERE owner_id = ?1 AND scope = 'main'",
    )?;
    let rows = stmt.query_map(params![owner_id], |row| {
        let id: i64 = row.get(0)?;
        let store_path: String = row.get(1)?;
        let last_accessed_at: i64 = row.get(2)?;
        let refs_json: String = row.get(3)?;
        let basename = store_path_basename(&store_path).unwrap().to_owned();
        let references: Vec<String> = serde_json::from_str(&refs_json).unwrap();

        Ok(MainNode {
            id,
            basename,
            last_accessed_at,
            references,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn query_narinfo_in_scope(
    conn: &Connection,
    owner_id: &str,
    scope: &str,
    store_hash: &str,
) -> Result<Option<StoredNarInfo>> {
    let mut stmt = conn.prepare_cached(
        "SELECT sp.id, sp.store_path, sp.nar_hash, sp.nar_size, sp.file_hash,
                b.file_size, b.blob_digest, sp.deriver, sp.references_json, sp.signature
         FROM store_paths sp
         JOIN blobs b ON b.id = sp.blob_id
         WHERE sp.owner_id = ?1 AND sp.scope = ?2 AND sp.store_hash = ?3",
    )?;

    let result = stmt
        .query_row(params![owner_id, scope, store_hash], |row| {
            let nar_size: i64 = row.get(3)?;
            let file_size: i64 = row.get(5)?;
            let refs_json: String = row.get(8)?;

            Ok(StoredNarInfo {
                id: row.get(0)?,
                store_path: row.get(1)?,
                nar_hash: row.get(2)?,
                nar_size: nar_size as u64,
                file_hash: row.get(4)?,
                file_size: file_size as u64,
                blob_digest: row.get(6)?,
                deriver: row.get(7)?,
                references: serde_json::from_str(&refs_json).unwrap(),
                signature: row.get(9)?,
            })
        })
        .optional()?;

    Ok(result)
}

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    fn init_connection(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;

            CREATE TABLE IF NOT EXISTS blobs (
                id               INTEGER PRIMARY KEY,
                owner_id         TEXT NOT NULL,
                ghcr_package     TEXT NOT NULL,
                manifest_digest  TEXT NOT NULL,
                blob_digest      TEXT NOT NULL,
                file_size        INTEGER NOT NULL,
                created_at       INTEGER NOT NULL,
                gc_blocked       INTEGER NOT NULL DEFAULT 0,
                gc_block_reason  TEXT,
                UNIQUE(owner_id, ghcr_package, blob_digest)
            );

            CREATE INDEX IF NOT EXISTS idx_blobs_owner_digest
                ON blobs(owner_id, blob_digest);

            CREATE TABLE IF NOT EXISTS store_paths (
                id               INTEGER PRIMARY KEY,
                owner_id         TEXT NOT NULL,
                scope            TEXT NOT NULL,
                store_hash       TEXT NOT NULL,
                store_path       TEXT NOT NULL,
                nar_hash         TEXT NOT NULL,
                nar_size         INTEGER NOT NULL,
                file_hash        TEXT NOT NULL,
                blob_id          INTEGER NOT NULL REFERENCES blobs(id),
                deriver          TEXT,
                references_json  TEXT NOT NULL,
                signature        TEXT NOT NULL,
                created_at       INTEGER NOT NULL,
                last_accessed_at INTEGER NOT NULL,
                UNIQUE(owner_id, scope, store_hash)
            );

            CREATE INDEX IF NOT EXISTS idx_store_paths_owner_scope_hash
                ON store_paths(owner_id, scope, store_hash);

            CREATE INDEX IF NOT EXISTS idx_store_paths_blob_id
                ON store_paths(blob_id);

            CREATE TABLE IF NOT EXISTS pr_scopes (
                owner_id   TEXT NOT NULL,
                repo       TEXT NOT NULL,
                pr_number  INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (owner_id, repo, pr_number)
            );
            ",
        )
        .context("failed to initialize database schema")?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap()
    }

    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent).with_context(|| {
                format!("failed to create database directory {}", parent.display())
            })?;
        }

        let conn = Connection::open(path)
            .with_context(|| format!("failed to open SQLite database {}", path.display()))?;

        Self::init_connection(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("failed to open in-memory SQLite")?;

        Self::init_connection(conn)
    }

    pub fn existing_store_hashes(
        &self,
        owner_id: &str,
        scope: &str,
        hashes: &[String],
    ) -> Result<HashSet<String>> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT 1 FROM store_paths
             WHERE owner_id = ?1 AND (scope = ?2 OR scope = 'main') AND store_hash = ?3",
        )?;
        let mut present = HashSet::new();
        for hash in hashes {
            if stmt.exists(params![owner_id, scope, hash])? {
                present.insert(hash.clone());
            }
        }

        Ok(present)
    }

    pub fn commit_entries(&self, records: &[CommitRecord<'_>]) -> Result<usize> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;

        for record in records {
            let file_size = record.file_size as i64;
            let nar_size = record.nar_size as i64;

            tx.execute(
                "INSERT INTO blobs (
                    owner_id, ghcr_package, manifest_digest, blob_digest, file_size, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(owner_id, ghcr_package, blob_digest) DO UPDATE SET
                    manifest_digest = excluded.manifest_digest,
                    file_size = excluded.file_size,
                    gc_blocked = 0,
                    gc_block_reason = NULL",
                params![
                    record.owner_id,
                    record.ghcr_package,
                    record.manifest_digest,
                    record.blob_digest,
                    file_size,
                    record.now,
                ],
            )?;

            let blob_id: i64 = tx.query_row(
                "SELECT id FROM blobs
                 WHERE owner_id = ?1 AND ghcr_package = ?2 AND blob_digest = ?3",
                params![record.owner_id, record.ghcr_package, record.blob_digest],
                |row| row.get(0),
            )?;

            let references_json = serde_json::to_string(record.references).unwrap();

            tx.execute(
                "INSERT INTO store_paths (
                    owner_id, scope, store_hash, store_path, nar_hash, nar_size,
                    file_hash, blob_id, deriver, references_json, signature,
                    created_at, last_accessed_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
                ON CONFLICT(owner_id, scope, store_hash) DO UPDATE SET
                    store_path = excluded.store_path,
                    nar_hash = excluded.nar_hash,
                    nar_size = excluded.nar_size,
                    file_hash = excluded.file_hash,
                    blob_id = excluded.blob_id,
                    deriver = excluded.deriver,
                    references_json = excluded.references_json,
                    signature = excluded.signature,
                    last_accessed_at = excluded.last_accessed_at",
                params![
                    record.owner_id,
                    record.scope,
                    record.store_hash,
                    record.store_path,
                    record.nar_hash,
                    nar_size,
                    record.file_hash,
                    blob_id,
                    record.deriver,
                    references_json,
                    record.signature,
                    record.now,
                ],
            )?;

            if let Some((repo, pr_number)) = record.pr_info {
                tx.execute(
                    "INSERT INTO pr_scopes (owner_id, repo, pr_number, updated_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(owner_id, repo, pr_number) DO UPDATE SET
                        updated_at = excluded.updated_at",
                    params![record.owner_id, repo, pr_number as i64, record.now],
                )?;
            }
        }

        tx.commit()?;

        Ok(records.len())
    }

    pub fn get_narinfo(
        &self,
        owner_id: &str,
        scope: &str,
        store_hash: &str,
    ) -> Result<Option<StoredNarInfo>> {
        let conn = self.lock();
        if scope != MAIN_SCOPE
            && let Some(found) = query_narinfo_in_scope(&conn, owner_id, scope, store_hash)?
        {
            return Ok(Some(found));
        }

        query_narinfo_in_scope(&conn, owner_id, MAIN_SCOPE, store_hash)
    }

    pub fn get_blob_for_download(
        &self,
        owner_id: &str,
        scope: &str,
        blob_digest: &str,
    ) -> Result<Option<BlobRecord>> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT b.id, b.ghcr_package, b.manifest_digest, b.blob_digest
             FROM blobs b
             JOIN store_paths sp ON sp.blob_id = b.id
             WHERE b.owner_id = ?1
               AND b.blob_digest = ?2
               AND (sp.scope = ?3 OR sp.scope = 'main')
             LIMIT 1",
        )?;

        Ok(stmt
            .query_row(params![owner_id, blob_digest, scope], map_blob_row)
            .optional()?)
    }

    pub fn touch_accessed(&self, ids: &[i64], now: i64) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "UPDATE store_paths SET last_accessed_at = ?1 WHERE id = ?2 AND last_accessed_at < ?1",
            )?;
            for id in ids {
                stmt.execute(params![now, id])?;
            }
        }
        tx.commit()?;

        Ok(())
    }

    pub fn delete_pr_scope(&self, owner_id: &str, repo: &str, pr_number: u64) -> Result<usize> {
        let scope = pr_scope(repo, pr_number);
        let mut conn = self.lock();
        let tx = conn.transaction()?;

        let removed = tx.execute(
            "DELETE FROM store_paths WHERE owner_id = ?1 AND scope = ?2",
            params![owner_id, scope],
        )?;
        tx.execute(
            "DELETE FROM pr_scopes WHERE owner_id = ?1 AND repo = ?2 AND pr_number = ?3",
            params![owner_id, repo, pr_number as i64],
        )?;
        tx.commit()?;

        Ok(removed)
    }

    pub fn evict_expired_pr_scopes(
        &self,
        owner_id: &str,
        cutoff_ts: i64,
        dry_run: bool,
    ) -> Result<usize> {
        let mut conn = self.lock();
        if dry_run {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM store_paths
                 WHERE owner_id = ?1
                   AND scope IN (
                       SELECT 'pr:' || repo || ':' || pr_number
                       FROM pr_scopes
                       WHERE owner_id = ?1 AND updated_at < ?2
                   )",
                params![owner_id, cutoff_ts],
                |row| row.get(0),
            )?;

            return Ok(count as usize);
        }

        let tx = conn.transaction()?;
        let removed = tx.execute(
            "DELETE FROM store_paths
             WHERE owner_id = ?1
               AND scope IN (
                   SELECT 'pr:' || repo || ':' || pr_number
                   FROM pr_scopes
                   WHERE owner_id = ?1 AND updated_at < ?2
               )",
            params![owner_id, cutoff_ts],
        )?;
        tx.execute(
            "DELETE FROM pr_scopes WHERE owner_id = ?1 AND updated_at < ?2",
            params![owner_id, cutoff_ts],
        )?;
        tx.commit()?;

        Ok(removed)
    }

    /// Evicts stale main-scope store paths whose `last_accessed_at < cutoff_ts`
    /// while preserving every transitive dependency of retained paths.
    pub fn evict_stale_main_paths(
        &self,
        owner_id: &str,
        cutoff_ts: i64,
        dry_run: bool,
    ) -> Result<usize> {
        let mut conn = self.lock();
        let nodes = load_main_nodes(&conn, owner_id)?;

        let index_by_basename: HashMap<&str, usize> = nodes
            .iter()
            .enumerate()
            .map(|(idx, node)| (node.basename.as_str(), idx))
            .collect();

        let mut live = vec![false; nodes.len()];
        let mut queue = VecDeque::new();
        for (idx, node) in nodes.iter().enumerate() {
            if node.last_accessed_at >= cutoff_ts {
                live[idx] = true;
                queue.push_back(idx);
            }
        }

        while let Some(idx) = queue.pop_front() {
            for reference in &nodes[idx].references {
                if let Some(&dep_idx) = index_by_basename.get(reference.as_str())
                    && !live[dep_idx]
                {
                    live[dep_idx] = true;
                    queue.push_back(dep_idx);
                }
            }
        }

        let victim_ids: Vec<i64> = nodes
            .iter()
            .enumerate()
            .filter_map(|(idx, node)| if live[idx] { None } else { Some(node.id) })
            .collect();

        if dry_run || victim_ids.is_empty() {
            return Ok(victim_ids.len());
        }

        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached("DELETE FROM store_paths WHERE id = ?1")?;
            for id in &victim_ids {
                stmt.execute(params![id])?;
            }
        }
        tx.commit()?;

        Ok(victim_ids.len())
    }

    pub fn list_unreferenced_blobs(&self, owner_id: &str) -> Result<Vec<BlobRecord>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT b.id, b.ghcr_package, b.manifest_digest, b.blob_digest
             FROM blobs b
             WHERE b.owner_id = ?1
               AND b.gc_blocked = 0
               AND NOT EXISTS (SELECT 1 FROM store_paths sp WHERE sp.blob_id = b.id)",
        )?;
        let rows = stmt.query_map(params![owner_id], map_blob_row)?;

        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn delete_blob_if_unreferenced(&self, blob_id: i64) -> Result<bool> {
        let conn = self.lock();
        let deleted = conn.execute(
            "DELETE FROM blobs
             WHERE id = ?1
               AND NOT EXISTS (SELECT 1 FROM store_paths WHERE blob_id = ?1)",
            params![blob_id],
        )?;

        Ok(deleted > 0)
    }

    pub fn mark_blob_gc_blocked(&self, blob_id: i64, reason: &str) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE blobs SET gc_blocked = 1, gc_block_reason = ?2 WHERE id = ?1",
            params![blob_id, reason],
        )?;

        Ok(())
    }

    pub fn owner_stats(&self, owner_id: &str) -> Result<OwnerStats> {
        let conn = self.lock();

        let main_paths: i64 = conn.query_row(
            "SELECT COUNT(*) FROM store_paths WHERE owner_id = ?1 AND scope = 'main'",
            params![owner_id],
            |row| row.get(0),
        )?;
        let pr_paths: i64 = conn.query_row(
            "SELECT COUNT(*) FROM store_paths WHERE owner_id = ?1 AND scope != 'main'",
            params![owner_id],
            |row| row.get(0),
        )?;
        let active_prs: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pr_scopes WHERE owner_id = ?1",
            params![owner_id],
            |row| row.get(0),
        )?;
        let (total_blobs, total_bytes): (i64, i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(file_size), 0) FROM blobs WHERE owner_id = ?1",
            params![owner_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let unreferenced_blobs: i64 = conn.query_row(
            "SELECT COUNT(*) FROM blobs b
             WHERE b.owner_id = ?1
               AND b.gc_blocked = 0
               AND NOT EXISTS (SELECT 1 FROM store_paths sp WHERE sp.blob_id = b.id)",
            params![owner_id],
            |row| row.get(0),
        )?;

        let mut stmt = conn.prepare(
            "SELECT ghcr_package, manifest_digest, COALESCE(gc_block_reason, '')
             FROM blobs
             WHERE owner_id = ?1 AND gc_blocked = 1
             ORDER BY ghcr_package, manifest_digest",
        )?;
        let blocked_blobs = stmt
            .query_map(params![owner_id], |row| {
                Ok(BlockedBlob {
                    ghcr_package: row.get(0)?,
                    manifest_digest: row.get(1)?,
                    reason: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        Ok(OwnerStats {
            main_paths: main_paths as usize,
            pr_paths: pr_paths as usize,
            active_prs: active_prs as usize,
            total_blobs: total_blobs as usize,
            total_bytes: total_bytes as u64,
            unreferenced_blobs: unreferenced_blobs as usize,
            blocked_blobs,
        })
    }

    pub fn list_store_paths(
        &self,
        owner_id: Option<&str>,
        scope: Option<&str>,
        limit: usize,
    ) -> Result<Vec<StorePathSummary>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT sp.owner_id, sp.scope, sp.store_path, b.file_size, sp.last_accessed_at
             FROM store_paths sp
             JOIN blobs b ON b.id = sp.blob_id
             WHERE (?1 IS NULL OR sp.owner_id = ?1)
               AND (?2 IS NULL OR sp.scope = ?2)
             ORDER BY sp.last_accessed_at DESC, sp.id DESC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![owner_id, scope, limit as i64], |row| {
            let file_size: i64 = row.get(3)?;

            Ok(StorePathSummary {
                owner_id: row.get(0)?,
                scope: row.get(1)?,
                store_path: row.get(2)?,
                file_size: file_size as u64,
                last_accessed_at: row.get(4)?,
            })
        })?;

        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn list_pr_scopes(&self, owner_id: Option<&str>) -> Result<Vec<PrScopeSummary>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT p.owner_id, p.repo, p.pr_number, p.updated_at,
                    (SELECT COUNT(*) FROM store_paths sp
                     WHERE sp.owner_id = p.owner_id
                       AND sp.scope = 'pr:' || p.repo || ':' || p.pr_number)
             FROM pr_scopes p
             WHERE (?1 IS NULL OR p.owner_id = ?1)
             ORDER BY p.updated_at DESC",
        )?;
        let rows = stmt.query_map(params![owner_id], |row| {
            let pr_number: i64 = row.get(2)?;
            let count: i64 = row.get(4)?;

            Ok(PrScopeSummary {
                owner_id: row.get(0)?,
                repo: row.get(1)?,
                pr_number: pr_number as u64,
                path_count: count as usize,
                updated_at: row.get(3)?,
            })
        })?;

        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_record<'a>(
        scope: &'a str,
        store_hash: &'a str,
        store_path: &'a str,
        blob_digest: &'a str,
        references: &'a [String],
        now: i64,
    ) -> CommitRecord<'a> {
        CommitRecord {
            owner_id: "so1ve",
            scope,
            pr_info: None,
            ghcr_package: "pkg-cache",
            manifest_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            blob_digest,
            file_size: 100,
            store_hash,
            store_path,
            nar_hash: "sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73",
            nar_size: 200,
            file_hash: "sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73",
            deriver: None,
            references,
            signature: "cache.so1ve.dev-1:sig",
            now,
        }
    }

    #[test]
    fn closure_safe_lru_preserves_referenced_dependencies() {
        let db = Database::open_in_memory().unwrap();
        let dep_hash = "11111111111111111111111111111111";
        let live_hash = "22222222222222222222222222222222";
        let orphan_hash = "33333333333333333333333333333333";
        let live_refs = vec![format!("{dep_hash}-dep")];

        let dep = sample_record(
            MAIN_SCOPE,
            dep_hash,
            "/nix/store/11111111111111111111111111111111-dep",
            "1111111111111111111111111111111111111111111111111111111111111111",
            &[],
            100,
        );
        let live = sample_record(
            MAIN_SCOPE,
            live_hash,
            "/nix/store/22222222222222222222222222222222-app",
            "2222222222222222222222222222222222222222222222222222222222222222",
            &live_refs,
            500,
        );
        let orphan = sample_record(
            MAIN_SCOPE,
            orphan_hash,
            "/nix/store/33333333333333333333333333333333-old",
            "3333333333333333333333333333333333333333333333333333333333333333",
            &[],
            100,
        );

        db.commit_entries(&[dep, live, orphan]).unwrap();

        assert_eq!(db.evict_stale_main_paths("so1ve", 300, false).unwrap(), 1);
        assert!(
            db.get_narinfo("so1ve", MAIN_SCOPE, dep_hash)
                .unwrap()
                .is_some()
        );
        assert!(
            db.get_narinfo("so1ve", MAIN_SCOPE, live_hash)
                .unwrap()
                .is_some()
        );
        assert!(
            db.get_narinfo("so1ve", MAIN_SCOPE, orphan_hash)
                .unwrap()
                .is_none()
        );

        let unreferenced = db.list_unreferenced_blobs("so1ve").unwrap();
        assert_eq!(unreferenced.len(), 1);
        assert_eq!(
            unreferenced[0].blob_digest,
            "3333333333333333333333333333333333333333333333333333333333333333"
        );
    }

    #[test]
    fn expired_pr_scopes_evict_cleanly_in_dry_run_and_apply() {
        let db = Database::open_in_memory().unwrap();
        let pr = pr_scope("latchshot", 42);
        let mut pr_entry = sample_record(
            &pr,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-prpkg",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            &[],
            100,
        );
        pr_entry.pr_info = Some(("latchshot", 42));
        db.commit_entries(&[pr_entry]).unwrap();

        assert_eq!(db.evict_expired_pr_scopes("so1ve", 200, true).unwrap(), 1);
        assert!(
            db.get_narinfo("so1ve", &pr, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
                .unwrap()
                .is_some()
        );

        assert_eq!(db.evict_expired_pr_scopes("so1ve", 200, false).unwrap(), 1);
        assert!(
            db.get_narinfo("so1ve", &pr, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
                .unwrap()
                .is_none()
        );
    }
}
