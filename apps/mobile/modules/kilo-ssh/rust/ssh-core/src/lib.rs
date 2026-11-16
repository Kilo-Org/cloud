//! SSH core shared by the Kotlin and Swift binding layers.
//!
//! Everything reachable from the mobile platforms is exported through uniffi.

uniffi::setup_scaffolding!();

mod error;
mod export;
mod forward;
mod key;
mod runtime;
mod session;
mod sftp;
mod shell;
mod transfer;

pub use error::SshError;
pub use export::{decrypt_export, encrypt_export};
pub use forward::{ForwardConfig, ForwardHandle, ForwardSink};
pub use key::{GeneratedKey, ParsedKey, generate_ed25519_key, parse_private_key};
pub use session::{AuthMethod, ConnectConfig, ExecResult, Prompt, SessionHandler, SshSession};
pub use sftp::{CancelToken, Entry, EntryKind, SftpClient, TransferProgress};
pub use shell::{ByteSink, ShellChannel};

#[uniffi::export]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_version_is_not_empty() {
        assert_eq!(core_version(), env!("CARGO_PKG_VERSION"));
    }
}
