```txt
pnpm install
pnpm run dev
```

```txt
pnpm run deploy
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
pnpm run cf-typegen
```

## Local NEXTAUTH_SECRET

This worker validates Kilo user JWTs in `src/middleware/kilo-jwt-auth.ts` using the `NEXTAUTH_SECRET`
Secrets Store binding.

## Session access invalidation credentials

Web calls `POST /internal/session-access/invalidate` with one credential, chosen by its own
`SESSION_INGEST_SENDER_AUTH`: `INTERNAL_API_SECRET` in `X-Internal-Secret`, or an STS service token
in `Authorization: Bearer`. `SESSION_ACCESS_INVALIDATE_CREDENTIAL_ACCEPT`
(`src/session-access-invalidate-auth.ts`) selects what the route accepts:

- absent, empty or `legacy-only`: `X-Internal-Secret`, exactly as before, with no verifier and no
  key-set fetch;
- `legacy-and-sts`: a request without `Authorization` takes the shared-secret check; one with it
  must carry a valid STS token, and that refusal is final; a request with both headers gets 400;
- `sts-only`: only an STS service token; the shared secret is never read;
- `disabled`: every request answers 401. Any other value answers 500.

The STS token must carry audience `session-ingest`, scope
`session-ingest:session-access.invalidate` and the `web` workload, from the issuer of
`STS_ENVIRONMENT` (`production`, or `development` for `wrangler dev`; staging is closed). In an STS
mode, `GET /.well-known/oauth-protected-resource` serves the RFC 9728 document that every STS
challenge names. Admissions are counted in `kilo_internal_auth` lines (`@kilocode/worker-utils`,
aggregated per minute; the first admission of a bucket is written at once) under route
`cloud_agent_internal`, as before and as the other internal routes, with `auth`
`legacy_shared_secret` or `sts` and `caller`, which for `sts` is the verified workload. Only this
route admits STS, so an `sts` row is always this route. A refusal logs
`session_access_invalidate_sts_refused` with the status and rule. Neither carries a credential. The
other internal routes keep `X-Internal-Secret`.

Production leaves the switch unset until the scope is registered and granted to `web`. The flip
order is `legacy-and-sts` here, then `sts` on web, then `sts-only` here; rollback is `legacy-only`.

## Session export (authenticated)

Use a Kilo user JWT to fetch session data by `session_id`:

```http
GET /api/session/:sessionId/export
Authorization: Bearer <user-jwt>
```

Returns the session ingest payload from the SessionIngestDO for that user.

For local development, Wrangler uses a local Secrets Store (no `--remote`). You can set the local
secret value to match either `.env.development` or `.env.production`.

Note: Passing `--value` will put the secret in your shell history. If that matters, omit `--value`
and use Wrangler's interactive prompt instead.

### Set LOCAL secret to dev value

```bash
STORE_ID=342a86d9e3a94da698e82d0c6e2a36f0
SECRET=$(pnpm -s exec dotenvx get NEXTAUTH_SECRET -f .env.development --format shell | sed -E 's/^NEXTAUTH_SECRET=//')
pnpm -s -C cloudflare-session-ingest exec wrangler secrets-store secret create \
  "$STORE_ID" \
  --name NEXTAUTH_SECRET_PROD \
  --scopes workers \
  --value "$SECRET"
```

### Set LOCAL secret to prod value

```bash
STORE_ID=342a86d9e3a94da698e82d0c6e2a36f0
SECRET=$(pnpm -s exec dotenvx get NEXTAUTH_SECRET -f .env.production --format shell | sed -E 's/^NEXTAUTH_SECRET=//')
pnpm -s -C cloudflare-session-ingest exec wrangler secrets-store secret create \
  "$STORE_ID" \
  --name NEXTAUTH_SECRET_PROD \
  --scopes workers \
  --value "$SECRET"
```

### Verify the LOCAL secret

```bash
STORE_ID=342a86d9e3a94da698e82d0c6e2a36f0
pnpm -s -C cloudflare-session-ingest exec wrangler secrets-store secret list "$STORE_ID"
```
