import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";
import { Transform } from "node:stream";
import { promisify } from "node:util";
import { constants as zlibConstants, createZstdCompress } from "node:zlib";

import type { Logger } from "clerc";
import { createLogger } from "clerc";

import { readBody, stripTrailingSlash } from "../shared/format.ts";
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
import { formatBytes, formatDurationMs, formatStorePath } from "./format.ts";

const execFileAsync = promisify(execFile);
const COMMIT_BATCH_SIZE = 15;
const TOKEN_REFRESH_MS = 180_000;

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
  log?: Logger;
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

  return [...new Set(raw.map((item) => fs.realpathSync(item)))].sort();
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
    getBearer: createCachedToken(async () => {
      const sep = requestUrl.includes("?") ? "&" : "?";
      const res = await fetch(
        `${requestUrl}${sep}audience=${encodeURIComponent(serverUrl)}`,
        { headers: { Authorization: `Bearer ${requestToken}` } },
      );
      if (!res.ok) {
        throw new Error(
          `GitHub Actions OIDC token request failed (${res.status}): ${await readBody(res)}`,
        );
      }

      return (await res.json<{ value: string }>()).value;
    }),
    githubToken,
  };
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
    throw new PushHttpError(
      url,
      response.status,
      await readBody(response),
      response.headers.get("x-firn-error"),
    );
  }

  return await response.json();
}

export function groupByDependencyOrder(
  items: readonly NixPathInfo[],
  batchSize: number = COMMIT_BATCH_SIZE,
): NixPathInfo[][] {
  if (items.length === 0) {
    return [];
  }

  const ordered = [...items].sort((a, b) => a.path.localeCompare(b.path));
  const byHash = new Map<string, number>();
  for (const [idx, item] of ordered.entries()) {
    byHash.set(item.storeHash, idx);
  }

  // Edges point dependent -> dependency so Tarjan emits dependencies first.
  const deps: number[][] = ordered.map((item, idx) => {
    const edges: number[] = [];
    for (const ref of item.references) {
      const depIdx = byHash.get(ref.slice(0, 32));
      if (depIdx !== undefined && depIdx !== idx) {
        edges.push(depIdx);
      }
    }
    edges.sort((a, b) => a - b);

    return edges;
  });

  const n = ordered.length;
  const index = new Int32Array(n).fill(-1);
  const lowlink = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const tarjanStack: number[] = [];
  const sccs: NixPathInfo[][] = [];
  let nextIndex = 0;

  for (let start = 0; start < n; start += 1) {
    if (index[start] !== -1) {
      continue;
    }

    const frames: [number, number][] = [[start, 0]];
    index[start] = nextIndex;
    lowlink[start] = nextIndex;
    nextIndex += 1;
    tarjanStack.push(start);
    onStack[start] = 1;

    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      const v = frame[0];
      const edges = deps[v];

      if (frame[1] < edges.length) {
        const w = edges[frame[1]];
        frame[1] += 1;

        if (index[w] === -1) {
          index[w] = nextIndex;
          lowlink[w] = nextIndex;
          nextIndex += 1;
          tarjanStack.push(w);
          onStack[w] = 1;
          frames.push([w, 0]);
        } else if (onStack[w] === 1 && index[w] < lowlink[v]) {
          lowlink[v] = index[w];
        }
      } else {
        frames.pop();
        if (frames.length > 0) {
          const parent = frames.at(-1)![0];
          if (lowlink[v] < lowlink[parent]) {
            lowlink[parent] = lowlink[v];
          }
        }

        if (lowlink[v] === index[v]) {
          const component: NixPathInfo[] = [];
          while (true) {
            const w = tarjanStack.pop()!;
            onStack[w] = 0;
            component.push(ordered[w]);
            if (w === v) {
              break;
            }
          }
          component.sort((a, b) => a.path.localeCompare(b.path));
          sccs.push(component);
        }
      }
    }
  }

  // Pack SCCs into commit batches without splitting any cyclic component.
  const batches: NixPathInfo[][] = [];
  let current: NixPathInfo[] = [];
  for (const scc of sccs) {
    if (current.length > 0 && current.length + scc.length > batchSize) {
      batches.push(current);
      current = [];
    }
    current.push(...scc);
    if (current.length >= batchSize) {
      batches.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

async function uploadCompressedNar(
  oci: OciClient,
  repository: string,
  getPushToken: () => Promise<string>,
  info: NixPathInfo,
  zstdLevel: number,
) {
  const child = spawn("nix-store", ["--dump", info.path], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const compressor = createZstdCompress({
    params: { [zlibConstants.ZSTD_c_compressionLevel]: zstdLevel },
  });

  const narHasher = createHash("sha256");
  const fileHasher = createHash("sha256");
  let narSize = 0;
  let stderr = "";
  let childExited = false;

  const narMeter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      narHasher.update(chunk);
      narSize += chunk.length;
      callback(null, chunk);
    },
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.stdout.on("error", (err) => narMeter.destroy(err));
  narMeter.on("error", (err) => compressor.destroy(err));

  const childDone = new Promise<void>((resolve, reject) => {
    child.on("error", (err) => {
      childExited = true;
      narMeter.destroy(err);
      compressor.destroy(err);
      reject(err);
    });
    child.on("close", (code, signal) => {
      childExited = true;
      if (code === 0) {
        resolve();
      } else {
        const detail =
          code === null ? `killed by ${signal}` : `exited with ${code}`;
        reject(
          new Error(
            `nix-store --dump ${info.path} ${detail}: ${stderr.trim()}`,
          ),
        );
      }
    });
  });
  childDone.catch(() => {});

  child.stdout.pipe(narMeter).pipe(compressor);

  let fileSha256: Buffer | null = null;
  async function* compressedChunks(): AsyncGenerator<Uint8Array> {
    for await (const chunk of compressor as AsyncIterable<Buffer>) {
      fileHasher.update(chunk);
      yield chunk;
    }
    await childDone;
    if (narSize !== info.narSize) {
      throw new Error(
        `NAR size mismatch for ${info.path}: nix path-info reported ${info.narSize}, dump produced ${narSize}`,
      );
    }
    fileSha256 = fileHasher.digest();
  }

  try {
    const { manifestDigest, fileSize } = await oci.uploadNarStream(
      repository,
      getPushToken,
      compressedChunks(),
      () => encodeHex(fileSha256!),
    );

    return {
      narSha256: narHasher.digest(),
      narSize,
      fileSha256: fileSha256!,
      fileSize,
      manifestDigest,
    };
  } catch (error) {
    compressor.destroy();
    narMeter.destroy();
    child.stdout.destroy();
    if (!childExited) {
      child.kill();
    }
    await childDone.catch(() => {});

    throw error;
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let nextIndex = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      async () => {
        while (nextIndex < items.length) {
          const idx = nextIndex++;
          results[idx] = await fn(items[idx]);
        }
      },
    ),
  );

  return results;
}

function filterReachableFromBuiltOutputs(
  closure: readonly NixPathInfo[],
  rootPaths: ReadonlySet<string>,
): NixPathInfo[] {
  const byBasename = new Map(
    closure.map((item) => [item.path.slice(11), item]),
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
  const log = options.log ?? createLogger();
  const { theme } = log;
  const startedAt = Date.now();
  const rawPaths = await collectInputPaths(options);
  if (rawPaths.length === 0) {
    log.info("No store paths provided; nothing to push.");

    return;
  }

  const { stdout } = await execFileAsync(
    "nix",
    ["path-info", "--json", "--recursive", ...rawPaths],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const rawClosure = parseNixPathInfoJson(stdout);
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
    log.info(
      `Nothing to upload: 0 candidate paths ${theme.muted(`(${[...skipSummary, `closure=${rawClosure.length}`].join(", ")})`)}`,
    );

    return;
  }

  const serverUrl = stripTrailingSlash(options.server);
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
    log.info(
      `Nothing to upload: ${alreadyCached} already cached ${theme.muted(`(${planMeta.join(", ")})`)}`,
    );

    return;
  }

  const uploadEntry = log.step(
    `Uploading ${theme.bold(String(plan.missing.length))} store paths to ${theme.bold(plan.ghcr_repository)} ${theme.muted(`(cached=${alreadyCached}, ${planMeta.slice(0, -1).join(", ")}, jobs=${options.jobs})`)}`,
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
            { owner: options.owner, store_paths: [] } satisfies PlanRequest,
          );

          return refreshed.ghcr_token!;
        }, plan.ghcr_token);

  const byHash = new Map(candidates.map((item) => [item.storeHash, item]));
  const missingInfos = plan.missing.map((hash) => byHash.get(hash)!);
  const batches = groupByDependencyOrder(missingInfos, COMMIT_BATCH_SIZE);

  let uploadedCount = 0;
  let uploadedBytes = 0;
  let uploadedNarBytes = 0;
  let totalCommitted = 0;

  for (const [batchIdx, chunk] of batches.entries()) {
    const batchIndex = batchIdx + 1;
    const entries = await mapWithConcurrency(
      chunk,
      options.jobs,
      async (info): Promise<CommitEntry> => {
        const uploaded = await uploadCompressedNar(
          oci,
          plan.ghcr_repository,
          getPushToken,
          info,
          options.zstdLevel,
        );
        const blobDigest = encodeHex(uploaded.fileSha256);

        uploadedCount += 1;
        uploadedBytes += uploaded.fileSize;
        uploadedNarBytes += uploaded.narSize;
        uploadEntry.line(
          `[${uploadedCount}/${missingInfos.length}] ${formatStorePath(theme, info.path)} (${formatBytes(uploaded.fileSize)} / ${formatBytes(uploaded.narSize)} NAR)`,
        );

        return {
          store_path: info.path,
          nar_hash: formatSha256NixBase32(uploaded.narSha256),
          nar_size: uploaded.narSize,
          file_hash: formatSha256NixBase32(uploaded.fileSha256),
          file_size: uploaded.fileSize,
          manifest_digest: uploaded.manifestDigest,
          blob_digest: blobDigest,
          deriver: info.deriver,
          references: info.references,
        };
      },
    );

    const committed = await postJson<CommitResponse>(
      `${serverUrl}/api/v1/uploads/commit`,
      await auth.getBearer(),
      { owner: options.owner, entries } satisfies CommitRequest,
    );
    totalCommitted += committed.committed;
    if (batches.length > 1) {
      uploadEntry.line(
        `Committed batch ${batchIndex}/${batches.length} (${committed.committed} paths)`,
      );
    }
  }

  log.success(
    `Committed ${theme.bold(String(totalCommitted))} store paths ${theme.muted(`(${formatBytes(uploadedBytes)} / ${formatBytes(uploadedNarBytes)} NAR in ${formatDurationMs(Date.now() - startedAt)})`)} to ${theme.accent(serverUrl)} ${theme.muted(`(scope=${plan.scope}, owner=${plan.owner}, repo=${plan.ghcr_repository})`)}`,
  );
}
