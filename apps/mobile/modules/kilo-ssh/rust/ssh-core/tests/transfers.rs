//! SFTP, port forwarding and bastion coverage against the containers in
//! `tests/docker`.
//!
//! Like the session suite, every test returns immediately unless the fixture
//! variables are set; the CI job starts the containers and exports them.

mod support;

use std::sync::Arc;

use ssh_core::{
    CancelToken, EntryKind, ForwardConfig, ForwardSink, SessionHandler, SftpClient, SshError,
    SshSession, TransferProgress,
};
use support::{
    RecordingForwardSink, RecordingProgress, Server, TestHandler, echo_server, fixture, local_url,
    password_session, port_or, server, sha256, temp_path, write_file,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const FIFTY_MEGABYTES: usize = 50 * 1024 * 1024;
const MULTI_CHUNK_BYTES: usize = 4 * 1024 * 1024;

async fn sftp(server: &Server) -> (Arc<SshSession>, Arc<SftpClient>) {
    let (session, _handler) = password_session(server).await;
    let sftp = session.open_sftp().await.expect("sftp subsystem");

    (session, sftp)
}

#[tokio::test]
async fn sftp_manages_remote_paths() {
    let server = server!();
    let (session, sftp) = sftp(&server).await;
    let root = format!("/home/user/sftp-{}", std::process::id());
    let _ = sftp.remove_dir(root.clone()).await;

    sftp.mkdir(root.clone()).await.expect("mkdir");
    let created = sftp.stat(root.clone()).await.expect("stat directory");
    assert_eq!(created.kind, EntryKind::Directory);
    assert_eq!(created.name, root.rsplit('/').next().expect("segment"));

    let local = temp_path("notes.txt");
    let digest = write_file(&local, 10);
    let file = format!("{root}/notes.txt");
    let written = sftp
        .upload(local_url(&local), file.clone(), None, CancelToken::new())
        .await
        .expect("upload");
    assert_eq!(written, 10);

    let stored = sftp.stat(file.clone()).await.expect("stat file");
    assert_eq!(stored.kind, EntryKind::File);
    assert_eq!(stored.size, 10);
    assert_eq!(stored.name, "notes.txt");
    assert!(stored.modified_unix.is_some(), "the server reports mtime");
    assert!(stored.permissions.is_some(), "the server reports mode");

    let listed = sftp.list(root.clone()).await.expect("list");
    assert_eq!(listed.len(), 1, "listed {listed:?}");
    assert_eq!(listed[0].name, "notes.txt");
    assert_eq!(listed[0].kind, EntryKind::File);

    let renamed = format!("{root}/renamed.txt");
    sftp.rename(file.clone(), renamed.clone())
        .await
        .expect("rename");
    assert!(
        matches!(sftp.stat(file).await, Err(SshError::NotFound { .. })),
        "the old name is gone"
    );
    assert_eq!(
        sftp.stat(renamed.clone()).await.expect("stat renamed").name,
        "renamed.txt"
    );

    let resolved = sftp.realpath(root.clone()).await.expect("realpath");
    assert_eq!(resolved, root);

    let downloaded = temp_path("notes-download.txt");
    let read = sftp
        .download(
            renamed.clone(),
            local_url(&downloaded),
            None,
            CancelToken::new(),
        )
        .await
        .expect("download");
    assert_eq!(read, 10);
    assert_eq!(
        sha256(&downloaded),
        digest,
        "the bytes round-trip unchanged"
    );

    let denied = sftp.mkdir("/etc/ssh-core-denied".to_string()).await;
    assert_eq!(
        denied.expect_err("the user cannot write /etc").category(),
        "PermissionDenied"
    );

    sftp.remove_file(renamed).await.expect("remove file");
    sftp.remove_dir(root.clone())
        .await
        .expect("remove directory");
    assert!(
        matches!(sftp.stat(root).await, Err(SshError::NotFound { .. })),
        "the directory is gone"
    );

    sftp.shutdown().await.expect("shutdown");
    session.disconnect().await.expect("disconnect");
}

#[tokio::test]
async fn sftp_transfers_fifty_megabytes_with_monotonic_progress() {
    let server = server!();
    let (session, sftp) = sftp(&server).await;
    let local = temp_path("upload-50m.bin");
    let digest = write_file(&local, FIFTY_MEGABYTES);
    let remote = format!("/home/user/upload-{}.bin", std::process::id());

    let upload_progress = Arc::new(RecordingProgress::new());
    let uploaded = sftp
        .upload(
            local_url(&local),
            remote.clone(),
            Some(Arc::clone(&upload_progress) as Arc<dyn TransferProgress>),
            CancelToken::new(),
        )
        .await
        .expect("upload 50 MB");
    assert_eq!(uploaded as usize, FIFTY_MEGABYTES);
    assert_monotonic(&upload_progress, FIFTY_MEGABYTES as u64);

    let stored = sftp.stat(remote.clone()).await.expect("stat 50 MB");
    assert_eq!(stored.size, FIFTY_MEGABYTES as u64);

    let downloaded = temp_path("download-50m.bin");
    let download_progress = Arc::new(RecordingProgress::new());
    let read = sftp
        .download(
            remote.clone(),
            local_url(&downloaded),
            Some(Arc::clone(&download_progress) as Arc<dyn TransferProgress>),
            CancelToken::new(),
        )
        .await
        .expect("download 50 MB");
    assert_eq!(read as usize, FIFTY_MEGABYTES);
    assert_monotonic(&download_progress, FIFTY_MEGABYTES as u64);
    assert_eq!(
        sha256(&downloaded),
        digest,
        "the download matches the upload"
    );

    sftp.remove_file(remote).await.expect("remove 50 MB");
    sftp.shutdown().await.expect("shutdown");
    session.disconnect().await.expect("disconnect");
}

#[tokio::test]
async fn cancelling_an_upload_leaves_no_remote_file() {
    let server = server!();
    let (session, sftp) = sftp(&server).await;
    let local = temp_path("cancelled.bin");
    write_file(&local, MULTI_CHUNK_BYTES);
    let remote = format!("/home/user/cancelled-{}.bin", std::process::id());
    let token = CancelToken::new();
    let progress = Arc::new(RecordingProgress::cancelling_on_report(
        1,
        Arc::clone(&token),
    ));

    let error = sftp
        .upload(
            local_url(&local),
            remote.clone(),
            Some(progress as Arc<dyn TransferProgress>),
            token,
        )
        .await
        .expect_err("the cancelled upload fails");

    assert_eq!(error.category(), "Cancelled", "{error:?}");
    assert!(
        matches!(
            sftp.stat(remote.clone()).await,
            Err(SshError::NotFound { .. })
        ),
        "an interrupted upload leaves no file at the destination"
    );
    assert!(
        matches!(
            sftp.stat(format!("{remote}.part")).await,
            Err(SshError::NotFound { .. })
        ),
        "the staging file is removed"
    );

    sftp.shutdown().await.expect("shutdown");
    session.disconnect().await.expect("disconnect");
}

fn assert_monotonic(progress: &RecordingProgress, total: u64) {
    let reports = progress.reports();
    assert!(
        reports.len() > 1,
        "progress reported {} times",
        reports.len()
    );

    let mut last = 0;
    for (transferred, reported_total) in &reports {
        assert!(*transferred >= last, "progress went backwards: {reports:?}");
        assert_eq!(
            *reported_total,
            Some(total),
            "every report carries the total"
        );
        last = *transferred;
    }
    assert_eq!(last, total, "the last report is the full size");
}

#[tokio::test]
async fn a_local_forward_reaches_the_server_network() {
    let server = server!();
    let http_host = fixture!("SSH_TEST_HTTP_HOST");
    let http_port = port_or("SSH_TEST_HTTP_PORT", 8080);
    let handler = Arc::new(TestHandler::accepting());
    let session = SshSession::connect(server.password_config(), handler as Arc<dyn SessionHandler>)
        .await
        .expect("password session");
    let events = Arc::new(RecordingForwardSink::default());
    let forward = session
        .start_local_forward(
            ForwardConfig {
                bind_host: "127.0.0.1".to_string(),
                bind_port: 0,
                dest_host: http_host,
                dest_port: http_port,
            },
            Arc::clone(&events) as Arc<dyn ForwardSink>,
        )
        .await
        .expect("local forward");
    assert_ne!(
        forward.actual_port(),
        0,
        "the operating system picked a port"
    );

    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", forward.actual_port()))
        .await
        .expect("connect through the forward");
    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n")
        .await
        .expect("request");
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.expect("response");
    let response = String::from_utf8_lossy(&response).to_string();
    assert!(response.contains("hello"), "response: {response:?}");

    forward.stop().await.expect("stop");
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", forward.actual_port()))
            .await
            .is_err(),
        "stop closes the listener"
    );
    assert!(events.messages().is_empty(), "{:?}", events.messages());
    session.disconnect().await.expect("disconnect");
}

#[tokio::test]
async fn a_remote_forward_reaches_a_device_server() {
    let server = server!();
    let bind_port = fixture!("SSH_TEST_REMOTE_FORWARD_PORT")
        .parse()
        .expect("SSH_TEST_REMOTE_FORWARD_PORT is a port");
    let (echo_port, echo_task) = echo_server().await;
    let handler = Arc::new(TestHandler::accepting());
    let session = SshSession::connect(server.password_config(), handler as Arc<dyn SessionHandler>)
        .await
        .expect("password session");
    let events = Arc::new(RecordingForwardSink::default());
    let forward = session
        .start_remote_forward(
            ForwardConfig {
                bind_host: "0.0.0.0".to_string(),
                bind_port,
                dest_host: "127.0.0.1".to_string(),
                dest_port: echo_port,
            },
            Arc::clone(&events) as Arc<dyn ForwardSink>,
        )
        .await
        .expect("remote forward");
    assert_eq!(forward.actual_port(), bind_port);

    let mut stream = tokio::net::TcpStream::connect((server.host.as_str(), bind_port))
        .await
        .expect("connect to the server's listener");
    let payload = b"ping over the forward";
    stream.write_all(payload).await.expect("write");
    let mut echoed = vec![0u8; payload.len()];
    stream.read_exact(&mut echoed).await.expect("read");
    assert_eq!(echoed, payload, "the device echo server answered");
    drop(stream);

    forward.stop().await.expect("stop");
    assert!(events.messages().is_empty(), "{:?}", events.messages());
    echo_task.abort();
    session.disconnect().await.expect("disconnect");
}

#[tokio::test]
async fn a_bastion_reaches_a_host_only_it_can_see() {
    let server = server!();
    let bastion_port = fixture!("SSH_TEST_BASTION_PORT")
        .parse()
        .expect("SSH_TEST_BASTION_PORT is a port");
    let target_host =
        std::env::var("SSH_TEST_TARGET_HOST").unwrap_or_else(|_| "target".to_string());
    let target_port = port_or("SSH_TEST_TARGET_PORT", 2222);

    let mut bastion_config = server.password_config();
    bastion_config.port = bastion_port;
    let handler = Arc::new(TestHandler::accepting());
    let bastion = SshSession::connect(
        bastion_config,
        Arc::clone(&handler) as Arc<dyn SessionHandler>,
    )
    .await
    .expect("bastion session");

    let mut target_config = server.password_config();
    target_config.host = target_host;
    target_config.port = target_port;
    let handler = Arc::new(TestHandler::accepting());
    let target = SshSession::connect_via(
        Arc::clone(&bastion),
        target_config,
        handler as Arc<dyn SessionHandler>,
    )
    .await
    .expect("the target is reachable through the bastion");

    let result = target
        .exec("echo through-the-bastion".to_string())
        .await
        .expect("exec through the bastion");
    assert_eq!(
        String::from_utf8_lossy(&result.stdout).trim(),
        "through-the-bastion"
    );

    let sftp = target.open_sftp().await.expect("sftp through the bastion");
    let entries = sftp.list("/home/user".to_string()).await.expect("list");
    assert!(
        entries.iter().any(|entry| entry.name == ".ssh"),
        "listed {entries:?}"
    );
    sftp.shutdown().await.expect("shutdown");

    if let Ok(third_host) = std::env::var("SSH_TEST_THIRD_HOP_HOST") {
        let mut third_config = server.password_config();
        third_config.host = third_host;
        third_config.port = port_or("SSH_TEST_THIRD_HOP_PORT", 2222);
        let handler = Arc::new(TestHandler::accepting());
        let third = SshSession::connect_via(
            Arc::clone(&target),
            third_config,
            handler as Arc<dyn SessionHandler>,
        )
        .await
        .expect("a chain of two bastions composes");
        let result = third
            .exec("echo three-hops".to_string())
            .await
            .expect("exec");
        assert_eq!(String::from_utf8_lossy(&result.stdout).trim(), "three-hops");
        third.disconnect().await.expect("disconnect");
    }

    target.disconnect().await.expect("disconnect");
    bastion.disconnect().await.expect("disconnect");
}
