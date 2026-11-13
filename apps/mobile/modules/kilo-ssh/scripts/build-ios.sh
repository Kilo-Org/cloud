#!/usr/bin/env bash
#
# Builds libssh_core.a for iOS (device + simulator) and packages it as
# ios/Frameworks/SshCore.xcframework, then generates the Swift bindings and the
# C module map into ios/Generated.
#
# Requires macOS with Xcode command line tools (lipo, xcodebuild) and rustup.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-ios.sh needs macOS: the SDK, lipo and xcodebuild are Xcode-only" >&2
  exit 1
fi
# shellcheck source=./ensure-rust.sh
source "$SCRIPT_DIR/ensure-rust.sh"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUST_DIR="$ROOT/rust"
MANIFEST="$RUST_DIR/Cargo.toml"
BINDGEN_MANIFEST="$RUST_DIR/uniffi-bindgen/Cargo.toml"
UNIFFI_CONFIG="$RUST_DIR/uniffi-bindgen.toml"
IOS_DIR="$ROOT/ios"
GENERATED_DIR="$IOS_DIR/Generated"
FRAMEWORKS_DIR="$IOS_DIR/Frameworks"
LIPO_DIR="$RUST_DIR/target/ios-lipo"
DEVICE_TARGET="aarch64-apple-ios"
SIM_TARGETS=("aarch64-apple-ios-sim" "x86_64-apple-ios")

echo "==> Installing Rust targets for iOS"
rustup target add "$DEVICE_TARGET" "${SIM_TARGETS[@]}"

echo "==> Building static libraries"
for target in "$DEVICE_TARGET" "${SIM_TARGETS[@]}"; do
  cargo build \
    --manifest-path "$MANIFEST" \
    --package ssh-core \
    --release \
    --target "$target"
done

echo "==> Fusing the simulator slices"
mkdir -p "$LIPO_DIR" "$GENERATED_DIR" "$FRAMEWORKS_DIR"
SIM_LIPO="$LIPO_DIR/libssh_core.a"
lipo -create \
  "$RUST_DIR/target/aarch64-apple-ios-sim/release/libssh_core.a" \
  "$RUST_DIR/target/x86_64-apple-ios/release/libssh_core.a" \
  -output "$SIM_LIPO"

echo "==> Generating Swift bindings into ${GENERATED_DIR#"$ROOT"/}"
# The generator reads the uniffi metadata out of a library it can dlopen, so it
# uses a host build; the generated sources are architecture independent.
cargo build --manifest-path "$MANIFEST" --package ssh-core --release
cargo run --quiet \
  --manifest-path "$BINDGEN_MANIFEST" \
  --bin uniffi-bindgen -- \
  generate "$RUST_DIR/target/release/libssh_core.dylib" \
  --language swift \
  --out-dir "$GENERATED_DIR" \
  --config "$UNIFFI_CONFIG" \
  --no-format

echo "==> Creating SshCore.xcframework"
rm -rf "$FRAMEWORKS_DIR/SshCore.xcframework"
xcodebuild -create-xcframework \
  -library "$RUST_DIR/target/aarch64-apple-ios/release/libssh_core.a" -headers "$GENERATED_DIR" \
  -library "$SIM_LIPO" -headers "$GENERATED_DIR" \
  -output "$FRAMEWORKS_DIR/SshCore.xcframework"

echo "==> Slices"
/usr/libexec/PlistBuddy -c 'Print :AvailableLibraries' "$FRAMEWORKS_DIR/SshCore.xcframework/Info.plist"

echo "==> Artifacts"
find "$FRAMEWORKS_DIR" -name '*.a' -exec ls -l {} +
find "$GENERATED_DIR" -maxdepth 1 -type f -exec ls -l {} +
