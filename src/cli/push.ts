import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";
import { promisify } from "node:util";
import { constants as zlibConstants, createZstdCompress } from "node:zlib";

import {
  encodeHex,
  formatSha256NixBase32,
  normalizeReferences,
  storeHashFromPath,
} from "../shared/nix-format.ts";
import { OciClient } from "../shared/oci.ts";
import type {
  CommitEntry,
  CommitRequest,
  CommitResponse,
  PlanRequest,
  PlanResponse,
} from "../shared/protocol.ts";
import {
  err,
  formatBytes,
  formatDurationMs,
  formatStorePath,
  out,
} from "./format.ts";

const execFileAsync = promisify(execFile);
// Keep each commit batch safely below Cloudflare Workers' 50-subrequest limit
// (1 OCI token exchange + 2 GHCR verification requests per entry).
const COMMIT_BATCH_SIZE = 15;
// GitHub Actions OIDC JWTs and GHCR bearer tokens expire after 5 minutes;
// refresh ahead of expiry so large multi-batch uploads never fail mid-flight.
const TOKEN_REFRESH_MS = 3 * 60 * 1000;

export interface PushOptions {
  server: string;
  owner?: string;
  token?: string;
  stdin: boolean;
  includeUpstream: boolean;
  excludeUnreferencedFods?: boolean;
  skipSignedBy: string[];
  jobs: number;
  zstdLevel: number;
  paths: string[];
}

export interface NixPathInfo {
  path: string;
  storeHash: string;
  narSize: number;
  deriver: string | null;
  ca: string | null;
  references: string[];
  signatures: string[];
}

interface RawPathInfo {
  path?: string;
  narSize: number;
  deriver?: string | null;
  ca?: string | null;
  references?: string[];
  signatures?: string[];
}

type AuthMode =
  | { kind: "manual"; getBearer: () => Promise<string> }
  | { kind: "oidc"; getBearer: () => Promise<string>; githubToken: string };

interface DumpedNar {
  compressed: Uint8Array;
  narSha256: Uint8Array;
  narSize: number;
  fileSha256: Uint8Array;
}

export function parseNixPathInfoJson(raw: string): NixPathInfo[] {
  const parsed = JSON.parse(raw) as
    Record<string, RawPathInfo | null> | RawPathInfo[];
  const entries: [string, RawPathInfo][] = Array.isArray(parsed)
    ? parsed.map((item) => {
        if (!item.path) {
          throw new Error("path-info array item missing `path` field");
        }

        return [item.path, item];
      })
    : Object.entries(parsed).filter(
        (pair): pair is [string, RawPathInfo] => pair[1] !== null,
      );

  return entries
    .map(([storePath, item]) => ({
      path: storePath,
      storeHash: storeHashFromPath(storePath),
      narSize: item.narSize,
      deriver: item.deriver ?? null,
      ca: item.ca ?? null,
      references: normalizeReferences(item.references ?? []),
      signatures: item.signatures ?? [],
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function queryNixClosure(paths: string[]): Promise<NixPathInfo[]> {
  const { stdout } = await execFileAsync(
    "nix",
    ["path-info", "--json", "--recursive", ...paths],
    { maxBuffer: 64 * 1024 * 1024 },
  );

  return parseNixPathInfoJson(stdout);
}

async function collectInputPaths(options: PushOptions): Promise<string[]> {
  const raw = [...options.paths];

  if (options.stdin) {
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed) {
        raw.push(trimmed);
      }
    }
  }

  const resolved = raw.map((item) => fs.realpathSync(item));

  return [...new Set(resolved)].sort();
}

function createCachedToken(
  fetchToken: () => Promise<string>,
  initial?: string,
): () => Promise<string> {
  let cached = initial ?? "";
  let issuedAt = initial ? Date.now() : 0;

  return async () => {
    if (!cached || Date.now() - issuedAt >= TOKEN_REFRESH_MS) {
      cached = await fetchToken();
      issuedAt = Date.now();
    }

    return cached;
  };
}

async function requestOidcJwt(
  requestUrl: string,
  requestToken: string,
  audience: string,
): Promise<string> {
  const separator = requestUrl.includes("?") ? "&" : "?";
  const fullUrl = `${requestUrl}${separator}audience=${encodeURIComponent(audience)}`;
  const response = await fetch(fullUrl, {
    headers: { Authorization: `Bearer ${requestToken}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");

    throw new Error(
      `GitHub Actions OIDC token request failed (${response.status}): ${body}`,
    );
  }

  const data = await response.json<{ value: string }>();

  return data.value;
}

function resolveAuth(serverUrl: string, options: PushOptions): AuthMode {
  if (options.token) {
    const bearer = options.token;

    return { kind: "manual", getBearer: async () => bearer };
  }

  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error(
      "no authentication credentials found: pass --token / FIRN_TOKEN for manual push, or run in GitHub Actions with `id-token: write`",
    );
  }

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    throw new Error(
      "GITHUB_TOKEN (with packages: write) is required for GitHub Actions OIDC push",
    );
  }

  return {
    kind: "oidc",
    getBearer: createCachedToken(() =>
      requestOidcJwt(requestUrl, requestToken, serverUrl),
    ),
    githubToken,
  };
}

export class PushHttpError extends Error {
  public readonly status: number;
  public readonly body: string;
  public readonly code: string | null;

  constructor(url: string, status: number, body: string, code: string | null) {
    super(`request to ${url} failed (${status}): ${body}`);
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

async function postJson<TResp>(
  url: string,
  bearer: string,
  body: unknown,
): Promise<TResp> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");

    throw new PushHttpError(
      url,
      response.status,
      text,
      response.headers.get("x-firn-error"),
    );
  }

  return await response.json();
}

const dumpAndCompressNar = async (
  storePath: string,
  zstdLevel: number,
): Promise<DumpedNar> =>
  new Promise((resolve, reject) => {
    const child = spawn("nix-store", ["--dump", storePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const compressor = createZstdCompress({
      params: { [zlibConstants.ZSTD_c_compressionLevel]: zstdLevel },
    });

    const narHasher = createHash("sha256");
    const fileHasher = createHash("sha256");
    const chunks: Buffer[] = [];
    let narSize = 0;
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.stdout.on("data", (chunk: Buffer) => {
      narHasher.update(chunk);
      narSize += chunk.length;
    });

    compressor.on("data", (chunk: Buffer) => {
      fileHasher.update(chunk);
      chunks.push(chunk);
    });

    let childExited = false;
    let childCode: number | null = null;
    let streamDone = false;

    function finish() {
      if (!childExited || !streamDone) {
        return;
      }
      if (childCode !== 0) {
        reject(
          new Error(
            `nix-store --dump ${storePath} exited with ${childCode}: ${stderr.trim()}`,
          ),
        );

        return;
      }

      resolve({
        compressed: Buffer.concat(chunks),
        narSha256: narHasher.digest(),
        narSize,
        fileSha256: fileHasher.digest(),
      });
    }

    child.on("error", reject);
    compressor.on("error", reject);
    child.on("close", (code) => {
      childExited = true;
      childCode = code;
      finish();
    });
    compressor.on("end", () => {
      streamDone = true;
      finish();
    });

    child.stdout.pipe(compressor);
  });

async function uploadSinglePath(
  oci: OciClient,
  repository: string,
  pushToken: string,
  info: NixPathInfo,
  zstdLevel: number,
): Promise<CommitEntry> {
  const dumped = await dumpAndCompressNar(info.path, zstdLevel);
  if (dumped.narSize !== info.narSize) {
    throw new Error(
      `NAR size mismatch for ${info.path}: nix path-info reported ${info.narSize}, dump produced ${dumped.narSize}`,
    );
  }

  const blobDigest = encodeHex(dumped.fileSha256);
  const manifestDigest = await oci.uploadNarBlob(
    repository,
    pushToken,
    dumped.compressed,
    blobDigest,
  );

  return {
    store_path: info.path,
    nar_hash: formatSha256NixBase32(dumped.narSha256),
    nar_size: dumped.narSize,
    file_hash: formatSha256NixBase32(dumped.fileSha256),
    file_size: dumped.compressed.length,
    manifest_digest: manifestDigest,
    blob_digest: blobDigest,
    deriver: info.deriver,
    references: info.references,
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const current = nextIndex++;
        results[current] = await fn(items[current]);
      }
    },
  );
  await Promise.all(workers);

  return results;
}

function filterReachableFromBuiltOutputs(
  closure: readonly NixPathInfo[],
  rootPaths: ReadonlySet<string>,
): NixPathInfo[] {
  const byBasename = new Map(
    closure.map((item) => [item.path.slice("/nix/store/".length), item]),
  );
  const keep = new Set<string>();
  const queue: NixPathInfo[] = [];

  for (const item of closure) {
    if (
      rootPaths.has(item.path) &&
      item.deriver !== null &&
      !item.ca?.startsWith("fixed:")
    ) {
      keep.add(item.path);
      queue.push(item);
    }
  }

  for (const current of queue) {
    for (const ref of current.references) {
      const dep = byBasename.get(ref);
      if (dep && !keep.has(dep.path)) {
        keep.add(dep.path);
        queue.push(dep);
      }
    }
  }

  return closure.filter((item) => keep.has(item.path));
}

export async function runPush(options: PushOptions): Promise<void> {
  const startedAt = Date.now();
  const rawPaths = await collectInputPaths(options);
  if (rawPaths.length === 0) {
    console.error(`${err.dim("▸")} No store paths provided; nothing to push.`);

    return;
  }

  const rawClosure = await queryNixClosure(rawPaths);
  const closure = options.excludeUnreferencedFods
    ? filterReachableFromBuiltOutputs(rawClosure, new Set(rawPaths))
    : rawClosure;
  const skippedFods = rawClosure.length - closure.length;

  const candidates = closure.filter(
    (item) =>
      options.includeUpstream ||
      !item.signatures.some((sig) =>
        options.skipSignedBy.some((prefix) => sig.startsWith(prefix)),
      ),
  );
  const skippedUpstream = closure.length - candidates.length;
  const skipSummary = [
    skippedFods > 0 ? `fod-skipped=${skippedFods}` : "",
    skippedUpstream > 0 ? `upstream-skipped=${skippedUpstream}` : "",
  ].filter(Boolean);

  if (candidates.length === 0) {
    console.error(
      `${err.green("✓")} Nothing to upload: 0 candidate paths ${err.dim(`(${[...skipSummary, `closure=${rawClosure.length}`].join(", ")})`)}`,
    );

    return;
  }

  const serverUrl = options.server.replace(/\/+$/, "");
  const auth = resolveAuth(serverUrl, options);

  const plan = await postJson<PlanResponse>(
    `${serverUrl}/api/v1/uploads/plan`,
    await auth.getBearer(),
    {
      owner: options.owner,
      store_paths: candidates.map((item) => item.path),
    } satisfies PlanRequest,
  );

  const alreadyCached = candidates.length - plan.missing.length;
  const planMeta = [
    ...skipSummary,
    `closure=${closure.length}`,
    `scope=${plan.scope}`,
    `repo=${plan.ghcr_repository}`,
  ];

  if (plan.missing.length === 0) {
    console.error(
      `${err.green("✓")} Nothing to upload: ${alreadyCached} already cached ${err.dim(`(${planMeta.join(", ")})`)}`,
    );

    return;
  }

  console.error(
    `${err.cyan("▸")} Uploading ${err.bold(String(plan.missing.length))} store paths to ${err.bold(plan.ghcr_repository)} ${err.dim(`(cached=${alreadyCached}, ${planMeta.slice(0, -1).join(", ")}, jobs=${options.jobs})`)}`,
  );

  const oci = new OciClient(plan.registry);
  const getPushToken =
    auth.kind === "oidc"
      ? createCachedToken(() =>
          oci.exchangeToken(plan.ghcr_repository, "pull,push", [
            "x-access-token",
            auth.githubToken,
          ]),
        )
      : createCachedToken(async () => {
          const refreshed = await postJson<PlanResponse>(
            `${serverUrl}/api/v1/uploads/plan`,
            await auth.getBearer(),
            {
              owner: options.owner,
              store_paths: [],
            } satisfies PlanRequest,
          );

          return refreshed.ghcr_token!;
        }, plan.ghcr_token);

  const byHash = new Map(candidates.map((item) => [item.storeHash, item]));
  const missingInfos = plan.missing.map((hash) => byHash.get(hash)!);

  let uploadedCount = 0;
  let uploadedBytes = 0;
  let uploadedNarBytes = 0;
  let totalCommitted = 0;
  const totalBatches = Math.ceil(missingInfos.length / COMMIT_BATCH_SIZE);

  for (let i = 0; i < missingInfos.length; i += COMMIT_BATCH_SIZE) {
    const batchIndex = Math.floor(i / COMMIT_BATCH_SIZE) + 1;
    const chunk = missingInfos.slice(i, i + COMMIT_BATCH_SIZE);
    const pushToken = await getPushToken();
    const entries = await mapWithConcurrency(
      chunk,
      options.jobs,
      async (info) => {
        const entry = await uploadSinglePath(
          oci,
          plan.ghcr_repository,
          pushToken,
          info,
          options.zstdLevel,
        );
        uploadedCount += 1;
        uploadedBytes += entry.file_size;
        uploadedNarBytes += entry.nar_size;
        console.error(
          `  ${err.dim(`[${uploadedCount}/${missingInfos.length}]`)} ${formatStorePath(info.path, err)} ${err.dim(`(${formatBytes(entry.file_size)} / ${formatBytes(entry.nar_size)} NAR)`)}`,
        );

        return entry;
      },
    );

    const committed = await postJson<CommitResponse>(
      `${serverUrl}/api/v1/uploads/commit`,
      await auth.getBearer(),
      {
        owner: options.owner,
        entries,
      } satisfies CommitRequest,
    );
    totalCommitted += committed.committed;
    if (totalBatches > 1) {
      console.error(
        `  ${err.dim(`↳ Committed batch ${batchIndex}/${totalBatches} (${committed.committed} paths)`)}`,
      );
    }
  }

  console.log(
    `${out.boldGreen("✓")} Committed ${out.bold(String(totalCommitted))} store paths ${out.dim(`(${formatBytes(uploadedBytes)} / ${formatBytes(uploadedNarBytes)} NAR in ${formatDurationMs(Date.now() - startedAt)})`)} to ${out.cyan(serverUrl)} ${out.dim(`(scope=${plan.scope}, owner=${plan.owner}, repo=${plan.ghcr_repository})`)}`,
  );
}
