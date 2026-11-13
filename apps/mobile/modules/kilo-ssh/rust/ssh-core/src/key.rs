//! Private key creation and import.

use russh::keys::ssh_key::LineEnding;
use russh::keys::ssh_key::private::{Ed25519Keypair, KeypairData};
use russh::keys::{HashAlg, PrivateKey, decode_secret_key};

use crate::error::{SshError, key_error};

const ED25519_SEED_LEN: usize = 32;

const OPENSSH_LABEL: &str = "OPENSSH PRIVATE KEY";
const PKCS8_LABEL: &str = "PRIVATE KEY";
const ENCRYPTED_PKCS8_LABEL: &str = "ENCRYPTED PRIVATE KEY";
const RSA_PKCS1_LABEL: &str = "RSA PRIVATE KEY";
const EC_SEC1_LABEL: &str = "EC PRIVATE KEY";

#[derive(Debug, uniffi::Record)]
pub struct GeneratedKey {
    pub private_key_openssh: String,
    pub public_key_openssh: String,
    pub fingerprint_sha256: String,
}

#[derive(Debug, uniffi::Record)]
pub struct ParsedKey {
    pub algorithm: String,
    pub public_key_openssh: String,
    pub fingerprint_sha256: String,
    /// Whether the imported key material was encrypted with a passphrase.
    pub encrypted: bool,
}

/// A key ready for authentication.
pub(crate) struct LoadedKey {
    pub(crate) key: PrivateKey,
    pub(crate) encrypted: bool,
}

#[uniffi::export]
pub fn generate_ed25519_key(comment: String) -> Result<GeneratedKey, SshError> {
    let mut seed = [0u8; ED25519_SEED_LEN];
    getrandom::fill(&mut seed).map_err(|error| SshError::KeyGeneration {
        message: error.to_string(),
    })?;

    let pair = Ed25519Keypair::from_seed(&seed);
    let key = PrivateKey::new(KeypairData::Ed25519(pair), comment).map_err(key_error)?;

    let private_key_openssh = key
        .to_openssh(LineEnding::LF)
        .map_err(key_error)?
        .to_string();
    let public_key = key.public_key();

    Ok(GeneratedKey {
        private_key_openssh,
        public_key_openssh: public_key.to_openssh().map_err(key_error)?,
        fingerprint_sha256: public_key.fingerprint(HashAlg::Sha256).to_string(),
    })
}

/// Reads an OpenSSH or PEM (PKCS#8, PKCS#1, SEC1) private key.
#[uniffi::export]
pub fn parse_private_key(pem: String, passphrase: Option<String>) -> Result<ParsedKey, SshError> {
    let loaded = load_private_key(&pem, passphrase.as_deref())?;
    let public_key = loaded.key.public_key();

    Ok(ParsedKey {
        algorithm: loaded.key.algorithm().to_string(),
        public_key_openssh: public_key.to_openssh().map_err(key_error)?,
        fingerprint_sha256: public_key.fingerprint(HashAlg::Sha256).to_string(),
        encrypted: loaded.encrypted,
    })
}

pub(crate) fn load_private_key(pem: &str, passphrase: Option<&str>) -> Result<LoadedKey, SshError> {
    let label = pem_label(pem)?;
    let encrypted = match label {
        OPENSSH_LABEL => PrivateKey::from_openssh(pem)
            .map_err(key_error)?
            .is_encrypted(),
        ENCRYPTED_PKCS8_LABEL => true,
        PKCS8_LABEL | RSA_PKCS1_LABEL | EC_SEC1_LABEL => is_legacy_encrypted(pem),
        other => {
            return Err(SshError::UnsupportedAlgorithm {
                message: format!("unsupported private key format: {other}"),
            });
        }
    };

    if encrypted && passphrase.is_none() {
        return Err(SshError::WrongPassphrase);
    }

    let key = if label == OPENSSH_LABEL {
        let key = PrivateKey::from_openssh(pem).map_err(key_error)?;
        if key.is_encrypted() {
            key.decrypt(passphrase.unwrap_or_default())
                .map_err(|_| SshError::WrongPassphrase)?
        } else {
            key
        }
    } else {
        decode_secret_key(pem, passphrase).map_err(|error| decode_error(error, encrypted))?
    };

    Ok(LoadedKey { key, encrypted })
}

/// The PEM header label, without the `-----BEGIN `/`-----` delimiters.
fn pem_label(pem: &str) -> Result<&str, SshError> {
    let header = pem
        .lines()
        .map(str::trim_start)
        .find(|line| line.starts_with("-----BEGIN "));

    header
        .and_then(|line| line.strip_prefix("-----BEGIN "))
        .and_then(|line| line.strip_suffix("-----"))
        .ok_or_else(|| SshError::KeyParse {
            message: "no PEM header".to_string(),
        })
}

fn is_legacy_encrypted(pem: &str) -> bool {
    pem.lines()
        .any(|line| line.starts_with("DEK-Info:") || line.starts_with("Proc-Type: 4,ENCRYPTED"))
}

/// Errors from [`decode_secret_key`] carry no passphrase signal, so a failing
/// encrypted key is reported as a passphrase problem once its format is known.
fn decode_error(error: russh::keys::Error, encrypted: bool) -> SshError {
    match error {
        russh::keys::Error::KeyIsEncrypted => SshError::WrongPassphrase,
        russh::keys::Error::UnknownAlgorithm(oid) => SshError::UnsupportedAlgorithm {
            message: format!("unknown key algorithm {oid}"),
        },
        russh::keys::Error::UnsupportedKeyType {
            key_type_string, ..
        } => SshError::UnsupportedAlgorithm {
            message: format!("unsupported key type {key_type_string}"),
        },
        _ if encrypted => SshError::WrongPassphrase,
        error => SshError::KeyParse {
            message: error.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
    const PASSPHRASE: &str = "correct horse battery";

    fn read(name: &str) -> String {
        let path: PathBuf = [FIXTURES, name].iter().collect();
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
    }

    fn parse(name: &str, passphrase: Option<&str>) -> Result<ParsedKey, SshError> {
        parse_private_key(read(name), passphrase.map(str::to_string))
    }

    /// The `<algorithm> <base64>` part of an OpenSSH public key, without its
    /// comment: PEM formats do not carry the OpenSSH comment.
    fn key_material(openssh: &str) -> String {
        openssh
            .split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn generated_key_round_trips() {
        let generated = generate_ed25519_key("scaffold@test".to_string()).expect("key generated");

        assert!(
            generated
                .private_key_openssh
                .starts_with("-----BEGIN OPENSSH PRIVATE KEY-----")
        );
        assert!(generated.public_key_openssh.starts_with("ssh-ed25519 "));
        assert!(generated.fingerprint_sha256.starts_with("SHA256:"));

        let parsed = PrivateKey::from_openssh(&generated.private_key_openssh).expect("re-parsed");
        assert_eq!(
            parsed.public_key().to_openssh().expect("public key"),
            generated.public_key_openssh
        );
        assert_eq!(
            parsed.public_key().fingerprint(HashAlg::Sha256).to_string(),
            generated.fingerprint_sha256
        );
    }

    #[test]
    fn openssh_keys_of_every_supported_algorithm_parse() {
        for (name, algorithm) in [
            ("id_ed25519", "ssh-ed25519"),
            ("id_rsa", "ssh-rsa"),
            ("id_ecdsa_p256", "ecdsa-sha2-nistp256"),
            ("id_ecdsa_p384", "ecdsa-sha2-nistp384"),
        ] {
            let parsed = parse(name, None).expect(name);

            assert_eq!(parsed.algorithm, algorithm, "{name}");
            assert!(!parsed.encrypted, "{name}");
            assert!(parsed.public_key_openssh.starts_with(algorithm), "{name}");
        }
    }

    #[test]
    fn pkcs8_keys_parse_and_match_their_openssh_form() {
        for (pkcs8, openssh) in [
            ("id_ed25519.pk8.pem", "id_ed25519"),
            ("id_rsa.pk8.pem", "id_rsa"),
            ("id_ecdsa_p256.pk8.pem", "id_ecdsa_p256"),
        ] {
            let from_pkcs8 = parse(pkcs8, None).expect(pkcs8);
            let from_openssh = parse(openssh, None).expect(openssh);

            assert_eq!(
                key_material(&from_pkcs8.public_key_openssh),
                key_material(&from_openssh.public_key_openssh)
            );
            assert_eq!(
                from_pkcs8.fingerprint_sha256,
                from_openssh.fingerprint_sha256
            );
            assert!(!from_pkcs8.encrypted);
        }
    }

    #[test]
    fn encrypted_openssh_key_needs_the_right_passphrase() {
        let parsed = parse("id_ed25519_encrypted", Some(PASSPHRASE)).expect("decrypted");
        assert!(parsed.encrypted);
        assert_eq!(parsed.algorithm, "ssh-ed25519");

        assert!(matches!(
            parse("id_ed25519_encrypted", Some("wrong")),
            Err(SshError::WrongPassphrase)
        ));
        assert!(matches!(
            parse("id_ed25519_encrypted", None),
            Err(SshError::WrongPassphrase)
        ));
    }

    #[test]
    fn encrypted_pkcs8_key_needs_the_right_passphrase() {
        let parsed = parse("id_rsa.pk8.encrypted.pem", Some(PASSPHRASE)).expect("decrypted");
        assert!(parsed.encrypted);
        assert_eq!(parsed.algorithm, "ssh-rsa");

        assert!(matches!(
            parse("id_rsa.pk8.encrypted.pem", Some("wrong")),
            Err(SshError::WrongPassphrase)
        ));
        assert!(matches!(
            parse("id_rsa.pk8.encrypted.pem", None),
            Err(SshError::WrongPassphrase)
        ));
    }

    #[test]
    fn legacy_pem_keys_parse() {
        let rsa = parse("id_rsa.pkcs1.pem", None).expect("pkcs1");
        assert_eq!(rsa.algorithm, "ssh-rsa");

        let ec = parse("id_ecdsa_p256.sec1.pem", None).expect("sec1");
        assert_eq!(ec.algorithm, "ecdsa-sha2-nistp256");
    }

    #[test]
    fn unsupported_formats_are_rejected_with_their_own_category() {
        let certificate = read("unsupported.pem");

        assert!(matches!(
            parse_private_key(certificate, None),
            Err(SshError::UnsupportedAlgorithm { .. })
        ));
        assert!(matches!(
            parse_private_key(
                "-----BEGIN FOO-----\nYmFy\n-----END FOO-----\n".to_string(),
                None
            ),
            Err(SshError::UnsupportedAlgorithm { .. })
        ));
        assert!(matches!(
            parse_private_key("not a key".to_string(), None),
            Err(SshError::KeyParse { .. })
        ));
    }
}
