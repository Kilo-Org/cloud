# kilo-chat: edit/delete plumbing + preview streaming

**Date:** 2026-04-13
**PR:** amends #2361
**Status:** approved (not committed per repo "no plan/spec .md commits" rule)

## Goal

Extend the kilo-chat channel plugin so agent replies appear progressively in the external chat client, Telegram-style ("H" → "Hel" → "Hello"), by editing a single message in place while tokens stream.

Out of scope: the external chat service itself (separate follow-up), reachability of the webhook through the CF Worker (existing gap from #2361), `block` streaming mode.

## Architecture

```
Agent reply (partial tokens → final block)
        │
        ▼
OpenClaw dispatch in webhook.ts
  replyOptions.onPartialReply ──┐
  recordInbound… → deliver     ─┤
        │                        ▼
        │             PreviewStream (per conversationId, per turn)
        │                  throttle 500ms, coalesce, version++
        │                  states: idle → created → editing → finalized|aborted
        │                        │
        ▼                        ▼
KiloChatClient.{createMessage, editMessage, deleteMessage}
        │
        ▼
Controller:  POST   /_kilo/kilo-chat/send
             PATCH  /_kilo/kilo-chat/messages/:id
             DELETE /_kilo/kilo-chat/messages/:id
        │   bearer OPENCLAW_GATEWAY_TOKEN, re-auth with
        │   Bearer KILOCHAT_API_TOKEN + x-kilo-sandbox-id
        ▼
External service (future):
             POST   {KILOCHAT_BASE_URL}/v1/messages
             PATCH  {KILOCHAT_BASE_URL}/v1/messages/:id
             DELETE {KILOCHAT_BASE_URL}/v1/messages/:id
```

## External-service contract (locked by this PR)

```
POST   {BASE}/v1/messages
  headers  Authorization: Bearer KILOCHAT_API_TOKEN
           x-kilo-sandbox-id: <sandbox>
           content-type: application/json
  body     { conversationId, text }
  resp     200 { messageId, version: 1 }

PATCH  {BASE}/v1/messages/:messageId
  headers  (same)
  body     { conversationId, text, version }   // monotonic int ≥ 2
  resp     200 { messageId, version }          // server echoes accepted version
  err      409 when version is not strictly greater than last accepted (client drops update)

DELETE {BASE}/v1/messages/:messageId
  headers  (same)
  body     { conversationId }
  resp     204
```

`version` is client-supplied, monotonic per `messageId`, starts at 1 on POST. Server MAY reject (409) any PATCH whose version is not strictly greater than the last accepted; client treats 409 as a benign drop (later PATCH supersedes anyway).

## Controller routes (`controller/src/routes/kilo-chat.ts`)

- Existing: `registerKiloChatSendRoute` (unchanged).
- New:
  - `registerKiloChatEditRoute` — `PATCH /_kilo/kilo-chat/messages/:messageId`
  - `registerKiloChatDeleteRoute` — `DELETE /_kilo/kilo-chat/messages/:messageId`
- All three share one `KiloChatRouteOptions` shape: `{ expectedToken, sandboxId, apiToken, baseUrl, fetchImpl? }`. Consider refactoring the three into `registerKiloChatRoutes(app, opts)` to reduce ceremony in `controller/src/index.ts`.
- Auth: bearer `expectedToken` (same `OPENCLAW_GATEWAY_TOKEN` pattern); on 401 path, do not leak upstream details.
- Downstream: rewrite with `Bearer ${apiToken}` and `x-kilo-sandbox-id`; forward raw body and `content-type`; passthrough upstream status + body (same pattern as existing send route).

## Plugin client (`plugins/kilo-chat/src/client.ts`)

```ts
type CreateMessageResult = { messageId: string; version: number };

type KiloChatClient = {
  createMessage(p: { conversationId: string; text: string }): Promise<CreateMessageResult>;
  editMessage(p: {
    conversationId: string;
    messageId: string;
    text: string;
    version: number;
  }): Promise<CreateMessageResult>;
  deleteMessage(p: { conversationId: string; messageId: string }): Promise<void>;
};
```

- `sendText` stays as a thin alias for `createMessage` (backward compatible with existing outbound wiring and tests).
- Error surface: throw on non-2xx except `409` on `editMessage`, which is treated as drop-and-continue (returns silently or resolves with `{ messageId, version: <last> }` — pick on implementation; tests pin behaviour).
- Validation of response JSON mirrors current pattern (`messageId` non-empty string, `version` positive integer).

## PreviewStream (`plugins/kilo-chat/src/preview-stream.ts`, new)

One controller per inbound dispatch turn, per `conversationId`. Borrows the throttle/coalesce pattern from `openclaw/src/channels/draft-stream-loop.ts` (≈50 LOC, duplicated — openclaw does not export it via `plugin-sdk`). Keep the module small and self-contained.

Public surface:

```ts
type PreviewStream = {
  update(partialText: string): void;         // fire-and-forget, throttled
  finalize(finalText: string): Promise<{ messageId: string }>; // awaits
  abort(reason?: unknown): Promise<void>;    // best-effort cleanup
};

function createPreviewStream(opts: {
  client: KiloChatClient;
  conversationId: string;
  throttleMs: number;                        // default 500
  now?: () => number;                        // test seam
  setTimer?: typeof setTimeout;              // test seam
  clearTimer?: typeof clearTimeout;          // test seam
}): PreviewStream;
```

State machine:

```
 idle
   │─ update(t)    ─► POST t              ─► editing (messageId, v=1, lastText=t)
   │─ finalize(t)  ─► POST t              ─► finalized (returns {messageId})
   │─ abort        ─► no-op               ─► aborted
 editing
   │─ update(t')   ─► throttled PATCH     ─► editing (v+=1, lastText=t')
   │                (dedup when t'==lastText; coalesce rapid updates)
   │─ finalize(t') ─► flush, PATCH t'     ─► finalized (returns {messageId})
   │─ abort        ─► DELETE messageId    ─► aborted (swallow errors)
 finalized | aborted
   │─ update       ─► ignored
   │─ finalize     ─► returns cached {messageId}
   │─ abort        ─► no-op
```

Invariants:
- Only one in-flight HTTP request at a time; concurrent `update` calls coalesce pending text.
- `finalize` waits for any in-flight request, then performs exactly one final POST (if idle) or PATCH (if editing). It is the only call that guarantees the external state matches its argument.
- `abort` runs `DELETE` only if `messageId` exists; errors are logged and swallowed.

Multi-block replies: preview covers the **first block only**. Subsequent blocks fall through to direct `createMessage`, producing additional messages. This mirrors OpenClaw's Telegram behavior for complex replies.

## Channel plugin (`plugins/kilo-chat/src/channel.ts`) changes

- Keep `outbound.attachedResults.sendText` (unchanged signature).
- Add to `outbound.attachedResults`:
  - `editText(params)` — invokes `client.editMessage`.
  - `deleteMessage(params)` — invokes `client.deleteMessage`.
- Verify `createChatChannelPlugin<T>` accepts these keys in `attachedResults`. If the builder does not, expose via `base.actions` or the manifest action list. Confirm during implementation by reading `openclaw/plugin-sdk/channel-core.d.ts`.
- `ResolvedKiloChatAccount` gains `{ streamingMode: 'off' | 'partial' | 'block'; throttleMs: number }`. Read via `resolveChannelPreviewStreamMode(section, 'partial')` from `openclaw/plugin-sdk/channel-streaming`; `throttleMs` reads `section.streaming?.throttleMs`, default 500.

## Config schema (`openclaw.plugin.json`)

Add under `channels.kilo-chat.properties`:

```json
"streaming": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "mode":       { "type": "string", "enum": ["off", "partial", "block"] },
    "throttleMs": { "type": "integer", "minimum": 100, "maximum": 5000 }
  }
}
```

Runtime defaults: `mode = 'partial'`, `throttleMs = 500`. Absent section = defaults.

## Webhook dispatch (`plugins/kilo-chat/src/webhook.ts`) changes

Inside `dispatchInbound`:

1. Read `streamingMode` and `throttleMs` from the resolved account.
2. Branch:
   - `off` or `block` (block not implemented; log warn once and treat as off): current behavior — `deliver` creates a new message per block.
   - `partial`: construct a `PreviewStream` for this `conversationId`. Pass `replyOptions: { onPartialReply: async payload => preview.update(payload.text ?? '') }` into `recordInboundSessionAndDispatchReply`. In the `deliver` callback:
     - First invocation with non-empty `text`: `await preview.finalize(text)` and record the resulting `messageId`.
     - Subsequent invocations: `await client.createMessage({ conversationId, text })`.
3. Wrap the whole dispatch in `try/catch`; on throw, `await preview.abort(err)` and rethrow.

## Config-writer, secrets, env vars

- No changes. Gating `KILOCHAT_API_TOKEN` + `KILOCHAT_BASE_URL` still enables the channel; `KILOCHAT_WEBHOOK_SECRET` still required for inbound. `streaming` is additive.

## Tests

- `client.test.ts` — add cases: `createMessage` happy path; `editMessage` happy path with version; `editMessage` 409 drop path; `deleteMessage` happy path; all error paths (non-2xx, malformed body).
- `preview-stream.test.ts` (new) — state-machine coverage with fake timers:
  - `update` before any send: POSTs, transitions to editing.
  - Two rapid `update`s within throttle: coalesced to one PATCH with latest text.
  - `update` with text equal to `lastText`: deduped, no HTTP.
  - `finalize` without prior `update`: exactly one POST.
  - `finalize` after updates: flushes any pending, performs one final PATCH with final text and `version = lastVersion + 1`.
  - `abort` after create: DELETE invoked; errors swallowed.
  - `abort` before any create: no HTTP.
  - Version monotonicity across many updates.
- `controller/src/routes/kilo-chat.test.ts` — add cases: PATCH route auth, success passthrough, upstream 409 passthrough; DELETE route auth, success, error passthrough.
- `webhook.test.ts` — add: `mode=partial` wires `onPartialReply` and uses preview.finalize; multi-block reply uses create for blocks 2+; error in deliver triggers abort → DELETE.
- `channel.test.ts` — add: `editText` / `deleteMessage` outbound actions present and delegate to client.

Target: all 1261 existing tests continue to pass; ~15–25 new tests across these files.

## Error handling

- Preview `update` never throws to caller; errors logged and stream transitions to aborted (best-effort DELETE attempt deferred to finalize/dispatch-exit).
- `finalize` may throw if the final PATCH/POST fails — caller (webhook) lets it bubble so OpenClaw sees dispatch failure.
- `abort` catches and logs; never throws.
- 409 on PATCH: client treats as drop; log at debug only to avoid noise.
- Preview is a live-UX feature: transient upstream failures during streaming do not surface to the agent or retry the dispatch.

## Docker / CI

No changes. Same artifact, same content-hash inputs.

## Known gaps (recorded, not fixed here)

- No public inbound route on CF Worker (inherited from #2361).
- `block` streaming mode not implemented (treated as `off` with a one-time warn).
- No retry/backoff on transient upstream 5xx during streaming edits.
- External service does not exist yet; end-to-end only verifiable once it lands.

## Open implementation questions to resolve while coding

- Whether `createChatChannelPlugin` accepts `editText` / `deleteMessage` in `outbound.attachedResults`, or requires a different slot (possibly `base.actions` or a capability declaration on the plugin object). Resolve by reading `openclaw/plugin-sdk/channel-core` types before writing `channel.ts` changes.
- Whether `block` mode should be parsed-but-unused (returns warn) or rejected at config validation. Default assumption: parsed, warned, treated as `off`.

## Self-review

- Placeholders: none.
- Internal consistency: version starts at 1 on POST (external contract) and `lastVersion + 1` on subsequent PATCH (preview-stream) — consistent.
- Scope: single PR amendment; plumbing + preview streaming + tests. Does not design the external service.
- Ambiguity: 409-on-PATCH behaviour is explicitly dropped; block-mode fallback behavior is explicitly "warn + off"; multi-block preview scope is explicitly "first block only". No remaining dual-reading.
