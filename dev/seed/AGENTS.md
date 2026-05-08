# AGENTS.md — `dev/seed/`

Contract for `pnpm dev:seed` runner/topic modules. Read before adding, modifying, or invoking seeds.

## Layout

```
dev/seed/
  index.ts                 Runner: args, listing, result output.
  lib/
    preflight.ts           Import FIRST; mutates process.env from argv.
    db.ts                  Lazy drizzle client.
    stripe.ts              Lazy Stripe test-mode client/customer helpers.
    kiloclaw-referrals.ts  KiloClaw referral fixtures/helpers.
  <scope>/<topic>.ts       Topic module. Scope = folder; topic = filename.
```

Runner globs `<scope>/*.ts`. Any top-level dir except `lib/` is a scope. Scope folders must contain only topic files; shared code goes in `lib/`.

## Invocation

```sh
pnpm dev:seed <scope>:<topic> [args...]   # canonical
pnpm dev:seed <scope> <topic> [args...]   # accepted
pnpm dev:seed                             # list topics + usage
```

Global flag:

- `--json`: suppress topic stdout; print exactly one `JSON.stringify(result)` line. Use `pnpm -s` for clean pipes:
  ```sh
  USER_ID=$(pnpm -s dev:seed app:create-user "Foo" foo@example.com --json | jq -r .userId)
  ```
  Implementation: `preflight.ts` sets `DOTENV_CONFIG_QUIET=true` before other imports; runner suppresses `console.log/info/warn` during `run()`. Do not bypass with `process.stdout.write`.

## Topic contract

Topic files MUST:

- Export `run(...args: string[]): Promise<SeedResult | void> | SeedResult | void`.
  - `type SeedResult = Record<string, string | number | boolean | null>`: flat JSON primitives only; no nested objects; stringify Dates.
  - Return every id/email/handle/balance needed by follow-up commands; the runner formats all output from this object.
- Support `--help`/`-h` via local `printUsage()` and early return.
- Reset only their own data at start for idempotent reruns. Referral seeds use `cleanupKiloClawReferralSeedScenario`; ad-hoc topics delete by stable ids/emails, stable sandbox prefixes, or `dev-seed:` category prefixes.
- Avoid module-level side effects (DB writes/network); no-args listing imports modules.

Topic files SHOULD:

- Export `const usage = '<arg> <arg> [options]'`; omit if no args.
- Print short context before returning (`This fixture represents:`, `Note:`, `Suggested next step:`). Runner appends the Result block.

Topic files MUST NOT:

- Write stdout in `--json` beyond the runner's single JSON line; `console.*` is suppressed during `run()`, but `process.stdout.write` is not.
- Print completion blocks or `key: value` lines duplicating `SeedResult`.
- Use `as` casts or `!` assertions; prefer `satisfies typeof <table>.$inferInsert`.
- Import from `apps/web/src/...` (server-only/Next runtime); replicate minimal logic in `lib/`.
- Return nested objects or non-primitives in `SeedResult`; flatten with prefixed keys (`eligibleUserId`, `eligibleInstanceId`, ...).

## Helpers

- `getSeedDb()`: lazy singleton drizzle client, safe from any topic; pool cap 1.
- `closeSeedDb()`: runner calls in `finally`; topics should not.
- `createSeedStripeCustomer({ email, name, kiloUserId })`: creates real Stripe test-mode customer with `metadata: { kiloUserId, source: 'dev-seed' }`.
- `deleteSeedStripeCustomer(id)`: rollback helper; swallows "no such customer".
- `lib/stripe.ts` rejects missing/non-`sk_test_...` `STRIPE_SECRET_KEY`.
- For seeded users used by Stripe-touching app code (`/profile`, billing pages, KiloClaw subscriptions), create a real Stripe customer. Never use `cus_seed_...`: it causes `StripeInvalidRequestError: No such customer` 400s. Order matches `createUserOnSignIn`: create Stripe customer, insert DB row, delete Stripe customer in `catch` on insert failure.
- `lib/kiloclaw-referrals.ts`: deterministic id/email/payment-id factories (`seedUserId`, `seedEmail`, `seedOpaqueReferralIdentifier`, ...), `cleanupKiloClawReferralSeedScenario`, and `insertSeedUsers`. Use for new referral scenarios so cleanup stays consistent.

## Direct user inserts

Bare `kilocode_users` inserts leave users trapped in onboarding. To reach product surfaces, set:

- `has_validation_stytch: true` — bypasses `/account-verification` (`!== null`).
- `customer_source: 'dev-seed'` — bypasses `/customer-source-survey` (`!== null`; `''` means skipped).

Canonical example: `app/create-user.ts`. Gate code: `apps/web/src/lib/stytch.ts` (`getStytchStatus`) and `apps/web/src/lib/survey-redirect.ts` (`maybeInterceptWithSurvey`). When adding a gate, update this section and `app/create-user.ts` together.

## New-topic checklist

1. Add `<scope>/<topic>.ts` (new top-level dirs become scopes).
2. Export `run()` and usually `usage`.
3. Use `getSeedDb()`; use `createSeedStripeCustomer` for app users needing Stripe.
4. Reset only own fixtures idempotently.
5. Return flat `SeedResult` with every follow-up id.
6. Verify both modes:
   ```sh
   pnpm dev:seed <scope>:<topic> <args>             # human-readable Result block
   pnpm -s dev:seed <scope>:<topic> <args> --json   # single JSON line
   ```
7. Run `pnpm format` and `pnpm lint`. Skip `pnpm typecheck`: `dev/seed/` runs via `tsx` and is outside tsconfig; runtime is the type check.
