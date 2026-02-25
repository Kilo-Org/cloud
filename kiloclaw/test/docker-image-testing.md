# Updating and Testing the KiloClaw Docker Image

This runbook walks you through the full cycle: making a change to the Docker image, validating it locally, pushing to Fly.io, and testing end-to-end.

## Overview

### Files you'll typically change

| File                           | Purpose                                                   |
| ------------------------------ | --------------------------------------------------------- |
| `kiloclaw/Dockerfile`          | Base image, dependencies, OpenClaw version                |
| `kiloclaw/start-openclaw.sh`   | Container entrypoint (config generation, process startup) |
| `kiloclaw/scripts/push-dev.sh` | Dev image build and push script                           |

### Workflow at a glance

```
Edit → Build locally → Test locally → Push to Fly → Test end-to-end → Cleanup
```

## Prerequisites

### Cloud backend setup

Follow the [Cloud README](../../README.md) "Getting Started" section to set up:

- Vercel env pull (step 1)
- Postgres via Docker Compose (step 2)
- Database migrations (step 3)
- Dev server on localhost:3000 (step 4)

> **Important for KiloClaw:** The `.env.development.local` file must NOT override
> `NEXTAUTH_SECRET` or `OPENROUTER_API_KEY` — these must come from the Vercel-pulled
> `.env.local` so JWTs and API keys work correctly when Fly machines authenticate
> back through ngrok.

### KiloClaw-specific setup

**1. Fly CLI installed and authenticated**

```bash
brew install flyctl
fly auth login
fly auth docker   # required for registry push
```

**2. ngrok installed and authenticated** (required for model access from Fly machines)

```bash
brew install ngrok
# Sign up at https://dashboard.ngrok.com/signup
# Copy your authtoken from https://dashboard.ngrok.com/get-started/your-authtoken
ngrok config add-authtoken <your-token>
```

See also: [Cloud README — Local development behind HTTPS tunnel](../../README.md#local-development-behind-https-tunnel)

**3. KiloClaw Worker**

```bash
cd cloud/kiloclaw
pnpm start
```

**4. DEV_MODE consideration**

- If `DEV_MODE=false` in `.dev.vars`, the worker requires real JWT auth from the
  Cloud backend. Provision and access must go through the UI or use the platform
  API with the internal API key.
- If `DEV_MODE=true`, the worker sets userId to `dev@kilocode.ai` for all requests,
  which won't match instances provisioned for real user IDs. Only use this for
  quick smoke tests where auth doesn't matter.

### Verify services

```bash
# Check Postgres
docker ps | grep postgres

# Check Cloud Backend
curl http://localhost:3000

# Check KiloClaw Worker
curl http://localhost:8795
```

## Step 1: Make Your Changes

Edit the relevant files in `kiloclaw/`:

- **Dockerfile** — Change the base image, add packages, update the OpenClaw version, modify directory structure
- **start-openclaw.sh** — Change config generation, startup order, environment variable handling

To debug a startup script change interactively:

```bash
docker build -t kiloclaw:test -f Dockerfile .

docker run --rm \
  -e KILOCODE_API_KEY=test-key \
  -e OPENCLAW_GATEWAY_TOKEN=test-token \
  kiloclaw:test \
  bash -c 'bash -x /usr/local/bin/start-openclaw.sh 2>&1 | head -50'
```

## Step 2: Build and Test Locally

> **Working directory:** All `docker build` and test commands in this step assume
> you're in the `kiloclaw/` directory (`cd cloud/kiloclaw`).

### Build the image

```bash
docker build -t kiloclaw:test -f Dockerfile .
```

### Quick validation

Run these three tests before pushing any image changes:

```bash
# 1. Build test
docker build -t kiloclaw:test -f Dockerfile . && \
docker run --rm kiloclaw:test openclaw --version

# 2. Startup test
docker run -d --name kiloclaw-test \
  -e KILOCODE_API_KEY=test-key \
  -e OPENCLAW_GATEWAY_TOKEN=test-token \
  kiloclaw:test && \
sleep 15 && \
docker ps | grep kiloclaw-test && \
docker stop kiloclaw-test && \
docker rm kiloclaw-test

# 3. Gateway test (uses port 18800 to avoid conflicts with running instances)
docker run -d --name kiloclaw-gateway \
  -p 18800:18789 \
  -e KILOCODE_API_KEY=test-key \
  -e OPENCLAW_GATEWAY_TOKEN=test-token \
  kiloclaw:test && \
sleep 15 && \
curl -f http://localhost:18800/ && \
docker stop kiloclaw-gateway && \
docker rm kiloclaw-gateway
```

### Verify components

```bash
# Check versions
docker run --rm kiloclaw:test node --version        # v22.13.1
docker run --rm kiloclaw:test openclaw --version    # 2026.2.9

# Check directories
docker run --rm kiloclaw:test ls -la /root/.openclaw
docker run --rm kiloclaw:test ls -la /root/clawd

# Check OpenClaw doctor
# Note: Warnings about missing config, session dirs, and gateway not running
# are expected — the entrypoint (start-openclaw.sh) handles onboarding and
# config generation at runtime, not during a standalone `openclaw doctor` run.
docker run --rm \
  -e KILOCODE_API_KEY=test-key \
  kiloclaw:test \
  openclaw doctor

# Inspect runtime config (entrypoint generates config at startup)
docker run -d --name kiloclaw-config \
  -e KILOCODE_API_KEY=test-key \
  -e OPENCLAW_GATEWAY_TOKEN=test-token \
  kiloclaw:test && \
sleep 15 && \
docker exec kiloclaw-config cat /root/.openclaw/openclaw.json | jq . && \
docker stop kiloclaw-config && docker rm kiloclaw-config
```

### Compare image sizes (when changing the Dockerfile)

```bash
docker images kiloclaw --format "table {{.Tag}}\t{{.Size}}"
```

## Step 3: Push to Fly for End to End Testing

The `push-dev.sh` script builds for linux/amd64 and pushes to a Fly app's registry.
It reads `FLY_APP_NAME` from `.dev.vars` (defaults to `kiloclaw-dev`) and updates
`FLY_IMAGE_TAG` in `.dev.vars` so the worker uses the new tag on next machine create.

> **Version tracking:** Make sure `OPENCLAW_VERSION` is set in `.dev.vars` to match
> the `openclaw@x.x.x` version in the Dockerfile (see `.dev.vars.example`). This
> enables the worker to self-register the version → image tag mapping in KV, so
> provisioned instances track which OpenClaw version they're running. Without it,
> version tracking fields will be null (instances still work via `FLY_IMAGE_TAG` fallback).
> Update this value whenever you bump the OpenClaw version in the Dockerfile.

```bash
# Authenticate Docker with Fly registry (also in prerequisites, but tokens expire per session)
fly auth docker

# Push to a specific app's registry (recommended)
./scripts/push-dev.sh <your-dev-app-name>

# Or let it read FLY_APP_NAME from .dev.vars
./scripts/push-dev.sh
```

**Verify the image was pushed:**

```bash
# Check the image exists in the registry
TAG=$(grep '^FLY_IMAGE_TAG=' .dev.vars | cut -d= -f2)
APP=$(grep '^FLY_APP_NAME=' .dev.vars | cut -d= -f2)
docker manifest inspect "registry.fly.io/$APP:$TAG"

# Should return a JSON manifest with "architecture": "amd64", "os": "linux"
# If you get "NAME_UNKNOWN", re-run `fly auth docker` and try again
```

**Warm the image on Fly (recommended):**

The registry verify above only confirms the image exists — Fly compute nodes still need
to pull it on first use, which takes 1-3 minutes and causes 408 timeouts during
provisioning. Pre-warm by creating a throwaway machine with the new tag:

```bash
# Create a throwaway machine that pulls the image (image gets cached on compute node)
fly machine run "registry.fly.io/$APP:$TAG" \
  --app "$APP" \
  --region iad \
  --env KILOCODE_API_KEY=warm

# Find the machine ID from the list (fly machine run output format varies)
fly machines list --app "$APP"
# Copy the ID from the output (e.g. 0805459b00d908)

# Wait for it to reach "started" (image is now cached)
fly machine status <machine-id> --app "$APP"

# Clean up the throwaway machine
fly machine destroy <machine-id> --app "$APP" --force
```

After warming, subsequent machine creates with this tag start in seconds instead of
timing out. You can skip this step if you're okay waiting 1-3 minutes on first provision
(see [408 timeout troubleshooting](#fly-io-issues) if that happens).

**If using ngrok for model access (Option A below),** set that up now before restarting
the worker, so you only restart once:

```bash
ngrok http 3000
# Note the https URL, e.g.: https://abc123.ngrok-free.dev

# Add to .dev.vars:
KILOCODE_API_BASE_URL=https://<your-ngrok-url>.ngrok-free.dev/api/openrouter/
```

**Restart the local KiloClaw worker** to pick up the new `FLY_IMAGE_TAG` (and ngrok URL if set):

```bash
cd cloud/kiloclaw && pnpm start
```

> **Important:** Existing running instances will NOT pick up the new image tag
> automatically. After restarting the worker, you must **destroy and re-provision**
> from the Cloud UI (or via the platform API) for the new image to take effect.
> Simply stopping and starting the instance is not sufficient — the machine
> config (including image tag) is set at provision time.

> **Note:** Each Fly app has its own private registry at `registry.fly.io/<app-name>`.
> Cross-app pulls work within the same Fly org. The script pushes to
> `registry.fly.io/<app-name>:dev-<timestamp>`.
> Using a deterministic image name is OK, because all registry operations require auth.

## Step 4: Test on Fly.io

The worker auto creates per user Fly apps named `dev-{sha256(userId)[:20]}` when
`WORKER_ENV=development`. You don't create Fly apps manually — the worker handles it
during provisioning.

### Finding your Fly dev app name and userId

The Cloud UI at localhost:3000/claw shows an **Instance ID** (e.g.
`NDQ3OTIwMzUtMGZiMC00NWUxLTkxMTUtYWM2NTc1ZjFmZmE3`). This is your
base64-encoded userId. You can derive both your userId and Fly app name from it:

```bash
# Copy the Instance ID from the Cloud UI (localhost:3000/claw → Instance tab)
INSTANCE_ID="<paste-instance-id-here>"

# Decode to get your userId
USER_ID=$(echo "$INSTANCE_ID" | base64 -d)
echo "userId: $USER_ID"

# Derive the Fly dev app name (sha256 of userId, first 20 hex chars, prefixed with dev-)
FLY_DEV_APP="dev-$(echo -n "$USER_ID" | shasum -a 256 | cut -c1-20)"
echo "flyAppName: $FLY_DEV_APP"
```

Set the API key for platform API calls:

```bash
API_KEY=$(grep '^INTERNAL_API_SECRET=' .dev.vars | cut -d= -f2)
```

> **Alternative:** If you don't have the UI open, you can also find dev apps
> with `fly apps list | grep '^dev-'`, or query the local database:
>
> ```bash
> docker exec dev-postgres-1 psql -U postgres \
>   -t -A -c "SELECT id, google_user_email FROM kilocode_users"
> ```

### Option A: Cloud UI (recommended, full model access via ngrok)

The recommended flow for full end-to-end testing with model access.
Requires ngrok — if you didn't set it up in Step 3, do so now and restart the worker.

1. Log in to the Cloud backend at **localhost:3000**
2. Navigate to the KiloClaw dashboard and provision/start the instance

The UI calls `generateApiToken()` which creates a JWT signed with the correct
`NEXTAUTH_SECRET`. This JWT is passed to the Fly machine, which uses it to
authenticate against your local Cloud backend (via ngrok) for model access.

The flow: Fly machine → ngrok → local Cloud backend (validates JWT, proxies to
OpenRouter with real API key) → model response streams back.

> **Note:** Free ngrok tunnels get a stable URL per session but the URL changes
> when you restart ngrok. You'll need to update `.dev.vars` and re-provision
> if the tunnel restarts. Consider a paid ngrok plan for a fixed domain.

**Check status via platform API:**

```bash
curl -s "http://localhost:8795/api/platform/status?userId=$USER_ID" \
  -H "x-internal-api-key: $API_KEY" | jq .

# Should show:
# - status: "running"
# - flyMachineId: "<machine-id>"
# - flyAppName: "dev-<hash>"
```

### Option B: Platform API (no model access)

For testing provisioning and gateway startup without needing model access.
Uses the platform API directly with a test key — the machine will start and
the gateway will respond, but chat will not work (invalid API key).

```bash
API_KEY=$(grep '^INTERNAL_API_SECRET=' .dev.vars | cut -d= -f2)

# 1. Provision instance
curl -X POST http://localhost:8795/api/platform/provision \
  -H "x-internal-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId": "test-user-fly", "kilocodeApiKey": "test-key"}'

# 2. Start instance (creates Fly machine)
curl -X POST http://localhost:8795/api/platform/start \
  -H "x-internal-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId": "test-user-fly"}'

# 3. Check status
curl -s "http://localhost:8795/api/platform/status?userId=test-user-fly" \
  -H "x-internal-api-key: $API_KEY" | jq .
```

### Option C: Direct Fly Machine (bypass worker)

For quick image smoke tests without involving the worker. This creates a standalone
machine with plain (unencrypted) env vars — useful for validating the image itself.

```bash
# Use any existing Fly app you have access to
fly machine run registry.fly.io/<app-name>:<tag> \
  --app <app-name> \
  --region iad \
  --env KILOCODE_API_KEY=test-key \
  --env OPENCLAW_GATEWAY_TOKEN=test-token

# Check logs
fly logs --app <app-name> --no-tail

# Cleanup
fly machine destroy <machine-id> --app <app-name> --force
```

### Verify machine status and logs

```bash
# Get flyAppName from the status API response, or find it directly:
FLY_DEV_APP=$(curl -s "http://localhost:8795/api/platform/status?userId=$USER_ID" \
  -H "x-internal-api-key: $API_KEY" | jq -r .flyAppName)
# Or if the worker isn't running: fly apps list | grep '^dev-'

# Check machine status
fly status --app $FLY_DEV_APP

# View machine logs (streams continuously; Ctrl+C to stop)
fly logs --app $FLY_DEV_APP --no-tail

# Should see:
# - "No KILOCLAW_ENV_KEY found" or decryption messages
# - "Starting OpenClaw Gateway..."
# - "listening on ws://0.0.0.0:18789"
# - No errors
```

Verify it's running your dev image:

```bash
fly machines list --app $FLY_DEV_APP
# Check the IMAGE column shows your expected tag (e.g. kiloclaw-machines:dev-1771448521)

# Optional: add a marker file to the Dockerfile for verification
# Place it outside /root (which is a Fly volume mount that hides image-layer files)
# Example: RUN echo "my-test-marker" > /etc/image-marker
# Then verify: fly ssh console --app $FLY_DEV_APP -C "cat /etc/image-marker"
```

### Test gateway access

Gateway access goes through the worker's catch all proxy, which requires JWT auth.

**With ngrok (full model access):** Use the Cloud backend UI at localhost:3000.
The UI connects via WebSocket automatically. Send a chat message to verify
model access works end-to-end through the ngrok tunnel.

**Without ngrok (gateway only):** Use the platform API to get a gateway token:

```bash
curl -s "http://localhost:8795/api/platform/gateway-token?userId=$USER_ID" \
  -H "x-internal-api-key: $API_KEY" | jq .
```

## Step 5: Cleanup

### Destroy via worker API (recommended)

Always destroy through the worker API to keep Durable Object state consistent:

```bash
# Use the same USER_ID and API_KEY variables from Step 4, or for Option B test users:
curl -X POST http://localhost:8795/api/platform/destroy \
  -H "x-internal-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$USER_ID\"}"
```

> **Warning:** Avoid using `fly apps destroy` directly — this deletes the Fly app
> but leaves the worker's Durable Object state intact, causing consistency errors.
> Always destroy through the worker's platform API.

### Clean up local Docker containers

```bash
docker rm -f $(docker ps -aq --filter "ancestor=kiloclaw:test")
```

## Troubleshooting

### Prerequisites issues

For Postgres or Cloud backend issues, see the [Cloud README](../../README.md).
General approach: check if the port is already in use with `lsof -i :<port>`.

**Worker fails**

```bash
lsof -i :8795  # Check port
cd cloud/kiloclaw && pnpm start
```

### Container issues

**Container won't start**

```bash
# Check logs
docker logs kiloclaw-test

# Interactive shell
docker run -it --rm \
  -e KILOCODE_API_KEY=test-key \
  -e OPENCLAW_GATEWAY_TOKEN=test-token \
  kiloclaw:test \
  bash
```

**Gateway not responding**

```bash
# Check process
docker exec kiloclaw-test ps aux | grep openclaw

# Test from inside
docker exec kiloclaw-test curl http://localhost:18789/
```

### Fly.io issues

**408 timeout on start/updateMachine (first image pull)**

This happens when you skip the "Warm the image" step in Step 3. Fly needs 1-3 minutes
to pull a new image tag to a compute node, and the worker's API call times out (~60s).
Fly continues pulling in the background — do NOT destroy and re-provision, just wait.

```bash
# Poll until the machine reaches "started" state:
fly machines list --app $FLY_DEV_APP
# "replacing" = still pulling (wait 1-3 min)
# "started"   = ready

# If the Cloud UI shows an error, try clicking Start again once the
# machine reaches "started" — the DO state may need to catch up.
# Subsequent starts with the same image tag will be fast (cached).
```

**Machine won't start**

```bash
# View logs (use flyAppName from status, not a hardcoded name)
fly logs --app $FLY_DEV_APP --no-tail

# Common causes:
# - Missing KILOCODE_API_KEY (check encrypted env var flow)
# - Image tag mismatch (check FLY_IMAGE_TAG in .dev.vars)
# - Old image without decryption support in start-openclaw.sh
# - KILOCLAW_ENV_KEY stuck in "Staged" (no machine to deploy to)
```

**Can't access gateway**

```bash
# Verify machine is running
fly status --app $FLY_DEV_APP

# Check from inside the machine
fly ssh console --app $FLY_DEV_APP -C "curl -s http://localhost:18789/"
```

**Local worker can't reach Fly machine**

```bash
# Verify FLY_API_TOKEN is set in .dev.vars
grep FLY_API_TOKEN .dev.vars

# Test Fly API access directly
FLY_TOKEN=$(grep '^FLY_API_TOKEN=' .dev.vars | cut -d= -f2-)
curl -s -H "Authorization: Bearer $FLY_TOKEN" \
  https://api.machines.dev/v1/apps/$FLY_DEV_APP/machines | jq .
```

**Origin not allowed (WebSocket)**

```bash
# The worker rewrites the Origin header for Fly proxy requests.
# If you still see this, check OPENCLAW_ALLOWED_ORIGINS in .dev.vars
# includes the Fly app URL: https://<fly-app-name>.fly.dev
```

**Chat returns single character or empty responses**

```bash
# The model API key is likely invalid. Verify:
# 1. ngrok is running and KILOCODE_API_BASE_URL in .dev.vars points to it
# 2. .env.development.local does NOT override NEXTAUTH_SECRET or OPENROUTER_API_KEY
# 3. Instance was provisioned from the Cloud UI (not curl with a test key)
# 4. Worker was restarted after updating .dev.vars

# Check the machine config to verify the base URL:
fly ssh console --app $FLY_DEV_APP -C \
  "cat /root/.openclaw/openclaw.json | grep baseUrl"
# Should show your ngrok URL, not api.kilo.ai
```

**ngrok tunnel changed URL**

```bash
# Free ngrok URLs change on restart. Update .dev.vars:
KILOCODE_API_BASE_URL=https://<new-ngrok-url>.ngrok-free.dev/api/openrouter/

# Then restart worker and re-provision (destroy + provision from UI)
```

## Best Practices

- Always run quick validation (Step 2) before pushing changes
- Test incrementally — one change at a time
- Always destroy through the worker API, never `fly apps destroy` directly
- After pushing a new image, restart the worker and re-provision to pick up the new tag
- Use `fly machine stop` instead of `destroy` to preserve volumes during testing
- Monitor Fly machine costs (machines are billed per second)
- Clean up test machines after testing
- Check logs when tests fail
- Update version checks when OpenClaw version changes
- The gateway may log "update available" notices — this is normal and does not indicate a problem. To bump the pinned version, update the `openclaw@x.x.x` version in the Dockerfile `npm install -g` line and update the version checks in this runbook to match

## See Also

- Push script: [`../scripts/push-dev.sh`](../scripts/push-dev.sh)
- Fly.io docs: [https://fly.io/docs/machines/](https://fly.io/docs/machines/)
