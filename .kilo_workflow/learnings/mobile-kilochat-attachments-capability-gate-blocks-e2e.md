# mobile: kilo-chat attachment flows are untestable against a dev:seed fake instance (capability gate)

Symptom: an E2E round that must attach a photo in kilo-chat (file-preview criterion 10,
share-button regression) cannot start: the composer renders no `Attach file` button.

Cause (r1): the button is gated on `botStatus?.capabilities?.includes('attachments')`
(apps/mobile/src/components/kilo-chat/conversation-screen.tsx:72); a fake sandbox never
advertises capabilities.

Cause (r2, NEW — defeats the direct-POST workaround): even an orchestrator-level
HMAC `POST /bot/v1/sandboxes/:id/bot-status` with `{online:true, capabilities:['attachments']}`
does NOT survive the first conversation open. The mobile client polls
`POST /v1/sandboxes/:id/request-bot-status` every ~15s while the conversation screen is
mounted; kilo-chat fans out `deliverChatWebhook` to kiloclaw, which throws
`Instance for <label> has no sandboxId` for every `ki_fake_*` sandbox (the fake-instance
seed writes `sandbox_id` in Postgres but never populates the KILOCLAW_INSTANCE DO record
that `deliverChatWebhook` reads via `stub.getStatus()`). `isDefiniteUnreachable` matches
`has no sandboxId` → kilo-chat publishes `{online:false, at: Date.now()}`
(services/kilo-chat/src/services/bot-status-request.ts), and the monotonic upsert in
SandboxStatusDO (`setWhere: at < excluded.at`) accepts it and NULLs capabilities. Verified
on device r2: seeded row (19:2x) overwritten at first open (21:26), `Bot is offline`
banner, 0 `Attach file`, stable across a reopen; kilo-chat pane shows the offline publish
on every poll tick. The overwrite is structural, not caused by a stack restart — DO state
(`.wrangler/state`) persists across `dev:start`.

Fix: none sanctioned today. The product needs a dev-only capability/status seed that also
survives the request-bot-status escalation (e.g. seed the KILOCLAW_INSTANCE DO so
`deliverChatWebhook` does not throw definitively, or a fake-bot harness answering
`bot.status_request`). Report the criterion unverified with evidence; never the tool-card
viewer as a proxy.

Related (r2 environment incident, corrected by the orchestrator): the seeding phase held an
e2e slot via a `sleep` placeholder tmux session; the placeholder **died mid-run** (cause
unidentified), the slot reaper reclaimed the slot for a foreign workflow, and the
now-uncovered dev stack was later stopped while the verifier's next round was queued.
Recovery: the r2 verifier re-ran one sanctioned `pnpm dev:start --no-attach mobile
cloud-agent-next kiloclaw event-service` after acquiring its own slot — ports are
deterministic per worktree, and miniflare DO state persisted. Orchestrators: keep the
placeholder slot until ALL rounds finish, and treat a slot-owning placeholder as a monitored
dispatch — its silent death cascades to the stack it covers.
