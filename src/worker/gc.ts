import { unixNow } from "../shared/nix-format.ts";
import type { GcReport } from "../shared/protocol.ts";
import type { LoadedConfig } from "./config.ts";
import {
  deleteBlobIfUnreferenced,
  evictExpiredPrScopes,
  evictStaleMainPaths,
  listUnreferencedBlobs,
  markBlobGcBlocked,
} from "./db.ts";
import { createGitHubAppClient } from "./github.ts";

const SECONDS_PER_DAY = 24 * 60 * 60;

export async function runGc(
  db: D1Database,
  config: LoadedConfig,
  dryRun: boolean,
): Promise<GcReport> {
  const now = unixNow();
  const prCutoff = now - config.gc.prTtlDays * SECONDS_PER_DAY;
  const mainCutoff = now - config.gc.mainLruDays * SECONDS_PER_DAY;

  const report: GcReport = {
    pr_paths_removed: await evictExpiredPrScopes(db, prCutoff, dryRun),
    main_paths_removed: await evictStaleMainPaths(db, mainCutoff, dryRun),
    blobs_deleted: 0,
    blobs_protected: 0,
    blobs_skipped: 0,
    blob_errors: 0,
  };

  const githubApp = createGitHubAppClient(config);

  for (const owner of config.ownersByName.values()) {
    const unreferenced = await listUnreferencedBlobs(db, owner.name);
    if (unreferenced.length === 0) {
      continue;
    }

    if (!githubApp || owner.githubInstallationId === null || dryRun) {
      report.blobs_skipped += unreferenced.length;

      continue;
    }

    const ghcrOwner = owner.name.toLowerCase();
    for (const blob of unreferenced) {
      try {
        const outcome = await githubApp.deleteGhcrPackageVersion(
          ghcrOwner,
          owner.ownerType,
          owner.githubInstallationId,
          blob.ghcrPackage,
          blob.manifestDigest,
        );
        if (outcome.kind === "deleted" || outcome.kind === "not_found") {
          if (await deleteBlobIfUnreferenced(db, blob.id)) {
            report.blobs_deleted += 1;
          }
        } else {
          await markBlobGcBlocked(db, blob.id, outcome.reason);
          report.blobs_protected += 1;
          console.warn(
            JSON.stringify({
              message:
                "GHCR refused deletion permanently; marked blob as gc_blocked",
              owner: owner.name,
              package: blob.ghcrPackage,
              manifest: blob.manifestDigest,
              reason: outcome.reason,
            }),
          );
        }
      } catch (error) {
        report.blob_errors += 1;
        console.error(
          JSON.stringify({
            message: "failed to delete unreferenced GHCR package version",
            owner: owner.name,
            package: blob.ghcrPackage,
            manifest: blob.manifestDigest,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }

  console.log(
    JSON.stringify({
      message: "garbage collection cycle complete",
      dry_run: dryRun,
      ...report,
    }),
  );

  return report;
}
