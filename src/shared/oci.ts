import { readBody, stripTrailingSlash } from "./format.ts";
import { encodeHex } from "./nix-format.ts";

const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const OCI_CONFIG_MEDIA_TYPE = "application/vnd.oci.empty.v1+json";
const NAR_LAYER_MEDIA_TYPE = "application/vnd.firn.nix.nar.zstd";

const encoder = new TextEncoder();
const EMPTY_CONFIG_BYTES = encoder.encode("{}");
const EMPTY_CONFIG_DIGEST =
  "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

const MAX_RETRIES = 6;
const BASE_RETRY_DELAY_MS = 200;
const MAX_RETRY_DELAY_MS = 15_000;

export const DEFAULT_UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024;

const MIN_ADAPTIVE_CHUNK_SIZE = 256 * 1024;
const MAX_UPLOAD_CHUNK_SIZE = 128 * 1024 * 1024;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_UNIT_MS: Record<string, number> = {
  m: 60_000,
  s: 1000,
  ms: 1,
  us: 0.001,
  µs: 0.001,
  ns: 0.000001,
};

export type TokenProvider = string | (() => Promise<string>);

const isRedirect = (status: number): boolean => status >= 300 && status < 400;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const resolveToken = (token: TokenProvider): Promise<string> | string =>
  typeof token === "function" ? token() : token;

function takeBytes(queue: Uint8Array[], count: number): Uint8Array {
  if (count === 0) {
    return new Uint8Array(0);
  }
  if (queue.length === 1 && queue[0].byteLength === count) {
    return queue.shift()!;
  }

  const out = new Uint8Array(count);
  let written = 0;
  while (written < count) {
    const head = queue[0];
    const needed = count - written;
    if (head.byteLength <= needed) {
      out.set(head, written);
      written += head.byteLength;
      queue.shift();
    } else {
      out.set(head.subarray(0, needed), written);
      queue[0] = head.subarray(needed);
      written += needed;
    }
  }

  return out;
}

function parseRetryDelayMs(
  response: Response,
  body: string,
  attempt: number,
): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_DELAY_MS);
    }
    const dateMs = Date.parse(header) - Date.now();
    if (Number.isFinite(dateMs) && dateMs > 0) {
      return Math.min(dateMs, MAX_RETRY_DELAY_MS);
    }
  }

  const ghcrMatch = /retry-after:\s*(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m)/i.exec(
    body,
  );
  if (ghcrMatch) {
    const ms = Math.ceil(
      Number(ghcrMatch[1]) * RETRY_UNIT_MS[ghcrMatch[2].toLowerCase()],
    );
    if (ms > 0) {
      return Math.min(ms + Math.floor(Math.random() * 150), MAX_RETRY_DELAY_MS);
    }
  }

  const exp = Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);

  return Math.min(
    exp + Math.floor(Math.random() * Math.min(exp, 500)),
    MAX_RETRY_DELAY_MS,
  );
}

class ChunkTooLargeError extends Error {}

export class OciHttpError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class OciClient {
  readonly #registryUrl: string;
  readonly #service: string;
  readonly #ensuredConfigRepos = new Map<string, Promise<void>>();

  constructor(registryUrl: string) {
    this.#registryUrl = stripTrailingSlash(registryUrl);
    this.#service = new URL(this.#registryUrl).host;
  }

  async #fetchWithRetry(
    url: string,
    init?: RequestInit | (() => Promise<RequestInit> | RequestInit),
  ): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const requestInit = typeof init === "function" ? await init() : init;
      const response = await fetch(url, requestInit);
      if (!RETRYABLE_STATUSES.has(response.status) || attempt >= MAX_RETRIES) {
        return response;
      }
      await sleep(
        parseRetryDelayMs(response, await readBody(response), attempt),
      );
    }
  }

  public async exchangeToken(
    repository: string,
    scopeAction: string,
    basicAuth?: readonly [string, string],
  ): Promise<string> {
    const params = new URLSearchParams({
      service: this.#service,
      scope: `repository:${repository}:${scopeAction}`,
    });
    const url = `${this.#registryUrl}/token?${params.toString()}`;
    const response = await this.#fetchWithRetry(url, {
      headers: basicAuth
        ? { Authorization: `Basic ${btoa(`${basicAuth[0]}:${basicAuth[1]}`)}` }
        : {},
    });
    if (!response.ok) {
      throw new OciHttpError(
        response.status,
        `OCI token exchange at ${url} failed (${response.status}): ${await readBody(response)}`,
      );
    }

    const data = await response.json<{
      token?: string;
      access_token?: string;
    }>();
    const token = data.token || data.access_token;
    if (!token) {
      throw new Error(`OCI token response from ${url} did not contain a token`);
    }

    return token;
  }

  public async verifyManifestAndBlob(
    repository: string,
    manifestDigest: string,
    blobDigestHex: string,
    expectedSize: number,
    pullToken: string,
  ): Promise<void> {
    const manifestUrl = `${this.#registryUrl}/v2/${repository}/manifests/${manifestDigest}`;
    const response = await this.#fetchWithRetry(manifestUrl, {
      headers: {
        Authorization: `Bearer ${pullToken}`,
        Accept: OCI_MANIFEST_MEDIA_TYPE,
      },
    });
    if (!response.ok) {
      throw new Error(
        `manifest ${manifestDigest} not found in ${repository} (${response.status}): ${await readBody(response)}`,
      );
    }

    const manifest = await response.json<{
      layers?: { digest: string; size: number }[];
    }>();
    const expectedLayerDigest = `sha256:${blobDigestHex.toLowerCase()}`;
    const found = (manifest.layers ?? []).some(
      (layer) =>
        layer.digest.toLowerCase() === expectedLayerDigest &&
        layer.size === expectedSize,
    );
    if (!found) {
      throw new Error(
        `manifest ${manifestDigest} in ${repository} does not reference layer ${expectedLayerDigest} of size ${expectedSize}`,
      );
    }

    if (!(await this.#blobExists(repository, pullToken, expectedLayerDigest))) {
      throw new Error(
        `blob ${expectedLayerDigest} not accessible in ${repository}`,
      );
    }
  }

  public async resolveBlobRedirect(
    repository: string,
    blobDigestHex: string,
    pullToken: string,
  ): Promise<string> {
    const blobUrl = `${this.#registryUrl}/v2/${repository}/blobs/sha256:${blobDigestHex.toLowerCase()}`;
    const response = await this.#fetchWithRetry(blobUrl, {
      headers: { Authorization: `Bearer ${pullToken}` },
      redirect: "manual",
    });

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) {
        throw new Error(
          `OCI registry returned ${response.status} without Location header for ${blobUrl}`,
        );
      }

      return new URL(location, this.#registryUrl).toString();
    }

    throw new Error(
      `expected redirect from ${blobUrl}, got status ${response.status}`,
    );
  }

  async #blobExists(
    repository: string,
    token: TokenProvider,
    digest: string,
  ): Promise<boolean> {
    const response = await this.#fetchWithRetry(
      `${this.#registryUrl}/v2/${repository}/blobs/${digest}`,
      async () => ({
        method: "HEAD",
        headers: { Authorization: `Bearer ${await resolveToken(token)}` },
        redirect: "manual",
      }),
    );
    await response.body?.cancel();

    return response.ok || isRedirect(response.status);
  }

  async #startUploadSession(
    repository: string,
    pushToken: TokenProvider,
  ): Promise<{ uploadUrl: string; minChunkSize: number }> {
    const startUrl = `${this.#registryUrl}/v2/${repository}/blobs/uploads/`;
    const start = await this.#fetchWithRetry(startUrl, async () => ({
      method: "POST",
      headers: {
        "Authorization": `Bearer ${await resolveToken(pushToken)}`,
        "Content-Length": "0",
      },
    }));
    if (start.status !== 202 && !start.ok) {
      throw new Error(
        `failed to initiate blob upload to ${startUrl} (${start.status}): ${await readBody(start)}`,
      );
    }

    const location = start.headers.get("location");
    const rawMin = Number.parseInt(
      start.headers.get("oci-chunk-min-length") ?? "",
      10,
    );
    await start.body?.cancel();
    if (!location) {
      throw new Error(`blob upload response from ${startUrl} missing Location`);
    }

    return {
      uploadUrl: new URL(location, this.#registryUrl).toString(),
      minChunkSize: Number.isFinite(rawMin) && rawMin > 0 ? rawMin : 0,
    };
  }

  async #patchChunk(
    uploadUrl: string,
    pushToken: TokenProvider,
    chunk: Uint8Array,
    offset: number,
  ): Promise<string> {
    const end = offset + chunk.byteLength - 1;
    for (let attempt = 0; ; attempt += 1) {
      const token = await resolveToken(pushToken);
      const response = await fetch(uploadUrl, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(chunk.byteLength),
          "Content-Range": `${offset}-${end}`,
        },
        body: chunk as BodyInit,
      });

      if (response.status === 202 || response.ok) {
        const nextLocation = response.headers.get("location");
        await response.body?.cancel();

        return nextLocation
          ? new URL(nextLocation, uploadUrl).toString()
          : uploadUrl;
      }

      const body = await readBody(response);
      if (
        response.status === 413 ||
        (response.status === 416 && /too large|exceeds/i.test(body))
      ) {
        throw new ChunkTooLargeError(
          `failed to upload blob chunk ${offset}-${end} to ${uploadUrl} (${response.status}): ${body}`,
        );
      }
      if (response.status === 416 && attempt > 0) {
        const status = await fetch(uploadUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        const range = status.headers.get("range") ?? "";
        const nextLocation = status.headers.get("location");
        await status.body?.cancel();
        if (status.ok || status.status === 204) {
          const rangeEnd = Number.parseInt(range.split("-").at(-1) ?? "", 10);
          if (rangeEnd === end) {
            return nextLocation
              ? new URL(nextLocation, uploadUrl).toString()
              : uploadUrl;
          }
        }
      }

      if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
        await sleep(parseRetryDelayMs(response, body, attempt));

        continue;
      }

      throw new Error(
        `failed to upload blob chunk ${offset}-${end} to ${uploadUrl} (${response.status}): ${body}`,
      );
    }
  }

  async #completeUploadSession(
    uploadUrl: string,
    pushToken: TokenProvider,
    repository: string,
    digest: string,
  ): Promise<void> {
    const finalUrl = new URL(uploadUrl);
    finalUrl.searchParams.set("digest", digest);

    const response = await this.#fetchWithRetry(
      finalUrl.toString(),
      async () => ({
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${await resolveToken(pushToken)}`,
          "Content-Length": "0",
        },
      }),
    );
    if (response.status === 201 || response.ok) {
      await response.body?.cancel();

      return;
    }

    throw new Error(
      `failed to finalize blob ${digest} in ${repository} (${response.status}): ${await readBody(response)}`,
    );
  }

  async #cancelUploadSession(
    uploadUrl: string,
    pushToken: TokenProvider,
  ): Promise<void> {
    try {
      const response = await fetch(uploadUrl, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${await resolveToken(pushToken)}` },
      });
      await response.body?.cancel();
    } catch {
      // Best-effort cleanup of abandoned upload session.
    }
  }

  async #putBlob(
    repository: string,
    pushToken: TokenProvider,
    digest: string,
    payload: Uint8Array,
  ): Promise<void> {
    if (await this.#blobExists(repository, pushToken, digest)) {
      return;
    }

    for (let attempt = 0; ; attempt += 1) {
      const { uploadUrl } = await this.#startUploadSession(
        repository,
        pushToken,
      );
      const finalUrl = new URL(uploadUrl);
      finalUrl.searchParams.set("digest", digest);

      const put = await fetch(finalUrl.toString(), {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${await resolveToken(pushToken)}`,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(payload.byteLength),
        },
        body: payload as BodyInit,
      });
      if (put.status === 201 || put.ok) {
        await put.body?.cancel();

        return;
      }

      const body = await readBody(put);
      if (RETRYABLE_STATUSES.has(put.status) && attempt < MAX_RETRIES) {
        await sleep(parseRetryDelayMs(put, body, attempt));

        continue;
      }

      throw new Error(
        `failed to upload blob ${digest} to ${repository} (${put.status}): ${body}`,
      );
    }
  }

  async #ensureEmptyConfig(
    repository: string,
    pushToken: TokenProvider,
  ): Promise<void> {
    let pending = this.#ensuredConfigRepos.get(repository);
    if (!pending) {
      pending = this.#putBlob(
        repository,
        pushToken,
        EMPTY_CONFIG_DIGEST,
        EMPTY_CONFIG_BYTES,
      ).catch((error: unknown) => {
        this.#ensuredConfigRepos.delete(repository);

        throw error;
      });
      this.#ensuredConfigRepos.set(repository, pending);
    }
    await pending;
  }

  async #putManifest(
    repository: string,
    pushToken: TokenProvider,
    lowerHex: string,
    fileSize: number,
  ): Promise<string> {
    const blobDigest = `sha256:${lowerHex}`;
    const manifestBytes = encoder.encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MANIFEST_MEDIA_TYPE,
        config: {
          mediaType: OCI_CONFIG_MEDIA_TYPE,
          digest: EMPTY_CONFIG_DIGEST,
          size: EMPTY_CONFIG_BYTES.length,
        },
        layers: [
          {
            mediaType: NAR_LAYER_MEDIA_TYPE,
            digest: blobDigest,
            size: fileSize,
          },
        ],
      }),
    );

    const manifestUrl = `${this.#registryUrl}/v2/${repository}/manifests/nar-${lowerHex.slice(0, 32)}`;
    const response = await this.#fetchWithRetry(manifestUrl, async () => ({
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${await resolveToken(pushToken)}`,
        "Content-Type": OCI_MANIFEST_MEDIA_TYPE,
      },
      body: manifestBytes,
    }));
    if (!response.ok) {
      throw new Error(
        `failed to push manifest to ${manifestUrl} (${response.status}): ${await readBody(response)}`,
      );
    }

    const digestHeader = response.headers.get("docker-content-digest");
    await response.body?.cancel();
    if (digestHeader) {
      return digestHeader;
    }

    return `sha256:${encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", manifestBytes)))}`;
  }

  public async uploadNarBlob(
    repository: string,
    pushToken: TokenProvider,
    payload: Uint8Array,
    blobDigestHex: string,
  ): Promise<string> {
    const lowerHex = blobDigestHex.toLowerCase();
    const blobDigest = `sha256:${lowerHex}`;
    await this.#ensureEmptyConfig(repository, pushToken);
    await this.#putBlob(repository, pushToken, blobDigest, payload);

    return this.#putManifest(
      repository,
      pushToken,
      lowerHex,
      payload.byteLength,
    );
  }

  async #flushPendingChunks(
    repository: string,
    pushToken: TokenProvider,
    state: {
      pending: Uint8Array[];
      pendingBytes: number;
      sessionUrl: string | null;
      effectiveChunkSize: number;
      offset: number;
    },
    flushAll: boolean,
  ): Promise<void> {
    while (
      flushAll
        ? state.pendingBytes > 0
        : state.pendingBytes >= state.effectiveChunkSize
    ) {
      if (state.sessionUrl === null) {
        const started = await this.#startUploadSession(repository, pushToken);
        state.sessionUrl = started.uploadUrl;
        if (started.minChunkSize > state.effectiveChunkSize) {
          state.effectiveChunkSize = Math.min(
            started.minChunkSize,
            MAX_UPLOAD_CHUNK_SIZE,
          );
          if (!flushAll && state.pendingBytes < state.effectiveChunkSize) {
            break;
          }
        }
      }

      const size = Math.min(state.pendingBytes, state.effectiveChunkSize);
      const chunk = takeBytes(state.pending, size);
      state.pendingBytes -= chunk.byteLength;
      try {
        state.sessionUrl = await this.#patchChunk(
          state.sessionUrl,
          pushToken,
          chunk,
          state.offset,
        );
        state.offset += chunk.byteLength;
      } catch (error) {
        if (
          error instanceof ChunkTooLargeError &&
          chunk.byteLength > MIN_ADAPTIVE_CHUNK_SIZE
        ) {
          state.effectiveChunkSize = Math.max(
            MIN_ADAPTIVE_CHUNK_SIZE,
            Math.floor(chunk.byteLength / 2),
          );
          state.pending.unshift(chunk);
          state.pendingBytes += chunk.byteLength;

          continue;
        }

        throw error;
      }
    }
  }

  public async uploadNarStream(
    repository: string,
    pushToken: TokenProvider,
    chunks: AsyncIterable<Uint8Array>,
    getDigestHex: () => string,
    chunkSize: number = DEFAULT_UPLOAD_CHUNK_SIZE,
  ): Promise<{ manifestDigest: string; fileSize: number }> {
    const state = {
      pending: [] as Uint8Array[],
      pendingBytes: 0,
      sessionUrl: null as string | null,
      effectiveChunkSize: Math.max(1, chunkSize),
      offset: 0,
    };

    try {
      for await (const piece of chunks) {
        if (piece.byteLength === 0) {
          continue;
        }
        state.pending.push(piece);
        state.pendingBytes += piece.byteLength;
        await this.#flushPendingChunks(repository, pushToken, state, false);
      }

      const lowerHex = getDigestHex().toLowerCase();
      const blobDigest = `sha256:${lowerHex}`;
      const fileSize = state.offset + state.pendingBytes;

      await this.#ensureEmptyConfig(repository, pushToken);

      if (state.sessionUrl === null) {
        const payload = takeBytes(state.pending, state.pendingBytes);
        state.pendingBytes = 0;
        await this.#putBlob(repository, pushToken, blobDigest, payload);
      } else {
        await this.#flushPendingChunks(repository, pushToken, state, true);
        await this.#completeUploadSession(
          state.sessionUrl,
          pushToken,
          repository,
          blobDigest,
        );
        state.sessionUrl = null;
      }

      const manifestDigest = await this.#putManifest(
        repository,
        pushToken,
        lowerHex,
        fileSize,
      );

      return { manifestDigest, fileSize };
    } catch (error) {
      if (state.sessionUrl !== null) {
        await this.#cancelUploadSession(state.sessionUrl, pushToken);
      }

      throw error;
    }
  }
}
