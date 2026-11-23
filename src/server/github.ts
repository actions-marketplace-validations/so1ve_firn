import { timingSafeEqual } from "node:crypto";

import {
  base64ToBytes,
  bytesToBase64,
  encodeHex,
  unixNow,
} from "../shared/nix-format.ts";
import type { LoadedConfig, OwnerType } from "./config.ts";

export interface OidcClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  repository_owner_id: string;
  repository: string;
  ref: string;
  event_name: string;
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

interface JwkKey extends JsonWebKey {
  kid?: string;
  alg?: string;
}

interface JwkSet {
  keys: JwkKey[];
}

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
  let rem = len;
  while (rem > 0) {
    bytes.unshift(rem & 0xff);
    rem >>= 8;
  }

  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

// Wraps a PKCS#1 RSAPrivateKey DER payload in a PKCS#8 PrivateKeyInfo envelope
// so Web Crypto `importKey("pkcs8", ...)` accepts GitHub App PEM keys directly.
function pkcs1ToPkcs8(pkcs1Der: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  // SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }
  const algorithmId = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ]);
  const octetString = concatBytes(
    new Uint8Array([0x04]),
    encodeDerLength(pkcs1Der.length),
    pkcs1Der,
  );
  const body = concatBytes(version, algorithmId, octetString);

  return concatBytes(
    new Uint8Array([0x30]),
    encodeDerLength(body.length),
    body,
  );
}

function pemToPkcs8Der(pem: string): Uint8Array {
  const trimmed = pem.trim();
  const isPkcs1 = trimmed.includes("BEGIN RSA PRIVATE KEY");
  const b64 = trimmed.replace(/-----[^-]+-----/g, "").replaceAll(/\s+/g, "");
  const binary = atob(b64);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    der[i] = binary.charCodeAt(i);
  }

  return isPkcs1 ? pkcs1ToPkcs8(der) : der;
}

export async function timingSafeEqualString(
  a: string,
  b: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
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
  const providedHex = headerValue.slice("sha256=".length).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(providedHex)) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));

  return timingSafeEqualString(encodeHex(mac), providedHex);
}

export function oidcOwnerId(claims: OidcClaims): number {
  const parsed = Number.parseInt(claims.repository_owner_id, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    String(parsed) !== claims.repository_owner_id
  ) {
    throw new Error(
      `invalid repository_owner_id '${claims.repository_owner_id}'`,
    );
  }

  return parsed;
}

export function oidcRepoName(claims: OidcClaims): string {
  const parts = claims.repository.split("/");
  if (parts.length !== 2 || !parts[1]) {
    throw new Error(`invalid OIDC repository claim '${claims.repository}'`);
  }

  return parts[1];
}

export function oidcPullRequestNumber(claims: OidcClaims): number | null {
  const match = /^refs\/pull\/(\d+)\/merge$/.exec(claims.ref);
  if (!match?.[1]) {
    return null;
  }

  return Number.parseInt(match[1], 10);
}

export async function verifyOidcToken(
  issuer: string,
  audience: string,
  token: string,
): Promise<OidcClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("malformed OIDC JWT");
  }
  const [headerSeg, payloadSeg, sigSeg] = parts as [string, string, string];
  const header = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(headerSeg)),
  ) as { alg?: string; kid?: string };

  if (header.alg !== "RS256") {
    throw new Error(`unsupported OIDC JWT algorithm '${header.alg ?? ""}'`);
  }
  if (!header.kid) {
    throw new Error("OIDC JWT header missing kid");
  }

  const jwksUrl = `${issuer}/.well-known/jwks`;
  const jwksRes = await fetch(jwksUrl);
  if (!jwksRes.ok) {
    throw new Error(
      `OIDC JWKS request to ${jwksUrl} failed with status ${jwksRes.status}`,
    );
  }
  const jwks = await jwksRes.json<JwkSet>();
  const jwk = jwks.keys.find((key) => key.kid === header.kid);
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
  const signingInput = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
  const signature = base64UrlDecode(sigSeg);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    verifyKey,
    signature,
    signingInput,
  );
  if (!valid) {
    throw new Error("OIDC JWT signature validation failed");
  }

  const claims = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(payloadSeg)),
  ) as OidcClaims;
  const now = unixNow();
  if (claims.iss !== issuer) {
    throw new Error(`unexpected OIDC issuer '${claims.iss}'`);
  }
  const audMatches = Array.isArray(claims.aud)
    ? claims.aud.includes(audience)
    : claims.aud === audience;
  if (!audMatches) {
    throw new Error("OIDC JWT audience mismatch");
  }
  if (typeof claims.exp !== "number" || claims.exp <= now - 60) {
    throw new Error("OIDC JWT has expired");
  }

  return claims;
}

const isLastVersionRejection = (status: number, body: string): boolean =>
  status === 400 && body.toLowerCase().includes("last version");

function isDownloadThresholdRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 403 && status !== 422) {
    return false;
  }
  const lower = body.toLowerCase();

  return (
    lower.includes("5000") ||
    lower.includes("5,000") ||
    lower.includes("public package")
  );
}

const githubApiRequest = async (
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

export class GitHubAppClient {
  readonly #appId: number;
  readonly #privateKeyPem: string;
  readonly #apiUrl: string;

  constructor(appId: number, privateKeyPem: string, apiUrl: string) {
    this.#appId = appId;
    this.#privateKeyPem = privateKeyPem;
    this.#apiUrl = apiUrl.replace(/\/+$/, "");
  }

  async #issueAppJwt(): Promise<string> {
    const now = unixNow();
    const header = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    );
    const payload = base64UrlEncode(
      new TextEncoder().encode(
        JSON.stringify({
          iat: now - 60,
          exp: now + 9 * 60,
          iss: String(this.#appId),
        }),
      ),
    );
    const signingInput = `${header}.${payload}`;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToPkcs8Der(this.#privateKeyPem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        new TextEncoder().encode(signingInput),
      ),
    );

    return `${signingInput}.${base64UrlEncode(sig)}`;
  }

  public async installationToken(installationId: number): Promise<string> {
    const jwt = await this.#issueAppJwt();
    const url = `${this.#apiUrl}/app/installations/${installationId}/access_tokens`;
    const response = await githubApiRequest("POST", url, jwt);
    if (!response.ok) {
      const body = await response.text().catch(() => "");

      throw new Error(
        `GitHub installation token request for installation ${installationId} failed (${response.status}): ${body}`,
      );
    }
    const data = await response.json<{ token: string }>();

    return data.token;
  }
}

export class GitHubPackagesClient {
  readonly #apiUrl: string;

  constructor(apiUrl: string) {
    this.#apiUrl = apiUrl.replace(/\/+$/, "");
  }

  #packageUrl(owner: string, ownerType: OwnerType, pkg: string): string {
    const scopeSegment = ownerType === "org" ? "orgs" : "users";

    return `${this.#apiUrl}/${scopeSegment}/${owner}/packages/container/${pkg}`;
  }

  public async listGhcrPackageVersionsPage(
    owner: string,
    ownerType: OwnerType,
    token: string,
    pkg: string,
    page: number,
  ): Promise<{ versions: GhcrPackageVersion[]; notFound: boolean }> {
    const url = `${this.#packageUrl(owner, ownerType, pkg)}/versions?per_page=100&page=${page}`;
    const response = await githubApiRequest("GET", url, token);
    if (response.status === 404) {
      return { versions: [], notFound: true };
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");

      throw new Error(
        `failed to list GHCR versions at ${url} (${response.status}): ${body}`,
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
        const ts = item.updated_at ?? item.created_at;
        const parsedMs = ts ? Date.parse(ts) : Number.NaN;

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

  public async listGhcrPackageVersions(
    owner: string,
    ownerType: OwnerType,
    token: string,
    pkg: string,
    maxPages: number,
    targetDigests?: ReadonlySet<string>,
  ): Promise<{
    versions: Map<string, number>;
    requestsUsed: number;
    complete: boolean;
  }> {
    const versions = new Map<string, number>();
    const remaining = targetDigests ? new Set(targetDigests) : null;
    let requestsUsed = 0;

    for (let page = 1; page <= maxPages; page++) {
      const result = await this.listGhcrPackageVersionsPage(
        owner,
        ownerType,
        token,
        pkg,
        page,
      );
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
  }

  public async ghcrPackageVersionExists(
    owner: string,
    ownerType: OwnerType,
    token: string,
    pkg: string,
    versionId: number,
  ): Promise<boolean> {
    const url = `${this.#packageUrl(owner, ownerType, pkg)}/versions/${versionId}`;
    const response = await githubApiRequest("GET", url, token);
    if (response.status === 404) {
      return false;
    }
    if (response.ok) {
      return true;
    }
    const body = await response.text().catch(() => "");

    throw new Error(
      `failed to check GHCR version ${versionId} for ${owner}/${pkg} (${response.status}): ${body}`,
    );
  }

  async #deletePackage(
    packageUrl: string,
    token: string,
  ): Promise<DeleteOutcome> {
    const response = await githubApiRequest("DELETE", packageUrl, token);
    if (response.status === 404) {
      const body = await response.text().catch(() => "");

      return { kind: "not_found", reason: body };
    }
    if (response.ok) {
      return { kind: "deleted" };
    }

    const body = await response.text().catch(() => "");
    if (isDownloadThresholdRejection(response.status, body)) {
      return { kind: "blocked", reason: body };
    }

    throw new Error(
      `failed to delete GHCR package ${packageUrl} (${response.status}): ${body}`,
    );
  }

  public async deleteGhcrPackageVersionById(
    owner: string,
    ownerType: OwnerType,
    token: string,
    pkg: string,
    versionId: number,
    manifestDigest: string,
  ): Promise<{ outcome: DeleteOutcome; requestsUsed: number }> {
    const packageUrl = this.#packageUrl(owner, ownerType, pkg);
    const deleteUrl = `${packageUrl}/versions/${versionId}`;
    const response = await githubApiRequest("DELETE", deleteUrl, token);
    if (response.status === 404) {
      const body = await response.text().catch(() => "");

      return { outcome: { kind: "not_found", reason: body }, requestsUsed: 1 };
    }
    if (response.ok) {
      return { outcome: { kind: "deleted" }, requestsUsed: 1 };
    }

    const body = await response.text().catch(() => "");
    if (isLastVersionRejection(response.status, body)) {
      console.log(
        JSON.stringify({
          message:
            "last GHCR version cannot be deleted individually; deleting empty package",
          owner,
          package: pkg,
          manifest: manifestDigest,
        }),
      );

      return {
        outcome: await this.#deletePackage(packageUrl, token),
        requestsUsed: 2,
      };
    }
    if (isDownloadThresholdRejection(response.status, body)) {
      return { outcome: { kind: "blocked", reason: body }, requestsUsed: 1 };
    }

    throw new Error(
      `failed to delete GHCR version ${versionId} (${manifestDigest}) for ${owner}/${pkg} (${response.status}): ${body}`,
    );
  }
}

export const createGitHubAppClient = (
  config: LoadedConfig,
): GitHubAppClient | null =>
  config.githubApp
    ? new GitHubAppClient(
        config.githubApp.appId,
        config.githubApp.privateKeyPem,
        config.githubApiUrl,
      )
    : null;
