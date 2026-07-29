# KiloClaw chat attachment uploads 500 locally: R2 media secrets missing (RESOLVED — recheck recipe)

Symptom: picking a file in the kilo-chat composer adds a chip that immediately goes to `failed`
(a11y `Retry upload for <name>`); kilo-chat logs `POST /v1/attachments/init 500` with
`Error: Secret "R2_ACCESS_KEY_ID_KILOCHAT_MEDIA" not found`.

RESOLVED 2026-07-28: the `R2_*_KILOCHAT_MEDIA` pair now exists in the Secrets Store and
`dev:start` provisions it like any source-backed secret; verified end-to-end
(`/v1/attachments/init 200`, chip `ready`, send 201).

If the symptom recurs: first check whether the store lost the pair again, then whether the
worktree's `services/kilo-chat/.wrangler/state` secrets KV is stale — re-run `dev:start`.
Oversized-rejection assertions (pre-read size gate) never needed the secrets and are always
testable.
