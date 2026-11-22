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

CREATE INDEX IF NOT EXISTS idx_blobs_digest
    ON blobs(blob_digest);

CREATE INDEX IF NOT EXISTS idx_blobs_owner
    ON blobs(owner_id);

CREATE TABLE IF NOT EXISTS store_paths (
    id               INTEGER PRIMARY KEY,
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
    UNIQUE(scope, store_hash)
);

CREATE INDEX IF NOT EXISTS idx_store_paths_scope_hash
    ON store_paths(scope, store_hash);

CREATE INDEX IF NOT EXISTS idx_store_paths_blob_id
    ON store_paths(blob_id);

CREATE TABLE IF NOT EXISTS pr_scopes (
    owner_id   TEXT NOT NULL,
    repo       TEXT NOT NULL,
    pr_number  INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, repo, pr_number)
);
