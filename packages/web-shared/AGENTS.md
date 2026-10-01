# web-shared

Server code shared by `apps/web` and `apps/ai-gateway`. The code was moved out of
`apps/web/src` without changing its `@/` import specifiers.

## Module resolution

- Import modules from this package as `@kilocode/web-shared/<path>`, which maps
  to `src/<path>`, both from consumers and inside this package. Every consumer
  tsconfig, the web Jest config, the `@kilocode/trpc` rollup resolver, and the
  Storybook webpack alias map that specifier. Consumers still reach these
  modules through the `@/` fallback below until their imports move over.
- Consumers map `@/*` to their own `src/*` first and to `packages/web-shared/src/*`
  second. Keep both entries in sync in every tsconfig, the web Jest config, the
  `@kilocode/trpc` rollup resolver, and the Storybook webpack alias.
- A path must exist in only one of `apps/web/src` and `packages/web-shared/src`.
  A duplicate silently shadows the web-shared file inside `apps/web`.
- Nothing here, tests included, imports from `apps/web`. `pnpm --filter
  @kilocode/web-shared typecheck` checks runtime code with `tsconfig.lib.json`
  (no tests, no Jest types) and everything with `tsconfig.json`; neither maps
  `@/`. An oxlint rule also rejects `@/` and relative `apps/web` imports.
- Tests run under the `apps/web` Jest config, which provides the database
  setup. Shared test helpers live in `src/tests/helpers` and `apps/web` tests
  import them as `@kilocode/web-shared/tests/helpers/<name>`. A test case that
  needs `apps/web` code belongs in `apps/web`, next to that code.
- Declare every npm import in `package.json` with the same version as
  `apps/web`, including the optional peers that make pnpm resolve the same
  `next` and `@sentry/nextjs` instances as `apps/web`. Two instances of `next`
  break request-scoped APIs such as `headers()`.
