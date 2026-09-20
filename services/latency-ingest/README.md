# Latency Ingest Worker

Cloudflare Worker that ingests client-observed request latency from the mobile app. The app
measures `ttfbMs` (time to response headers) and `totalMs` (body read) per tRPC call, batches the
samples, and POSTs them here. The Worker emits one structured log line per sample and Cloudflare
logpush ships those lines to Axiom, where they join the server's `trpc_timing` rows by `requestId`.

## Endpoints

- `POST /v1/latency` — accepts a batch of latency samples.
- `GET /health` — liveness probe.

Every other method/path combination is `404`.

### `POST /v1/latency`

Headers:

| Header | Required | Purpose |
|---|---|---|
| `authorization: Bearer <session>` | yes | Session identity, presence-checked only (the Worker cannot verify it). Never logged or stored, and never the rate-limit key. |
| `x-kilo-app-version` | yes | Must match `/^\d+(\.\d+)*$/` and be at least `MIN_APP_VERSION`. |
| `x-kilo-app-platform` | no | `ios` or `android`; logged as `platform` (`unknown` when absent). |
| `cf-connecting-ip` | set by the edge | The trusted rate-limit identity. Cloudflare overwrites any caller value. |

Body (strict schema):

```json
{
  "samples": [
    {
      "requestId": "http-call-id",
      "procedures": ["user.getMe"],
      "ttfbMs": 12,
      "totalMs": 34,
      "status": 200,
      "ok": true
    }
  ]
}
```

Responses:

| Status | Meaning |
|---|---|
| `204` | Accepted. An empty batch (`{"samples":[]}`) is also accepted with no log lines. |
| `400` | Unparseable JSON or a schema mismatch (unknown keys included). |
| `401` | Missing or non-bearer `authorization`. |
| `403` | Missing, malformed, or below-minimum `x-kilo-app-version`. |
| `413` | Body over 64 KiB (enforced while reading, so an oversized chunked body is never buffered), or more than 50 samples in the batch. |
| `429` | The rate limiter rejected the client (120 requests / 60 s per Cloudflare edge client IP). |

Each accepted sample logs one line:

```json
{
  "type": "client_latency",
  "client": "mobile",
  "platform": "ios",
  "version": "1.0.12",
  "requestId": "http-call-id",
  "procedures": ["user.getMe"],
  "batchSize": 1,
  "ttfbMs": 12,
  "totalMs": 34,
  "status": 200,
  "ok": true
}
```

The line carries no `userId` and no bearer/session value.

## Local Development

From the repository root:

```bash
pnpm install
pnpm --filter cloudflare-latency-ingest dev
```

Wrangler serves the Worker at `http://localhost:8816`. The rate-limit binding works locally, so
the limits above apply in dev too. A local request carries no `cf-connecting-ip`, so every caller
there shares the one `client:unknown` bucket.

Smoke test:

```bash
curl -i -X POST http://localhost:8816/v1/latency \
  -H 'authorization: Bearer local-session' \
  -H 'x-kilo-app-version: 1.0.12' \
  -H 'x-kilo-app-platform: ios' \
  -H 'content-type: application/json' \
  -d '{"samples":[{"requestId":"r1","procedures":["user.getMe"],"ttfbMs":12,"totalMs":34,"status":200,"ok":true}]}'
```

```bash
curl http://localhost:8816/health
```

There are no secrets to configure; `.dev.vars.example` is documentation only.

## Deployment Configuration

- Custom domain route `latency.kiloapps.io` (zone `kiloapps.io`).
- Rate-limit binding `LATENCY_RATE_LIMITER` (namespace `1004`, 120 requests / 60 s per key).
  The key is the Cloudflare edge client IP (`cf-connecting-ip`), because the caller-supplied
  bearer is not verified and would let a caller rotate a fresh bucket per request.
- `MIN_APP_VERSION` var — bump it when a release must be retired.
- `observability.enabled` and `logpush: true` so the structured lines reach Axiom.

Tests and typecheck:

```bash
pnpm --filter cloudflare-latency-ingest test
pnpm --filter cloudflare-latency-ingest typecheck
```
