export interface PlanRequest {
  owner?: string;
  store_paths: string[];
}

export interface PlanResponse {
  owner: string;
  scope: string;
  registry: string;
  ghcr_repository: string;
  ghcr_token?: string;
  missing: string[];
}

export interface CommitEntry {
  store_path: string;
  nar_hash: string;
  nar_size: number;
  file_hash: string;
  file_size: number;
  manifest_digest: string;
  blob_digest: string;
  deriver?: string | null;
  references: string[];
}

export interface CommitRequest {
  owner?: string;
  entries: CommitEntry[];
}

export interface CommitResponse {
  owner: string;
  scope: string;
  committed: number;
}

export interface PublicKeysResponse {
  main_public_key: string;
  pr_public_key: string;
}

export interface BlockedBlob {
  ghcr_package: string;
  manifest_digest: string;
  reason: string;
}

export interface OwnerStatusSummary {
  name: string;
  owner_type: "user" | "org";
  active_prs: number;
  total_blobs: number;
  total_bytes: number;
  unreferenced_blobs: number;
  blocked_blobs: BlockedBlob[];
}

export interface AdminStatusResponse {
  public_base_url: string;
  gc: {
    pr_ttl_days: number;
    main_lru_days: number;
  };
  main_public_key: string;
  pr_public_key: string;
  main_paths: number;
  pr_paths: number;
  active_prs: number;
  owners: OwnerStatusSummary[];
}

export interface StorePathSummary {
  owner_id: string;
  scope: string;
  store_path: string;
  file_size: number;
  last_accessed_at: number;
}

export interface PrScopeSummary {
  owner_id: string;
  repo: string;
  pr_number: number;
  path_count: number;
  updated_at: number;
}

export interface GcReport {
  pr_paths_removed: number;
  main_paths_removed: number;
  blobs_deleted: number;
  blobs_blocked: number;
  blobs_skipped: number;
  blob_errors: number;
}
