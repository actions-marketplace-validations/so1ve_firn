import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { getInput, getState, listStoreEntries } from "./common.mjs";

const CLI_ENTRY = path.resolve(import.meta.dirname, "../src/cli/index.ts");

function main() {
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
  const owner = getInput("owner");
  const token = getInput("token");
  const jobs = getInput("jobs");
  const includeUpstream = getInput("include-upstream").toLowerCase() === "true";
  const githubToken =
    getInput("github-token") || process.env.GITHUB_TOKEN || "";

  const args = [CLI_ENTRY, "push", "--server", server, "--stdin"];
  if (owner) {
    args.push("--owner", owner);
  }
  if (token) {
    args.push("--token", token);
  }
  if (jobs) {
    args.push("--jobs", jobs);
  }
  if (includeUpstream) {
    args.push("--include-upstream");
  }

  console.log(
    `Pushing ${newPaths.length} newly built Nix store paths to ${server}`,
  );
  const result = spawnSync(process.execPath, args, {
    input: `${newPaths.join("\n")}\n`,
    stdio: ["pipe", "inherit", "inherit"],
    env: {
      ...process.env,
      ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
    },
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

try {
  main();
} catch (error) {
  console.error(
    `::error::${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
