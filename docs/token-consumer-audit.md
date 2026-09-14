# Remaining token-family consumer audit

This audit covers native/mobile, Chat, Wasteland, explicit delegation, and benchmark in the retained PR, their token-bearing requests, and the receiving authentication policies. It combines source tracing with automated route, storage and signed-token tests. It does not certify a physical-device or deployed provider/container smoke run. Cloud Agent transport lifecycle fixes, Gastown, Webhook Agent Ingest, and Security Auto Analysis are owned separately.

## Request coverage

| Producer / credential | Requests checked | Receiver / result |
|---|---|---|
| Native login, legacy exchange, device-code token and refresh | Negotiated API/gateway bundle or legacy response; client parsing, storage, refresh and logout | Native flag unset/false preserves legacy responses, including with shared master on. Non-negotiating clients retain legacy format. No pepper initialization. |
| Native API credential | tRPC profile, balance, organization settings, cloud operations, device sessions, push registration, chat-token and stream-ticket acquisition; organization models/defaults | General API authentication expects `kilo-api`; existing session/organization checks still apply. Legacy tokens remain compatible. |
| Native gateway credential | Personal model catalog, quick-chat completions, voice transcription and transcription-model catalog | Gateway readers expect `kilo-gateway`. Voice and transcription catalog now select the gateway member. Legacy callers retain direct bearer behavior; proactive resource-specific refresh applies to negotiated bundles. |
| Native session viewing | Snapshot/messages through tRPC; one-use Session Ingest web ticket; Cloud Agent stream ticket; presigned attachment uploads | Dedicated tickets authorize streams; the native API token is not forwarded directly as a Session Ingest bearer. Storage uploads use their presigned URL. |
| Chat token | Chat HTTP, Events subscriptions/presence, Notifications badges | Issuer includes all three audiences: `kilo-chat`, `event-service`, `notifications`. Each reader verifies its own audience. Child lifetime is capped by parent expiry and one hour. |
| Explicit personal/organization delegation | Opt-in resource-token routes for API, gateway, attribution and HTML deployment | Exact resource audience, current source authority and organization permissions; maximum 15-minute lifetime. Personal attribution is refused; use the authorized organization route. Disabled delegation returns migration-unavailable. |
| Benchmark | Worker mint request; container warmup/run; CLI API/model discovery and gateway inference | Six-hour modern token includes API and gateway audiences. Automatic Session Ingest is disabled in benchmark processes; benchmark results come from CLI output. Internal mint authentication and eligible account/organization checks remain. |
| Wasteland browser/server control | Browser HTTP/tRPC and server `getWasteland` | `wasteland` reader. DoltHub token acquisition uses an internal secret; DoltHub requests use OAuth credentials, not the Kilo control token. |

Cloud Agent's existing exchange gives its runtime API, gateway and Session Ingest audiences. Its dedicated control-authenticated balance endpoint and null-pepper workflow compatibility fixes are preserved from main. This review does not change the Cloud Agent proxy handle or wrapper process lifecycle.

## Required compatibility checks

Mobile acceptance includes native adoption unset/false while the shared master is on: current login and device polling, legacy response parsing/storage, refresh, resource requests and logout must retain their existing contract. Negotiated bundles additionally need atomic storage, single-flight refresh, account-switch fencing, rollback and correct API/gateway selection. Unsupported clients must not receive bundles merely because a server gate is on.

## Remaining activation requirements

- Native: physical iOS/Android login, cold restore, refresh, voice upload, stream continuity and rollback. Downgrading an already-adopted modern bundle may require sign-in.
- Benchmark: the image installs `@kilocode/cli@latest`; capture the resolved version and verify that the built CLI honors `KILO_DISABLE_SESSION_INGEST` before activation. The local source audit does not identify the deployed binary.
- Chat/Wasteland/delegation/benchmark: exercise the actual receiving deployments and installed client versions before enabling each family. Source-level coverage and mocked tests do not prove the deployed aliases, images or third-party services are aligned.

Existing limitations found during tracing are not presented as regressions fixed here: some ordinary access tokens remain usable until expiry after device-session revocation; Wasteland readers do not provide universal immediate pepper revocation. These require separate ownership and must not be treated as validated rollback paths.

See [deployment settings and rollback](token-issuance-policy.md#remaining-family-deployment-and-activation). The PR description records the exact automated checks run on the final branch; no prior-branch test counts establish validation of a later revision.
