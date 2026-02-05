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
