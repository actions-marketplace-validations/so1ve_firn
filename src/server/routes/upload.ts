import type { Context } from "hono";

import { errorMessage } from "../../shared/format.ts";
import {
  fingerprint,
  normalizeReferences,
  storeHashFromPath,
  storePathBasename,
  unixNow,
  validateSha256Hex,
  validateSha256NixBase32,
} from "../../shared/nix-format.ts";
import { OciClient } from "../../shared/oci.ts";
import type {
  CommitEntry,
  CommitRequest,
  CommitResponse,
  PlanRequest,
  PlanResponse,
} from "../../shared/protocol.ts";
import type { AppBindings } from "../app.ts";
import type { LoadedConfig, LoadedOwner } from "../config.ts";
import {
  ghcrPackageForRepo,
  ghcrRepository,
  isMainRef,
  isRepoAllowed,
} from "../config.ts";
import type { CommitRecord } from "../db.ts";
import {
  MAIN_SCOPE,
  commitEntries,
  existingStoreHashes,
  prScope,
} from "../db.ts";
import {
  GhcrAuthUnavailableError,
  acquirePullToken,
  constantTimeTokenMatches,
  exchangeInstallationGhcrToken,
  extractBearerToken,
  verifyOidcToken,
} from "../github.ts";

export class HttpError extends Error {
  public readonly status: 400 | 401 | 403 | 503;
  public readonly code: string | undefined;

  constructor(status: 400 | 401 | 403 | 503, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface AuthenticatedUpload {
  owner: LoadedOwner;
  ghcrPackage: string;
  scope: string;
  prInfo: { repo: string; number: number } | null;
  needsGhcrToken: boolean;
}

function tryHttp<T>(
  status: 400 | 401 | 403 | 503,
  fn: () => T,
  prefix = "",
): T {
  try {
    return fn();
  } catch (error) {
    throw new HttpError(status, `${prefix}${errorMessage(error)}`);
  }
}

async function matchManualOwner(
  config: LoadedConfig,
  requestedOwner: string | undefined,
  token: string,
): Promise<LoadedOwner | null> {
  if (requestedOwner) {
    const owner = config.ownersByName.get(requestedOwner);

    return owner && (await constantTimeTokenMatches(owner.manualTokens, token))
      ? owner
      : null;
  }

  let matched: LoadedOwner | null = null;
  for (const owner of config.ownersByName.values()) {
    if (await constantTimeTokenMatches(owner.manualTokens, token)) {
      if (matched) {
        throw new HttpError(
          400,
          "manual token matches multiple owners; specify --owner",
        );
      }
      matched = owner;
    }
  }

  return matched;
}

async function authenticate(
  config: LoadedConfig,
  request: Request,
  requestedOwner: string | undefined,
): Promise<AuthenticatedUpload> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    throw new HttpError(401, "missing or invalid Bearer Authorization header");
  }

  const manualOwner = await matchManualOwner(config, requestedOwner, token);
  if (manualOwner) {
    return {
      owner: manualOwner,
      ghcrPackage: manualOwner.manualPushPackage,
      scope: MAIN_SCOPE,
      prInfo: null,
      needsGhcrToken: true,
    };
  }

  const oidc = await verifyOidcToken(
    config.oidcIssuer,
    config.publicBaseUrl,
    token,
  ).catch((error: unknown) => {
    const message = errorMessage(error);
    console.warn(
      JSON.stringify({ message: "OIDC authentication failed", error: message }),
    );

    throw new HttpError(401, `invalid credentials: ${message}`);
  });

  const owner = config.ownersByGithubId.get(oidc.ownerId);
  if (!owner) {
    throw new HttpError(403, "GitHub owner is not configured");
  }
  if (requestedOwner && requestedOwner !== owner.name) {
    throw new HttpError(403, "requested owner does not match OIDC identity");
  }
  if (!isRepoAllowed(owner, oidc.repoName)) {
    throw new HttpError(
      403,
      `repository '${oidc.repoName}' is not allowed for owner '${owner.name}'`,
    );
  }
  if (oidc.eventName === "pull_request_target") {
    throw new HttpError(
      403,
      "pull_request_target is rejected to prevent fork PR cache poisoning",
    );
  }

  let scope = MAIN_SCOPE;
  let prInfo: { repo: string; number: number } | null = null;
  if (oidc.eventName === "pull_request") {
    if (oidc.prNumber === null) {
      throw new HttpError(
        403,
        "pull_request event did not carry a refs/pull/<n>/merge ref",
      );
    }
    scope = prScope(owner.name, oidc.repoName, oidc.prNumber);
    prInfo = { repo: oidc.repoName, number: oidc.prNumber };
  } else if (!isMainRef(owner, oidc.ref)) {
    throw new HttpError(
      403,
      `ref '${oidc.ref}' is not in main_refs for owner '${owner.name}'`,
      "non-main-ref",
    );
  }

  return {
    owner,
    ghcrPackage: ghcrPackageForRepo(owner, oidc.repoName),
    scope,
    prInfo,
    needsGhcrToken: false,
  };
}

async function validateAndSign(
  oci: OciClient,
  repository: string,
  pullToken: string,
  config: LoadedConfig,
  auth: AuthenticatedUpload,
  entry: CommitEntry,
  now: number,
): Promise<CommitRecord> {
  const { storeHash, blobDigest, manifestDigest, references, deriver } =
    tryHttp(400, () => {
      if (!entry.manifest_digest.startsWith("sha256:")) {
        throw new Error("manifest_digest must start with 'sha256:'");
      }
      const manifestHex = entry.manifest_digest.slice(7);
      validateSha256Hex(entry.blob_digest);
      validateSha256Hex(manifestHex);
      validateSha256NixBase32(entry.nar_hash);
      validateSha256NixBase32(entry.file_hash);

      return {
        storeHash: storeHashFromPath(entry.store_path),
        blobDigest: entry.blob_digest.toLowerCase(),
        manifestDigest: `sha256:${manifestHex.toLowerCase()}`,
        references: normalizeReferences(entry.references ?? []),
        deriver: entry.deriver
          ? entry.deriver.startsWith("/nix/store/")
            ? storePathBasename(entry.deriver)
            : entry.deriver
          : null,
      };
    });

  await oci
    .verifyManifestAndBlob(
      repository,
      manifestDigest,
      blobDigest,
      entry.file_size,
      pullToken,
    )
    .catch((error: unknown) => {
      throw new HttpError(
        400,
        `GHCR verification failed: ${errorMessage(error)}`,
      );
    });

  const signingKey = auth.prInfo ? config.prKey : config.mainKey;
  const signature = await signingKey.signFingerprint(
    fingerprint(entry.store_path, entry.nar_hash, entry.nar_size, references),
  );

  return {
    ownerId: auth.owner.name,
    scope: auth.scope,
    prInfo: auth.prInfo,
    ghcrPackage: auth.ghcrPackage,
    manifestDigest,
    blobDigest,
    fileSize: entry.file_size,
    storeHash,
    storePath: entry.store_path,
    narHash: entry.nar_hash,
    narSize: entry.nar_size,
    fileHash: entry.file_hash,
    deriver,
    references,
    signature,
    now,
  };
}

export async function handleUploadPlan(
  c: Context<AppBindings>,
): Promise<Response> {
  const config = c.get("config");
  const body = await c.req.json<PlanRequest>();
  const auth = await authenticate(config, c.req.raw, body.owner);
  const hashes = tryHttp(400, () =>
    (body.store_paths ?? []).map((p) => storeHashFromPath(p)),
  );

  const existing = await existingStoreHashes(c.get("db"), auth.scope, hashes);
  const missing = hashes.filter((hash) => !existing.has(hash));
  const repo = ghcrRepository(auth.owner.name, auth.ghcrPackage);

  const oci = new OciClient(config.registryUrl);
  let ghcrToken: string | undefined;
  if (auth.needsGhcrToken) {
    ghcrToken = await exchangeInstallationGhcrToken(
      config,
      auth.owner,
      oci,
      repo,
      "pull,push",
    ).catch((error: unknown) => {
      if (error instanceof GhcrAuthUnavailableError) {
        throw new HttpError(503, error.message);
      }

      throw error;
    });
  }

  console.log(
    JSON.stringify({
      message: "planned cache upload",
      owner: auth.owner.name,
      scope: auth.scope,
      repository: repo,
      total: hashes.length,
      missing: missing.length,
      manual: auth.needsGhcrToken,
    }),
  );

  return c.json({
    owner: auth.owner.name,
    scope: auth.scope,
    registry: config.registryUrl,
    ghcr_repository: repo,
    ...(ghcrToken ? { ghcr_token: ghcrToken } : {}),
    missing,
  } satisfies PlanResponse);
}

export async function handleUploadCommit(
  c: Context<AppBindings>,
): Promise<Response> {
  const config = c.get("config");
  const body = await c.req.json<CommitRequest>();
  const auth = await authenticate(config, c.req.raw, body.owner);
  const repo = ghcrRepository(auth.owner.name, auth.ghcrPackage);
  const oci = new OciClient(config.registryUrl);
  const now = unixNow();
  const entries = body.entries ?? [];
  const pullToken =
    entries.length > 0
      ? await acquirePullToken(config, auth.owner, oci, repo)
      : "";

  const records = await Promise.all(
    entries.map((entry) =>
      validateAndSign(oci, repo, pullToken, config, auth, entry, now),
    ),
  );
  const committed = await commitEntries(c.get("db"), records);

  console.log(
    JSON.stringify({
      message: "committed cache entries",
      owner: auth.owner.name,
      scope: auth.scope,
      repository: repo,
      committed,
    }),
  );

  return c.json({
    owner: auth.owner.name,
    scope: auth.scope,
    committed,
  } satisfies CommitResponse);
}
