# web-shared

Server code shared by `apps/web` and `apps/ai-gateway`, consumed from source.

## Module resolution

- Import modules from this package as `@kilocode/web-shared/<path>`, which maps
  to `src/<path>`, both from consumers and inside this package. Every consumer
  tsconfig, the web Jest config, the `@kilocode/trpc` rollup resolver, and the
  Storybook webpack alias map that specifier. There is no `exports` map:
  specifiers are extensionless, so resolution relies on those mappings.
- `@/` in a consumer means that consumer's own `src`; it never resolves here.
- Runtime code here must only import from this package. `pnpm --filter
  @kilocode/web-shared typecheck` enforces that with `tsconfig.lib.json`, which
  excludes tests and does not map `@/` at all.
- Tests run under the `apps/web` Jest config and may import `apps/web` modules
  and test helpers through `@/`, which `tsconfig.json` maps to `apps/web/src`.
- Declare every npm import in `package.json` with the same version as
  `apps/web`, including the optional peers that make pnpm resolve the same
  `next` and `@sentry/nextjs` instances as `apps/web`. Two instances of `next`
  break request-scoped APIs such as `headers()`.
