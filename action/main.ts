import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  errorMessage,
  exportEnv,
  getInput,
  listStoreEntries,
  readEventPayload,
  saveState,
  tempDir,
} from "./common.ts";

async function resolvePublicKeys(
  server: string,
  mainKeyInput: string,
  prKeyInput: string,
): Promise<{ mainKey: string; prKey: string }> {
  if (mainKeyInput && prKeyInput) {
    return { mainKey: mainKeyInput, prKey: prKeyInput };
  }
  const url = `${server}/api/v1/public-keys`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.log(
        `::warning::Failed to fetch public keys from ${url} (${response.status})`,
      );

      return { mainKey: mainKeyInput, prKey: prKeyInput };
    }
    const data = await response.json<{
      main_public_key?: string;
      pr_public_key?: string;
    }>();

    return {
      mainKey: mainKeyInput || (data.main_public_key ?? "").trim(),
      prKey: prKeyInput || (data.pr_public_key ?? "").trim(),
    };
  } catch (error) {
    console.log(
      `::warning::Failed to fetch public keys from ${url}: ${errorMessage(error)}`,
    );

    return { mainKey: mainKeyInput, prKey: prKeyInput };
  }
}

function configureNix(
  server: string,
  mainKey: string,
  prKey: string,
  options: { isPr: boolean; prNumber: number | null; isForkPr: boolean },
): void {
  const { isPr, prNumber, isForkPr } = options;
  const usePrOverlay =
    isPr &&
    prNumber !== null &&
    Boolean(prKey) &&
    !isForkPr &&
    Boolean(process.env.GITHUB_REPOSITORY);
  const substituter = usePrOverlay
    ? `${server}/pr/${process.env.GITHUB_REPOSITORY}/${prNumber}`
    : server;
  const keys = (usePrOverlay ? [mainKey, prKey] : [mainKey]).filter(Boolean);
  if (keys.length === 0) {
    return;
  }

  const configHome =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const nixConfPath = path.join(configHome, "nix", "nix.conf");
  fs.mkdirSync(path.dirname(nixConfPath), { recursive: true });
  fs.appendFileSync(
    nixConfPath,
    `\n# Configured by firn-action\nextra-substituters = ${substituter}\nextra-trusted-public-keys = ${keys.join(" ")}\n`,
  );
  console.log(`Configured Nix substituter: ${substituter}`);
}

function skipPush(message: string): void {
  console.log(message);
  saveState("should_push", "false");
}

async function main(): Promise<void> {
  const server = getInput("server").replace(/\/+$/, "");
  if (!server) {
    throw new Error("Input 'server' is required");
  }

  const { mainKey, prKey } = await resolvePublicKeys(
    server,
    getInput("main-public-key"),
    getInput("pr-public-key"),
  );
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  const event = readEventPayload();
  const isPr = eventName === "pull_request";
  const prNumber = isPr ? (event.pull_request?.number ?? null) : null;
  const isForkPr =
    isPr &&
    Boolean(event.pull_request?.head?.repo?.full_name) &&
    event.pull_request?.head?.repo?.full_name !== process.env.GITHUB_REPOSITORY;

  configureNix(server, mainKey, prKey, { isPr, prNumber, isForkPr });

  if (getInput("push").toLowerCase() === "false") {
    skipPush("Cache push disabled by input 'push: false'");

    return;
  }
  if (eventName === "pull_request_target") {
    skipPush("::notice::Skipping Firn cache push on pull_request_target");

    return;
  }
  if (isForkPr) {
    skipPush("::notice::Skipping Firn cache push for fork pull request");

    return;
  }
  const hasOidc =
    Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL) &&
    Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  if (!getInput("token") && !hasOidc) {
    skipPush(
      "::warning::Skipping Firn cache push: neither 'token' nor GitHub Actions OIDC (permissions: id-token: write) is available",
    );

    return;
  }

  const pathsFile =
    getInput("paths-file") ||
    path.join(tempDir(), `firn-paths-${process.pid}.txt`);
  fs.mkdirSync(path.dirname(pathsFile), { recursive: true });
  if (!fs.existsSync(pathsFile)) {
    fs.writeFileSync(pathsFile, "");
  }
  exportEnv("FIRN_PATHS_FILE", pathsFile);
  saveState("paths_file", pathsFile);

  if (!getInput("paths")) {
    const snapshotFile = path.join(
      tempDir(),
      `firn-store-before-${process.pid}.txt`,
    );
    const before = listStoreEntries();
    fs.writeFileSync(snapshotFile, `${before.join("\n")}\n`);
    console.log(`Snapshotted ${before.length} existing /nix/store entries`);
    saveState("snapshot_file", snapshotFile);
  }

  saveState("should_push", "true");
}

main().catch((error: unknown) => {
  console.error(`::error::${errorMessage(error)}`);
  process.exit(1);
});
