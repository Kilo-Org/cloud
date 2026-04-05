# Webhook Agent - Cloudflare Worker

A webhook trigger service for Kilo Code that allows users to create named endpoints to capture incoming HTTP requests, store them temporarily, and deliver them to a destination worker via Cloudflare Queue.

## Features

- Create named webhook endpoints per user/org
- Capture and store last 50 requests per ingest endpoint
- Queue-based delivery to cloud-agent-next
- Internal API key authentication for CRUD routes (backend-to-backend)

## Architecture

- **Durable Objects**: TriggerDO for per-trigger request storage with SQLite
- **Queue**: WEBHOOK_DELIVERY_QUEUE for reliable delivery to cloud-agent-next
- **Service Binding**: Direct connection to cloud-agent-next worker

> **Note**: KV registry for abuse prevention is planned for future implementation.
> See [plans/webhook-catcher-design.md](plans/webhook-catcher-design.md#future-work-kv-registry-for-abuse-prevention).

## Development

### Local Secrets Setup

Before running the dev server, you need to set up your local secret store. The `INTERNAL_API_SECRET_DEV` create it with:

```bash
npx wrangler secrets-store secret create 342a86d9e3a94da698e82d0c6e2a36f0 --name INTERNAL_API_SECRET_DEV --scopes workers --value 'YOUR_SECRET_HERE'
```

> **Note**: Get the actual secret value from .env.development with dotenvx.

### Running locally

```bash
pnpm dev
```

The development server will start on `http://localhost:8793`.

### Testing

```bash
# Unit tests
pnpm test

# Integration tests (Cloudflare Workers runtime)
pnpm test:integration
```

### Linting & Type Checking

```bash
pnpm lint
pnpm typecheck
```

## Deployment

### Development Environment

```bash
pnpm deploy:dev
```

Deploys to: `cloudflare-webhook-agent-ingest-dev`

### Production Environment

```bash
pnpm deploy:prod
```

Deploys to: `cloudflare-webhook-agent-ingest`

## API Endpoints

### Quick Reference

| Endpoint                                             | Method | Auth         | Description             |
| ---------------------------------------------------- | ------ | ------------ | ----------------------- |
| `/health`                                            | GET    | None         | Health check            |
| `/inbound/user/:userId/:triggerId`                   | ANY    | None         | Personal webhook ingest |
| `/inbound/org/:orgId/:triggerId`                     | ANY    | None         | Org webhook ingest      |
| `/api/triggers/user/:userId/:triggerId`              | POST   | Internal API | Create personal trigger |
| `/api/triggers/user/:userId/:triggerId`              | DELETE | Internal API | Delete personal trigger |
| `/api/triggers/user/:userId/:triggerId/requests`     | GET    | Internal API | List personal requests  |
| `/api/triggers/user/:userId/:triggerId/requests/:id` | GET    | Internal API | Get personal request    |
| `/api/triggers/org/:orgId/:triggerId`                | POST   | Internal API | Create org trigger      |
| `/api/triggers/org/:orgId/:triggerId`                | DELETE | Internal API | Delete org trigger      |
| `/api/triggers/org/:orgId/:triggerId/requests`       | GET    | Internal API | List org requests       |
| `/api/triggers/org/:orgId/:triggerId/requests/:id`   | GET    | Internal API | Get org request         |

### Webhook URL Format

Webhooks are sent to explicit URLs:

```
/inbound/user/{userId}/{triggerId}
/inbound/org/{orgId}/{triggerId}
```

The `inboundUrl` is returned when creating a trigger.

## Usage Examples

### 1. Create a Trigger (Provisioning)

```bash
# Create a personal webhook trigger
curl -X POST "https://localhost:8793/api/triggers/user/user_abc123/my-github-webhook" \
  -H "X-Internal-API-Key: $INTERNAL_API_SECRET"

# Create an organization webhook trigger
curl -X POST "https://localhost:8793/api/triggers/org/org_xyz789/my-github-webhook" \
  -H "X-Internal-API-Key: $INTERNAL_API_SECRET"
```

**Response:**

```json
{
  "success": true,
  "data": {
    "triggerId": "my-github-webhook",
    "namespace": "user/user_abc123",
    "message": "Trigger created successfully",
    "inboundUrl": "/inbound/user/user_abc123/my-github-webhook"
  }
}
```

### 2. Send a Webhook (External Service)

```bash
curl -X POST "https://localhost:8793/inbound/user/user_abc123/my-github-webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -d '{"ref": "refs/heads/main"}'
```

**Response:**

```json
{
  "success": true,
  "data": {
    "requestId": "req_550e8400-e29b-41d4-a716-446655440000",
    "message": "Webhook captured successfully"
  }
}
```

### 3. List Captured Requests

```bash
# List personal trigger requests
curl "https://localhost:8793/api/triggers/user/user_abc123/my-github-webhook/requests" \
  -H "X-Internal-API-Key: $INTERNAL_API_SECRET"

# List org trigger requests with custom limit
curl "https://localhost:8793/api/triggers/org/org_xyz789/my-github-webhook/requests?limit=10" \
  -H "X-Internal-API-Key: $INTERNAL_API_SECRET"
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "req_550e8400-e29b-41d4-a716-446655440000",
      "timestamp": "2024-01-15T10:30:00.000Z",
      "method": "POST",
      "path": "/inbound/user/user_abc123/my-github-webhook",
      "headers": {
        "content-type": "application/json",
        "x-github-event": "push"
      },
      "body": "{\"ref\":\"refs/heads/main\"}",
      "contentType": "application/json",
      "sourceIp": "192.30.252.1",
      "processStatus": "captured",
      "startedAt": null,
      "completedAt": null,
      "cloudAgentSessionId": null
    }
  ]
}
```

### 4. Get a Single Request

```bash
# Personal trigger
curl "https://localhost:8793/api/triggers/user/user_abc123/my-github-webhook/requests/req_550e8400-e29b-41d4-a716-446655440000" \
  -H "X-Internal-API-Key: $INTERNAL_API_SECRET"

# Organization trigger
curl "https://localhost:8793/api/triggers/org/org_xyz789/my-github-webhook/requests/req_550e8400-e29b-41d4-a716-446655440000" \
  -H "X-Internal-API-Key: $INTERNAL_API_SECRET"
```

### 5. Delete a Trigger

```bash
# Delete personal trigger
curl -X DELETE "https://localhost:8793/api/triggers/user/user_abc123/my-github-webhook" \
  -H "X-Internal-API-Key: $INTERNAL_API_SECRET"

# Delete organization trigger
curl -X DELETE "https://localhost:8793/api/triggers/org/org_xyz789/my-github-webhook" \
  -H "X-Internal-API-Key: $INTERNAL_API_SECRET"
```

## Request Processing Status

Captured requests go through the following status lifecycle:

| Status       | Description                         |
| ------------ | ----------------------------------- |
| `captured`   | Request received and stored         |
| `inprogress` | Being processed by cloud-agent-next |
| `success`    | Successfully processed              |
| `failed`     | Processing failed                   |

## Environment Variables

| Variable                    | Description                   |
| --------------------------- | ----------------------------- |
| `ENVIRONMENT`               | `production` or `development` |
| `KILOCODE_BACKEND_BASE_URL` | Backend API URL               |

## Secrets (via Secrets Store)

| Secret                | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `INTERNAL_API_SECRET` | Internal API key for backend-to-backend authentication |

## Authentication

### Webhook Ingestion (No Auth)

The `/inbound/*` routes accept webhooks from external services without authentication. These endpoints are designed to be publicly accessible so that services like GitHub, Stripe, etc. can send webhooks.

### CRUD API (Internal API Key)

The `/api/*` routes use internal API key authentication for backend-to-backend calls:

- Requests must include `X-Internal-API-Key: <secret>` header
- The secret is validated against `INTERNAL_API_SECRET` from the secrets store
- This is designed for calls from the Kilo backend, not direct user access
- The backend is trusted to call the correct endpoints for the appropriate users/orgs

## Cloudflare Resources

The following resources are already configured:

### Queues

| Queue                  | Environment |
| ---------------------- | ----------- |
| `webhook-delivery`     | Production  |
| `webhook-delivery-dev` | Development |

### Service Bindings

| Binding       | Target Worker          | Environment |
| ------------- | ---------------------- | ----------- |
| `CLOUD_AGENT` | `cloud-agent-next`     | Production  |
| `CLOUD_AGENT` | `cloud-agent-next-dev` | Development |

### KV Namespaces

KV namespaces are used to cache API tokens for webhook delivery. Each namespace needs to be created before deployment.

#### Creating KV Namespaces

**Production:**

```bash
cd cloudflare-webhook-agent-ingest
npx wrangler kv:namespace create "WEBHOOK_TOKEN_CACHE"
```

Copy the generated `id` and update `wrangler.jsonc` in the `kv_namespaces` section:

```json
"kv_namespaces": [
  {
    "binding": "WEBHOOK_TOKEN_CACHE",
    "id": "<your-production-kv-id>"
  }
]
```

**Development:**

```bash
cd cloudflare-webhook-agent-ingest
npx wrangler kv:namespace create "WEBHOOK_TOKEN_CACHE" --env dev
```

Copy the generated `id` and update `wrangler.jsonc` in the dev environment's `kv_namespaces` section:

```json
"kv_namespaces": [
  {
    "binding": "WEBHOOK_TOKEN_CACHE",
    "id": "<your-dev-kv-id>"
  }
]
```

| KV Namespace          | Purpose                                 | Environment |
| --------------------- | --------------------------------------- | ----------- |
| `WEBHOOK_TOKEN_CACHE` | Cache API tokens (30m TTL, 1h validity) | Production  |
| `WEBHOOK_TOKEN_CACHE` | Cache API tokens (30m TTL, 1h validity) | Development |

## Queue Consumer

The worker includes a queue consumer that processes webhook delivery messages from `WEBHOOK_DELIVERY_QUEUE`. When a webhook is captured by TriggerDO, a message is enqueued containing the request ID and trigger location. The queue consumer:

1. Fetches the request data and trigger config from TriggerDO
2. Checks idempotency (only processes requests in `captured` status)
3. Gets or mints an API token (cached in KV for 30 minutes)
4. Renders the prompt from the trigger's template
5. Calls cloud-agent-next's `prepareSession` to create a session
6. Calls cloud-agent-next's `initiateFromKilocodeSessionV2` to start processing
7. Updates request status through the lifecycle

### Queue Configuration

| Setting             | Value | Description                           |
| ------------------- | ----- | ------------------------------------- |
| `max_batch_size`    | 10    | Maximum messages per batch            |
| `max_batch_timeout` | 30    | Seconds to wait before processing     |
| `max_retries`       | 3     | Maximum retry attempts before failing |
