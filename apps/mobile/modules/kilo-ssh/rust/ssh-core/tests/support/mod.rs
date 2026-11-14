//! Fixtures shared by the integration suites: the test server description, the
//! session handler, and the sinks the tests observe.
//!
//! The module is compiled into each suite separately, so a suite that only uses
//! part of it must not leave the rest unused.
#![allow(dead_code, unused_imports, unused_macros)]

use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use russh::server::Auth;
use russh::server::Server as RusshServer;
use sha2::{Digest, Sha256};
use ssh_core::{
    AuthMethod, ByteSink, CancelToken, ConnectConfig, ForwardSink, Prompt, SessionHandler,
    ShellChannel, SshError, SshSession, TransferProgress,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

pub const CONNECT_TIMEOUT: Duration = Duration::from_millis(4_000);
pub const OUTPUT_WAIT: Duration = Duration::from_secs(20);
pub const POLL: Duration = Duration::from_millis(25);
pub const KEEPALIVE_INTERVAL_S: u32 = 5;

pub struct Server {
    pub host: String,
    pub password_port: u16,
    pub keyboard_interactive_port: u16,
    pub silent_port: u16,
    pub user: String,
    pub password: String,
    pub keyboard_interactive_code: String,
    pub keys: PathBuf,
}

impl Server {
    pub fn from_env() -> Option<Self> {
        let host = std::env::var("SSH_TEST_HOST").ok()?;
        let variable =
            |name: &str, default: &str| std::env::var(name).unwrap_or_else(|_| default.to_string());
        let keys = std::env::var("SSH_TEST_KEYS").map_or_else(
            |_| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures")),
            PathBuf::from,
        );

        Some(Self {
            host,
            password_port: port_or("SSH_TEST_PASSWORD_PORT", 2222),
            keyboard_interactive_port: port_or("SSH_TEST_KEYBOARD_INTERACTIVE_PORT", 2223),
            silent_port: port_or("SSH_TEST_SILENT_PORT", 2224),
            user: variable("SSH_TEST_USER", "user"),
            password: variable("SSH_TEST_PASSWORD", "ssh-core-password"),
            keyboard_interactive_code: variable("SSH_TEST_KEYBOARD_INTERACTIVE_CODE", "424242"),
            keys,
        })
    }

    pub fn config(&self, port: u16, auth: AuthMethod) -> ConnectConfig {
        ConnectConfig {
            host: self.host.clone(),
            port,
            username: self.user.clone(),
            auth,
            connect_timeout_ms: CONNECT_TIMEOUT.as_millis() as u32,
            keepalive_interval_s: KEEPALIVE_INTERVAL_S,
        }
    }

    pub fn password_config(&self) -> ConnectConfig {
        let password = AuthMethod::Password {
            password: self.password.clone(),
        };
        self.config(self.password_port, password)
    }

    pub fn key_config(&self, name: &str, passphrase: Option<&str>) -> ConnectConfig {
        let key = AuthMethod::Key {
            private_key_openssh: self.key(name),
            passphrase: passphrase.map(str::to_string),
        };
        self.config(self.password_port, key)
    }

    pub fn key(&self, name: &str) -> String {
        let path = self.keys.join(name);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("reading {}: {error}", path.display()))
    }
}

macro_rules! server {
    () => {
        match crate::support::Server::from_env() {
            Some(server) => server,
            None => {
                eprintln!("skipped: SSH_TEST_HOST is not set");
                return;
            }
        }
    };
}

macro_rules! fixture {
    ($name:expr) => {
        match std::env::var($name) {
            Ok(value) => value,
            Err(_) => {
                eprintln!("skipped: {} is not set", $name);
                return;
            }
        }
    };
}

pub(crate) use fixture;
pub(crate) use server;

pub fn port_or(name: &str, default: u16) -> u16 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

#[derive(Debug)]
pub struct SeenHostKey {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub public_key_base64: String,
    pub fingerprint_sha256: String,
}

pub struct TestHandler {
    accept_host_key: bool,
    answers: Vec<Vec<String>>,
    answer_by_prompt: Option<(String, String)>,
    answer_delay: Duration,
    rounds: Mutex<Vec<Vec<Prompt>>>,
    pub host_keys: Mutex<Vec<SeenHostKey>>,
    pub disconnects: AtomicUsize,
}

impl TestHandler {
    pub fn accepting() -> Self {
        Self {
            accept_host_key: true,
            answers: Vec::new(),
            answer_by_prompt: None,
            answer_delay: Duration::ZERO,
            rounds: Mutex::new(Vec::new()),
            host_keys: Mutex::new(Vec::new()),
            disconnects: AtomicUsize::new(0),
        }
    }

    /// Waits `delay` before every answer, standing in for a user who takes
    /// their time at a prompt.
    pub fn delayed(self, delay: Duration) -> Self {
        Self {
            answer_delay: delay,
            ..self
        }
    }

    pub fn answering_by_prompt(code: String, password: String) -> Self {
        Self {
            answer_by_prompt: Some((code, password)),
            ..Self::accepting()
        }
    }

    pub fn answering(answers: Vec<Vec<String>>, accept_host_key: bool) -> Self {
        Self {
            accept_host_key,
            answers,
            ..Self::accepting()
        }
    }

    pub fn rounds(&self) -> Vec<Vec<Prompt>> {
        let mut rounds = self.rounds.lock().expect("rounds");
        std::mem::take(&mut *rounds)
    }

    pub fn host_keys(&self) -> Vec<SeenHostKey> {
        let mut keys = self.host_keys.lock().expect("host keys");
        std::mem::take(&mut *keys)
    }
}

#[async_trait]
impl SessionHandler for TestHandler {
    async fn verify_host_key(
        &self,
        host: String,
        port: u16,
        algorithm: String,
        public_key_base64: String,
        fingerprint_sha256: String,
    ) -> bool {
        self.host_keys.lock().expect("host keys").push(SeenHostKey {
            host,
            port,
            algorithm,
            public_key_base64,
            fingerprint_sha256,
        });

        self.accept_host_key
    }

    async fn keyboard_interactive(
        &self,
        name: String,
        _instructions: String,
        prompts: Vec<Prompt>,
    ) -> Option<Vec<String>> {
        assert!(name.len() < 256, "the server name is a short identifier");
        if !self.answer_delay.is_zero() {
            tokio::time::sleep(self.answer_delay).await;
        }
        let answers = self.answer_by_prompt.as_ref().map(|(code, password)| {
            prompts
                .iter()
                .map(|prompt| {
                    if prompt.text.to_lowercase().contains("password") {
                        password.clone()
                    } else {
                        code.clone()
                    }
                })
                .collect::<Vec<String>>()
        });

        let round = {
            let mut rounds = self.rounds.lock().expect("rounds");
            let round = rounds.len();
            rounds.push(prompts);
            round
        };

        answers.or_else(|| self.answers.get(round).cloned())
    }

    fn on_disconnect(&self, _reason: String) {
        self.disconnects.fetch_add(1, Ordering::SeqCst);
    }
}

struct StalledAuthServer;

struct StalledAuthSession;

impl RusshServer for StalledAuthServer {
    type Handler = StalledAuthSession;

    fn new_client(&mut self, _peer: Option<SocketAddr>) -> Self::Handler {
        StalledAuthSession
    }
}

impl russh::server::Handler for StalledAuthSession {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        std::future::pending().await
    }
}

/// Serves SSH on a device port, completes key exchange, and never answers
/// authentication: the connect budget is the only way out.
pub async fn stalled_auth_server() -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind a stalled auth server");
    let port = listener.local_addr().expect("local address").port();
    let key_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/id_ed25519");
    let key = russh::keys::PrivateKey::from_openssh(
        std::fs::read_to_string(&key_path)
            .unwrap_or_else(|error| panic!("reading {}: {error}", key_path.display())),
    )
    .expect("parse the fixture host key");
    let config = Arc::new(russh::server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });

    let task = tokio::spawn(async move {
        let mut server = StalledAuthServer;
        let _ = server.run_on_socket(config, &listener).await;
    });

    (port, task)
}

#[derive(Default)]
pub struct CollectingSink {
    data: Mutex<Vec<u8>>,
    closed: Mutex<Option<(Option<u32>, Option<String>)>>,
}

impl CollectingSink {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.data.lock().expect("data")).to_string()
    }

    pub fn clear(&self) {
        self.data.lock().expect("data").clear();
    }

    pub fn closed(&self) -> Option<(Option<u32>, Option<String>)> {
        self.closed.lock().expect("closed").clone()
    }
}

impl ByteSink for CollectingSink {
    fn on_data(&self, bytes: Vec<u8>) {
        self.data.lock().expect("data").extend_from_slice(&bytes);
    }

    fn on_closed(&self, exit_status: Option<u32>, error: Option<String>) {
        *self.closed.lock().expect("closed") = Some((exit_status, error));
    }
}

#[derive(Default)]
pub struct RecordingProgress {
    reports: Mutex<Vec<(u64, Option<u64>)>>,
    cancel_on_report: Option<(usize, Arc<CancelToken>)>,
}

impl RecordingProgress {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancelling_on_report(index: usize, token: Arc<CancelToken>) -> Self {
        Self {
            reports: Mutex::new(Vec::new()),
            cancel_on_report: Some((index, token)),
        }
    }

    pub fn reports(&self) -> Vec<(u64, Option<u64>)> {
        self.reports.lock().expect("reports").clone()
    }
}

impl TransferProgress for RecordingProgress {
    fn on_progress(&self, transferred: u64, total: Option<u64>) {
        let mut reports = self.reports.lock().expect("reports");
        reports.push((transferred, total));

        if let Some((index, token)) = &self.cancel_on_report
            && reports.len() == *index
        {
            token.cancel();
        }
    }
}

#[derive(Default)]
pub struct RecordingForwardSink {
    messages: Mutex<Vec<String>>,
}

impl RecordingForwardSink {
    pub fn messages(&self) -> Vec<String> {
        self.messages.lock().expect("messages").clone()
    }
}

impl ForwardSink for RecordingForwardSink {
    fn on_error(&self, message: String) {
        self.messages.lock().expect("messages").push(message);
    }
}

pub async fn wait_for_text(sink: &CollectingSink, needle: &str) {
    let deadline = tokio::time::Instant::now() + OUTPUT_WAIT;

    loop {
        let text = sink.text();
        if text.contains(needle) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "waited {OUTPUT_WAIT:?} for {needle:?}; output so far: {text:?}"
        );
        tokio::time::sleep(POLL).await;
    }
}

pub async fn wait_for_close(sink: &CollectingSink) {
    let deadline = tokio::time::Instant::now() + OUTPUT_WAIT;

    while sink.closed().is_none() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "channel never reported a close; output: {:?}",
            sink.text()
        );
        tokio::time::sleep(POLL).await;
    }
}

/// Fails a test with `context` when the connection unexpectedly succeeds.
#[track_caller]
pub fn expect_failure(result: Result<Arc<SshSession>, SshError>, context: &str) -> SshError {
    match result {
        Ok(_) => panic!("{context}"),
        Err(error) => error,
    }
}

pub async fn password_session(server: &Server) -> (Arc<SshSession>, Arc<TestHandler>) {
    let handler = Arc::new(TestHandler::accepting());
    let session = SshSession::connect(
        server.password_config(),
        Arc::clone(&handler) as Arc<dyn SessionHandler>,
    )
    .await
    .expect("password session");

    (session, handler)
}

pub async fn open_shell(
    server: &Server,
    cols: u32,
    rows: u32,
) -> (Arc<SshSession>, Arc<ShellChannel>, Arc<CollectingSink>) {
    let (session, _handler) = password_session(server).await;
    let sink = Arc::new(CollectingSink::default());
    let shell = session
        .open_shell(
            "xterm-256color".to_string(),
            cols,
            rows,
            Arc::clone(&sink) as Arc<dyn ByteSink>,
        )
        .await
        .expect("shell");

    (session, shell, sink)
}

pub fn temp_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("ssh-core-{}-{name}", std::process::id()))
}

pub fn local_url(path: &Path) -> String {
    format!("file://{}", path.display())
}

/// Writes `size` bytes of deterministic content and returns their SHA-256.
pub fn write_file(path: &Path, size: usize) -> String {
    const BLOCK: usize = 64 * 1024;

    let mut hasher = Sha256::new();
    let mut file = std::fs::File::create(path).expect("create fixture");
    let mut block = vec![0u8; BLOCK];
    let mut remaining = size;

    while remaining > 0 {
        let take = remaining.min(BLOCK);
        for (index, byte) in block.iter_mut().enumerate().take(take) {
            *byte = (index % 251) as u8;
        }
        block[take - 1] = (remaining % 251) as u8;
        file.write_all(&block[..take]).expect("write fixture");
        hasher.update(&block[..take]);
        remaining -= take;
    }

    hex(hasher.finalize().as_slice())
}

pub fn sha256(path: &Path) -> String {
    let mut hasher = Sha256::new();
    let mut file = std::fs::File::open(path).expect("open for hashing");
    std::io::copy(&mut file, &mut hasher).expect("hash");

    hex(hasher.finalize().as_slice())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Echoes every byte back until the peer closes, on a device port.
pub async fn echo_server() -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("echo bind");
    let port = listener.local_addr().expect("echo address").port();
    let task = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buffer = [0u8; 1024];
                loop {
                    match stream.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            if stream.write_all(&buffer[..read]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });

    (port, task)
}
