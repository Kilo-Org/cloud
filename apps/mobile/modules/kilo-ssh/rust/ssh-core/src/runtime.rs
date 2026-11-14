//! The tokio runtime the core owns for every SSH task.
//!
//! Exported futures are polled by the platform binding layer, which must not be
//! trusted with SSH I/O: each call is spawned onto this runtime instead.

use std::future::Future;
use std::sync::LazyLock;

use tokio::runtime::{Builder, Runtime};

use crate::error::SshError;

/// Two workers carry one session task each in both directions; the I/O is
/// event driven, so thread count does not limit session count.
const WORKER_THREADS: usize = 2;

fn runtime() -> &'static Runtime {
    static RUNTIME: LazyLock<Runtime> = LazyLock::new(|| {
        Builder::new_multi_thread()
            .worker_threads(WORKER_THREADS)
            .enable_all()
            .thread_name("ssh-core")
            .build()
            .expect("ssh core runtime")
    });

    &RUNTIME
}

/// Runs `future` on the core runtime and reports its task failure as a
/// [`SshError`] instead of a panic.
pub(crate) async fn run<F, T>(future: F) -> Result<T, SshError>
where
    F: Future<Output = Result<T, SshError>> + Send + 'static,
    T: Send + 'static,
{
    runtime()
        .spawn(future)
        .await
        .map_err(|error| SshError::Protocol {
            message: format!("ssh task failed: {error}"),
        })?
}

/// Spawns a background task that outlives the call which started it.
pub(crate) fn spawn<F>(future: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    runtime().spawn(future);
}
