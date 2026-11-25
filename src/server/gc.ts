import { errorMessage } from "../shared/format.ts";
import { unixNow } from "../shared/nix-format.ts";
import type { GcReport } from "../shared/protocol.ts";
import type { LoadedConfig, LoadedOwner } from "./config.ts";
import type { SqlDatabase } from "./db.ts";
import {
  cacheBlobVersionIds,
  deleteBlobIfUnreferenced,
  evictExpiredPrScopes,
  evictStaleMainPaths,
  listKnownManifestsByPackage,
  listUnreferencedBlobs,
  markBlobGcBlocked,
} from "./db.ts";
import type { GhcrPackageClient, GhcrPackageVersion } from "./github.ts";
import { mintInstallationToken, openGhcrPackage } from "./github.ts";
import { log } from "./log.ts";

const SECONDS_PER_DAY = 86_400;
const ORPHAN_GRACE_SECONDS = 3600;
const DELETE_SUBREQUEST_RESERVE = 2;

const isFirnNarVersion = (version: GhcrPackageVersion): boolean =>
  version.tags.length > 0 &&
  version.tags.every((tag) => tag.startsWith("nar-"));

interface GcState {
  db: SqlDatabase;
  config: LoadedConfig;
  report: GcReport;
  tokens: Map<string, string>;
  failedTokenOwners: Set<string>;
  subrequests: number;
  orphansDeleted: number;
}

interface DeleteTarget {
  versionId: number;
  manifestDigest: string;
  blobId?: number;
}

const hasBudget = (state: GcState, needed: number): boolean =>
  state.subrequests + needed <= state.config.gc.maxSubrequests;

const canAccessOwner = (state: GcState, owner: LoadedOwner): boolean =>
  Boolean(
    state.config.githubPackagesToken ||
    (state.config.githubApp && owner.githubInstallationId !== null),
  );

function recordError(state: GcState, message: string, count = 1): void {
  state.report.blob_errors += count;
  state.report.last_error ??= message;
}

async function acquireOwnerToken(
  state: GcState,
  owner: LoadedOwner,
  extraBudget: number,
): Promise<
  { status: "ok"; token: string } | { status: "skip" } | { status: "error" }
> {
  const { githubPackagesToken, githubApp, githubApiUrl } = state.config;
  const cached = githubPackagesToken ?? state.tokens.get(owner.name);
  const minNeeded = (cached ? 0 : 1) + extraBudget;
  if (!canAccessOwner(state, owner) || !hasBudget(state, minNeeded)) {
    return { status: "skip" };
  }
  if (cached) {
    return { status: "ok", token: cached };
  }
  if (
    !githubApp ||
    owner.githubInstallationId === null ||
    state.failedTokenOwners.has(owner.name)
  ) {
    return { status: "error" };
  }

  try {
    const token = await mintInstallationToken(
      githubApp,
      githubApiUrl,
      owner.githubInstallationId,
    );
    state.subrequests += 1;
    state.tokens.set(owner.name, token);

    return { status: "ok", token };
  } catch (error) {
    state.failedTokenOwners.add(owner.name);
    const detail = errorMessage(error);
    state.report.last_error ??= detail;
    log.error("failed to mint GitHub App installation token for GC", {
      owner: owner.name,
      error: detail,
    });

    return { status: "error" };
  }
}

async function deleteVersion(
  state: GcState,
  pkgClient: GhcrPackageClient,
  ownerName: string,
  pkg: string,
  target: DeleteTarget,
  justListed: boolean,
): Promise<"deleted" | "handled" | "abort_package"> {
  const { versionId, manifestDigest, blobId } = target;
  try {
    const { outcome, requestsUsed } = await pkgClient.deleteVersion(
      versionId,
      manifestDigest,
    );
    state.subrequests += requestsUsed;

    if (outcome.kind === "deleted") {
      if (blobId === undefined) {
        state.report.blobs_deleted += 1;
        state.orphansDeleted += 1;
      } else if (await deleteBlobIfUnreferenced(state.db, blobId)) {
        state.report.blobs_deleted += 1;
      }

      return "deleted";
    }

    if (outcome.kind === "not_found") {
      let stillExists = justListed;
      if (!justListed && hasBudget(state, 1)) {
        stillExists = await pkgClient.exists(versionId);
        state.subrequests += 1;
      }
      if (!stillExists && blobId !== undefined) {
        if (await deleteBlobIfUnreferenced(state.db, blobId)) {
          state.report.blobs_deleted += 1;
        }

        return "deleted";
      }

      const detail = `GHCR returned 404 deleting existing version ${versionId} in ${ownerName}/${pkg} (${outcome.reason || "check GitHub App Packages write permission and repository access"})`;
      recordError(state, detail);
      log.error(detail, {
        owner: ownerName,
        package: pkg,
        version_id: versionId,
        manifest: manifestDigest,
      });

      return "abort_package";
    }

    if (blobId !== undefined) {
      await markBlobGcBlocked(state.db, blobId, outcome.reason);
    }
    state.report.blobs_blocked += 1;
    log.warn("GHCR refused deletion permanently", {
      owner: ownerName,
      package: pkg,
      manifest: manifestDigest,
      reason: outcome.reason,
    });

    return "handled";
  } catch (error) {
    state.subrequests += 1;
    const detail = errorMessage(error);
    recordError(state, detail);
    log.error("failed to delete GHCR package version", {
      owner: ownerName,
      package: pkg,
      manifest: manifestDigest,
      error: detail,
    });

    return "handled";
  }
}

async function deleteBatch(
  state: GcState,
  pkgClient: GhcrPackageClient,
  ownerName: string,
  pkg: string,
  targets: readonly DeleteTarget[],
  justListed: boolean,
): Promise<{ deleted: number; aborted: boolean; budgetExhausted: boolean }> {
  let deleted = 0;
  for (const [i, target] of targets.entries()) {
    if (!hasBudget(state, DELETE_SUBREQUEST_RESERVE)) {
      state.report.blobs_skipped += targets.length - i;

      return { deleted, aborted: false, budgetExhausted: true };
    }
    const res = await deleteVersion(
      state,
      pkgClient,
      ownerName,
      pkg,
      target,
      justListed,
    );
    if (res === "abort_package") {
      return { deleted, aborted: true, budgetExhausted: false };
    }
    if (res === "deleted") {
      deleted += 1;
    }
  }

  return { deleted, aborted: false, budgetExhausted: false };
}

async function gcUnreferencedBlobs(
  state: GcState,
  owners: readonly LoadedOwner[],
): Promise<void> {
  for (const owner of owners) {
    const unreferenced = await listUnreferencedBlobs(state.db, owner.name);
    if (unreferenced.length === 0) {
      continue;
    }

    const auth = await acquireOwnerToken(
      state,
      owner,
      DELETE_SUBREQUEST_RESERVE,
    );
    if (auth.status !== "ok") {
      if (auth.status === "skip") {
        state.report.blobs_skipped += unreferenced.length;
      } else {
        state.report.blob_errors += unreferenced.length;
      }

      continue;
    }

    const ghcrOwner = owner.name.toLowerCase();
    for (const [pkg, pkgBlobs] of Map.groupBy(
      unreferenced,
      (b) => b.ghcrPackage,
    )) {
      const pkgClient = openGhcrPackage(
        state.config.githubApiUrl,
        ghcrOwner,
        owner.ownerType,
        auth.token,
        pkg,
      );
      const knownTargets: DeleteTarget[] = [];
      const unknownBlobs = [];
      for (const blob of pkgBlobs) {
        if (blob.ghcrVersionId === null) {
          unknownBlobs.push(blob);
        } else {
          knownTargets.push({
            versionId: blob.ghcrVersionId,
            manifestDigest: blob.manifestDigest,
            blobId: blob.id,
          });
        }
      }

      const knownResult = await deleteBatch(
        state,
        pkgClient,
        owner.name,
        pkg,
        knownTargets,
        false,
      );
      if (knownResult.aborted || unknownBlobs.length === 0) {
        continue;
      }

      const maxListPages =
        state.config.gc.maxSubrequests -
        state.subrequests -
        DELETE_SUBREQUEST_RESERVE;
      if (maxListPages < 1) {
        state.report.blobs_skipped += unknownBlobs.length;

        continue;
      }

      let listed: Awaited<ReturnType<GhcrPackageClient["listVersions"]>>;
      try {
        listed = await pkgClient.listVersions(
          maxListPages,
          new Set(unknownBlobs.map((b) => b.manifestDigest)),
        );
        state.subrequests += listed.requestsUsed;
      } catch (error) {
        const detail = errorMessage(error);
        recordError(state, detail, unknownBlobs.length);
        log.error("failed to list GHCR package versions for GC", {
          owner: owner.name,
          package: pkg,
          error: detail,
        });

        continue;
      }

      await cacheBlobVersionIds(state.db, owner.name, pkg, listed.versions);

      const resolvedTargets: DeleteTarget[] = [];
      for (const blob of unknownBlobs) {
        const versionId = listed.versions.get(blob.manifestDigest);
        if (versionId !== undefined) {
          resolvedTargets.push({
            versionId,
            manifestDigest: blob.manifestDigest,
            blobId: blob.id,
          });
        } else if (!listed.complete) {
          state.report.blobs_skipped += 1;
        } else if (await deleteBlobIfUnreferenced(state.db, blob.id)) {
          state.report.blobs_deleted += 1;
        }
      }

      await deleteBatch(
        state,
        pkgClient,
        owner.name,
        pkg,
        resolvedTargets,
        true,
      );
    }
  }
}

async function sweepOrphanManifests(
  state: GcState,
  owners: readonly LoadedOwner[],
  orphanCutoff: number,
): Promise<void> {
  let budgetExhausted = false;

  for (const owner of owners) {
    if (!canAccessOwner(state, owner)) {
      continue;
    }
    const knownByPackage = await listKnownManifestsByPackage(
      state.db,
      owner.name,
    );
    if (knownByPackage.size === 0) {
      continue;
    }

    const auth = await acquireOwnerToken(
      state,
      owner,
      1 + DELETE_SUBREQUEST_RESERVE,
    );
    if (auth.status === "skip") {
      budgetExhausted = true;

      break;
    }
    if (auth.status === "error") {
      state.report.blob_errors += 1;

      continue;
    }

    const ghcrOwner = owner.name.toLowerCase();
    for (const [pkg, knownManifests] of knownByPackage) {
      const pkgClient = openGhcrPackage(
        state.config.githubApiUrl,
        ghcrOwner,
        owner.ownerType,
        auth.token,
        pkg,
      );
      for (let page = 1; ;) {
        if (!hasBudget(state, 1 + DELETE_SUBREQUEST_RESERVE)) {
          budgetExhausted = true;

          break;
        }

        let pageResult: Awaited<ReturnType<GhcrPackageClient["listPage"]>>;
        try {
          pageResult = await pkgClient.listPage(page);
          state.subrequests += 1;
        } catch (error) {
          state.subrequests += 1;
          const detail = errorMessage(error);
          recordError(state, detail);
          log.error("failed to list GHCR versions during orphan sweep", {
            owner: owner.name,
            package: pkg,
            page,
            error: detail,
          });

          break;
        }

        if (pageResult.notFound || pageResult.versions.length === 0) {
          break;
        }

        const orphans: DeleteTarget[] = pageResult.versions
          .filter(
            (v) =>
              !knownManifests.has(v.name) &&
              isFirnNarVersion(v) &&
              v.updatedAt !== null &&
              v.updatedAt <= orphanCutoff,
          )
          .map((v) => ({ versionId: v.id, manifestDigest: v.name }));

        const result = await deleteBatch(
          state,
          pkgClient,
          owner.name,
          pkg,
          orphans,
          true,
        );
        budgetExhausted = result.budgetExhausted;
        if (
          budgetExhausted ||
          result.aborted ||
          pageResult.versions.length < 100
        ) {
          break;
        }
        if (result.deleted === 0) {
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

  if (budgetExhausted && state.report.blobs_skipped === 0) {
    state.report.blobs_skipped += 1;
  }
}

export async function runGc(
  db: SqlDatabase,
  config: LoadedConfig,
  dryRun: boolean,
): Promise<GcReport> {
  const now = unixNow();
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

  const state: GcState = {
    db,
    config,
    report,
    tokens: new Map(),
    failedTokenOwners: new Set(),
    subrequests: 0,
    orphansDeleted: 0,
  };
  const owners = [...config.ownersByName.values()];

  if ((!config.githubApp && !config.githubPackagesToken) || dryRun) {
    for (const owner of owners) {
      report.blobs_skipped += (
        await listUnreferencedBlobs(db, owner.name)
      ).length;
    }
  } else {
    await gcUnreferencedBlobs(state, owners);
    if (report.blobs_skipped === 0) {
      await sweepOrphanManifests(state, owners, now - ORPHAN_GRACE_SECONDS);
    }
  }

  log.info("garbage collection cycle complete", {
    dry_run: dryRun,
    subrequests: state.subrequests,
    orphans_deleted: state.orphansDeleted,
    ...report,
  });

  return report;
}
