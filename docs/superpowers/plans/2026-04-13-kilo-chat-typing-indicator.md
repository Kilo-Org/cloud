# Kilo Chat Typing Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Do not commit this plan file** — repo policy forbids committing plan/spec markdown.

**Goal:** Add Telegram-style "typing…" indicator to the `kilo-chat` openclaw plugin so users see live activity during the silent gap between an inbound message and the first streamed token (and across streaming gaps within a turn).

**Architecture:** The OpenClaw plugin SDK already ships a typing primitive (`createTypingCallbacks` from `openclaw/plugin-sdk/channel-reply-pipeline`) that handles a 3s keepalive loop, a 60s safety TTL, and consecutive-failure backoff. Telegram wires it via `createChannelReplyPipeline({ typing: { start, onStartError } })` and dispatches via `dispatchReplyWithBufferedBlockDispatcher`. Today our `kilo-chat` webhook uses the higher-level `recordInboundSessionAndDispatchReply` helper, which does not expose a `typing` parameter. We will mirror Telegram exactly: drop that helper, inline its three steps (`recordInboundSession` → `createChannelReplyPipeline` → `dispatchReplyWithBufferedBlockDispatcher`), and supply `typing.start` that POSTs to a new controller-proxied endpoint backed by the external chat service. Stop semantics come from the SDK's `onIdle`/`onCleanup` (typing pings stop when the reply turn settles — same as Telegram).

**Tech Stack:** TypeScript, Vitest, Hono (controller), Node 22, the existing `openclaw` plugin SDK already in use.

---

## Wire contract (locked by this plan)

- **External chat service:** `POST {KILOCHAT_BASE_URL}/v1/conversations/:conversationId/typing` → `204 No Content`. Server holds the indicator for **5 seconds** then auto-clears (matches Telegram's `sendChatAction("typing")` TTL). Clients re-ping while still working.
- **Controller proxy:** `POST /_kilo/kilo-chat/typing` with body `{ "conversationId": "<id>" }`. Auth: `Bearer ${OPENCLAW_GATEWAY_TOKEN}`. Forwards to upstream with `Bearer ${KILOCHAT_API_TOKEN}` + `x-kilo-sandbox-id: ${KILOCLAW_SANDBOX_ID}`. Pass through upstream status + body.
- **Plugin client method:** `KiloChatClient.sendTyping({ conversationId }): Promise<void>`. Throws on non-2xx; the SDK's typing-start guard catches and counts failures (10 → suspend).
- **Frequency:** SDK default keepalive of 3s + 60s safety TTL — no overrides.

## File map

- **Modify** `services/kiloclaw/controller/src/routes/kilo-chat.ts` — add `registerKiloChatTypingRoute` mirroring `registerKiloChatSendRoute`.
- **Modify** `services/kiloclaw/controller/src/routes/kilo-chat.test.ts` — add typing-route tests mirroring send-route tests.
- **Modify** `services/kiloclaw/controller/src/index.ts` — register the typing route alongside send/edit/delete.
- **Modify** `services/kiloclaw/plugins/kilo-chat/src/client.ts` — add `sendTyping` method + types.
- **Modify** `services/kiloclaw/plugins/kilo-chat/src/client.test.ts` — add `sendTyping` tests.
- **Modify** `services/kiloclaw/plugins/kilo-chat/src/webhook.ts` — replace `recordInboundSessionAndDispatchReply` with inlined SDK calls + typing wiring.
- **Modify** `services/kiloclaw/plugins/kilo-chat/src/webhook.test.ts` — add tests proving typing fires on dispatch, stops on settle, errors are silent.
- **Modify** `services/kiloclaw/plugins/kilo-chat/README.md` — document the new endpoint contract.

No new files. All work fits inside the existing PR.

---

## Task 1: Controller proxy route — add typing endpoint

**Files:**
- Modify: `services/kiloclaw/controller/src/routes/kilo-chat.ts`
- Modify: `services/kiloclaw/controller/src/routes/kilo-chat.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `services/kiloclaw/controller/src/routes/kilo-chat.test.ts` (after the existing `describe('DELETE …')` block):

```ts
import { registerKiloChatTypingRoute } from './kilo-chat';

function makeTypingApp(fetchImpl: typeof fetch) {
  const app = new Hono();
  registerKiloChatTypingRoute(app, {
    expectedToken: TOKEN,
    sandboxId: SANDBOX_ID,
    apiToken: 'api_token',
    baseUrl: 'https://chat.example.test',
    fetchImpl,
  });
  return app;
}

describe('POST /_kilo/kilo-chat/typing', () => {
  it('rejects requests without bearer token', async () => {
    const app = makeTypingApp(async () => new Response(null, { status: 204 }));
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/typing', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'c1' }),
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(res.status).toBe(401);
  });

  it('rejects requests with wrong token', async () => {
    const app = makeTypingApp(async () => new Response(null, { status: 204 }));
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/typing', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'c1' }),
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer wrong',
        },
      })
    );
    expect(res.status).toBe(401);
  });

  it('forwards to upstream /v1/conversations/:id/typing with sandbox id and api token', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedInit = init;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const app = makeTypingApp(fetchImpl);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/typing', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'c1' }),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
      })
    );

    expect(res.status).toBe(204);
    expect(capturedUrl).toBe('https://chat.example.test/v1/conversations/c1/typing');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer api_token');
    expect(headers.get('x-kilo-sandbox-id')).toBe(SANDBOX_ID);
    expect(capturedInit?.method).toBe('POST');
  });

  it('url-encodes the conversation id', async () => {
    let capturedUrl = '';
    const fetchImpl = (async (url: string | URL) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const app = makeTypingApp(fetchImpl);
    await app.fetch(
      new Request('http://x/_kilo/kilo-chat/typing', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'a b/c' }),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
      })
    );
    expect(capturedUrl).toBe('https://chat.example.test/v1/conversations/a%20b%2Fc/typing');
  });

  it('rejects body missing conversationId with 400', async () => {
    const app = makeTypingApp(async () => new Response(null, { status: 204 }));
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/typing', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
      })
    );
    expect(res.status).toBe(400);
  });

  it('passes upstream non-2xx status through', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 502 })) as typeof fetch;
    const app = makeTypingApp(fetchImpl);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/typing', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'c1' }),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
      })
    );
    expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/kiloclaw && pnpm test -- controller/src/routes/kilo-chat.test.ts`
Expected: All `POST /_kilo/kilo-chat/typing` tests fail with `registerKiloChatTypingRoute is not a function` (or import error).

- [ ] **Step 3: Implement the route**

Append to `services/kiloclaw/controller/src/routes/kilo-chat.ts` (after `registerKiloChatDeleteRoute`):

```ts
const KILO_CHAT_TYPING_PATH = '/_kilo/kilo-chat/typing';

export function registerKiloChatTypingRoute(app: Hono, options: KiloChatRouteOptions): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  app.post(KILO_CHAT_TYPING_PATH, async c => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!token || !timingSafeTokenEqual(token, options.expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { conversationId?: unknown };
    try {
      body = (await c.req.json()) as { conversationId?: unknown };
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const conversationId = body.conversationId;
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      return c.json({ error: 'conversationId required' }, 400);
    }

    const upstream = await fetchImpl(
      `${options.baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/typing`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiToken}`,
          'x-kilo-sandbox-id': options.sandboxId,
        },
      }
    );

    const responseBody = await upstream.text();
    return new Response(responseBody || null, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/kiloclaw && pnpm test -- controller/src/routes/kilo-chat.test.ts`
Expected: All tests in the file pass (existing + new typing block).

- [ ] **Step 5: Wire the route into the controller bootstrap**

Modify `services/kiloclaw/controller/src/index.ts`:

Update the import block at lines 22–25:

```ts
import {
  registerKiloChatSendRoute,
  registerKiloChatEditRoute,
  registerKiloChatDeleteRoute,
  registerKiloChatTypingRoute,
} from './routes/kilo-chat';
```

Update the `if (env.KILOCHAT_API_TOKEN && env.KILOCHAT_BASE_URL)` block at lines 357–367 — add the typing registration after delete:

```ts
    registerKiloChatSendRoute(honoApp, kiloChatOpts);
    registerKiloChatEditRoute(honoApp, kiloChatOpts);
    registerKiloChatDeleteRoute(honoApp, kiloChatOpts);
    registerKiloChatTypingRoute(honoApp, kiloChatOpts);
```

- [ ] **Step 6: Re-run the controller test suite**

Run: `cd services/kiloclaw && pnpm test`
Expected: All tests pass (1266 + new tests).

- [ ] **Step 7: Format + commit**

```bash
cd /Users/igor/Projects/cloud
pnpm run format:changed
git add services/kiloclaw/controller/src/routes/kilo-chat.ts \
        services/kiloclaw/controller/src/routes/kilo-chat.test.ts \
        services/kiloclaw/controller/src/index.ts
git commit -m "feat(kiloclaw): controller typing proxy for kilo-chat"
```

---

## Task 2: Plugin client — add `sendTyping`

**Files:**
- Modify: `services/kiloclaw/plugins/kilo-chat/src/client.ts`
- Modify: `services/kiloclaw/plugins/kilo-chat/src/client.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `services/kiloclaw/plugins/kilo-chat/src/client.test.ts`:

```ts
describe('sendTyping', () => {
  it('POSTs to /_kilo/kilo-chat/typing with conversationId in body and gateway token', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'gwt',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.sendTyping({ conversationId: 'c1' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:18789/_kilo/kilo-chat/typing');
    const init2 = init as RequestInit;
    expect(init2.method).toBe('POST');
    const headers = new Headers(init2.headers);
    expect(headers.get('authorization')).toBe('Bearer gwt');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(init2.body as string)).toEqual({ conversationId: 'c1' });
  });

  it('throws on non-2xx so the SDK typing guard can count failures', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'gwt',
      fetchImpl,
    });
    await expect(client.sendTyping({ conversationId: 'c1' })).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/kiloclaw/plugins/kilo-chat && pnpm test -- src/client.test.ts`
Expected: `sendTyping` tests fail with `client.sendTyping is not a function`.

- [ ] **Step 3: Implement `sendTyping` on the client**

Modify `services/kiloclaw/plugins/kilo-chat/src/client.ts`. Add a type after `DeleteMessageParams`:

```ts
export type SendTypingParams = { conversationId: string };
```

Update the `KiloChatClient` type:

```ts
export type KiloChatClient = {
  createMessage(p: CreateMessageParams): Promise<CreateMessageResult>;
  editMessage(p: EditMessageParams): Promise<EditMessageResult>;
  deleteMessage(p: DeleteMessageParams): Promise<void>;
  sendTyping(p: SendTypingParams): Promise<void>;
};
```

Inside `createKiloChatClient`, after `deleteMessage`:

```ts
  async function sendTyping(params: SendTypingParams): Promise<void> {
    const response = await fetchImpl(`${base}/_kilo/kilo-chat/typing`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversationId: params.conversationId }),
    });
    if (!response.ok) {
      throw new Error(
        `kilo-chat: controller /typing responded ${response.status}: ${await response.text()}`
      );
    }
    void response.body?.cancel();
  }
```

Update the returned object:

```ts
  return {
    createMessage,
    editMessage,
    deleteMessage,
    sendTyping,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/kiloclaw/plugins/kilo-chat && pnpm test -- src/client.test.ts`
Expected: All client tests pass.

- [ ] **Step 5: Format + commit**

```bash
cd /Users/igor/Projects/cloud
pnpm run format:changed
git add services/kiloclaw/plugins/kilo-chat/src/client.ts \
        services/kiloclaw/plugins/kilo-chat/src/client.test.ts
git commit -m "feat(kiloclaw): kilo-chat client sendTyping"
```

---

## Task 3: Webhook — inline SDK pipeline + wire typing

This is the load-bearing change. We replace `recordInboundSessionAndDispatchReply` (which doesn't expose `typing`) with the three primitive calls Telegram uses.

**Files:**
- Modify: `services/kiloclaw/plugins/kilo-chat/src/webhook.ts`
- Modify: `services/kiloclaw/plugins/kilo-chat/src/webhook.test.ts`

- [ ] **Step 1: Read the existing webhook test to learn the test-harness shape**

Read: `services/kiloclaw/plugins/kilo-chat/src/webhook.test.ts` (full file). Note how it stubs `api`, calls `createKiloChatWebhookHandler`, and inspects calls to the client. The new tests follow the same pattern.

- [ ] **Step 2: Write the failing tests**

Append to `services/kiloclaw/plugins/kilo-chat/src/webhook.test.ts`. (Adapt the test-harness factory names to match what already exists in the file — re-use whatever factory the existing tests use to build the `api` stub.)

```ts
describe('typing wiring', () => {
  it('passes a typing.start callback that POSTs to /typing once dispatch begins', async () => {
    // Use the same `api` + `client` stubs the existing tests build. The test asserts:
    //   1. dispatchReplyWithBufferedBlockDispatcher was called with
    //      `dispatcherOptions.typingCallbacks` defined (the SDK pipeline added it).
    //   2. Invoking `dispatcherOptions.typingCallbacks.onReplyStart()` triggers
    //      one call to `client.sendTyping({ conversationId })`.
    //   3. Errors thrown by client.sendTyping do NOT throw out of dispatch
    //      (the SDK's start-guard catches them; we verify by calling
    //      onReplyStart() with a rejecting client and expecting no throw).
  });

  it('does not use recordInboundSessionAndDispatchReply (uses inlined pipeline)', async () => {
    // Verify by spying on recordInboundSession (called directly) and
    // dispatchReplyWithBufferedBlockDispatcher (called directly) — both should
    // be called exactly once per inbound, and the helper should not appear in
    // imports (compile-time check via grep is sufficient and lives in CI lint).
  });
});
```

Replace those two comment-blocks with concrete tests once you read the existing harness — e.g., if the existing tests pass `dispatchReplyWithBufferedBlockDispatcher` as a `vi.fn` on the stub `api.runtime.channel.reply`, assert against it directly:

```ts
it('passes a typing.start callback that POSTs to /typing', async () => {
  const dispatchSpy = vi.fn(async () => {});
  const sendTyping = vi.fn(async () => {});
  const api = makeApiStub({
    dispatchReplyWithBufferedBlockDispatcher: dispatchSpy,
  });
  // …override client factory or __pluginInternals so client.sendTyping = sendTyping…
  const handler = createKiloChatWebhookHandler({ api, getWebhookSecret: () => 'secret' });
  await invokeHandler(handler, validSignedPayload({ conversationId: 'c1' }));

  expect(dispatchSpy).toHaveBeenCalledTimes(1);
  const dispatcherOpts = dispatchSpy.mock.calls[0]![0].dispatcherOptions;
  expect(dispatcherOpts.typingCallbacks).toBeDefined();

  await dispatcherOpts.typingCallbacks.onReplyStart();
  expect(sendTyping).toHaveBeenCalledWith({ conversationId: 'c1' });
});

it('typing failures do not propagate out of onReplyStart', async () => {
  // Same setup; sendTyping rejects; onReplyStart() resolves without throwing
  // because the SDK's createTypingStartGuard catches.
  // …
});
```

If the existing test file does not already provide `makeApiStub` / `invokeHandler` helpers, write minimal local helpers in the test file. **Do not invent** SDK shapes — read `~/Projects/openclaw/src/plugin-sdk/inbound-reply-dispatch.ts` and `~/Projects/openclaw/src/auto-reply/reply/reply-dispatcher.ts` to confirm the exact shape of `dispatcherOptions.typingCallbacks`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd services/kiloclaw/plugins/kilo-chat && pnpm test -- src/webhook.test.ts`
Expected: New tests fail because `dispatcherOptions.typingCallbacks` is undefined (current code goes through `recordInboundSessionAndDispatchReply`, which does not pass typing).

- [ ] **Step 4: Refactor the webhook to inline the pipeline**

Modify `services/kiloclaw/plugins/kilo-chat/src/webhook.ts`.

Replace the imports block at the top (lines 4–6):

```ts
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from 'openclaw/plugin-sdk/inbound-envelope';
import { createChannelReplyPipeline } from 'openclaw/plugin-sdk/channel-reply-pipeline';
import { createNormalizedOutboundDeliverer } from 'openclaw/plugin-sdk/reply-payload';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
```

(Note: the existing import of `recordInboundSessionAndDispatchReply` from `openclaw/plugin-sdk/inbound-reply-dispatch` is removed entirely. Verify with `grep -n recordInboundSessionAndDispatchReply services/kiloclaw/plugins/kilo-chat/src/webhook.ts` — must return zero lines after this step.)

Replace the body of `dispatchInbound` (lines ~143–235). Keep the existing route-resolution + envelope-building + `ctxPayload` + `client` + `wiring` blocks (lines ~147–206) verbatim. Replace **only** the `try { await recordInboundSessionAndDispatchReply({ … }); … } catch { … }` block at the bottom with:

```ts
  try {
    await channelRuntime.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      onRecordError: err => console.error('[kilo-chat] recordInboundSession:', err),
    });

    const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
      cfg,
      agentId: route.agentId,
      channel: 'kilo-chat',
      accountId: '',
      typing: {
        start: () => client.sendTyping({ conversationId: payload.conversationId }),
        onStartError: err =>
          console.warn('[kilo-chat] typing start failed:', err),
      },
    });

    const deliver = createNormalizedOutboundDeliverer(wiring.deliver);

    await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        ...replyPipeline,
        deliver,
        onError: (err, info) =>
          console.error(`[kilo-chat] dispatchReply (${info.kind}):`, err),
      },
      replyOptions: {
        ...wiring.replyOptions,
        onModelSelected,
      },
    });
    await wiring.finalize();
  } catch (err) {
    try {
      await wiring.finalize(err);
    } catch {
      // best-effort cleanup; do not let finalize errors mask the original dispatch error
    }
    throw err;
  }
```

Three things to double-check while editing:
1. The `client` const created at line ~197 must stay in scope (the typing `start` closure references it).
2. `wiring.replyOptions` already supplies `onPartialReply`. We must spread it so `onModelSelected` overrides nothing else accidentally.
3. The `accountId: ''` matches the value passed elsewhere in the file (kilo-chat is single-account).

- [ ] **Step 5: Run plugin tests**

Run: `cd services/kiloclaw/plugins/kilo-chat && pnpm test`
Expected: All 43 existing tests + new typing tests pass (now 45+).

- [ ] **Step 6: Run full kiloclaw test suite to catch regressions**

Run: `cd services/kiloclaw && pnpm test`
Expected: 1266+ tests pass.

- [ ] **Step 7: Run typecheck + lint**

Run: `cd services/kiloclaw && pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 8: Format + commit**

```bash
cd /Users/igor/Projects/cloud
pnpm run format:changed
git add services/kiloclaw/plugins/kilo-chat/src/webhook.ts \
        services/kiloclaw/plugins/kilo-chat/src/webhook.test.ts
git commit -m "feat(kiloclaw): kilo-chat typing indicator via SDK pipeline"
```

---

## Task 4: Documentation

**Files:**
- Modify: `services/kiloclaw/plugins/kilo-chat/README.md`

- [ ] **Step 1: Document the new outbound action**

Read the existing README first to match its style. Add a fourth bullet under the outbound-actions list, alongside POST/PATCH/DELETE:

```markdown
- `POST   {KILOCHAT_BASE_URL}/v1/conversations/:conversationId/typing` — typing indicator. Server holds for ~5s, then auto-clears. Plugin re-pings every 3s while the agent reply turn is in progress (default openclaw SDK keepalive).
```

If there's a "controller proxy paths" section, also add `POST /_kilo/kilo-chat/typing` there.

- [ ] **Step 2: Format + commit**

```bash
cd /Users/igor/Projects/cloud
pnpm run format:changed
git add services/kiloclaw/plugins/kilo-chat/README.md
git commit -m "docs(kiloclaw): document kilo-chat typing endpoint"
```

---

## Task 5: Final verification

- [ ] **Step 1: Run the full validation suite**

Run from repo root:

```bash
cd /Users/igor/Projects/cloud
pnpm run format:changed
cd services/kiloclaw && pnpm typecheck && pnpm lint && pnpm test
cd plugins/kilo-chat && pnpm test
```

Expected: all green.

- [ ] **Step 2: Push and update the PR**

```bash
git push --no-verify
```

Per repo convention, the pre-push hook has unrelated failures; manual checks above replace it.

- [ ] **Step 3: Update PR description**

Edit PR #2361 description: append a section under "Outbound" listing the new `/v1/conversations/:id/typing` action and removing the typing item from "Known gaps" if it was listed.

---

## Self-review notes

**Spec coverage:**
- Wire shape A → Task 1 (controller route) + Task 2 (client method)
- Telegram-equivalent start trigger → Task 3 (`createChannelReplyPipeline({ typing })`)
- Inter-block re-fire → Task 3 (free from SDK; no extra code)
- Silent failures → Task 3 `onStartError: console.warn` + Task 2 client throws so SDK guard counts
- TTL = 5s server-side → Task 4 README contract
- Concurrency-acceptable → no per-conversation locking added; matches stated assumption

**Type consistency:**
- `KiloChatClient.sendTyping` signature `(p: SendTypingParams) => Promise<void>` is consistent across client.ts, client.test.ts, and the closure in webhook.ts.
- `KILOCHAT_BASE_URL`, `KILOCLAW_SANDBOX_ID`, and `OPENCLAW_GATEWAY_TOKEN` env names match existing usages elsewhere in the file.

**Open verification items the executing engineer must confirm before writing tests in Task 3, Step 2:**
- Read `services/kiloclaw/plugins/kilo-chat/src/webhook.test.ts` to learn the existing harness shape (helper names, how `api` is stubbed). Adapt the new test snippets to match.
- Read `~/Projects/openclaw/src/auto-reply/reply/reply-dispatcher.ts` lines 220–230 to confirm `dispatcherOptions.typingCallbacks` is the exact field name on the dispatcher options shape.
