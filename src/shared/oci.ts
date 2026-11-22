import { encodeHex } from "./nix-format.ts";

const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const OCI_CONFIG_MEDIA_TYPE = "application/vnd.oci.empty.v1+json";
const NAR_LAYER_MEDIA_TYPE = "application/vnd.firn.nix.nar.zstd";

// SHA-256 of "{}"
const EMPTY_CONFIG_BYTES = new TextEncoder().encode("{}");
const EMPTY_CONFIG_DIGEST =
  "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

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

function resolveRelativeUrl(base: string, location: string): string {
  if (location.startsWith("http://") || location.startsWith("https://")) {
    return location;
  }

  return new URL(location, base).toString();
}

export class OciClient {
  readonly #registryUrl: string;
  readonly #service: string;

  constructor(registryUrl: string) {
    this.#registryUrl = registryUrl.replace(/\/+$/, "");
    this.#service = new URL(this.#registryUrl).host;
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

    const response = await fetch(url, { headers });
    if (!response.ok) {
      const body = await response.text().catch(() => "");

      throw new Error(
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
  ): Promise<void> {
    const token = await this.exchangeToken(repository, "pull");
    const manifestUrl = `${this.#registryUrl}/v2/${repository}/manifests/${manifestDigest}`;
    const response = await fetch(manifestUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
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
    const head = await fetch(blobUrl, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${token}` },
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
  ): Promise<string> {
    const token = await this.exchangeToken(repository, "pull");
    const digest = `sha256:${blobDigestHex.toLowerCase()}`;
    const blobUrl = `${this.#registryUrl}/v2/${repository}/blobs/${digest}`;
    const response = await fetch(blobUrl, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(
          `OCI registry returned ${response.status} without Location header for ${blobUrl}`,
        );
      }

      return resolveRelativeUrl(this.#registryUrl, location);
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
    const response = await fetch(url, {
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
    const start = await fetch(startUrl, {
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
      throw new Error(`blob upload response from ${startUrl} missing Location`);
    }

    const uploadUrl = new URL(resolveRelativeUrl(this.#registryUrl, location));
    uploadUrl.searchParams.set("digest", digest);

    const put = await fetch(uploadUrl.toString(), {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${pushToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: payload as BodyInit,
    });
    if (put.status !== 201 && !put.ok) {
      const body = await put.text().catch(() => "");

      throw new Error(
        `failed to upload blob ${digest} to ${repository} (${put.status}): ${body}`,
      );
    }
  }

  public async uploadNarBlob(
    repository: string,
    pushToken: string,
    payload: Uint8Array,
    blobDigestHex: string,
  ): Promise<string> {
    const blobDigest = `sha256:${blobDigestHex.toLowerCase()}`;
    await this.#putBlob(
      repository,
      pushToken,
      EMPTY_CONFIG_DIGEST,
      EMPTY_CONFIG_BYTES,
    );
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
    const response = await fetch(manifestUrl, {
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
