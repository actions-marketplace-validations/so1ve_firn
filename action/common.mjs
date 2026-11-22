import fs from "node:fs";
import os from "node:os";

const STORE_DIR = "/nix/store";
const STORE_ENTRY_RE = /^[0-9a-df-np-sv-z]{32}-/;

export const getInput = (name) =>
  (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();

export const getState = (name) => (process.env[`STATE_${name}`] ?? "").trim();

function appendEnvFile(filePath, name, value) {
  if (!filePath) {
    return;
  }
  const delimiter = `FIRN_EOF_${process.pid}_${Math.random().toString(16).slice(2)}`;
  fs.appendFileSync(
    filePath,
    `${name}<<${delimiter}\n${value}\n${delimiter}\n`,
  );
}

export const saveState = (name, value) =>
  appendEnvFile(process.env.GITHUB_STATE, name, value);

export const exportEnv = (name, value) =>
  appendEnvFile(process.env.GITHUB_ENV, name, value);

export const tempDir = () => process.env.RUNNER_TEMP || os.tmpdir();

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
