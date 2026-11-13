//! TCP port forwarding: device-side listeners and server-side forwards, both
//! carried over channels of a session.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use russh::Channel;
use russh::client::Msg;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::{JoinHandle, JoinSet};

use crate::error::SshError;
use crate::runtime;
use crate::session::SessionHandle;

const ORIGINATOR_ADDRESS: &str = "127.0.0.1";

/// Receives the failures a forward cannot report through its return value,
/// because they happen after it started or on a single connection.
#[uniffi::export(with_foreign)]
pub trait ForwardSink: Send + Sync {
    fn on_error(&self, message: String);
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct ForwardConfig {
    /// Interface the forward listens on: the device for a local forward, the
    /// server for a remote one.
    pub bind_host: String,
    /// `0` asks the operating system or the server for a free port.
    pub bind_port: u16,
    pub dest_host: String,
    pub dest_port: u16,
}

/// A running forward. Dropping it leaves the forward running; call
/// [`ForwardHandle::stop`] to end it.
#[derive(uniffi::Object)]
pub struct ForwardHandle {
    actual_port: u16,
    stopper: Mutex<Option<Stopper>>,
}

#[uniffi::export]
impl ForwardHandle {
    /// The port data actually reaches: the bound port for a local forward, the
    /// one the server selected for a remote one.
    pub fn actual_port(&self) -> u16 {
        self.actual_port
    }

    /// Closes the listener and every connection it carries. Calling it twice
    /// is harmless.
    pub async fn stop(&self) -> Result<(), SshError> {
        let stopper = self
            .stopper
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        let Some(stopper) = stopper else {
            return Ok(());
        };

        runtime::run(async move { stopper.stop().await }).await
    }
}

enum Stopper {
    Local {
        cancel: watch::Sender<bool>,
        task: JoinHandle<()>,
    },
    Remote {
        session: SessionHandle,
        forwards: Arc<RemoteForwards>,
        address: String,
        port: u32,
    },
}

impl Stopper {
    async fn stop(self) -> Result<(), SshError> {
        match self {
            Self::Local { cancel, task } => {
                cancel.send_replace(true);
                let _ = task.await;
                Ok(())
            }
            Self::Remote {
                session,
                forwards,
                address,
                port,
            } => {
                forwards.remove(port);

                session
                    .cancel_tcpip_forward(address, port)
                    .await
                    .map_err(|error| SshError::Forwarding {
                        message: format!("withdrawing the forward failed: {error}"),
                    })
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct Destination {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) events: Arc<dyn ForwardSink>,
}

impl Destination {
    fn label(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// The destinations of the remote forwards this session asked the server for,
/// keyed by the port the server bound.
#[derive(Default)]
pub(crate) struct RemoteForwards {
    targets: Mutex<HashMap<u32, Destination>>,
}

impl RemoteForwards {
    pub(crate) fn insert(&self, port: u32, destination: Destination) {
        self.targets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(port, destination);
    }

    pub(crate) fn remove(&self, port: u32) {
        self.targets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&port);
    }

    pub(crate) fn destination(&self, port: u32) -> Option<Destination> {
        self.targets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&port)
            .cloned()
    }
}

pub(crate) async fn start_local(
    session: SessionHandle,
    config: ForwardConfig,
    events: Arc<dyn ForwardSink>,
) -> Result<Arc<ForwardHandle>, SshError> {
    let listener = TcpListener::bind((config.bind_host.as_str(), config.bind_port))
        .await
        .map_err(|error| binding_error(&config, error))?;
    let actual_port = listener
        .local_addr()
        .map_err(|error| binding_error(&config, error))?
        .port();

    let (cancel, cancelled) = watch::channel(false);
    let destination = Destination {
        host: config.dest_host,
        port: config.dest_port,
        events,
    };
    let task = tokio::spawn(accept_connections(
        listener,
        cancelled,
        session,
        destination,
    ));

    Ok(Arc::new(ForwardHandle {
        actual_port,
        stopper: Mutex::new(Some(Stopper::Local { cancel, task })),
    }))
}

pub(crate) async fn start_remote(
    session: SessionHandle,
    forwards: Arc<RemoteForwards>,
    config: ForwardConfig,
    events: Arc<dyn ForwardSink>,
) -> Result<Arc<ForwardHandle>, SshError> {
    let reported = session
        .tcpip_forward(config.bind_host.clone(), u32::from(config.bind_port))
        .await
        .map_err(|error| SshError::Forwarding {
            message: format!(
                "requesting {}:{} failed: {error}",
                config.bind_host, config.bind_port
            ),
        })?;
    let bound = port_bound(reported, config.bind_port)?;

    forwards.insert(
        bound,
        Destination {
            host: config.dest_host,
            port: config.dest_port,
            events,
        },
    );

    Ok(Arc::new(ForwardHandle {
        actual_port: u16::try_from(bound).map_err(|_| SshError::Forwarding {
            message: format!("the server bound an invalid port {bound}"),
        })?,
        stopper: Mutex::new(Some(Stopper::Remote {
            session,
            forwards,
            address: config.bind_host,
            port: bound,
        })),
    }))
}

/// Carries a connection the server opened for a remote forward to the device
/// destination. Runs after the handler accepted the channel.
pub(crate) async fn pump_forwarded(channel: Channel<Msg>, destination: Destination) {
    match TcpStream::connect((destination.host.as_str(), destination.port)).await {
        Ok(transport) => bridge(transport, channel, &destination).await,
        Err(error) => {
            destination.events.on_error(format!(
                "connecting to {} on the device failed: {error}",
                destination.label()
            ));
            let _ = channel.close().await;
        }
    }
}

async fn accept_connections(
    listener: TcpListener,
    mut cancelled: watch::Receiver<bool>,
    session: SessionHandle,
    destination: Destination,
) {
    let mut pumps = JoinSet::new();

    loop {
        tokio::select! {
            biased;
            _ = cancelled.wait_for(|value| *value) => break,
            Some(_) = pumps.join_next(), if !pumps.is_empty() => {}
            accepted = listener.accept() => match accepted {
                Ok((transport, _)) => {
                    pumps.spawn(forward(transport, Arc::clone(&session), destination.clone()));
                }
                Err(error) => {
                    destination.events.on_error(format!("accepting a connection failed: {error}"));
                    break;
                }
            },
        }
    }

    pumps.abort_all();
    while pumps.join_next().await.is_some() {}
}

async fn forward(transport: TcpStream, session: SessionHandle, destination: Destination) {
    let channel = session
        .channel_open_direct_tcpip(
            destination.host.clone(),
            u32::from(destination.port),
            ORIGINATOR_ADDRESS,
            0,
        )
        .await;

    match channel {
        Ok(channel) => bridge(transport, channel, &destination).await,
        Err(error) => destination.events.on_error(format!(
            "opening {} over the session failed: {error}",
            destination.label()
        )),
    }
}

async fn bridge(mut transport: TcpStream, channel: Channel<Msg>, destination: &Destination) {
    let mut stream = channel.into_stream();

    if let Err(error) = tokio::io::copy_bidirectional(&mut transport, &mut stream).await {
        destination.events.on_error(format!(
            "forwarding to {} failed: {error}",
            destination.label()
        ));
    }
}

/// The port a remote forward actually listens on.
///
/// OpenSSH answers with `0` when it accepted the requested port; only a request
/// for port `0` carries the port the server picked.
fn port_bound(reported: u32, requested: u16) -> Result<u32, SshError> {
    match reported {
        0 if requested > 0 => Ok(u32::from(requested)),
        0 => Err(SshError::Forwarding {
            message: "the server did not report the port it bound".to_string(),
        }),
        port => Ok(port),
    }
}

fn binding_error(config: &ForwardConfig, error: std::io::Error) -> SshError {
    SshError::Forwarding {
        message: format!(
            "binding {}:{} failed: {error}",
            config.bind_host, config.bind_port
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_that_answers_zero_bound_the_requested_port() {
        assert_eq!(port_bound(0, 19_000).unwrap(), 19_000);
        assert_eq!(port_bound(2_200, 19_000).unwrap(), 2_200);
        assert_eq!(port_bound(6_000, 0).unwrap(), 6_000);
        assert!(port_bound(0, 0).is_err());
    }
}
