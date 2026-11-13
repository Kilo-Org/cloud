//! Passphrase-encrypted export and import of the app's data.
//!
//! The payload is app-defined JSON; the core treats it as opaque bytes. Files are
//! age v1 files encrypted to an scrypt passphrase recipient and ASCII-armored, so
//! this module and `age -p` interoperate in both directions.

use std::fmt;
use std::io::{BufReader, Read, Write};
use std::iter;

use age::armor::{ArmoredReader, ArmoredWriter, Format};
use age::secrecy::SecretString;
use age::{DecryptError, Encryptor};
use zeroize::Zeroize;

use crate::SshError;

const MAX_EXPORT_BYTES: usize = 16 * 1024 * 1024;
const MIN_PASSPHRASE_CHARS: usize = 8;
// age's scrypt default: 2^18 iterations and a 256 MiB allocation. A fixed factor
// keeps a file created on a fast device openable on a slow one, and bounds the
// memory a supplied file may demand.
const SCRYPT_WORK_FACTOR: u8 = 18;

/// Encrypts `plaintext_json` into an ASCII-armored age file.
///
/// Fails with [`SshError::InvalidExport`] when the payload exceeds 16 MiB or the
/// passphrase is shorter than 8 characters.
#[uniffi::export]
pub fn encrypt_export(plaintext_json: String, passphrase: String) -> Result<String, SshError> {
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(SshError::InvalidExport {
            message: format!("the passphrase must be at least {MIN_PASSPHRASE_CHARS} characters"),
        });
    }

    let mut plaintext = plaintext_json.into_bytes();
    let byte_count = plaintext.len();

    if byte_count > MAX_EXPORT_BYTES {
        plaintext.zeroize();

        return Err(SshError::InvalidExport {
            message: format!("the payload is {byte_count} bytes; the limit is {MAX_EXPORT_BYTES}"),
        });
    }

    let sealed = seal(&plaintext, passphrase);
    plaintext.zeroize();

    sealed
}

/// Decrypts an ASCII-armored age file produced by [`encrypt_export`] or by
/// `age -p -a`.
///
/// Fails with [`SshError::WrongPassphrase`] when the passphrase does not open the
/// file, and with [`SshError::InvalidExport`] when the input is not an age file,
/// is damaged, or decrypts to more than 16 MiB.
#[uniffi::export]
pub fn decrypt_export(armored: String, passphrase: String) -> Result<String, SshError> {
    let mut identity = age::scrypt::Identity::new(SecretString::from(passphrase));
    identity.set_max_work_factor(SCRYPT_WORK_FACTOR);

    let decryptor =
        age::Decryptor::new_buffered(ArmoredReader::new(BufReader::new(armored.as_bytes())))
            .map_err(|error| invalid_export(format!("not an age export: {error}")))?;

    let mut reader = decryptor
        .decrypt(iter::once(&identity as &dyn age::Identity))
        .map_err(open_error)?;

    let mut plaintext = Vec::new();
    reader
        .by_ref()
        .take(MAX_EXPORT_BYTES as u64 + 1)
        .read_to_end(&mut plaintext)
        .map_err(|error| invalid_export(format!("the export is damaged: {error}")))?;

    if plaintext.len() > MAX_EXPORT_BYTES {
        plaintext.zeroize();

        return Err(SshError::InvalidExport {
            message: format!("the payload exceeds the {MAX_EXPORT_BYTES} byte limit"),
        });
    }

    String::from_utf8(plaintext).map_err(|_| invalid_export("the payload is not UTF-8".to_string()))
}

fn seal(plaintext: &[u8], passphrase: String) -> Result<String, SshError> {
    let mut recipient = age::scrypt::Recipient::new(SecretString::from(passphrase));
    recipient.set_work_factor(SCRYPT_WORK_FACTOR);

    let encryptor = Encryptor::with_recipients(iter::once(&recipient as &dyn age::Recipient))
        .map_err(|error| invalid_export(format!("could not encrypt: {error}")))?;

    let mut armored = Vec::with_capacity(plaintext.len() + plaintext.len() / 3 + 1024);
    let mut writer = encryptor
        .wrap_output(
            ArmoredWriter::wrap_output(&mut armored, Format::AsciiArmor)
                .map_err(|error| invalid_export(format!("could not encrypt: {error}")))?,
        )
        .map_err(|error| invalid_export(format!("could not encrypt: {error}")))?;

    writer
        .write_all(plaintext)
        .and_then(|()| writer.finish()?.finish())
        .map_err(|error| invalid_export(format!("could not encrypt: {error}")))?;

    String::from_utf8(armored)
        .map_err(|_| invalid_export("the ciphertext is not UTF-8".to_string()))
}

fn open_error(error: DecryptError) -> SshError {
    match error {
        DecryptError::DecryptionFailed => SshError::WrongPassphrase,
        other => invalid_export(format!("the export cannot be opened: {other}")),
    }
}

fn invalid_export(message: impl fmt::Display) -> SshError {
    SshError::InvalidExport {
        message: message.to_string(),
    }
}
