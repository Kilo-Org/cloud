# Shared Session Chat History Plan

## 1. Executive Summary

Can we render chat history from a shared URL today?

- Legacy `/share/{shareId}` can render only a limited preview from `shared_cli_sessions` snapshot rows. It reads `ui_messages_blob_url` server-side from R2, converts a small subset of legacy UI messages to simple `{ role, content, timestamp }`, and displays them in `apps/web/src/app/share/[shareId]/session-preview-dialog.tsx`.
- Current v2 `/s/{public_id}` cannot render chat history today. `apps/web/src/app/s/[sessionId]/page.tsx` validates the public UUID, loads metadata/title/owner, and renders only Open in Extension plus `kilo import` actions.
- The backend data path needed for v2 public history mostly exists. `services/session-ingest/src/app.ts` exposes public `GET /session/{public_id}`, resolves `cli_sessions_v2.public_id` to the internal session, and returns a `SessionIngestDO.getAllStream()` export shaped as `{ info, messages: [{ info, parts }] }`.
- The web app already has compatible rendering primitives in `apps/web/src/components/cloud-agent-next/MessageBubble.tsx` and `apps/web/src/components/cloud-agent-next/PartRenderer.tsx`. The recommended work is primarily a lightweight public landing page, a client-side fetch path, a sanitized renderer-ready snapshot contract, and an extracted read-only transcript component.

Recommended first implementation: keep `/s/[sessionId]` as a lightweight public landing page that validates and displays share metadata/actions, then add a CTA such as "View in Cloud Agent" that navigates to a client-rendered read-only viewer route like `/s/[sessionId]/view`. The viewer should fetch the public transcript from the browser with React Query and render it through extracted cloud-agent transcript components. Avoid fetching shared history server-side in the Next.js page.

This can work and is not too much if scoped as a read-only public viewer that reuses cloud-agent rendering components. It is too much for a first pass if "View in Cloud Agent" means importing or forking the shared transcript into a real authenticated cloud-agent session, or shoehorning the existing authenticated `CloudAgentProvider` unchanged into a public page.

## 2. Current Sharing Flows

### V2 shared links: `/s/{public_id}`

Creation flow:

- `apps/web/src/routers/cli-sessions-v2-router.ts` owns the authenticated `share` mutation.
- The router verifies the caller owns the v2 session.
- It calls `shareSession` in `apps/web/src/lib/session-ingest-client.ts`.
- `shareSession` calls the session-ingest worker at `POST /api/session/{sessionId}/share`.
- `services/session-ingest/src/routes/api.ts` and related worker logic set or return `cli_sessions_v2.public_id`.
- `packages/db/src/schema.ts` stores the public UUID on `cli_sessions_v2.public_id`.

Opening flow today:

- `apps/web/src/app/s/[sessionId]/page.tsx` treats `sessionId` as a public UUID.
- It validates the UUID, queries metadata/title/owner, and renders sharing actions.
- It does not call the public session-ingest export route and does not render messages.

Public history route already available:

- `services/session-ingest/src/app.ts` has `GET /session/{public_id}`.
- The route maps public UUID to internal `cli_sessions_v2.session_id` and `kilo_user_id`.
- It returns `SessionIngestDO.getAllStream()` from `services/session-ingest/src/dos/SessionIngestDO.ts`.
- Export shape is `{ info, messages: [{ info, parts }] }`, which is close to the web renderer's `StoredMessage = { info: Message, parts: Part[] }`.
- Because this is currently a raw-ish export, product and engineering should decide whether direct browser exposure is acceptable or whether to add a narrower public view endpoint first.

Authenticated history retrieval:

- `apps/web/src/lib/session-ingest-client.ts` already has `fetchSessionSnapshot` and `fetchSessionMessages` for authenticated retrieval.
- `cliSessionsV2.getSessionMessages` uses these authenticated paths.
- This is a useful reference, but the public viewer should use a distinct public fetch path keyed by `public_id` rather than user-owned session IDs.

### Legacy shared links: `/share/{shareId}`

- Legacy sharing uses `shared_cli_sessions` snapshot rows.
- `cliSessionsRouter.share` copies R2 blobs from `sessions/{session_id}` to `shared-sessions/{share_id}`.
- `apps/web/src/app/share/[shareId]/page.tsx` validates the UUID, requires `shared_state = public`, reads `ui_messages_blob_url` server-side from R2, converts a small subset of legacy UI messages, and renders only a preview dialog.
- This legacy flow should remain separate from v2. It can inform privacy and caching decisions, but it should not be the target architecture for v2 history rendering.

## 3. Recommended Architecture

### Primary path: landing page plus client-rendered read-only viewer

Keep `/s/{public_id}` as a lightweight landing page:

- Continue validating the public UUID and share metadata/title/owner as it does today.
- Preserve existing Open in Extension and `kilo import` actions.
- Add a CTA such as "View in Cloud Agent" that links to `/s/{public_id}/view` or an equivalent public viewer route.
- Do not fetch the transcript snapshot server-side in `apps/web/src/app/s/[sessionId]/page.tsx`.

Create a public read-only viewer route:

- Add a client-rendered viewer route such as `apps/web/src/app/s/[sessionId]/view/page.tsx` with a client component for data fetching and rendering.
- Use React Query in the browser to fetch the public transcript snapshot.
- Render loading, empty, revoked/not-found, and fetch-error states without requiring authentication.
- Use cache/no-store semantics at the worker response layer and React Query settings appropriate for bearer-link revocation.

Create a reusable presentational transcript component around the existing cloud-agent renderer stack:

- Extract message list wrappers from `apps/web/src/components/cloud-agent-next/CloudChatPage.tsx` into a reusable component such as `CloudAgentTranscript` or `MessageList`.
- The component should accept already-resolved messages, render `MessageBubble.tsx`, and keep `MessageErrorBoundary` behavior.
- Continue using `PartRenderer.tsx` and existing tool cards so message/part rendering is not duplicated.
- Keep the component read-only: no transport, input box, live subscription, mutation, or authenticated session state.

Add a public client-side snapshot fetch path:

- Prefer a new session-ingest worker endpoint such as `GET /session/{public_id}/view` that returns a sanitized renderer-ready snapshot for public browser use.
- If raw export exposure is acceptable, the browser can fetch existing `GET /session/{public_id}` directly, but this exposes the raw worker export shape in browser/devtools.
- Direct browser fetch requires CORS support on the session-ingest worker and a public worker URL/config available to the web client.
- Avoid a Next.js proxy if the product goal is no server-side web fetch for shared session history.
- Validate the returned shape in the client and/or worker, and sanitize at the worker boundary before data reaches the browser whenever possible.

### Adapter/reuse seam and SDK discussion

Should the cloud-agent SDK have a different adapter?

Yes, possibly. The existing SDK already has read-only historical concepts:

- `apps/web/src/lib/cloud-agent-sdk/types.ts` has `ResolvedSession` including `read-only`.
- `apps/web/src/lib/cloud-agent-sdk/cli-historical-transport.ts` can replay a `SessionSnapshot` into the same chat processor.

A future SDK seam could be a public snapshot adapter, such as `public-shared-transport` or `SessionSnapshotSource`, that supports both authenticated historical sessions and public shared snapshots. That could unify parsing, replay, and read-only state behavior across authenticated and public pages.

However, the first implementation should not depend on the full `SessionManager` or unchanged `CloudAgentProvider` for `/s/[sessionId]/view`. `CloudAgentProvider.tsx` and `CloudChatPage.tsx` are coupled to authenticated live sessions, and a public page would likely need many stubs for ownership, live transport, mutations, and provider state. That adds risk without much benefit for a static shared transcript.

Recommended split:

- First pass: lightweight `/s/{public_id}` landing page + CTA + client-rendered read-only public viewer + React Query public snapshot fetch + extracted presentational transcript.
- Prefer worker-level sanitization via `GET /session/{public_id}/view`; use existing `GET /session/{public_id}` only if raw export exposure is acceptable.
- Later pass: optional SDK-level `public-shared-transport` or `SessionSnapshotSource` if multiple read-only transcript surfaces need shared replay/state semantics.

## 4. Implementation Phases and Expected File Touches

### Phase 1: Define public viewer snapshot contract

Expected files:

- `services/session-ingest/src/app.ts`
- `services/session-ingest/src/dos/SessionIngestDO.ts`
- Session-ingest CORS/config files if the public worker URL or CORS policy needs changes
- Optional client config file in `apps/web/` if a public session-ingest base URL is not already exposed safely

Work:

- Decide whether browser access to existing `GET /session/{public_id}` is acceptable.
- Prefer adding `GET /session/{public_id}/view` that returns a sanitized renderer-ready snapshot, not the full raw export.
- Add CORS headers for the public viewer origin if the browser fetches session-ingest directly.
- Ensure no credentials are required or sent for public transcript fetches.
- Return 404/403 consistently for missing, invalid, or revoked public IDs.
- Use `Cache-Control: no-store` or another explicit revocation-safe cache policy.

### Phase 2: Extract presentational transcript renderer

Expected files:

- `apps/web/src/components/cloud-agent-next/CloudChatPage.tsx`
- `apps/web/src/components/cloud-agent-next/MessageBubble.tsx`
- `apps/web/src/components/cloud-agent-next/PartRenderer.tsx`
- New or existing component file under `apps/web/src/components/cloud-agent-next/`, such as `CloudAgentTranscript.tsx` or `MessageList.tsx`

Work:

- Extract the message list UI currently local to `CloudChatPage.tsx` into `CloudAgentTranscript` or `MessageList`.
- Keep `MessageBubble.tsx`, `PartRenderer.tsx`, tool cards, and error boundaries as the rendering source of truth.
- Ensure the component accepts `StoredMessage[]` or an intentionally narrower public transcript type that maps cleanly to `StoredMessage`.
- Preserve the current authenticated cloud chat UI behavior by swapping `CloudChatPage.tsx` to use the extracted component.

### Phase 3: Add landing CTA and public viewer route

Expected files:

- `apps/web/src/app/s/[sessionId]/page.tsx`
- New route under `apps/web/src/app/s/[sessionId]/view/`
- New client component under `apps/web/src/app/s/[sessionId]/view/` or shared cloud-agent components
- Optional public fetch helper under `apps/web/src/lib/` if direct `fetch` should be wrapped

Work:

- Keep `/s/[sessionId]/page.tsx` focused on metadata and actions.
- Add a CTA only, such as "View in Cloud Agent", linking to the read-only viewer route.
- In the viewer client component, use React Query to fetch the public snapshot from session-ingest.
- Fetch either existing `GET /session/{public_id}` or preferably new `GET /session/{public_id}/view`.
- Avoid a Next.js proxy or server-side page fetch if the goal is no server-side web fetch.
- Avoid exposing internal identifiers such as `session_id`, `kilo_user_id`, `cloud_agent_session_id`, R2 keys, or raw worker export internals to the client when using a sanitized view endpoint.
- Handle empty histories, failed snapshot fetches, and revoked links with clear viewer states.

### Phase 4: Optional SDK adapter unification

Expected files:

- `apps/web/src/lib/cloud-agent-sdk/cli-historical-transport.ts`
- `apps/web/src/lib/cloud-agent-sdk/types.ts`
- Optional new SDK file such as `apps/web/src/lib/cloud-agent-sdk/public-shared-transport.ts`
- `apps/web/src/components/cloud-agent-next/CloudAgentProvider.tsx`
- `apps/web/src/components/cloud-agent-next/CloudChatPage.tsx`

Work:

- Introduce a `public-shared-transport`, `SessionSnapshotSource`, or similar adapter only if public and authenticated read-only transcript surfaces need common replay semantics.
- Keep this separate from the first public viewer implementation unless product requirements need SDK-level state, replay timing, or richer event processing.
- Do not import/fork public shared sessions into real authenticated cloud-agent sessions as part of the first pass.

## 5. Security, Privacy, and Revocation Considerations

- Treat `public_id` as bearer access. Anyone with the URL can read the shared transcript.
- Do not expose arbitrary `session_id`, `kilo_user_id`, `cloud_agent_session_id`, raw R2 keys, raw event payloads, tokens, callback headers, environment values, or other internal identifiers to the browser.
- Full histories can contain secrets, PII, prompts, model output, and tool output. Product should explicitly decide whether sharing a v2 session means sharing the full transcript, selected parts, redacted content, or a preview-only subset.
- Direct browser fetch means the response is visible in browser devtools. If using existing `GET /session/{public_id}`, raw export exposure must be an explicit product/security choice.
- Prefer sanitizing and redacting at the worker boundary before data reaches client components. A dedicated `GET /session/{public_id}/view` endpoint should return only renderer-ready public fields.
- Public transcript fetches should not include credentials, cookies, auth headers, or user-owned internal session IDs.
- `unshare` clears `cli_sessions_v2.public_id` and should revoke public access. The public viewer and snapshot route must return not found or forbidden once `public_id` is cleared.
- Avoid `revalidate = 86400` or long static caching for v2 shared histories because it can keep revoked content visible. Use dynamic/no-store or a short cache that respects revocation requirements.
- Organization shares are not currently supported publicly. The plan should not infer org-wide access or visibility from the public route.
- Avoid logging public snapshot payloads or headers. If headers need to be stored or inspected, use existing redaction utilities such as `redactSensitiveHeaders` where applicable.

## 6. Open Decisions for Discussion

- Scope of shared content: full transcript, preview-only transcript, user/assistant messages only, or full tool parts including inputs and outputs.
- Public endpoint shape: existing raw `GET /session/{public_id}` or new sanitized `GET /session/{public_id}/view`.
- CORS/config: which public session-ingest URL the browser should call and which origins should be allowed.
- Redaction policy: whether to add automatic filtering for tokens, callback headers, environment values, URLs with credentials, and known secret patterns.
- Metadata display: whether to show owner name, title, timestamps, model/tool metadata, or only transcript content.
- Revocation freshness: whether public viewer responses must be strictly no-store or can tolerate a short CDN/browser cache.
- Error behavior: whether revoked or missing public IDs should be indistinguishable 404s for privacy.
- Renderer compatibility: whether the public transcript component should accept raw `StoredMessage[]` or a narrower `PublicTranscriptMessage[]` adapted at the worker boundary.
- SDK direction: whether to formalize `public-shared-transport` or `SessionSnapshotSource` now, or wait until another read-only transcript surface needs it.

## 7. Verification Plan

- Unit-test the public view adapter/sanitizer with representative `SessionIngestDO.getAllStream()` exports, including unknown parts and missing optional fields.
- Add component tests for the extracted transcript renderer if existing test patterns support React component rendering.
- Add route/page tests or integration coverage for `/s/[public_id]` states: landing page CTA, viewer with messages, viewer with empty history, invalid UUID, missing public ID, and revoked share.
- Verify `unshare` revocation by sharing a session, loading `/s/[public_id]/view`, unsharing it, and confirming the viewer and public snapshot fetch no longer expose history.
- Verify browser direct fetch behavior: CORS succeeds for allowed web origins, credentials are not sent, and disallowed origins are rejected if applicable.
- Run `pnpm typecheck` after implementation, plus targeted tests for changed web and session-ingest code.
- Manually inspect a shared transcript containing text, tool calls, tool results, errors, and large outputs to confirm rendering matches authenticated history and does not expose internal fields.
