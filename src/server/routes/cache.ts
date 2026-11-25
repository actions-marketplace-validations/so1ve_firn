import type { Context } from "hono";

import { MAIN_SCOPE, errorMessage, prScope } from "../../shared/format.ts";
import {
  CACHE_PRIORITY,
  renderNarInfo,
  renderNixCacheInfo,
  unixNow,
  validateSha256Hex,
  validateStoreHash,
} from "../../shared/nix-format.ts";
import { OciClient } from "../../shared/oci.ts";
import type { PublicKeysResponse } from "../../shared/protocol.ts";
import type { AppBindings } from "../app.ts";
import { isDatabaseOverloadedError, parsePrParams } from "../app.ts";
import { ghcrRepository } from "../config.ts";
import {
  TOUCH_THROTTLE_SECONDS,
  getBlobForDownload,
  getNarInfo,
  touchAccessedThrottled,
} from "../db.ts";
import { acquirePullToken } from "../github.ts";
import { log } from "../log.ts";

const CACHE_INFO_MAX_AGE = 3600;
const MAIN_NARINFO_MAX_AGE = 3600;
const PR_NARINFO_MAX_AGE = 300;

const textResponse = (body: string, contentType: string, maxAge: number) =>
  new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": `public, max-age=${maxAge}`,
    },
  });

function narInfoCacheKeyForUrl(rawUrl: string): Request {
  const url = new URL(rawUrl);

  return new Request(`${url.origin}${url.pathname}`, { method: "GET" });
}

function prScopeFromParams(c: Context<AppBindings>): string {
  const { owner, repo, prNumber } = parsePrParams(c, 404);

  return prScope(owner, repo, prNumber);
}

async function serveNarInfo(
  c: Context<AppBindings>,
  scope: string,
  narinfoFile: string,
): Promise<Response> {
  if (!narinfoFile.endsWith(".narinfo")) {
    return c.text("not found", 404);
  }
  const storeHash = narinfoFile.slice(0, -".narinfo".length);
  try {
    validateStoreHash(storeHash);
  } catch {
    return c.text("invalid store hash", 404);
  }

  const edgeCache = c.get("edgeCache");
  const cacheKey = edgeCache ? narInfoCacheKeyForUrl(c.req.url) : null;
  if (edgeCache && cacheKey) {
    const cached = await edgeCache.match(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const stored = await getNarInfo(c.get("readDb"), scope, storeHash);
  if (!stored) {
    return c.text("narinfo not found", 404, { "Cache-Control": "no-store" });
  }

  const now = unixNow();
  if (now - stored.lastAccessedAt >= TOUCH_THROTTLE_SECONDS) {
    c.get("waitUntil")(
      touchAccessedThrottled(c.get("db"), stored.id, now).catch(
        (error: unknown) => {
          if (!isDatabaseOverloadedError(error)) {
            log.warn("failed to update last_accessed_at", {
              id: stored.id,
              error: errorMessage(error),
            });
          }
        },
      ),
    );
  }

  const response = textResponse(
    renderNarInfo({
      ...stored,
      url: `nar/${stored.blobDigest}.nar.zst`,
      sig: stored.signature,
    }),
    "text/x-nix-narinfo",
    scope === MAIN_SCOPE ? MAIN_NARINFO_MAX_AGE : PR_NARINFO_MAX_AGE,
  );
  if (edgeCache && cacheKey) {
    c.get("waitUntil")(
      edgeCache.put(cacheKey, response.clone()).catch((error: unknown) => {
        log.warn("failed to populate edge cache", {
          path: c.req.path,
          error: errorMessage(error),
        });
      }),
    );
  }

  return response;
}

async function serveNar(
  c: Context<AppBindings>,
  scope: string,
  fileName: string,
): Promise<Response> {
  if (!fileName.endsWith(".nar.zst")) {
    return c.text("invalid nar filename", 404);
  }
  const digestHex = fileName.slice(0, -".nar.zst".length);
  try {
    validateSha256Hex(digestHex);
  } catch {
    return c.text("invalid nar digest", 404);
  }

  const blob = await getBlobForDownload(c.get("readDb"), scope, digestHex);
  if (!blob) {
    return c.text("nar blob not found", 404);
  }

  const config = c.get("config");
  const oci = new OciClient(config.registryUrl);
  const repo = ghcrRepository(blob.ownerId, blob.ghcrPackage);
  const pullToken = await acquirePullToken(
    config,
    config.ownersByName.get(blob.ownerId),
    oci,
    repo,
  );

  return c.redirect(
    await oci.resolveBlobRedirect(repo, blob.blobDigest, pullToken),
    302,
  );
}

export function handlePublicKeys(c: Context<AppBindings>): Response {
  const config = c.get("config");

  return c.json({
    main_public_key: config.mainKey.publicString(),
    pr_public_key: config.prKey.publicString(),
  } satisfies PublicKeysResponse);
}

export const handleMainCacheInfo = (): Response =>
  textResponse(
    renderNixCacheInfo(CACHE_PRIORITY),
    "text/x-nix-cache-info",
    CACHE_INFO_MAX_AGE,
  );

export function handlePrCacheInfo(c: Context<AppBindings>): Response {
  const owner = c.req.param("owner") ?? "";
  if (!c.get("config").ownersByName.has(owner)) {
    return c.text("unknown cache owner", 404);
  }

  return handleMainCacheInfo();
}

export const handleMainNarInfo = (c: Context<AppBindings>) =>
  serveNarInfo(c, MAIN_SCOPE, c.req.param("narinfo") ?? "");

export const handlePrNarInfo = (c: Context<AppBindings>) =>
  serveNarInfo(c, prScopeFromParams(c), c.req.param("narinfo") ?? "");

export const handleMainNar = (c: Context<AppBindings>) =>
  serveNar(c, MAIN_SCOPE, c.req.param("file") ?? "");

export const handlePrNar = (c: Context<AppBindings>) =>
  serveNar(c, prScopeFromParams(c), c.req.param("file") ?? "");
