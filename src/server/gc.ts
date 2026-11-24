import { errorMessage } from "../shared/format.ts";
import { unixNow } from "../shared/nix-format.ts";
import type { GcReport } from "../shared/protocol.ts";
import type { LoadedConfig, LoadedOwner } from "./config.ts";
import type { BlobRecord, SqlDatabase } from "./db.ts";
import {
  cacheBlobVersionIds,
  deleteBlobIfUnreferenced,
  evictExpiredPrScopes,
  evictStaleMainPaths,
  listKnownManifestsByPackage,
  listUnreferencedBlobs,
  markBlobGcBlocked,
} from "./db.ts";
import type { GhcrPackageVersion } from "./github.ts";
import { GitHubPackagesClient, createGitHubAppClient } from "./github.ts";

const SECONDS_PER_DAY = 86_400;
const ORPHAN_GRACE_SECONDS = 3600;
const DELETE_SUBREQUEST_RESERVE = 2;

const isFirnNarVersion = (version: GhcrPackageVersion): boolean =>
  version.tags.length > 0 &&
  version.tags.every((tag) => tag.startsWith("nar-"));

function groupBlobsByPackage(
  blobs: readonly BlobRecord[],
): Map<string, BlobRecord[]> {
  const byPackage = new Map<string, BlobRecord[]>();
  for (const blob of blobs) {
    const list = byPackage.get(blob.ghcrPackage);
    if (list) {
      list.push(blob);
    } else {
      byPackage.set(blob.ghcrPackage, [blob]);
    }
  }

  return byPackage;
}

export async function runGc(
  db: SqlDatabase,
  config: LoadedConfig,
  dryRun: boolean,
): Promise<GcReport> {
  const now = unixNow();
  const orphanCutoff = now - ORPHAN_GRACE_SECONDS;

  const report: GcReport = {
    pr_paths_removed: await evictExpiredPrScopes(
      db,
      now - config.gc.prTtlDays * SECONDS_PER_DAY,
      dryRun,
    ),
    main_paths_removed: await evictStaleMainPaths(
      db,
      now - config.gc.mainLruDays * SECONDS_PER_DAY,
      dryRun,
    ),
    blobs_deleted: 0,
    blobs_blocked: 0,
    blobs_skipped: 0,
    blob_errors: 0,
  };

  const githubApp = createGitHubAppClient(config);
  const packagesToken = config.githubPackagesToken;
  const owners = [...config.ownersByName.values()];
  let subrequests = 0;
  let orphansDeleted = 0;

  if ((!githubApp && !packagesToken) || dryRun) {
    for (const owner of owners) {
      report.blobs_skipped += (
        await listUnreferencedBlobs(db, owner.name)
      ).length;
    }
  } else {
    const packages = new GitHubPackagesClient(config.githubApiUrl);
    const maxSubrequests = config.gc.maxSubrequests;
    const tokens = new Map<string, string>();
    const failedTokenOwners = new Set<string>();

    const hasBudget = (needed: number) =>
      subrequests + needed <= maxSubrequests;
    const canAccessOwner = (owner: LoadedOwner) =>
      Boolean(
        packagesToken || (githubApp && owner.githubInstallationId !== null),
      );
    const needsTokenMint = (ownerName: string) =>
      !packagesToken && !tokens.has(ownerName);
    function recordError(message: string, count = 1) {
      report.blob_errors += count;
      report.last_error ??= message;
    }

    async function getOwnerToken(owner: LoadedOwner): Promise<string | null> {
      if (packagesToken) {
        return packagesToken;
      }
      const cached = tokens.get(owner.name);
      if (cached) {
        return cached;
      }
      if (
        !githubApp ||
        owner.githubInstallationId === null ||
        failedTokenOwners.has(owner.name)
      ) {
        return null;
      }

      try {
        const token = await githubApp.installationToken(
          owner.githubInstallationId,
        );
        subrequests += 1;
        tokens.set(owner.name, token);

        return token;
      } catch (error) {
        failedTokenOwners.add(owner.name);
        const detail = errorMessage(error);
        report.last_error ??= detail;
        console.error(
          JSON.stringify({
            message: "failed to mint GitHub App installation token for GC",
            owner: owner.name,
            error: detail,
          }),
        );

        return null;
      }
    }

    async function deleteVersion(
      owner: LoadedOwner,
      token: string,
      pkg: string,
      versionId: number,
      manifestDigest: string,
      options: { blobId?: number; justListed: boolean },
    ): Promise<"deleted" | "handled" | "abort_package"> {
      const ghcrOwner = owner.name.toLowerCase();
      try {
        const { outcome, requestsUsed } =
          await packages.deleteGhcrPackageVersionById(
            ghcrOwner,
            owner.ownerType,
            token,
            pkg,
            versionId,
            manifestDigest,
          );
        subrequests += requestsUsed;

        if (outcome.kind === "deleted") {
          if (options.blobId === undefined) {
            report.blobs_deleted += 1;
            orphansDeleted += 1;
          } else if (await deleteBlobIfUnreferenced(db, options.blobId)) {
            report.blobs_deleted += 1;
          }

          return "deleted";
        }

        if (outcome.kind === "not_found") {
          let stillExists = options.justListed;
          if (!options.justListed && hasBudget(1)) {
            stillExists = await packages.ghcrPackageVersionExists(
              ghcrOwner,
              owner.ownerType,
              token,
              pkg,
              versionId,
            );
            subrequests += 1;
          }
          if (!stillExists && options.blobId !== undefined) {
            if (await deleteBlobIfUnreferenced(db, options.blobId)) {
              report.blobs_deleted += 1;
            }

            return "deleted";
          }

          const detail = `GHCR returned 404 deleting existing version ${versionId} in ${owner.name}/${pkg} (${outcome.reason || "check GitHub App Packages write permission and repository access"})`;
          recordError(detail);
          console.error(
            JSON.stringify({
              message: detail,
              owner: owner.name,
              package: pkg,
              version_id: versionId,
              manifest: manifestDigest,
            }),
          );

          return "abort_package";
        }

        if (options.blobId !== undefined) {
          await markBlobGcBlocked(db, options.blobId, outcome.reason);
        }
        report.blobs_blocked += 1;
        console.warn(
          JSON.stringify({
            message: "GHCR refused deletion permanently",
            owner: owner.name,
            package: pkg,
            manifest: manifestDigest,
            reason: outcome.reason,
          }),
        );

        return "handled";
      } catch (error) {
        subrequests += 1;
        const detail = errorMessage(error);
        recordError(detail);
        console.error(
          JSON.stringify({
            message: "failed to delete GHCR package version",
            owner: owner.name,
            package: pkg,
            manifest: manifestDigest,
            error: detail,
          }),
        );

        return "handled";
      }
    }

    // Phase 1: Delete unreferenced blobs tracked in the database.
    for (const owner of owners) {
      const unreferenced = await listUnreferencedBlobs(db, owner.name);
      if (unreferenced.length === 0) {
        continue;
      }

      const minNeeded =
        (needsTokenMint(owner.name) ? 1 : 0) + DELETE_SUBREQUEST_RESERVE;
      if (!canAccessOwner(owner) || !hasBudget(minNeeded)) {
        report.blobs_skipped += unreferenced.length;

        continue;
      }

      const token = await getOwnerToken(owner);
      if (!token) {
        report.blob_errors += unreferenced.length;

        continue;
      }

      const ghcrOwner = owner.name.toLowerCase();
      for (const [pkg, pkgBlobs] of groupBlobsByPackage(unreferenced)) {
        const knownBlobs = pkgBlobs.filter((b) => b.ghcrVersionId !== null);
        const unknownBlobs = pkgBlobs.filter((b) => b.ghcrVersionId === null);

        let aborted = false;
        for (const blob of knownBlobs) {
          if (!hasBudget(DELETE_SUBREQUEST_RESERVE)) {
            report.blobs_skipped += 1;

            continue;
          }
          const res = await deleteVersion(
            owner,
            token,
            pkg,
            blob.ghcrVersionId!,
            blob.manifestDigest,
            { blobId: blob.id, justListed: false },
          );
          if (res === "abort_package") {
            aborted = true;

            break;
          }
        }
        if (aborted || unknownBlobs.length === 0) {
          continue;
        }

        const maxListPages =
          maxSubrequests - subrequests - DELETE_SUBREQUEST_RESERVE;
        if (maxListPages < 1) {
          report.blobs_skipped += unknownBlobs.length;

          continue;
        }

        let listed: Awaited<
          ReturnType<GitHubPackagesClient["listGhcrPackageVersions"]>
        >;
        try {
          listed = await packages.listGhcrPackageVersions(
            ghcrOwner,
            owner.ownerType,
            token,
            pkg,
            maxListPages,
            new Set(unknownBlobs.map((b) => b.manifestDigest)),
          );
          subrequests += listed.requestsUsed;
        } catch (error) {
          const detail = errorMessage(error);
          recordError(detail, unknownBlobs.length);
          console.error(
            JSON.stringify({
              message: "failed to list GHCR package versions for GC",
              owner: owner.name,
              package: pkg,
              error: detail,
            }),
          );

          continue;
        }

        await cacheBlobVersionIds(db, owner.name, pkg, listed.versions);

        for (const blob of unknownBlobs) {
          const versionId = listed.versions.get(blob.manifestDigest);
          if (versionId === undefined) {
            if (!listed.complete) {
              report.blobs_skipped += 1;
            } else if (await deleteBlobIfUnreferenced(db, blob.id)) {
              report.blobs_deleted += 1;
            }

            continue;
          }
          if (!hasBudget(DELETE_SUBREQUEST_RESERVE)) {
            report.blobs_skipped += 1;

            continue;
          }
          const res = await deleteVersion(
            owner,
            token,
            pkg,
            versionId,
            blob.manifestDigest,
            { blobId: blob.id, justListed: true },
          );
          if (res === "abort_package") {
            break;
          }
        }
      }
    }

    // Phase 2: Sweep aged, untracked Firn nar-* manifests left on GHCR by failed commits.
    if (report.blobs_skipped === 0) {
      let budgetExhausted = false;

      for (const owner of owners) {
        if (!canAccessOwner(owner)) {
          continue;
        }
        const knownByPackage = await listKnownManifestsByPackage(
          db,
          owner.name,
        );
        if (knownByPackage.size === 0) {
          continue;
        }

        const minNeeded =
          (needsTokenMint(owner.name) ? 1 : 0) + 1 + DELETE_SUBREQUEST_RESERVE;
        if (!hasBudget(minNeeded)) {
          budgetExhausted = true;

          break;
        }

        const token = await getOwnerToken(owner);
        if (!token) {
          report.blob_errors += 1;

          continue;
        }

        const ghcrOwner = owner.name.toLowerCase();
        for (const [pkg, knownManifests] of knownByPackage) {
          for (let page = 1; ;) {
            if (!hasBudget(1 + DELETE_SUBREQUEST_RESERVE)) {
              budgetExhausted = true;

              break;
            }

            let pageResult: {
              versions: GhcrPackageVersion[];
              notFound: boolean;
            };
            try {
              pageResult = await packages.listGhcrPackageVersionsPage(
                ghcrOwner,
                owner.ownerType,
                token,
                pkg,
                page,
              );
              subrequests += 1;
            } catch (error) {
              subrequests += 1;
              const detail = errorMessage(error);
              recordError(detail);
              console.error(
                JSON.stringify({
                  message: "failed to list GHCR versions during orphan sweep",
                  owner: owner.name,
                  package: pkg,
                  page,
                  error: detail,
                }),
              );

              break;
            }

            if (pageResult.notFound || pageResult.versions.length === 0) {
              break;
            }

            const orphans = pageResult.versions.filter(
              (v) =>
                !knownManifests.has(v.name) &&
                isFirnNarVersion(v) &&
                v.updatedAt !== null &&
                v.updatedAt <= orphanCutoff,
            );

            let deletedOnPage = 0;
            let packageAborted = false;
            for (const [i, orphan] of orphans.entries()) {
              if (!hasBudget(DELETE_SUBREQUEST_RESERVE)) {
                report.blobs_skipped += orphans.length - i;
                budgetExhausted = true;

                break;
              }
              const res = await deleteVersion(
                owner,
                token,
                pkg,
                orphan.id,
                orphan.name,
                { justListed: true },
              );
              if (res === "abort_package") {
                packageAborted = true;

                break;
              }
              if (res === "deleted") {
                deletedOnPage += 1;
              }
            }

            if (
              budgetExhausted ||
              packageAborted ||
              pageResult.versions.length < 100
            ) {
              break;
            }
            if (deletedOnPage === 0) {
              page += 1;
            }
          }

          if (budgetExhausted) {
            break;
          }
        }

        if (budgetExhausted) {
          break;
        }
      }

      if (budgetExhausted && report.blobs_skipped === 0) {
        report.blobs_skipped += 1;
      }
    }
  }

  console.log(
    JSON.stringify({
      message: "garbage collection cycle complete",
      dry_run: dryRun,
      subrequests,
      orphans_deleted: orphansDeleted,
      ...report,
    }),
  );

  return report;
}
