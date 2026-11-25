# UTS feed Worker

The UTS Worker that serves the key set, and later the revocation feed and the bootstrap endpoint
(`services/uts/README.md`). It runs without placement, so a reader far from Frankfurt is served
near itself.

## Key set

`GET /.well-known/jwks.json` serves the UTS JWKS: the current and next key of all 16 signer objects
(32 keys), plus each retired key until 10 minutes after the last token it signed expired.

- `Cache-Control: max-age=300, stale-if-error=86400` (design 5.7).
- The keys come from the mint Worker's internal `SignerKeys` entrypoint over the `UTS_SIGNER_KEYS`
  service binding, which carries this Worker's deployed name as `props.caller`. The mint Worker
  refuses any other caller.
- An isolate serves the key set it read for 60 seconds, then reads again. It never shares a
  pending read between requests.
- A failed call answers `503 temporarily_unavailable` with `Retry-After: 30`; a refused caller or an
  answer that is not a valid key set answers `500 server_error`. Verifiers keep their last good set
  meanwhile (`stale-if-error`).
- Token keys carry `kid`s that start `uts-token-`. The feed keys join the same `keys` array with a
  prefix of their own, so a verifier selects token keys by `UtsTokenKidSchema` and never accepts a
  feed key for a token.

## Local development

`pnpm dev` runs `wrangler dev --env local` on port 8801; run the mint Worker (`services/uts`) on port
8800 beside it.
