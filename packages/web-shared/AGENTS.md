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
- Runtime code here must only import from this package. `pnpm --filter
  @kilocode/web-shared typecheck` enforces that with `tsconfig.lib.json`, which
  resolves `@/*` to this package only and excludes tests.
- Tests run under the `apps/web` Jest config and may import `apps/web` test
  helpers; `tsconfig.json` falls back to `apps/web/src` for editors and linting.
- Declare every npm import in `package.json` with the same version as
  `apps/web`, including the optional peers that make pnpm resolve the same
  `next` and `@sentry/nextjs` instances as `apps/web`. Two instances of `next`
  break request-scoped APIs such as `headers()`.
