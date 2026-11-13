//! Failure categories shared by every SSH operation.

use std::fmt;

use russh::keys::ssh_key;

/// Why an SSH operation failed.
///
/// The variants are the stable contract with the JavaScript layer: each one
/// maps to a `code` on the rejected promise, so apps can branch on the category
/// instead of matching message text.
///
/// [`SshError::retryable`] records whether repeating the same call, without
/// changing its inputs, can succeed. Transient transport failures are
/// retryable; everything that needs different input, a new session, or a user
/// decision is not.
#[derive(Debug, uniffi::Error)]
#[uniffi(flat_error)]
pub enum SshError {
    /// The transport could not reach the server or lost it.
    Network { message: String },
    /// The server did not answer within the configured timeout.
    Timeout { message: String },
    /// The host key was rejected by the session handler.
    HostKeyRejected,
    /// The server refused the supplied credentials.
    AuthFailed { message: String },
    /// The keyboard-interactive handler declined to answer.
    AuthCancelled,
    /// The key or negotiated algorithm is not supported.
    UnsupportedAlgorithm { message: String },
    /// The private key could not be parsed.
    KeyParse { message: String },
    /// A passphrase is required, or does not decrypt the key.
    WrongPassphrase,
    /// An export is not a valid age file, or cannot be produced from its inputs.
    InvalidExport { message: String },
    /// The channel is closed: end of stream, server close, or session loss.
    ChannelClosed { message: String },
    /// The peer broke the protocol or the session ended unexpectedly.
    Protocol { message: String },
    /// A local key pair could not be created.
    KeyGeneration { message: String },
    /// The remote path does not exist.
    NotFound { path: String },
    /// The server refused access to the path.
    PermissionDenied { path: String },
    /// The app cancelled the transfer.
    Cancelled,
    /// A port forward could not be set up.
    Forwarding { message: String },
    /// A file in the app sandbox could not be read or written.
    LocalIo { message: String },
}

impl SshError {
    /// Whether repeating the same call can succeed without changing its inputs.
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Network { .. } | Self::Timeout { .. })
    }

    /// The category name, matching the JavaScript `code` union.
    pub fn category(&self) -> &'static str {
        match self {
            Self::Network { .. } => "Network",
            Self::Timeout { .. } => "Timeout",
            Self::HostKeyRejected => "HostKeyRejected",
            Self::AuthFailed { .. } => "AuthFailed",
            Self::AuthCancelled => "AuthCancelled",
            Self::UnsupportedAlgorithm { .. } => "UnsupportedAlgorithm",
            Self::KeyParse { .. } => "KeyParse",
            Self::WrongPassphrase => "WrongPassphrase",
            Self::InvalidExport { .. } => "InvalidExport",
            Self::ChannelClosed { .. } => "ChannelClosed",
            Self::Protocol { .. } => "Protocol",
            Self::KeyGeneration { .. } => "KeyGeneration",
            Self::NotFound { .. } => "NotFound",
            Self::PermissionDenied { .. } => "PermissionDenied",
            Self::Cancelled => "Cancelled",
            Self::Forwarding { .. } => "Forwarding",
            Self::LocalIo { .. } => "LocalIo",
        }
    }

    pub(crate) fn network(error: impl fmt::Display) -> Self {
        Self::Network {
            message: error.to_string(),
        }
    }

    pub(crate) fn protocol(error: impl fmt::Display) -> Self {
        Self::Protocol {
            message: error.to_string(),
        }
    }
}

/// Whether a call that failed with `category` can succeed when repeated.
///
/// Lets the binding layers answer the question without duplicating the table.
#[uniffi::export]
pub fn category_is_retryable(category: String) -> bool {
    matches!(category.as_str(), "Network" | "Timeout")
}

impl fmt::Display for SshError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Network { message } => write!(f, "network error: {message}"),
            Self::Timeout { message } => write!(f, "timeout: {message}"),
            Self::HostKeyRejected => write!(f, "host key rejected"),
            Self::AuthFailed { message } => write!(f, "authentication failed: {message}"),
            Self::AuthCancelled => write!(f, "authentication cancelled"),
            Self::UnsupportedAlgorithm { message } => {
                write!(f, "unsupported algorithm: {message}")
            }
            Self::KeyParse { message } => write!(f, "key parse error: {message}"),
            Self::WrongPassphrase => write!(f, "wrong or missing passphrase"),
            Self::InvalidExport { message } => write!(f, "invalid export: {message}"),
            Self::ChannelClosed { message } => write!(f, "channel closed: {message}"),
            Self::Protocol { message } => write!(f, "protocol error: {message}"),
            Self::KeyGeneration { message } => write!(f, "key generation failed: {message}"),
            Self::NotFound { path } => write!(f, "not found: {path}"),
            Self::PermissionDenied { path } => write!(f, "permission denied: {path}"),
            Self::Cancelled => write!(f, "cancelled"),
            Self::Forwarding { message } => write!(f, "forwarding failed: {message}"),
            Self::LocalIo { message } => write!(f, "local I/O error: {message}"),
        }
    }
}

impl std::error::Error for SshError {}

impl From<russh::Error> for SshError {
    fn from(error: russh::Error) -> Self {
        use russh::Error as RusshError;

        match error {
            RusshError::IO(error) => match error.kind() {
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => Self::Timeout {
                    message: error.to_string(),
                },
                _ => Self::network(error),
            },
            RusshError::ConnectionTimeout
            | RusshError::KeepaliveTimeout
            | RusshError::InactivityTimeout
            | RusshError::Elapsed(_) => Self::Timeout {
                message: error.to_string(),
            },
            RusshError::Disconnect
            | RusshError::HUP
            | RusshError::SendError
            | RusshError::Pending => Self::network(error),
            RusshError::UnknownAlgo | RusshError::NoCommonAlgo { .. } => {
                Self::UnsupportedAlgorithm {
                    message: error.to_string(),
                }
            }
            RusshError::WrongChannel => Self::ChannelClosed {
                message: error.to_string(),
            },
            RusshError::Keys(error) => Self::from(error),
            other => Self::protocol(other),
        }
    }
}

impl From<russh::keys::Error> for SshError {
    fn from(error: russh::keys::Error) -> Self {
        use russh::keys::Error as KeyError;

        match error {
            KeyError::KeyIsEncrypted => Self::WrongPassphrase,
            KeyError::UnknownAlgorithm(oid) => Self::UnsupportedAlgorithm {
                message: format!("unknown key algorithm {oid}"),
            },
            KeyError::UnsupportedKeyType {
                key_type_string, ..
            } => Self::UnsupportedAlgorithm {
                message: format!("unsupported key type {key_type_string}"),
            },
            other => Self::KeyParse {
                message: other.to_string(),
            },
        }
    }
}

/// Maps a failure from `ssh_key` while reading key material.
pub(crate) fn key_error(error: ssh_key::Error) -> SshError {
    match error {
        ssh_key::Error::AlgorithmUnsupported { algorithm } => SshError::UnsupportedAlgorithm {
            message: format!("unsupported algorithm {algorithm}"),
        },
        ssh_key::Error::AlgorithmUnknown => SshError::UnsupportedAlgorithm {
            message: "unknown algorithm".to_string(),
        },
        other => SshError::KeyParse {
            message: other.to_string(),
        },
    }
}

/// Maps an SFTP failure, naming the path the operation addressed.
pub(crate) fn sftp_error(path: &str, error: russh_sftp::client::error::Error) -> SshError {
    use russh_sftp::client::error::Error as SftpError;
    use russh_sftp::protocol::StatusCode;

    match error {
        SftpError::Status(status) => match status.status_code {
            StatusCode::NoSuchFile => SshError::NotFound {
                path: path.to_string(),
            },
            StatusCode::PermissionDenied => SshError::PermissionDenied {
                path: path.to_string(),
            },
            StatusCode::NoConnection | StatusCode::ConnectionLost => SshError::Network {
                message: status.error_message,
            },
            code => SshError::Protocol {
                message: format!("{code} for {path}: {}", status.error_message),
            },
        },
        other => other.into(),
    }
}

/// Maps an I/O failure of an SFTP file object back to its protocol cause.
pub(crate) fn sftp_io(path: &str, error: std::io::Error) -> SshError {
    let message = error.to_string();

    match error
        .into_inner()
        .map(|inner| inner.downcast::<russh_sftp::client::error::Error>())
    {
        Some(Ok(cause)) => sftp_error(path, *cause),
        _ => SshError::Protocol {
            message: format!("{path}: {message}"),
        },
    }
}

pub(crate) fn local_io(path: &std::path::Path, error: std::io::Error) -> SshError {
    SshError::LocalIo {
        message: format!("{}: {error}", path.display()),
    }
}

impl From<russh_sftp::client::error::Error> for SshError {
    fn from(error: russh_sftp::client::error::Error) -> Self {
        use russh_sftp::client::error::Error as SftpError;

        match error {
            SftpError::Status(status) => SshError::Protocol {
                message: format!("{}: {}", status.status_code, status.error_message),
            },
            SftpError::Timeout => SshError::Timeout {
                message: "sftp request".to_string(),
            },
            SftpError::IO(message) => SshError::Network { message },
            other => SshError::Protocol {
                message: other.to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn every_error() -> Vec<SshError> {
        vec![
            SshError::Network {
                message: "refused".into(),
            },
            SshError::Timeout {
                message: "handshake".into(),
            },
            SshError::HostKeyRejected,
            SshError::AuthFailed {
                message: "denied".into(),
            },
            SshError::AuthCancelled,
            SshError::UnsupportedAlgorithm {
                message: "ssh-dss".into(),
            },
            SshError::KeyParse {
                message: "garbage".into(),
            },
            SshError::WrongPassphrase,
            SshError::InvalidExport {
                message: "not an age file".into(),
            },
            SshError::ChannelClosed {
                message: "eof".into(),
            },
            SshError::Protocol {
                message: "bad mac".into(),
            },
            SshError::KeyGeneration {
                message: "no entropy".into(),
            },
            SshError::NotFound {
                path: "/missing".into(),
            },
            SshError::PermissionDenied {
                path: "/root".into(),
            },
            SshError::Cancelled,
            SshError::Forwarding {
                message: "port busy".into(),
            },
            SshError::LocalIo {
                message: "no space".into(),
            },
        ]
    }

    #[test]
    fn only_transport_failures_are_retryable() {
        for error in every_error() {
            let expected = matches!(error, SshError::Network { .. } | SshError::Timeout { .. });
            assert_eq!(
                error.retryable(),
                expected,
                "{} has the wrong retryable flag",
                error.category()
            );
        }
    }

    #[test]
    fn categories_are_stable() {
        let categories: Vec<&str> = every_error().iter().map(SshError::category).collect();

        assert_eq!(
            categories,
            [
                "Network",
                "Timeout",
                "HostKeyRejected",
                "AuthFailed",
                "AuthCancelled",
                "UnsupportedAlgorithm",
                "KeyParse",
                "WrongPassphrase",
                "InvalidExport",
                "ChannelClosed",
                "Protocol",
                "KeyGeneration",
                "NotFound",
                "PermissionDenied",
                "Cancelled",
                "Forwarding",
                "LocalIo",
            ]
        );
    }

    #[test]
    fn exported_retryable_matches_every_variant() {
        for error in every_error() {
            assert_eq!(
                category_is_retryable(error.category().to_string()),
                error.retryable(),
                "{} disagrees with the exported table",
                error.category()
            );
        }
    }

    #[test]
    fn io_timeouts_map_to_timeout() {
        let mapped: SshError =
            russh::Error::IO(std::io::Error::from(std::io::ErrorKind::TimedOut)).into();

        assert!(matches!(mapped, SshError::Timeout { .. }));
    }

    #[test]
    fn refused_connections_map_to_network() {
        let mapped: SshError =
            russh::Error::IO(std::io::Error::from(std::io::ErrorKind::ConnectionRefused)).into();

        assert!(matches!(mapped, SshError::Network { .. }));
    }
}
