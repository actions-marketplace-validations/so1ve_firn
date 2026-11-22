use anyhow::Result;
use tracing::{info, warn};

use crate::firn::Firn;
use crate::github::DeleteOutcome;
use crate::nix_format::unix_now;

const SECONDS_PER_DAY: i64 = 24 * 60 * 60;

const fn days_before(now: i64, days: u64) -> i64 {
    now.saturating_sub((days as i64).saturating_mul(SECONDS_PER_DAY))
}

#[derive(Debug, Default)]
pub struct GcReport {
    pub pr_paths_removed: usize,
    pub main_paths_removed: usize,
    pub blobs_deleted: usize,
    pub blobs_protected: usize,
    pub blobs_skipped: usize,
    pub blob_errors: usize,
}

pub async fn run_once(firn: &Firn, dry_run: bool) -> Result<GcReport> {
    let now = unix_now();
    let pr_cutoff = days_before(now, firn.config.gc.pr_ttl_days);
    let main_cutoff = days_before(now, firn.config.gc.main_lru_days);
    let mut report = GcReport::default();

    for owner in firn.config.owners_by_name.values() {
        report.pr_paths_removed +=
            firn.db
                .evict_expired_pr_scopes(&owner.name, pr_cutoff, dry_run)?;
        report.main_paths_removed +=
            firn.db
                .evict_stale_main_paths(&owner.name, main_cutoff, dry_run)?;

        let unreferenced = firn.db.list_unreferenced_blobs(&owner.name)?;
        if unreferenced.is_empty() {
            continue;
        }

        let (Some(app), Some(installation_id)) =
            (firn.github_app.as_deref(), owner.github_installation_id)
        else {
            report.blobs_skipped += unreferenced.len();
            continue;
        };
        if dry_run {
            report.blobs_skipped += unreferenced.len();
            continue;
        }

        let ghcr_owner = owner.ghcr_owner();
        for blob in unreferenced {
            match app
                .delete_ghcr_package_version(
                    &ghcr_owner,
                    owner.owner_type,
                    installation_id,
                    &blob.ghcr_package,
                    &blob.manifest_digest,
                )
                .await
            {
                Ok(DeleteOutcome::Deleted | DeleteOutcome::NotFound) => {
                    if firn.db.delete_blob_if_unreferenced(blob.id)? {
                        report.blobs_deleted += 1;
                    }
                }
                Ok(DeleteOutcome::Protected(reason)) => {
                    firn.db.mark_blob_gc_blocked(blob.id, &reason)?;
                    report.blobs_protected += 1;
                    warn!(
                        owner = %owner.name,
                        package = %blob.ghcr_package,
                        manifest = %blob.manifest_digest,
                        reason = %reason,
                        "GHCR refused deletion permanently; marked blob as gc_blocked"
                    );
                }
                Err(error) => {
                    report.blob_errors += 1;
                    warn!(
                        owner = %owner.name,
                        package = %blob.ghcr_package,
                        manifest = %blob.manifest_digest,
                        error = %error,
                        "failed to delete unreferenced GHCR package version"
                    );
                }
            }
        }
    }

    info!(
        dry_run,
        pr_paths_removed = report.pr_paths_removed,
        main_paths_removed = report.main_paths_removed,
        blobs_deleted = report.blobs_deleted,
        blobs_protected = report.blobs_protected,
        blobs_skipped = report.blobs_skipped,
        blob_errors = report.blob_errors,
        "garbage collection cycle complete"
    );

    Ok(report)
}
