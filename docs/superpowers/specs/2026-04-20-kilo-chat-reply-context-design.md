# Kilo-Chat Reply Context (Bidirectional)

## Problem

When a user replies to a specific message in the kilo-chat UI, the agent has no idea the user was quoting a particular message. The reply context (`inReplyToMessageId`) is stored in the database but dropped at every stage of the webhook delivery chain. Conversely, when the agent replies, its messages are always top-level — even though the frontend already renders threaded replies and the kilo-chat backend supports `in_reply_to_message_id`.

## Solution

Thread reply context through the full inbound and outbound paths so the agent sees what the user quoted and the agent's responses thread back to the triggering message.

## Inbound Path (user → agent)

### Data flow

```
User sends message with inReplyToMessageId
  → kilo-chat backend createMessageFor()
    → resolves parent message text + sender from ConversationDO
    → deliverToBot() includes reply context in webhook payload
      → kiloclaw RPC (pass-through)
        → controller HTTP forward (pass-through)
          → plugin webhook handler
            → sets ReplyToId, ReplyToBody, ReplyToSender on finalizeInboundContext()
              → OpenClaw core auto-builds [Replying to ...] block in agent prompt
```

### Changes

**`services/kilo-chat/src/do/conversation-do.ts`** — Add `getMessage(messageId: string)` RPC method.

Returns `{ id, senderId, content, deleted } | null`. Needed so `createMessageFor` can look up the parent message's text and sender without listing.

**`services/kilo-chat/src/webhook/deliver.ts`** — Add optional reply fields to types.

`WebhookMessage` gains: `inReplyToMessageId?: string`, `inReplyToBody?: string`, `inReplyToSender?: string`.

`WebhookPayload` gains the same three optional fields.

`buildPayload()` passes them through when present.

**`services/kilo-chat/src/services/messages.ts`** — Resolve parent message in `createMessageFor`.

When `inReplyToMessageId` is set, call `convStub.getMessage(inReplyToMessageId)` to get the parent's text content and `senderId`. Extract `inReplyToBody` by joining all text-type content blocks (same pattern as `buildPayload`'s existing text extraction). Pass all three reply fields to `deliverToBot`.

If `getMessage` returns null (deleted or invalid), deliver the webhook without reply context — graceful degradation.

**`services/kiloclaw/src/types.ts`** — Add optional reply fields to `ChatWebhookPayload`.

`inReplyToMessageId?: string`, `inReplyToBody?: string`, `inReplyToSender?: string`.

The kiloclaw `deliverChatWebhook` method already strips `targetBotId` and forwards the rest verbatim — no other changes needed in kiloclaw.

**`services/kiloclaw/plugins/kilo-chat/src/webhook.ts`** — Parse reply fields and pass to OpenClaw.

`KiloChatInboundPayload` gains optional `inReplyToMessageId`, `inReplyToBody`, `inReplyToSender`.

`parseInboundPayload` extracts these (optional strings, missing = undefined).

`dispatchInbound` passes `ReplyToId`, `ReplyToBody`, `ReplyToSender` to `finalizeInboundContext`. OpenClaw core automatically constructs the `[Replying to <sender> id:<id>] <body> [/Replying]` block in the agent's prompt — this is the standard mechanism used by WhatsApp, Telegram, Discord, etc.

## Outbound Path (agent → kilo-chat)

### Data flow

```
OpenClaw agent reply (replyToId from session context)
  → plugin sendText({ to, text, replyToId })
    → client.createMessage({ conversationId, content, inReplyToMessageId })
      → controller proxy (transparent relay)
        → kilo-chat backend (stores in_reply_to_message_id)
          → frontend renders threaded reply (already works)
```

### Changes

**`services/kiloclaw/plugins/kilo-chat/src/client.ts`** — Add `inReplyToMessageId?: string` to `CreateMessageParams`. Include it in the JSON body sent to the controller `/send` endpoint.

**`services/kiloclaw/plugins/kilo-chat/src/channel.ts`** — Update `sendText` in `outbound.attachedResults` to destructure `replyToId` from params and pass it as `inReplyToMessageId` to `client.createMessage`.

**`services/kiloclaw/plugins/kilo-chat/src/preview-stream.ts`** — Add `inReplyToMessageId?: string` to `CreatePreviewStreamOptions`. The first POST (in `flushOnce` and the `finalize` fallback path) includes it in the `createMessage` call. Subsequent PATCHes don't need it — it's set once on creation.

**`services/kiloclaw/plugins/kilo-chat/src/webhook.ts`** — Update `buildDeliverWiring` to accept the inbound `messageId` (the triggering user message). Pass it as `inReplyToMessageId` to `createPreviewStream` so the bot's streamed reply threads back to the user's message. This mirrors how other OpenClaw channels thread bot replies.

### Controller proxy

The controller routes in `services/kiloclaw/controller/src/routes/kilo-chat.ts` use `relayBodyRoute` which forwards the request body verbatim. Adding `inReplyToMessageId` to the plugin client's request body flows through automatically — no controller changes needed.

## Edge Cases

- **Parent message deleted or not found:** `getMessage` returns null → webhook delivered without reply context. Agent sees no quote, same as today.
- **Parent message is soft-deleted:** `getMessage` returns `{ deleted: true }` → treat as not found, skip reply context. Don't quote deleted content.
- **Bot replying to its own message:** Works fine. `replyToId` from OpenClaw is the inbound triggering message ID.
- **Preview streaming:** `inReplyToMessageId` set on the first POST only. PATCHes and the final PATCH don't change it.
- **Multiple bot members:** Each bot gets its own webhook delivery with the same reply context. Independent.

## Files Changed

| Package | File | Nature |
|---------|------|--------|
| kilo-chat backend | `src/do/conversation-do.ts` | Add `getMessage()` RPC |
| kilo-chat backend | `src/services/messages.ts` | Resolve parent, pass to webhook |
| kilo-chat backend | `src/webhook/deliver.ts` | Add reply fields to types + passthrough |
| kiloclaw | `src/types.ts` | Add reply fields to `ChatWebhookPayload` |
| plugin | `src/client.ts` | Add `inReplyToMessageId` to create params |
| plugin | `src/channel.ts` | Pass `replyToId` from sendText params |
| plugin | `src/preview-stream.ts` | Accept + forward `inReplyToMessageId` on first POST |
| plugin | `src/webhook.ts` | Parse reply fields, set on context, thread bot reply |

## Test Updates

| Test file | What to add |
|-----------|-------------|
| `services/kilo-chat/src/__tests__/conversation-do.test.ts` | `getMessage` returns correct data, returns null for missing/deleted |
| `services/kilo-chat/src/__tests__/messages-routes.test.ts` | Webhook delivery includes reply context when `inReplyToMessageId` is set |
| `services/kilo-chat/src/__tests__/webhook-deliver.test.ts` | `buildPayload` passes through reply fields |
| `services/kiloclaw/plugins/kilo-chat/src/webhook.test.ts` | Inbound payload parsing with reply fields, `ReplyToId`/`Body`/`Sender` set on context |
| `services/kiloclaw/plugins/kilo-chat/src/channel.test.ts` | `sendText` passes `replyToId` through |
| `services/kiloclaw/plugins/kilo-chat/src/preview-stream.test.ts` | First POST includes `inReplyToMessageId`, PATCHes don't |
| `services/kiloclaw/plugins/kilo-chat/src/client.test.ts` | `createMessage` sends `inReplyToMessageId` in request body |
