import type { Context } from "hono";

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
  exchangeInstallationGhcrToken,
} from "../ghcr.ts";
import {
  constantTimeTokenMatches,
  oidcOwnerId,
  oidcPullRequestNumber,
  oidcRepoName,
  verifyOidcToken,
} from "../github.ts";
import type { AppBindings } from "./cache.ts";

type UploadScope =
  | { kind: "main" }
  | { kind: "pr"; owner: string; repo: string; number: number };

interface AuthenticatedUpload {
  owner: LoadedOwner;
  ghcrPackage: string;
  scope: UploadScope;
  needsGhcrToken: boolean;
}

class HttpError extends Error {
  public readonly status: 400 | 401 | 403 | 503;
  public readonly code: string | undefined;

  constructor(status: 400 | 401 | 403 | 503, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const errorResponse = (c: Context<AppBindings>, error: HttpError): Response =>
  c.text(
    error.message,
    error.status,
    error.code ? { "X-Firn-Error": error.code } : undefined,
  );

const scopeToDbString = (scope: UploadScope): string =>
  scope.kind === "main"
    ? MAIN_SCOPE
    : prScope(scope.owner, scope.repo, scope.number);

function extractBearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    throw new HttpError(401, "missing or invalid Bearer Authorization header");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    throw new HttpError(401, "missing or invalid Bearer Authorization header");
  }

  return token;
}

async function matchManualOwner(
  config: LoadedConfig,
  requestedOwner: string | undefined,
  token: string,
): Promise<LoadedOwner | null> {
  if (requestedOwner) {
    const owner = config.ownersByName.get(requestedOwner);
    if (!owner) {
      return null;
    }

    return (await constantTimeTokenMatches(owner.manualTokens, token))
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
  const token = extractBearerToken(request);
  const manualOwner = await matchManualOwner(config, requestedOwner, token);
  if (manualOwner) {
    return {
      owner: manualOwner,
      ghcrPackage: manualOwner.manualPushPackage,
      scope: { kind: "main" },
      needsGhcrToken: true,
    };
  }

  let claims;
  try {
    claims = await verifyOidcToken(
      config.oidcIssuer,
      config.publicBaseUrl,
      token,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      JSON.stringify({ message: "OIDC authentication failed", error: message }),
    );

    throw new HttpError(401, `invalid credentials: ${message}`);
  }

  let ownerId: number;
  try {
    ownerId = oidcOwnerId(claims);
  } catch (error) {
    throw new HttpError(
      401,
      error instanceof Error ? error.message : String(error),
    );
  }

  const owner = config.ownersByGithubId.get(ownerId);
  if (!owner) {
    throw new HttpError(403, "GitHub owner is not configured");
  }
  if (requestedOwner && requestedOwner !== owner.name) {
    throw new HttpError(403, "requested owner does not match OIDC identity");
  }

  let repoName: string;
  try {
    repoName = oidcRepoName(claims);
  } catch (error) {
    throw new HttpError(
      403,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!isRepoAllowed(owner, repoName)) {
    throw new HttpError(
      403,
      `repository '${repoName}' is not allowed for owner '${owner.name}'`,
    );
  }

  let scope: UploadScope;
  if (claims.event_name === "pull_request_target") {
    throw new HttpError(
      403,
      "pull_request_target is rejected to prevent fork PR cache poisoning",
    );
  } else if (claims.event_name === "pull_request") {
    const number = oidcPullRequestNumber(claims);
    if (number === null) {
      throw new HttpError(
        403,
        "pull_request event did not carry a refs/pull/<n>/merge ref",
      );
    }
    scope = { kind: "pr", owner: owner.name, repo: repoName, number };
  } else {
    if (!isMainRef(owner, claims.ref)) {
      throw new HttpError(
        403,
        `ref '${claims.ref}' is not in main_refs for owner '${owner.name}'`,
        "non-main-ref",
      );
    }
    scope = { kind: "main" };
  }

  return {
    owner,
    ghcrPackage: ghcrPackageForRepo(owner, repoName),
    scope,
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
  let storeHash: string;
  let blobDigest: string;
  let manifestDigest: string;
  let references: string[];
  let deriver: string | null;

  try {
    storeHash = storeHashFromPath(entry.store_path);
    validateSha256Hex(entry.blob_digest);
    blobDigest = entry.blob_digest.toLowerCase();

    if (!entry.manifest_digest.startsWith("sha256:")) {
      throw new Error("manifest_digest must start with 'sha256:'");
    }
    const manifestHex = entry.manifest_digest.slice("sha256:".length);
    validateSha256Hex(manifestHex);
    manifestDigest = `sha256:${manifestHex.toLowerCase()}`;

    validateSha256NixBase32(entry.nar_hash);
    validateSha256NixBase32(entry.file_hash);
    references = normalizeReferences(entry.references ?? []);

    deriver = entry.deriver
      ? entry.deriver.startsWith("/nix/store/")
        ? storePathBasename(entry.deriver)
        : entry.deriver
      : null;
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    await oci.verifyManifestAndBlob(
      repository,
      manifestDigest,
      blobDigest,
      entry.file_size,
      pullToken,
    );
  } catch (error) {
    throw new HttpError(
      400,
      `GHCR verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const signingKey = auth.scope.kind === "main" ? config.mainKey : config.prKey;
  const fp = fingerprint(
    entry.store_path,
    entry.nar_hash,
    entry.nar_size,
    references,
  );
  const signature = await signingKey.signFingerprint(fp);

  return {
    ownerId: auth.owner.name,
    scope: scopeToDbString(auth.scope),
    prInfo:
      auth.scope.kind === "pr"
        ? { repo: auth.scope.repo, number: auth.scope.number }
        : null,
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
  try {
    const config = c.get("config");
    const body = await c.req.json<PlanRequest>();
    const auth = await authenticate(config, c.req.raw, body.owner);

    const hashes: string[] = [];
    for (const storePath of body.store_paths ?? []) {
      try {
        hashes.push(storeHashFromPath(storePath));
      } catch (error) {
        throw new HttpError(
          400,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const scope = scopeToDbString(auth.scope);
    const existing = await existingStoreHashes(c.env.DB, scope, hashes);
    const missing = hashes.filter((hash) => !existing.has(hash));
    const repo = ghcrRepository(auth.owner.name, auth.ghcrPackage);

    const oci = new OciClient(config.registryUrl);
    let ghcrToken: string | undefined;
    if (auth.needsGhcrToken) {
      try {
        ghcrToken = await exchangeInstallationGhcrToken(
          config,
          auth.owner,
          oci,
          repo,
          "pull,push",
        );
      } catch (error) {
        if (error instanceof GhcrAuthUnavailableError) {
          throw new HttpError(503, error.message);
        }

        throw error;
      }
    }

    console.log(
      JSON.stringify({
        message: "planned cache upload",
        owner: auth.owner.name,
        scope,
        repository: repo,
        total: hashes.length,
        missing: missing.length,
        manual: auth.needsGhcrToken,
      }),
    );

    const response: PlanResponse = {
      owner: auth.owner.name,
      scope,
      registry: config.registryUrl,
      ghcr_repository: repo,
      ...(ghcrToken ? { ghcr_token: ghcrToken } : {}),
      missing,
    };

    return c.json(response);
  } catch (error) {
    if (error instanceof HttpError) {
      return errorResponse(c, error);
    }

    throw error;
  }
}

export async function handleUploadCommit(
  c: Context<AppBindings>,
): Promise<Response> {
  try {
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
    const committed = await commitEntries(c.env.DB, records);
    const scope = scopeToDbString(auth.scope);

    console.log(
      JSON.stringify({
        message: "committed cache entries",
        owner: auth.owner.name,
        scope,
        repository: repo,
        committed,
      }),
    );

    const response: CommitResponse = {
      owner: auth.owner.name,
      scope,
      committed,
    };

    return c.json(response);
  } catch (error) {
    if (error instanceof HttpError) {
      return errorResponse(c, error);
    }

    throw error;
  }
}
