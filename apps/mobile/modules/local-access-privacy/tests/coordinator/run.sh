#!/usr/bin/env bash
# Run from apps/mobile, with an existing output directory outside the product worktree.
# ios:     bash modules/local-access-privacy/tests/coordinator/run.sh ios <output>
# android: bash modules/local-access-privacy/tests/coordinator/run.sh android <output> <kotlin-stdlib.jar> <kotlinc command...>
# These adapters execute the production coordinators, not platform rendering or OS window timing.
set -euo pipefail
platform=${1:?platform is required}
output=${2:?output directory is required}
test -d "$output"
suite=$(dirname "$0")
module="$suite/../.."
case "$platform" in
  ios)
    swiftc -emit-module -emit-library -module-name UIKit "$suite/ios/UIKit.swift" \
      -emit-module-path "$output/UIKit.swiftmodule" -o "$output/libUIKit.dylib"
    swiftc -I "$output" -L "$output" -lUIKit -Xlinker -rpath -Xlinker "$output" \
      "$module/ios/PrivacyVisibilityState.swift" "$module/ios/LocalAccessPrivacy.swift" \
      "$suite/ios/LocalAccessPrivacyCoordinatorTests.swift" -o "$output/coordinator-tests"
    "$output/coordinator-tests"
    ;;
  android)
    runtime=${3:?kotlin-stdlib.jar is required}
    shift 3
    : "${1:?kotlinc command is required}"
    javac -d "$output" "$module/android/src/main/java/expo/modules/localaccessprivacy/PrivacyVisibilityState.java"
    "$@" -no-stdlib -no-reflect -classpath "$output:$runtime" -d "$output" \
      "$module/android/src/main/java/expo/modules/localaccessprivacy/LocalAccessPrivacy.kt" "$suite"/android/*.kt
    java -cp "$output:$runtime" expo.modules.localaccessprivacy.LocalAccessPrivacyCoordinatorTestsKt
    ;;
  *)
    printf 'Unsupported coordinator platform: %s\n' "$platform" >&2
    exit 2
    ;;
esac
