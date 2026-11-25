import { timingSafeEqual } from "node:crypto";

import { readBody, stripTrailingSlash } from "../shared/format.ts";
import {
  base64ToBytes,
  bytesToBase64,
  encodeHex,
  unixNow,
} from "../shared/nix-format.ts";
import type { OciClient } from "../shared/oci.ts";
import { OciHttpError } from "../shared/oci.ts";
import type {
  LoadedConfig,
  LoadedGitHubApp,
  LoadedOwner,
  OwnerType,
} from "./config.ts";
import { log } from "./log.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const appSigningKeys = new WeakMap<LoadedGitHubApp, Promise<CryptoKey>>();

export interface VerifiedOidcIdentity {
  ownerId: number;
  repoName: string;
  ref: string;
  eventName: string;
  prNumber: number | null;
}

export type DeleteOutcome =
  | { kind: "deleted" }
  | { kind: "not_found"; reason: string }
  | { kind: "blocked"; reason: string };

export interface GhcrPackageVersion {
  id: number;
  name: string;
  updatedAt: number | null;
  tags: string[];
}

export type GhcrPackageClient = ReturnType<typeof openGhcrPackage>;

export class GhcrAuthUnavailableError extends Error {}

export const extractBearerToken = (
  header: string | undefined | null,
): string | null =>
  header?.startsWith("Bearer ") ? header.slice(7).trim() || null : null;

const base64UrlEncode = (bytes: Uint8Array): string =>
  bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const base64UrlDecode = (segment: string): Uint8Array =>
  base64ToBytes(
    segment
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(segment.length / 4) * 4, "="),
  );

function encodeDerLength(len: number): Uint8Array {
  if (len < 0x80) {
    return new Uint8Array([len]);
  }
  const bytes: number[] = [];
  for (let rem = len; rem > 0; rem >>= 8) {
    bytes.unshift(rem & 0xff);
  }

  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

// Wraps a PKCS#1 RSAPrivateKey DER payload in a PKCS#8 PrivateKeyInfo envelope
// so Web Crypto `importKey("pkcs8", ...)` accepts GitHub App PEM keys directly.
function pemToPkcs8Der(pem: string): Uint8Array {
  const trimmed = pem.trim();
  const der = base64ToBytes(
    trimmed.replace(/-----[^-]+-----/g, "").replaceAll(/\s+/g, ""),
  );
  if (!trimmed.includes("BEGIN RSA PRIVATE KEY")) {
    return der;
  }

  const body = concatBytes(
    new Uint8Array([
      0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7,
      0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, 0x04,
    ]),
    encodeDerLength(der.length),
    der,
  );

  return concatBytes(
    new Uint8Array([0x30]),
    encodeDerLength(body.length),
    body,
  );
}

export async function timingSafeEqualString(
  a: string,
  b: string,
): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);

  return timingSafeEqual(new Uint8Array(hashA), new Uint8Array(hashB));
}

export async function constantTimeTokenMatches(
  tokens: readonly string[],
  candidate: string,
): Promise<boolean> {
  let matched = false;
  for (const token of tokens) {
    if (await timingSafeEqualString(token, candidate)) {
      matched = true;
    }
  }

  return matched;
}

export async function verifyWebhookSignature(
  secret: string,
  headerValue: string,
  body: ArrayBuffer,
): Promise<boolean> {
  if (!headerValue.startsWith("sha256=")) {
    return false;
  }
  const providedHex = headerValue.slice(7).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(providedHex)) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));

  return timingSafeEqualString(encodeHex(mac), providedHex);
}

export async function verifyOidcToken(
  issuer: string,
  audience: string,
  token: string,
): Promise<VerifiedOidcIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("malformed OIDC JWT");
  }
  const [headerSeg, payloadSeg, sigSeg] = parts as [string, string, string];
  const header = JSON.parse(decoder.decode(base64UrlDecode(headerSeg))) as {
    alg?: string;
    kid?: string;
  };
  if (header.alg !== "RS256" || !header.kid) {
    throw new Error(`unsupported OIDC JWT header (alg=${header.alg ?? ""})`);
  }

  const jwksUrl = `${issuer}/.well-known/jwks`;
  const jwksRes = await fetch(jwksUrl);
  if (!jwksRes.ok) {
    throw new Error(
      `OIDC JWKS request to ${jwksUrl} failed with status ${jwksRes.status}`,
    );
  }
  const { keys } = await jwksRes.json<{
    keys: (JsonWebKey & { kid?: string })[];
  }>();
  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    throw new Error(`no OIDC JWK found for kid '${header.kid}'`);
  }

  const verifyKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    verifyKey,
    base64UrlDecode(sigSeg),
    encoder.encode(`${headerSeg}.${payloadSeg}`),
  );
  if (!valid) {
    throw new Error("OIDC JWT signature validation failed");
  }

  const claims = JSON.parse(decoder.decode(base64UrlDecode(payloadSeg))) as {
    iss: string;
    aud: string | string[];
    exp: number;
    repository_owner_id: string;
    repository: string;
    ref: string;
    event_name: string;
  };

  if (claims.iss !== issuer) {
    throw new Error(`unexpected OIDC issuer '${claims.iss}'`);
  }
  const audMatches = Array.isArray(claims.aud)
    ? claims.aud.includes(audience)
    : claims.aud === audience;
  if (!audMatches) {
    throw new Error("OIDC JWT audience mismatch");
  }
  if (typeof claims.exp !== "number" || claims.exp <= unixNow() - 60) {
    throw new Error("OIDC JWT has expired");
  }

  const ownerId = Number.parseInt(claims.repository_owner_id, 10);
  if (
    !Number.isSafeInteger(ownerId) ||
    String(ownerId) !== claims.repository_owner_id
  ) {
    throw new Error(
      `invalid repository_owner_id '${claims.repository_owner_id}'`,
    );
  }
  const repoParts = claims.repository.split("/");
  if (repoParts.length !== 2 || !repoParts[1]) {
    throw new Error(`invalid OIDC repository claim '${claims.repository}'`);
  }
  const prMatch = /^refs\/pull\/(\d+)\/merge$/.exec(claims.ref);

  return {
    ownerId,
    repoName: repoParts[1],
    ref: claims.ref,
    eventName: claims.event_name,
    prNumber: prMatch?.[1] ? Number.parseInt(prMatch[1], 10) : null,
  };
}

const isDownloadThresholdRejection = (status: number, body: string): boolean =>
  (status === 400 || status === 403 || status === 422) &&
  /5,?000|public package/i.test(body);

const githubApiRequest = (
  method: string,
  url: string,
  bearer: string,
): Promise<Response> =>
  fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${bearer}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "firn",
    },
  });

function getAppSigningKey(app: LoadedGitHubApp): Promise<CryptoKey> {
  let key = appSigningKeys.get(app);
  if (!key) {
    key = crypto.subtle.importKey(
      "pkcs8",
      pemToPkcs8Der(app.privateKeyPem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    appSigningKeys.set(app, key);
  }

  return key;
}

export async function mintInstallationToken(
  app: LoadedGitHubApp,
  apiUrl: string,
  installationId: number,
): Promise<string> {
  const now = unixNow();
  const signingInput = [
    { alg: "RS256", typ: "JWT" },
    { iat: now - 60, exp: now + 540, iss: String(app.appId) },
  ]
    .map((part) => base64UrlEncode(encoder.encode(JSON.stringify(part))))
    .join(".");
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      await getAppSigningKey(app),
      encoder.encode(signingInput),
    ),
  );

  const url = `${stripTrailingSlash(apiUrl)}/app/installations/${installationId}/access_tokens`;
  const response = await githubApiRequest(
    "POST",
    url,
    `${signingInput}.${base64UrlEncode(sig)}`,
  );
  if (!response.ok) {
    throw new Error(
      `GitHub installation token request for installation ${installationId} failed (${response.status}): ${await readBody(response)}`,
    );
  }

  return (await response.json<{ token: string }>()).token;
}

export async function exchangeInstallationGhcrToken(
  config: LoadedConfig,
  owner: LoadedOwner,
  oci: OciClient,
  repository: string,
  scopeAction: "pull" | "pull,push",
): Promise<string> {
  if (!config.githubApp) {
    throw new GhcrAuthUnavailableError(
      "GitHub App is not configured for GHCR token exchange",
    );
  }
  if (owner.githubInstallationId === null) {
    throw new GhcrAuthUnavailableError(
      `owner '${owner.name}' has no github_installation_id configured`,
    );
  }

  const installToken = await mintInstallationToken(
    config.githubApp,
    config.githubApiUrl,
    owner.githubInstallationId,
  );

  return oci.exchangeToken(repository, scopeAction, [
    "x-access-token",
    installToken,
  ]);
}

export async function acquirePullToken(
  config: LoadedConfig,
  owner: LoadedOwner | undefined,
  oci: OciClient,
  repository: string,
): Promise<string> {
  try {
    return await oci.exchangeToken(repository, "pull");
  } catch (error) {
    if (
      !(error instanceof OciHttpError) ||
      (error.status !== 401 && error.status !== 403) ||
      !owner ||
      !config.githubApp ||
      owner.githubInstallationId === null
    ) {
      throw error;
    }

    return exchangeInstallationGhcrToken(
      config,
      owner,
      oci,
      repository,
      "pull",
    );
  }
}

async function classifyDelete(
  response: Response,
  targetLabel: string,
): Promise<{ outcome?: DeleteOutcome; body: string }> {
  if (response.ok) {
    return { outcome: { kind: "deleted" }, body: "" };
  }
  const body = await readBody(response);
  if (response.status === 404) {
    return { outcome: { kind: "not_found", reason: body }, body };
  }
  if (isDownloadThresholdRejection(response.status, body)) {
    return { outcome: { kind: "blocked", reason: body }, body };
  }
  if (response.status === 400 && body.toLowerCase().includes("last version")) {
    return { body };
  }

  throw new Error(
    `failed to delete ${targetLabel} (${response.status}): ${body}`,
  );
}

export function openGhcrPackage(
  apiUrl: string,
  owner: string,
  ownerType: OwnerType,
  token: string,
  pkg: string,
) {
  const packageUrl = `${stripTrailingSlash(apiUrl)}/${ownerType === "org" ? "orgs" : "users"}/${owner}/packages/container/${encodeURIComponent(pkg)}`;

  async function listPage(page: number) {
    const url = `${packageUrl}/versions?per_page=100&page=${page}`;
    const response = await githubApiRequest("GET", url, token);
    if (response.status === 404) {
      return { versions: [], notFound: true };
    }
    if (!response.ok) {
      throw new Error(
        `failed to list GHCR versions at ${url} (${response.status}): ${await readBody(response)}`,
      );
    }

    const items = await response.json<
      {
        id: number;
        name: string;
        created_at?: string;
        updated_at?: string;
        metadata?: { container?: { tags?: string[] } };
      }[]
    >();

    return {
      notFound: false,
      versions: items.map((item) => {
        const parsedMs = Date.parse(item.updated_at ?? item.created_at ?? "");

        return {
          id: item.id,
          name: item.name,
          updatedAt: Number.isFinite(parsedMs)
            ? Math.floor(parsedMs / 1000)
            : null,
          tags: item.metadata?.container?.tags ?? [],
        };
      }),
    };
  }

  return {
    listPage,

    async listVersions(maxPages: number, targetDigests?: ReadonlySet<string>) {
      const versions = new Map<string, number>();
      const remaining = targetDigests ? new Set(targetDigests) : null;
      let requestsUsed = 0;

      for (let page = 1; page <= maxPages; page++) {
        const result = await listPage(page);
        requestsUsed += 1;
        if (result.notFound) {
          return { versions, requestsUsed, complete: true };
        }
        for (const item of result.versions) {
          versions.set(item.name, item.id);
          remaining?.delete(item.name);
        }
        if (result.versions.length < 100) {
          return { versions, requestsUsed, complete: true };
        }
        if (remaining?.size === 0) {
          return { versions, requestsUsed, complete: false };
        }
      }

      return { versions, requestsUsed, complete: false };
    },

    async exists(versionId: number): Promise<boolean> {
      const response = await githubApiRequest(
        "GET",
        `${packageUrl}/versions/${versionId}`,
        token,
      );
      if (response.status === 404) {
        return false;
      }
      if (response.ok) {
        return true;
      }

      throw new Error(
        `failed to check GHCR version ${versionId} for ${owner}/${pkg} (${response.status}): ${await readBody(response)}`,
      );
    },

    async deleteVersion(
      versionId: number,
      manifestDigest: string,
    ): Promise<{ outcome: DeleteOutcome; requestsUsed: number }> {
      const first = await classifyDelete(
        await githubApiRequest(
          "DELETE",
          `${packageUrl}/versions/${versionId}`,
          token,
        ),
        `GHCR version ${versionId} (${manifestDigest}) for ${owner}/${pkg}`,
      );
      if (first.outcome) {
        return { outcome: first.outcome, requestsUsed: 1 };
      }

      log.info(
        "last GHCR version cannot be deleted individually; deleting empty package",
        { owner, package: pkg, manifest: manifestDigest },
      );

      const pkgDelete = await classifyDelete(
        await githubApiRequest("DELETE", packageUrl, token),
        `GHCR package ${packageUrl}`,
      );
      if (!pkgDelete.outcome) {
        throw new Error(
          `failed to delete GHCR package ${packageUrl}: ${pkgDelete.body}`,
        );
      }

      return { outcome: pkgDelete.outcome, requestsUsed: 2 };
    },
  };
}
