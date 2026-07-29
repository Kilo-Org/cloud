# mobile-native-build-cache-ignores-root-patches

Symptom: after applying a root-level `patches/` or `pnpm-workspace.yaml` change
(e.g. a `react-native` Hermes pin), `pnpm dev:mobile:android build` /
`pnpm dev:mobile:ios build` still installs a binary that behaves as if the
patch were absent. Easy to conclude "the patch had no effect."

Cause: the Android and iOS native build wrappers key on an `@expo/fingerprint`
hash computed over `apps/mobile` (plus toolchain) only. Root `patches/`,
`pnpm-workspace.yaml`, and `pnpm-lock.yaml` are outside that root, so the
fingerprint is unchanged and a warm
`~/Library/Caches/Kilo/mobile-android-builds` /
`…/mobile-ios-builds` entry is reused.

Fix: force a rebuild by deleting `entries/<key>` for the `key` printed by
`pnpm dev:mobile:android fingerprint` (or `pnpm dev:mobile:ios fingerprint`).
Parse with `pnpm --silent … fingerprint` and slice JSON from the first `{`.
Never conclude a root patch was a no-op from a cached binary. EAS and CI build
from a clean checkout and are unaffected.
