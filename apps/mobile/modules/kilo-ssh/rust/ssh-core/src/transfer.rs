//! Chunked, cancellable, progress-reporting file transfers.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use russh_sftp::client::SftpSession;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{SshError, local_io, sftp_error, sftp_io};
use crate::sftp::{CancelToken, TransferProgress};

/// Bytes moved per read and per write request.
const CHUNK_BYTES: usize = 256 * 1024;
/// Shortest gap between two progress callbacks.
const REPORT_INTERVAL: Duration = Duration::from_millis(100);
/// Suffix of the staging file a transfer writes before renaming it into place.
const STAGING_SUFFIX: &str = ".part";

/// Copies a remote file into the app sandbox.
pub(crate) async fn download(
    session: &SftpSession,
    remote: &str,
    local: &Path,
    progress: Option<Arc<dyn TransferProgress>>,
    cancel: &CancelToken,
) -> Result<u64, SshError> {
    let attributes = session
        .symlink_metadata(remote.to_string())
        .await
        .map_err(|error| sftp_error(remote, error))?;
    let staged = staging_path(local);
    let mut target = File::create(&staged)
        .await
        .map_err(|error| local_io(&staged, error))?;

    let result = async {
        let mut source = session
            .open(remote.to_string())
            .await
            .map_err(|error| sftp_error(remote, error))?;
        let mut reporter = Reporter::new(progress, attributes.size);
        let mut buffer = vec![0u8; CHUNK_BYTES];
        let mut transferred = 0u64;

        loop {
            if cancel.is_cancelled() {
                return Err(SshError::Cancelled);
            }
            let read = source
                .read(&mut buffer)
                .await
                .map_err(|error| sftp_io(remote, error))?;
            if read == 0 {
                break;
            }
            target
                .write_all(&buffer[..read])
                .await
                .map_err(|error| local_io(&staged, error))?;
            transferred += read as u64;
            reporter.advance(transferred);
        }

        target
            .flush()
            .await
            .map_err(|error| local_io(&staged, error))?;
        reporter.finish(transferred);

        Ok(transferred)
    }
    .await;

    let transferred = match result {
        Ok(transferred) => transferred,
        Err(error) => {
            let _ = tokio::fs::remove_file(&staged).await;
            return Err(error);
        }
    };

    tokio::fs::rename(&staged, local)
        .await
        .map_err(|error| local_io(local, error))?;

    Ok(transferred)
}

/// Copies a file from the app sandbox to the server.
pub(crate) async fn upload(
    session: &SftpSession,
    local: &Path,
    remote: &str,
    progress: Option<Arc<dyn TransferProgress>>,
    cancel: &CancelToken,
) -> Result<u64, SshError> {
    let mut source = File::open(local)
        .await
        .map_err(|error| local_io(local, error))?;
    let total = source
        .metadata()
        .await
        .map_err(|error| local_io(local, error))?
        .len();
    let staged = format!("{remote}{STAGING_SUFFIX}");
    let mut target = session
        .create(staged.clone())
        .await
        .map_err(|error| sftp_error(remote, error))?;

    let result = async {
        let mut reporter = Reporter::new(progress, Some(total));
        let mut buffer = vec![0u8; CHUNK_BYTES];
        let mut transferred = 0u64;

        loop {
            if cancel.is_cancelled() {
                return Err(SshError::Cancelled);
            }
            let read = source
                .read(&mut buffer)
                .await
                .map_err(|error| local_io(local, error))?;
            if read == 0 {
                break;
            }
            target
                .write_all(&buffer[..read])
                .await
                .map_err(|error| sftp_io(&staged, error))?;
            transferred += read as u64;
            reporter.advance(transferred);
        }

        target
            .shutdown()
            .await
            .map_err(|error| sftp_io(&staged, error))?;
        session
            .rename(staged.clone(), remote.to_string())
            .await
            .map_err(|error| sftp_error(remote, error))?;
        reporter.finish(transferred);

        Ok(transferred)
    }
    .await;

    if result.is_err() {
        let _ = session.remove_file(staged).await;
    }

    result
}

fn staging_path(local: &Path) -> PathBuf {
    let mut staged = local.as_os_str().to_os_string();
    staged.push(STAGING_SUFFIX);

    PathBuf::from(staged)
}

/// Turns a `file://` URL from the app sandbox into a path.
pub(crate) fn local_path(url: &str) -> Result<PathBuf, SshError> {
    let Some(rest) = url.strip_prefix("file://") else {
        return Ok(PathBuf::from(url));
    };
    let path = rest.strip_prefix("localhost").unwrap_or(rest);

    Ok(PathBuf::from(percent_decode(path)?))
}

fn percent_decode(input: &str) -> Result<String, SshError> {
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' {
            let digits = input
                .get(index + 1..index + 3)
                .ok_or_else(|| SshError::LocalIo {
                    message: format!("truncated escape in {input}"),
                })?;
            let byte = u8::from_str_radix(digits, 16).map_err(|_| SshError::LocalIo {
                message: format!("invalid escape %{digits} in {input}"),
            })?;
            decoded.push(byte);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }

    String::from_utf8(decoded).map_err(|_| SshError::LocalIo {
        message: format!("{input} is not valid UTF-8"),
    })
}

struct Reporter {
    sink: Option<Arc<dyn TransferProgress>>,
    total: Option<u64>,
    last: Option<Instant>,
    reported: Option<u64>,
}

impl Reporter {
    fn new(sink: Option<Arc<dyn TransferProgress>>, total: Option<u64>) -> Self {
        Self {
            sink,
            total,
            last: None,
            reported: None,
        }
    }

    fn advance(&mut self, transferred: u64) {
        let due = self
            .last
            .is_none_or(|last| last.elapsed() >= REPORT_INTERVAL);

        if due {
            self.report(transferred);
        }
    }

    fn finish(&mut self, transferred: u64) {
        if self.reported != Some(transferred) {
            self.report(transferred);
        }
    }

    fn report(&mut self, transferred: u64) {
        self.last = Some(Instant::now());
        self.reported = Some(transferred);

        if let Some(sink) = &self.sink {
            sink.on_progress(transferred, self.total);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct RecordingSink {
        reports: Mutex<Vec<(u64, Option<u64>)>>,
    }

    impl TransferProgress for RecordingSink {
        fn on_progress(&self, transferred: u64, total: Option<u64>) {
            self.reports
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((transferred, total));
        }
    }

    #[test]
    fn file_urls_become_sandbox_paths() {
        assert_eq!(
            local_path("file:///data/user/0/app/files/notes.txt")
                .unwrap()
                .to_str(),
            Some("/data/user/0/app/files/notes.txt")
        );
        assert_eq!(
            local_path("file://localhost/var/tmp/a%20b.txt")
                .unwrap()
                .to_str(),
            Some("/var/tmp/a b.txt")
        );
        assert_eq!(
            local_path("/already/a/path").unwrap().to_str(),
            Some("/already/a/path")
        );
    }

    #[test]
    fn malformed_file_urls_are_local_io_errors() {
        for url in ["file:///tmp/%", "file:///tmp/%zz", "file:///tmp/%ff"] {
            let error = local_path(url).unwrap_err();

            assert_eq!(error.category(), "LocalIo", "{url}");
        }
    }

    #[test]
    fn progress_is_throttled_and_always_ends_with_the_total() {
        let sink = Arc::new(RecordingSink {
            reports: Mutex::new(Vec::new()),
        });
        let mut reporter = Reporter::new(Some(sink.clone()), Some(1_000));

        for step in 1..=100 {
            reporter.advance(step * 10);
        }
        reporter.finish(1_000);

        let reports = sink
            .reports
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        assert!(reports.len() <= 3, "throttling reported {reports:?}");
        assert_eq!(
            reports.first().map(|(transferred, _)| *transferred),
            Some(10)
        );
        assert_eq!(reports.last(), Some(&(1_000, Some(1_000))));
    }

    #[test]
    fn staging_keeps_the_original_extension_visible() {
        assert_eq!(
            staging_path(Path::new("/data/app/notes.txt"))
                .to_str()
                .unwrap(),
            "/data/app/notes.txt.part"
        );
    }
}
