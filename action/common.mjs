import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE_DIR = "/nix/store";
const STORE_ENTRY_RE = /^[0-9a-df-np-sv-z]{32}-/;

export function getInput(name) {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
}

export function getState(name) {
  return (process.env[`STATE_${name}`] ?? "").trim();
}

export function saveState(name, value) {
  const stateFile = process.env.GITHUB_STATE;
  if (!stateFile) {
    return;
  }
  const delimiter = `FIRN_EOF_${process.pid}_${Math.random().toString(16).slice(2)}`;
  fs.appendFileSync(stateFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export function addPath(dir) {
  const pathFile = process.env.GITHUB_PATH;
  if (pathFile) {
    fs.appendFileSync(pathFile, `${dir}\n`);
  }
}

export function tempDir() {
  return process.env.RUNNER_TEMP || os.tmpdir();
}

export function listStoreEntries() {
  if (!fs.existsSync(STORE_DIR)) {
    return [];
  }

  return fs
    .readdirSync(STORE_DIR)
    .filter(
      (name) =>
        STORE_ENTRY_RE.test(name) &&
        !name.endsWith(".drv") &&
        !name.endsWith(".drv.chroot") &&
        !name.endsWith(".lock") &&
        !name.endsWith(".check"),
    )
    .sort();
}

export function readEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(eventPath, "utf8"));
  } catch {
    return {};
  }
}
