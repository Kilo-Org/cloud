# UTS feed Worker

The UTS Worker that serves the key set, and later the revocation feed and the bootstrap endpoint
(`services/uts/README.md`). It runs without placement, so a reader far from Frankfurt is served
near itself.

## Key set

`GET /.well-known/jwks.json` serves the UTS JWKS: the current and next key of all 16 signer objects
(32 keys), plus, for 1 hour and 10 minutes after each rotation, the key that retired (48 keys right
after the 16 signers rotate together).

- `Cache-Control: max-age=300, stale-if-error=86400` (design 5.7) while the oldest keys in the set
  were read from their signer object less than 10 seconds ago. An older set also carries `Age`, the
  seconds since that read, and both limits shrink by it: `max-age=<max(0, 300 - Age)>,
  stale-if-error=<max(0, 86400 - Age)>`. A verifier that counts `Age` therefore keeps no key longer
  than 24 hours after its last good read (design 7, decision Q55).
- The keys come from the mint Worker's internal signer-keys route (`GET /internal/signer-keys`),
  fetched over the `UTS_MINT` service binding to the mint Worker's default entrypoint, so the read
  runs in the mint Worker's placed fetch handler. The binding carries this Worker's deployed name as
  `props.caller`; the mint Worker answers any other caller as an unknown path. The answer lists each
  signer with its keys and the time they were read from the signer object, or with its failure.
- Each isolate holds every signer's keys separately, as plain data with their read time, and never
  shares a pending read between requests (`src/jwks.ts`):
  - while its newest keys are under 10 seconds old it serves the held set with no new read;
  - after that, the first request starts one read in `ctx.waitUntil` and is served the held set
    while the newest keys are under 17 seconds old (15 seconds plus the mint Worker's 2-second
    copy); after that a request waits for the read. While every signer read succeeds, a signer key
    change therefore reaches this response within 17 seconds, and a verifier within 5 minutes and
    17 seconds (its `max-age` plus these 17 seconds);
  - an isolate starts at most one read per 10 seconds, whatever the outcome, and aborts a read
    after 10 seconds; a request that needs a read another request started polls for up to 10
    seconds, and keeps polling when a new read replaces a hung one;
  - isolates share no copy: the Cache API is one cache per zone, shared by every Worker on the
    zone, so a copy there could be written by another Worker, and design 7 allows a shared entry
    only under an HMAC from the workload's own secret bundle, which this Worker does not hold yet.
    A new isolate, after a deploy of this Worker too, makes its own first read.
- Failures:
  - any failed read (a failed or timed-out call, a refused caller, an answer that is not a valid
    signer-keys answer) keeps the held set serving;
  - a signer the mint Worker answers without keys keeps the keys this isolate holds for it, so the
    other signers stay current. Each signer's keys serve for up to 24 hours after its last good
    read; then that signer drops out of the set, its tokens fail verification, and the isolate logs
    `uts_feed.key_set.signers_missing`;
  - with no signer's keys held, a failed call answers `503 temporarily_unavailable` with
    `Retry-After: 10`; a refused caller, misconfigured signer objects or an invalid signer-keys
    answer give `500 server_error`.
- Token keys carry `kid`s that start `uts-token-`. The feed keys join the same `keys` array with a
  prefix of their own, so a verifier selects token keys by `UtsTokenKidSchema` and never accepts a
  feed key for a token.

## Local development

`pnpm dev` runs `wrangler dev --env local` on port 8801; run the mint Worker (`services/uts`) on port
8800 beside it.
