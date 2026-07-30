# pnpm-install-noop-leaves-virtual-store-drift

Symptom: `pnpm install` prints "Already up to date" in <1s and does NOT re-apply
patches or recreate deleted `.pnpm` package dirs — even `pnpm install --force` and
removing `node_modules/.modules.yaml` no-op. Hand-edited files under
`node_modules/.pnpm/<pkg>/` stay edited; deleted package dirs stay deleted (symlinks
dangle), and stale duplicate peer-hash instances (react-native-css, nativewind,
react-native) accumulate and poison Metro bundling (the stale file-map side of
that wedge now self-heals: `pnpm dev:restart mobile` clears it).

Cause: pnpm v11 short-circuits headless install when
`node_modules/.pnpm-workspace-state-v1.json` matches the lockfile; it never
re-verifies virtual-store contents. Patch re-application only happens during a real
(re)link pass.

Fix: `rm -f node_modules/.pnpm-workspace-state-v1.json && pnpm install` forces the
full relink (~1 min, re-applies patches, prunes stale peer-hash instances). Verify
with `xxd`/`cat` on the patched files afterwards. The install does not disturb
running dev services; restart Metro afterwards as cheap insurance.
