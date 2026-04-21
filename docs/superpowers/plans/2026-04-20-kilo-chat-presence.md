# Kilo-Chat Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add presence tracking to the event service — global ping heartbeat, per-context show/hide visibility, and presence join/leave broadcasts.

**Architecture:** The UserSessionDO gains per-connection userId tracking (WS attachment) and persisted presence state (DO storage) for `lastPingAt` and visible contexts. Three new client message types (ping, show, hide) and two new server messages (joined, left). `presence.sync` is deferred — the UserSessionDO is per-user so it can't aggregate across users without a separate coordination mechanism. Clients build presence state from join/leave events. The client starts a 5s ping interval on connect. RPC method `userPresent` renamed to `isUserInContext`.

**Tech Stack:** Cloudflare Workers, Durable Objects (Hibernation API + DO storage), TypeScript, WebSocket.

**Working directory:** `/Users/igor/Projects/.worktrees/kilo-chat-plugin/`
**Branch:** `feat/kiloclaw-kilo-chat-plugin` (PR #2361)

---

### Task 1: Add presence message types to both server and client

**Files:**
- Modify: `services/event-service/src/types.ts`
- Modify: `packages/event-service/src/types.ts`

- [ ] **Step 1: Update server types**

Replace the entire contents of `services/event-service/src/types.ts`:

```typescript
// ── Client → Server ─────────────────────────────────────────────────

export type ContextSubscribeMessage = {
  type: 'context.subscribe';
  contexts: string[];
};

export type ContextUnsubscribeMessage = {
  type: 'context.unsubscribe';
  contexts: string[];
};

export type PresencePingMessage = {
  type: 'presence.ping';
};

export type PresenceShowMessage = {
  type: 'presence.show';
  context: string;
};

export type PresenceHideMessage = {
  type: 'presence.hide';
  context: string;
};

export type ClientMessage =
  | ContextSubscribeMessage
  | ContextUnsubscribeMessage
  | PresencePingMessage
  | PresenceShowMessage
  | PresenceHideMessage;

// ── Server → Client ─────────────────────────────────────────────────

export type EventMessage = {
  type: 'event';
  context: string;
  event: string;
  payload: unknown;
};

export type PresenceJoinedMessage = {
  type: 'presence.joined';
  context: string;
  userId: string;
};

export type PresenceLeftMessage = {
  type: 'presence.left';
  context: string;
  userId: string;
};

export type ServerMessage = EventMessage | PresenceJoinedMessage | PresenceLeftMessage;
```

- [ ] **Step 2: Update client package types**

Replace the entire contents of `packages/event-service/src/types.ts` with the same types plus the config type:

```typescript
// Client → Server
export type ContextSubscribeMessage = {
  type: 'context.subscribe';
  contexts: string[];
};

export type ContextUnsubscribeMessage = {
  type: 'context.unsubscribe';
  contexts: string[];
};

export type PresencePingMessage = {
  type: 'presence.ping';
};

export type PresenceShowMessage = {
  type: 'presence.show';
  context: string;
};

export type PresenceHideMessage = {
  type: 'presence.hide';
  context: string;
};

export type ClientMessage =
  | ContextSubscribeMessage
  | ContextUnsubscribeMessage
  | PresencePingMessage
  | PresenceShowMessage
  | PresenceHideMessage;

// Server → Client
export type EventMessage = {
  type: 'event';
  context: string;
  event: string;
  payload: unknown;
};

export type PresenceJoinedMessage = {
  type: 'presence.joined';
  context: string;
  userId: string;
};

export type PresenceLeftMessage = {
  type: 'presence.left';
  context: string;
  userId: string;
};

export type ServerMessage = EventMessage | PresenceJoinedMessage | PresenceLeftMessage;

// Config
export type EventServiceConfig = {
  url: string;
  getToken: () => Promise<string>;
};
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/igor/Projects/.worktrees/kilo-chat-plugin && pnpm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add services/event-service/src/types.ts packages/event-service/src/types.ts
git commit -m "feat(event-service): add presence message types"
```

---

### Task 2: Add presence handling to UserSessionDO

**Files:**
- Modify: `services/event-service/src/do/user-session-do.ts`

Presence state is persisted in DO storage (not WS attachments). WS attachments continue to hold per-connection event subscription contexts and the userId.

Storage keys:
- `presence:lastPingAt` → `number` (global liveness for this user)
- `presence:visible:{context}` → `true` (one key per visible context)

- [ ] **Step 1: Add userId to WS attachment and update fetch**

Update the type:

```typescript
type SerializedState = { contexts: string[]; userId: string };
```

Update `fetch` to extract `userId` from the request URL:

```typescript
async fetch(request: Request): Promise<Response> {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId') ?? '';

  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];

  this.ctx.acceptWebSocket(server);
  server.serializeAttachment({ contexts: [], userId } satisfies SerializedState);

  return new Response(null, { status: 101, webSocket: client });
}
```

- [ ] **Step 2: Update getState and saveState**

```typescript
private getState(ws: WebSocket): { contexts: Set<string>; userId: string } {
  const raw = ws.deserializeAttachment() as SerializedState | null;
  return {
    contexts: new Set(raw?.contexts ?? []),
    userId: raw?.userId ?? '',
  };
}

private saveState(ws: WebSocket, state: { contexts: Set<string>; userId: string }): void {
  ws.serializeAttachment({
    contexts: [...state.contexts],
    userId: state.userId,
  } satisfies SerializedState);
}
```

- [ ] **Step 3: Add presence storage helpers**

```typescript
// ── Presence storage (DO-persisted) ─────────────────────────────

private async setLastPingAt(now: number): Promise<void> {
  await this.ctx.storage.put('presence:lastPingAt', now);
}

async getLastPingAt(): Promise<number> {
  return (await this.ctx.storage.get<number>('presence:lastPingAt')) ?? 0;
}

private async setVisible(context: string): Promise<boolean> {
  const key = `presence:visible:${context}`;
  const already = await this.ctx.storage.get<true>(key);
  if (already) return false;
  await this.ctx.storage.put(key, true);
  return true;
}

private async clearVisible(context: string): Promise<boolean> {
  const key = `presence:visible:${context}`;
  const was = await this.ctx.storage.get<true>(key);
  if (!was) return false;
  await this.ctx.storage.delete(key);
  return true;
}
```

- [ ] **Step 4: Add presence broadcast helper**

Broadcasts to connections subscribed to the context (via event subscriptions):

```typescript
private broadcastPresence(
  type: 'presence.joined' | 'presence.left',
  sender: WebSocket,
  context: string,
  userId: string
): void {
  const msg: ServerMessage = { type, context, userId };
  const text = JSON.stringify(msg);
  for (const ws of this.ctx.getWebSockets()) {
    if (ws === sender) continue;
    const state = this.getState(ws);
    if (state.contexts.has(context)) {
      try {
        ws.send(text);
      } catch {
        // dead connection
      }
    }
  }
}
```

- [ ] **Step 5: Add presence cases to webSocketMessage**

Add three new cases to the switch block:

```typescript
case 'presence.ping': {
  await this.setLastPingAt(Date.now());
  break;
}
case 'presence.show': {
  const added = await this.setVisible(msg.context);
  if (added) {
    const state = this.getState(ws);
    this.broadcastPresence('presence.joined', ws, msg.context, state.userId);
  }
  break;
}
case 'presence.hide': {
  const removed = await this.clearVisible(msg.context);
  if (removed) {
    const state = this.getState(ws);
    this.broadcastPresence('presence.left', ws, msg.context, state.userId);
  }
  break;
}
```

- [ ] **Step 6: Run typecheck and tests**

Run: `cd /Users/igor/Projects/.worktrees/kilo-chat-plugin && pnpm run typecheck`
Run: `cd /Users/igor/Projects/.worktrees/kilo-chat-plugin/services/event-service && pnpm test`
Expected: PASS (existing tests may need `userId` added to fixtures if they break)

- [ ] **Step 7: Commit**

```bash
git add services/event-service/src/do/user-session-do.ts
git commit -m "feat(event-service): add presence handling to UserSessionDO"
```

---

### Task 3: Rename `userPresent` to `isUserInContext`

**Files:**
- Modify: `services/event-service/src/do/user-session-do.ts`
- Modify: `services/event-service/src/index.ts`
- Modify: `services/event-service/src/__tests__/user-session-do.test.ts`
- Modify: `services/kilo-chat/src/services/event-push.ts`

- [ ] **Step 1: Rename in UserSessionDO**

In `services/event-service/src/do/user-session-do.ts`, rename the method:

```typescript
async isUserInContext(context: string): Promise<boolean> {
  for (const ws of this.ctx.getWebSockets()) {
    const state = this.getState(ws);
    if (state.contexts.has(context)) return true;
  }
  return false;
}
```

- [ ] **Step 2: Rename in WorkerEntrypoint**

In `services/event-service/src/index.ts`, rename:

```typescript
async isUserInContext(userId: string, context: string): Promise<boolean> {
  const doId = this.env.USER_SESSION_DO.idFromName(userId);
  const stub = this.env.USER_SESSION_DO.get(doId);
  return stub.isUserInContext(context);
}
```

- [ ] **Step 3: Rename in kilo-chat event-push.ts**

In `services/kilo-chat/src/services/event-push.ts`, update the binding type:

```typescript
type EventServiceBinding = {
  pushEvent: (userId: string, context: string, event: string, payload: unknown) => Promise<void>;
  isUserInContext: (userId: string, context: string) => Promise<boolean>;
};
```

Update the call site in `isUserPresentInConversation`:

```typescript
return await es.isUserInContext(userId, context);
```

- [ ] **Step 4: Update tests**

In `services/event-service/src/__tests__/user-session-do.test.ts`, rename all `userPresent` references to `isUserInContext` in test descriptions and method calls.

- [ ] **Step 5: Run typecheck and tests**

Run: `cd /Users/igor/Projects/.worktrees/kilo-chat-plugin && pnpm run typecheck`
Run: `cd /Users/igor/Projects/.worktrees/kilo-chat-plugin/services/event-service && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add services/event-service/src/do/user-session-do.ts services/event-service/src/index.ts services/event-service/src/__tests__/user-session-do.test.ts services/kilo-chat/src/services/event-push.ts
git commit -m "refactor(event-service): rename userPresent to isUserInContext"
```

---

### Task 4: Add presence methods to EventServiceClient

**Files:**
- Modify: `packages/event-service/src/client.ts`

- [ ] **Step 1: Add ping interval and presence handler state**

Add after `reconnectHandlers`:

```typescript
private pingTimer: ReturnType<typeof setInterval> | null = null;
private presenceHandlers = {
  joined: new Set<(context: string, userId: string) => void>(),
  left: new Set<(context: string, userId: string) => void>(),
};
```

- [ ] **Step 2: Start/stop ping on connect/disconnect**

In `ws.onopen` handler, after `resolve()`, add:

```typescript
this.startPing();
```

In `disconnect()`, before `this.connected = false`, add:

```typescript
this.stopPing();
```

Add private methods:

```typescript
private startPing(): void {
  this.stopPing();
  this.pingTimer = setInterval(() => {
    this.send({ type: 'presence.ping' });
  }, 5000);
}

private stopPing(): void {
  if (this.pingTimer !== null) {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
```

- [ ] **Step 3: Add public presence methods**

Add after `onReconnect`:

```typescript
showPresence(context: string): void {
  if (this.isConnected()) {
    this.send({ type: 'presence.show', context });
  }
}

hidePresence(context: string): void {
  if (this.isConnected()) {
    this.send({ type: 'presence.hide', context });
  }
}

onPresenceJoined(handler: (context: string, userId: string) => void): () => void {
  this.presenceHandlers.joined.add(handler);
  return () => { this.presenceHandlers.joined.delete(handler); };
}

onPresenceLeft(handler: (context: string, userId: string) => void): () => void {
  this.presenceHandlers.left.add(handler);
  return () => { this.presenceHandlers.left.delete(handler); };
}
```

- [ ] **Step 4: Update handleMessage for presence server messages**

Replace `handleMessage`:

```typescript
private handleMessage(data: string): void {
  let message: ServerMessage;
  try {
    message = JSON.parse(data) as ServerMessage;
  } catch {
    return;
  }

  switch (message.type) {
    case 'event': {
      const handlers = this.eventHandlers.get(message.event);
      if (handlers) {
        for (const handler of handlers) {
          handler(message.context, message.payload);
        }
      }
      break;
    }
    case 'presence.joined': {
      for (const handler of this.presenceHandlers.joined) {
        handler(message.context, message.userId);
      }
      break;
    }
    case 'presence.left': {
      for (const handler of this.presenceHandlers.left) {
        handler(message.context, message.userId);
      }
      break;
    }
  }
}
```

- [ ] **Step 5: Run typecheck**

Run: `cd /Users/igor/Projects/.worktrees/kilo-chat-plugin && pnpm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/event-service/src/client.ts
git commit -m "feat(event-service): add presence methods to EventServiceClient"
```

---

### Task 5: Add usePresence hook (plumbing only, no UI)

**Files:**
- Create: `apps/web/src/app/(app)/claw/kilo-chat/hooks/usePresence.ts`
- Modify: `apps/web/src/app/(app)/claw/kilo-chat/components/MessageArea.tsx`

- [ ] **Step 1: Create usePresence hook**

Create `apps/web/src/app/(app)/claw/kilo-chat/hooks/usePresence.ts`:

```typescript
import { useEffect, useState } from 'react';
import type { EventServiceClient } from '@kilocode/event-service';

/**
 * Manages presence for the current user in a conversation context.
 * Shows presence on mount, hides on unmount.
 * Builds present member set from join/leave events.
 */
export function usePresence(
  eventService: EventServiceClient,
  context: string | null
): Set<string> {
  const [members, setMembers] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!context) return;

    eventService.showPresence(context);

    const offs = [
      eventService.onPresenceJoined((ctx, userId) => {
        if (ctx === context) {
          setMembers(prev => {
            if (prev.has(userId)) return prev;
            const next = new Set(prev);
            next.add(userId);
            return next;
          });
        }
      }),
      eventService.onPresenceLeft((ctx, userId) => {
        if (ctx === context) {
          setMembers(prev => {
            if (!prev.has(userId)) return prev;
            const next = new Set(prev);
            next.delete(userId);
            return next;
          });
        }
      }),
    ];

    return () => {
      eventService.hidePresence(context);
      offs.forEach(off => off());
      setMembers(new Set());
    };
  }, [eventService, context]);

  return members;
}
```

- [ ] **Step 2: Wire usePresence in MessageArea**

In `apps/web/src/app/(app)/claw/kilo-chat/components/MessageArea.tsx`, add the import:

```typescript
import { usePresence } from '../hooks/usePresence';
```

After the `useConversationContext` call, add:

```typescript
const conversationContext = sandboxId ? `/kiloclaw/${sandboxId}/${conversationId}` : null;
const _presentMembers = usePresence(eventService, conversationContext);
```

Prefixed with `_` since it's not consumed by UI yet.

- [ ] **Step 3: Run typecheck and format**

Run: `cd /Users/igor/Projects/.worktrees/kilo-chat-plugin && pnpm run typecheck`
Run: `cd /Users/igor/Projects/.worktrees/kilo-chat-plugin && pnpm run format:changed`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(app\)/claw/kilo-chat/hooks/usePresence.ts apps/web/src/app/\(app\)/claw/kilo-chat/components/MessageArea.tsx
git commit -m "feat(kilo-chat): add usePresence hook and wire in MessageArea"
```

---

## Deferred

- **`presence.sync`** — server-side initial snapshot requires cross-DO aggregation (UserSessionDO is per-user). Needs either a PresenceDO per context or an RPC fan-out through the WorkerEntrypoint with a member list. Deferring to a follow-up when the UI needs it.
