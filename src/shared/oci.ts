import { encodeHex } from "./nix-format.ts";

const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const OCI_CONFIG_MEDIA_TYPE = "application/vnd.oci.empty.v1+json";
const NAR_LAYER_MEDIA_TYPE = "application/vnd.firn.nix.nar.zstd";

// SHA-256 of "{}"
const EMPTY_CONFIG_BYTES = new TextEncoder().encode("{}");
const EMPTY_CONFIG_DIGEST =
  "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

const MAX_RETRIES = 6;
const BASE_RETRY_DELAY_MS = 200;
const MAX_RETRY_DELAY_MS = 15_000;

interface TokenResponse {
  token?: string;
  access_token?: string;
}

interface OciManifest {
  layers?: { digest: string; size: number }[];
}

async function sha256DigestPrefixed(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

  return `sha256:${encodeHex(hash)}`;
}

const isRetryableStatus = (status: number): boolean =>
  status === 408 ||
  status === 429 ||
  status === 500 ||
  status === 502 ||
  status === 503 ||
  status === 504;

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
    const amount = Number(ghcrMatch[1]);
    const unit = ghcrMatch[2].toLowerCase();
    const factor =
      unit === "m"
        ? 60_000
        : unit === "s"
          ? 1000
          : unit === "ms"
            ? 1
            : unit === "us" || unit === "µs"
              ? 0.001
              : 0.000001;
    const ms = Math.ceil(amount * factor);
    if (Number.isFinite(ms) && ms > 0) {
      return Math.min(ms + Math.floor(Math.random() * 150), MAX_RETRY_DELAY_MS);
    }
  }

  const exp = Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
  const jitter = Math.floor(Math.random() * Math.min(exp, 500));

  return Math.min(exp + jitter, MAX_RETRY_DELAY_MS);
}

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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
    this.#registryUrl = registryUrl.replace(/\/+$/, "");
    this.#service = new URL(this.#registryUrl).host;
  }

  async #fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, init);
      if (!isRetryableStatus(response.status) || attempt >= MAX_RETRIES) {
        return response;
      }

      const body = await response.text().catch(() => "");
      const delayMs = parseRetryDelayMs(response, body, attempt);
      await sleep(delayMs);
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
    const headers: Record<string, string> = {};
    if (basicAuth) {
      headers.Authorization = `Basic ${btoa(`${basicAuth[0]}:${basicAuth[1]}`)}`;
    }

    const response = await this.#fetchWithRetry(url, { headers });
    if (!response.ok) {
      const body = await response.text().catch(() => "");

      throw new OciHttpError(
        response.status,
        `OCI token exchange at ${url} failed (${response.status}): ${body}`,
      );
    }

    const data = await response.json<TokenResponse>();
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
      const body = await response.text().catch(() => "");

      throw new Error(
        `manifest ${manifestDigest} not found in ${repository} (${response.status}): ${body}`,
      );
    }

    const manifest = await response.json<OciManifest>();
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

    const blobUrl = `${this.#registryUrl}/v2/${repository}/blobs/${expectedLayerDigest}`;
    const head = await this.#fetchWithRetry(blobUrl, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${pullToken}` },
      redirect: "manual",
    });
    if (!head.ok && (head.status < 300 || head.status >= 400)) {
      throw new Error(
        `blob ${expectedLayerDigest} not accessible in ${repository} (${head.status})`,
      );
    }
  }

  public async resolveBlobRedirect(
    repository: string,
    blobDigestHex: string,
    pullToken: string,
  ): Promise<string> {
    const digest = `sha256:${blobDigestHex.toLowerCase()}`;
    const blobUrl = `${this.#registryUrl}/v2/${repository}/blobs/${digest}`;
    const response = await this.#fetchWithRetry(blobUrl, {
      headers: { Authorization: `Bearer ${pullToken}` },
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
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
    pushToken: string,
    digest: string,
  ): Promise<boolean> {
    const url = `${this.#registryUrl}/v2/${repository}/blobs/${digest}`;
    const response = await this.#fetchWithRetry(url, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${pushToken}` },
      redirect: "manual",
    });

    return response.ok || (response.status >= 300 && response.status < 400);
  }

  async #putBlob(
    repository: string,
    pushToken: string,
    digest: string,
    payload: Uint8Array,
  ): Promise<void> {
    if (await this.#blobExists(repository, pushToken, digest)) {
      return;
    }

    const startUrl = `${this.#registryUrl}/v2/${repository}/blobs/uploads/`;
    for (let attempt = 0; ; attempt += 1) {
      const start = await this.#fetchWithRetry(startUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${pushToken}`,
          "Content-Length": "0",
        },
      });
      if (start.status !== 202 && !start.ok) {
        const body = await start.text().catch(() => "");

        throw new Error(
          `failed to initiate blob upload to ${startUrl} (${start.status}): ${body}`,
        );
      }

      const location = start.headers.get("location");
      if (!location) {
        throw new Error(
          `blob upload response from ${startUrl} missing Location`,
        );
      }

      const uploadUrl = new URL(location, this.#registryUrl);
      uploadUrl.searchParams.set("digest", digest);

      const put = await fetch(uploadUrl.toString(), {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${pushToken}`,
          "Content-Type": "application/octet-stream",
        },
        body: payload as BodyInit,
      });
      if (put.status === 201 || put.ok) {
        return;
      }

      const body = await put.text().catch(() => "");
      if (isRetryableStatus(put.status) && attempt < MAX_RETRIES) {
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
    pushToken: string,
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

  public async uploadNarBlob(
    repository: string,
    pushToken: string,
    payload: Uint8Array,
    blobDigestHex: string,
  ): Promise<string> {
    const blobDigest = `sha256:${blobDigestHex.toLowerCase()}`;
    await this.#ensureEmptyConfig(repository, pushToken);
    await this.#putBlob(repository, pushToken, blobDigest, payload);

    const manifestBytes = new TextEncoder().encode(
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
            size: payload.length,
          },
        ],
      }),
    );

    const tag = `nar-${blobDigestHex.toLowerCase().slice(0, 32)}`;
    const manifestUrl = `${this.#registryUrl}/v2/${repository}/manifests/${tag}`;
    const response = await this.#fetchWithRetry(manifestUrl, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${pushToken}`,
        "Content-Type": OCI_MANIFEST_MEDIA_TYPE,
      },
      body: manifestBytes,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");

      throw new Error(
        `failed to push manifest to ${manifestUrl} (${response.status}): ${body}`,
      );
    }

    return (
      response.headers.get("docker-content-digest") ??
      (await sha256DigestPrefixed(manifestBytes))
    );
  }
}
