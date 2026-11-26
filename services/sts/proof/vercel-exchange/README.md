# Proof runs: Vercel OIDC custom-audience exchange (design 4.4, Q49)

STS accepts a Vercel token only after the caller exchanged its function token for one whose
audience is the STS issuer (`../../README.md`, "Vercel callers"). Vercel publishes no limit for that
exchange (`POST https://oidc.vercel.com/~token`). This standalone Vercel project measures it.

## What proof run 1 found (2026-11-25, throwaway project, deleted)

- The exchange serves about 100 exchanges per burst, then answers 429 `{"error":"Rate limit
  exceeded"}` with no `retry-after`; the budget refills within about 65 seconds. Sustained 25 per
  3 seconds and 50 per 8 seconds pass.
- The budget is wider than the instance: 2,500 invocations on 411 instances got 100 tokens in
  total (proof run 3 run e showed it is wider than the deployment too).
- Exchanged claims: `iss` `https://oidc.vercel.com/kilocode` (team slug form), `aud` exactly the
  requested audience, `act` `{ iat, aud: "https://vercel.com/kilocode" }`, `exp` equal to the base
  token's `exp`; claim names `act aud deployment_id environment exp iat iss jti nbf owner owner_id
  plan project project_id scope sub`.
- Team `kilocode` protects `*.vercel.app` by default (`ssoProtection: all_except_custom_domains`).

So one exchange per instance cannot work. Decision D10 (design Q49): instances share the exchanged
token through the Vercel Runtime Cache.

## What proof run 2 found (2026-11-25/26, throwaway project `sts-oidc-proof2`)

- Gate run a **failed** on time to token (p99 11.6 s, max 13.1 s) with 707 instances, 36 exchanges,
  35 claim winners and no 429; cache reads p99 62 ms. Every other check passed. Three later waves on
  fresh deployments (329 to 399 instances) passed with one exchange and p99 72 to 555 ms.
- Cause: the base token is **not** stable for a deployment's life. Vercel minted a new function
  token on the same deployment 33 s apart (`iat` 1795648554, then 1795648587), so the run-2 key
  (SHA-256 of base token and audience) split one wave into several keys, each with its own claim
  and poll cycle. The key now leaves the token out (below).
- Vercel refuses to exchange an exchanged token: 401 `{"error":"Token has already been exchanged"}`.
- Burst from one instance: 100 exchanges, p50 235 ms, p99 553 ms; then 429, refill about 65 s; no
  rate-limit headers on success or failure.
- Person tokens: `vercel env pull` for `preview`, `production` and `staging` (that step ran against
  the production web project, which run 3 no longer touches; nothing was opened or kept) each returned a token
  claiming `environment: development` with `user_id`, so STS refuses all three. Whether `user_id`
  survives the exchange was not measured; run 3 step 3 does.

## What proof run 3 found (2026-11-25, throwaway project `sts-oidc-proof3`, deleted): PASS

- Gate run a passed all 8 checks: 2,500 invocations on 498 cold instances in `iad1`, every one
  served, 2 exchanges (`attemptsByRegion {iad1: 2}`, the base token rolled over inside the wave), 0 ×
  429, time to token p99 1,954 ms, max 2,623 ms, `request-context` cache backend throughout.
- Run b (claims off, fresh deployment): 340 cold instances, 1 exchange, p99 75 ms. With the token
  out of the key, one wave on one base token needs one exchange; the claim adds a marker write.
- Run c: the chained exchange is refused 401 `{"error":"Token has already been exchanged"}`; `act`
  stays the team default audience and is not nested.
- Run d: burst from one instance, about 123 exchanges/s (100 at concurrency 50 in 813 ms), p50
  235 ms, p99 554 ms, no rate-limit headers.
- Run e (budget scope): two fresh deployments of the project fired together got 42 + 58 = 100
  tokens, then 429. The budget is **per project or per team, not per deployment** (which of the two
  needs a second project and was not measured). Overlapping deployments, and if it is team-wide
  every project of team `kilocode`, share it; with the shared cache each deployment spends about one
  exchange per region and audience, so a release spends a handful.
- Person tokens (step 3): `preview`, `production` and `staging` pulls each claim `environment:
  development` with `user_id`, and `user_id` survives the exchange: all three `holds`.
- A function token of the custom environment `staging` carries `environment: staging` and
  `custom_environment_id`.
- `scope` equals `sub` (`owner:kilocode:project:<name>:environment:<env>`) for function,
  custom-environment and person tokens alike, so it does not tell a build token from a function
  token: STS cannot tell them apart, and build code is trusted like the deployment's own code
  (design 6.2).

The algorithm lives in the Vercel client, `packages/service-token-client/src/vercel/shared-token.ts`
(its one source; `vercelIdentity` uses it and `lib/shared-token.ts` here re-exports it);
`packages/service-token-client/test/shared-token.test.ts` checks its logic against stand-ins, and
`test/proof/pass-rule.test.ts` checks the pass rule. **Proof run 3 was the merge gate for the first
Vercel workload, and it passed.**

## The shared-cache algorithm (`packages/service-token-client/src/vercel/shared-token.ts`)

1. Key: SHA-256 of a per-run salt (`?run=`, empty in production), the base token's `owner_id`,
   `project_id`, `environment`, `custom_environment_id` and `deployment_id` (decoded, not
   verified), and the audience. These stay the same when Vercel renews the base token, so all
   instances of a deployment share one key per region and audience. A base token missing one of
   them fails the request.
2. A cached entry is used only if its token decodes to the same five claims, `aud` equal to the
   audience, `exp` equal to the entry's, the team slug issuer of its `owner` and an `act` naming that
   team's default audience with nothing nested (as STS requires), until `exp` minus 60 s, whichever
   base token the reader holds. An exchanged token that fails the same check is never stored nor
   served. A forged entry with matching claims can only make the caller's STS call fail (STS checks
   the signature). The key is not secret: code that can write the same Runtime Cache partition
   (other deployments of the project in the same scope; a custom environment may share the preview
   partition) can stall a deployment's exchanges, never change which token it presents; production
   has its own partition.
3. Instance memory, then the Runtime Cache: a hit is used. On a miss, a base token with under 60 s
   left fails the request at once: no exchange, no waiting.
4. Miss: wait a random 0 to 500 ms, read again.
5. Still a miss: claim. Write a claim marker (10 s TTL) unless one exists, wait 150 ms, read it back;
   only the request whose marker is still there exchanges. The Runtime Cache has no lock, so the
   last writer wins.
6. The exchanger stores `{ token, exp }` until 60 s before `exp`. There is no earlier refresh: the
   exchange keeps the base token's `exp`, so exchanging earlier could not get a later one; the next
   exchange happens on the first miss after the entry expires, with the claim winner's (newer)
   base token.
7. Everyone else, and an exchanger that got 429, polls the cache with backoff (50 ms doubling to
   800 ms, with jitter) and never exchanges again while a marker exists. When the marker expires
   without a token, one poller claims again: at most one exchange per 10 seconds per key.
8. No token after 20 seconds: the request fails, and the caller's STS call fails with it.

**Degraded mode (cache down).** When the marker does not read back (the Runtime Cache throws or
keeps nothing), the request exchanges itself, once per request; on a 429 in that mode it fails at
once instead of polling a cache that cannot bring a token. Cost: about 100 requests per 65 s get a
token, the rest of a cold wave fail fast (no 20 s of function time each), and their STS calls fail
until the cache is back.

**Cache cost.** A memory hit reads nothing. A cache hit is 1 read. A miss that reaches the claim is
4 reads (read, read after the random wait, claim check, read-back) and 1 write (2 for the
exchanger), then 2 reads per poll step. Run 2's single-key wave measured 339 reads and 1 write for
2,500 invocations on 332 instances, about 1 read per instance. Per wave of about 2,200 instances
that is about 2,200 to 3,000 reads per audience and region (worst case, every instance polling to
the deadline: about 56 reads each, about 120,000); per day at 43 releases about 100,000 to 130,000
reads per audience and region, plus one miss wave per base-token renewal that outlives a cached
token.

## Files

This directory is not a pnpm workspace (`pnpm-workspace.yaml` lists `services/*`, not this
grandchild), has no `wrangler.jsonc` (the Worker deploy discovers `services/**/wrangler.jsonc`), and
holds no secret. Its one dependency is `@vercel/functions` 3.4.6 for `getCache()`; Vercel installs
it at deploy. `pnpm typecheck` and `pnpm lint` in `services/sts` check this directory, resolving
`@vercel/functions` from the web app's install (same version).

| File | What it does |
|---|---|
| `api/shared.ts` | `POST /api/shared`: one STS-audience token through the shared cache. Answers the source (`memory`, `cache`, `cache_after_jitter`, `exchanged`, `poll`), time to token, wait time, exchange attempts and 429s, whether it won the claim, cache reads and writes, the cache backend, the region, the base token's `iat`/`exp`, the clock and the token's `exp`. `?jitterMs=`, `?claim=0`, `?deadlineMs=` override the defaults; `?run=` salts the key. |
| `api/cold.ts` | `POST /api/cold`: one exchange per invocation, no cache (run 1's mode), plus the base token's `iat`/`exp`, the clock, the exchanged `exp` and the rate-limit headers. |
| `api/exchange.ts` | `POST /api/exchange?n=2500&c=50`: a burst from one instance. Its latency numbers are the ones to quote; the limit is measured only by a fan-out. |
| `api/chain.ts` | `POST /api/chain`: exchanges for `https://example.invalid`, then exchanges that token again; `vercelRefusedChain` is true only for a non-429 refusal (`chainedRateLimited` marks a 429). |
| `lib/shared-token.ts` | Re-exports the client's shared-cache module; the deploy step replaces it with a copy of that module, which imports nothing. |
| `lib/pass-rule.ts` | The run-3 pass rule `drive.ts` applies. |
| `drive.ts` | `--mode shared` (the gate), `--mode cold` (baseline and budget scope), `--mode warm` (header token age). `--dry-run` prints the plan and pass rule. Shared mode salts each run with a fresh `run` id. |
| `inspect-env-token.ts` | Pulls `VERCEL_OIDC_TOKEN` with `vercel env pull` per environment of the proof project, exchanges it for `https://sts-proof.invalid`, and prints for both tokens `environment`, `custom_environment_id`, whether `user_id` is present, the `act` shape and `scope`, plus the gate outcome. Never a token. |
| `vercel.json` | `fluid: false`, so concurrent invocations land on separate instances, as cold instances would. |

Every function refuses a request without `x-proof-key` equal to the project's `PROOF_SHARED_SECRET`
(at least 32 characters), and refuses everything while it is unset. The audience is
`PROOF_AUDIENCE`, default `https://sts-proof.invalid`: not an STS issuer, so no token the harness
gets can be presented to STS. No function returns a token. Rate-limit headers (`x-ratelimit-*`,
`ratelimit*`, `retry-after`) are recorded on successes and failures. Exchanged-claim samples record
`scope` and `plan` values and whether `deployment_id` is present.

## Proof run 3 runbook (operator)

Prerequisites: Vercel CLI logged in to team `kilocode`; the work VM (2,500 sockets need
`ulimit -n 10000`); `node` 24. Every step runs against the throwaway proof project only; no other
project of the team is linked, pulled or changed.

### 1. Deploy a throwaway project

```sh
WORK=$(mktemp -d) && rsync -a --exclude node_modules --exclude .vercel \
  services/sts/proof/vercel-exchange/ "$WORK/" \
  && cp packages/service-token-client/src/vercel/shared-token.ts "$WORK/lib/shared-token.ts" \
  && cd "$WORK"   # keep .vercel out of the repo; the copy replaces the re-export
PROJECT=sts-proof-vercel-exchange-$(date +%Y%m%d)
TEAM=team_ItxRShuUkJaEd9GmXMEEgunb
vercel project add "$PROJECT" --scope kilocode
vercel link --yes --scope kilocode --project "$PROJECT"
PROJECT_ID=$(node -e 'console.log(require("./.vercel/project.json").projectId)')
```

On that project only: OIDC federation on in team issuer mode, deployment protection off (team
default protects `*.vercel.app`), Node 24, and a custom environment `staging` for step 3:

```sh
printf '%s' '{"oidcTokenConfig":{"enabled":true,"issuerMode":"team"},"ssoProtection":null,"passwordProtection":null,"nodeVersion":"24.x"}' > patch.json
vercel api "/v9/projects/$PROJECT_ID?teamId=$TEAM" -X PATCH --input patch.json
printf '%s' '{"slug":"staging","description":"proof run 3"}' > staging.json
vercel api "/v9/projects/$PROJECT_ID/custom-environments?teamId=$TEAM" -X POST --input staging.json
openssl rand -hex 32 | tr -d '\n' > proof-key && chmod 600 proof-key
vercel env add PROOF_SHARED_SECRET production --scope kilocode --yes < proof-key
vercel deploy --prod --yes --scope kilocode     # prints https://$PROJECT.vercel.app
```

Leave `PROOF_AUDIENCE` unset (default `https://sts-proof.invalid`). Note the function region the
deployment reports (`region` in every answer).

### 2. Run (from the VM, with `drive.ts`, `lib/pass-rule.ts` and `proof-key` copied there)

Each shared run carries its own `run` salt, so no run reads an earlier run's token. A no-claim run
still goes to a fresh deployment, so its instances start cold.

```sh
ulimit -n 10000
export PROOF_SHARED_SECRET="$(cat proof-key)"
URL=https://$PROJECT.vercel.app

node drive.ts --mode shared --dry-run --url "$URL"
# a. The gate: a 2,500-invocation cold wave through the shared cache.
node drive.ts --mode shared --url "$URL" --invocations 2500 > shared.json
# b. On a fresh deployment (vercel deploy --prod on the Mac, note its URL as URL_B), after 70 s:
#    the same wave with claims off, to show what the claim saves.
sleep 70 && node drive.ts --mode shared --url "$URL_B" --invocations 2500 --no-claim > shared-noclaim.json
# c. Chained exchange and the act shape, after the budget refills.
sleep 70 && curl -sS -X POST -H "x-proof-key: $PROOF_SHARED_SECRET" "$URL/api/chain" > chain.json
# d. Burst latency only (one instance), after the budget refills.
sleep 70 && curl -sS -X POST -H "x-proof-key: $PROOF_SHARED_SECRET" "$URL/api/exchange?n=100&c=50" > burst.json
# e. Budget scope (optional): two fresh deployments (URL_C, URL_D) at once, about 150 cold
#    exchanges each. About 200 tokens in total would mean per deployment; about 100 (proof run 3:
#    42 + 58) means per project or team (a second throwaway project tells those apart).
sleep 70 && { node drive.ts --mode cold --url "$URL_C" --invocations 150 > scope-c.json &
  node drive.ts --mode cold --url "$URL_D" --invocations 150 > scope-d.json & wait; }
# f. Header token age on long-lived instances: once a minute for 2.5 hours.
node drive.ts --mode warm --url "$URL" --interval-s 60 --duration-s 9000 > warm.json 2> warm-samples.jsonl
```

### 3. Person tokens (on the Mac, from `$WORK`, which is linked to the proof project)

```sh
node inspect-env-token.ts --cwd "$WORK" preview production staging > env-tokens.jsonl
```

The pull writes the proof project's own (dummy) values to a 0700 temp directory, removed at once.

### 4. Pass rule (run a, `drive.ts` prints `checks` and `passed`)

- `allServed`: every invocation got a token, no function 5xx.
- `sharedBackend`: no invocation used the in-memory fallback of `getCache()`.
- `withinExchangeBudget` (hard limit): exchange attempts, 429s included, at most 100 in total and
  per region.
- `claimHolds`: exchange attempts per region (one audience per run) at most 3, and no 429. A run
  inside the hard limit but above 3 per region shows the claim does not hold on the real cache.
- `withinTimeToTokenBudget`: time to token inside the function p99 at most 3 s and max at most 20 s.
- `expMatchesBase`: every token's `exp` equals the base token's `exp`.
- `actOk`: the exchanged token's `act` is an object whose `aud` is `https://vercel.com/kilocode`,
  with no nested `act` (STS refuses anything else).
- `coldWave`: at least 200 distinct instances, otherwise the run is inconclusive.
  `instancesVsDesignPeak` reports the measured count next to the design's peak of about 2,200.

**Person-token gate (step 3).** For every pulled environment, either Vercel issues no token, or both
the pulled and the exchanged token carry `user_id` (`gate: "holds"`; a refused exchange counts as
no exchanged token). Any `gate: "stops"` stops the merge until Igor decides: a team member could
then pull, exchange and present a token STS accepts. `gate: "inconclusive"` (429 or network error)
is rerun after 70 s.

**Build tokens.** Record `scope` from `exchangedClaims` (run a) and from step 3. Proof run 3: `scope`
equals `sub` for every token, so it does not tell a build token from a function token, and design
6.2 states that build code is trusted like the deployment's own code.

Record in the PR: `shared.json`, `shared-noclaim.json`, `chain.json` (`vercelRefusedChain`, both
`act` shapes; counts only if `chainedRateLimited` is false), `burst.json`, `scope-*.json` (if run),
`warm.json` (oldest header token, least time left, `headerTokensUnder60sLeft`, how often the base
token changed) and `env-tokens.jsonl`.

The fan-out (run a) is binding for the limit; the burst (run d) is for latency only.

### 5. Clean up

```sh
vercel project rm "$PROJECT" --scope kilocode   # deletes the project, its deployments, env vars and custom environments
vercel project ls --scope kilocode 2>&1 | grep "$PROJECT"   # no output
cd / && rm -rf "$WORK"                            # proof-key, patch.json, staging.json and .vercel go with it
# VM: rm -f proof-key drive.ts lib/pass-rule.ts *.json *.jsonl
```
