import fs from "node:fs";
import os from "node:os";

export { errorMessage } from "../src/shared/format.ts";

const STORE_DIR = "/nix/store";
const STORE_ENTRY_RE = /^[0-9a-df-np-sv-z]{32}-/;

export interface PullRequestEventPayload {
  pull_request?: {
    number?: number;
    head?: {
      repo?: {
        full_name?: string;
      };
    };
  };
}

export const getInput = (name: string): string =>
  (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();

export const getState = (name: string): string =>
  (process.env[`STATE_${name}`] ?? "").trim();

function appendEnvFile(
  filePath: string | undefined,
  name: string,
  value: string,
): void {
  if (!filePath) {
    return;
  }
  const delimiter = `FIRN_EOF_${process.pid}_${Math.random().toString(16).slice(2)}`;
  fs.appendFileSync(
    filePath,
    `${name}<<${delimiter}\n${value}\n${delimiter}\n`,
  );
}

export const saveState = (name: string, value: string): void =>
  appendEnvFile(process.env.GITHUB_STATE, name, value);

export const exportEnv = (name: string, value: string): void =>
  appendEnvFile(process.env.GITHUB_ENV, name, value);

export const tempDir = (): string => process.env.RUNNER_TEMP || os.tmpdir();

export function readTrimmedLines(filePath: string): string[] {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }

  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function listStoreEntries(): string[] {
  if (!fs.existsSync(STORE_DIR)) {
    return [];
  }

  return fs
    .readdirSync(STORE_DIR)
    .filter(
      (name) =>
        STORE_ENTRY_RE.test(name) &&
        !/\.(?:drv(?:\.chroot)?|lock|check)$/.test(name),
    )
    .sort();
}

export function readEventPayload(): PullRequestEventPayload {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    return {};
  }
  try {
    return JSON.parse(
      fs.readFileSync(eventPath, "utf8"),
    ) as PullRequestEventPayload;
  } catch {
    return {};
  }
}
