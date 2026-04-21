# Kilo-Chat OpenClaw Channel Plugin Enhancements

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the kilo-chat OpenClaw channel plugin with edit/delete/rename message actions, improved read pagination, setup metadata, and a health check probe for the kilo-chat Worker.

**Architecture:** Six tasks add new plugin actions (edit, delete, rename), improve the existing read action (pagination + timestamps), add metadata to `package.json`, and introduce a periodic health probe from the controller to the kilo-chat Worker. Each action follows the existing `react-action.ts` pattern: a standalone handler file with unit tests, wired into `channel.ts` via `supportsAction` + `handleAction`. The controller proxy, client, and kilo-chat service changes follow existing patterns from the codebase.

**Tech Stack:** TypeScript, Vitest, Hono (controller routes), OpenClaw plugin SDK, pnpm monorepo

---

## File Map

| File                                                            | Role                                 | Task |
| --------------------------------------------------------------- | ------------------------------------ | ---- |
| `services/kiloclaw/plugins/kilo-chat/src/edit-action.ts`        | Edit message action handler          | 1    |
| `services/kiloclaw/plugins/kilo-chat/src/edit-action.test.ts`   | Tests for edit action                | 1    |
| `services/kiloclaw/plugins/kilo-chat/src/delete-action.ts`      | Delete message action handler        | 1    |
| `services/kiloclaw/plugins/kilo-chat/src/delete-action.test.ts` | Tests for delete action              | 1    |
| `services/kiloclaw/plugins/kilo-chat/src/channel.ts`            | Wire edit/delete/rename actions      | 1, 3 |
| `services/kiloclaw/plugins/kilo-chat/src/channel.test.ts`       | Update channel adapter tests         | 1, 3 |
| `services/kilo-chat/src/routes/conversations.ts`                | Remove user-only guard on rename     | 2    |
| `services/kilo-chat/src/routes/bot-messages.ts`                 | Add bot rename route                 | 2    |
| `services/kilo-chat/src/__tests__/bot-messages-routes.test.ts`  | Bot rename integration tests         | 2    |
| `services/kiloclaw/controller/src/routes/kilo-chat.ts`          | Add rename proxy route               | 3    |
| `services/kiloclaw/controller/src/routes/kilo-chat.test.ts`     | Tests for rename proxy route         | 3    |
| `services/kiloclaw/controller/src/index.ts`                     | Register rename route + health probe | 3, 6 |
| `services/kiloclaw/plugins/kilo-chat/src/client.ts`             | Add `renameConversation` method      | 3    |
| `services/kiloclaw/plugins/kilo-chat/src/client.test.ts`        | Test `renameConversation`            | 3    |
| `services/kiloclaw/plugins/kilo-chat/src/rename-action.ts`      | Rename action handler                | 3    |
| `services/kiloclaw/plugins/kilo-chat/src/rename-action.test.ts` | Tests for rename action              | 3    |
| `services/kiloclaw/plugins/kilo-chat/src/read-action.ts`        | Add `before` param + timestamps      | 4    |
| `services/kiloclaw/plugins/kilo-chat/src/read-action.test.ts`   | Update read action tests             | 4    |
| `services/kiloclaw/plugins/kilo-chat/package.json`              | Add channel metadata                 | 5    |
| `services/kiloclaw/controller/src/routes/health.ts`             | Health probe + expose in version     | 6    |
| `services/kiloclaw/controller/src/routes/health.test.ts`        | Health probe tests                   | 6    |

---

## Reference: mockClient helper

All plugin action tests use this pattern. The `renameConversation` method must be added when Task 3 is implemented. Until then, tests for Tasks 1 and 4 use the existing mock shape.

```typescript
function mockClient(overrides: Partial<KiloChatClient> = {}): KiloChatClient {
  return {
    createMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    sendTyping: vi.fn(),
    sendTypingStop: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    listMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getMembers: vi.fn(),
    renameConversation: vi.fn(),
    ...overrides,
  } as KiloChatClient;
}
```

**Note:** After Task 3 adds `renameConversation` to `KiloChatClient`, all existing `mockClient` helpers in other test files need the new method added too. The implementer should add `renameConversation: vi.fn()` to mockClient in ALL existing test files (`react-action.test.ts`, `read-action.test.ts`, `member-info-action.test.ts`) when implementing Task 3.

---

### Task 1: Edit and delete bot message actions (plugin-only)

**Files:**

- Create: `services/kiloclaw/plugins/kilo-chat/src/edit-action.ts`
- Create: `services/kiloclaw/plugins/kilo-chat/src/edit-action.test.ts`
- Create: `services/kiloclaw/plugins/kilo-chat/src/delete-action.ts`
- Create: `services/kiloclaw/plugins/kilo-chat/src/delete-action.test.ts`
- Modify: `services/kiloclaw/plugins/kilo-chat/src/channel.ts`
- Modify: `services/kiloclaw/plugins/kilo-chat/src/channel.test.ts`

#### Edit action

- [ ] **Step 1: Write edit-action.test.ts**

Create `services/kiloclaw/plugins/kilo-chat/src/edit-action.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { handleKiloChatEditAction } from './edit-action';
import type { KiloChatClient } from './client';

function mockClient(overrides: Partial<KiloChatClient> = {}): KiloChatClient {
  return {
    createMessage: vi.fn(),
    editMessage: vi.fn().mockResolvedValue({ messageId: 'MID', stale: false }),
    deleteMessage: vi.fn(),
    sendTyping: vi.fn(),
    sendTypingStop: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    listMessages: vi.fn(),
    getMembers: vi.fn(),
    ...overrides,
  } as KiloChatClient;
}

describe('handleKiloChatEditAction', () => {
  it('edits a message with explicit params', async () => {
    const client = mockClient();
    const result = await handleKiloChatEditAction({
      params: { to: 'CONV', messageId: 'MID', text: 'Updated text' },
      client,
    });
    expect(client.editMessage).toHaveBeenCalledWith({
      conversationId: 'CONV',
      messageId: 'MID',
      content: [{ type: 'text', text: 'Updated text' }],
      timestamp: expect.any(Number),
    });
    expect(result.content[0].text).toBe('Edited MID');
  });

  it('strips kilo-chat: prefix from conversationId', async () => {
    const client = mockClient();
    await handleKiloChatEditAction({
      params: { to: 'kilo-chat:CONV', messageId: 'MID', text: 'hi' },
      client,
    });
    expect(client.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'CONV' })
    );
  });

  it('falls back to toolContext for conversationId and messageId', async () => {
    const client = mockClient();
    await handleKiloChatEditAction({
      params: { text: 'hi' },
      toolContext: { currentChannelId: 'CTX_CONV', currentMessageId: 'CTX_MID' },
      client,
    });
    expect(client.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'CTX_CONV', messageId: 'CTX_MID' })
    );
  });

  it('throws when conversationId is missing', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatEditAction({
        params: { messageId: 'MID', text: 'hi' },
        toolContext: { currentMessageId: 'MID' },
        client,
      })
    ).rejects.toThrow(/conversationId/i);
  });

  it('throws when messageId is missing', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatEditAction({
        params: { to: 'CONV', text: 'hi' },
        toolContext: { currentChannelId: 'CONV' },
        client,
      })
    ).rejects.toThrow(/messageId/i);
  });

  it('throws when text is missing', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatEditAction({
        params: { to: 'CONV', messageId: 'MID' },
        client,
      })
    ).rejects.toThrow(/text is required/i);
  });

  it('reports stale edit without throwing', async () => {
    const client = mockClient({
      editMessage: vi.fn().mockResolvedValue({ messageId: 'MID', stale: true }),
    });
    const result = await handleKiloChatEditAction({
      params: { to: 'CONV', messageId: 'MID', text: 'hi' },
      client,
    });
    expect(result.content[0].text).toMatch(/stale/i);
  });
});
```

- [ ] **Step 2: Run edit action tests to verify they fail**

Run: `pnpm --filter @kiloclaw/kilo-chat test -- edit-action`
Expected: FAIL — `edit-action` module does not exist.

- [ ] **Step 3: Write edit-action.ts**

Create `services/kiloclaw/plugins/kilo-chat/src/edit-action.ts`:

```typescript
import type { KiloChatClient } from './client.js';

export type HandleKiloChatEditActionParams = {
  params: Record<string, unknown>;
  toolContext?: {
    currentChannelId?: string | null;
    currentMessageId?: string | number | null;
  };
  client: KiloChatClient;
};

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function stripPrefix(raw: string): string {
  return raw.trim().replace(/^kilo-chat:/i, '');
}

export async function handleKiloChatEditAction(
  args: HandleKiloChatEditActionParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const raw =
    readString(args.params, 'to') ??
    (typeof args.toolContext?.currentChannelId === 'string'
      ? args.toolContext.currentChannelId
      : undefined);
  if (!raw) {
    throw new Error('kilo-chat: conversationId (or `to`) is required');
  }
  const conversationId = stripPrefix(raw);

  const paramMessageId = readString(args.params, 'messageId');
  const ctxMessageId =
    args.toolContext?.currentMessageId != null
      ? String(args.toolContext.currentMessageId)
      : undefined;
  const messageId = paramMessageId ?? ctxMessageId;
  if (!messageId) {
    throw new Error('kilo-chat: messageId is required (explicit or via toolContext)');
  }

  const text = readString(args.params, 'text');
  if (!text) {
    throw new Error('kilo-chat: text is required for edit action');
  }

  const result = await args.client.editMessage({
    conversationId,
    messageId,
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  });

  if (result.stale) {
    return {
      content: [{ type: 'text', text: `Edit of ${messageId} was stale (a newer version exists)` }],
    };
  }

  return { content: [{ type: 'text', text: `Edited ${messageId}` }] };
}
```

- [ ] **Step 4: Run edit action tests to verify they pass**

Run: `pnpm --filter @kiloclaw/kilo-chat test -- edit-action`
Expected: 7 tests PASS.

#### Delete action

- [ ] **Step 5: Write delete-action.test.ts**

Create `services/kiloclaw/plugins/kilo-chat/src/delete-action.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { handleKiloChatDeleteAction } from './delete-action';
import type { KiloChatClient } from './client';

function mockClient(overrides: Partial<KiloChatClient> = {}): KiloChatClient {
  return {
    createMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn(),
    sendTypingStop: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    listMessages: vi.fn(),
    getMembers: vi.fn(),
    ...overrides,
  } as KiloChatClient;
}

describe('handleKiloChatDeleteAction', () => {
  it('deletes a message with explicit params', async () => {
    const client = mockClient();
    const result = await handleKiloChatDeleteAction({
      params: { to: 'CONV', messageId: 'MID' },
      client,
    });
    expect(client.deleteMessage).toHaveBeenCalledWith({
      conversationId: 'CONV',
      messageId: 'MID',
    });
    expect(result.content[0].text).toBe('Deleted MID');
  });

  it('strips kilo-chat: prefix from conversationId', async () => {
    const client = mockClient();
    await handleKiloChatDeleteAction({
      params: { to: 'kilo-chat:CONV', messageId: 'MID' },
      client,
    });
    expect(client.deleteMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'CONV' })
    );
  });

  it('falls back to toolContext for conversationId and messageId', async () => {
    const client = mockClient();
    await handleKiloChatDeleteAction({
      params: {},
      toolContext: { currentChannelId: 'CTX_CONV', currentMessageId: 'CTX_MID' },
      client,
    });
    expect(client.deleteMessage).toHaveBeenCalledWith({
      conversationId: 'CTX_CONV',
      messageId: 'CTX_MID',
    });
  });

  it('throws when conversationId is missing', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatDeleteAction({
        params: { messageId: 'MID' },
        toolContext: { currentMessageId: 'MID' },
        client,
      })
    ).rejects.toThrow(/conversationId/i);
  });

  it('throws when messageId is missing', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatDeleteAction({
        params: { to: 'CONV' },
        toolContext: { currentChannelId: 'CONV' },
        client,
      })
    ).rejects.toThrow(/messageId/i);
  });

  it('prefers explicit params over toolContext', async () => {
    const client = mockClient();
    await handleKiloChatDeleteAction({
      params: { to: 'EXPLICIT_CONV', messageId: 'EXPLICIT_MID' },
      toolContext: { currentChannelId: 'CTX_CONV', currentMessageId: 'CTX_MID' },
      client,
    });
    expect(client.deleteMessage).toHaveBeenCalledWith({
      conversationId: 'EXPLICIT_CONV',
      messageId: 'EXPLICIT_MID',
    });
  });

  it('coerces numeric messageId from toolContext', async () => {
    const client = mockClient();
    await handleKiloChatDeleteAction({
      params: {},
      toolContext: {
        currentChannelId: 'CONV',
        currentMessageId: 42 as unknown as string,
      },
      client,
    });
    expect(client.deleteMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: '42' }));
  });
});
```

- [ ] **Step 6: Run delete action tests to verify they fail**

Run: `pnpm --filter @kiloclaw/kilo-chat test -- delete-action`
Expected: FAIL — `delete-action` module does not exist.

- [ ] **Step 7: Write delete-action.ts**

Create `services/kiloclaw/plugins/kilo-chat/src/delete-action.ts`:

```typescript
import type { KiloChatClient } from './client.js';

export type HandleKiloChatDeleteActionParams = {
  params: Record<string, unknown>;
  toolContext?: {
    currentChannelId?: string | null;
    currentMessageId?: string | number | null;
  };
  client: KiloChatClient;
};

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function stripPrefix(raw: string): string {
  return raw.trim().replace(/^kilo-chat:/i, '');
}

export async function handleKiloChatDeleteAction(
  args: HandleKiloChatDeleteActionParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const raw =
    readString(args.params, 'to') ??
    (typeof args.toolContext?.currentChannelId === 'string'
      ? args.toolContext.currentChannelId
      : undefined);
  if (!raw) {
    throw new Error('kilo-chat: conversationId (or `to`) is required');
  }
  const conversationId = stripPrefix(raw);

  const paramMessageId = readString(args.params, 'messageId');
  const ctxMessageId =
    args.toolContext?.currentMessageId != null
      ? String(args.toolContext.currentMessageId)
      : undefined;
  const messageId = paramMessageId ?? ctxMessageId;
  if (!messageId) {
    throw new Error('kilo-chat: messageId is required (explicit or via toolContext)');
  }

  await args.client.deleteMessage({ conversationId, messageId });

  return { content: [{ type: 'text', text: `Deleted ${messageId}` }] };
}
```

- [ ] **Step 8: Run delete action tests to verify they pass**

Run: `pnpm --filter @kiloclaw/kilo-chat test -- delete-action`
Expected: 7 tests PASS.

#### Wire into channel.ts

- [ ] **Step 9: Update channel.ts to import and dispatch edit/delete actions**

In `services/kiloclaw/plugins/kilo-chat/src/channel.ts`:

Add imports at the top (after the existing `import { handleKiloChatReactAction } from './react-action';`):

```typescript
import { handleKiloChatEditAction } from './edit-action';
import { handleKiloChatDeleteAction } from './delete-action';
```

Change `describeMessageTool` actions array from:

```typescript
actions: ['react', 'read', 'member-info'] as const,
```

to:

```typescript
actions: ['react', 'read', 'member-info', 'edit', 'delete'] as const,
```

Change `supportsAction` from:

```typescript
supportsAction: ({ action }: { action: string }) =>
  action === 'react' || action === 'read' || action === 'member-info',
```

to:

```typescript
supportsAction: ({ action }: { action: string }) =>
  action === 'react' ||
  action === 'read' ||
  action === 'member-info' ||
  action === 'edit' ||
  action === 'delete',
```

In `handleAction`, add two dispatch branches before the final `return handleKiloChatReactAction(...)` fallback:

```typescript
if (ctx.action === 'edit') {
  return handleKiloChatEditAction({
    params: ctx.params,
    toolContext: ctx.toolContext,
    client,
  });
}
if (ctx.action === 'delete') {
  return handleKiloChatDeleteAction({
    params: ctx.params,
    toolContext: ctx.toolContext,
    client,
  });
}
```

- [ ] **Step 10: Update channel.test.ts**

In `services/kiloclaw/plugins/kilo-chat/src/channel.test.ts`:

Update the `describeMessageTool` test from:

```typescript
it('describeMessageTool returns all three actions', () => {
  const adapter = kiloChatPlugin.actions;
  expect(adapter).toBeDefined();
  const discovery = adapter!.describeMessageTool?.({ cfg: {} as never, accountId: null });
  expect(discovery?.actions).toContain('react');
  expect(discovery?.actions).toContain('read');
  expect(discovery?.actions).toContain('member-info');
});
```

to:

```typescript
it('describeMessageTool returns all supported actions', () => {
  const adapter = kiloChatPlugin.actions;
  expect(adapter).toBeDefined();
  const discovery = adapter!.describeMessageTool?.({ cfg: {} as never, accountId: null });
  expect(discovery?.actions).toContain('react');
  expect(discovery?.actions).toContain('read');
  expect(discovery?.actions).toContain('member-info');
  expect(discovery?.actions).toContain('edit');
  expect(discovery?.actions).toContain('delete');
});
```

Update the `supportsAction` test from:

```typescript
it('supportsAction returns true for react, read, member-info and false for pin', () => {
  const adapter = kiloChatPlugin.actions;
  expect(adapter?.supportsAction?.({ action: 'react' as never })).toBe(true);
  expect(adapter?.supportsAction?.({ action: 'read' as never })).toBe(true);
  expect(adapter?.supportsAction?.({ action: 'member-info' as never })).toBe(true);
  expect(adapter?.supportsAction?.({ action: 'pin' as never })).toBe(false);
});
```

to:

```typescript
it('supportsAction returns true for supported actions and false for unsupported', () => {
  const adapter = kiloChatPlugin.actions;
  expect(adapter?.supportsAction?.({ action: 'react' as never })).toBe(true);
  expect(adapter?.supportsAction?.({ action: 'read' as never })).toBe(true);
  expect(adapter?.supportsAction?.({ action: 'member-info' as never })).toBe(true);
  expect(adapter?.supportsAction?.({ action: 'edit' as never })).toBe(true);
  expect(adapter?.supportsAction?.({ action: 'delete' as never })).toBe(true);
  expect(adapter?.supportsAction?.({ action: 'pin' as never })).toBe(false);
});
```

- [ ] **Step 11: Run all plugin tests to verify everything passes**

Run: `pnpm --filter @kiloclaw/kilo-chat test`
Expected: All tests PASS.

- [ ] **Step 12: Format and commit**

```bash
pnpm format
git add services/kiloclaw/plugins/kilo-chat/src/edit-action.ts \
       services/kiloclaw/plugins/kilo-chat/src/edit-action.test.ts \
       services/kiloclaw/plugins/kilo-chat/src/delete-action.ts \
       services/kiloclaw/plugins/kilo-chat/src/delete-action.test.ts \
       services/kiloclaw/plugins/kilo-chat/src/channel.ts \
       services/kiloclaw/plugins/kilo-chat/src/channel.test.ts
git commit -m "feat(kilo-chat): add edit and delete message actions to plugin"
```

---

### Task 2: Bot rename endpoint in kilo-chat service

**Files:**

- Modify: `services/kilo-chat/src/routes/conversations.ts:87-91` — remove user-only guard
- Modify: `services/kilo-chat/src/routes/bot-messages.ts` — add bot rename route
- Modify: `services/kilo-chat/src/__tests__/bot-messages-routes.test.ts` — add bot rename tests

The `renameConversationFor` service function (`services/kilo-chat/src/services/conversations.ts:84-116`) already checks membership via `convStub.isMember(userId)` — that's the real access control. The `callerKind !== 'user'` guard on the PATCH handler is redundant and prevents bots from renaming. The bot's `callerId` is `bot:kiloclaw:{sandboxId}`, and the DO's `isMember` check verifies the bot is a member.

- [ ] **Step 1: Write bot rename tests**

Add to `services/kilo-chat/src/__tests__/bot-messages-routes.test.ts`, after the existing `DELETE reactions` describe block at the end of the file:

```typescript
// ─── PATCH /bot/v1/sandboxes/:sandboxId/conversations/:conversationId ─────────

describe('PATCH /bot/v1/sandboxes/:sandboxId/conversations/:conversationId', () => {
  it('bot can rename a conversation it is a member of (200)', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-rename-ok');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: 'Renamed by bot' }),
      },
      testEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });

  it('returns 403 when bot is not a member', async () => {
    const { conversationId, testEnv } = await setupData('bot-rename-forbidden');
    const otherSandboxId = 'other-sandbox-rename';
    const app = makeBotApp();
    const token = await tokenFor(otherSandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${otherSandboxId}/conversations/${conversationId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: 'Nope' }),
      },
      testEnv
    );

    expect(res.status).toBe(403);
  });

  it('returns 400 for empty title', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-rename-empty');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: '' }),
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it('returns 400 for title exceeding 200 chars', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-rename-long');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: 'x'.repeat(201) }),
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid conversation ID', async () => {
    const { sandboxId, testEnv } = await setupData('bot-rename-badid');
    const app = makeBotApp();
    const token = await tokenFor(sandboxId);

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/not-a-ulid`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: 'Valid title' }),
      },
      testEnv
    );

    expect(res.status).toBe(400);
  });

  it('returns 401 without auth token', async () => {
    const { sandboxId, conversationId, testEnv } = await setupData('bot-rename-noauth');
    const app = makeBotApp();

    const res = await app.request(
      `/bot/v1/sandboxes/${sandboxId}/conversations/${conversationId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'No auth' }),
      },
      testEnv
    );

    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run bot rename tests to verify they fail**

Run: `pnpm --filter kilo-chat test -- bot-messages-routes`
Expected: FAIL — route not registered, 404 for PATCH.

- [ ] **Step 3: Create handleRenameConversation in handler.ts**

Add to `services/kilo-chat/src/routes/handler.ts`, after the existing imports at the top add:

```typescript
import { renameConversationFor } from '../services/conversations';
```

Then add a `renameConversationSchema` (at the top, after the existing imports):

```typescript
import { z } from 'zod';

const renameConversationSchema = z.object({
  title: z.string().min(1).max(200),
});
```

Then add the handler function at the bottom of the file:

```typescript
// ─── renameConversation ─────────────────────────────────────────────────────

export async function handleRenameConversation(c: HonoCtx) {
  const convId = parseConversationId(c);
  if (!convId.ok) return convId.response;

  const body = await parseBody(c, renameConversationSchema);
  if (!body.ok) return body.response;

  const callerId = c.get('callerId');
  const result = await renameConversationFor(c.env, callerId, {
    conversationId: convId.data,
    title: body.data.title,
  });
  if (!result.ok) {
    return c.json({ error: result.error }, 403);
  }
  return c.json({ ok: true });
}
```

- [ ] **Step 4: Remove user-only guard from conversations.ts rename handler**

In `services/kilo-chat/src/routes/conversations.ts`, remove lines 88-91 from the PATCH handler:

```typescript
// REMOVE these lines:
const callerKind = c.get('callerKind');
if (callerKind !== 'user') {
  return c.json({ error: 'Only users can rename conversations' }, 403);
}
```

The handler should now read:

```typescript
// PATCH /v1/conversations/:id — rename
app.patch('/v1/conversations/:id', async c => {
  const idParam = ulidSchema.safeParse(c.req.param('id'));
  if (!idParam.success) {
    return c.json({ error: 'Invalid conversation ID' }, 400);
  }
  const conversationId = idParam.data;

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const body = renameConversationSchema.safeParse(rawBody);
  if (!body.success) {
    return c.json({ error: 'Invalid request', issues: body.error.issues }, 400);
  }

  const callerId = c.get('callerId');
  const result = await renameConversationFor(c.env, callerId, {
    conversationId,
    title: body.data.title,
  });
  if (!result.ok) {
    return c.json({ error: result.error }, 403);
  }

  return c.json({ ok: true });
});
```

- [ ] **Step 5: Add bot rename route to bot-messages.ts**

In `services/kilo-chat/src/routes/bot-messages.ts`, add the import for the new handler:

```typescript
import {
  handleCreateMessage,
  handleEditMessage,
  handleDeleteMessage,
  handleAddReaction,
  handleRemoveReaction,
  handleSetTyping,
  handleStopTyping,
  handleListMessages,
  handleGetMembers,
  handleRenameConversation,
} from './handler';
```

Add the route inside `registerBotRoutes`, after the existing `getMembers` route:

```typescript
app.patch('/bot/v1/sandboxes/:sandboxId/conversations/:conversationId', handleRenameConversation);
```

- [ ] **Step 6: Run bot rename tests to verify they pass**

Run: `pnpm --filter kilo-chat test -- bot-messages-routes`
Expected: All tests PASS, including the new rename tests.

- [ ] **Step 7: Run all kilo-chat service tests**

Run: `pnpm --filter kilo-chat test`
Expected: All tests PASS. The existing conversations-routes tests should still pass (renaming still works for users since we only removed the guard, not the route).

- [ ] **Step 8: Format and commit**

```bash
pnpm format
git add services/kilo-chat/src/routes/conversations.ts \
       services/kilo-chat/src/routes/bot-messages.ts \
       services/kilo-chat/src/routes/handler.ts \
       services/kilo-chat/src/__tests__/bot-messages-routes.test.ts
git commit -m "feat(kilo-chat): allow bots to rename conversations via bot API"
```

---

### Task 3: Rename — controller proxy route, client method, and plugin action

**Files:**

- Modify: `services/kiloclaw/controller/src/routes/kilo-chat.ts` — add rename proxy route
- Modify: `services/kiloclaw/controller/src/routes/kilo-chat.test.ts` — test rename proxy
- Modify: `services/kiloclaw/controller/src/index.ts` — register rename route
- Modify: `services/kiloclaw/plugins/kilo-chat/src/client.ts` — add `renameConversation` method
- Modify: `services/kiloclaw/plugins/kilo-chat/src/client.test.ts` — test `renameConversation`
- Create: `services/kiloclaw/plugins/kilo-chat/src/rename-action.ts`
- Create: `services/kiloclaw/plugins/kilo-chat/src/rename-action.test.ts`
- Modify: `services/kiloclaw/plugins/kilo-chat/src/channel.ts` — add rename to actions
- Modify: `services/kiloclaw/plugins/kilo-chat/src/channel.test.ts` — update action tests

#### Controller proxy route

- [ ] **Step 1: Write controller rename proxy test**

Add to `services/kiloclaw/controller/src/routes/kilo-chat.test.ts`, after the existing `body size limits` describe block at the end of the file (but before the `makeListMessagesApp` function):

Actually — add it at the very end of the file:

```typescript
function makeRenameApp(fetchImpl: typeof fetch) {
  const app = new Hono();
  registerKiloChatRenameRoute(app, {
    expectedToken: TOKEN,
    sandboxId: SANDBOX_ID,
    kiloChatBaseUrl: 'https://chat.example.test',
    fetchImpl,
  });
  return app;
}

describe('PATCH /_kilo/kilo-chat/conversations/:conversationId', () => {
  it('rejects without bearer', async () => {
    const app = makeRenameApp(async () => new Response('{}', { status: 200 }));
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/conversations/CONV1', {
        method: 'PATCH',
        body: JSON.stringify({ title: 'New Name' }),
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(res.status).toBe(401);
  });

  it('forwards authorized PATCH to the kilo-chat worker rename endpoint', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const app = makeRenameApp(fetchImpl);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/conversations/CONV1', {
        method: 'PATCH',
        body: JSON.stringify({ title: 'New Name' }),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
      })
    );

    expect(res.status).toBe(200);
    expect(capturedUrl).toBe(
      'https://chat.example.test/bot/v1/sandboxes/sbx_test/conversations/CONV1'
    );
    expect(capturedInit?.method).toBe('PATCH');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer ' + TOKEN);
    expect(JSON.parse((capturedInit?.body as string) ?? '{}')).toEqual({
      title: 'New Name',
    });
  });

  it('returns 502 when upstream fetch throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const app = makeRenameApp(fetchImpl);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/conversations/CONV1', {
        method: 'PATCH',
        body: JSON.stringify({ title: 'x' }),
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

Also update the import at the top of the file to include `registerKiloChatRenameRoute`:

```typescript
import {
  registerKiloChatSendRoute,
  registerKiloChatEditRoute,
  registerKiloChatDeleteRoute,
  registerKiloChatTypingRoute,
  registerKiloChatReactionPostRoute,
  registerKiloChatReactionDeleteRoute,
  registerKiloChatListMessagesRoute,
  registerKiloChatGetMembersRoute,
  registerKiloChatRenameRoute,
} from './kilo-chat';
```

- [ ] **Step 2: Run controller rename test to verify it fails**

Run: `pnpm --filter kiloclaw test -- kilo-chat.test`
Expected: FAIL — `registerKiloChatRenameRoute` does not exist.

- [ ] **Step 3: Add registerKiloChatRenameRoute to kilo-chat.ts**

Add to `services/kiloclaw/controller/src/routes/kilo-chat.ts`, after the existing `registerKiloChatGetMembersRoute` function:

```typescript
export function registerKiloChatRenameRoute(app: Hono, options: KiloChatRouteOptions): void {
  app.patch('/_kilo/kilo-chat/conversations/:conversationId', c =>
    relayBodyRoute(c, options, {
      method: 'PATCH',
      upstreamSuffix: ctx =>
        `/conversations/${encodeURIComponent(routeParam(ctx, 'conversationId'))}`,
      bodyLimit: MAX_SMALL_BODY_BYTES,
    })
  );
}
```

- [ ] **Step 4: Register the rename route in controller index.ts**

In `services/kiloclaw/controller/src/index.ts`, update the import to include the new function:

```typescript
import {
  registerKiloChatSendRoute,
  registerKiloChatEditRoute,
  registerKiloChatDeleteRoute,
  registerKiloChatTypingRoute,
  registerKiloChatReactionPostRoute,
  registerKiloChatReactionDeleteRoute,
  registerKiloChatListMessagesRoute,
  registerKiloChatGetMembersRoute,
  registerKiloChatRenameRoute,
} from './routes/kilo-chat';
```

Add the registration inside the `if (env.KILOCLAW_SANDBOX_ID && kiloChatBaseUrl)` block, after `registerKiloChatGetMembersRoute(honoApp, kiloChatOpts);`:

```typescript
registerKiloChatRenameRoute(honoApp, kiloChatOpts);
```

- [ ] **Step 5: Run controller rename tests to verify they pass**

Run: `pnpm --filter kiloclaw test -- kilo-chat.test`
Expected: All tests PASS.

#### Client method

- [ ] **Step 6: Write client renameConversation test**

Add to `services/kiloclaw/plugins/kilo-chat/src/client.test.ts`, at the end of the file:

```typescript
describe('renameConversation', () => {
  it('PATCHes /_kilo/kilo-chat/conversations/:id with title in body', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'gwt',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.renameConversation({ conversationId: 'CONV1', title: 'New Name' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:18789/_kilo/kilo-chat/conversations/CONV1');
    const init2 = init as RequestInit;
    expect(init2.method).toBe('PATCH');
    const headers = new Headers(init2.headers);
    expect(headers.get('authorization')).toBe('Bearer gwt');
    expect(JSON.parse(init2.body as string)).toEqual({ title: 'New Name' });
  });

  it('URL-encodes the conversation id', async () => {
    const calls: Array<string> = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://ctrl',
      gatewayToken: 'gw',
      fetchImpl,
    });
    await client.renameConversation({ conversationId: 'a/b c', title: 'x' });
    expect(calls[0]).toBe('http://ctrl/_kilo/kilo-chat/conversations/a%2Fb%20c');
  });

  it('throws on non-2xx response', async () => {
    const fetchImpl = (async () => new Response('forbidden', { status: 403 })) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://ctrl',
      gatewayToken: 'gw',
      fetchImpl,
    });
    await expect(client.renameConversation({ conversationId: 'C', title: 'x' })).rejects.toThrow(
      /403/
    );
  });
});
```

- [ ] **Step 7: Run client rename test to verify it fails**

Run: `pnpm --filter @kiloclaw/kilo-chat test -- client.test`
Expected: FAIL — `renameConversation` method does not exist on client.

- [ ] **Step 8: Add renameConversation to client.ts**

In `services/kiloclaw/plugins/kilo-chat/src/client.ts`:

Add the type after the existing `GetMembersResult` type:

```typescript
export type RenameConversationParams = { conversationId: string; title: string };
```

Add the method signature to the `KiloChatClient` type:

```typescript
renameConversation(p: RenameConversationParams): Promise<void>;
```

Add the implementation inside `createKiloChatClient`, after the `getMembers` function:

```typescript
async function renameConversation(params: RenameConversationParams): Promise<void> {
  const response = await fetchImpl(
    `${base}/_kilo/kilo-chat/conversations/${encodeURIComponent(params.conversationId)}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ title: params.title }),
    }
  );
  if (!response.ok) {
    throw new Error(
      `kilo-chat: controller PATCH conversations responded ${response.status}: ${await response.text()}`
    );
  }
  void response.body?.cancel();
}
```

Add `renameConversation` to the return object:

```typescript
return {
  createMessage,
  editMessage,
  deleteMessage,
  sendTyping,
  sendTypingStop,
  addReaction,
  removeReaction,
  listMessages,
  getMembers,
  renameConversation,
};
```

- [ ] **Step 9: Update all mockClient helpers to include renameConversation**

In each of these test files, add `renameConversation: vi.fn(),` to the `mockClient` function's return object:

- `services/kiloclaw/plugins/kilo-chat/src/react-action.test.ts` — add after `removeReaction: vi.fn().mockResolvedValue(undefined),`
- `services/kiloclaw/plugins/kilo-chat/src/read-action.test.ts` — add after `getMembers: vi.fn(),`
- `services/kiloclaw/plugins/kilo-chat/src/member-info-action.test.ts` — add after `getMembers: vi.fn().mockResolvedValue({ members: [] }),`
- `services/kiloclaw/plugins/kilo-chat/src/edit-action.test.ts` — add after `getMembers: vi.fn(),`
- `services/kiloclaw/plugins/kilo-chat/src/delete-action.test.ts` — add after `getMembers: vi.fn(),`

- [ ] **Step 10: Run client rename tests to verify they pass**

Run: `pnpm --filter @kiloclaw/kilo-chat test -- client.test`
Expected: All tests PASS.

#### Plugin action

- [ ] **Step 11: Write rename-action.test.ts**

Create `services/kiloclaw/plugins/kilo-chat/src/rename-action.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { handleKiloChatRenameAction } from './rename-action';
import type { KiloChatClient } from './client';

function mockClient(overrides: Partial<KiloChatClient> = {}): KiloChatClient {
  return {
    createMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    sendTyping: vi.fn(),
    sendTypingStop: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    listMessages: vi.fn(),
    getMembers: vi.fn(),
    renameConversation: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as KiloChatClient;
}

describe('handleKiloChatRenameAction', () => {
  it('renames a conversation with explicit params', async () => {
    const client = mockClient();
    const result = await handleKiloChatRenameAction({
      params: { to: 'CONV', title: 'New Title' },
      client,
    });
    expect(client.renameConversation).toHaveBeenCalledWith({
      conversationId: 'CONV',
      title: 'New Title',
    });
    expect(result.content[0].text).toBe('Renamed conversation CONV to "New Title"');
  });

  it('strips kilo-chat: prefix from conversationId', async () => {
    const client = mockClient();
    await handleKiloChatRenameAction({
      params: { to: 'kilo-chat:CONV', title: 'X' },
      client,
    });
    expect(client.renameConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'CONV' })
    );
  });

  it('falls back to toolContext for conversationId', async () => {
    const client = mockClient();
    await handleKiloChatRenameAction({
      params: { title: 'X' },
      toolContext: { currentChannelId: 'CTX_CONV' },
      client,
    });
    expect(client.renameConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'CTX_CONV' })
    );
  });

  it('throws when conversationId is missing', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatRenameAction({
        params: { title: 'X' },
        client,
      })
    ).rejects.toThrow(/conversationId/i);
  });

  it('throws when title is missing', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatRenameAction({
        params: { to: 'CONV' },
        client,
      })
    ).rejects.toThrow(/title is required/i);
  });

  it('throws when title is empty string', async () => {
    const client = mockClient();
    await expect(
      handleKiloChatRenameAction({
        params: { to: 'CONV', title: '' },
        client,
      })
    ).rejects.toThrow(/title is required/i);
  });
});
```

- [ ] **Step 12: Run rename action test to verify it fails**

Run: `pnpm --filter @kiloclaw/kilo-chat test -- rename-action`
Expected: FAIL — `rename-action` module does not exist.

- [ ] **Step 13: Write rename-action.ts**

Create `services/kiloclaw/plugins/kilo-chat/src/rename-action.ts`:

```typescript
import type { KiloChatClient } from './client.js';

export type HandleKiloChatRenameActionParams = {
  params: Record<string, unknown>;
  toolContext?: { currentChannelId?: string | null };
  client: KiloChatClient;
};

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function stripPrefix(raw: string): string {
  return raw.trim().replace(/^kilo-chat:/i, '');
}

export async function handleKiloChatRenameAction(
  args: HandleKiloChatRenameActionParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const raw =
    readString(args.params, 'to') ??
    (typeof args.toolContext?.currentChannelId === 'string'
      ? args.toolContext.currentChannelId
      : undefined);
  if (!raw) {
    throw new Error('kilo-chat: conversationId (or `to`) is required');
  }
  const conversationId = stripPrefix(raw);

  const title = readString(args.params, 'title');
  if (!title) {
    throw new Error('kilo-chat: title is required for rename action');
  }

  await args.client.renameConversation({ conversationId, title });

  return {
    content: [{ type: 'text', text: `Renamed conversation ${conversationId} to "${title}"` }],
  };
}
```

- [ ] **Step 14: Run rename action tests to verify they pass**

Run: `pnpm --filter @kiloclaw/kilo-chat test -- rename-action`
Expected: 6 tests PASS.

#### Wire rename into channel.ts

- [ ] **Step 15: Update channel.ts to import and dispatch rename action**

In `services/kiloclaw/plugins/kilo-chat/src/channel.ts`:

Add import (after the edit/delete imports from Task 1):

```typescript
import { handleKiloChatRenameAction } from './rename-action';
```

Update `describeMessageTool` actions array from:

```typescript
actions: ['react', 'read', 'member-info', 'edit', 'delete'] as const,
```

to:

```typescript
actions: ['react', 'read', 'member-info', 'edit', 'delete', 'rename'] as const,
```

Update `supportsAction` to add `|| action === 'rename'`:

```typescript
supportsAction: ({ action }: { action: string }) =>
  action === 'react' ||
  action === 'read' ||
  action === 'member-info' ||
  action === 'edit' ||
  action === 'delete' ||
  action === 'rename',
```

Add dispatch branch in `handleAction`, after the `delete` branch and before the fallback `return handleKiloChatReactAction(...)`:

```typescript
if (ctx.action === 'rename') {
  return handleKiloChatRenameAction({
    params: ctx.params,
    toolContext: ctx.toolContext,
    client,
  });
}
```

- [ ] **Step 16: Update channel.test.ts for rename**

In `services/kiloclaw/plugins/kilo-chat/src/channel.test.ts`:

Update the `describeMessageTool` test to also assert:

```typescript
expect(discovery?.actions).toContain('rename');
```

Update the `supportsAction` test to also assert:

```typescript
expect(adapter?.supportsAction?.({ action: 'rename' as never })).toBe(true);
```

- [ ] **Step 17: Run all plugin tests**

Run: `pnpm --filter @kiloclaw/kilo-chat test`
Expected: All tests PASS.

- [ ] **Step 18: Run all controller tests**

Run: `pnpm --filter kiloclaw test`
Expected: All tests PASS.

- [ ] **Step 19: Format and commit**

```bash
pnpm format
git add services/kiloclaw/controller/src/routes/kilo-chat.ts \
       services/kiloclaw/controller/src/routes/kilo-chat.test.ts \
       services/kiloclaw/controller/src/index.ts \
       services/kiloclaw/plugins/kilo-chat/src/client.ts \
       services/kiloclaw/plugins/kilo-chat/src/client.test.ts \
       services/kiloclaw/plugins/kilo-chat/src/rename-action.ts \
       services/kiloclaw/plugins/kilo-chat/src/rename-action.test.ts \
       services/kiloclaw/plugins/kilo-chat/src/channel.ts \
       services/kiloclaw/plugins/kilo-chat/src/channel.test.ts \
       services/kiloclaw/plugins/kilo-chat/src/react-action.test.ts \
       services/kiloclaw/plugins/kilo-chat/src/read-action.test.ts \
       services/kiloclaw/plugins/kilo-chat/src/member-info-action.test.ts \
       services/kiloclaw/plugins/kilo-chat/src/edit-action.test.ts \
       services/kiloclaw/plugins/kilo-chat/src/delete-action.test.ts
git commit -m "feat(kilo-chat): add rename action with controller proxy, client method, and plugin wiring"
```

---

### Task 4: Better read action with pagination and timestamps

**Files:**

- Modify: `services/kiloclaw/plugins/kilo-chat/src/read-action.ts`
- Modify: `services/kiloclaw/plugins/kilo-chat/src/read-action.test.ts`

The client's `ListMessagesParams` already supports `before?: string`. The API response messages include `updatedAt: number | null` (epoch ms).

- [ ] **Step 1: Write new tests for before param and timestamps**

Add to `services/kiloclaw/plugins/kilo-chat/src/read-action.test.ts`, inside the existing `describe('handleKiloChatReadAction')` block. Add these tests after the existing `throws when conversationId cannot be resolved` test:

```typescript
it('passes before param to client.listMessages', async () => {
  const client = mockClient({
    listMessages: vi.fn().mockResolvedValue({
      messages: [{ id: 'M1', senderId: 'alice', content: [{ type: 'text', text: 'Hi' }] }],
    }),
  });

  await handleKiloChatReadAction({
    params: { to: 'CONV', before: 'CURSOR_XYZ' },
    client,
  });

  expect(client.listMessages).toHaveBeenCalledWith({
    conversationId: 'CONV',
    limit: undefined,
    before: 'CURSOR_XYZ',
  });
});

it('includes formatted timestamp when updatedAt is present', async () => {
  const ts = 1713700000000; // 2024-04-21T12:26:40.000Z
  const client = mockClient({
    listMessages: vi.fn().mockResolvedValue({
      messages: [
        {
          id: 'MSG1',
          senderId: 'alice',
          content: [{ type: 'text', text: 'Hello' }],
          updatedAt: ts,
        },
      ],
    }),
  });

  const result = await handleKiloChatReadAction({
    params: { to: 'CONV' },
    client,
  });

  const expectedIso = new Date(ts).toISOString();
  expect(result.content[0].text).toBe(`[MSG1] alice (${expectedIso}): Hello`);
});

it('omits timestamp when updatedAt is null', async () => {
  const client = mockClient({
    listMessages: vi.fn().mockResolvedValue({
      messages: [
        {
          id: 'MSG1',
          senderId: 'alice',
          content: [{ type: 'text', text: 'Hello' }],
          updatedAt: null,
        },
      ],
    }),
  });

  const result = await handleKiloChatReadAction({
    params: { to: 'CONV' },
    client,
  });

  expect(result.content[0].text).toBe('[MSG1] alice: Hello');
});

it('omits timestamp when updatedAt is not present', async () => {
  const client = mockClient({
    listMessages: vi.fn().mockResolvedValue({
      messages: [
        {
          id: 'MSG1',
          senderId: 'alice',
          content: [{ type: 'text', text: 'Hello' }],
        },
      ],
    }),
  });

  const result = await handleKiloChatReadAction({
    params: { to: 'CONV' },
    client,
  });

  expect(result.content[0].text).toBe('[MSG1] alice: Hello');
});
```

- [ ] **Step 2: Run read action tests to check which new tests fail**

Run: `pnpm --filter @kiloclaw/kilo-chat test -- read-action`
Expected: The `before param` test and the `includes formatted timestamp` test FAIL. The `omits timestamp` tests may pass since the current code doesn't include timestamps.

- [ ] **Step 3: Update read-action.ts to support before param and timestamps**

Replace the full contents of `services/kiloclaw/plugins/kilo-chat/src/read-action.ts`:

```typescript
import type { KiloChatClient } from './client.js';

export type HandleKiloChatReadActionParams = {
  params: Record<string, unknown>;
  toolContext?: { currentChannelId?: string | null };
  client: KiloChatClient;
};

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function stripPrefix(raw: string): string {
  return raw.trim().replace(/^kilo-chat:/i, '');
}

export async function handleKiloChatReadAction(
  args: HandleKiloChatReadActionParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const raw =
    readString(args.params, 'to') ??
    (typeof args.toolContext?.currentChannelId === 'string'
      ? args.toolContext.currentChannelId
      : undefined);
  if (!raw) {
    throw new Error('kilo-chat: conversationId (or `to`) is required');
  }
  const conversationId = stripPrefix(raw);

  const limitRaw = args.params.limit;
  const limit = typeof limitRaw === 'number' ? limitRaw : undefined;
  const before = readString(args.params, 'before');

  const { messages } = await args.client.listMessages({ conversationId, limit, before });

  if (messages.length === 0) {
    return { content: [{ type: 'text', text: 'No messages in this conversation.' }] };
  }

  const lines = messages.map(msg => {
    const id = typeof msg.id === 'string' ? msg.id : String(msg.id ?? '');
    const sender = typeof msg.senderId === 'string' ? msg.senderId : String(msg.senderId ?? '');
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const text = blocks
      .filter(
        (b: unknown): b is { type: string; text: string } =>
          typeof b === 'object' &&
          b !== null &&
          'text' in b &&
          typeof (b as Record<string, unknown>).text === 'string'
      )
      .map(b => b.text)
      .join('');

    const updatedAt = msg.updatedAt;
    if (typeof updatedAt === 'number') {
      const timestamp = new Date(updatedAt).toISOString();
      return `[${id}] ${sender} (${timestamp}): ${text}`;
    }

    return `[${id}] ${sender}: ${text}`;
  });

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
```

- [ ] **Step 4: Update existing test assertions**

The existing happy-path test expects `listMessages` to be called with `{ conversationId: 'CONV', limit: undefined }` but now the call also includes `before: undefined`. Update the assertion in the first test:

In `services/kiloclaw/plugins/kilo-chat/src/read-action.test.ts`, change the first test's assertion:

From:

```typescript
expect(client.listMessages).toHaveBeenCalledWith({ conversationId: 'CONV', limit: undefined });
```

To:

```typescript
expect(client.listMessages).toHaveBeenCalledWith({
  conversationId: 'CONV',
  limit: undefined,
  before: undefined,
});
```

And the `passes limit param` test:

From:

```typescript
expect(client.listMessages).toHaveBeenCalledWith({ conversationId: 'CONV', limit: 5 });
```

To:

```typescript
expect(client.listMessages).toHaveBeenCalledWith({
  conversationId: 'CONV',
  limit: 5,
  before: undefined,
});
```

- [ ] **Step 5: Run all read action tests to verify they pass**

Run: `pnpm --filter @kiloclaw/kilo-chat test -- read-action`
Expected: All tests PASS (existing + new).

- [ ] **Step 6: Format and commit**

```bash
pnpm format
git add services/kiloclaw/plugins/kilo-chat/src/read-action.ts \
       services/kiloclaw/plugins/kilo-chat/src/read-action.test.ts
git commit -m "feat(kilo-chat): add before pagination and timestamps to read action"
```

---

### Task 5: Setup/status metadata

**Files:**

- Modify: `services/kiloclaw/plugins/kilo-chat/package.json`

- [ ] **Step 1: Update package.json metadata**

In `services/kiloclaw/plugins/kilo-chat/package.json`, update the `openclaw.channel` field from:

```json
"channel": {
  "id": "kilo-chat",
  "label": "Kilo Chat",
  "blurb": "Kilo's hosted chat channel for OpenClaw instances."
}
```

to:

```json
"channel": {
  "id": "kilo-chat",
  "label": "Kilo Chat",
  "blurb": "Kilo's hosted chat channel for OpenClaw instances.",
  "markdownCapable": true,
  "exposure": "direct"
}
```

- [ ] **Step 2: Format and commit**

```bash
pnpm format
git add services/kiloclaw/plugins/kilo-chat/package.json
git commit -m "feat(kilo-chat): add markdownCapable and exposure metadata to channel config"
```

---

### Task 6: Kilo-chat health check visibility

**Files:**

- Modify: `services/kiloclaw/controller/src/routes/health.ts`
- Modify: `services/kiloclaw/controller/src/routes/health.test.ts`
- Modify: `services/kiloclaw/controller/src/index.ts`

#### Health probe

- [ ] **Step 1: Write health probe tests**

Add to `services/kiloclaw/controller/src/routes/health.test.ts`. Add the new import alongside the existing ones:

```typescript
import { startKiloChatHealthProbe } from './health';
import type { KiloChatHealthState } from './health';
```

Add these test blocks at the end of the file:

```typescript
describe('startKiloChatHealthProbe', () => {
  it('reports ok on 200 response', async () => {
    const fetchImpl = (async () => new Response('', { status: 200 })) as typeof fetch;
    const { getHealth, stop } = startKiloChatHealthProbe({
      kiloChatBaseUrl: 'https://chat.test',
      fetchImpl,
      intervalMs: 100_000, // won't fire in test
    });
    // Manually trigger by waiting for the initial probe
    await new Promise(resolve => setTimeout(resolve, 50));
    const health = getHealth();
    expect(health.status).toBe('ok');
    expect(health.lastCheckedAt).toBeGreaterThan(0);
    expect(health.lastError).toBeUndefined();
    stop();
  });

  it('reports degraded on non-200 response', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 503 })) as typeof fetch;
    const { getHealth, stop } = startKiloChatHealthProbe({
      kiloChatBaseUrl: 'https://chat.test',
      fetchImpl,
      intervalMs: 100_000,
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const health = getHealth();
    expect(health.status).toBe('degraded');
    expect(health.lastError).toMatch(/503/);
    stop();
  });

  it('reports unreachable on fetch error', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const { getHealth, stop } = startKiloChatHealthProbe({
      kiloChatBaseUrl: 'https://chat.test',
      fetchImpl,
      intervalMs: 100_000,
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const health = getHealth();
    expect(health.status).toBe('unreachable');
    expect(health.lastError).toMatch(/ECONNREFUSED/);
    stop();
  });
});

describe('GET /_kilo/version with kiloChatHealth', () => {
  it('includes kiloChatHealth when available', async () => {
    const app = new Hono();
    const kiloChatHealth: KiloChatHealthState = {
      status: 'ok',
      lastCheckedAt: 1713700000000,
    };
    registerHealthRoute(app, createMockSupervisor(), 'test-token', undefined, () => kiloChatHealth);

    const resp = await app.request('/_kilo/version', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json<{ kiloChatHealth: KiloChatHealthState }>();
    expect(body.kiloChatHealth).toEqual({ status: 'ok', lastCheckedAt: 1713700000000 });
  });

  it('omits kiloChatHealth when not configured', async () => {
    const app = new Hono();
    registerHealthRoute(app, createMockSupervisor(), 'test-token');

    const resp = await app.request('/_kilo/version', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json<Record<string, unknown>>();
    expect(body.kiloChatHealth).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run health tests to verify the new tests fail**

Run: `pnpm --filter kiloclaw test -- health.test`
Expected: FAIL — `startKiloChatHealthProbe` and `KiloChatHealthState` do not exist, and `registerHealthRoute` doesn't accept the 5th parameter.

- [ ] **Step 3: Add KiloChatHealthState type and startKiloChatHealthProbe to health.ts**

In `services/kiloclaw/controller/src/routes/health.ts`:

Add the type and probe function after the existing imports, before `registerHealthRoute`:

```typescript
export type KiloChatHealthState = {
  status: 'ok' | 'degraded' | 'unreachable';
  lastCheckedAt: number;
  lastError?: string;
};

export type KiloChatHealthProbeOptions = {
  kiloChatBaseUrl: string;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
};

export function startKiloChatHealthProbe(options: KiloChatHealthProbeOptions): {
  getHealth: () => KiloChatHealthState;
  stop: () => void;
} {
  const fetchImpl = options.fetchImpl ?? fetch;
  const intervalMs = options.intervalMs ?? 30_000;

  let state: KiloChatHealthState = {
    status: 'unreachable',
    lastCheckedAt: 0,
  };

  async function probe() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const response = await fetchImpl(`${options.kiloChatBaseUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        state = { status: 'ok', lastCheckedAt: Date.now() };
      } else {
        state = {
          status: 'degraded',
          lastCheckedAt: Date.now(),
          lastError: `HTTP ${response.status}`,
        };
      }
    } catch (err) {
      state = {
        status: 'unreachable',
        lastCheckedAt: Date.now(),
        lastError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Run the first probe immediately (non-blocking).
  void probe();

  const interval = setInterval(() => void probe(), intervalMs);

  return {
    getHealth: () => state,
    stop: () => clearInterval(interval),
  };
}
```

- [ ] **Step 4: Update registerHealthRoute to accept kiloChatHealth getter**

Change the `registerHealthRoute` signature from:

```typescript
export function registerHealthRoute(
  app: Hono,
  supervisor: Supervisor | null,
  expectedToken?: string,
  stateRef?: ControllerStateRef
): void {
```

to:

```typescript
export function registerHealthRoute(
  app: Hono,
  supervisor: Supervisor | null,
  expectedToken?: string,
  stateRef?: ControllerStateRef,
  getKiloChatHealth?: () => KiloChatHealthState
): void {
```

Update the `/_kilo/version` handler's return json to include kiloChatHealth when available. Change the return from:

```typescript
return c.json({
  version: CONTROLLER_VERSION,
  commit: CONTROLLER_COMMIT,
  openclawVersion: openclaw.version,
  openclawCommit: openclaw.commit,
  gateway: supervisor?.getStats() ?? null,
  ...(stateRef ? { controllerState: stateRef.current } : {}),
});
```

to:

```typescript
return c.json({
  version: CONTROLLER_VERSION,
  commit: CONTROLLER_COMMIT,
  openclawVersion: openclaw.version,
  openclawCommit: openclaw.commit,
  gateway: supervisor?.getStats() ?? null,
  ...(stateRef ? { controllerState: stateRef.current } : {}),
  ...(getKiloChatHealth ? { kiloChatHealth: getKiloChatHealth() } : {}),
});
```

- [ ] **Step 5: Run health tests to verify they pass**

Run: `pnpm --filter kiloclaw test -- health.test`
Expected: All tests PASS.

#### Wire into controller index.ts

- [ ] **Step 6: Update controller index.ts to start health probe**

In `services/kiloclaw/controller/src/index.ts`:

Update the import from `./routes/health` to include the new function:

```typescript
import { registerHealthRoute, startKiloChatHealthProbe } from './routes/health';
```

Inside the `if (env.KILOCLAW_SANDBOX_ID && kiloChatBaseUrl)` block, after the route registrations and after `registerKiloChatRenameRoute(honoApp, kiloChatOpts);`, start the health probe:

```typescript
const kiloChatHealthProbe = startKiloChatHealthProbe({ kiloChatBaseUrl });
```

Then update the `registerHealthRoute` call (which is above the kilo-chat block) to pass the health getter. Since the health probe is created inside the conditional block, we need to restructure slightly:

Declare a variable before the kilo-chat block:

```typescript
let getKiloChatHealth: (() => import('./routes/health').KiloChatHealthState) | undefined;
```

Then inside the kilo-chat block, after starting the probe:

```typescript
getKiloChatHealth = kiloChatHealthProbe.getHealth;
```

But wait — `registerHealthRoute` is called BEFORE the kilo-chat block. So the healthRoute won't have the getter at registration time. However, since `getKiloChatHealth` is a function reference, we can use a wrapper:

**Better approach**: Declare a mutable reference before `registerHealthRoute`:

Replace:

```typescript
registerHealthRoute(honoApp, supervisor, config.expectedToken, controllerState);
```

With:

```typescript
let kiloChatHealthGetter: (() => import('./routes/health').KiloChatHealthState) | undefined;
registerHealthRoute(
  honoApp,
  supervisor,
  config.expectedToken,
  controllerState,
  // Lazy: the getter is set after kilo-chat routes are registered
  () => kiloChatHealthGetter?.()!
);
```

Wait, that won't work cleanly — if `kiloChatHealthGetter` is undefined, we'd get undefined. Let's use a simpler approach: make the getter conditional.

**Simplest approach**: Use a late-binding wrapper that returns undefined when not set:

Actually, re-read the code. The `registerHealthRoute` call is at line 389. The kilo-chat block starts at line 399. We can't move `registerHealthRoute` after because other routes depend on order.

The cleanest approach is to keep a mutable ref:

Before `registerHealthRoute` (around line 388):

```typescript
let kiloChatHealthGetter: (() => import('./routes/health').KiloChatHealthState) | undefined;
```

Change `registerHealthRoute` call to:

```typescript
registerHealthRoute(honoApp, supervisor, config.expectedToken, controllerState, (() =>
  kiloChatHealthGetter?.()) as (() => import('./routes/health').KiloChatHealthState) | undefined);
```

Hmm, that's awkward because the 5th parameter type is `(() => KiloChatHealthState) | undefined` but we're passing a function that may return `undefined`.

**Best approach**: Pass a wrapper function that the version endpoint calls, and have it check for undefined internally. Actually, since the `registerHealthRoute` already does `getKiloChatHealth ? { kiloChatHealth: getKiloChatHealth() } : {}`, we always pass a function but need it to be a proper getter. Let's use a different pattern:

Wrap in a simple closure: always pass the getter function, but initialize it to return a default, and replace it once the probe starts.

Let me simplify the whole thing. We'll declare a state holder:

```typescript
import type { KiloChatHealthState } from './routes/health';
```

Before `registerHealthRoute`:

```typescript
const kiloChatHealthRef: { getter?: () => KiloChatHealthState } = {};
```

Pass to `registerHealthRoute`:

```typescript
registerHealthRoute(
  honoApp,
  supervisor,
  config.expectedToken,
  controllerState,
  kiloChatHealthRef.getter ? () => kiloChatHealthRef.getter!() : undefined
);
```

No — that evaluates at call time. We need late binding.

**Final approach**: Change the `registerHealthRoute` to accept a ref object instead. But that changes the signature tested elsewhere.

**Simplest correct approach**: Move `registerHealthRoute` to after the kilo-chat block. Looking at the existing code, there's no reason it must be called first — Hono matches routes in registration order, and `/_kilo/health` and `/_kilo/version` are specific paths that won't conflict with the kilo-chat routes.

So: move the `registerHealthRoute(honoApp, ...)` call to just after the kilo-chat block, passing the health getter.

In `services/kiloclaw/controller/src/index.ts`:

Remove the existing `registerHealthRoute(honoApp, supervisor, config.expectedToken, controllerState);` at line 389.

Add it after the kilo-chat block (after line 413), with the health getter:

```typescript
  let getKiloChatHealth: (() => KiloChatHealthState) | undefined;
  if (env.KILOCLAW_SANDBOX_ID && kiloChatBaseUrl) {
    const kiloChatOpts = { ... }; // (existing code)
    registerKiloChatSendRoute(honoApp, kiloChatOpts);
    // ... (existing route registrations)
    registerKiloChatRenameRoute(honoApp, kiloChatOpts);
    const kiloChatHealthProbe = startKiloChatHealthProbe({ kiloChatBaseUrl });
    getKiloChatHealth = kiloChatHealthProbe.getHealth;
  }
  registerHealthRoute(honoApp, supervisor, config.expectedToken, controllerState, getKiloChatHealth);
```

Wait, looking at the code more carefully — `registerHealthRoute` registers `/_kilo/health`, `/_kilo/version`, and `/health`. The kilo-chat routes register `/_kilo/kilo-chat/*`. These paths don't overlap, so registration order doesn't matter for matching.

**Here's the complete change for index.ts**:

1. Add `startKiloChatHealthProbe` to the import from `./routes/health`
2. Add `import type { KiloChatHealthState } from './routes/health';`
3. Move `registerHealthRoute(honoApp, supervisor, config.expectedToken, controllerState);` from line 389 to after the kilo-chat block
4. Declare `getKiloChatHealth` variable
5. Create health probe inside the kilo-chat block
6. Pass to `registerHealthRoute`

The resulting code around the kilo-chat block should look like:

```typescript
// kilo-chat channel
const kiloChatBaseUrl = env.KILOCHAT_BASE_URL || undefined;
let getKiloChatHealth: (() => KiloChatHealthState) | undefined;
if (env.KILOCLAW_SANDBOX_ID && kiloChatBaseUrl) {
  const kiloChatOpts = {
    expectedToken: config.expectedToken,
    sandboxId: env.KILOCLAW_SANDBOX_ID,
    kiloChatBaseUrl,
  };
  registerKiloChatSendRoute(honoApp, kiloChatOpts);
  registerKiloChatEditRoute(honoApp, kiloChatOpts);
  registerKiloChatDeleteRoute(honoApp, kiloChatOpts);
  registerKiloChatTypingRoute(honoApp, kiloChatOpts);
  registerKiloChatReactionPostRoute(honoApp, kiloChatOpts);
  registerKiloChatReactionDeleteRoute(honoApp, kiloChatOpts);
  registerKiloChatListMessagesRoute(honoApp, kiloChatOpts);
  registerKiloChatGetMembersRoute(honoApp, kiloChatOpts);
  registerKiloChatRenameRoute(honoApp, kiloChatOpts);
  const kiloChatHealthProbe = startKiloChatHealthProbe({ kiloChatBaseUrl });
  getKiloChatHealth = kiloChatHealthProbe.getHealth;
}
registerHealthRoute(honoApp, supervisor, config.expectedToken, controllerState, getKiloChatHealth);
```

Note: `registerHealthRoute` was previously at line 389 (before the kilo-chat block). Move it to after.

- [ ] **Step 7: Run all controller tests**

Run: `pnpm --filter kiloclaw test`
Expected: All tests PASS.

- [ ] **Step 8: Format and commit**

```bash
pnpm format
git add services/kiloclaw/controller/src/routes/health.ts \
       services/kiloclaw/controller/src/routes/health.test.ts \
       services/kiloclaw/controller/src/index.ts
git commit -m "feat(kilo-chat): add periodic health probe for kilo-chat Worker visibility in /_kilo/version"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run formatter**

```bash
pnpm format
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```

Expected: No errors.

- [ ] **Step 3: Run kiloclaw tests**

```bash
pnpm --filter kiloclaw test
```

Expected: All tests PASS.

- [ ] **Step 4: Run kilo-chat service tests**

```bash
pnpm --filter kilo-chat test
```

Expected: All tests PASS.

- [ ] **Step 5: Commit any formatting fixes if needed**

If `pnpm format` changed any files:

```bash
git add -A
git commit -m "style: apply oxfmt formatting"
```
