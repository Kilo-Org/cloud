# mobile-metro-file-map-stale-after-node-modules-relayout

Symptom: after a dependency-layout change (e.g. a root patch changes pnpm peer-hash
dirs), the dev client deterministically white-screens and logcat shows
`ReactNativeJS: [runtime not ready]: RangeError: Maximum call stack size exceeded`,
stack `metroRequire` → repeated `get NativeModules@<line>:56`. Metro serves a bundle
in which a proxy module (here `react-native-css/dist/commonjs/components/index.cjs`)
has `require("react-native")` resolved back to itself.

Cause: Metro's jest-haste-map cache in `$TMPDIR/metro-file-map-expo-*` persists per
project root across `pnpm install`s. Stale entries pointing into old `.pnpm` peer-hash
directories still validate while those dirs exist on disk (pnpm keeps them), so the
resolver serves modules from the stale instance and NativeWind's
"am I inside react-native-css?" exclusion misfires.

Fix: identify the project file-map (`grep -ac '<worktree-name>'` the
`$TMPDIR/metro-file-map-expo-*` files — only one matches), delete it, restart Metro
(`pnpm dev:restart mobile`), re-fetch the bundle with a cache-bust query param, and
verify the proxy's dep map points at the real `react-native/index.js` module id.
Never diagnose "the patch broke the app" from a bundle served before this check.
