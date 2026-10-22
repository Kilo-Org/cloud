# web-shared

Server code shared by `apps/web` and `apps/ai-gateway`, moved out of `apps/web/src`.
The usage wire contract lives in `@kilocode/usage-contracts`. Import it directly;
`usage-record-contract-alignment.ts` checks alignment with DB types.

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

## AI gateway database access

AI gateway handlers (`src/lib/ai-gateway/**` and everything they call) also run
in `sfo1`, but `db` from `lib/drizzle` always connects to the Frankfurt primary.
Each primary query from `sfo1` is a transatlantic round trip; a transaction is
several.

Read-write (`db`) connections in gateway paths are generally not permissible.
Besides the `sfo1` -> `fra1` latency they add to every request, each one holds a
primary pool connection for the whole round trip, so slow primary access keeps
connections checked out longer and contributes to primary connection pool
exhaustion. Read replica lag is acceptable for authentication and authorization
reads, such as user, API token, and organization lookups; do not switch them to
the primary to avoid it.

Before the upstream inference request is sent:

- Read through `readDb`, which uses the US replica in `sfo1`. Many helpers
  default to `fromDb = db`; pass `readDb` explicitly. Omitting the argument
  silently selects the primary.
- Do not open `db` transactions, take row locks, or write. Defer writes with
  `after()`, or forward them to `fra1` like `recordUsageInPrimaryRegion` does.
- Keep primary access only where correctness needs it (read-after-write, a row
  lock, or an optimistic write such as lazy credit expiry), on a rare path, with
  a comment saying why.
- Shared helpers that the web app also calls keep their primary default and take
  a `fromDb` argument; gateway callers pass `readDb`.
- `readDb` falls back to the primary when `POSTGRES_REPLICA_US_URL` is unset, so
  that variable must stay set on the `kilocode-ai-gateway` Vercel project.

## Runtime files

- `src/lib/email.ts` reads `src/emails/*.html` from disk, relative to the app's
  working directory. Both apps' `next.config.mjs` list those templates in
  `outputFileTracingIncludes` so Vercel bundles them into every function. Keep
  any new file read at runtime in that list too.
