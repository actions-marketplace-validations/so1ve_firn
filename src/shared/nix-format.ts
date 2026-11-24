const NIX_BASE32_ALPHABET = "0123456789abcdfghijklmnpqrsvwxyz";
const NIX_BASE32_RE = /^[0-9a-df-np-sv-z]+$/;
const STORE_PREFIX = "/nix/store/";
const encoder = new TextEncoder();

// RFC 8410 PKCS#8 PrivateKeyInfo prefix for a 32-byte Ed25519 seed.
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);

export const CACHE_PRIORITY = 41;

export interface NarInfo {
  storePath: string;
  url: string;
  fileHash: string;
  fileSize: number;
  narHash: string;
  narSize: number;
  references: string[];
  deriver: string | null;
  sig: string;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }

  return out;
}

function validateKeyName(name: string): void {
  if (!name || name.includes(":") || /\s/.test(name)) {
    throw new Error(`invalid Nix key name '${name}'`);
  }
}

export const unixNow = (): number => Math.floor(Date.now() / 1000);

export function encodeHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }

  return out;
}

function encodeNixBase32(bytes: Uint8Array): string {
  const outLen = Math.floor((bytes.length * 8 - 1) / 5) + 1;
  let out = "";
  for (let n = outLen - 1; n >= 0; n--) {
    const bitPos = n * 5;
    const byteIdx = bitPos >> 3;
    const bitOffset = bitPos & 7;
    let chunk = (bytes[byteIdx] >> bitOffset) & 0x1f;
    if (bitOffset > 3 && byteIdx + 1 < bytes.length) {
      chunk |= (bytes[byteIdx + 1] << (8 - bitOffset)) & 0x1f;
    }
    out += NIX_BASE32_ALPHABET[chunk];
  }

  return out;
}

export function formatSha256NixBase32(digest: Uint8Array): string {
  if (digest.length !== 32) {
    throw new Error(`expected 32-byte SHA-256 digest, got ${digest.length}`);
  }

  return `sha256:${encodeNixBase32(digest)}`;
}

export function validateSha256Hex(value: string): void {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`invalid SHA-256 hex digest '${value}'`);
  }
}

export function validateSha256NixBase32(value: string): void {
  if (
    !value.startsWith("sha256:") ||
    value.length !== 59 ||
    !NIX_BASE32_RE.test(value.slice(7))
  ) {
    throw new Error(`invalid sha256 nixbase32 digest '${value}'`);
  }
}

export function validateStoreHash(hash: string): void {
  if (hash.length !== 32 || !NIX_BASE32_RE.test(hash)) {
    throw new Error(`invalid Nix store hash '${hash}'`);
  }
}

export function storePathBasename(storePath: string): string {
  if (!storePath.startsWith(STORE_PREFIX)) {
    throw new Error(
      `store path must start with ${STORE_PREFIX}: '${storePath}'`,
    );
  }
  const rest = storePath.slice(STORE_PREFIX.length);
  if (rest.length <= 33 || rest.includes("/") || rest[32] !== "-") {
    throw new Error(`invalid Nix store path '${storePath}'`);
  }
  validateStoreHash(rest.slice(0, 32));

  return rest;
}

export const storeHashFromPath = (storePath: string): string =>
  storePathBasename(storePath).slice(0, 32);

export function normalizeReferences(references: readonly string[]): string[] {
  const normalized = references.map((ref) =>
    storePathBasename(
      ref.startsWith(STORE_PREFIX) ? ref : `${STORE_PREFIX}${ref}`,
    ),
  );

  return [...new Set(normalized.sort())];
}

export function fingerprint(
  storePath: string,
  narHash: string,
  narSize: number,
  references: readonly string[],
): string {
  const fullRefs = references.map((ref) =>
    ref.startsWith(STORE_PREFIX) ? ref : `${STORE_PREFIX}${ref}`,
  );

  return `1;${storePath};${narHash};${narSize};${fullRefs.join(",")}`;
}

export const renderNixCacheInfo = (priority: number = CACHE_PRIORITY): string =>
  `StoreDir: /nix/store\nWantMassQuery: 1\nPriority: ${priority}\n`;

export function renderNarInfo(info: NarInfo): string {
  const lines = [
    `StorePath: ${info.storePath}`,
    `URL: ${info.url}`,
    "Compression: zstd",
    `FileHash: ${info.fileHash}`,
    `FileSize: ${info.fileSize}`,
    `NarHash: ${info.narHash}`,
    `NarSize: ${info.narSize}`,
    `References: ${info.references.join(" ")}`,
    ...(info.deriver ? [`Deriver: ${info.deriver}`] : []),
    `Sig: ${info.sig}`,
  ];

  return `${lines.join("\n")}\n`;
}

export class SigningKeyPair {
  public readonly name: string;
  readonly #privateKey: CryptoKey;
  readonly #seed: Uint8Array;
  readonly #publicBytes: Uint8Array;

  private constructor(
    name: string,
    privateKey: CryptoKey,
    seed: Uint8Array,
    publicBytes: Uint8Array,
  ) {
    this.name = name;
    this.#privateKey = privateKey;
    this.#seed = seed;
    this.#publicBytes = publicBytes;
  }

  public static async generate(name: string): Promise<SigningKeyPair> {
    validateKeyName(name);
    const pair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(
      (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
    );
    const publicBytes = new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    );

    return new SigningKeyPair(
      name,
      pair.privateKey,
      pkcs8.slice(-32),
      publicBytes,
    );
  }

  public static async parseSecret(raw: string): Promise<SigningKeyPair> {
    const trimmed = raw.trim();
    const sep = trimmed.indexOf(":");
    if (sep === -1) {
      throw new Error("invalid Nix secret key: missing ':' separator");
    }
    const name = trimmed.slice(0, sep);
    validateKeyName(name);

    const bytes = base64ToBytes(trimmed.slice(sep + 1));
    if (bytes.length !== 64) {
      throw new Error(
        `invalid Nix secret key length: expected 64 bytes, got ${bytes.length}`,
      );
    }

    const seed = bytes.slice(0, 32);
    const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
    pkcs8.set(ED25519_PKCS8_PREFIX, 0);
    pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);

    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      "Ed25519",
      false,
      ["sign"],
    );

    return new SigningKeyPair(name, privateKey, seed, bytes.slice(32, 64));
  }

  public secretString(): string {
    const combined = new Uint8Array(64);
    combined.set(this.#seed, 0);
    combined.set(this.#publicBytes, 32);

    return `${this.name}:${bytesToBase64(combined)}`;
  }

  public publicString(): string {
    return `${this.name}:${bytesToBase64(this.#publicBytes)}`;
  }

  public async signFingerprint(fp: string): Promise<string> {
    const sig = new Uint8Array(
      await crypto.subtle.sign("Ed25519", this.#privateKey, encoder.encode(fp)),
    );

    return `${this.name}:${bytesToBase64(sig)}`;
  }
}

export async function verifySignature(
  publicKey: string,
  fp: string,
  signature: string,
): Promise<boolean> {
  const [trimmedKey, trimmedSig] = [publicKey.trim(), signature.trim()];
  const [keySep, sigSep] = [trimmedKey.indexOf(":"), trimmedSig.indexOf(":")];
  if (keySep === -1 || sigSep === -1) {
    throw new Error("invalid Nix key or signature format");
  }
  if (trimmedKey.slice(0, keySep) !== trimmedSig.slice(0, sigSep)) {
    return false;
  }

  const keyBytes = base64ToBytes(trimmedKey.slice(keySep + 1));
  const sigBytes = base64ToBytes(trimmedSig.slice(sigSep + 1));
  if (keyBytes.length !== 32 || sigBytes.length !== 64) {
    return false;
  }

  const key = await crypto.subtle.importKey("raw", keyBytes, "Ed25519", false, [
    "verify",
  ]);

  return crypto.subtle.verify("Ed25519", key, sigBytes, encoder.encode(fp));
}
