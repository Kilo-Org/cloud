#!/usr/bin/env bash
#
# Builds libssh_core.so for the given Android ABIs and generates the Kotlin
# bindings that the module compiles against.
#
# Usage: build-android.sh [abi...]
#   The ABIs are Gradle ABI names (armeabi-v7a, arm64-v8a, x86, x86_64); the
#   module task passes the app's reactNativeArchitectures. With no argument the
#   four the React Native template packages are built.
#
# Requires: rustup, cargo, an Android SDK with the NDK installed (ANDROID_HOME
# or ANDROID_SDK_ROOT, or ANDROID_NDK_HOME set explicitly).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./ensure-rust.sh
source "$SCRIPT_DIR/ensure-rust.sh"

ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUST_DIR="$ROOT/rust"
MANIFEST="$RUST_DIR/Cargo.toml"
BINDGEN_MANIFEST="$RUST_DIR/uniffi-bindgen/Cargo.toml"
UNIFFI_CONFIG="$RUST_DIR/uniffi-bindgen.toml"
JNI_DIR="$ROOT/android/src/main/jniLibs"
KOTLIN_SRC_DIR="$ROOT/android/src/main/java"
KOTLIN_PACKAGE_DIR="$KOTLIN_SRC_DIR/ai/kilo/reactnativessh/uniffi"
ANDROID_API=24

rust_target() {
  case "$1" in
    armeabi-v7a) echo "armv7-linux-androideabi" ;;
    arm64-v8a) echo "aarch64-linux-android" ;;
    x86) echo "i686-linux-android" ;;
    x86_64) echo "x86_64-linux-android" ;;
    *)
      echo "Unknown Android ABI: $1" >&2
      exit 1
      ;;
  esac
}

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

if [[ "$#" -gt 0 ]]; then
  ABIS=("$@")
else
  ABIS=(armeabi-v7a arm64-v8a x86 x86_64)
fi

TARGETS=()
NDK_FLAGS=()
for abi in "${ABIS[@]}"; do
  TARGETS+=("$(rust_target "$abi")")
  NDK_FLAGS+=(--target "$abi")
done

echo "==> Installing Rust targets for Android: ${TARGETS[*]}"
rustup target add "${TARGETS[@]}"

if ! command -v cargo-ndk >/dev/null 2>&1; then
  echo "==> Installing cargo-ndk"
  cargo install cargo-ndk --locked
fi

export ANDROID_NDK_HOME="$(resolve_ndk)"
echo "==> Using NDK $ANDROID_NDK_HOME"

echo "==> Building libssh_core.so for ${ABIS[*]}"
rm -rf "$JNI_DIR"
# cargo-ndk reads Cargo.toml from the working directory before it applies flags.
(
  cd "$RUST_DIR"
  cargo ndk \
    "${NDK_FLAGS[@]}" \
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