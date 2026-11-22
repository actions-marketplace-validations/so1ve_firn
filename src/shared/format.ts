const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * 60;
const SECONDS_PER_DAY = 24 * 60 * 60;
const STORE_PREFIX = "/nix/store/";

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx + 1 < units.length) {
    value /= 1024;
    idx += 1;
  }

  return idx === 0 ? `${bytes} B` : `${value.toFixed(2)} ${units[idx]}`;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / SECONDS_PER_MINUTE);
  const rem = Math.round(seconds % SECONDS_PER_MINUTE);

  return `${mins}m${rem}s`;
}

export function formatAge(now: number, timestamp: number): string {
  const delta = Math.max(0, now - timestamp);
  if (delta < SECONDS_PER_MINUTE) {
    return `${delta}s ago`;
  }
  if (delta < SECONDS_PER_HOUR) {
    return `${Math.floor(delta / SECONDS_PER_MINUTE)}m ago`;
  }
  if (delta < SECONDS_PER_DAY) {
    return `${Math.floor(delta / SECONDS_PER_HOUR)}h ago`;
  }

  return `${Math.floor(delta / SECONDS_PER_DAY)}d ago`;
}

export function formatRemainingTtl(
  now: number,
  updatedAt: number,
  ttlDays: number,
): { text: string; state: "ok" | "warn" | "expired" } {
  const remaining = updatedAt + ttlDays * SECONDS_PER_DAY - now;
  if (remaining <= 0) {
    return { text: "expired", state: "expired" };
  }
  if (remaining < SECONDS_PER_HOUR) {
    return {
      text: `${Math.max(1, Math.floor(remaining / SECONDS_PER_MINUTE))}m left`,
      state: "warn",
    };
  }
  if (remaining < SECONDS_PER_DAY) {
    return {
      text: `${Math.floor(remaining / SECONDS_PER_HOUR)}h left`,
      state: "warn",
    };
  }

  return {
    text: `${Math.floor(remaining / SECONDS_PER_DAY)}d left`,
    state: "ok",
  };
}

export function splitStorePath(storePath: string): {
  hash: string;
  name: string;
} {
  const base = storePath.startsWith(STORE_PREFIX)
    ? storePath.slice(STORE_PREFIX.length)
    : storePath;
  if (base.length > 33 && base[32] === "-") {
    return { hash: base.slice(0, 32), name: base.slice(33) };
  }

  return { hash: "", name: base };
}
