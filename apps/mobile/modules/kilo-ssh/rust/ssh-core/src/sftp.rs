//! SFTP: the remote file system reached over a session channel.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType};

use crate::error::{SshError, sftp_error};
use crate::runtime;
use crate::transfer;

/// What a directory entry points at, taken from the server's `lstat`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Entry {
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    /// Seconds since the Unix epoch, when the server reported a time.
    pub modified_unix: Option<u64>,
    /// POSIX mode bits, when the server reported them.
    pub permissions: Option<u32>,
}

/// Receives the byte count of a transfer while it runs.
///
/// The core calls it at most ten times a second, so an implementation may
/// forward every call to the platform event emitter.
#[uniffi::export(with_foreign)]
pub trait TransferProgress: Send + Sync {
    /// `total` is the expected size when the source reported one.
    fn on_progress(&self, transferred: u64, total: Option<u64>);
}

/// Stops a running transfer at its next chunk boundary.
#[derive(uniffi::Object)]
pub struct CancelToken {
    cancelled: AtomicBool,
}

#[uniffi::export]
impl CancelToken {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            cancelled: AtomicBool::new(false),
        })
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// A remote file system on one channel of a session.
#[derive(uniffi::Object)]
pub struct SftpClient {
    session: Arc<SftpSession>,
}

impl SftpClient {
    pub(crate) fn new(session: SftpSession) -> Self {
        Self {
            session: Arc::new(session),
        }
    }
}

#[uniffi::export]
impl SftpClient {
    /// Lists a directory. `.` and `..` are not returned.
    pub async fn list(&self, path: String) -> Result<Vec<Entry>, SshError> {
        let session = Arc::clone(&self.session);
        runtime::run(async move {
            let entries = session
                .read_dir(path.clone())
                .await
                .map_err(|error| sftp_error(&path, error))?;

            Ok(entries
                .map(|entry| entry_from(&entry.file_name(), &entry.metadata()))
                .collect())
        })
        .await
    }

    /// Reads the attributes of `path` without following a final symlink.
    pub async fn stat(&self, path: String) -> Result<Entry, SshError> {
        let session = Arc::clone(&self.session);
        runtime::run(async move {
            let attributes = session
                .symlink_metadata(path.clone())
                .await
                .map_err(|error| sftp_error(&path, error))?;

            Ok(entry_from(&file_name(&path), &attributes))
        })
        .await
    }

    /// Resolves a server-side path, including symbolic links and `~`.
    pub async fn realpath(&self, path: String) -> Result<String, SshError> {
        let session = Arc::clone(&self.session);
        runtime::run(async move {
            session
                .canonicalize(path.clone())
                .await
                .map_err(|error| sftp_error(&path, error))
        })
        .await
    }

    pub async fn mkdir(&self, path: String) -> Result<(), SshError> {
        let session = Arc::clone(&self.session);
        runtime::run(async move {
            session
                .create_dir(path.clone())
                .await
                .map_err(|error| sftp_error(&path, error))
        })
        .await
    }

    pub async fn rename(&self, from: String, to: String) -> Result<(), SshError> {
        let session = Arc::clone(&self.session);
        runtime::run(async move {
            session
                .rename(from.clone(), to)
                .await
                .map_err(|error| sftp_error(&from, error))
        })
        .await
    }

    pub async fn remove_file(&self, path: String) -> Result<(), SshError> {
        let session = Arc::clone(&self.session);
        runtime::run(async move {
            session
                .remove_file(path.clone())
                .await
                .map_err(|error| sftp_error(&path, error))
        })
        .await
    }

    pub async fn remove_dir(&self, path: String) -> Result<(), SshError> {
        let session = Arc::clone(&self.session);
        runtime::run(async move {
            session
                .remove_dir(path.clone())
                .await
                .map_err(|error| sftp_error(&path, error))
        })
        .await
    }

    /// Copies a remote file to `local_path`, a `file://` URL in the app
    /// sandbox. Returns the number of bytes written.
    ///
    /// The bytes go to `<local_path>.part` first, which is renamed into place
    /// on success and removed on failure or cancellation, so an interrupted
    /// download never leaves a truncated file at `local_path`.
    pub async fn download(
        &self,
        remote_path: String,
        local_path: String,
        progress: Option<Arc<dyn TransferProgress>>,
        cancel: Arc<CancelToken>,
    ) -> Result<u64, SshError> {
        let session = Arc::clone(&self.session);
        runtime::run(async move {
            let local = transfer::local_path(&local_path)?;
            transfer::download(&session, &remote_path, &local, progress, &cancel).await
        })
        .await
    }

    /// Copies `local_path`, a `file://` URL in the app sandbox, to the server.
    /// Returns the number of bytes read.
    ///
    /// The bytes go to `<remote_path>.part` first, which is renamed into place
    /// on success and removed on failure or cancellation, so an interrupted
    /// upload never leaves a truncated file at `remote_path`.
    pub async fn upload(
        &self,
        local_path: String,
        remote_path: String,
        progress: Option<Arc<dyn TransferProgress>>,
        cancel: Arc<CancelToken>,
    ) -> Result<u64, SshError> {
        let session = Arc::clone(&self.session);
        runtime::run(async move {
            let local = transfer::local_path(&local_path)?;
            transfer::upload(&session, &local, &remote_path, progress, &cancel).await
        })
        .await
    }

    /// Ends the SFTP subsystem channel. Other channels of the session stay up.
    /// Named `shutdown` because `close` collides with the `AutoCloseable.close`
    /// that uniffi generates for every exported object.
    pub async fn shutdown(&self) -> Result<(), SshError> {
        let session = Arc::clone(&self.session);
        runtime::run(async move { session.close().await.map_err(SshError::from) }).await
    }
}

fn entry_from(name: &str, attributes: &FileAttributes) -> Entry {
    Entry {
        name: name.to_string(),
        kind: kind_of(attributes.file_type()),
        size: attributes.size.unwrap_or(0),
        modified_unix: attributes.mtime.map(u64::from),
        permissions: attributes.permissions,
    }
}

fn kind_of(file_type: FileType) -> EntryKind {
    match file_type {
        FileType::File => EntryKind::File,
        FileType::Dir => EntryKind::Directory,
        FileType::Symlink => EntryKind::Symlink,
        FileType::Other => EntryKind::Other,
    }
}

fn file_name(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');

    if trimmed.is_empty() {
        return path.to_string();
    }

    trimmed.rsplit('/').next().unwrap_or(trimmed).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_protocol_file_type_maps_to_a_kind() {
        assert_eq!(kind_of(FileType::File), EntryKind::File);
        assert_eq!(kind_of(FileType::Dir), EntryKind::Directory);
        assert_eq!(kind_of(FileType::Symlink), EntryKind::Symlink);
        assert_eq!(kind_of(FileType::Other), EntryKind::Other);
    }

    #[test]
    fn stat_names_use_the_last_path_segment() {
        assert_eq!(file_name("/home/user/notes.txt"), "notes.txt");
        assert_eq!(file_name("/home/user/notes.txt/"), "notes.txt");
        assert_eq!(file_name("/"), "/");
        assert_eq!(file_name("notes.txt"), "notes.txt");
    }

    #[test]
    fn cancel_tokens_start_and_stay_cancelled() {
        let token = CancelToken::new();

        assert!(!token.is_cancelled());
        token.cancel();
        assert!(token.is_cancelled());
    }
}
