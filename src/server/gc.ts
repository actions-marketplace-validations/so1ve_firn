import { unixNow } from "../shared/nix-format.ts";
import type { GcReport } from "../shared/protocol.ts";
import type { LoadedConfig } from "./config.ts";
import type { SqlDatabase } from "./db/types.ts";
import type { BlobRecord } from "./db.ts";
import {
  cacheBlobVersionIds,
  deleteBlobIfUnreferenced,
  evictExpiredPrScopes,
  evictStaleMainPaths,
  listUnreferencedBlobs,
  markBlobGcBlocked,
} from "./db.ts";
import { createGitHubAppClient } from "./github.ts";

const SECONDS_PER_DAY = 24 * 60 * 60;

export async function runGc(
  db: SqlDatabase,
  config: LoadedConfig,
  dryRun: boolean,
): Promise<GcReport> {
  const now = unixNow();
  const prCutoff = now - config.gc.prTtlDays * SECONDS_PER_DAY;
  const mainCutoff = now - config.gc.mainLruDays * SECONDS_PER_DAY;
  const maxSubrequests = config.gc.maxSubrequests;

  const report: GcReport = {
    pr_paths_removed: await evictExpiredPrScopes(db, prCutoff, dryRun),
    main_paths_removed: await evictStaleMainPaths(db, mainCutoff, dryRun),
    blobs_deleted: 0,
    blobs_blocked: 0,
    blobs_skipped: 0,
    blob_errors: 0,
  };

  const githubApp = createGitHubAppClient(config);
  let subrequests = 0;

  for (const owner of config.ownersByName.values()) {
    const unreferenced = await listUnreferencedBlobs(db, owner.name);
    if (unreferenced.length === 0) {
      continue;
    }

    if (
      !githubApp ||
      owner.githubInstallationId === null ||
      dryRun ||
      subrequests + 3 > maxSubrequests
    ) {
      report.blobs_skipped += unreferenced.length;

      continue;
    }

    let token: string;
    try {
      token = await githubApp.installationToken(owner.githubInstallationId);
      subrequests += 1;
    } catch (error) {
      report.blob_errors += unreferenced.length;
      console.error(
        JSON.stringify({
          message: "failed to mint GitHub App installation token for GC",
          owner: owner.name,
          error: error instanceof Error ? error.message : String(error),
        }),
      );

      continue;
    }

    const byPackage = new Map<string, BlobRecord[]>();
    for (const blob of unreferenced) {
      const list = byPackage.get(blob.ghcrPackage) ?? [];
      list.push(blob);
      byPackage.set(blob.ghcrPackage, list);
    }

    const ghcrOwner = owner.name.toLowerCase();

    async function deleteBlobVersion(
      pkg: string,
      blob: BlobRecord,
      versionId: number,
    ): Promise<void> {
      try {
        const { outcome, requestsUsed } =
          await githubApp!.deleteGhcrPackageVersionById(
            ghcrOwner,
            owner.ownerType,
            token,
            pkg,
            versionId,
            blob.manifestDigest,
          );
        subrequests += requestsUsed;

        if (outcome.kind === "deleted" || outcome.kind === "not_found") {
          if (await deleteBlobIfUnreferenced(db, blob.id)) {
            report.blobs_deleted += 1;
          }
        } else {
          await markBlobGcBlocked(db, blob.id, outcome.reason);
          report.blobs_blocked += 1;
          console.warn(
            JSON.stringify({
              message:
                "GHCR refused deletion permanently; marked blob as gc_blocked",
              owner: owner.name,
              package: pkg,
              manifest: blob.manifestDigest,
              reason: outcome.reason,
            }),
          );
        }
      } catch (error) {
        subrequests += 1;
        report.blob_errors += 1;
        console.error(
          JSON.stringify({
            message: "failed to delete unreferenced GHCR package version",
            owner: owner.name,
            package: pkg,
            manifest: blob.manifestDigest,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    for (const [pkg, pkgBlobs] of byPackage) {
      const knownBlobs: BlobRecord[] = [];
      const unknownBlobs: BlobRecord[] = [];
      for (const blob of pkgBlobs) {
        if (blob.ghcrVersionId === null) {
          unknownBlobs.push(blob);
        } else {
          knownBlobs.push(blob);
        }
      }

      for (const blob of knownBlobs) {
        // Reserve 2 subrequests in case deleting the last version falls back to package deletion.
        if (subrequests + 2 > maxSubrequests) {
          report.blobs_skipped += 1;

          continue;
        }
        await deleteBlobVersion(pkg, blob, blob.ghcrVersionId!);
      }

      if (unknownBlobs.length === 0) {
        continue;
      }

      const maxListPages = maxSubrequests - subrequests - 2;
      if (maxListPages < 1) {
        report.blobs_skipped += unknownBlobs.length;

        continue;
      }

      let versions: Map<string, number>;
      let complete: boolean;
      try {
        const targetDigests = new Set(
          unknownBlobs.map((blob) => blob.manifestDigest),
        );
        const listed = await githubApp.listGhcrPackageVersions(
          ghcrOwner,
          owner.ownerType,
          token,
          pkg,
          maxListPages,
          targetDigests,
        );
        versions = listed.versions;
        complete = listed.complete;
        subrequests += listed.requestsUsed;
      } catch (error) {
        report.blob_errors += unknownBlobs.length;
        console.error(
          JSON.stringify({
            message: "failed to list GHCR package versions for GC",
            owner: owner.name,
            package: pkg,
            error: error instanceof Error ? error.message : String(error),
          }),
        );

        continue;
      }

      await cacheBlobVersionIds(db, owner.name, pkg, versions);

      for (const blob of unknownBlobs) {
        const versionId = versions.get(blob.manifestDigest);
        if (versionId === undefined) {
          if (!complete) {
            report.blobs_skipped += 1;
          } else if (await deleteBlobIfUnreferenced(db, blob.id)) {
            report.blobs_deleted += 1;
          }

          continue;
        }

        if (subrequests + 2 > maxSubrequests) {
          report.blobs_skipped += 1;

          continue;
        }

        await deleteBlobVersion(pkg, blob, versionId);
      }
    }
  }

  console.log(
    JSON.stringify({
      message: "garbage collection cycle complete",
      dry_run: dryRun,
      subrequests,
      ...report,
    }),
  );

  return report;
}
