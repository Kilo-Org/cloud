// Thin re-export so Metro can resolve this module at runtime through the
// standard `@/*` → `./src/*` alias. The actual type + predicate live in
// apps/web/src/lib/kiloclaw/instance-not-running-sentinel.ts — single
// source of truth, no copy/paste sync risk.
//
// Why this file exists: tsconfig path aliases work at typecheck time, but
// Metro only honors the explicit `extraNodeModules` and `resolveRequest`
// hooks in metro.config.js. Adding a path-alias entry alone would fail at
// bundle time. A relative-path re-export from inside `src/` resolves
// cleanly because Metro's `watchFolders` already includes the monorepo
// root, so it can follow `../../../../web/src/...`.
export * from '../../../../../apps/web/src/lib/kiloclaw/instance-not-running-sentinel';
