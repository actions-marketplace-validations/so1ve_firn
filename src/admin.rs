use anyhow::{Result, bail};

use crate::firn::Firn;
use crate::nix_format::unix_now;

const SECONDS_PER_MINUTE: i64 = 60;
const SECONDS_PER_HOUR: i64 = 60 * 60;
const SECONDS_PER_DAY: i64 = 24 * 60 * 60;

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut idx = 0usize;
    while value >= 1024.0 && idx + 1 < UNITS.len() {
        value /= 1024.0;
        idx += 1;
    }

    if idx == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.2} {}", UNITS[idx])
    }
}

fn format_age(now: i64, timestamp: i64) -> String {
    let delta = (now - timestamp).max(0);
    if delta < SECONDS_PER_MINUTE {
        format!("{delta}s ago")
    } else if delta < SECONDS_PER_HOUR {
        format!("{}m ago", delta / SECONDS_PER_MINUTE)
    } else if delta < SECONDS_PER_DAY {
        format!("{}h ago", delta / SECONDS_PER_HOUR)
    } else {
        format!("{}d ago", delta / SECONDS_PER_DAY)
    }
}

fn format_remaining_ttl(now: i64, updated_at: i64, ttl_days: u64) -> String {
    let expires_at = updated_at.saturating_add((ttl_days as i64).saturating_mul(SECONDS_PER_DAY));
    let remaining = expires_at - now;
    if remaining <= 0 {
        return "expired".to_owned();
    }
    if remaining < SECONDS_PER_HOUR {
        format!("{}m left", (remaining / SECONDS_PER_MINUTE).max(1))
    } else if remaining < SECONDS_PER_DAY {
        format!("{}h left", remaining / SECONDS_PER_HOUR)
    } else {
        format!("{}d left", remaining / SECONDS_PER_DAY)
    }
}

impl Firn {
    pub fn show_status(&self) -> Result<()> {
        println!("Public URL: {}", self.config.public_base_url);
        println!("Database:   {}", self.config.database_path.display());
        println!(
            "GC policy:  pr_ttl={}d, main_lru={}d",
            self.config.gc.pr_ttl_days, self.config.gc.main_lru_days
        );

        let mut owner_names: Vec<&str> = self
            .config
            .owners_by_name
            .keys()
            .map(String::as_str)
            .collect();
        owner_names.sort_unstable();

        for name in owner_names {
            let owner = self.config.owner_by_name(name).unwrap();
            let stats = self.db.owner_stats(name)?;

            println!("\n[{name}]");
            println!("  main key:     {}", owner.main_key.public_string());
            println!("  pr key:       {}", owner.pr_key.public_string());
            println!(
                "  store paths:  {} main, {} pr ({} active PRs)",
                stats.main_paths, stats.pr_paths, stats.active_prs
            );
            println!(
                "  blobs:        {} total ({}), {} unreferenced, {} gc-blocked",
                stats.total_blobs,
                format_bytes(stats.total_bytes),
                stats.unreferenced_blobs,
                stats.blocked_blobs.len()
            );

            for blocked in &stats.blocked_blobs {
                println!(
                    "  blocked:      {} {} ({})",
                    blocked.ghcr_package, blocked.manifest_digest, blocked.reason
                );
            }
        }

        Ok(())
    }

    pub fn list_paths(&self, owner: Option<&str>, scope: Option<&str>, limit: usize) -> Result<()> {
        if let Some(name) = owner
            && self.config.owner_by_name(name).is_none()
        {
            bail!("unknown owner '{name}'");
        }

        let items = self.db.list_store_paths(owner, scope, limit)?;
        if items.is_empty() {
            println!("No cached store paths found.");

            return Ok(());
        }

        let now = unix_now();
        println!(
            "{:<12} {:<20} {:>10} {:>10}  STORE PATH",
            "OWNER", "SCOPE", "SIZE", "ACCESSED"
        );
        for item in items {
            println!(
                "{:<12} {:<20} {:>10} {:>10}  {}",
                item.owner_id,
                item.scope,
                format_bytes(item.file_size),
                format_age(now, item.last_accessed_at),
                item.store_path
            );
        }

        Ok(())
    }

    pub fn list_prs(&self, owner: Option<&str>) -> Result<()> {
        if let Some(name) = owner
            && self.config.owner_by_name(name).is_none()
        {
            bail!("unknown owner '{name}'");
        }

        let prs = self.db.list_pr_scopes(owner)?;
        if prs.is_empty() {
            println!("No active PR overlays.");

            return Ok(());
        }

        let now = unix_now();
        println!(
            "{:<12} {:<24} {:>6} {:>7} {:>10}  TTL",
            "OWNER", "REPO", "PR", "PATHS", "UPDATED"
        );
        for pr in prs {
            println!(
                "{:<12} {:<24} {:>6} {:>7} {:>10}  {}",
                pr.owner_id,
                pr.repo,
                format!("#{}", pr.pr_number),
                pr.path_count,
                format_age(now, pr.updated_at),
                format_remaining_ttl(now, pr.updated_at, self.config.gc.pr_ttl_days),
            );
        }

        Ok(())
    }

    pub fn remove_pr(&self, owner: &str, repo: &str, pr_number: u64) -> Result<()> {
        if self.config.owner_by_name(owner).is_none() {
            bail!("unknown owner '{owner}'");
        }

        let removed = self.db.delete_pr_scope(owner, repo, pr_number)?;
        println!(
            "Removed PR overlay {owner}/{repo}#{pr_number} ({removed} store paths deleted; unreferenced blobs will be cleaned on next GC)"
        );

        Ok(())
    }
}
