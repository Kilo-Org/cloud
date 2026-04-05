# Gmail Push - Cloudflare Worker

Receives Gmail push notifications from Google Cloud Pub/Sub and forwards them to the user's kiloclaw bot controller, waking the bot's main session when new emails arrive.

## Architecture

```
Gmail API → Pub/Sub topic → Push subscription → this worker (OIDC validation)
  → Cloudflare Queue (gmail-push-notifications)
  → consumer: service binding → kiloclaw DO (status + gateway token lookup)
  → fly-force-instance-id → controller /_kilo/gmail-pubsub
  → gog gmail watch serve (localhost:3002)
```

## Authentication

Push requests are authenticated via **Google OIDC JWT** (mandatory). The Pub/Sub subscription is configured with `--push-auth-service-account` and `--push-auth-token-audience`, so Google signs every push request with a JWT. The worker validates the token against Google's JWKS, checking issuer, audience, email claim, and email_verified.

## API Endpoints

| Endpoint             | Method | Auth     | Description          |
| -------------------- | ------ | -------- | -------------------- |
| `/health`            | GET    | None     | Health check         |
| `/push/user/:userId` | POST   | OIDC JWT | Receive Pub/Sub push |

## Development

### Local Secrets Setup

```bash
pnpx wrangler secrets-store secret create 342a86d9e3a94da698e82d0c6e2a36f0 --name INTERNAL_API_SECRET_PROD --scopes workers
```

### Running Tests

```bash
pnpm test
```

### Linting & Type Checking

```bash
pnpm lint
pnpm typecheck
```

### Local E2E Testing

Requires: kiloclaw worker running locally, a provisioned bot on Fly with the gmail-push controller image, and a Cloudflare Tunnel for public ingress.

**Terminal 1** - Run kiloclaw worker locally:

```bash
cd kiloclaw && wrangler dev --env dev
```

**Terminal 2** - Run this worker locally (service binding auto-discovers local kiloclaw):

```bash
cd cloudflare-gmail-push && wrangler dev --env dev
```

**Terminal 3** - Expose via CF tunnel:

```bash
cloudflared tunnel --url http://localhost:8787
```

**Push the controller image** (needed for the Fly machine to have the gmail-push route):

```bash
cd kiloclaw && ./scripts/push-dev.sh kiloclaw-machines-dev
```

**Connect Google account** with Pub/Sub setup, passing the tunnel URL to the setup container:

```bash
--gmail-push-worker-url=https://<tunnel-hostname>.trycloudflare.com
```

Then enable notifications in the Settings UI and send an email to the connected Gmail account.

### Smoke Testing

The push route requires a valid Google OIDC JWT, so you can't curl it directly without Pub/Sub. To test the worker logic in isolation, run the unit tests:

```bash
pnpm test
```

For a full E2E smoke test, use the Local E2E Testing flow above — send an email to the connected Gmail account and watch the worker logs for `[gmail-push]` entries.

### Tunnel URL changes

If you restart `cloudflared`, rerun the setup container with the new tunnel URL.

## Deployment

### Development

```bash
wrangler deploy --env dev
```

Deploys to: `cloudflare-gmail-push-dev`

### Production

```bash
wrangler deploy
```

Deploys to: `cloudflare-gmail-push`

## Secrets (via Secrets Store)

| Secret                | Description                            |
| --------------------- | -------------------------------------- |
| `INTERNAL_API_SECRET` | Shared secret for service binding auth |

## Environment Variables

| Variable             | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `OIDC_AUDIENCE_BASE` | Base URL for per-user OIDC audience claim validation |

## Service Bindings

| Binding    | Target Worker | Environment |
| ---------- | ------------- | ----------- |
| `KILOCLAW` | `kiloclaw`    | Production  |
