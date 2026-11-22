import fs from "node:fs";

import { PushHttpError, runPush } from "../src/cli/push.ts";
import { getInput, getState, listStoreEntries } from "./common.mjs";

function readExplicitPaths() {
  const fromInput = getInput("paths")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const pathsFile = getState("paths_file");
  const fromFile =
    pathsFile && fs.existsSync(pathsFile)
      ? fs
          .readFileSync(pathsFile, "utf8")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : [];

  return [...new Set([...fromInput, ...fromFile])].filter((storePath) =>
    fs.existsSync(storePath),
  );
}

async function main() {
  if (getState("should_push") !== "true") {
    return;
  }

  const server = getInput("server").replace(/\/+$/, "");
  const owner = getInput("owner") || undefined;
  const token = getInput("token") || undefined;
  const jobs = Number.parseInt(getInput("jobs"), 10) || 4;
  const includeUpstream = getInput("include-upstream").toLowerCase() === "true";
  const githubToken = getInput("github-token");
  if (githubToken) {
    process.env.GITHUB_TOKEN = githubToken;
  }

  const explicitPaths = readExplicitPaths();
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

    const before = new Set(
      fs
        .readFileSync(snapshotFile, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );

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
    owner,
    token,
    stdin: false,
    includeUpstream,
    excludeUnreferencedFods,
    skipSignedBy: ["cache.nixos.org-1:"],
    jobs,
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

  console.error(
    `::error::${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
