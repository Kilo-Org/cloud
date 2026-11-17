# Mock Snowflake

A dev-only stand-in for the Snowflake SQL API v2 that the usage dashboard
(`/usage`, and the mobile usage screens through `usageAnalytics`) reads from.
The warehouse is not part of the local stack, so this answers the analytics
router's three statements — summary, daily timeseries and breakdown — from
fixture rows written by `pnpm dev:seed usage:usage-rows`.

Nothing in `apps/web` imports this directory: it is test tooling, and it is the
only way to see a populated usage screen locally.

## The local stack starts it for you

`pnpm dev:start` starts the mock as the `mock-snowflake` service (core group,
always on, before the web app) and its entry — `stack-service.ts` — keeps one
managed section of the repo-root `.env.local` current. The section, delimited by
`# wired by dev/mock-snowflake/stack-service.ts` and
`# end of dev/mock-snowflake wiring`, holds the `SNOWFLAKE_*` block and one
`NODE_EXTRA_CA_CERTS` line.

Three guarantees about the file:

- **An existing real warehouse is never replaced.** A `SNOWFLAKE_ACCOUNT_HOST`
  entry outside the range this entry owns means the stack entry leaves the file
  byte-identical when it owns nothing there. When it does own a section — an
  earlier `dev:start` wrote one, and you then added your real warehouse above or
  below it — it takes its own section back out instead, restoring any
  `NODE_EXTRA_CA_CERTS` line it had repointed at the bundle, because `dotenv`
  keeps the last definition and a section left below your block would silently
  put the app on the mock. The guard reads parsed entries, so `export KEY=value`,
  `KEY = value`, `KEY = "value"  # prod` and a plain `KEY=value` all count.
- **The section is kept current.** A port change — a different worktree offset,
  or a lease that moved this worktree to a free offset — rewrites that one
  section in place: it names the port the mock actually listens on
  (`4792 + offset`), stays the only section, and a start that finds it identical
  writes nothing.
- **Your own CA keeps working.** The section names
  `dev/mock-snowflake/fixtures/tls/ca-bundle.pem`, which holds the mock's
  self-signed certificate followed by the contents of every CA file that
  `NODE_EXTRA_CA_CERTS` named in the shell, in the repo-root `.env.local`
  (outside the section, which is this entry's own line), or in any of the other
  env files `scripts/dev.sh` reads.

## Where trust comes from

`scripts/dev.sh` resolves the variable as *exported value first, then the first
matching line of `.env.development.local`, `.env.local` and the repo-root copies*,
and it matches only a line whose text before the first `=` is exactly the key:
`export KEY=value` and `KEY = value` never match, and an empty value makes it
fall through to the next file. Node then reads the variable once at startup,
before Next.js loads `.env*` for its own process.

- **`pnpm dev:start` and `pnpm dev:restart`.** `dev/local/services.ts` prefixes
  the web app's command with `NODE_EXTRA_CA_CERTS=<bundle>`, shell-quoted so a
  checkout path with a space in it stays one argument, whenever
  `mock-snowflake` is in the selection, and every path that relaunches the web
  app passes that selection — a start, a `dev:restart`, a dashboard start or
  restart, the recreate of a pane that died with its process, and the
  `dev:start-command` line printed for driving a pane by hand. The prefix wins
  over whatever the shell exported and over every `.env*` line, so this is the
  path that keeps the mock trusted.
- **A shell that already exports `NODE_EXTRA_CA_CERTS`.** No file edit can win
  there — an exported value beats every file, including the section's line — so
  the command prefix above is what keeps the mock trusted; the stack entry
  folds the shell's own CA into the bundle, so it stays trusted too.
- **`pnpm dev` inside `apps/web`, with no stack export.** Trust then comes from
  the file. A plain `NODE_EXTRA_CA_CERTS=...` line above the managed section is
  the one `dev.sh` would read, so the stack entry points that line's value at the
  bundle in place — same line, same position, only a trailing comment dropped,
  because that comment would otherwise become part of the value — and records
  the original path in the section as `# mock-snowflake CA: <path>`. The bundle
  re-reads that file on every wire, so a rotated certificate keeps taking effect,
  and the original value is never dropped: its bytes are in the bundle.
  `dev.sh` takes the first match across the four files it walks, and this entry
  only rewrites that one line of the repo-root `.env.local`. So a
  `NODE_EXTRA_CA_CERTS` line in `apps/web/.env.development.local`,
  `apps/web/.env.local` or the repo-root `.env.development.local` still decides
  the value here, and the mock's certificate stays untrusted: the entry does not
  rewrite a file it does not own. The stack export above covers that case, since
  the bundle carries the CAs those files name as well as the mock's, so on that
  path every one of them stays trusted.

## Turning it off

```sh
pnpm dev:start app --without=mock-snowflake
```

`--without` accepts a comma-separated list (or `$KILO_DEV_WITHOUT`); the web app
then starts without the stand-in and every warehouse read reports its failure
with a Try again action. `pnpm dev:stop` also stops it with everything else.

## Run it by hand

You can still run the standalone server without the stack:

```sh
pnpm dev:mock-snowflake
```

It listens on `https://127.0.0.1:4792` (`MOCK_SNOWFLAKE_PORT` overrides the
port), generates a self-signed certificate under `fixtures/tls/` on first run,
and (re)writes `fixtures/snowflake-env.txt` for the port it listens on. It never
talks to a real warehouse.

Point the web app at it by appending that block, plus one trust line for the
self-signed certificate, to the repo-root `.env.local` (the web dev script
symlinks it into `apps/web` before starting Next.js):

```sh
cat dev/mock-snowflake/fixtures/snowflake-env.txt >> .env.local
printf 'NODE_EXTRA_CA_CERTS=%s\n' "$PWD/dev/mock-snowflake/fixtures/tls/cert.pem" >> .env.local
pnpm dev:start app
```

Both lines are dev-only and `.env.local` is gitignored. The generated
certificate is a CA that signs only itself and names this one host, so the web
app trusts the mock and nothing else. Naming `cert.pem` directly is right when
the mock is the only extra CA you trust; if you also trust another local CA, the
stack's `fixtures/tls/ca-bundle.pem` holds the mock's certificate plus the CAs
you already named, and that is the file it wires. If you later let the stack wire
the mock, delete the block you appended by hand first: the stack never replaces a
`SNOWFLAKE_ACCOUNT_HOST` it did not write, so it leaves that block alone and
writes no section beside it — and if it already wrote one, it takes its section
back out. Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0` instead: it turns
certificate verification off for every host the Next.js process talks to.

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

To exercise the usage screen's error state, stop the mock (`pnpm dev:start app
--without=mock-snowflake`, or kill the mock's tmux pane — not the web app —
that removes the screen) and reload the screen; the totals and the breakdowns
each report the failure with a Try again button. Start the mock again and press
it to see them recover.
