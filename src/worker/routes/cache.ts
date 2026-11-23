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
import type { LoadedConfig, WorkerRuntimeEnv } from "../config.ts";
import { ghcrRepository } from "../config.ts";
import {
  MAIN_SCOPE,
  getBlobForDownload,
  getNarInfo,
  prScope,
  storedToNarInfo,
  touchAccessedThrottled,
} from "../db.ts";
import { acquirePullToken } from "../ghcr.ts";

export interface AppBindings {
  Bindings: WorkerRuntimeEnv;
  Variables: {
    config: LoadedConfig;
  };
}

const textResponse = (body: string, contentType: string): Response =>
  new Response(body, {
    status: 200,
    headers: { "Content-Type": contentType },
  });

function ensureOwnerExists(
  config: LoadedConfig,
  owner: string,
): Response | null {
  if (!config.ownersByName.has(owner)) {
    return new Response("unknown cache owner", { status: 404 });
  }

  return null;
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

  const stored = await getNarInfo(c.env.DB, scope, storeHash);
  if (!stored) {
    return c.text("narinfo not found", 404);
  }

  c.executionCtx.waitUntil(
    touchAccessedThrottled(c.env.DB, stored.id, unixNow()),
  );

  return textResponse(
    renderNarInfo(storedToNarInfo(stored)),
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

  const blob = await getBlobForDownload(c.env.DB, scope, digestHex);
  if (!blob) {
    return c.text("nar blob not found", 404);
  }

  const config = c.get("config");
  const oci = new OciClient(config.registryUrl);
  const repo = ghcrRepository(blob.ownerId, blob.ghcrPackage);
  const owner = config.ownersByName.get(blob.ownerId);
  const pullToken = await acquirePullToken(config, owner, oci, repo);
  const redirectUrl = await oci.resolveBlobRedirect(
    repo,
    blob.blobDigest,
    pullToken,
  );

  return c.redirect(redirectUrl, 302);
}

export function handlePublicKeys(c: Context<AppBindings>): Response {
  const config = c.get("config");
  const payload: PublicKeysResponse = {
    main_public_key: config.mainKey.publicString(),
    pr_public_key: config.prKey.publicString(),
  };

  return c.json(payload);
}

export const handleMainCacheInfo = (): Response =>
  textResponse(renderNixCacheInfo(CACHE_PRIORITY), "text/x-nix-cache-info");

export function handlePrCacheInfo(c: Context<AppBindings>): Response {
  const missing = ensureOwnerExists(
    c.get("config"),
    c.req.param("owner") ?? "",
  );
  if (missing) {
    return missing;
  }

  return textResponse(
    renderNixCacheInfo(CACHE_PRIORITY),
    "text/x-nix-cache-info",
  );
}

export const handleMainNarInfo = async (
  c: Context<AppBindings>,
): Promise<Response> =>
  serveNarInfo(c, MAIN_SCOPE, c.req.param("narinfo") ?? "");

export async function handlePrNarInfo(
  c: Context<AppBindings>,
): Promise<Response> {
  const owner = c.req.param("owner") ?? "";
  const missing = ensureOwnerExists(c.get("config"), owner);
  if (missing) {
    return missing;
  }
  const prNumber = Number.parseInt(c.req.param("number") ?? "", 10);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return c.text("invalid pull request number", 404);
  }

  return serveNarInfo(
    c,
    prScope(owner, c.req.param("repo") ?? "", prNumber),
    c.req.param("narinfo") ?? "",
  );
}

export const handleMainNar = async (
  c: Context<AppBindings>,
): Promise<Response> => serveNar(c, MAIN_SCOPE, c.req.param("file") ?? "");

export async function handlePrNar(c: Context<AppBindings>): Promise<Response> {
  const owner = c.req.param("owner") ?? "";
  const missing = ensureOwnerExists(c.get("config"), owner);
  if (missing) {
    return missing;
  }
  const prNumber = Number.parseInt(c.req.param("number") ?? "", 10);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return c.text("invalid pull request number", 404);
  }

  return serveNar(
    c,
    prScope(owner, c.req.param("repo") ?? "", prNumber),
    c.req.param("file") ?? "",
  );
}
