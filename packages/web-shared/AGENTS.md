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
in `sfo1`, but the read-write `db` from `lib/drizzle` always connects to the
Frankfurt primary. Do not use it before the upstream inference request starts:
each query adds an `sfo1` -> `fra1` round trip (a transaction several) and holds
a primary pool connection that long, contributing to pool exhaustion. Async
work, work after the upstream request starts, and exceptional paths may use it.

- Read through `readDb`, which uses the US replica in `sfo1`. Its lag is
  acceptable for auth. Shared helpers keep their `fromDb = db` default for the
  web app; gateway callers must pass `readDb`, since omitting it selects the
  primary.
- Usage accounting has its own transport selection; do not infer it from the
  general write guidance below. `usageAccountingTransport` selects queue or
  direct transport per request for `logMicrodollarUsage` and
  `logMicrodollarUsageAndReportToBouncer`. Selected usage publishes its
  finalized record through the selected queue transport; in production that is
  the authenticated Cloudflare ingress, whose consumer calls the existing
  Frankfurt `/api/internal/usage/record` writer. HTTP 202 is queue acceptance,
  not a committed row or debit; the writer persists idempotently by usage ID, so
  redelivery does not create a second debit. Selection changes accounting
  transport only, not inference routing or compute location.
- Direct accounting remains for FRA deployments other than staging and
  production `fra1`, for production FRA requests without a payer identity, and
  for the existing SFO `recordUsageInPrimaryRegion` handoff, which falls back
  to a local write when the handoff is unavailable. Selected queue usage falls
  back to a direct write only in the two pre-publication cases where nothing was
  sent:
  missing/unparseable publisher configuration and failed lifetime registration.
  It does not fall back after any publication attempt, including timeout or an
  ambiguous failure, because the event may already be queued.
- For other writes, defer with `after()` or forward them to `fra1` like
  `recordUsageInPrimaryRegion` does.
- Where correctness needs the primary on a rare path (read-after-write, a row
  lock, or an optimistic write such as lazy credit expiry), comment why.
- `readDb` falls back to the primary when `POSTGRES_REPLICA_US_URL` is unset, so
  that variable must stay set on the `kilocode-ai-gateway` Vercel project.

The queue launch and SFO exposure controls and rollback are documented in
[`ENVIRONMENT.md`](../../ENVIRONMENT.md) and
[`services/usage-ingest/README.md`](../../services/usage-ingest/README.md).
Source defaults do not establish the deployed SFO cohort; production FRA
selection follows the deployed source.

## Data collection versus ZDR

`provider.data_collection: 'deny'` only excludes providers that store prompts
for feedback or training; they may still store prompts for compliance. Only
`zdr: true` excludes all prompt retention. The organization Data Collection
Policy maps to `data_collection`, never `zdr`. Provider `training` and
`retainsPrompts` follow the same split. See
[OpenRouter's ZDR guide](https://openrouter.ai/docs/guides/features/zdr).

## Runtime files

- `src/lib/email.ts` reads `src/emails/*.html` from disk, relative to the app's
  working directory. Both apps' `next.config.mjs` list those templates in
  `outputFileTracingIncludes` so Vercel bundles them into every function. Keep
  any new file read at runtime in that list too.
