# Proof run: Vercel OIDC custom-audience exchange (design 4.4)

STS accepts a Vercel token only after the caller exchanged its function token for one whose
audience is the STS issuer (`../../README.md`, "Vercel callers"). Vercel publishes no rate limit for
that exchange (`POST https://oidc.vercel.com/~token`). This standalone Vercel project measures it
before the first Vercel workload depends on it: the exchange latency, the limit if one shows, and
that 2,500 exchanges (about 15 percent above the 2,200 concurrent Vercel instances at peak) stay
below it. It also records which issuer form an exchanged function token carries
(`https://oidc.vercel.com/kilocode` or `https://oidc.vercel.com/team_ItxRShuUkJaEd9GmXMEEgunb`),
which the STS policy's `issuer` must name.

This directory is not a pnpm workspace (`pnpm-workspace.yaml` lists only `services/*`), has no
`wrangler.jsonc` (the Worker deploy discovers `services/**/wrangler.jsonc`), and holds no secret.
It has no dependencies: the functions use Node 24's `fetch` and web handlers.

| File | What it does |
|---|---|
| `api/exchange.ts` | `POST /api/exchange?n=2500&c=50`: one instance runs `n` exchanges (default 2,500, at most 10,000), `c` at a time (default 50, at most 1,000), each with a fresh `jti`, so no cache answers. Returns latency p50/p95/p99/max, status counts, the first 5 error bodies (JWTs redacted), wall time, and the claims (not the token) of one exchanged token. |
| `api/cold.ts` | `POST /api/cold`: one exchange per invocation, with an instance id and a cold-start flag. |
| `drive.ts` | Fires `--invocations` concurrent `cold` invocations (default 2,500, all at once unless `--concurrency` is lower) and summarizes them. `--dry-run` prints the plan. |
| `vercel.json` | `fluid: false`, so concurrent invocations land on separate instances, as cold instances would; 300 s for the burst function. |

Both functions refuse every request without `x-proof-key` equal to the project's
`PROOF_SHARED_SECRET` (at least 32 characters), and refuse everything while that variable is unset.
The exchange audience comes from `PROOF_AUDIENCE`. No function returns a token.

## Deploy (operator, throwaway project in team `kilocode`)

Run from this directory with the Vercel CLI, logged in to team `kilocode`.

```sh
cd services/sts/proof/vercel-exchange
PROJECT=sts-proof-vercel-exchange-$(date +%Y%m%d)
vercel project add "$PROJECT" --scope kilocode            # a NEW throwaway project
vercel link --yes --scope kilocode --project "$PROJECT"
```

Enable OIDC federation in team issuer mode on that project: dashboard → the project → Settings →
Security → Secure backend access with OIDC federation → Enabled, issuer mode Team. (Or
`PATCH https://api.vercel.com/v9/projects/$PROJECT?teamId=team_ItxRShuUkJaEd9GmXMEEgunb` with
`{"oidcTokenConfig":{"enabled":true,"issuerMode":"team"}}`.) Match the function region to
`kilocode-app` (Settings → Functions) so latency is comparable.

```sh
openssl rand -hex 32 > /tmp/proof-key && chmod 600 /tmp/proof-key
vercel env add PROOF_SHARED_SECRET production < /tmp/proof-key
printf 'https://sts-staging.kiloapps.io' | vercel env add PROOF_AUDIENCE production
vercel deploy --prod --yes          # prints the production URL; production is not behind Vercel Authentication
```

## Run

```sh
export PROOF_SHARED_SECRET="$(cat /tmp/proof-key)"
URL=https://$PROJECT.vercel.app

# 1. Burst from one instance: 2,500 exchanges, 50 then 200 in flight.
curl -sS -X POST -H "x-proof-key: $PROOF_SHARED_SECRET" "$URL/api/exchange?n=2500&c=50"
curl -sS -X POST -H "x-proof-key: $PROOF_SHARED_SECRET" "$URL/api/exchange?n=2500&c=200"

# 2. Real instance concurrency: 2,500 concurrent cold invocations, one exchange each.
#    Run where the file-descriptor limit allows 2,500 sockets (the work VM, or `ulimit -n 10000`).
node drive.ts --dry-run --url "$URL"
node drive.ts --url "$URL" --invocations 2500
```

Record in the PR: each run's JSON (statuses, latency percentiles, wall time, `distinctInstances`,
`coldStarts`) and `exchangedClaims` (`iss` form, `aud` is the STS issuer, `act`,
`expMatchesBaseToken`, `lifetimeSeconds`).

## Pass

- No exchange answers 429 or 5xx (and no timeout or network error) across 2,500 exchanges, in the
  single-instance burst at `c=200` and in the 2,500-invocation fan-out; `drive.ts` prints
  `"passed": true`.
- Latency p50/p95/p99/max are recorded for both runs.
- `exchangedClaims.iss` names the issuer form the STS policies use, `aud` is exactly
  `https://sts-staging.kiloapps.io`, and `expMatchesBaseToken` is `true`.

A 429 or 5xx fails the run: the design's one-exchange-per-instance budget (design 3, cold start) then
needs a different plan before any Vercel workload uses STS.

## Clean up

```sh
vercel project rm "$PROJECT" --scope kilocode   # deletes the project, its deployments and env vars
rm -f /tmp/proof-key && rm -rf .vercel
```
