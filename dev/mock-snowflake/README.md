# Mock Snowflake

A dev-only stand-in for the Snowflake SQL API v2 that the usage dashboard
(`/usage`, and the mobile usage screens through `usageAnalytics`) reads from.
The warehouse is not part of the local stack, so this answers the analytics
router's three statements — summary, daily timeseries and breakdown — from
fixture rows written by `pnpm dev:seed usage:usage-rows`.

Nothing in `apps/web` imports this directory: it is test tooling, and it is the
only way to see a populated usage screen locally.

## Run it

```sh
pnpm dev:mock-snowflake
```

It listens on `https://127.0.0.1:4792` (`MOCK_SNOWFLAKE_PORT` overrides the
port), generates a self-signed certificate under `fixtures/tls/` on first run,
and writes `fixtures/snowflake-env.txt`: the `SNOWFLAKE_*` block to append to
`apps/web/.env.development.local`. It never talks to a real warehouse.

The web dev process must trust the certificate:

```sh
NODE_EXTRA_CA_CERTS=dev/mock-snowflake/fixtures/tls/cert.pem pnpm dev:start web
```

Then write fixture rows for a fake account that already signed in once:

```sh
pnpm dev:seed usage:usage-rows <fake-email>
```

The topic also creates a sales-demo organization the account owns and one it
only belongs to as a member, with daily limits, so the members screen and the
organization usage scope can both be exercised.

## Checks

`fixtures/` is gitignored, so seeding is safe to repeat: each run replaces that
account's fixture file. Stop the web app if you want the usage screen to fail
and exercise its error state; restart the mock and retry to see it recover.
