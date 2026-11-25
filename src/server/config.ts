import { stripTrailingSlash } from "../shared/format.ts";
import { SigningKeyPair } from "../shared/nix-format.ts";

export type OwnerType = "user" | "org";

export interface RawOwnerConfig {
  name: string;
  owner_type?: OwnerType;
  github_owner_id: number;
  github_installation_id?: number | null;
  package_template?: string;
  repo_packages?: Record<string, string>;
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
  repoPackages: Map<string, string>;
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
  githubPackagesToken: string | null;
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

const CONFIG_ENV_KEYS = [
  "PUBLIC_BASE_URL",
  "OWNERS_JSON",
  "GC_PR_TTL_DAYS",
  "GC_MAIN_LRU_DAYS",
  "GC_MAX_SUBREQUESTS",
  "GITHUB_APP_ID",
  "MAIN_SIGNING_KEY",
  "PR_SIGNING_KEY",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_PACKAGES_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "MANUAL_TOKENS_JSON",
  "ADMIN_TOKEN",
  "GHCR_REGISTRY_URL",
  "GITHUB_API_URL",
  "GITHUB_OIDC_ISSUER",
] as const;

export type ServerRuntimeEnv = Partial<
  Record<(typeof CONFIG_ENV_KEYS)[number], string>
>;

export interface LoadConfigOptions {
  defaultMaxGcSubrequests?: number;
}

const OWNER_NAME_RE = /^[\w-]+$/;
const GHCR_PACKAGE_RE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

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

function parseRepoPackages(
  ownerName: string,
  raw: Record<string, string> | undefined,
  allowedRepos: ReadonlySet<string>,
): Map<string, string> {
  const result = new Map<string, string>();
  if (raw === undefined) {
    return result;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(
      `repo_packages for owner '${ownerName}' must be an object`,
    );
  }

  for (const [repo, pkg] of Object.entries(raw)) {
    const repoName = repo.trim();
    if (!repoName) {
      throw new Error(
        `repo_packages for owner '${ownerName}' contains an empty repository name`,
      );
    }
    if (allowedRepos.size > 0 && !allowedRepos.has(repoName)) {
      throw new Error(
        `repo_packages['${repoName}'] for owner '${ownerName}' is not listed in allowed_repos`,
      );
    }
    if (typeof pkg !== "string") {
      throw new TypeError(
        `repo_packages['${repoName}'] for owner '${ownerName}' must be a string`,
      );
    }
    const normalized = pkg.trim().toLowerCase();
    if (!GHCR_PACKAGE_RE.test(normalized)) {
      throw new Error(
        `invalid GHCR package name '${pkg}' in repo_packages['${repoName}'] for owner '${ownerName}'`,
      );
    }
    result.set(repoName, normalized);
  }

  return result;
}

function parseManualTokens(raw: string | undefined): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!raw?.trim()) {
    return result;
  }
  for (const [owner, tokens] of Object.entries(
    JSON.parse(raw) as Record<string, unknown>,
  )) {
    if (!Array.isArray(tokens)) {
      throw new TypeError(`MANUAL_TOKENS_JSON['${owner}'] must be an array`);
    }
    result.set(
      owner,
      tokens.map((item) => String(item).trim()).filter(Boolean),
    );
  }

  return result;
}

export const ghcrPackageForRepo = (owner: LoadedOwner, repo: string): string =>
  owner.repoPackages.get(repo) ??
  owner.packageTemplate.replaceAll("{repo}", repo).toLowerCase();

export const ghcrRepository = (ownerName: string, pkg: string): string =>
  `${ownerName.toLowerCase()}/${pkg.toLowerCase()}`;

export const isRepoAllowed = (owner: LoadedOwner, repo: string): boolean =>
  owner.allowedRepos.size === 0 || owner.allowedRepos.has(repo);

export const isMainRef = (owner: LoadedOwner, refName: string): boolean =>
  owner.mainRefs.includes(refName);

let cachedConfig: { key: string; promise: Promise<LoadedConfig> } | null = null;

async function buildConfig(
  env: ServerRuntimeEnv,
  defaultMaxGcSubrequests: number,
): Promise<LoadedConfig> {
  const publicBaseUrl = stripTrailingSlash(env.PUBLIC_BASE_URL ?? "");
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

    const allowedRepos = new Set(raw.allowed_repos);
    const loaded: LoadedOwner = {
      name: raw.name,
      ownerType: raw.owner_type ?? "user",
      githubOwnerId: raw.github_owner_id,
      githubInstallationId: raw.github_installation_id ?? null,
      packageTemplate: raw.package_template ?? "{repo}-cache",
      repoPackages: parseRepoPackages(
        raw.name,
        raw.repo_packages,
        allowedRepos,
      ),
      manualPushPackage: (
        raw.manual_push_package ?? "manual-cache"
      ).toLowerCase(),
      mainRefs: raw.main_refs ?? ["refs/heads/main"],
      allowedRepos,
      manualTokens: manualTokensByOwner.get(raw.name) ?? [],
    };
    ownersByName.set(loaded.name, loaded);
    ownersByGithubId.set(loaded.githubOwnerId, loaded);
  }

  const appIdRaw = env.GITHUB_APP_ID?.trim();
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY?.trim();

  return {
    publicBaseUrl,
    registryUrl: stripTrailingSlash(env.GHCR_REGISTRY_URL || "https://ghcr.io"),
    githubApiUrl: stripTrailingSlash(
      env.GITHUB_API_URL || "https://api.github.com",
    ),
    oidcIssuer: stripTrailingSlash(
      env.GITHUB_OIDC_ISSUER || "https://token.actions.githubusercontent.com",
    ),
    mainKey,
    prKey,
    githubApp:
      appIdRaw && privateKeyPem
        ? { appId: parsePositiveInt(appIdRaw), privateKeyPem }
        : null,
    githubPackagesToken: env.GITHUB_PACKAGES_TOKEN?.trim() || null,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET?.trim() || null,
    gc: {
      prTtlDays: parseOptionalPositiveInt(env.GC_PR_TTL_DAYS, 3),
      mainLruDays: parseOptionalPositiveInt(env.GC_MAIN_LRU_DAYS, 15),
      maxSubrequests: parseOptionalPositiveInt(
        env.GC_MAX_SUBREQUESTS,
        defaultMaxGcSubrequests,
      ),
    },
    adminToken: env.ADMIN_TOKEN?.trim() || null,
    ownersByName,
    ownersByGithubId,
  };
}

export function loadConfig(
  env: ServerRuntimeEnv,
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const defaultMax = options.defaultMaxGcSubrequests ?? 40;
  const key = JSON.stringify([
    defaultMax,
    ...CONFIG_ENV_KEYS.map((name) => env[name]),
  ]);
  if (cachedConfig?.key === key) {
    return cachedConfig.promise;
  }
  const promise = buildConfig(env, defaultMax).catch((error: unknown) => {
    if (cachedConfig?.key === key) {
      cachedConfig = null;
    }

    throw error;
  });
  cachedConfig = { key, promise };

  return promise;
}
