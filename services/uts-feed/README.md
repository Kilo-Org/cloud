# UTS feed Worker

The UTS Worker that serves the key set, the revocation feed and the bootstrap endpoint
(`services/uts/README.md`, "Revocation feed"). It runs without placement, so a reader far from
Frankfurt is served near itself.

## Key set

`GET /.well-known/jwks.json` serves the UTS JWKS: the current and next key of all 16 signer objects
(32 token keys) and of the 2 feed objects (4 feed keys), plus, for 1 hour and 10 minutes after each
rotation, the key that retired (54 keys right after every object rotates together).

- `Cache-Control: max-age=300, stale-if-error=86400` (design 5.7), unchanged on every response,
  with two ages in whole seconds beside it:
  - `Age` (RFC 9111 section 5.1): the seconds since the newest keys in the set were read from their
    signer object, which is when the set last got fresh keys. A verifier counts its 5-minute
    lifetime from it, so one failing signer does not make every response arrive expired, and
    verifiers that fetched at different times do not move in lockstep.
  - `Kilo-Key-Set-Oldest-Age`: the seconds since the oldest keys in the set were read. A verifier
    counts its 24-hour last-good limit from it, so it keeps no key longer than 24 hours after that
    signer's last good read (design 7, decision Q55).
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
    other signers stay current. Each signer's keys serve for up to 24 hours after its last good
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
- HTTPS (`httpsFeedSources(origin)`): `GET /revocation/head` (`application/jwt`),
  `GET /revocation/list/<hash>`, `GET /revocation/bootstrap` (`{jwks, head, list}`, the list as
  base64url of its exact bytes); 503 with `Retry-After: 5` when no object answers, 500 on a
  deploy error. These paths are served in development only: the feed names accounts and grants,
  and staging and production answer them 404 until this Worker verifies the caller's STS audience
  token (design 5.6). Opening them is an open budget item (design 3, "Revocation feed").

## Local development

`pnpm dev` runs `wrangler dev --env local` on port 8801; run the mint Worker (`services/uts`) on port
8800 beside it. `test/fixtures/e2e` holds a verifier Worker for the local end-to-end run of the feed
(`services/uts/scripts/feed-e2e.ts`); nothing deploys it.
