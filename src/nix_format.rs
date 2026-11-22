use std::fmt::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
#[cfg(test)]
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;

const NIX_BASE32_ALPHABET: &[u8; 32] = b"0123456789abcdfghijklmnpqrsvwxyz";
const STORE_PREFIX: &str = "/nix/store/";

fn is_nixbase32(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| NIX_BASE32_ALPHABET.contains(&byte))
}

fn validate_key_name(name: &str) -> Result<()> {
    if name.is_empty() || name.contains(':') || name.chars().any(char::is_whitespace) {
        bail!("invalid Nix key name '{name}'");
    }

    Ok(())
}

#[must_use]
pub fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

#[derive(Clone)]
pub struct SigningKeyPair {
    name: String,
    signing_key: SigningKey,
}

impl SigningKeyPair {
    pub fn generate(name: impl Into<String>) -> Result<Self> {
        let name = name.into();
        validate_key_name(&name)?;

        Ok(Self {
            name,
            signing_key: SigningKey::generate(&mut OsRng),
        })
    }

    pub fn parse_secret(raw: &str) -> Result<Self> {
        let Some((name, encoded)) = raw.trim().split_once(':') else {
            bail!("invalid Nix secret key: missing ':' separator");
        };
        validate_key_name(name)?;

        let bytes = BASE64
            .decode(encoded)
            .context("failed to base64-decode Nix secret key")?;
        if bytes.len() != 64 {
            bail!(
                "invalid Nix secret key length: expected 64 bytes, got {}",
                bytes.len()
            );
        }

        let seed: [u8; 32] = bytes[..32].try_into().unwrap();
        let signing_key = SigningKey::from_bytes(&seed);
        if signing_key.verifying_key().to_bytes() != bytes[32..64] {
            bail!("Nix secret key public half does not match Ed25519 seed");
        }

        Ok(Self {
            name: name.to_owned(),
            signing_key,
        })
    }

    #[must_use]
    pub fn secret_string(&self) -> String {
        let mut combined = [0u8; 64];
        combined[..32].copy_from_slice(&self.signing_key.to_bytes());
        combined[32..].copy_from_slice(&self.signing_key.verifying_key().to_bytes());

        format!("{}:{}", self.name, BASE64.encode(combined))
    }

    #[must_use]
    pub fn public_string(&self) -> String {
        let public_bytes = self.signing_key.verifying_key().to_bytes();

        format!("{}:{}", self.name, BASE64.encode(public_bytes))
    }

    #[must_use]
    pub fn sign_fingerprint(&self, fingerprint: &str) -> String {
        let signature = self.signing_key.sign(fingerprint.as_bytes());

        format!("{}:{}", self.name, BASE64.encode(signature.to_bytes()))
    }
}

#[cfg(test)]
pub fn verify_signature(public_key: &str, fingerprint: &str, signature: &str) -> Result<bool> {
    let Some((key_name, key_b64)) = public_key.trim().split_once(':') else {
        bail!("invalid Nix public key: missing ':' separator");
    };
    let Some((sig_name, sig_b64)) = signature.trim().split_once(':') else {
        bail!("invalid Nix signature: missing ':' separator");
    };
    if key_name != sig_name {
        return Ok(false);
    }

    let key_bytes: [u8; 32] = BASE64
        .decode(key_b64)
        .context("failed to base64-decode Nix public key")?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Nix public key must be 32 bytes"))?;
    let verifying_key = VerifyingKey::from_bytes(&key_bytes)?;

    let sig_bytes: [u8; 64] = BASE64
        .decode(sig_b64)
        .context("failed to base64-decode Nix signature")?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Nix signature must be 64 bytes"))?;
    let parsed_sig = Signature::from_bytes(&sig_bytes);

    Ok(verifying_key
        .verify(fingerprint.as_bytes(), &parsed_sig)
        .is_ok())
}

#[must_use]
pub fn encode_nixbase32(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    let len = (bytes.len() * 8 - 1) / 5 + 1;
    let mut out = String::with_capacity(len);
    for n in (0..len).rev() {
        let bit_offset = n * 5;
        let byte_index = bit_offset / 8;
        let bit_shift = bit_offset % 8;
        let low = bytes[byte_index] >> bit_shift;
        let high = if byte_index + 1 < bytes.len() && bit_shift > 3 {
            bytes[byte_index + 1] << (8 - bit_shift)
        } else {
            0
        };
        let digit = (low | high) & 0x1f;
        out.push(char::from(NIX_BASE32_ALPHABET[usize::from(digit)]));
    }

    out
}

#[must_use]
pub fn format_sha256_nixbase32(digest: &[u8; 32]) -> String {
    format!("sha256:{}", encode_nixbase32(digest))
}

pub fn validate_sha256_nixbase32(raw: &str) -> Result<()> {
    let Some(rest) = raw.strip_prefix("sha256:") else {
        bail!("hash '{raw}' must start with 'sha256:'");
    };
    if rest.len() != 52 || !is_nixbase32(rest) {
        bail!("invalid sha256 nixbase32 hash '{raw}'");
    }

    Ok(())
}

pub fn store_path_basename(store_path: &str) -> Result<&str> {
    let Some(rest) = store_path.strip_prefix(STORE_PREFIX) else {
        bail!("store path '{store_path}' must start with '{STORE_PREFIX}'");
    };
    if rest.is_empty() || rest.contains('/') {
        bail!("store path '{store_path}' must be a direct child of /nix/store");
    }

    Ok(rest)
}

pub fn validate_store_hash(hash: &str) -> Result<()> {
    if hash.len() != 32 || !is_nixbase32(hash) {
        bail!("invalid Nix store hash '{hash}'");
    }

    Ok(())
}

pub fn store_hash_from_path(store_path: &str) -> Result<&str> {
    let basename = store_path_basename(store_path)?;
    let Some((hash, _name)) = basename.split_once('-') else {
        bail!("invalid store path '{store_path}': missing '-' after hash");
    };
    validate_store_hash(hash)?;

    Ok(hash)
}

pub fn validate_sha256_hex(digest: &str) -> Result<()> {
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("invalid sha256 hex digest '{digest}'");
    }

    Ok(())
}

pub fn normalize_references(references: &[String]) -> Result<Vec<String>> {
    let mut normalized = Vec::with_capacity(references.len());
    for reference in references {
        let basename = if reference.starts_with(STORE_PREFIX) {
            store_path_basename(reference)?.to_owned()
        } else {
            if reference.is_empty() || reference.contains('/') {
                bail!("invalid store reference '{reference}'");
            }

            reference.clone()
        };
        normalized.push(basename);
    }
    normalized.sort();
    normalized.dedup();

    Ok(normalized)
}

#[must_use]
pub fn fingerprint(
    store_path: &str,
    nar_hash_nix32: &str,
    nar_size: u64,
    sorted_ref_basenames: &[String],
) -> String {
    let mut refs_joined = String::new();
    for (index, basename) in sorted_ref_basenames.iter().enumerate() {
        if index > 0 {
            refs_joined.push(',');
        }
        refs_joined.push_str(STORE_PREFIX);
        refs_joined.push_str(basename);
    }

    format!("1;{store_path};{nar_hash_nix32};{nar_size};{refs_joined}")
}

pub struct NarInfo {
    pub store_path: String,
    pub url: String,
    pub file_hash: String,
    pub file_size: u64,
    pub nar_hash: String,
    pub nar_size: u64,
    pub references: Vec<String>,
    pub deriver: Option<String>,
    pub sig: String,
}

impl NarInfo {
    #[must_use]
    pub fn render(&self) -> String {
        let mut out = String::with_capacity(512);
        let _ = writeln!(out, "StorePath: {}", self.store_path);
        let _ = writeln!(out, "URL: {}", self.url);
        let _ = writeln!(out, "Compression: zstd");
        let _ = writeln!(out, "FileHash: {}", self.file_hash);
        let _ = writeln!(out, "FileSize: {}", self.file_size);
        let _ = writeln!(out, "NarHash: {}", self.nar_hash);
        let _ = writeln!(out, "NarSize: {}", self.nar_size);
        if !self.references.is_empty() {
            let _ = writeln!(out, "References: {}", self.references.join(" "));
        }
        if let Some(deriver) = &self.deriver {
            let _ = writeln!(out, "Deriver: {deriver}");
        }
        let _ = writeln!(out, "Sig: {}", self.sig);

        out
    }
}

#[must_use]
pub fn render_nix_cache_info(priority: u32) -> String {
    format!("StoreDir: /nix/store\nWantMassQuery: 1\nPriority: {priority}\n")
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;

    #[test]
    fn nixbase32_matches_known_sha256_empty_vector() {
        let digest: [u8; 32] = Sha256::digest(b"").into();
        let encoded = format_sha256_nixbase32(&digest);
        assert_eq!(
            encoded,
            "sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73"
        );
        validate_sha256_nixbase32(&encoded).unwrap();
    }

    #[test]
    fn signing_key_roundtrip_and_verification() {
        let pair = SigningKeyPair::generate("cache.so1ve.dev-1").unwrap();
        let reparsed = SigningKeyPair::parse_secret(&pair.secret_string()).unwrap();
        assert_eq!(pair.public_string(), reparsed.public_string());

        let fp = fingerprint(
            "/nix/store/00000000000000000000000000000000-hello",
            "sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73",
            128,
            &[
                "11111111111111111111111111111111-a".to_owned(),
                "22222222222222222222222222222222-b".to_owned(),
            ],
        );
        assert_eq!(
            fp,
            "1;/nix/store/00000000000000000000000000000000-hello;sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73;128;/nix/store/11111111111111111111111111111111-a,/nix/store/22222222222222222222222222222222-b"
        );

        let sig = reparsed.sign_fingerprint(&fp);
        assert!(verify_signature(&pair.public_string(), &fp, &sig).unwrap());
        assert!(!verify_signature(&pair.public_string(), "tampered", &sig).unwrap());
    }
}
