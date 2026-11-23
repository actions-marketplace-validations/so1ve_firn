CREATE INDEX IF NOT EXISTS idx_store_paths_accessed
    ON store_paths(last_accessed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_blobs_blocked
    ON blobs(owner_id, ghcr_package, manifest_digest)
    WHERE gc_blocked = 1;
