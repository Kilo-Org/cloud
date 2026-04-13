# Kilo Chat — local e2e testing

How to exercise the full kilo-chat pipeline on your laptop, no Fly/CF required.
Covers the outbound path (plugin → controller → external service), the inbound
HMAC webhook, and Telegram-style partial streaming with PATCH coalescing.

## Architecture

```
   ┌──────────────────────┐            ┌────────────────────────────┐
   │ fake upstream :9999  │◀──────────▶│ kiloclaw container :18789  │
   │  /v1/messages        │  HTTP/S    │                            │
   │  POST/PATCH/DELETE   │            │  controller → supervisor   │
   │                      │            │  openclaw gateway :3001    │
   │  HMAC-signed inbound │            │  /plugins/kilo-chat/webhook│
   │  webhook to plugin   │◀──────────▶│                            │
   └──────────────────────┘            └────────────────────────────┘
```

Plugin outbound hits `/_kilo/kilo-chat/send` (and `/messages/:id`) on the
controller, which auth-proxies to `${KILOCHAT_BASE_URL}/v1/messages`. Inbound
webhooks land on `/plugins/kilo-chat/webhook`, HMAC-verified against
`KILOCHAT_WEBHOOK_SECRET`, then dispatched to the agent.

## Prereqs

- Docker with `host.docker.internal` support (Docker Desktop on macOS/Windows;
  on Linux add `--add-host=host.docker.internal:host-gateway`)
- Node 20+ for the fake upstream
- A working `KILOCODE_API_KEY` (the onboard path wires it into
  `/root/.openclaw/agents/main/agent/auth-profiles.json` as `kilocode:default`)

## 1. Build the image

From the repo root:

```bash
cd services/kiloclaw
docker build -t kiloclaw:local .
```

First build is slow; subsequent builds hit the cache and finish in seconds.

## 2. Start the fake upstream (Terminal 2)

Save this as `/tmp/fake-kilo-chat-upstream.mjs`:

```js
import { createServer } from 'node:http';

const EXPECTED_BEARER = process.env.KILOCHAT_API_TOKEN ?? 'upstream-token';
const msgs = new Map();
let counter = 0;

const readBody = req =>
  new Promise((res, rej) => {
    const bufs = [];
    req.on('data', c => bufs.push(c));
    req.on('end', () => res(Buffer.concat(bufs).toString('utf8')));
    req.on('error', rej);
  });

const j = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const auth = req.headers['authorization'];
  const sandbox = req.headers['x-kilo-sandbox-id'];
  const body = await readBody(req);
  console.log(`[upstream] ${req.method} ${url.pathname} sandbox=${sandbox} auth=${auth} body=${body}`);

  if (auth !== `Bearer ${EXPECTED_BEARER}`) return j(res, 401, { error: 'bad token' });

  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    const { text } = JSON.parse(body || '{}');
    const id = `m${++counter}`;
    msgs.set(id, { text, version: 1 });
    return j(res, 200, { messageId: id, version: 1 });
  }

  const m = url.pathname.match(/^\/v1\/messages\/(.+)$/);
  if (m) {
    const id = m[1];
    const current = msgs.get(id);
    if (!current) return j(res, 404, { error: 'not found' });
    if (req.method === 'PATCH') {
      const { text, version } = JSON.parse(body || '{}');
      if (version <= current.version) return j(res, 409, { error: 'stale' });
      current.text = text;
      current.version = version;
      return j(res, 200, { messageId: id, version });
    }
    if (req.method === 'DELETE') {
      msgs.delete(id);
      return j(res, 204, {});
    }
  }

  j(res, 404, { error: 'not found' });
}).listen(9999, () => console.log('[upstream] listening on :9999'));
```

Run it in a second terminal and leave it running:

```bash
KILOCHAT_API_TOKEN=upstream-token node /tmp/fake-kilo-chat-upstream.mjs
```

## 3. Start the container (Terminal 1)

```bash
ROOTDIR=/tmp/kiloclaw-root-test
rm -rf "$ROOTDIR"
mkdir -p "$ROOTDIR"    # let onboard create .openclaw/

docker run -d --rm --name kiloclaw-test \
  -p 18789:18789 \
  -e OPENCLAW_GATEWAY_TOKEN=test-gwt \
  -e KILOCODE_API_KEY='<your-kilocode-api-key>' \
  -e KILOCLAW_FRESH_INSTALL=true \
  -e KILOCODE_DEFAULT_MODEL='kilocode/kilo-auto/free' \
  -e REQUIRE_PROXY_TOKEN=false \
  -e KILOCHAT_API_TOKEN=upstream-token \
  -e KILOCHAT_WEBHOOK_SECRET=webhook-secret-xyz \
  -e KILOCHAT_BASE_URL=http://host.docker.internal:9999 \
  -v "$ROOTDIR:/root" \
  kiloclaw:local
```

Required env, summarised:

| var | purpose |
|---|---|
| `OPENCLAW_GATEWAY_TOKEN` | auth for controller `/_kilo/*` routes |
| `KILOCODE_API_KEY` | onboarded into kilocode auth profile; model calls use it |
| `KILOCLAW_FRESH_INSTALL=true` | forces onboard even if `/root` is non-empty |
| `KILOCODE_DEFAULT_MODEL` | default model; `kilocode/kilo-auto/free` is free-tier |
| `REQUIRE_PROXY_TOKEN=false` | skip `x-kiloclaw-proxy-token` on the catch-all proxy so webhook curls don't need it |
| `KILOCHAT_API_TOKEN` | controller → upstream Bearer |
| `KILOCHAT_WEBHOOK_SECRET` | HMAC-SHA256 key for inbound webhooks |
| `KILOCHAT_BASE_URL` | upstream for the controller's PATCH/POST/DELETE routes |

Controller comes up in ~3s; the openclaw gateway inside the container can take
another ~5–10s to finish plugin load. Poll until the webhook route is live (any
non-`502`/`404` response means the plugin registered):

```bash
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:18789/plugins/kilo-chat/webhook \
    -H 'content-type: application/json' -d '{}')
  if [ "$code" != "502" ] && [ "$code" != "404" ]; then
    echo "ready ($code)"
    break
  fi
  sleep 1
done
```

401 is the expected response to an unsigned webhook — it means the route is up.

## 4. Exercise the pipeline

### Outbound direct (controller → upstream, no agent)

```bash
curl -X POST http://localhost:18789/_kilo/kilo-chat/send \
  -H 'authorization: Bearer test-gwt' -H 'content-type: application/json' \
  -d '{"conversationId":"sanity","text":"hi"}'
# → {"messageId":"m1","version":1}, upstream logs the POST
```

### Inbound — short reply (POST-only path)

```bash
SECRET=webhook-secret-xyz
PAYLOAD='{"conversationId":"short","from":"alice","text":"Reply with just: ok","messageId":"x1","sentAt":"2026-04-13T12:00:00Z"}'
SIG=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')
curl -X POST http://localhost:18789/plugins/kilo-chat/webhook \
  -H 'content-type: application/json' \
  -H "x-kilo-chat-signature: sha256=$SIG" \
  --data "$PAYLOAD"
```

Upstream should log one `POST /v1/messages` with the agent's reply. No PATCH —
the reply was short enough to land in a single `deliver` call.

### Inbound — streaming (POST + PATCH path)

Ask for enough output that the model streams multiple partials:

```bash
PAYLOAD='{"conversationId":"stream","from":"alice","text":"Name the 8 planets in order with a short note each.","messageId":"x2","sentAt":"2026-04-13T12:00:00Z"}'
SIG=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')
curl -X POST http://localhost:18789/plugins/kilo-chat/webhook \
  -H 'content-type: application/json' \
  -H "x-kilo-chat-signature: sha256=$SIG" \
  --data "$PAYLOAD"
```

Upstream should log:

1. `POST /v1/messages` with a partial (mid-stream text) → creates `mN`
2. One or more `PATCH /v1/messages/mN` with `version` monotonically increasing
   and the full/updated text

That's the live-edit flow driven by `onPartialReply` in
[`src/webhook.ts`](./src/webhook.ts) and the coalescing state machine in
[`src/preview-stream.ts`](./src/preview-stream.ts).

### Bad HMAC (smoke test for auth)

```bash
curl -i -X POST http://localhost:18789/plugins/kilo-chat/webhook \
  -H 'content-type: application/json' \
  -H 'x-kilo-chat-signature: sha256=deadbeef' \
  --data '{}'
# → 401 {"error":"Invalid signature"}, nothing reaches upstream
```

## 5. Teardown

```bash
docker stop kiloclaw-test      # removes container (--rm)
# Ctrl-C the fake upstream in Terminal 2
rm -rf /tmp/kiloclaw-root-test /tmp/fake-kilo-chat-upstream.mjs
```

## Troubleshooting

- **Webhook returns 404**: the plugin's `registerFull(api)` didn't run. The most
  common cause is the channel config being empty-or-only-`enabled` — OpenClaw's
  `hasMeaningfulChannelConfig` requires at least one non-`enabled` key on
  `channels['kilo-chat']`. `config-writer.ts` handles this by seeding `baseUrl`.
- **Agent errors `"No API key found for provider openai"`**: onboard didn't run
  or kilocode auth didn't wire. Delete `$ROOTDIR` and restart the container with
  `KILOCLAW_FRESH_INSTALL=true`.
- **Model rejects `kilo/auto`**: use `KILOCODE_DEFAULT_MODEL=kilocode/kilo-auto/free`
  (or any other valid id from `/root/.openclaw/agents/main/agent/models.json`).
- **`502 Bad Gateway` on webhook**: controller is up but the gateway subprocess
  hasn't finished starting yet. Wait another ~10s.
- **Upstream gets `POST` but no `PATCH`**: the model didn't stream multiple
  partials — either the response was too short, or the provider returned the
  whole thing in one chunk. Try a longer prompt.
