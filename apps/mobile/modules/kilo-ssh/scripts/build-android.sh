#!/usr/bin/env bash
#
# Builds libssh_core.so for the Android ABIs the example app ships and generates
# the Kotlin bindings that the module compiles against.
#
# Requires: rustup, cargo, a JDK-free Android SDK with the NDK installed
# (ANDROID_HOME or ANDROID_SDK_ROOT, or ANDROID_NDK_HOME set explicitly).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUST_DIR="$ROOT/rust"
MANIFEST="$RUST_DIR/Cargo.toml"
BINDGEN_MANIFEST="$RUST_DIR/uniffi-bindgen/Cargo.toml"
UNIFFI_CONFIG="$RUST_DIR/uniffi-bindgen.toml"
JNI_DIR="$ROOT/android/src/main/jniLibs"
KOTLIN_SRC_DIR="$ROOT/android/src/main/java"
KOTLIN_PACKAGE_DIR="$KOTLIN_SRC_DIR/ai/kilo/reactnativessh/uniffi"
ANDROID_API=24

resolve_ndk() {
  if [[ -n "${ANDROID_NDK_HOME:-}" ]]; then
    echo "$ANDROID_NDK_HOME"
    return
  fi
  local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  if [[ -z "$sdk" && -d "$HOME/Library/Android/sdk" ]]; then
    sdk="$HOME/Library/Android/sdk"
  fi
  if [[ -z "$sdk" || ! -d "$sdk/ndk" ]]; then
    echo "No NDK found: set ANDROID_NDK_HOME or ANDROID_HOME" >&2
    exit 1
  fi
  find "$sdk/ndk" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1
}

host_library() {
  local ext
  case "$(uname -s)" in
    Darwin) ext="dylib" ;;
    *) ext="so" ;;
  esac
  echo "$RUST_DIR/target/release/libssh_core.$ext"
}

echo "==> Installing Rust targets for Android"
rustup target add aarch64-linux-android x86_64-linux-android

if ! command -v cargo-ndk >/dev/null 2>&1; then
  echo "==> Installing cargo-ndk"
  cargo install cargo-ndk --locked
fi

export ANDROID_NDK_HOME="$(resolve_ndk)"
echo "==> Using NDK $ANDROID_NDK_HOME"

echo "==> Building libssh_core.so for arm64-v8a and x86_64"
rm -rf "$JNI_DIR"
# cargo-ndk reads Cargo.toml from the working directory before it applies flags.
(
  cd "$RUST_DIR"
  cargo ndk \
    --target arm64-v8a \
    --target x86_64 \
    --platform "$ANDROID_API" \
    --output-dir "$JNI_DIR" \
    build --package ssh-core --release
)

echo "==> Building a host library for the bindings generator"
cargo build --manifest-path "$MANIFEST" --package ssh-core --release

echo "==> Generating Kotlin bindings into ${KOTLIN_PACKAGE_DIR#"$ROOT"/}"
rm -rf "$KOTLIN_PACKAGE_DIR"
cargo run --quiet \
  --manifest-path "$BINDGEN_MANIFEST" \
  --bin uniffi-bindgen -- \
  generate "$(host_library)" \
  --language kotlin \
  --out-dir "$KOTLIN_SRC_DIR" \
  --config "$UNIFFI_CONFIG" \
  --no-format

echo "==> Artifacts"
find "$JNI_DIR" -name '*.so' -exec ls -l {} +
find "$KOTLIN_PACKAGE_DIR" -name '*.kt' -exec ls -l {} +
