# Proof runs: Vercel OIDC custom-audience exchange (design 4.4, Q49)

STS accepts a Vercel token only after the caller exchanged its function token for one whose
audience is the STS issuer (`../../README.md`, "Vercel callers"). Vercel publishes no limit for that
exchange (`POST https://oidc.vercel.com/~token`). This standalone Vercel project measures it.

## What proof run 1 found (2026-11-25, throwaway project, deleted)

- The exchange serves about 100 exchanges per burst, then answers 429 `{"error":"Rate limit
  exceeded"}` with no `retry-after`; the budget refills within about 65 seconds. Sustained 25 per
  3 seconds and 50 per 8 seconds pass.
- The budget belongs to the deployment, not the instance: 2,500 invocations on 411 instances got 100
  tokens in total. Every instance of a deployment carries the same base token (`act.iat` was equal
  on all 411).
- Exchanged claims: `iss` `https://oidc.vercel.com/kilocode` (team slug form), `aud` exactly the
  requested audience, `act` `{ iat, aud: "https://vercel.com/kilocode" }`, `exp` equal to the base
  token's `exp`; claim names `act aud deployment_id environment exp iat iss jti nbf owner owner_id
  plan project project_id scope sub`.
- Team `kilocode` protects `*.vercel.app` by default (`ssoProtection: all_except_custom_domains`).

So one exchange per instance cannot work. Decision D10 (design Q49): instances share the exchanged
token through the Vercel Runtime Cache. `lib/shared-token.ts` implements the algorithm, the one the
slice-4 Vercel client copies or imports; `test/proof/shared-token.test.ts` checks its logic against
stand-ins. Proof run 2 checks it against the real Runtime Cache and exchange. **It is the merge gate
for the first Vercel workload: no Vercel workload uses STS until proof run 2 passes.**

## The shared-cache algorithm (`lib/shared-token.ts`)

1. Key: SHA-256 of the base token and the audience. A region's instances share one key per audience;
   a new base token (new deployment, or Vercel renewing it) is a new key.
2. Instance memory, then the Runtime Cache: a hit is used.
3. Miss: wait a random 0 to 500 ms, read again.
4. Still a miss: claim. Write a claim marker (10 s TTL) unless one exists, wait 150 ms, read it back;
   only the request whose marker is still there exchanges. The Runtime Cache has no lock, so the
   last writer wins; random waiting alone would need several seconds of jitter to keep a
   2,500-instance wave under 100 exchanges.
5. The exchanger stores `{ token, exp }` until 10 minutes before `exp`. The exchange keeps the base
   token's `exp`, so with under 10 minutes left a fresh token is kept until 60 seconds before `exp`
   instead of being exchanged on every request.
6. Everyone else, and an exchanger that got 429, polls the cache with backoff (50 ms doubling to
   800 ms, with jitter) and never exchanges again while a marker exists. When the marker expires
   without a token, one poller claims again: at most one exchange per 10 seconds per key.
7. No token after 20 seconds: the request fails, and the caller's STS call fails with it.

## Files

This directory is not a pnpm workspace (`pnpm-workspace.yaml` lists `services/*`, not this
grandchild), has no `wrangler.jsonc` (the Worker deploy discovers `services/**/wrangler.jsonc`), and
holds no secret. Its one dependency is `@vercel/functions` 3.4.6 for `getCache()`; Vercel installs
it at deploy. `pnpm typecheck` and `pnpm lint` in `services/sts` check this directory, resolving
`@vercel/functions` from the web app's install (same version).

| File | What it does |
|---|---|
| `api/shared.ts` | `POST /api/shared`: one STS-audience token through the shared cache. Answers the source (`memory`, `cache`, `cache_after_jitter`, `exchanged`, `poll`), time to token, wait time, exchange attempts and 429s, whether it won the claim, cache reads and writes, the cache backend, the region, the base token's `iat`/`exp`, the clock and the token's `exp`. `?jitterMs=`, `?claim=0`, `?deadlineMs=` override the defaults. |
| `api/cold.ts` | `POST /api/cold`: one exchange per invocation, no cache (run 1's mode), plus the base token's `iat`/`exp`, the clock, the exchanged `exp` and the rate-limit headers. |
| `api/exchange.ts` | `POST /api/exchange?n=2500&c=50`: a burst from one instance. Its latency numbers are the ones to quote; the limit is measured only by a fan-out. |
| `api/chain.ts` | `POST /api/chain`: exchanges for `https://example.invalid`, then exchanges that token for the run's audience; answers whether Vercel refused the second hop and each token's full `act`. |
| `drive.ts` | `--mode shared` (the gate), `--mode cold` (baseline), `--mode warm` (header token age). `--dry-run` prints the plan and pass rule. |
| `inspect-env-token.ts` | Pulls `VERCEL_OIDC_TOKEN` with `vercel env pull` per environment and prints only its `environment` claim and whether it carries `user_id`. |
| `vercel.json` | `fluid: false`, so concurrent invocations land on separate instances, as cold instances would. |

Every function refuses a request without `x-proof-key` equal to the project's `PROOF_SHARED_SECRET`
(at least 32 characters), and refuses everything while it is unset. The audience is
`PROOF_AUDIENCE`, default `https://sts-proof.invalid`: not an STS issuer, so no token the harness
gets can be presented to STS. No function returns a token. Rate-limit headers (`x-ratelimit-*`,
`ratelimit*`, `retry-after`) are recorded on successes and failures.

## Proof run 2 runbook (operator)

Prerequisites: Vercel CLI logged in to team `kilocode`; the work VM (2,500 sockets need
`ulimit -n 10000`); `node` 24.

### 1. Deploy a throwaway project

```sh
WORK=$(mktemp -d) && rsync -a --exclude node_modules --exclude .vercel \
  services/sts/proof/vercel-exchange/ "$WORK/" && cd "$WORK"   # keep .vercel out of the repo
PROJECT=sts-proof-vercel-exchange-$(date +%Y%m%d)
vercel project add "$PROJECT" --scope kilocode
vercel link --yes --scope kilocode --project "$PROJECT"
PROJECT_ID=$(node -e 'console.log(require("./.vercel/project.json").projectId)')
```

On that project only: OIDC federation on in team issuer mode, deployment protection off (team
default protects `*.vercel.app`), Node 24:

```sh
printf '%s' '{"oidcTokenConfig":{"enabled":true,"issuerMode":"team"},"ssoProtection":null,"passwordProtection":null,"nodeVersion":"24.x"}' > patch.json
vercel api "/v9/projects/$PROJECT_ID?teamId=team_ItxRShuUkJaEd9GmXMEEgunb" -X PATCH --input patch.json
openssl rand -hex 32 | tr -d '\n' > proof-key && chmod 600 proof-key
vercel env add PROOF_SHARED_SECRET production --scope kilocode --yes < proof-key
vercel deploy --prod --yes --scope kilocode     # prints https://$PROJECT.vercel.app
```

Leave `PROOF_AUDIENCE` unset (default `https://sts-proof.invalid`). Note the function region the
deployment reports (`region` in every answer).

### 2. Run (from the VM, with `drive.ts` and `proof-key` copied there)

```sh
ulimit -n 10000
export PROOF_SHARED_SECRET="$(cat proof-key)"
URL=https://$PROJECT.vercel.app

node drive.ts --mode shared --dry-run --url "$URL"
# a. The gate: a 2,500-invocation cold wave through the shared cache.
node drive.ts --mode shared --url "$URL" --invocations 2500 > shared.json
# b. Wait 70 s (budget refill). The same wave with claims off, to show what the claim saves.
sleep 70 && node drive.ts --mode shared --url "$URL" --invocations 2500 --no-claim > shared-noclaim.json
# c. Chained exchange (S2) and the act shape.
curl -sS -X POST -H "x-proof-key: $PROOF_SHARED_SECRET" "$URL/api/chain" > chain.json
# d. Burst latency only (one instance): wait 70 s first so the budget is full.
sleep 70 && curl -sS -X POST -H "x-proof-key: $PROOF_SHARED_SECRET" "$URL/api/exchange?n=100&c=50" > burst.json
# e. Header token age on long-lived instances: once a minute for 2.5 hours.
node drive.ts --mode warm --url "$URL" --interval-s 60 --duration-s 9000 > warm.json 2> warm-samples.jsonl
```

Then, on the Mac from `$WORK` (read only; prints no token), against a directory linked to
`kilocode-app` (`vercel link --yes --scope kilocode --project kilocode-app` in an empty directory):

```sh
node inspect-env-token.ts --cwd <directory linked to kilocode-app> preview production staging > env-tokens.jsonl
```

### 3. Pass rule (run a, `drive.ts` prints `checks` and `passed`)

- `allServed`: every invocation got a token, no function 5xx.
- `sharedBackend`: no invocation used the in-memory fallback of `getCache()`.
- `withinExchangeBudget`: exchange attempts, 429s included, at most 100 in total and per region.
  A 429 is tolerated only inside the next two rules; the expected result is 0.
- `withinTimeToTokenBudget`: time to token inside the function p99 at most 3 s and max at most 20 s.
  Design 3 states the cold-start budget as one shared-cache read per audience and two parallel
  fetches, with no millisecond figure; 20 s is the longest STS waits for a bundle object.
- `expMatchesBase`: every token's `exp` equals the base token's `exp`.
- `actOk`: the exchanged token's `act` is an object whose `aud` is `https://vercel.com/kilocode`,
  with no nested `act` (STS refuses anything else).
- `coldWave`: at least 200 distinct instances, otherwise the run is inconclusive (run 1 reached 411).
  The run measures concurrent exchanges per wave; the instance count is reported with it.

Record in the PR: `shared.json`, `shared-noclaim.json` (attempts and 429s without claims),
`chain.json` (`vercelRefusedChain`, both `act` shapes), `burst.json` (latency percentiles and
rate-limit headers), `warm.json` (oldest header token, least time left, fresh exchanges expiring
within 10 minutes, how often the base token changed) and `env-tokens.jsonl` (`environment` and
`userIdPresent` per pulled environment; STS refuses every token with `user_id`).

The fan-out (run a) is binding for the limit; the burst (run d) is for latency only. `--mode cold`
is run 1's mode and is expected to fail (100 served, the rest 429); it is not part of run 2.

### 4. Clean up

```sh
vercel project rm "$PROJECT" --scope kilocode   # deletes the project, its deployments and env vars
vercel project ls --scope kilocode | grep "$PROJECT"   # no output
cd / && rm -rf "$WORK"                            # proof-key, patch.json and .vercel go with it
# VM: rm -f proof-key drive.ts *.json *.jsonl
```
