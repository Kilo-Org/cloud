//! Interactive shell channels: terminal bytes flow through a foreign sink and
//! never enter the JavaScript runtime.

use std::sync::{Arc, Mutex, RwLock};

use russh::{Channel, ChannelMsg, ChannelReadHalf, ChannelWriteHalf};
use tokio::sync::{
    mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel},
    watch,
};

use crate::error::SshError;
use crate::runtime;

/// Receives the bytes and the close event of a shell channel.
#[uniffi::export(with_foreign)]
pub trait ByteSink: Send + Sync {
    /// A chunk of terminal output, in the order the server sent it.
    fn on_data(&self, bytes: Vec<u8>);

    /// The channel ended. `exit_status` is the shell's exit status when the
    /// server reported one; `error` explains an abnormal end.
    fn on_closed(&self, exit_status: Option<u32>, error: Option<String>);
}

enum Command {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

#[derive(uniffi::Object)]
pub struct ShellChannel {
    commands: Mutex<Option<UnboundedSender<Command>>>,
    state: Arc<ShellState>,
}

impl ShellChannel {
    /// Starts the reader and writer tasks for a channel whose pty and shell
    /// have already been requested.
    pub(crate) fn start(channel: Channel<russh::client::Msg>, sink: Arc<dyn ByteSink>) -> Self {
        let (reader, writer) = channel.split();
        let (commands, receiver) = unbounded_channel();
        let (closed, _) = watch::channel(false);
        let state = Arc::new(ShellState {
            sink: RwLock::new(sink),
            closed,
        });

        runtime::spawn(write_loop(receiver, writer, Arc::clone(&state)));
        runtime::spawn(read_loop(reader, Arc::clone(&state)));

        Self {
            commands: Mutex::new(Some(commands)),
            state,
        }
    }

    fn send(&self, command: Command) -> Result<(), SshError> {
        let mut commands = self
            .commands
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *self.state.closed.borrow() {
            return Err(channel_closed());
        }
        let sender = commands.as_ref().ok_or_else(channel_closed)?;
        let closing = matches!(command, Command::Close);
        sender.send(command).map_err(|_| channel_closed())?;
        if closing {
            commands.take();
        }
        Ok(())
    }
}

#[uniffi::export]
impl ShellChannel {
    /// Sends terminal input, preserving order with [`ShellChannel::resize`].
    pub fn write(&self, bytes: Vec<u8>) -> Result<(), SshError> {
        self.send(Command::Write(bytes))
    }

    pub fn resize(&self, cols: u32, rows: u32) -> Result<(), SshError> {
        self.send(Command::Resize { cols, rows })
    }

    /// Closes the channel. Named `shutdown` because `close` collides with the
    /// `AutoCloseable.close` that uniffi generates for every exported object.
    pub fn shutdown(&self) -> Result<(), SshError> {
        self.send(Command::Close)
    }

    /// Replaces the sink that receives output; bytes that arrive after the swap
    /// go to the new sink.
    pub fn set_sink(&self, sink: Arc<dyn ByteSink>) {
        *self
            .state
            .sink
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = sink;
    }
}

struct ShellState {
    sink: RwLock<Arc<dyn ByteSink>>,
    closed: watch::Sender<bool>,
}

impl ShellState {
    fn finish(&self, exit_status: Option<u32>, error: Option<String>) {
        if !self.closed.send_replace(true) {
            self.sink
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .on_closed(exit_status, error);
        }
    }
}

fn channel_closed() -> SshError {
    SshError::ChannelClosed {
        message: "shell channel is closed".to_string(),
    }
}

async fn write_loop(
    mut commands: UnboundedReceiver<Command>,
    writer: ChannelWriteHalf<russh::client::Msg>,
    state: Arc<ShellState>,
) {
    let mut closed = state.closed.subscribe();
    loop {
        let command = tokio::select! {
            biased;
            _ = closed.wait_for(|value| *value) => break,
            command = commands.recv() => command,
        };
        let stopping = matches!(command, Some(Command::Close) | None);
        let operation = async {
            match command {
                Some(Command::Write(bytes)) => writer.data_bytes(bytes).await,
                Some(Command::Resize { cols, rows }) => {
                    writer.window_change(cols, rows, 0, 0).await
                }
                Some(Command::Close) | None => {
                    writer.eof().await?;
                    writer.close().await
                }
            }
        };
        let result = tokio::select! {
            biased;
            _ = closed.wait_for(|value| *value) => break,
            result = operation => result,
        };
        if let Err(error) = result {
            state.finish(None, Some(format!("shell write failed: {error}")));
            let _ = writer.close().await;
            break;
        }
        if stopping {
            break;
        }
    }
}

async fn read_loop(mut reader: ChannelReadHalf, state: Arc<ShellState>) {
    let mut exit_status = None;

    loop {
        match reader.wait().await {
            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                state
                    .sink
                    .read()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .on_data(data.to_vec());
            }
            Some(ChannelMsg::ExitStatus {
                exit_status: status,
            }) => exit_status = Some(status),
            Some(ChannelMsg::Eof) => {}
            Some(ChannelMsg::Close) | None => break,
            Some(_) => {}
        }
    }

    state.finish(exit_status, None);
}
