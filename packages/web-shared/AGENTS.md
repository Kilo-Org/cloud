# web-shared

Server code shared by `apps/web` and `apps/ai-gateway`, moved out of `apps/web/src`.

## Module resolution

- Import this package as `@kilocode/web-shared/<path under src>`, both from
  consumers and from inside this package. `@/` always means the importing app's
  own `src` and never resolves here.
- `@kilocode/web-shared/*` maps to `packages/web-shared/src/*` in every consumer
  tsconfig, the web Jest config, the `@kilocode/trpc` rollup resolver, and the
  Storybook webpack alias. Keep those entries in sync.
- Code here, including tests and `src/tests/helpers`, must only import from this
  package. `pnpm --filter @kilocode/web-shared typecheck` enforces that with
  `tsconfig.lib.json` for runtime code (tests and helpers excluded) and
  `tsconfig.json` for everything; neither maps `@/`.
- Tests run under the `apps/web` Jest config. A test that needs `apps/web` code
  belongs in `apps/web/src`, which can import from both.
- Declare every npm import in `package.json` with the same version as
  `apps/web`, including the optional peers that make pnpm resolve the same
  `next` and `@sentry/nextjs` instances as `apps/web`. Two instances of `next`
  break request-scoped APIs such as `headers()`.
