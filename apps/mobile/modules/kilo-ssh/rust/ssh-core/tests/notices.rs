//! Keeps the licence notices of the crates statically linked into the shipped
//! binaries in step with the dependency graph.
//!
//! `RUST_THIRD_PARTY_NOTICES.md` ships with the app: `libssh_core.so` and
//! `libssh_core.a` contain every crate `ssh-core` links, so their notices and
//! licences travel with it. The table is generated from
//! `cargo metadata --format-version 1`, which is why this test compares the two
//! rather than trusting the file.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Command;

use serde_json::Value;

const NOTICES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../RUST_THIRD_PARTY_NOTICES.md"
);

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct Crate {
    name: String,
    version: String,
    license: String,
    repository: String,
}

impl Crate {
    fn row(&self) -> String {
        format!(
            "| `{}` | `{}` | {} | {} |",
            self.name, self.version, self.license, self.repository
        )
    }
}

fn metadata() -> Value {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let output = Command::new(env!("CARGO"))
        .args([
            "metadata",
            "--format-version",
            "1",
            "--locked",
            "--manifest-path",
        ])
        .arg(&manifest)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("run cargo metadata");

    assert!(
        output.status.success(),
        "cargo metadata failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    serde_json::from_slice(&output.stdout).expect("parse cargo metadata")
}

/// Every crate the ssh-core library links at run time: normal dependencies of
/// the library, transitively. Dev and build dependencies are not shipped.
fn shipped_crates(metadata: &Value) -> BTreeSet<Crate> {
    let packages = metadata["packages"]
        .as_array()
        .expect("packages")
        .iter()
        .map(|package| {
            (
                package["id"].as_str().expect("package id").to_string(),
                package.clone(),
            )
        })
        .collect::<BTreeMap<_, _>>();

    let root = packages
        .values()
        .find(|package| package["name"] == "ssh-core")
        .expect("the workspace resolves ssh-core")
        .clone();
    let root_id = root["id"].as_str().expect("package id").to_string();

    let mut shipped = BTreeSet::new();
    let mut pending = vec![root_id];
    while let Some(id) = pending.pop() {
        if !shipped.insert(id.clone()) {
            continue;
        }

        let Some(node) = metadata["resolve"]["nodes"]
            .as_array()
            .expect("resolve nodes")
            .iter()
            .find(|node| node["id"] == id)
        else {
            continue;
        };

        for dependency in node["deps"].as_array().expect("deps") {
            let runtime = dependency["dep_kinds"]
                .as_array()
                .expect("dep kinds")
                .iter()
                .any(|kind| kind["kind"].is_null());
            if !runtime {
                continue;
            }

            pending.push(
                dependency["pkg"]
                    .as_str()
                    .expect("dependency package id")
                    .to_string(),
            );
        }
    }

    shipped
        .into_iter()
        .map(|id| {
            let package = &packages[&id];
            Crate {
                name: package["name"].as_str().expect("name").to_string(),
                version: package["version"].as_str().expect("version").to_string(),
                license: package["license"]
                    .as_str()
                    .unwrap_or("unstated")
                    .to_string(),
                repository: package["repository"]
                    .as_str()
                    .unwrap_or("https://crates.io/crates/")
                    .to_string(),
            }
        })
        .filter(|krate| krate.name != "ssh-core")
        .collect()
}

fn notices_crates(markdown: &str) -> BTreeSet<Crate> {
    markdown
        .lines()
        .filter_map(|line| {
            let (name, rest) = line.strip_prefix("| `")?.split_once("` | `")?;
            let (version, rest) = rest.split_once("` | ")?;
            let (license, repository) = rest.split_once(" | ")?;

            Some(Crate {
                name: name.to_string(),
                version: version.to_string(),
                license: license.to_string(),
                repository: repository.trim_end_matches(" |").to_string(),
            })
        })
        .collect()
}

#[test]
fn the_notices_list_every_shipped_crate() {
    let metadata = metadata();
    let expected = shipped_crates(&metadata);
    let markdown = std::fs::read_to_string(NOTICES)
        .unwrap_or_else(|error| panic!("reading {NOTICES}: {error}"));
    let listed = notices_crates(&markdown);

    if expected == listed {
        return;
    }

    let missing = expected
        .difference(&listed)
        .map(Crate::row)
        .collect::<Vec<_>>();
    let stale = listed
        .difference(&expected)
        .map(Crate::row)
        .collect::<Vec<_>>();

    panic!(
        "RUST_THIRD_PARTY_NOTICES.md is out of date.\n\
         missing rows:\n{}\n\
         rows without a shipped crate:\n{}",
        missing.join("\n"),
        stale.join("\n")
    );
}
