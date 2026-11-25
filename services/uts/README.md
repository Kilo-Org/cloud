# UTS: the user token service

UTS is the OAuth 2.1 authorization server for every token with a user subject. It runs as two
Cloudflare Workers:

| Worker | Package | Hostname (production / staging) | Placement | Serves |
|---|---|---|---|---|
| Mint Worker `uts` | `services/uts` | `uts.kiloapps.io` / `uts-staging.kiloapps.io` | `aws:eu-central-1` | Issuer metadata; later sign-in, token and account endpoints. Binds the signer objects |
| Feed Worker `uts-feed` | `services/uts-feed` | `uts-feed.kiloapps.io` / `uts-feed-staging.kiloapps.io` | none | The UTS key set; later the revocation feed and the bootstrap endpoint |

The issuer, key set URL and local ports of each environment live in
`@kilocode/uts-contracts` (`UTS_ENDPOINTS`); verifiers read them from there.

## Mint Worker

- `GET /.well-known/oauth-authorization-server` serves RFC 8414 metadata: `issuer`, `jwks_uri`
  (on the feed Worker), and empty `response_types_supported` and `grant_types_supported`. An
  endpoint joins the document in the change that makes it answer, so no listed endpoint returns 404.
- Placement runs the fetch handler next to the identity store's primary in Frankfurt:
  `"placement": { "region": "aws:eu-central-1" }`, a Cloudflare placement hint
  (https://developers.cloudflare.com/workers/configuration/placement/#specify-a-cloud-region), which
  runs the Worker in the data center with the lowest latency to that AWS region. Smart placement is
  not used: it places only after it has seen traffic from several locations, and it can leave a
  request where it arrived. Placement does not apply to RPC methods or named entrypoints, so token
  minting stays a fetch handler.
- RFC 9728 protected-resource metadata is not served yet: UTS becomes a protected resource with the
  account API, which publishes its own document at `/.well-known/oauth-protected-resource` then.
- Traces stay off in every block: a trace records Durable Object storage calls, and the signer
  objects hold private keys. Logs stay on.

### Signer objects

`UtsSignerDO` has 16 instances, named `<environment>:signer:<00-15>`, created in the `eu`
jurisdiction with the `weur` location hint (local development runs unscoped). A grant's tokens are
signed by the object `signerForGrant(grantId)` picks: SHA-256 of the grant id, first 4 bytes,
modulo 16.

Each object:

- generates its own Ed25519 keys and keeps them in its KV storage, one record, never in SQL rows
  (a trace would record bound SQL values); no method returns a private key;
- refuses to create keys under any other name or in any other jurisdiction than its environment's;
- publishes the public halves under `uts-token-<signer>-<RFC 7638 thumbprint>`;
- signs with `sign(claims)`: a compact JWS with header `alg: EdDSA`, `typ: at+jwt`, `kid`. It refuses
  a claim set with another issuer or environment, an `iat` more than 60 seconds from now, or an
  `exp` more than 1 hour ahead, the longest UTS token lifetime. `src/keys/claims.ts` is the
  signer's admission check; the published claim contract is phase 2's `AccessTokenClaimsSchema`
  (`@kilocode/sts-contracts`), and every claim set the signer accepts also passes it;
- rotates by alarm: a key signs for 30 days; the next key is published 7 days before it signs (a
  new object publishes its first two keys at once, the second 30 days ahead); a late alarm never
  shortens that lead; a retired key stays published for 1 hour and 10 minutes, until the last token
  it signed has been expired for 10 minutes;
- removes a key at once with `removeKid(kid)`, an internal emergency operation. A removed current
  key is replaced by the published next key. The result is the revocation-feed entry: verifiers
  reject the `kid` until `revokeUntil`. The revocation feed writes it once that feed exists.

### The internal entrypoint

`SignerKeys.publicKeys()` returns every signer's published keys. It answers only the caller
`props.caller = <feed Worker deployed name>` for its own environment and refuses every other
binding. `test/repo/worker-configs.test.ts` fails any Worker config outside the two UTS Workers that
names a UTS Durable Object class or binds the mint Worker, any feed binding whose caller is not the
feed block's own name, and any drift in the UTS configs (names, `eu` jurisdiction, placement,
traces).

## Local development

```sh
cd services/uts && pnpm exec wrangler dev --env local --persist-to ../../.wrangler-uts
cd services/uts-feed && pnpm exec wrangler dev --env local --persist-to ../../.wrangler-uts
curl -s http://localhost:8801/.well-known/jwks.json
```

Development only: `POST http://localhost:8800/__dev/sign` with `{ "grantId": "...", "claims": {...} }`
signs a claim set through the signer the grant picks. The route lives in `src/dev-index.ts`, which
only the `local` block runs (`test/repo` fails a deployed block that runs it), and the claim set
must name the development issuer.

## Tests

- `pnpm test:workers`: unit and runtime tests in the Workers pool (`vitest.config.ts`,
  `wrangler.test.jsonc`): key lifecycle with time travel, signing and verification with `jose`, key
  persistence across restarts, rotation and removal by alarm, the caller check, metadata.
- `pnpm test:node`: the repository config check (`test/repo`).

## Staging checks that need real Cloudflare

workerd implements neither jurisdictions nor placement, so these run after the first staging
deploy of both Workers. Start a tail of the mint Worker first; it records the first key-set read,
which creates all 16 signer objects:

```sh
cd services/uts
pnpm exec wrangler tail uts-staging --format json > /tmp/uts-staging-tail.json &
curl -sS -D - https://uts-feed-staging.kiloapps.io/.well-known/jwks.json -o /tmp/jwks.json
jq '.keys | length' /tmp/jwks.json
curl -sS https://uts-staging.kiloapps.io/.well-known/oauth-authorization-server
```

Expect `200`, `cache-control: max-age=300, stale-if-error=86400`, `32`, and metadata naming
`https://uts-staging.kiloapps.io` and the feed key set.

1. **`eu` jurisdiction and location hint together (design 5.7).** Each object logs
   `uts.signer.bootstrapped` once, when it creates its keys, with its jurisdiction and the data
   center it runs in; an object outside `eu` throws instead of creating keys:

   ```sh
   jq -r '.logs[]?.message[]? | select(type == "string" and contains("uts.signer.bootstrapped"))' /tmp/uts-staging-tail.json | jq -c '{signer, jurisdiction, colo}'
   ```

   Expect 16 lines, each `"jurisdiction":"eu"` and a `colo` in western Europe (the `weur` hint),
   such as `FRA`, `AMS` or `CDG`.

2. **Key persistence across real restarts (design 5.7).** A deploy restarts every object. Record
   the kids, redeploy the mint Worker, wait over a minute for the feed Worker's read to expire, and
   compare; the tail must show no new `uts.signer.bootstrapped` line:

   ```sh
   jq -r '.keys[].kid' /tmp/jwks.json | sort > /tmp/kids-before
   pnpm exec wrangler deploy --env staging
   sleep 70
   curl -sS https://uts-feed-staging.kiloapps.io/.well-known/jwks.json | jq -r '.keys[].kid' | sort | diff /tmp/kids-before - && echo same
   ```

3. **The mint path runs in the placed region (design 5.2).** Cloudflare adds a `cf-placement`
   request header (`remote-<colo>` or `local-<colo>`) to every request of a placed Worker:

   ```sh
   curl -sS -o /dev/null https://uts-staging.kiloapps.io/.well-known/oauth-authorization-server
   jq -r 'select(.event.request.url? | tostring | contains("oauth-authorization-server")) | .event.request.headers["cf-placement"]' /tmp/uts-staging-tail.json
   ```

   Expect `remote-FRA` (or `local-FRA` for a request that entered in Frankfurt).

## Deploys

Both Workers deploy through `.github/workflows/deploy-workers.yml`, which discovers every
`services/*/wrangler.jsonc`. The feed Worker's service binding names the mint Worker, so the first
deploy of an environment deploys `services/uts` before `services/uts-feed`.
