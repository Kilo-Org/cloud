# web-shared

Server code shared by `apps/web` and `apps/ai-gateway`, consumed from source.

## Module resolution

- Import modules from this package as `@kilocode/web-shared/<path>`, which maps
  to `src/<path>`, both from consumers and inside this package. Every consumer
  tsconfig, the web Jest config, the `@kilocode/trpc` rollup resolver, and the
  Storybook webpack alias map that specifier. There is no `exports` map:
  specifiers are extensionless, so resolution relies on those mappings.
- `@/` in a consumer means that consumer's own `src`; it never resolves here.
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
