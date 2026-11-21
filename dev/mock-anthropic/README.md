# Mock Claude Platform OAuth

A loopback stand-in for the Claude Platform OAuth endpoints, so "Sign in with
Claude" runs end to end without an Anthropic account or network access.

## Run

```bash
pnpm dev:mock-anthropic
```

Run it with the web app's environment: it reads the same
`CLAUDE_FEDERATION_*` values and app client IDs to check Kilo's client
assertions. It binds to `127.0.0.1` on `MOCK_ANTHROPIC_PORT` (default `4791`).

Point the web app at it:

```bash
CLAUDE_OIDC_ISSUER=http://127.0.0.1:4791/users
CLAUDE_AUTH_BASE_URL=http://127.0.0.1:4791
```

Generate a throwaway federation key for local use:

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256
```

## Behavior

- The approval page lets you pick the email in the ID token and whether it is
  verified, then approve or decline. Decline returns `error=access_denied`.
- The token endpoint enforces the rules of auth.claude.com: a JSON body, a client
  assertion signed by the federation key for the app's audience with a single
  `aud`, a one-hour lifetime cap, a single-use `jti`, a single-use code that
  expires after 5 minutes, an exact redirect URI, and a PKCE S256 verifier.
- ID tokens are ES256, expire after 10 minutes, and carry a pairwise `sub`.
- `GET /test/requests` lists the requests received, without assertions or
  verifiers, with the `anthropic-beta` header each one sent.
- `GET /test/profiles` lists the profiles and `GET /test/links` the links that
  survive them. Like Anthropic, a link outlives its profile: deleting a profile
  leaves the organization linked to the app, so linking that organization again
  fails with `user_profile_already_linked` until `POST
  /v1/user_profiles/{id}/unlink` ends the link — which it does even for a deleted
  profile, so the recovery path can be exercised. The unlink endpoint requires the
  `user-profiles-search-2026-08-30` beta header, a body of only `oauth_app_id`,
  and no query parameters, then answers `{"revoked_connection_ids": [...]}`.
- `POST /test/config` sets the refusal code and the number of leading `503`
  responses that billed requests receive.
