const NIX_BASE32_ALPHABET = "0123456789abcdfghijklmnpqrsvwxyz";
const STORE_PREFIX = "/nix/store/";

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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }

  return out;
}

function isNixBase32(value: string): boolean {
  for (const element of value) {
    if (!NIX_BASE32_ALPHABET.includes(element)) {
      return false;
    }
  }

  return true;
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

export function encodeNixBase32(bytes: Uint8Array): string {
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
  if (!value.startsWith("sha256:")) {
    throw new Error(`expected sha256:<nixbase32>, got '${value}'`);
  }
  const rest = value.slice("sha256:".length);
  if (rest.length !== 52 || !isNixBase32(rest)) {
    throw new Error(`invalid sha256 nixbase32 digest '${value}'`);
  }
}

export function validateStoreHash(hash: string): void {
  if (hash.length !== 32 || !isNixBase32(hash)) {
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
  const normalized = references.map((ref) => {
    const basename = ref.startsWith(STORE_PREFIX)
      ? storePathBasename(ref)
      : ref;
    if (
      basename.length <= 33 ||
      basename.includes("/") ||
      basename[32] !== "-"
    ) {
      throw new Error(`invalid store reference '${ref}'`);
    }
    validateStoreHash(basename.slice(0, 32));

    return basename;
  });

  normalized.sort();

  return [...new Set(normalized)];
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
  ];
  if (info.deriver) {
    lines.push(`Deriver: ${info.deriver}`);
  }
  lines.push(`Sig: ${info.sig}`);

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
    const seed = pkcs8.slice(-32);
    const publicBytes = new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    );

    return new SigningKeyPair(name, pair.privateKey, seed, publicBytes);
  }

  public static async parseSecret(raw: string): Promise<SigningKeyPair> {
    const trimmed = raw.trim();
    const sep = trimmed.indexOf(":");
    if (sep === -1) {
      throw new Error("invalid Nix secret key: missing ':' separator");
    }
    const name = trimmed.slice(0, sep);
    const encoded = trimmed.slice(sep + 1);
    validateKeyName(name);

    const bytes = base64ToBytes(encoded);
    if (bytes.length !== 64) {
      throw new Error(
        `invalid Nix secret key length: expected 64 bytes, got ${bytes.length}`,
      );
    }

    const seed = bytes.slice(0, 32);
    const publicBytes = bytes.slice(32, 64);

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

    // Cross-check that the public half matches the Ed25519 seed.
    const verifyKey = await crypto.subtle.importKey(
      "raw",
      publicBytes,
      "Ed25519",
      false,
      ["verify"],
    );
    const probe = new TextEncoder().encode("firn-key-check");
    const sig = await crypto.subtle.sign("Ed25519", privateKey, probe);
    const valid = await crypto.subtle.verify("Ed25519", verifyKey, sig, probe);
    if (!valid) {
      throw new Error("Nix secret key public half does not match Ed25519 seed");
    }

    return new SigningKeyPair(name, privateKey, seed, publicBytes);
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
    const data = new TextEncoder().encode(fp);
    const sig = new Uint8Array(
      await crypto.subtle.sign("Ed25519", this.#privateKey, data),
    );

    return `${this.name}:${bytesToBase64(sig)}`;
  }
}

export async function verifySignature(
  publicKey: string,
  fp: string,
  signature: string,
): Promise<boolean> {
  const keySep = publicKey.trim().indexOf(":");
  const sigSep = signature.trim().indexOf(":");
  if (keySep === -1 || sigSep === -1) {
    throw new Error("invalid Nix key or signature format");
  }
  const keyName = publicKey.trim().slice(0, keySep);
  const sigName = signature.trim().slice(0, sigSep);
  if (keyName !== sigName) {
    return false;
  }

  const keyBytes = base64ToBytes(publicKey.trim().slice(keySep + 1));
  const sigBytes = base64ToBytes(signature.trim().slice(sigSep + 1));
  if (keyBytes.length !== 32 || sigBytes.length !== 64) {
    return false;
  }

  const key = await crypto.subtle.importKey("raw", keyBytes, "Ed25519", false, [
    "verify",
  ]);

  return crypto.subtle.verify(
    "Ed25519",
    key,
    sigBytes,
    new TextEncoder().encode(fp),
  );
}
