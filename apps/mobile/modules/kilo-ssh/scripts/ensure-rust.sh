#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"
export RUSTUP_TOOLCHAIN
RUSTUP_TOOLCHAIN=$(sed -n 's/^channel = "\(.*\)"/\1/p' "$(dirname "${BASH_SOURCE[0]}")/../rust-toolchain.toml")

if ! command -v rustup >/dev/null 2>&1; then
  (
    rustup_version=1.28.2
    case "$(uname -s):$(uname -m)" in
      Darwin:arm64) host=aarch64-apple-darwin ;;
      Darwin:x86_64) host=x86_64-apple-darwin ;;
      Linux:aarch64) host=aarch64-unknown-linux-gnu ;;
      Linux:x86_64) host=x86_64-unknown-linux-gnu ;;
      *) echo "Unsupported rustup host: $(uname -s):$(uname -m)" >&2; exit 1 ;;
    esac
    temporary=$(mktemp -d)
    trap 'rm -rf "$temporary"' EXIT
    url="https://static.rust-lang.org/rustup/archive/$rustup_version/$host/rustup-init"
    echo "==> Installing rustup $rustup_version for $host"
    curl --proto '=https' --tlsv1.2 -fsS "$url" -o "$temporary/rustup-init"
    curl --proto '=https' --tlsv1.2 -fsS "$url.sha256" -o "$temporary/rustup-init.sha256"
    read -r expected _ < "$temporary/rustup-init.sha256"
    if [[ ! "$expected" =~ ^[[:xdigit:]]{64}$ ]]; then
      echo "Invalid rustup checksum" >&2
      exit 1
    fi
    if command -v sha256sum >/dev/null 2>&1; then
      actual=$(sha256sum "$temporary/rustup-init")
    else
      actual=$(shasum -a 256 "$temporary/rustup-init")
    fi
    if [[ "${actual%% *}" != "$expected" ]]; then
      echo "rustup checksum mismatch" >&2
      exit 1
    fi
    chmod +x "$temporary/rustup-init"
    "$temporary/rustup-init" -y --profile minimal --no-modify-path --default-toolchain "$RUSTUP_TOOLCHAIN"
  )
fi