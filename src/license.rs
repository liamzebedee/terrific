//! Offline license verification and the unregistered-copy nag bookkeeping.
//!
//! termset is sold like Sublime Text: fully functional forever, with an
//! occasional "unregistered copy" reminder that a valid license key silences
//! permanently. This whole model is gated behind the `licensing` cargo feature
//! (on by default) — build with `--no-default-features` to compile it out and
//! ship an unrestricted binary.
//!
//! A license key is `<b64url(payload)>.<b64url(sig)>`, where `sig` is an
//! Ed25519 signature — made by the vendor's private key — over the exact ASCII
//! bytes of the `b64url(payload)` half. The matching 32-byte public key is
//! compiled into the binary from `scripts/license-pubkey.bin`, so verification
//! is entirely offline: no network, no phone-home. `payload` is small JSON:
//! `{"name":..,"email":..,"issued":"YYYY-MM-DD","product":"termset"}`.
//!
//! The web backend (`web/`) holds the private key and mints keys on purchase;
//! `web/scripts/gen-license-keypair.ts` (re)generates the pair.

use std::path::PathBuf;

use ed25519_compact::{PublicKey, Signature};

/// The vendor's Ed25519 public key, compiled in at build time. Regenerate the
/// pair (and this file) with `web/scripts/gen-license-keypair.ts`; the private
/// half lives only in the backend's environment.
const PUBKEY: &[u8] = include_bytes!("../scripts/license-pubkey.bin");

/// The product string a payload must carry to be accepted — guards against a
/// key minted for some other product signed by the same key.
const PRODUCT: &str = "termset";

/// Show the unregistered reminder on the first launch and then every Nth launch
/// after that. Never on a registered copy.
pub(crate) const NAG_EVERY: u64 = 5;

/// Where "Buy License…" (menu item and nag button) sends the user.
pub(crate) const BUY_URL: &str = "https://termset.app/#buy";

/// A verified license. Only ever constructed by [`verify`], so holding one is
/// proof the key checked out against the embedded public key.
#[derive(Debug, Clone)]
pub(crate) struct License {
    pub name: String,
    pub email: String,
}

/// The JSON payload half of a key. Extra fields (e.g. `issued`) are ignored.
#[derive(serde::Deserialize)]
struct Payload {
    #[serde(default)]
    name: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    product: String,
}

/// Verify a pasted license key against the embedded public key. Returns the
/// [`License`] only when the signature checks out *and* the payload is for this
/// product; any malformation, bad signature, or wrong product yields `None`.
pub(crate) fn verify(key: &str) -> Option<License> {
    let key = key.trim();
    let (payload_b64, sig_b64) = key.split_once('.')?;
    let payload_bytes = b64url_decode(payload_b64)?;
    let sig_bytes = b64url_decode(sig_b64)?;

    let pk = PublicKey::from_slice(PUBKEY).ok()?;
    let sig = Signature::from_slice(&sig_bytes).ok()?;
    // The signature covers the ASCII of the base64 payload, so we never
    // re-serialize the JSON (which could differ byte-for-byte from what was
    // signed) — we verify the exact bytes and only then parse them.
    pk.verify(payload_b64.as_bytes(), &sig).ok()?;

    // JSON is a subset of YAML, so the existing serde_yaml parser reads it
    // without pulling in a second deserializer.
    let payload: Payload = serde_yaml::from_slice(&payload_bytes).ok()?;
    if payload.product != PRODUCT {
        return None;
    }
    Some(License {
        name: payload.name,
        email: payload.email,
    })
}

/// `~/.config/termset` — where the license and launch counter live. Created
/// lazily by the writers; readers tolerate its absence.
fn config_dir() -> PathBuf {
    crate::home_dir().join(".config").join("termset")
}

fn license_path() -> PathBuf {
    config_dir().join("license.key")
}

fn launches_path() -> PathBuf {
    config_dir().join("launches")
}

/// Load and verify the stored license, if any. A stored-but-invalid key (e.g.
/// left over from a key rotation) reads as unregistered.
pub(crate) fn load_license() -> Option<License> {
    let text = std::fs::read_to_string(license_path()).ok()?;
    verify(&text)
}

/// Verify `key`; on success persist it to disk and return the [`License`]. An
/// invalid key is neither saved nor returned, so the on-disk key is always one
/// that verified at least once.
pub(crate) fn save_license(key: &str) -> Option<License> {
    let lic = verify(key)?;
    let _ = std::fs::create_dir_all(config_dir());
    let _ = std::fs::write(license_path(), key.trim());
    Some(lic)
}

/// Increment the persistent launch counter and report whether this launch
/// should show the nag. Registered copies never nag and leave the counter
/// untouched. Unregistered: nag on the very first launch and every
/// [`NAG_EVERY`]th launch thereafter.
pub(crate) fn bump_launch_and_should_nag(registered: bool) -> bool {
    if registered {
        return false;
    }
    let path = launches_path();
    let n = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0)
        + 1;
    let _ = std::fs::create_dir_all(config_dir());
    let _ = std::fs::write(&path, n.to_string());
    n == 1 || n % NAG_EVERY == 0
}

/// Decode unpadded base64url (`-`/`_` alphabet). Returns `None` on any byte
/// outside the alphabet or a length that can't be a whole byte stream.
fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    }
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &c in s.as_bytes() {
        acc = (acc << 6) | val(c)? as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    // Any leftover bits must be zero padding, not dropped data.
    if bits > 0 && (acc & ((1 << bits) - 1)) != 0 {
        return None;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real key signed by the private half of the committed
    // `scripts/license-pubkey.bin`, minted by web/scripts/gen-license-keypair.ts.
    const SAMPLE: &str = "eyJuYW1lIjoiQWRhIExvdmVsYWNlIiwiZW1haWwiOiJhZGFAZXhhbXBsZS5jb20iLCJpc3N1ZWQiOiIyMDI2LTA3LTE5IiwicHJvZHVjdCI6InRlcm1zZXQifQ.AKMyxlX5eiXOSJVGR0Y6Bcd58XnTtLt9Qq0Pzvhlhg2thUL4yl8u1zWnBqdCiLEG1hAp58spvPpqH9LPHYaaCQ";

    #[test]
    fn accepts_a_validly_signed_key() {
        let lic = verify(SAMPLE).expect("sample key must verify");
        assert_eq!(lic.name, "Ada Lovelace");
        assert_eq!(lic.email, "ada@example.com");
    }

    #[test]
    fn tolerates_surrounding_whitespace() {
        assert!(verify(&format!("\n  {SAMPLE}\t\n")).is_some());
    }

    #[test]
    fn rejects_a_tampered_payload() {
        // Flip a character in the payload half: signature no longer matches.
        let (p, s) = SAMPLE.split_once('.').unwrap();
        let mut p = p.to_string();
        p.replace_range(0..1, "F");
        assert!(verify(&format!("{p}.{s}")).is_none());
    }

    #[test]
    fn rejects_garbage_and_empty() {
        assert!(verify("").is_none());
        assert!(verify("not-a-key").is_none());
        assert!(verify("a.b").is_none());
    }

    #[test]
    fn b64url_roundtrip_and_reject() {
        assert_eq!(b64url_decode("aGk").unwrap(), b"hi");
        assert!(b64url_decode("!!!").is_none());
    }
}
