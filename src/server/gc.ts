import { unixNow } from "../shared/nix-format.ts";
import type { GcReport } from "../shared/protocol.ts";
import type { LoadedConfig, LoadedOwner } from "./config.ts";
import type { SqlDatabase } from "./db/types.ts";
import type { BlobRecord } from "./db.ts";
import {
  cacheBlobVersionIds,
  deleteBlobIfUnreferenced,
  evictExpiredPrScopes,
  evictStaleMainPaths,
  listKnownManifestsByPackage,
  listUnreferencedBlobs,
  markBlobGcBlocked,
} from "./db.ts";
import type { GhcrPackageVersion, GitHubAppClient } from "./github.ts";
import { createGitHubAppClient } from "./github.ts";

const SECONDS_PER_DAY = 24 * 60 * 60;
// Wait before deleting untracked GHCR manifests so in-flight pushes that have
// uploaded to GHCR but not yet called /api/v1/uploads/commit are never raced.
const ORPHAN_GRACE_SECONDS = 60 * 60;

// Reserve 2 subrequests per delete in case deleting the last version falls back
// to deleting the empty package.
const DELETE_SUBREQUEST_RESERVE = 2;

const isFirnNarVersion = (version: GhcrPackageVersion): boolean =>
  version.tags.length > 0 &&
  version.tags.every((tag) => tag.startsWith("nar-"));

class GcSession {
  public readonly db: SqlDatabase;
  public readonly githubApp: GitHubAppClient;
  public readonly maxSubrequests: number;
  public readonly report: GcReport;
  public subrequests = 0;
  public orphansDeleted = 0;
  readonly #tokens = new Map<string, string>();
  readonly #failedTokenOwners = new Set<string>();

  constructor(
    db: SqlDatabase,
    githubApp: GitHubAppClient,
    maxSubrequests: number,
    report: GcReport,
  ) {
    this.db = db;
    this.githubApp = githubApp;
    this.maxSubrequests = maxSubrequests;
    this.report = report;
  }

  public hasBudget(needed: number): boolean {
    return this.subrequests + needed <= this.maxSubrequests;
  }

  public remainingBudget(): number {
    return this.maxSubrequests - this.subrequests;
  }

  public hasToken(ownerName: string): boolean {
    return this.#tokens.has(ownerName);
  }

  public async getOwnerToken(owner: LoadedOwner): Promise<string | null> {
    const cached = this.#tokens.get(owner.name);
    if (cached) {
      return cached;
    }
    if (
      owner.githubInstallationId === null ||
      this.#failedTokenOwners.has(owner.name)
    ) {
      return null;
    }

    try {
      const token = await this.githubApp.installationToken(
        owner.githubInstallationId,
      );
      this.subrequests += 1;
      this.#tokens.set(owner.name, token);

      return token;
    } catch (error) {
      this.#failedTokenOwners.add(owner.name);
      console.error(
        JSON.stringify({
          message: "failed to mint GitHub App installation token for GC",
          owner: owner.name,
          error: error instanceof Error ? error.message : String(error),
        }),
      );

      return null;
    }
  }
}

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

async function deleteTrackedBlob(
  session: GcSession,
  owner: LoadedOwner,
  token: string,
  pkg: string,
  blob: BlobRecord,
  versionId: number,
): Promise<void> {
  try {
    const { outcome, requestsUsed } =
      await session.githubApp.deleteGhcrPackageVersionById(
        owner.name.toLowerCase(),
        owner.ownerType,
        token,
        pkg,
        versionId,
        blob.manifestDigest,
      );
    session.subrequests += requestsUsed;

    if (outcome.kind === "deleted" || outcome.kind === "not_found") {
      if (await deleteBlobIfUnreferenced(session.db, blob.id)) {
        session.report.blobs_deleted += 1;
      }

      return;
    }

    await markBlobGcBlocked(session.db, blob.id, outcome.reason);
    session.report.blobs_blocked += 1;
    console.warn(
      JSON.stringify({
        message: "GHCR refused deletion permanently; marked blob as gc_blocked",
        owner: owner.name,
        package: pkg,
        manifest: blob.manifestDigest,
        reason: outcome.reason,
      }),
    );
  } catch (error) {
    session.subrequests += 1;
    session.report.blob_errors += 1;
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

async function sweepOwnerTrackedBlobs(
  session: GcSession,
  owner: LoadedOwner,
  unreferenced: readonly BlobRecord[],
): Promise<void> {
  if (owner.githubInstallationId === null || !session.hasBudget(3)) {
    session.report.blobs_skipped += unreferenced.length;

    return;
  }

  const token = await session.getOwnerToken(owner);
  if (!token) {
    session.report.blob_errors += unreferenced.length;

    return;
  }

  const ghcrOwner = owner.name.toLowerCase();

  for (const [pkg, pkgBlobs] of groupBlobsByPackage(unreferenced)) {
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
      if (!session.hasBudget(DELETE_SUBREQUEST_RESERVE)) {
        session.report.blobs_skipped += 1;

        continue;
      }
      await deleteTrackedBlob(
        session,
        owner,
        token,
        pkg,
        blob,
        blob.ghcrVersionId!,
      );
    }

    if (unknownBlobs.length === 0) {
      continue;
    }

    const maxListPages = session.remainingBudget() - DELETE_SUBREQUEST_RESERVE;
    if (maxListPages < 1) {
      session.report.blobs_skipped += unknownBlobs.length;

      continue;
    }

    let versions: Map<string, number>;
    let complete: boolean;
    try {
      const targetDigests = new Set(
        unknownBlobs.map((blob) => blob.manifestDigest),
      );
      const listed = await session.githubApp.listGhcrPackageVersions(
        ghcrOwner,
        owner.ownerType,
        token,
        pkg,
        maxListPages,
        targetDigests,
      );
      versions = listed.versions;
      complete = listed.complete;
      session.subrequests += listed.requestsUsed;
    } catch (error) {
      session.report.blob_errors += unknownBlobs.length;
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

    await cacheBlobVersionIds(session.db, owner.name, pkg, versions);

    for (const blob of unknownBlobs) {
      const versionId = versions.get(blob.manifestDigest);
      if (versionId === undefined) {
        if (!complete) {
          session.report.blobs_skipped += 1;
        } else if (await deleteBlobIfUnreferenced(session.db, blob.id)) {
          session.report.blobs_deleted += 1;
        }

        continue;
      }

      if (!session.hasBudget(DELETE_SUBREQUEST_RESERVE)) {
        session.report.blobs_skipped += 1;

        continue;
      }

      await deleteTrackedBlob(session, owner, token, pkg, blob, versionId);
    }
  }
}

async function deleteOrphanVersion(
  session: GcSession,
  owner: LoadedOwner,
  token: string,
  pkg: string,
  orphan: GhcrPackageVersion,
): Promise<boolean> {
  try {
    const { outcome, requestsUsed } =
      await session.githubApp.deleteGhcrPackageVersionById(
        owner.name.toLowerCase(),
        owner.ownerType,
        token,
        pkg,
        orphan.id,
        orphan.name,
      );
    session.subrequests += requestsUsed;

    if (outcome.kind === "deleted" || outcome.kind === "not_found") {
      session.report.blobs_deleted += 1;
      session.orphansDeleted += 1;

      return true;
    }

    session.report.blobs_blocked += 1;
    console.warn(
      JSON.stringify({
        message: "GHCR refused deletion of orphan version",
        owner: owner.name,
        package: pkg,
        manifest: orphan.name,
        reason: outcome.reason,
      }),
    );
  } catch (error) {
    session.subrequests += 1;
    session.report.blob_errors += 1;
    console.error(
      JSON.stringify({
        message: "failed to delete orphan GHCR package version",
        owner: owner.name,
        package: pkg,
        manifest: orphan.name,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  return false;
}

async function sweepPackageOrphans(
  session: GcSession,
  owner: LoadedOwner,
  token: string,
  pkg: string,
  knownManifests: ReadonlySet<string>,
  orphanCutoff: number,
): Promise<boolean> {
  const ghcrOwner = owner.name.toLowerCase();
  let page = 1;

  while (true) {
    if (!session.hasBudget(1 + DELETE_SUBREQUEST_RESERVE)) {
      return true;
    }

    let pageResult: { versions: GhcrPackageVersion[]; notFound: boolean };
    try {
      pageResult = await session.githubApp.listGhcrPackageVersionsPage(
        ghcrOwner,
        owner.ownerType,
        token,
        pkg,
        page,
      );
      session.subrequests += 1;
    } catch (error) {
      session.subrequests += 1;
      session.report.blob_errors += 1;
      console.error(
        JSON.stringify({
          message: "failed to list GHCR versions during orphan sweep",
          owner: owner.name,
          package: pkg,
          page,
          error: error instanceof Error ? error.message : String(error),
        }),
      );

      return false;
    }

    if (pageResult.notFound || pageResult.versions.length === 0) {
      return false;
    }

    const orphans = pageResult.versions.filter(
      (v) =>
        !knownManifests.has(v.name) &&
        isFirnNarVersion(v) &&
        v.updatedAt !== null &&
        v.updatedAt <= orphanCutoff,
    );

    let deletedOnPage = 0;
    for (const [i, orphan] of orphans.entries()) {
      if (!session.hasBudget(DELETE_SUBREQUEST_RESERVE)) {
        session.report.blobs_skipped += orphans.length - i;

        return true;
      }

      if (await deleteOrphanVersion(session, owner, token, pkg, orphan)) {
        deletedOnPage += 1;
      }
    }

    if (pageResult.versions.length < 100) {
      return false;
    }
    // When deletions shrink the current page, later items shift onto it;
    // re-reading the same page avoids skipping those shifted entries.
    if (deletedOnPage === 0) {
      page += 1;
    }
  }
}

async function sweepOrphanedVersions(
  session: GcSession,
  owners: Iterable<LoadedOwner>,
  orphanCutoff: number,
): Promise<void> {
  let budgetExhausted = false;

  for (const owner of owners) {
    if (owner.githubInstallationId === null) {
      continue;
    }

    const knownByPackage = await listKnownManifestsByPackage(
      session.db,
      owner.name,
    );
    if (knownByPackage.size === 0) {
      continue;
    }

    const minNeeded =
      (session.hasToken(owner.name) ? 0 : 1) + 1 + DELETE_SUBREQUEST_RESERVE;
    if (!session.hasBudget(minNeeded)) {
      budgetExhausted = true;

      break;
    }

    const token = await session.getOwnerToken(owner);
    if (!token) {
      session.report.blob_errors += 1;

      continue;
    }

    for (const [pkg, knownManifests] of knownByPackage) {
      if (
        await sweepPackageOrphans(
          session,
          owner,
          token,
          pkg,
          knownManifests,
          orphanCutoff,
        )
      ) {
        budgetExhausted = true;

        break;
      }
    }

    if (budgetExhausted) {
      break;
    }
  }

  // Signal to callers (e.g. UI drain loop) that unchecked packages/pages remain.
  if (budgetExhausted && session.report.blobs_skipped === 0) {
    session.report.blobs_skipped += 1;
  }
}

export async function runGc(
  db: SqlDatabase,
  config: LoadedConfig,
  dryRun: boolean,
): Promise<GcReport> {
  const now = unixNow();
  const prCutoff = now - config.gc.prTtlDays * SECONDS_PER_DAY;
  const mainCutoff = now - config.gc.mainLruDays * SECONDS_PER_DAY;
  const orphanCutoff = now - ORPHAN_GRACE_SECONDS;

  const report: GcReport = {
    pr_paths_removed: await evictExpiredPrScopes(db, prCutoff, dryRun),
    main_paths_removed: await evictStaleMainPaths(db, mainCutoff, dryRun),
    blobs_deleted: 0,
    blobs_blocked: 0,
    blobs_skipped: 0,
    blob_errors: 0,
  };

  const githubApp = createGitHubAppClient(config);
  const owners = [...config.ownersByName.values()];
  let subrequests = 0;
  let orphansDeleted = 0;

  if (!githubApp || dryRun) {
    for (const owner of owners) {
      const unreferenced = await listUnreferencedBlobs(db, owner.name);
      report.blobs_skipped += unreferenced.length;
    }
  } else {
    const session = new GcSession(
      db,
      githubApp,
      config.gc.maxSubrequests,
      report,
    );

    // Phase 1: Delete unreferenced blobs tracked in the database.
    for (const owner of owners) {
      const unreferenced = await listUnreferencedBlobs(db, owner.name);
      if (unreferenced.length > 0) {
        await sweepOwnerTrackedBlobs(session, owner, unreferenced);
      }
    }

    // Phase 2: Sweep aged, untracked Firn nar-* manifests left on GHCR by failed commits.
    if (report.blobs_skipped === 0) {
      await sweepOrphanedVersions(session, owners, orphanCutoff);
    }

    subrequests = session.subrequests;
    orphansDeleted = session.orphansDeleted;
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
