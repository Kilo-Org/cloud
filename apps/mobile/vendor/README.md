# Vendored dependencies

## pylon-react-native-chat

Pylon's React Native chat widget SDK, vendored because it is not published to npm
and its git `prepare` step fails under pnpm (upstream peer-dependency conflict).

- **Upstream**: https://github.com/pylon-labs/sdk-mobile (`react-native/` subdirectory)
- **Commit**: `7ec8150240da02a9417a494d2840ee68d6e2a3c9`
- **Built with**: `npm install --legacy-peer-deps && npm run prepare` in `react-native/`,
  then the `npm pack` contents were committed here. `scripts` and `devDependencies`
  were removed from `package.json` so pnpm never tries to rebuild it; `lib/` is the
  prebuilt output.

### Kilo patches (search for "Kilo patch")

- `ios/RNPylonChatFabricView.mm`: `+shouldBeRecycled` returns `NO` — Fabric view
  recycling leaves the WebView-backed view permanently stuck after a remount.

To update: clone upstream at a new commit, build as above, re-apply the patches,
and bump the `-kilo.N` version suffix in `package.json`.
