import type { Context } from "hono";

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
import { ghcrRepository } from "../config.ts";
import {
  MAIN_SCOPE,
  TOUCH_THROTTLE_SECONDS,
  getBlobForDownload,
  getNarInfo,
  prScope,
  touchAccessedThrottled,
} from "../db.ts";
import { acquirePullToken } from "../github.ts";

const textResponse = (body: string, contentType: string): Response =>
  new Response(body, { status: 200, headers: { "Content-Type": contentType } });

function resolvePrScope(c: Context<AppBindings>): string | Response {
  const owner = c.req.param("owner") ?? "";
  if (!c.get("config").ownersByName.has(owner)) {
    return c.text("unknown cache owner", 404);
  }
  const prNumber = Number.parseInt(c.req.param("number") ?? "", 10);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return c.text("invalid pull request number", 404);
  }

  return prScope(owner, c.req.param("repo") ?? "", prNumber);
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

  const db = c.get("db");
  const stored = await getNarInfo(db, scope, storeHash);
  if (!stored) {
    return c.text("narinfo not found", 404);
  }

  const now = unixNow();
  if (now - stored.lastAccessedAt >= TOUCH_THROTTLE_SECONDS) {
    c.get("waitUntil")(touchAccessedThrottled(db, stored.id, now));
  }

  return textResponse(
    renderNarInfo({
      ...stored,
      url: `nar/${stored.blobDigest}.nar.zst`,
      sig: stored.signature,
    }),
    "text/x-nix-narinfo",
  );
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

  const blob = await getBlobForDownload(c.get("db"), scope, digestHex);
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
  textResponse(renderNixCacheInfo(CACHE_PRIORITY), "text/x-nix-cache-info");

export function handlePrCacheInfo(c: Context<AppBindings>): Response {
  const owner = c.req.param("owner") ?? "";
  if (!c.get("config").ownersByName.has(owner)) {
    return c.text("unknown cache owner", 404);
  }

  return handleMainCacheInfo();
}

export const handleMainNarInfo = (c: Context<AppBindings>): Promise<Response> =>
  serveNarInfo(c, MAIN_SCOPE, c.req.param("narinfo") ?? "");

export async function handlePrNarInfo(
  c: Context<AppBindings>,
): Promise<Response> {
  const scope = resolvePrScope(c);

  return typeof scope === "string"
    ? serveNarInfo(c, scope, c.req.param("narinfo") ?? "")
    : scope;
}

export const handleMainNar = (c: Context<AppBindings>): Promise<Response> =>
  serveNar(c, MAIN_SCOPE, c.req.param("file") ?? "");

export async function handlePrNar(c: Context<AppBindings>): Promise<Response> {
  const scope = resolvePrScope(c);

  return typeof scope === "string"
    ? serveNar(c, scope, c.req.param("file") ?? "")
    : scope;
}
