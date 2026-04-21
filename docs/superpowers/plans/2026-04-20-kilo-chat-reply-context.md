# Kilo-Chat Reply Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread reply context bidirectionally so the agent sees what message a user is quoting and the agent's responses thread back to the triggering message.

**Architecture:** The inbound path resolves the parent message text+sender in the kilo-chat backend and pipes it through the webhook chain to the OpenClaw plugin, which sets `ReplyToId`/`ReplyToBody`/`ReplyToSender` on the inbound context. The outbound path passes OpenClaw's `replyToId` through the plugin client as `inReplyToMessageId` on create-message calls. The controller proxy is a transparent relay — no changes needed there.

**Tech Stack:** TypeScript, Vitest, Cloudflare Durable Objects (kilo-chat backend), OpenClaw plugin SDK

**Spec:** `docs/superpowers/specs/2026-04-20-kilo-chat-reply-context-design.md`

---

## File Structure

| File | Responsibility | Change |
|------|---------------|--------|
| `services/kilo-chat/src/do/conversation-do.ts` | Durable Object for conversation state | Add `getMessage()` RPC |
| `services/kilo-chat/src/webhook/deliver.ts` | Webhook payload types + delivery | Add reply fields to types, pass through in `buildPayload` |
| `services/kilo-chat/src/services/messages.ts` | Message creation orchestration | Resolve parent message, include reply context in webhook |
| `services/kiloclaw/src/types.ts` | Kiloclaw shared types | Add reply fields to `ChatWebhookPayload` |
| `services/kiloclaw/plugins/kilo-chat/src/client.ts` | Plugin HTTP client | Add `inReplyToMessageId` to create params + request body |
| `services/kiloclaw/plugins/kilo-chat/src/channel.ts` | Plugin channel definition | Pass `replyToId` from `sendText` params |
| `services/kiloclaw/plugins/kilo-chat/src/preview-stream.ts` | Streaming preview controller | Accept + forward `inReplyToMessageId` on first POST |
| `services/kiloclaw/plugins/kilo-chat/src/webhook.ts` | Inbound webhook handler + delivery wiring | Parse reply fields, set on context, pass messageId to preview stream |

---

### Task 1: Add `getMessage` RPC to ConversationDO

**Files:**
- Modify: `services/kilo-chat/src/do/conversation-do.ts`
- Test: `services/kilo-chat/src/__tests__/conversation-do.test.ts`

- [ ] **Step 1: Write failing tests for `getMessage`**

Add these tests to the existing `describe('ConversationDO')` block in `services/kilo-chat/src/__tests__/conversation-do.test.ts`:

```typescript
it('getMessage - returns message data for existing message', async () => {
  const stub = getStub('conv-getmsg-1');
  await stub.initialize(BASE_PARAMS);
  const createResult = await stub.createMessage({
    senderId: 'user-alice',
    content: [{ type: 'text', text: 'Hello!' }],
  });
  expect(createResult.ok).toBe(true);
  if (!createResult.ok) return;

  const msg = await stub.getMessage(createResult.messageId);
  expect(msg).not.toBeNull();
  expect(msg!.id).toBe(createResult.messageId);
  expect(msg!.senderId).toBe('user-alice');
  expect(msg!.content).toEqual([{ type: 'text', text: 'Hello!' }]);
  expect(msg!.deleted).toBe(false);
});

it('getMessage - returns null for non-existent message', async () => {
  const stub = getStub('conv-getmsg-2');
  await stub.initialize(BASE_PARAMS);
  const msg = await stub.getMessage('NONEXISTENT00000000000000');
  expect(msg).toBeNull();
});

it('getMessage - returns deleted=true for soft-deleted message', async () => {
  const stub = getStub('conv-getmsg-3');
  await stub.initialize(BASE_PARAMS);
  const createResult = await stub.createMessage({
    senderId: 'user-alice',
    content: [{ type: 'text', text: 'Delete me' }],
  });
  expect(createResult.ok).toBe(true);
  if (!createResult.ok) return;

  await stub.deleteMessage({ messageId: createResult.messageId, senderId: 'user-alice' });
  const msg = await stub.getMessage(createResult.messageId);
  expect(msg).not.toBeNull();
  expect(msg!.deleted).toBe(true);
  expect(msg!.content).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/kilo-chat && pnpm test -- src/__tests__/conversation-do.test.ts`
Expected: FAIL — `stub.getMessage is not a function`

- [ ] **Step 3: Implement `getMessage` in ConversationDO**

Add this return type after the existing `MessageRow` type in `services/kilo-chat/src/do/conversation-do.ts`:

```typescript
export type GetMessageResult = {
  id: string;
  senderId: string;
  content: MessageContentBlock[];
  deleted: boolean;
} | null;
```

Add this method to the `ConversationDO` class:

```typescript
getMessage(messageId: string): GetMessageResult {
  const row = this.db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!row) return null;
  return {
    id: row.id,
    senderId: row.sender_id,
    content: row.deleted === 1 ? [] : (JSON.parse(row.content) as MessageContentBlock[]),
    deleted: row.deleted === 1,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/kilo-chat && pnpm test -- src/__tests__/conversation-do.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```
feat(kilo-chat): add getMessage RPC to ConversationDO

Needed to resolve reply context (parent message text + sender) during
webhook delivery without listing all messages.
```

---

### Task 2: Add reply fields to webhook delivery types

**Files:**
- Modify: `services/kilo-chat/src/webhook/deliver.ts`
- Test: `services/kilo-chat/src/__tests__/webhook-deliver.test.ts`

- [ ] **Step 1: Write failing test for `buildPayload` with reply fields**

The `buildPayload` function is not exported, but it's tested through `deliverToBot`. Add this test to the existing `describe('deliverToBot')` block in `services/kilo-chat/src/__tests__/webhook-deliver.test.ts`:

```typescript
it('includes reply context fields in payload when present', async () => {
  const deliverChatWebhook = vi.fn().mockResolvedValue(undefined);
  const env = { KILOCLAW: { deliverChatWebhook } } as unknown as Env;
  const convStub = { notifyDeliveryFailed: vi.fn() };

  await deliverToBot(
    env,
    convStub,
    makeMsg({
      inReplyToMessageId: 'parent-msg-1',
      inReplyToBody: 'Original text',
      inReplyToSender: 'user-bob',
    })
  );

  expect(deliverChatWebhook).toHaveBeenCalledWith(
    expect.objectContaining({
      inReplyToMessageId: 'parent-msg-1',
      inReplyToBody: 'Original text',
      inReplyToSender: 'user-bob',
    })
  );
});

it('omits reply context fields from payload when not present', async () => {
  const deliverChatWebhook = vi.fn().mockResolvedValue(undefined);
  const env = { KILOCLAW: { deliverChatWebhook } } as unknown as Env;
  const convStub = { notifyDeliveryFailed: vi.fn() };

  await deliverToBot(env, convStub, makeMsg());

  const payload = deliverChatWebhook.mock.calls[0]![0];
  expect(payload.inReplyToMessageId).toBeUndefined();
  expect(payload.inReplyToBody).toBeUndefined();
  expect(payload.inReplyToSender).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/kilo-chat && pnpm test -- src/__tests__/webhook-deliver.test.ts`
Expected: FAIL — the reply fields are not in the payload

- [ ] **Step 3: Add reply fields to types and `buildPayload`**

In `services/kilo-chat/src/webhook/deliver.ts`, update `WebhookMessage`:

```typescript
export type WebhookMessage = {
  targetBotId: string;
  conversationId: string;
  messageId: string;
  from: string;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  sentAt: string;
  inReplyToMessageId?: string;
  inReplyToBody?: string;
  inReplyToSender?: string;
};
```

Update `WebhookPayload`:

```typescript
type WebhookPayload = {
  conversationId: string;
  messageId: string;
  from: string;
  text: string;
  sentAt: string;
  inReplyToMessageId?: string;
  inReplyToBody?: string;
  inReplyToSender?: string;
};
```

Update `buildPayload` to pass through the reply fields:

```typescript
function buildPayload(msg: WebhookMessage): WebhookPayload {
  const text = msg.content
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('');
  return {
    conversationId: msg.conversationId,
    messageId: msg.messageId,
    from: msg.from,
    text,
    sentAt: msg.sentAt,
    ...(msg.inReplyToMessageId !== undefined && { inReplyToMessageId: msg.inReplyToMessageId }),
    ...(msg.inReplyToBody !== undefined && { inReplyToBody: msg.inReplyToBody }),
    ...(msg.inReplyToSender !== undefined && { inReplyToSender: msg.inReplyToSender }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/kilo-chat && pnpm test -- src/__tests__/webhook-deliver.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```
feat(kilo-chat): add reply context fields to webhook delivery types
```

---

### Task 3: Resolve parent message in `createMessageFor`

**Files:**
- Modify: `services/kilo-chat/src/services/messages.ts`
- Test: `services/kilo-chat/src/__tests__/messages-routes.test.ts`

- [ ] **Step 1: Write failing test for reply context in webhook delivery**

Read `services/kilo-chat/src/__tests__/messages-routes.test.ts` first to understand the existing test setup (env fixtures, conversation creation patterns, how `KILOCLAW.deliverChatWebhook` is mocked). Then add a test to the appropriate describe block that:

1. Creates a conversation with a user + bot member
2. Creates a first message from the user (this will be the parent)
3. Creates a second message from the user with `inReplyToMessageId` pointing to the first message
4. Asserts that `deliverChatWebhook` was called with a payload containing `inReplyToMessageId`, `inReplyToBody` matching the first message's text, and `inReplyToSender` matching the first message's sender

The exact test structure depends on how the existing test file sets up its mocks and fixtures — read it before writing the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/kilo-chat && pnpm test -- src/__tests__/messages-routes.test.ts`
Expected: FAIL — the webhook payload doesn't include reply context

- [ ] **Step 3: Implement parent message resolution in `createMessageFor`**

In `services/kilo-chat/src/services/messages.ts`, modify the webhook delivery block inside `createMessageFor`. After the existing `const now = new Date().toISOString();` line, add parent message resolution:

```typescript
// Resolve reply context for webhook delivery
let inReplyToBody: string | undefined;
let inReplyToSender: string | undefined;
if (inReplyToMessageId) {
  const parent = await convStub.getMessage(inReplyToMessageId);
  if (parent && !parent.deleted) {
    inReplyToBody = parent.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('');
    inReplyToSender = parent.senderId;
  }
}
```

Then update the `deliverToBot` call to include the reply fields:

```typescript
deliverToBot(env, convStub, {
  targetBotId: bot.id,
  conversationId,
  messageId,
  from: callerId,
  content,
  sentAt: now,
  ...(inReplyToMessageId !== undefined && { inReplyToMessageId }),
  ...(inReplyToBody !== undefined && { inReplyToBody }),
  ...(inReplyToSender !== undefined && { inReplyToSender }),
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/kilo-chat && pnpm test -- src/__tests__/messages-routes.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run full kilo-chat test suite**

Run: `cd services/kilo-chat && pnpm test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```
feat(kilo-chat): resolve parent message for reply context in webhook delivery
```

---

### Task 4: Add reply fields to kiloclaw `ChatWebhookPayload`

**Files:**
- Modify: `services/kiloclaw/src/types.ts`

- [ ] **Step 1: Update `ChatWebhookPayload` type**

In `services/kiloclaw/src/types.ts`, add the three optional fields to `ChatWebhookPayload`:

```typescript
export type ChatWebhookPayload = {
  targetBotId: string;
  conversationId: string;
  messageId: string;
  from: string;
  text: string;
  sentAt: string;
  inReplyToMessageId?: string;
  inReplyToBody?: string;
  inReplyToSender?: string;
};
```

No test changes needed — this is a type-only change. The kiloclaw `deliverChatWebhook` method strips `targetBotId` and JSON-forwards the rest verbatim, so the new fields pass through automatically.

- [ ] **Step 2: Typecheck kiloclaw**

Run: `cd services/kiloclaw && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```
feat(kiloclaw): add reply context fields to ChatWebhookPayload
```

---

### Task 5: Add `inReplyToMessageId` to plugin client

**Files:**
- Modify: `services/kiloclaw/plugins/kilo-chat/src/client.ts`
- Test: `services/kiloclaw/plugins/kilo-chat/src/client.test.ts`

- [ ] **Step 1: Write failing test for `createMessage` with `inReplyToMessageId`**

Add this test to the existing describe block in `services/kiloclaw/plugins/kilo-chat/src/client.test.ts`:

```typescript
it('createMessage includes inReplyToMessageId in request body when provided', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify({ messageId: 'm1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  );
  const client = createKiloChatClient({
    controllerBaseUrl: 'http://127.0.0.1:18789',
    gatewayToken: 'gwt',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  await client.createMessage({
    conversationId: 'c1',
    content: [{ type: 'text', text: 'reply' }],
    inReplyToMessageId: 'parent-msg-1',
  });

  const [, init] = fetchImpl.mock.calls[0]!;
  const body = JSON.parse((init as RequestInit).body as string);
  expect(body.inReplyToMessageId).toBe('parent-msg-1');
});

it('createMessage omits inReplyToMessageId from request body when not provided', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify({ messageId: 'm1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  );
  const client = createKiloChatClient({
    controllerBaseUrl: 'http://127.0.0.1:18789',
    gatewayToken: 'gwt',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  await client.createMessage({
    conversationId: 'c1',
    content: [{ type: 'text', text: 'no reply' }],
  });

  const [, init] = fetchImpl.mock.calls[0]!;
  const body = JSON.parse((init as RequestInit).body as string);
  expect(body.inReplyToMessageId).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/kiloclaw/plugins/kilo-chat && npx vitest run src/client.test.ts`
Expected: FAIL — `inReplyToMessageId` not in request body

- [ ] **Step 3: Implement the change**

In `services/kiloclaw/plugins/kilo-chat/src/client.ts`, update `CreateMessageParams`:

```typescript
export type CreateMessageParams = {
  conversationId: string;
  content: ContentBlock[];
  inReplyToMessageId?: string;
};
```

Update the `createMessage` function body to include `inReplyToMessageId`:

```typescript
async function createMessage(params: CreateMessageParams): Promise<CreateMessageResult> {
  const response = await fetchImpl(`${base}/_kilo/kilo-chat/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      conversationId: params.conversationId,
      content: params.content,
      ...(params.inReplyToMessageId !== undefined && {
        inReplyToMessageId: params.inReplyToMessageId,
      }),
    }),
  });
  if (!response.ok) {
    throw new Error(
      `kilo-chat: controller /send responded ${response.status}: ${await response.text()}`
    );
  }
  return parseCreateResult(await response.json());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/kiloclaw/plugins/kilo-chat && npx vitest run src/client.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```
feat(kilo-chat-plugin): add inReplyToMessageId to client createMessage
```

---

### Task 6: Wire `replyToId` through plugin outbound + preview stream

**Files:**
- Modify: `services/kiloclaw/plugins/kilo-chat/src/channel.ts`
- Modify: `services/kiloclaw/plugins/kilo-chat/src/preview-stream.ts`
- Test: `services/kiloclaw/plugins/kilo-chat/src/channel.test.ts`
- Test: `services/kiloclaw/plugins/kilo-chat/src/preview-stream.test.ts`

- [ ] **Step 1: Write failing test for `sendText` passing `replyToId`**

Add this test to the `describe('kilo-chat outbound.sendText')` block in `services/kiloclaw/plugins/kilo-chat/src/channel.test.ts`:

```typescript
it('passes replyToId as inReplyToMessageId to createMessage', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify({ messageId: 'm42' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  ) as unknown as typeof fetch;

  const originalEnv = { ...process.env };
  process.env.OPENCLAW_GATEWAY_TOKEN = 'gwt';
  process.env.KILOCLAW_CONTROLLER_URL = 'http://127.0.0.1:18789';
  __pluginInternals.fetchImpl = fetchImpl;
  try {
    await kiloChatPlugin.outbound!.sendText!({
      cfg: {} as never,
      to: 'conv-1',
      text: 'reply text',
      replyToId: 'parent-msg-1',
    } as never);

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.inReplyToMessageId).toBe('parent-msg-1');
  } finally {
    __pluginInternals.fetchImpl = undefined;
    process.env = originalEnv;
  }
});
```

- [ ] **Step 2: Write failing test for preview stream with `inReplyToMessageId`**

Add these tests to the `describe('createPreviewStream')` block in `services/kiloclaw/plugins/kilo-chat/src/preview-stream.test.ts`:

```typescript
it('first POST includes inReplyToMessageId when provided', async () => {
  const { client, createMessage } = makeClientSpies();
  const stream = createPreviewStream({
    client,
    conversationId: 'c1',
    throttleMs: 100,
    inReplyToMessageId: 'parent-msg-1',
  });
  await stream.finalize('Hello');
  expect(createMessage).toHaveBeenCalledWith({
    conversationId: 'c1',
    content: [{ type: 'text', text: 'Hello' }],
    inReplyToMessageId: 'parent-msg-1',
  });
});

it('first update POST includes inReplyToMessageId, subsequent PATCHes do not', async () => {
  vi.useFakeTimers();
  try {
    const { client, createMessage, editMessage } = makeClientSpies();
    const stream = createPreviewStream({
      client,
      conversationId: 'c1',
      throttleMs: 100,
      inReplyToMessageId: 'parent-msg-1',
    });
    stream.update('H');
    await vi.advanceTimersByTimeAsync(0);
    expect(createMessage).toHaveBeenCalledWith({
      conversationId: 'c1',
      content: [{ type: 'text', text: 'H' }],
      inReplyToMessageId: 'parent-msg-1',
    });

    stream.update('Hello');
    await vi.advanceTimersByTimeAsync(100);
    // PATCH should NOT include inReplyToMessageId
    expect(editMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({ inReplyToMessageId: expect.anything() })
    );
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd services/kiloclaw/plugins/kilo-chat && npx vitest run src/channel.test.ts src/preview-stream.test.ts`
Expected: FAIL

- [ ] **Step 4: Update `preview-stream.ts`**

In `services/kiloclaw/plugins/kilo-chat/src/preview-stream.ts`, add `inReplyToMessageId` to the options type:

```typescript
export type CreatePreviewStreamOptions = {
  client: KiloChatClient;
  conversationId: string;
  throttleMs: number;
  inReplyToMessageId?: string;
  onWarn?: (message: string, err?: unknown) => void;
};
```

Update the two `createMessage` calls inside `createPreviewStream` to include `inReplyToMessageId`:

In `flushOnce` (the first-send POST path):

```typescript
const p = opts.client
  .createMessage({
    conversationId: opts.conversationId,
    content: [{ type: 'text', text }],
    inReplyToMessageId: opts.inReplyToMessageId,
  })
```

In `finalize` (the fallback path when finalize is called with no prior update):

```typescript
const res = await opts.client.createMessage({
  conversationId: opts.conversationId,
  content: [{ type: 'text', text: finalText }],
  inReplyToMessageId: opts.inReplyToMessageId,
});
```

- [ ] **Step 5: Update `channel.ts` to pass `replyToId`**

In `services/kiloclaw/plugins/kilo-chat/src/channel.ts`, update the `sendText` function in the `outbound.attachedResults` block:

```typescript
attachedResults: {
  channel: CHANNEL_ID,
  sendText: async params => {
    const client = makeClient();
    const { messageId } = await client.createMessage({
      conversationId: params.to,
      content: [{ type: 'text', text: params.text }],
      inReplyToMessageId: params.replyToId ?? undefined,
    });
    return { messageId };
  },
},
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd services/kiloclaw/plugins/kilo-chat && npx vitest run src/channel.test.ts src/preview-stream.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```
feat(kilo-chat-plugin): wire replyToId through outbound sendText and preview stream
```

---

### Task 7: Parse reply context in plugin webhook and thread bot replies

**Files:**
- Modify: `services/kiloclaw/plugins/kilo-chat/src/webhook.ts`
- Test: `services/kiloclaw/plugins/kilo-chat/src/webhook.test.ts`

- [ ] **Step 1: Write failing tests for `parseInboundPayload` with reply fields**

Add these tests to the existing `describe('parseInboundPayload')` block in `services/kiloclaw/plugins/kilo-chat/src/webhook.test.ts`:

```typescript
it('parses reply context fields when present', () => {
  const parsed = parseInboundPayload({
    conversationId: 'c1',
    from: 'u1',
    text: 'my reply',
    messageId: 'm2',
    sentAt: '2026-01-01T00:00:00Z',
    inReplyToMessageId: 'm1',
    inReplyToBody: 'original text',
    inReplyToSender: 'u2',
  });
  expect(parsed).not.toBeNull();
  expect(parsed!.inReplyToMessageId).toBe('m1');
  expect(parsed!.inReplyToBody).toBe('original text');
  expect(parsed!.inReplyToSender).toBe('u2');
});

it('parses successfully when reply context fields are absent', () => {
  const parsed = parseInboundPayload({
    conversationId: 'c1',
    from: 'u1',
    text: 'hi',
    messageId: 'm1',
    sentAt: '2026-01-01T00:00:00Z',
  });
  expect(parsed).not.toBeNull();
  expect(parsed!.inReplyToMessageId).toBeUndefined();
  expect(parsed!.inReplyToBody).toBeUndefined();
  expect(parsed!.inReplyToSender).toBeUndefined();
});
```

- [ ] **Step 2: Write failing test for `buildDeliverWiring` accepting `inReplyToMessageId`**

Add this test to the existing `describe('buildDeliverWiring')` block:

```typescript
it('passes inReplyToMessageId to preview stream on first create', async () => {
  vi.useFakeTimers();
  try {
    const calls: { type: string; args: unknown }[] = [];
    const wiring = buildDeliverWiring({
      client: fakeClient(calls),
      conversationId: 'c1',
      inReplyToMessageId: 'parent-msg-1',
      warn: () => {},
    });
    await wiring.replyOptions.onPartialReply({ text: 'H' });
    await vi.advanceTimersByTimeAsync(0);

    const creates = calls.filter(c => c.type === 'create');
    expect(creates).toHaveLength(1);
    expect((creates[0]!.args as { inReplyToMessageId?: string }).inReplyToMessageId).toBe(
      'parent-msg-1'
    );
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd services/kiloclaw/plugins/kilo-chat && npx vitest run src/webhook.test.ts`
Expected: FAIL

- [ ] **Step 4: Update `KiloChatInboundPayload` and `parseInboundPayload`**

In `services/kiloclaw/plugins/kilo-chat/src/webhook.ts`, update the type:

```typescript
export type KiloChatInboundPayload = {
  conversationId: string;
  from: string;
  text: string;
  messageId: string;
  sentAt: string;
  inReplyToMessageId?: string;
  inReplyToBody?: string;
  inReplyToSender?: string;
};
```

Update `parseInboundPayload` to extract the optional reply fields. Add these lines before the `return` statement:

```typescript
const inReplyToMessageId =
  typeof o.inReplyToMessageId === 'string' && o.inReplyToMessageId.length > 0
    ? o.inReplyToMessageId
    : undefined;
const inReplyToBody =
  typeof o.inReplyToBody === 'string' && o.inReplyToBody.length > 0
    ? o.inReplyToBody
    : undefined;
const inReplyToSender =
  typeof o.inReplyToSender === 'string' && o.inReplyToSender.length > 0
    ? o.inReplyToSender
    : undefined;
```

And include them in the return value:

```typescript
return {
  conversationId: o.conversationId,
  from: o.from,
  text: o.text,
  messageId: o.messageId,
  sentAt: o.sentAt,
  inReplyToMessageId,
  inReplyToBody,
  inReplyToSender,
};
```

- [ ] **Step 5: Update `buildDeliverWiring` to accept and forward `inReplyToMessageId`**

In `services/kiloclaw/plugins/kilo-chat/src/webhook.ts`, add `inReplyToMessageId` to the `buildDeliverWiring` params type:

```typescript
export function buildDeliverWiring(params: {
  client: KiloChatClient;
  conversationId: string;
  inReplyToMessageId?: string;
  warn: (msg: string, err?: unknown) => void;
}): DeliverWiring {
```

Pass it to `createPreviewStream`:

```typescript
const stream = createPreviewStream({
  client: params.client,
  conversationId: params.conversationId,
  throttleMs: STREAM_THROTTLE_MS,
  inReplyToMessageId: params.inReplyToMessageId,
  onWarn: params.warn,
});
```

- [ ] **Step 6: Update `dispatchInbound` to pass reply fields to `finalizeInboundContext` and `buildDeliverWiring`**

In the `dispatchInbound` function, update the `finalizeInboundContext` call to include:

```typescript
ReplyToId: payload.inReplyToMessageId,
ReplyToBody: payload.inReplyToBody,
ReplyToSender: payload.inReplyToSender,
```

Update the `buildDeliverWiring` call to pass the triggering message ID so the bot's reply threads back:

```typescript
const wiring = buildDeliverWiring({
  client,
  conversationId: payload.conversationId,
  inReplyToMessageId: payload.messageId,
  warn: (msg, err) => console.error(`[kilo-chat] ${msg}:`, err),
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd services/kiloclaw/plugins/kilo-chat && npx vitest run src/webhook.test.ts`
Expected: All tests PASS

- [ ] **Step 8: Run full plugin test suite**

Run: `cd services/kiloclaw/plugins/kilo-chat && npx vitest run`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```
feat(kilo-chat-plugin): parse reply context in webhook and thread bot replies
```

---

### Task 8: Final verification

- [ ] **Step 1: Run kilo-chat backend tests**

Run: `cd services/kilo-chat && pnpm test`
Expected: All tests PASS

- [ ] **Step 2: Run kiloclaw typecheck**

Run: `cd services/kiloclaw && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Run plugin tests**

Run: `cd services/kiloclaw/plugins/kilo-chat && npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Format changed files**

Run: `pnpm run format:changed`
Expected: Files formatted

- [ ] **Step 5: Commit any formatting changes**

If formatting changed anything, commit:

```
style: format
```
