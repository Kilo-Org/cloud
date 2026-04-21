# Kilo Chat OpenClaw Plugin Findings

## Context

Issue #2361 adds the Kilo Chat OpenClaw channel plugin so KiloClaw sandboxes can receive Kilo Chat messages and stream assistant replies back into Kilo Chat conversations.

The implementation is directionally appropriate for OpenClaw's channel plugin model. It uses a native channel plugin manifest, package-level OpenClaw metadata, setup entry, HTTP plugin route, outbound channel implementation, shared message-tool actions, and preview streaming through send/edit/delete calls.

This document records the remaining findings, proposed fixes, and useful follow-up functionality.

## Current Implementation Assessment

1. The plugin manifest at `services/kiloclaw/plugins/kilo-chat/openclaw.plugin.json` has the expected native plugin shape with `id`, `kind: "channel"`, `channels`, and config schema metadata.
2. `services/kiloclaw/plugins/kilo-chat/package.json` declares OpenClaw extension metadata, setup entry, and channel entry points.
3. `services/kiloclaw/plugins/kilo-chat/src/index.ts` registers the channel via `defineChannelPluginEntry` and exposes `/plugins/kilo-chat/webhook` with plugin auth.
4. `services/kiloclaw/plugins/kilo-chat/src/channel.ts` uses OpenClaw's channel plugin builder and implements outbound send/edit/delete typing/reaction/read/member-info behavior through the KiloClaw controller.
5. The streaming behavior matches OpenClaw's documented preview-streaming model: create a temporary message, edit it as partial content arrives, finalize it, and delete it on abort/failure.
6. The controller proxy keeps the plugin talking to localhost while forwarding Kilo Chat API calls to the Worker with the derived per-sandbox gateway token.
7. The inbound service-binding path is covered by a new test in `services/kiloclaw/src/index.test.ts`, which verifies `deliverChatWebhook` resolves the target instance and forwards to `/plugins/kilo-chat/webhook` with the derived proxy token.

## Potential Issues And Proposed Fixes

1. Config schema path mismatch.
   - Finding: the manifest schema appears to describe plugin entry config, while runtime config is written under `channels["kilo-chat"]`.
   - Impact: runtime behavior is probably unaffected, but OpenClaw setup/status/audit surfaces may validate or display the wrong config path.
   - Proposal: update metadata to describe the channel config section if OpenClaw supports extension `channelConfigs`; otherwise remove misleading plugin-config schema and keep runtime validation in code.

2. `reactionLevel` is a fake load-bearing config field.
   - Finding: `config-writer.ts` sets `reactionLevel` because an earlier implementation needed meaningful config for plugin loading, but runtime code does not appear to use it.
   - Impact: user-facing config implies reaction behavior that does not exist.
   - Proposal: replace it with an explicit internal configured marker such as `configured: true` or `_kiloChatConfigured: true` if that satisfies OpenClaw's meaningful-config check. If OpenClaw requires semantic config, implement real reaction behavior and document it.

3. Kilo Chat conversations may share one OpenClaw session.
   - Finding: the plugin models targets as `direct`. OpenClaw's default DM behavior can collapse direct messages into the agent's main session.
   - Impact: separate Kilo Chat conversations may unintentionally share memory/context.
   - Proposal: set OpenClaw `session.dmScope` to `per-channel-peer` in generated config, or use an equivalent channel-specific session setting if available. This should make each conversation ID produce its own session key.

4. README edit payload was stale.
   - Finding: README said edit payloads use `version`, but code sends `timestamp`.
   - Status: fixed in commit `9c5d2995b`.

5. `read` action may render blank message bodies.
   - Finding: `read-action.ts` appears to format `msg.text`, while Kilo Chat stores and returns message content as content blocks such as `{ type: "text", text: "..." }`.
   - Impact: if the API response does not include a flattened `text` field, the agent's read-history output may omit message content.
   - Proposal: normalize content blocks inside the action by joining text blocks. Include sender labels and timestamps while touching this code.

6. End-to-end webhook routing needed coverage.
   - Finding: plugin handler and controller proxy had tests, but the KiloClaw Worker service-binding `deliverChatWebhook` path was not directly covered.
   - Status: fixed in commit `9c5d2995b` with a test that verifies target instance resolution, forwarded payload shape, and derived proxy token.

7. Kilo Chat backend health is not surfaced.
   - Finding: `KILOCHAT_BASE_URL` is expected to always exist from `wrangler.jsonc`, so startup env validation is not the concern. Runtime availability is still opaque.
   - Impact: operators may not know when the Kilo Chat backend is unavailable or returning errors.
   - Proposal: add a lightweight health check from the controller to the Kilo Chat Worker and surface it in controller health/status as `kiloChat: healthy | degraded` with the last error. Do not block startup.

8. Inbound non-text messages are rejected.
   - Finding: the webhook payload currently requires non-empty `text`.
   - Impact: attachment-only/image-only/file-only messages cannot reach the agent.
   - Decision: acceptable for this iteration. Revisit with media support.

9. Timestamp validation is minimal.
   - Finding: `sentAt` is trusted and not deeply validated.
   - Decision: acceptable because this is a closed trusted service path.

## Useful Missing Functionality

1. Edit/delete bot message actions.
   - Add OpenClaw message actions for editing and deleting bot-authored Kilo Chat messages.
   - This is approved as useful for a follow-up.

2. Message search.
   - Add a tool/action for searching conversation history.
   - Useful for agents that need to reference prior discussion without reading pages manually.

3. Conversation rename/create.
   - Add tools/actions for creating conversations and renaming existing conversations if Kilo Chat supports these operations.
   - Keep separate from pin/unpin, which is not desired for now.

4. Richer `member-info`.
   - Current behavior is ID/kind oriented.
   - Add display name, safe profile metadata, and role-like fields if available.

5. Better `read` action.
   - The read action is the agent's way to read recent Kilo Chat history.
   - Improve it with pagination (`before`), timestamps, sender labels, and content-block rendering.

6. Setup/status metadata.
   - `docsPath`: link OpenClaw setup/status UI to plugin setup docs.
   - `markdownCapable`: tell OpenClaw whether Kilo Chat supports markdown-formatted messages.
   - `exposure`: describe whether the channel behaves like DM/group/public messaging for security/status surfaces.
   - `channelConfigs`: describe channel-level config schema if OpenClaw supports it for extension channels.

7. Health check visibility.
   - Add controller-visible Kilo Chat health as described above.
   - This is more useful than env validation because the env var is guaranteed by deployment config.

8. Conversation discovery and targeting.
   - Add tools for agents/operators to discover target conversations without raw ULIDs.
   - Suggested tools: `kilo-chat.conversations.list`, `kilo-chat.conversations.search`, and `kilo-chat.conversations.create`.
   - For routing syntax, keep raw `kilo-chat:<conversationId>` support and add resolver support for display names or search results.

9. Native approval surfaces.
   - Follow-up item: expose Kilo Chat as a first-class OpenClaw approval UI through OpenClaw approval capability metadata.
   - Useful for exec/plugin approvals, but not part of the current iteration.

10. Attachments and media.
    - Future iteration only.
    - Add inbound attachment context and outbound file/image support through OpenClaw media patterns.

11. Inbound non-text content.
    - Future iteration only.
    - Allow image/file/structured messages to be represented in agent context instead of rejected.

## Explicitly Not Planned For This Iteration

1. Configurable streaming mode.
   - Decision: Kilo Chat should always stream.

2. Pin/unpin actions.
   - Decision: skip for now.

3. Attachment/media support.
   - Decision: future iteration.

4. Inbound non-text message support.
   - Decision: future iteration.

5. Native approval surfaces.
   - Decision: follow-up.

## Verification Already Performed

1. `pnpm --filter kiloclaw test src/index.test.ts`
2. `pnpm format`
3. Push hooks ran `format:check` and affected package typechecks successfully.

## Related Commit

`9c5d2995b test(kilo-chat): cover webhook delivery`
