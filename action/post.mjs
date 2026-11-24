import fs from "node:fs";

import { PushHttpError, runPush } from "../src/cli/push.ts";
import {
  errorMessage,
  getInput,
  getState,
  listStoreEntries,
  readTrimmedLines,
} from "./common.mjs";

async function main() {
  if (getState("should_push") !== "true") {
    return;
  }

  const server = getInput("server").replace(/\/+$/, "");
  const githubToken = getInput("github-token");
  if (githubToken) {
    process.env.GITHUB_TOKEN = githubToken;
  }

  const fromInput = getInput("paths").split(/\s+/).filter(Boolean);
  const explicitPaths = [
    ...new Set([...fromInput, ...readTrimmedLines(getState("paths_file"))]),
  ].filter((storePath) => fs.existsSync(storePath));

  if (getInput("paths") && explicitPaths.length === 0) {
    console.log("No existing paths matched 'paths' input; nothing to push.");

    return;
  }

  let targetPaths;
  let excludeUnreferencedFods = false;

  if (explicitPaths.length > 0) {
    targetPaths = explicitPaths;
    console.log(
      `Inspecting ${targetPaths.length} explicit Nix store paths for ${server}`,
    );
  } else {
    const snapshotFile = getState("snapshot_file");
    if (!snapshotFile || !fs.existsSync(snapshotFile)) {
      console.log("::warning::Firn store snapshot missing; skipping push");

      return;
    }
    const before = new Set(readTrimmedLines(snapshotFile));
    targetPaths = listStoreEntries()
      .filter((entry) => !before.has(entry))
      .map((entry) => `/nix/store/${entry}`)
      .filter((storePath) => fs.existsSync(storePath));
    excludeUnreferencedFods = true;

    if (targetPaths.length === 0) {
      console.log("No new Nix store paths to push.");

      return;
    }
    console.log(
      `Inspecting ${targetPaths.length} new /nix/store entries for ${server}`,
    );
  }

  await runPush({
    server,
    owner: getInput("owner") || undefined,
    token: getInput("token") || undefined,
    stdin: false,
    includeUpstream: getInput("include-upstream").toLowerCase() === "true",
    excludeUnreferencedFods,
    skipSignedBy: ["cache.nixos.org-1:"],
    jobs: Number.parseInt(getInput("jobs"), 10) || 4,
    zstdLevel: 3,
    paths: targetPaths,
  });
}

try {
  await main();
} catch (error) {
  if (
    error instanceof PushHttpError &&
    error.status === 403 &&
    error.code === "non-main-ref"
  ) {
    console.log(`::notice::Skipping Firn cache push: ${error.body}`);
    process.exit(0);
  }
  console.error(`::error::${errorMessage(error)}`);
  process.exit(1);
}
