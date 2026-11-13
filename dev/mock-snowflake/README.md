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
and writes `fixtures/snowflake-env.txt`. It never talks to a real warehouse.

Point the web app at it by appending that block, plus one trust line for the
self-signed certificate, to the repo-root `.env.local` (the web dev script
symlinks it into `apps/web` before starting Next.js):

```sh
cat dev/mock-snowflake/fixtures/snowflake-env.txt >> .env.local
printf 'NODE_EXTRA_CA_CERTS=%s\n' "$PWD/dev/mock-snowflake/fixtures/tls/cert.pem" >> .env.local
pnpm dev:start app
```

Both lines are dev-only and `.env.local` is gitignored. `scripts/dev.sh` exports
`NODE_EXTRA_CA_CERTS` before `next dev` starts, which is what makes it work:
Next.js loads `.env.local` into its own process after Node has already read that
variable, so a line that only reached Next would leave the certificate
untrusted. The generated certificate is a CA that signs only itself and names
this one host, so the web app trusts the mock and nothing else. Do not use
`NODE_TLS_REJECT_UNAUTHORIZED=0` instead: it turns certificate verification off
for every host the Next.js process talks to.

Then write fixture rows for a fake account that already signed in once:

```sh
pnpm dev:seed usage:usage-rows <fake-email>
```

The topic also creates a sales-demo organization the account owns and one it
only belongs to as a member, with daily limits, so the members screen and the
organization usage scope can both be exercised.

## Checks

`fixtures/` is gitignored, so seeding is safe to repeat: each run replaces that
account's fixture file.

To exercise the usage screen's error state, stop the mock (not the web app —
that removes the screen) and reload the screen; the totals and the chart each
report the failure with a Retry. Start the mock again and press Retry to see it
recover.
