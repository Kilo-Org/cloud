use ssh_core::{SshError, decrypt_export, encrypt_export};

const PASSPHRASE: &str = "correct horse battery staple";
const CLI_FIXTURE: &str = include_str!("fixtures/age-cli-passphrase.age");
const CLI_FIXTURE_PASSPHRASE: &str = "fixture passphrase 123";
const CLI_FIXTURE_PLAINTEXT: &str = r#"{"version":1,"hosts":[{"host":"example.com","user":"fixture"}],"note":"made by the age CLI"}"#;

fn payload() -> String {
    r#"{"version":1,"hosts":[{"host":"example.com","port":22,"user":"игорь"}],"note":"round trip"}"#
        .to_string()
}

fn tamper(armored: &str) -> String {
    let mut bytes: Vec<u8> = armored.as_bytes().to_vec();
    let start = bytes.len() * 3 / 4;
    let index = (start..bytes.len())
        .find(|&index| bytes[index].is_ascii_alphanumeric() && bytes[index] != b'-')
        .expect("the armor body is not empty");

    bytes[index] = if bytes[index] == b'A' { b'B' } else { b'A' };

    String::from_utf8(bytes).expect("the armor is UTF-8")
}

#[test]
fn round_trip_returns_the_payload() {
    let armored = encrypt_export(payload(), PASSPHRASE.to_string()).expect("encrypts");

    let decrypted = decrypt_export(armored, PASSPHRASE.to_string()).expect("decrypts");

    assert_eq!(decrypted, payload());
}

#[test]
fn output_is_ascii_armor() {
    let armored = encrypt_export(payload(), PASSPHRASE.to_string()).expect("encrypts");

    assert!(armored.starts_with("-----BEGIN AGE ENCRYPTED FILE-----\n"));
    assert!(armored.ends_with("-----END AGE ENCRYPTED FILE-----\n"));
}

#[test]
fn wrong_passphrase_is_reported() {
    let armored = encrypt_export(payload(), PASSPHRASE.to_string()).expect("encrypts");

    let error =
        decrypt_export(armored, "wrong horse battery staple".to_string()).expect_err("fails");

    assert!(matches!(error, SshError::WrongPassphrase), "{error:?}");
    assert_eq!(error.category(), "WrongPassphrase");
}

#[test]
fn tampered_file_is_invalid() {
    let armored = encrypt_export(payload(), PASSPHRASE.to_string()).expect("encrypts");

    let error = decrypt_export(tamper(&armored), PASSPHRASE.to_string()).expect_err("fails");

    assert!(matches!(error, SshError::InvalidExport { .. }), "{error:?}");
    assert_eq!(error.category(), "InvalidExport");
}

#[test]
fn truncated_file_is_invalid() {
    let armored = encrypt_export(payload(), PASSPHRASE.to_string()).expect("encrypts");
    let truncated = armored[..armored.len() - 40].to_string();

    let error = decrypt_export(truncated, PASSPHRASE.to_string()).expect_err("fails");

    assert!(matches!(error, SshError::InvalidExport { .. }), "{error:?}");
}

#[test]
fn non_age_input_is_invalid() {
    for input in ["", "{\"version\":1}", "not an age file at all"] {
        let error = decrypt_export(input.to_string(), PASSPHRASE.to_string()).expect_err("fails");

        assert!(
            matches!(error, SshError::InvalidExport { .. }),
            "{input:?}: {error:?}"
        );
    }
}

#[test]
fn short_passphrase_is_rejected() {
    let error = encrypt_export(payload(), "1234567".to_string()).expect_err("fails");

    assert!(matches!(error, SshError::InvalidExport { .. }), "{error:?}");
    assert!(error.to_string().contains('8'), "{error}");
}

#[test]
fn oversized_payload_is_rejected() {
    let oversized = "a".repeat(16 * 1024 * 1024 + 1);

    let error = encrypt_export(oversized, PASSPHRASE.to_string()).expect_err("fails");

    assert!(matches!(error, SshError::InvalidExport { .. }), "{error:?}");
    assert!(error.to_string().contains("16777216"), "{error}");
}

#[test]
fn cli_made_file_decrypts() {
    let decrypted = decrypt_export(CLI_FIXTURE.to_string(), CLI_FIXTURE_PASSPHRASE.to_string())
        .expect("decrypts");

    assert_eq!(decrypted, CLI_FIXTURE_PLAINTEXT);
}

#[cfg(target_os = "linux")]
#[test]
fn our_file_decrypts_with_the_age_cli() {
    use std::process::Command;

    if Command::new("age").arg("--version").output().is_err() {
        eprintln!("skipping: the age CLI is not installed");

        return;
    }

    let armored = encrypt_export(CLI_FIXTURE_PLAINTEXT.to_string(), PASSPHRASE.to_string())
        .expect("encrypts");
    let path = std::env::temp_dir().join(format!("ssh-core-export-{}.age", std::process::id()));
    std::fs::write(&path, armored).expect("writes the export");

    let output = decrypt_with_cli(&path);

    let _ = std::fs::remove_file(&path);

    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(
        output.status.success(),
        "age -d failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        stdout.contains(CLI_FIXTURE_PLAINTEXT),
        "age -d returned {stdout:?}"
    );
}

#[cfg(target_os = "linux")]
fn decrypt_with_cli(path: &std::path::Path) -> std::process::Output {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let command = format!("age -d {}", path.display());

    let mut child = Command::new("script")
        .args(["-q", "-e", "-c", &command, "/dev/null"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("starts the age CLI on a pty");

    child
        .stdin
        .as_mut()
        .expect("a piped stdin")
        .write_all(format!("{PASSPHRASE}\n").as_bytes())
        .expect("types the passphrase");

    child.wait_with_output().expect("waits for the age CLI")
}
