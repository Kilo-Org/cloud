#!/usr/bin/env bash
#
# Makes cargo available to a build host. rust-toolchain.toml pins the channel,
# components and targets; rustup installs them on first use. EAS images and a
# bare macOS install neither ship rustup nor put it on PATH, so both build
# scripts source this file and the EAS pre-install hook runs it.
set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"

if ! command -v rustup >/dev/null 2>&1; then
  echo "==> Installing rustup"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
    sh -s -- -y --profile minimal --no-modify-path
fi