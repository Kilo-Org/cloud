//! Session coverage against the OpenSSH test server in `tests/docker`.
//!
//! The suite needs a server, so it runs only when `SSH_TEST_HOST` is set (the
//! CI job starts the containers and sets it). Without it every test returns
//! immediately and `cargo test` stays hermetic.

mod support;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use ssh_core::{AuthMethod, Prompt, SessionHandler, SshError, SshSession};
use support::{
    TestHandler, expect_failure, open_shell, password_session, server, wait_for_close,
    wait_for_text,
};

#[tokio::test]
async fn password_authentication_succeeds() {
    let server = server!();
    let (session, handler) = password_session(&server).await;

    let seen = handler.host_keys();
    assert_eq!(seen.len(), 1, "one host key per key exchange");
    assert_eq!(seen[0].host, server.host);
    assert_eq!(seen[0].port, server.password_port);
    assert!(
        seen[0].algorithm.starts_with("ssh-") || seen[0].algorithm.starts_with("ecdsa-"),
        "unexpected algorithm {:?}",
        seen[0].algorithm
    );
    assert!(!seen[0].public_key_base64.is_empty());
    assert!(
        seen[0].fingerprint_sha256.starts_with("SHA256:"),
        "unexpected fingerprint {:?}",
        seen[0].fingerprint_sha256
    );

    session.disconnect().await.expect("disconnect");
}

#[tokio::test]
async fn password_authentication_rejects_a_wrong_password() {
    let server = server!();
    let mut config = server.password_config();
    config.auth = AuthMethod::Password {
        password: "not the password".to_string(),
    };
    let handler = Arc::new(TestHandler::accepting());

    let error = expect_failure(
        SshSession::connect(config, handler as Arc<dyn SessionHandler>).await,
        "the server must reject a wrong password",
    );

    assert!(
        matches!(error, SshError::AuthFailed { .. }),
        "unexpected error: {error:?}"
    );
}

#[tokio::test]
async fn key_authentication_succeeds_for_every_supported_algorithm() {
    let server = server!();

    for (name, algorithm) in [
        ("id_ed25519", "ssh-ed25519"),
        ("id_rsa", "ssh-rsa"),
        ("id_ecdsa_p256", "ecdsa-sha2-nistp256"),
        ("id_ecdsa_p384", "ecdsa-sha2-nistp384"),
    ] {
        let handler = Arc::new(TestHandler::accepting());
        let session = SshSession::connect(
            server.key_config(name, None),
            handler as Arc<dyn SessionHandler>,
        )
        .await
        .unwrap_or_else(|error| panic!("{name} ({algorithm}): {error:?}"));

        let result = session.exec("echo key".to_string()).await.expect("exec");
        assert_eq!(String::from_utf8_lossy(&result.stdout).trim(), "key");
        session.disconnect().await.expect("disconnect");
    }
}

#[tokio::test]
async fn encrypted_key_authentication_needs_the_passphrase() {
    let server = server!();

    let handler = Arc::new(TestHandler::accepting());
    let session = SshSession::connect(
        server.key_config("id_ed25519_encrypted", Some("correct horse battery")),
        handler as Arc<dyn SessionHandler>,
    )
    .await
    .expect("the right passphrase authenticates");
    session.disconnect().await.expect("disconnect");

    let handler = Arc::new(TestHandler::accepting());
    let error = expect_failure(
        SshSession::connect(
            server.key_config("id_ed25519_encrypted", Some("wrong")),
            handler as Arc<dyn SessionHandler>,
        )
        .await,
        "a wrong passphrase must not authenticate",
    );

    assert!(
        matches!(error, SshError::WrongPassphrase),
        "unexpected error: {error:?}"
    );
}

#[tokio::test]
async fn keyboard_interactive_answers_every_round() {
    let server = server!();
    let handler = Arc::new(TestHandler::answering_by_prompt(
        server.keyboard_interactive_code.clone(),
        server.password.clone(),
    ));
    let config = server.config(
        server.keyboard_interactive_port,
        AuthMethod::KeyboardInteractive,
    );

    let session = SshSession::connect(config, handler.clone() as Arc<dyn SessionHandler>)
        .await
        .expect("keyboard-interactive session");

    let prompts: Vec<Prompt> = handler.rounds().into_iter().flatten().collect();
    assert_eq!(prompts.len(), 2, "the PAM stack asks two questions");
    assert!(
        prompts
            .iter()
            .any(|prompt| prompt.text.contains("Verification code") && prompt.echo),
        "the code prompt echoes: {prompts:?}"
    );
    assert!(
        prompts
            .iter()
            .any(|prompt| prompt.text.contains("Password") && !prompt.echo),
        "the password prompt does not echo: {prompts:?}"
    );

    session.disconnect().await.expect("disconnect");
}

#[tokio::test]
async fn keyboard_interactive_can_be_cancelled() {
    let server = server!();
    let handler = Arc::new(TestHandler::answering(Vec::new(), true));
    let config = server.config(
        server.keyboard_interactive_port,
        AuthMethod::KeyboardInteractive,
    );

    let error = expect_failure(
        SshSession::connect(config, handler as Arc<dyn SessionHandler>).await,
        "declining the prompts must fail authentication",
    );

    assert!(
        matches!(error, SshError::AuthCancelled),
        "unexpected error: {error:?}"
    );
}

#[tokio::test]
async fn host_key_rejection_aborts_the_connection() {
    let server = server!();
    let handler = Arc::new(TestHandler::answering(Vec::new(), false));

    let error = expect_failure(
        SshSession::connect(
            server.password_config(),
            handler.clone() as Arc<dyn SessionHandler>,
        )
        .await,
        "a rejected host key must abort",
    );

    assert!(
        matches!(error, SshError::HostKeyRejected),
        "unexpected error: {error:?}"
    );
    assert_eq!(handler.host_keys().len(), 1);
}

#[tokio::test]
async fn shell_round_trip_delivers_output_and_close() {
    let server = server!();
    let (session, shell, sink) = open_shell(&server, 80, 24).await;

    shell
        .write(b"echo hello-from-ssh\r".to_vec())
        .expect("write input");
    wait_for_text(&sink, "hello-from-ssh").await;

    shell.write(b"exit\r".to_vec()).expect("write exit");
    wait_for_close(&sink).await;
    let (exit_status, error) = sink.closed().expect("close event");
    assert_eq!(error, None);
    assert!(
        exit_status.is_none() || exit_status == Some(0),
        "unexpected exit status: {exit_status:?}"
    );

    session.disconnect().await.expect("disconnect");
}

#[tokio::test]
async fn shell_resize_reaches_the_remote_pty() {
    let server = server!();
    let (_session, shell, sink) = open_shell(&server, 80, 24).await;

    shell.write(b"stty size\r".to_vec()).expect("write");
    wait_for_text(&sink, "24 80").await;

    sink.clear();
    shell.resize(100, 40).expect("resize");
    shell.write(b"stty size\r".to_vec()).expect("write");
    wait_for_text(&sink, "40 100").await;
}

#[tokio::test]
async fn shell_preserves_rapid_single_byte_writes() {
    let server = server!();
    let (session, shell, sink) = open_shell(&server, 80, 24).await;
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let path = format!("/tmp/ssh-core-byte-order-{}-{unique}", std::process::id());
    let payload: Vec<u8> = (0..16_384).map(|index| b'!' + (index % 90) as u8).collect();
    let command = format!(
        "stty -echo -icanon; printf '\\nSSH_CORE_READY\\n'; head -c {} > {path}; stty sane; printf '\\nSSH_CORE_DONE\\n'\r",
        payload.len()
    );
    shell.write(command.into_bytes()).expect("start receiver");
    wait_for_text(&sink, "\r\nSSH_CORE_READY\r\n").await;

    for (index, byte) in payload.iter().enumerate() {
        shell.write(vec![*byte]).expect("single-byte write");
        if index % 128 == 0 {
            shell.resize(80 + (index % 20) as u32, 24).expect("resize");
        }
    }
    wait_for_text(&sink, "\r\nSSH_CORE_DONE\r\n").await;
    let received = session
        .exec(format!("cat {path}; rm -f {path}"))
        .await
        .expect("read received bytes");
    assert_eq!(received.exit_status, Some(0));
    assert_eq!(received.stdout, payload);

    shell.write(b"exit\r".to_vec()).expect("exit");
    wait_for_close(&sink).await;
    assert!(
        matches!(shell.write(vec![b'x']), Err(SshError::ChannelClosed { .. })),
        "writes after remote close must fail"
    );
    session.disconnect().await.expect("disconnect");
}

#[tokio::test]
async fn exec_reports_stdout_stderr_and_exit_status() {
    let server = server!();
    let (session, _handler) = password_session(&server).await;

    let result = session
        .exec("sh -c 'echo out; echo err >&2; exit 7'".to_string())
        .await
        .expect("exec");

    assert_eq!(String::from_utf8_lossy(&result.stdout).trim(), "out");
    assert_eq!(String::from_utf8_lossy(&result.stderr).trim(), "err");
    assert_eq!(result.exit_status, Some(7));

    session.disconnect().await.expect("disconnect");
}

#[tokio::test]
async fn keepalive_keeps_an_idle_session_connected() {
    let server = server!();
    let mut config = server.password_config();
    config.keepalive_interval_s = 1;
    let handler = Arc::new(TestHandler::accepting());

    let session = SshSession::connect(config, handler.clone() as Arc<dyn SessionHandler>)
        .await
        .expect("session");

    tokio::time::sleep(Duration::from_secs(65)).await;

    let result = session
        .exec("echo alive".to_string())
        .await
        .expect("the session survives 65 idle seconds");
    assert_eq!(String::from_utf8_lossy(&result.stdout).trim(), "alive");
    assert_eq!(
        handler.disconnects.load(Ordering::SeqCst),
        0,
        "the server must not have dropped the session"
    );

    session.disconnect().await.expect("disconnect");
}

#[tokio::test]
async fn connect_timeout_bounds_a_silent_listener() {
    let server = server!();
    let mut config = server.password_config();
    config.port = server.silent_port;
    config.connect_timeout_ms = 1_500;
    let handler = Arc::new(TestHandler::accepting());

    let started = tokio::time::Instant::now();
    let error = expect_failure(
        SshSession::connect(config, handler as Arc<dyn SessionHandler>).await,
        "a listener that never speaks SSH must time out",
    );
    let waited = started.elapsed();

    assert!(
        matches!(error, SshError::Timeout { .. }),
        "unexpected error: {error:?}"
    );
    assert!(
        waited < Duration::from_secs(10),
        "the timeout fired after {waited:?}"
    );
}
