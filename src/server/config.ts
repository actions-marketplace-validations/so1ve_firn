import { SigningKeyPair } from "../shared/nix-format.ts";

export type OwnerType = "user" | "org";

export interface RawOwnerConfig {
  name: string;
  owner_type?: OwnerType;
  github_owner_id: number;
  github_installation_id?: number | null;
  package_template?: string;
  manual_push_package?: string;
  main_refs?: string[];
  allowed_repos?: string[];
}

export interface LoadedOwner {
  name: string;
  ownerType: OwnerType;
  githubOwnerId: number;
  githubInstallationId: number | null;
  packageTemplate: string;
  manualPushPackage: string;
  mainRefs: string[];
  allowedRepos: Set<string>;
  manualTokens: string[];
}

export interface LoadedGitHubApp {
  appId: number;
  privateKeyPem: string;
}

export interface LoadedConfig {
  publicBaseUrl: string;
  registryUrl: string;
  githubApiUrl: string;
  oidcIssuer: string;
  mainKey: SigningKeyPair;
  prKey: SigningKeyPair;
  githubApp: LoadedGitHubApp | null;
  webhookSecret: string | null;
  gc: {
    prTtlDays: number;
    mainLruDays: number;
    maxSubrequests: number;
  };
  adminToken: string | null;
  ownersByName: Map<string, LoadedOwner>;
  ownersByGithubId: Map<number, LoadedOwner>;
}

const OWNER_NAME_RE = /^[\w-]+$/;

function parsePositiveInt(raw: string): number {
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`expected positive integer, got '${raw}'`);
  }

  return value;
}

const parseOptionalPositiveInt = (
  raw: string | undefined,
  fallback: number,
): number => (raw?.trim() ? parsePositiveInt(raw) : fallback);

function parseManualTokens(raw: string | undefined): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!raw?.trim()) {
    return result;
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const [owner, tokens] of Object.entries(parsed)) {
    if (!Array.isArray(tokens)) {
      throw new TypeError(`MANUAL_TOKENS_JSON['${owner}'] must be an array`);
    }
    result.set(
      owner,
      tokens
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0),
    );
  }

  return result;
}

export const ghcrPackageForRepo = (owner: LoadedOwner, repo: string): string =>
  owner.packageTemplate.replaceAll("{repo}", repo).toLowerCase();

export const ghcrRepository = (ownerName: string, pkg: string): string =>
  `${ownerName.toLowerCase()}/${pkg.toLowerCase()}`;

export const isRepoAllowed = (owner: LoadedOwner, repo: string): boolean =>
  owner.allowedRepos.size === 0 || owner.allowedRepos.has(repo);

export const isMainRef = (owner: LoadedOwner, refName: string): boolean =>
  owner.mainRefs.includes(refName);

export interface ServerRuntimeEnv {
  PUBLIC_BASE_URL?: string;
  OWNERS_JSON?: string;
  GC_PR_TTL_DAYS?: string;
  GC_MAIN_LRU_DAYS?: string;
  GC_MAX_SUBREQUESTS?: string;
  GITHUB_APP_ID?: string;
  MAIN_SIGNING_KEY?: string;
  PR_SIGNING_KEY?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  MANUAL_TOKENS_JSON?: string;
  ADMIN_TOKEN?: string;
  GHCR_REGISTRY_URL?: string;
  GITHUB_API_URL?: string;
  GITHUB_OIDC_ISSUER?: string;
}

export interface LoadConfigOptions {
  defaultMaxGcSubrequests?: number;
}

export async function loadConfig(
  env: ServerRuntimeEnv,
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!publicBaseUrl) {
    throw new Error("PUBLIC_BASE_URL must not be empty");
  }
  if (!env.MAIN_SIGNING_KEY?.trim()) {
    throw new Error("MAIN_SIGNING_KEY secret is required");
  }
  if (!env.PR_SIGNING_KEY?.trim()) {
    throw new Error("PR_SIGNING_KEY secret is required");
  }

  const [mainKey, prKey] = await Promise.all([
    SigningKeyPair.parseSecret(env.MAIN_SIGNING_KEY),
    SigningKeyPair.parseSecret(env.PR_SIGNING_KEY),
  ]);
  if (mainKey.publicString() === prKey.publicString()) {
    throw new Error(
      "MAIN_SIGNING_KEY and PR_SIGNING_KEY must use distinct signing keys",
    );
  }

  const rawOwners = JSON.parse(env.OWNERS_JSON || "[]") as RawOwnerConfig[];
  if (!Array.isArray(rawOwners) || rawOwners.length === 0) {
    throw new Error("OWNERS_JSON must define at least one owner entry");
  }

  const manualTokensByOwner = parseManualTokens(env.MANUAL_TOKENS_JSON);
  const ownersByName = new Map<string, LoadedOwner>();
  const ownersByGithubId = new Map<number, LoadedOwner>();

  for (const raw of rawOwners) {
    if (!raw.name || !OWNER_NAME_RE.test(raw.name)) {
      throw new Error(
        `invalid owner name '${raw.name}': only ASCII alphanumerics, '-', and '_' are allowed`,
      );
    }
    if (ownersByName.has(raw.name)) {
      throw new Error(`duplicate owner name '${raw.name}'`);
    }
    if (ownersByGithubId.has(raw.github_owner_id)) {
      throw new Error(`duplicate github_owner_id ${raw.github_owner_id}`);
    }

    const loaded: LoadedOwner = {
      name: raw.name,
      ownerType: raw.owner_type ?? "user",
      githubOwnerId: raw.github_owner_id,
      githubInstallationId: raw.github_installation_id ?? null,
      packageTemplate: raw.package_template ?? "{repo}-cache",
      manualPushPackage: (
        raw.manual_push_package ?? "manual-cache"
      ).toLowerCase(),
      mainRefs: raw.main_refs ?? ["refs/heads/main"],
      allowedRepos: new Set(raw.allowed_repos),
      manualTokens: manualTokensByOwner.get(raw.name) ?? [],
    };
    ownersByName.set(loaded.name, loaded);
    ownersByGithubId.set(loaded.githubOwnerId, loaded);
  }

  const appIdRaw = env.GITHUB_APP_ID?.trim();
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY?.trim();
  const githubApp: LoadedGitHubApp | null =
    appIdRaw && privateKeyPem
      ? {
          appId: parsePositiveInt(appIdRaw),
          privateKeyPem,
        }
      : null;

  return {
    publicBaseUrl,
    registryUrl: (env.GHCR_REGISTRY_URL || "https://ghcr.io").replace(
      /\/+$/,
      "",
    ),
    githubApiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(
      /\/+$/,
      "",
    ),
    oidcIssuer: (
      env.GITHUB_OIDC_ISSUER || "https://token.actions.githubusercontent.com"
    ).replace(/\/+$/, ""),
    mainKey,
    prKey,
    githubApp,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET?.trim() || null,
    gc: {
      prTtlDays: parseOptionalPositiveInt(env.GC_PR_TTL_DAYS, 3),
      mainLruDays: parseOptionalPositiveInt(env.GC_MAIN_LRU_DAYS, 15),
      maxSubrequests: parseOptionalPositiveInt(
        env.GC_MAX_SUBREQUESTS,
        options.defaultMaxGcSubrequests ?? 40,
      ),
    },
    adminToken: env.ADMIN_TOKEN?.trim() || null,
    ownersByName,
    ownersByGithubId,
  };
}
