# Bot-reported delivery failure for kilo-chat

## Context

The kilo-chat webhook handler in the kiloclaw plugin acks `202 Accepted`
as soon as the payload parses, then runs dispatch / approval resolution
in an unawaited promise (`services/kiloclaw/plugins/kilo-chat/src/webhook.ts:374`).
That means "delivered" in kilo-chat only reflects webhook receipt, not
successful processing. If the background work fails, state drifts silently.

We need two bot-facing endpoints that let the plugin report those
failures after the 202, and we need the UI to react.

## Scope

Two endpoints, two state changes, two events, matching UI updates.

### 1. Message delivery failure

**Route:** `POST /bot/v1/sandboxes/:sandboxId/conversations/:conversationId/messages/:messageId/delivery-failed`

**Body:** `{ reason?: string }` — logged only, not stored.

**Behavior:**

- Sandbox auth via existing `auth-bot.ts` middleware.
- Calls ConversationDO `notifyDeliveryFailed(messageId)` (already exists —
  `services/kilo-chat/src/do/conversation-do.ts:152`). Flips
  `messages.delivery_failed = 1`. Idempotent by construction (UPDATE is a
  no-op on an already-failed row).
- Pushes the existing `message.delivery_failed` event to human members via
  `pushEventToHumanMembers` (same shape as today's RPC-exhausted path in
  `services/kilo-chat/src/webhook/deliver.ts:92`).
- Returns `202 {}`.

**Refactor:** extract the "flip flag + push event" block out of
`deliverToBot` into a shared helper so both the RPC-exhausted path and
this route use it. One source of truth for the delivery-failure notify.

### 2. Action delivery failure

**Route:** `POST /bot/v1/sandboxes/:sandboxId/conversations/:conversationId/actions/:groupId/delivery-failed`

**Body:** `{ messageId: string; reason?: string }`

**Behavior:**

- Sandbox auth same as above.
- Calls new ConversationDO method `revertActionResolution({ messageId, groupId })`
  that clears `resolved` on the actions block back to `undefined` and
  bumps `version`. Traversal mirrors `executeAction`
  (`services/kilo-chat/src/do/conversation-do.ts:423`). Idempotent:
  already-unresolved is a no-op success.
- Pushes a new `action.delivery_failed` event to human members
  (name matches the existing `message.delivery_failed` convention):

  ```ts
  actionDeliveryFailedEventSchema = z.object({
    conversationId: z.string(),
    messageId: z.string(),
    groupId: z.string(),
  });
  ```

  Added to the discriminated union and payload registry in
  `packages/kilo-chat/src/events.ts`.

- Returns `202 {}`.

Retry is implicit: the user clicks the button again, `executeAction`
runs, a fresh `action.executed` webhook fires. No retry API.

## Plugin side (kiloclaw)

In `services/kiloclaw/plugins/kilo-chat/src/`:

- Add `client.ts`:
  - `reportMessageDeliveryFailed(conversationId, messageId, reason?)`
  - `reportActionDeliveryFailed(conversationId, groupId, messageId, reason?)`
- Extend `parseActionExecutedPayload` in `webhook.ts:87` to keep
  `conversationId` and `messageId` (currently dropped).
- In `webhook.ts`:
  - `.catch` after `dispatchInbound` (line 439) → call
    `reportMessageDeliveryFailed`.
  - `.catch` after `handleActionExecuted` (line 415) → call
    `reportActionDeliveryFailed`.
- Both best-effort: swallow errors from the report call itself. Never
  throw from the catch. Not fired on the synchronous 400 paths — nothing
  was acked.

## UI (`apps/web/src/app/(app)/claw/kilo-chat/`)

- **Messages**: already handled. `hooks/useMessages.ts:404` processes
  `message.delivery_failed` and flips `deliveryFailed: true` on the row;
  `components/MessageBubble.tsx:355` renders the failed-badge. No change.
- **Actions**: add handling for the new `action.delivery_failed` event.
  - In `hooks/useMessages.ts`, next to the existing event switch, add a
    `case 'action.delivery_failed'` that finds the target message by
    `messageId` and clears `resolved` on the matching `actions` block
    (mirror of the optimistic-resolve branch at line 285).
  - Show a `toast.error('Couldn\'t reach the bot — please try again')`
    via `sonner` (already imported throughout the kilo-chat UI, e.g.
    `components/MessageArea.tsx:25`). Fire the toast in the same
    reducer branch so it's coupled to the state revert.

## Shared package

`packages/kilo-chat/src/events.ts`:

- Add `actionDeliveryFailedEventSchema` and `'action.delivery_failed'`
  branches in the discriminated union and the `payloadSchemaRegistry`.
- Add a client `onActionDeliveryFailed(...)` helper in
  `packages/kilo-chat/src/client.ts`, mirroring the existing
  `onMessageDeliveryFailed` (line 226).

## Tests

- kilo-chat routes:
  - message delivery-failed: flips DO flag, pushes event, idempotent,
    auth-scoped to sandbox.
  - action delivery-failed: clears DO `resolved`, pushes
    `action.delivery_failed`, idempotent (already-unresolved succeeds
    silently), auth-scoped.
- kilo-chat DO: `revertActionResolution` clears `resolved`, bumps
  version, no-ops on already-unresolved, `not_found` on unknown
  messageId/groupId.
- plugin: dispatch rejection triggers message report; action handler
  rejection triggers action report; success paths do not.
- events package: `action.delivery_failed` round-trips through the union.
- web UI: reducer branch for `action.delivery_failed` clears `resolved`
  on the right actions block and fires a toast.

## Rollout

Additive on all sides. Old plugin versions never report (current
behavior). Old kilo-chat would 404 the new routes; the plugin swallows.
UI that hasn't shipped `action.delivery_failed` handling just misses the
live transition — next fetch shows the unresolved state anyway.
