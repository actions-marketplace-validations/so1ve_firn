import type { OciClient } from "../shared/oci.ts";
import { OciHttpError } from "../shared/oci.ts";
import type { LoadedConfig, LoadedOwner } from "./config.ts";
import { createGitHubAppClient } from "./github.ts";

export class GhcrAuthUnavailableError extends Error {}

export async function exchangeInstallationGhcrToken(
  config: LoadedConfig,
  owner: LoadedOwner,
  oci: OciClient,
  repository: string,
  scopeAction: "pull" | "pull,push",
): Promise<string> {
  const app = createGitHubAppClient(config);
  if (!app) {
    throw new GhcrAuthUnavailableError(
      "GitHub App is not configured for GHCR token exchange",
    );
  }
  if (owner.githubInstallationId === null) {
    throw new GhcrAuthUnavailableError(
      `owner '${owner.name}' has no github_installation_id configured`,
    );
  }

  const installToken = await app.installationToken(owner.githubInstallationId);

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
