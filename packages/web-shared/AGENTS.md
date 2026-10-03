# web-shared

Server code shared by `apps/web` and `apps/ai-gateway`. The code was moved out of
`apps/web/src` without changing its `@/` import specifiers.

## Module resolution

- Consumers map `@/*` to their own `src/*` first and to `packages/web-shared/src/*`
  second. Keep both entries in sync in every tsconfig, the web Jest config, the
  `@kilocode/trpc` rollup resolver, and the Storybook webpack alias.
- A path must exist in only one of `apps/web/src` and `packages/web-shared/src`.
  A duplicate silently shadows the web-shared file inside `apps/web`.
- Code here, including tests and `src/tests/helpers`, must only import from this
  package; `@/*` resolves to this package only. `pnpm --filter
  @kilocode/web-shared typecheck` enforces that with `tsconfig.lib.json` for
  runtime code (tests and helpers excluded) and `tsconfig.json` for everything.
- Tests run under the `apps/web` Jest config. A test that needs `apps/web` code
  belongs in `apps/web/src`, which can import from both.
- Declare every npm import in `package.json` with the same version as
  `apps/web`, including the optional peers that make pnpm resolve the same
  `next` and `@sentry/nextjs` instances as `apps/web`. Two instances of `next`
  break request-scoped APIs such as `headers()`.
