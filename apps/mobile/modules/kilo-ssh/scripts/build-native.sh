#!/usr/bin/env bash
#
# Builds the Rust core for the host platform: the xcframework the podspec
# vendors on macOS, and nothing elsewhere. CocoaPods reads vendored_frameworks
# at pod install, so this runs before it: the ios script in apps/mobile, the
# eas-build-post-install hook, and the iOS job of mobile-native-build.yml.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "==> No iOS slice to build on $(uname -s)"
  exit 0
fi

exec bash "$(dirname "${BASH_SOURCE[0]}")/build-ios.sh"