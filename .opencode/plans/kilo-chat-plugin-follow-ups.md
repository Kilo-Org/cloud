# Kilo Chat Plugin — Follow-Up Items

This document enumerates future enhancements for the kilo-chat OpenClaw channel plugin. Each item includes context, proposed approach, dependencies, and estimated effort.

These items were identified during the initial plugin review (see `.plans/kilo-chat-openclaw-plugin-findings.md`) and are deferred to future iterations.

---

## 1. Message Search

**What:** Add an action for searching conversation history by keyword.

**Why:** The agent's only way to find past messages is paginating through `read` action results. Search would let agents reference prior discussion directly.

**Dependencies:** Requires a new bot API endpoint on the kilo-chat service first: `GET /bot/v1/sandboxes/:sandboxId/conversations/:conversationId/messages/search?q=`. The kilo-chat Durable Object (ConversationDO) uses SQLite, which supports `LIKE` queries. A full-text search index (FTS5) would be better for larger conversations.

**Implementation path:**

1. Add `searchMessages` method to ConversationDO with SQLite LIKE or FTS5 query
2. Add `handleSearchMessages` handler in kilo-chat service routes
3. Register bot route in `bot-messages.ts`
4. Add controller proxy route `GET /_kilo/kilo-chat/conversations/:id/messages/search`
5. Add `searchMessages` client method
6. Add `search` action to the plugin

**Effort:** Large (cross-service, 3 packages)

---

## 2. Create Conversation

**What:** Add an action for the agent to create new conversations.

**Why:** Currently agents can only respond to existing conversations. Creating conversations would enable proactive outreach.

**Dependencies:** Requires a new bot API endpoint. The user-facing create endpoint exists at `POST /v1/conversations` (in `services/kilo-chat/src/routes/conversations.ts`) but has no bot equivalent. Bot conversations need decisions about: initial members, who "owns" the conversation, and how to surface bot-created conversations in the UI.

**Implementation path:**

1. Design bot conversation creation semantics (members, visibility, ownership)
2. Add bot create endpoint in kilo-chat service
3. Add controller proxy route, client method, and plugin action

**Effort:** Medium-Large (cross-service, design decisions needed)

---

## 3. Richer Member Info

**What:** Enhance the `member-info` action to include display names, profile metadata, and roles.

**Why:** Current output is just `- {id} ({kind})`. Display names would make member lists useful for the agent.

**Dependencies:** The kilo-chat ConversationDO's `getInfo()` and `getMembers()` methods currently only return `{ id, kind }`. The data source needs to be enriched — either by joining against a user profile table/DO, or by storing display names in the membership record.

**Implementation path:**

1. Decide where display names come from (membership DO, user profile DO, or a lookup service)
2. Enhance the kilo-chat `getMembers` response to include display names
3. Update the plugin's `member-info-action.ts` to format with names: `- {displayName} ({id}, {kind})`

**Effort:** Small (plugin side, once API exists) / Medium (API side)

---

## 4. Conversation Discovery and Targeting

**What:** Add tools for agents to discover target conversations without knowing raw ULIDs.

**Why:** Agents currently need raw `kilo-chat:01HXY...` ULIDs to target conversations. There's no way to list or search conversations.

**Dependencies:** Requires bot API endpoints: `GET /bot/v1/sandboxes/:sandboxId/conversations` (list) and optionally a search variant. The user-facing list endpoint exists at `GET /v1/conversations`.

**Implementation path:**

1. Add bot conversation list endpoint in kilo-chat service
2. Add controller proxy route, client method
3. Add `conversations.list` action to plugin
4. Optionally add target resolver support for display names (so agents can use `kilo-chat:Project Discussion` instead of ULIDs)

**Effort:** Medium-Large (cross-service)

---

## 5. Native Approval Surfaces

**What:** Expose Kilo Chat as a first-class OpenClaw approval UI.

**Why:** OpenClaw supports exec/plugin approval workflows. Kilo Chat could render approval requests as interactive messages with approve/reject buttons, giving users a chat-native approval experience.

**Dependencies:** Requires understanding OpenClaw's approval capability metadata contract. This is not documented in the current SDK surface area visible in the codebase.

**Implementation path:**

1. Research OpenClaw approval API (capability metadata, approval request format, callback mechanism)
2. Design Kilo Chat approval message format (card/buttons or structured message)
3. Implement approval capability in the plugin manifest and channel definition
4. Add webhook handler for approval responses from the chat UI

**Effort:** Unknown (depends on OpenClaw approval spec)

---

## 6. Attachments and Media (Outbound)

**What:** Add outbound file/image support so the agent can send media in Kilo Chat messages.

**Why:** Currently the plugin only sends text content blocks. Agents generating images, code files, or documents can't share them directly.

**Dependencies:** Requires:

- New `ContentBlock` variants in `@kilocode/kilo-chat` types (e.g., `ImageBlock`, `FileBlock`)
- kilo-chat service support for media content blocks (storage, rendering)
- OpenClaw media patterns for outbound delivery

**Implementation path:**

1. Define media content block types in `packages/kilo-chat`
2. Add media storage/serving infrastructure to kilo-chat service
3. Update the plugin's `sendText` to handle media blocks from OpenClaw's delivery pipeline
4. Add `sendMedia` or `sendFile` to the outbound interface

**Effort:** Large (cross-service, new infrastructure)

---

## 7. Inbound Non-Text Content

**What:** Allow image/file/structured messages to reach the agent instead of being rejected.

**Why:** The webhook handler currently requires non-empty `text`. Attachment-only or image-only messages are silently dropped.

**Dependencies:** Pairs with item 6 (attachments/media). Requires:

- Defining how non-text content is represented in the OpenClaw inbound context
- kilo-chat service support for rich content in bot webhook payloads

**Implementation path:**

1. Extend `KiloChatInboundPayload` in webhook.ts to accept optional `content` blocks alongside `text`
2. Build inbound context that includes media references (URLs, descriptions)
3. Make `text` optional when `content` blocks are present
4. Represent attachments in `BodyForAgent` (e.g., `[Image: description]` or `[File: filename.pdf]`)

**Effort:** Medium (cross-service, paired with media support)

---

## Related Documents

- `.plans/kilo-chat-openclaw-plugin-findings.md` — Original assessment identifying these items
- `.opencode/plans/kilo-chat-plugin-enhancements.md` — Implementation plan for items being done now
- `services/kiloclaw/plugins/kilo-chat/README.md` — Plugin documentation
