# UTS feed Worker

The UTS Worker that serves the key set, and later the revocation feed and the bootstrap endpoint
(`services/uts/README.md`). It runs without placement, so a reader far from Frankfurt is served
near itself.

## Key set

`GET /.well-known/jwks.json` serves the UTS JWKS: the current and next key of all 16 signer objects
(32 keys), plus, for 1 hour and 10 minutes after each rotation, the key that retired (48 keys right
after the 16 signers rotate together).

- `Cache-Control: max-age=300, stale-if-error=86400` (design 5.7).
- The keys come from the mint Worker's internal signer-keys route (`GET /internal/signer-keys`),
  fetched over the `UTS_MINT` service binding to the mint Worker's default entrypoint, so the read
  runs in the mint Worker's placed fetch handler. The binding carries this Worker's deployed name as
  `props.caller`; the mint Worker answers any other caller as an unknown path.
- Each isolate holds the last key set as plain data and never shares a pending read between
  requests (`src/jwks.ts`):
  - for 10 seconds after a read it serves the held set with no new read;
  - after that, the first request starts one read in `ctx.waitUntil` and is served the held set,
    while the set is under 15 seconds old; once it is 15 seconds old, a request waits for the read.
    A signer key change therefore reaches this response within 15 seconds, and a verifier within
    5 minutes and 15 seconds (its `max-age` plus these 15 seconds);
  - an isolate runs at most one read at a time, and after a failed read it starts the next one 10
    seconds later; a request that needs a read another request started polls for its result;
  - isolates share no copy: the Cache API is one cache per zone, shared by every Worker on the
    zone, so a copy there could be written by another Worker, and design 7 allows a shared entry
    only under an HMAC from the workload's own secret bundle, which this Worker does not hold yet.
    A new isolate, after a deploy of this Worker too, makes its own first read.
- Failures:
  - a failed or `unavailable` read keeps the held set serving for up to 24 hours, the verifier's own
    `stale-if-error` limit;
  - with nothing held, a failed call answers `503 temporarily_unavailable` with `Retry-After: 10`,
    and a refused caller, a misconfigured signer object or an answer that is not a valid key set
    answers `500 server_error`.
- Token keys carry `kid`s that start `uts-token-`. The feed keys join the same `keys` array with a
  prefix of their own, so a verifier selects token keys by `UtsTokenKidSchema` and never accepts a
  feed key for a token.

## Local development

`pnpm dev` runs `wrangler dev --env local` on port 8801; run the mint Worker (`services/uts`) on port
8800 beside it.
