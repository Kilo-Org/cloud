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
  verifiers.
