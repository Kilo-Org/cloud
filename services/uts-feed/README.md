# UTS feed Worker

The UTS Worker that serves the key set, the revocation feed and the bootstrap endpoint
(`services/uts/README.md`, "Revocation feed"). It runs without placement, so a reader far from
Frankfurt is served near itself.

## Key set

`GET /.well-known/jwks.json` serves the UTS JWKS: the current and next key of all 16 signer objects
(32 token keys) and of the 2 feed objects (4 feed keys), plus, for 1 hour and 10 minutes after each
rotation, the key that retired (54 keys right after every object rotates together).

- `Cache-Control: max-age=<at most 300>, stale-if-error=<at most 86400>` (design 5.7), with two
  ages in whole seconds beside it:
  - `Age` (RFC 9111 section 5.1): the seconds since the newest keys in the set were read from their
    signer object, which is when the set last got fresh keys. A verifier counts its 5-minute
    lifetime from it, so one failing signer does not make every response arrive expired, and
    verifiers that fetched at different times do not move in lockstep.
  - `Kilo-Key-Set-Oldest-Age`: the seconds since the oldest keys in the set were read. A verifier
    counts its 24-hour last-good limit from it, so it keeps no key longer than 24 hours after that
    signer's last good read (design 7, decision Q55).
  - A standard HTTP cache reads only `Age` and `Cache-Control`: it serves the response fresh for
    `max-age` minus `Age` after it arrives, and on error for `stale-if-error` after that (RFC
    5861). So the limits are cut to end there no later than the oldest keys' hold:
    `max-age = min(300, Age + left)` and `stale-if-error = min(86400, left - (max-age - Age))`,
    where `left` is 86400 minus the oldest age, in whole seconds rounded down. While the oldest
    keys are as old as the newest (every signer read succeeds), that is `max-age=300` and
    `stale-if-error=86100`.
- The keys come from `signerKeys()` on the mint Worker's `SignerKeys` entrypoint, called over the
  `UTS_MINT` service binding. The binding carries this Worker's deployed name as `props.caller`;
  the mint Worker refuses any other caller. Placement does not apply to a named entrypoint, so the
  entrypoint runs where this Worker runs and asks one of the mint Worker's 8 key-set shards in the
  EU, which reads the 16 signer objects at most once per 2 seconds (`services/uts/README.md`). The
  answer lists each signer with its keys and the time they were read from the signer object, or
  with its failure. This Worker validates the result and then disposes it, so the call does not
  stay open; a result that is not an object (`null`) has nothing to dispose and counts as an
  invalid answer.
- Each isolate holds every signer's keys separately, as plain data with their read time, and never
  shares a pending read between requests (`src/jwks.ts`):
  - while its newest keys are under 10 seconds old it serves the held set with no new read;
  - after that, the first request starts one read in `ctx.waitUntil` and is served the held set
    while the newest keys are under 17 seconds old (15 seconds plus the mint Worker's 2-second
    copy); after that a request waits for the read. While every signer read succeeds, a signer key
    change therefore reaches this response within 17 seconds, and a verifier within 5 minutes and
    17 seconds (its `max-age` plus these 17 seconds);
  - an isolate starts at most one read per 10 seconds, whatever the outcome, and gives up a read
    after 10 seconds (a result that lands later is only disposed); a request that needs a read
    another request started polls for up to 10 seconds, and keeps polling when a new read replaces
    a hung one;
  - isolates share no copy: the Cache API is one cache per zone, shared by every Worker on the
    zone, so a copy there could be written by another Worker, and design 7 allows a shared entry
    only under an HMAC from the workload's own secret bundle, which this Worker does not hold yet.
    A new isolate, after a deploy of this Worker too, makes its own first read.
- Failures:
  - any failed read (a failed or timed-out call, a refused caller, a result that is not a valid
    signer-keys read) keeps the held set serving;
  - a signer the mint Worker answers without keys keeps the keys this isolate holds for it, so the
    other signers stay current. A new isolate holds none, but the mint Worker's key-set shards
    keep each signer's last good keys in their storage across restarts and answer them with their
    read time, so a cold isolate whose shard also restarted still serves a failing signer's keys
    instead of a set without them. Each signer's keys serve for up to 24 hours after its last good
    read; then that signer drops out of the set, its tokens fail verification, and the isolate logs
    `uts_feed.key_set.signers_missing`;
  - with no signer's keys held, a failed call answers `503 temporarily_unavailable` with
    `Retry-After: 10`; a refused caller, misconfigured signer objects or an invalid signer-keys
    answer give `500 server_error`.
- Token keys carry `kid`s that start `uts-token-`, feed keys `uts-feed-<0|1>-`, in the same `keys`
  array. A verifier selects token keys by `UTS_TOKEN_KID_PREFIX` and feed keys by
  `UTS_FEED_KID_PREFIX`, and never accepts a feed key for a token. Each feed object's keys follow
  the signer rules above: held separately, served up to 24 hours after their last good read.

## Revocation feed

The feed objects live in the mint Worker, which alone binds them and so alone writes entries. This
Worker reads them through the mint Worker's `FeedReads` entrypoint (`UTS_FEED_READS`, bound with
this Worker's deployed name as `props.caller`) and serves (`src/revocation.ts`):

- **Head** (a compact JWS, `typ: kilo-feed-head+jwt`, payload `{iat, list_hash}`): feed object 0
  gets 1 second to answer, then feed object 1 is read. An object that failed, answered
  `unavailable`, or answered a head over 20 seconds old is skipped for 30 seconds, unless both
  failed. A head's `iat` is the start of its object's last good backfill. The head stays in each
  data center's cache for 5 seconds, under a key that carries this deployment's version id, and its
  `iat` and hash are read from the head itself; a cached head past 20 seconds is not served. Both
  failing answers `unavailable`; both refusing to load answers `misconfigured`.
- **List** by its hash: from the data center's cache (10 minutes) when its bytes still hash to the
  name, otherwise from the objects; bytes that do not match the hash are refused and the other
  object is read; objects skipped after a failure are read last. `not_found` only when every object
  holds no such list.
- **Bootstrap**: the key set, the head and the list it covers in one answer, whole or not at all.
- **Key set over RPC** (`FeedReader.jwks()`): the held key set and its two ages, with no feed-object
  read; `unavailable` while no signer key is held.

Transports (`@kilocode/uts-contracts`, the shapes of `@kilocode/verify`'s ports):

- Workers bind the named entrypoint `FeedReader` (`head()`, `list(hash)`, `bootstrap()`) with their
  own deployed name as `props.caller`; `services/uts/test/repo` fails any other caller value. A
  binding without a caller is refused; a failed read answers `unavailable` with
  `retryAfterSeconds: 5`. `feedReaderSources(binding)` adapts it to the verifier's ports.
- HTTPS (`httpsFeedSources(origin, fetcher)`): `GET /revocation/head` (`application/jwt`),
  `GET /revocation/list/<hash>`, `GET /revocation/bootstrap` (`{jwks, key_ages, head, list}`, the
  list as base64url of its exact bytes); 503 with `Retry-After: 5` when no object answers, 500 on
  a deploy error. The fetcher adds the caller's STS token to every request.

### Authenticated HTTPS feed

The feed names accounts and grants, so the HTTPS paths answer only a Vercel or Fly workload that
proves itself with an STS service token (design 5.6, `src/https-auth.ts`). The key set stays
public.

- **Switch.** `FEED_HTTPS_ENABLED` must be exactly `true` and `STS_URL` must be the STS issuer of
  this Worker's environment (`STS_ISSUERS`; development also takes a bare loopback origin, for the
  local runs). Otherwise the three paths answer `503 temporarily_unavailable` with
  `Retry-After: 60` before any token check or feed read, never 500. Production and staging set
  neither (`services/uts/test/repo` checks both blocks and refuses any value but `true` or another
  environment's issuer); the local block sets both.
- **Caller check.** `@kilocode/verify` checks `Authorization: Bearer <STS token>` against the STS
  key set (`httpJwksSource(STS_URL)`, one verifier per isolate): audience `uts-feed`, scope
  `uts-feed:revocation.read`, environment, expiry, signature. Then the token's workload must be in
  `UTS_FEED_HTTPS_WORKLOADS` for this environment: `web` and `ai-gateway` in development and
  staging, none in production until activation. No token: 401 with a Bearer challenge; another
  audience or scope, or a workload not listed: 403; another issuer or environment, an expired or
  badly signed token: 401; an unreachable STS key set: 503 with `Retry-After`. A refusal logs
  `uts_feed.https.refused` with the reason and workload, never the token. Nothing is read from a
  feed object before the check passes.
- **Caching.** Every answer is `private`, so no shared cache keeps one:
  - head: `no-cache`, a weak `ETag` `W/"<iat>-<list hash>"` and `Kilo-Feed-Head-Age` (seconds
    since the head's `iat`); an `If-None-Match` that matches answers 304 with no body.
    `httpsFeedSources` sends the last `ETag` it read and answers a 304 with the held head.
  - list: `max-age=600, immutable` and the hash as a strong `ETag`; a matching `If-None-Match`
    answers 304 without reading a feed object.
  - bootstrap: `no-store`, with `Age`, `Kilo-Key-Set-Oldest-Age` and `Kilo-Feed-Head-Age`.
- **Cost.** Every request, a 304 included, is one billed Worker invocation: the request carries
  `Authorization` and the answer is `private`, so no Cloudflare cache answers it in front of the
  Worker. Per verifier instance a head read at most every 10 seconds, a list read only when the
  head names a new list, and one bootstrap per cold start; the monthly arithmetic is in design 3
  ("Revocation feed"). Invocation logs keep a 5 percent head sample
  (`observability.logs.head_sampling_rate` 0.05, inherited by every block), so logs do not grow
  the bill with every read; `services/uts/test/repo` refuses a rate above 0.05. The refusal log
  lines above are sampled the same way.

## Local development

`pnpm dev` runs `wrangler dev --env local` on port 8801; run the mint Worker (`services/uts`,
`pnpm dev`, which runs `wrangler.dev.jsonc`) on port 8800 beside it. The local block's HTTPS feed
accepts tokens of the local STS (`http://localhost:8825`); the end-to-end runs replace it with
their own stand-in (`--var STS_URL:http://127.0.0.1:<port>`, `services/uts/scripts/fake-sts.ts`).
`test/fixtures/e2e` holds a verifier Worker for the local end-to-end run of the feed
(`services/uts/scripts/feed-e2e.ts`); nothing deploys it. `services/uts/scripts/feed-https-e2e.ts`
runs the HTTPS feed's callers, refusals, 304s and the verification library over it.
