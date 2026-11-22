import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getInput,
  listStoreEntries,
  readEventPayload,
  saveState,
  tempDir,
} from "./common.mjs";

async function resolvePublicKeys(server, mainKeyInput, prKeyInput) {
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
    const data = await response.json();

    return {
      mainKey: mainKeyInput || (data.main_public_key ?? "").trim(),
      prKey: prKeyInput || (data.pr_public_key ?? "").trim(),
    };
  } catch (error) {
    console.log(
      `::warning::Failed to fetch public keys from ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );

    return { mainKey: mainKeyInput, prKey: prKeyInput };
  }
}

function configureNix(server, mainKey, prKey, { isPr, prNumber, isForkPr }) {
  if (!mainKey && !prKey) {
    return;
  }

  const usePrOverlay =
    isPr && prNumber && prKey && !isForkPr && process.env.GITHUB_REPOSITORY;
  const substituter = usePrOverlay
    ? `${server}/pr/${process.env.GITHUB_REPOSITORY}/${prNumber}`
    : server;
  const keys = usePrOverlay
    ? [mainKey, prKey].filter(Boolean)
    : [mainKey].filter(Boolean);

  if (keys.length === 0) {
    return;
  }

  const configHome =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const nixConfPath = path.join(configHome, "nix", "nix.conf");
  fs.mkdirSync(path.dirname(nixConfPath), { recursive: true });

  const block = [
    "",
    "# Configured by firn-action",
    `extra-substituters = ${substituter}`,
    `extra-trusted-public-keys = ${keys.join(" ")}`,
    "",
  ].join("\n");
  fs.appendFileSync(nixConfPath, block);
  console.log(`Configured Nix substituter: ${substituter}`);
}

async function main() {
  const server = getInput("server").replace(/\/+$/, "");
  if (!server) {
    throw new Error("Input 'server' is required");
  }

  const { mainKey, prKey } = await resolvePublicKeys(
    server,
    getInput("main-public-key"),
    getInput("pr-public-key"),
  );
  const pushEnabled = getInput("push").toLowerCase() !== "false";
  const token = getInput("token");

  const eventName = process.env.GITHUB_EVENT_NAME || "";
  const event = readEventPayload();
  const isPr = eventName === "pull_request";
  const prNumber = isPr ? event.pull_request?.number : null;
  const isForkPr =
    isPr &&
    Boolean(event.pull_request?.head?.repo?.full_name) &&
    event.pull_request.head.repo.full_name !== process.env.GITHUB_REPOSITORY;

  configureNix(server, mainKey, prKey, { isPr, prNumber, isForkPr });

  if (!pushEnabled) {
    console.log("Cache push disabled by input 'push: false'");
    saveState("should_push", "false");

    return;
  }

  if (eventName === "pull_request_target") {
    console.log("::notice::Skipping Firn cache push on pull_request_target");
    saveState("should_push", "false");

    return;
  }

  if (isForkPr) {
    console.log("::notice::Skipping Firn cache push for fork pull request");
    saveState("should_push", "false");

    return;
  }

  const hasOidc =
    Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL) &&
    Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  if (!token && !hasOidc) {
    console.log(
      "::warning::Skipping Firn cache push: neither 'token' nor GitHub Actions OIDC (permissions: id-token: write) is available",
    );
    saveState("should_push", "false");

    return;
  }

  const snapshotFile = path.join(
    tempDir(),
    `firn-store-before-${process.pid}.txt`,
  );
  const before = listStoreEntries();
  fs.writeFileSync(snapshotFile, `${before.join("\n")}\n`);
  console.log(`Snapshotted ${before.length} existing /nix/store entries`);

  saveState("should_push", "true");
  saveState("snapshot_file", snapshotFile);
}

main().catch((error) => {
  console.error(
    `::error::${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
