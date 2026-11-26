# UTS feed Worker

The UTS Worker that serves the key set, and later the revocation feed and the bootstrap endpoint
(`services/uts/README.md`). It runs without placement, so a reader far from Frankfurt is served
near itself.

## Key set

`GET /.well-known/jwks.json` serves the UTS JWKS: the current and next key of all 16 signer objects
(32 keys), plus, for 1 hour and 10 minutes after each rotation, the key that retired (48 keys right
after the 16 signers rotate together).

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
- Token keys carry `kid`s that start `uts-token-`. The feed keys join the same `keys` array with a
  prefix of their own, so a verifier selects token keys by `UtsTokenKidSchema` and never accepts a
  feed key for a token.

## Local development

`pnpm dev` runs `wrangler dev --env local` on port 8801; run the mint Worker (`services/uts`,
`pnpm dev`, which runs `wrangler.dev.jsonc`) on port 8800 beside it.
