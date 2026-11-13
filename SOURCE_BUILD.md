# Building the Kilo Code Firefox extension from source

This archive is the source of the Firefox package submitted to AMO for
`kilo-extension` 1.0.4: commit `2e0871d9e164a9a290dd683c3cc1deb6d8059a84` of
<https://github.com/Kilo-Org/cloud>.

It is a pnpm workspace subset, not the whole monorepo:

- the root workspace files (`package.json`, `pnpm-workspace.yaml`,
  `pnpm-lock.yaml`, `.nvmrc`, `.gitignore`, `patches/`,
  `scripts/check-pnpm.mjs`);
- the complete `apps/extension` build;
- the workspace packages the extension bundles from source:
  `packages/cloud-agent-sdk`, `packages/app-shared`,
  `packages/session-ingest-contracts`;
- the `package.json` of every other workspace project. pnpm resolves the whole
  workspace graph from the workspace file and the lockfile even for a filtered
  install, so those manifests are required; their sources are not.

## Requirements

- Node.js 24.x. The repository pins `24.22.1` in `.nvmrc` and allows `>=24 <25`
  in `engines`.
- pnpm `11.1.2`, installed with Corepack from the root `packageManager` field.
- Network access for the dependency download.
- Verified on Ubuntu 24.04 x86_64. macOS behaves the same way.

## Steps

```sh
mkdir kilo-extension-1.0.4-amo-sources
unzip -q kilo-extension-1.0.4-amo-sources.zip -d kilo-extension-1.0.4-amo-sources
cd kilo-extension-1.0.4-amo-sources

# Corepack links pnpm into /usr/bin, so this one step needs root. Without sudo,
# use `npm install -g pnpm@11.1.2` instead.
sudo corepack enable
corepack prepare pnpm@11.1.2 --activate

# --ignore-scripts skips install hooks. The repository's root `prepare` hook
# builds packages that are not part of this extension, and it cannot run here.
pnpm install --frozen-lockfile --filter kilo-extension... --ignore-scripts

# --config.verify-deps-before-run=false stops pnpm from re-running a full
# workspace install before the script: only the extension's dependencies are
# installed above.
VITE_POSTHOG_API_KEY=... pnpm --filter kilo-extension \
  --config.verify-deps-before-run=false build:firefox
```

The build writes the unpacked extension to:

```
apps/extension/.output/firefox-mv3/
```

Its contents — `manifest.json`, `background.js`, `sidepanel.html`, `chunks/`,
`assets/`, `icon/` — are the files inside the submitted
`kilo-extension-1.0.4-firefox.zip`. To recreate that zip:

```sh
cd apps/extension/.output/firefox-mv3
zip -r -X ../../../../kilo-extension-1.0.4-firefox.zip .
```

## The one build-time input that is not in this archive

`VITE_POSTHOG_API_KEY` is the PostHog write key for the "Kilo Code" project. It
is a public client key that ships inside the release's
`chunks/sidepanel-*.js` bundle, so it can be read back from the submitted
package:

```sh
grep -rho 'phc_[A-Za-z0-9]*' chunks/sidepanel-*.js
```

The release build was made with that value. Set it to the same string and every
rebuilt file is byte-identical to the submitted package. Without it the build
still succeeds and prints `PostHog analytics disabled: VITE_POSTHOG_API_KEY is
not set.` when a signed-in conversation starts, and the analytics client is
never constructed; the only difference is that `chunks/sidepanel-*.js` is 129
bytes smaller because the key string is not inlined. Nothing else about the
extension changes.

## Regenerated, not shipped

`node_modules/`, `apps/extension/.output/`, `apps/extension/.wxt/` and the
Playwright artifacts are not in the archive. `pnpm install` recreates
`node_modules/`, and `wxt build` writes both `.output/` and the `.wxt/`
directory that `apps/extension/tsconfig.json` extends.
