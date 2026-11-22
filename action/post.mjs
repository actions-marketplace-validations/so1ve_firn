import fs from "node:fs";

import { PushHttpError, runPush } from "../src/cli/push.ts";
import { getInput, getState, listStoreEntries } from "./common.mjs";

async function main() {
  if (getState("should_push") !== "true") {
    return;
  }

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

  const newPaths = listStoreEntries()
    .filter((entry) => !before.has(entry))
    .map((entry) => `/nix/store/${entry}`)
    .filter((storePath) => fs.existsSync(storePath));

  if (newPaths.length === 0) {
    console.log("No new Nix store paths to push.");

    return;
  }

  const server = getInput("server").replace(/\/+$/, "");
  const owner = getInput("owner") || undefined;
  const token = getInput("token") || undefined;
  const jobs = Number.parseInt(getInput("jobs"), 10) || 4;
  const includeUpstream = getInput("include-upstream").toLowerCase() === "true";
  const githubToken =
    getInput("github-token") || process.env.GITHUB_TOKEN || "";

  if (githubToken && !process.env.GITHUB_TOKEN) {
    process.env.GITHUB_TOKEN = githubToken;
  }

  console.log(
    `Inspecting ${newPaths.length} new /nix/store entries for ${server}`,
  );
  await runPush({
    server,
    owner,
    token,
    stdin: false,
    includeUpstream,
    skipSignedBy: ["cache.nixos.org-1:"],
    jobs,
    zstdLevel: 3,
    paths: newPaths,
  });
}

try {
  await main();
} catch (error) {
  if (
    error instanceof PushHttpError &&
    error.status === 403 &&
    error.code === "unprotected-ref"
  ) {
    console.log(`::notice::Skipping Firn cache push: ${error.body}`);
    process.exit(0);
  }

  console.error(
    `::error::${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
