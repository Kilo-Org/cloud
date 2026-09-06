# Control-plane pre-admission retry

Incident: `msg_072ebd578000Qo08FEoXwClq51` on `workspace_d9f76f49-…` (2026-09-05). A follow-up user message attached against a dying runtime, got retryable `not_ready` before `session.prompt`, then `failWaitingMessages` marked it `failed` with `kilo_unhealthy`. The next explicit message worked on a replacement runtime.

This plan is only that gap. Do not replay accepted or prompted work.

## Current behaviour

1. Queue binds the head message to the current wrapper and calls `session.attach`.
2. Retryable `not_ready` before prompt leaves the message `queued` and arms a short retry (`recordDeliveryFailure` → `armQueueRetry`).
3. Runtime quarantine then calls `failWaitingMessages` for every queued/accepted message bound to that wrapper.
4. The retry never runs. The user sees a failed turn. A later send creates new demand and recovers the chat.

Attach in this incident did start a wrapper preparation task and reached `workspace_prepare`, but it did not commit attachment and did not prompt. Blind replay of an **accepted** attach/prompt is still unsafe.

## Minimal fix

When a runtime is quarantined, **keep** a message that is still `queued` and has **no successful attach and no prompt**, and **unbind** it from the dying wrapper so the replacement can attach it.

Leave `failWaitingMessages` unchanged for:

- `accepted` messages
- queued messages with a successful attach proof (`operations.attach` committed / `attached: true`)
- queued messages whose last attach was non-retryable or exhausted (`ATTACH_FAILURE_LIMIT`)

Concrete shape:

- Add a narrow helper next to `failWaitingMessages`, for example `releaseUnadmittedWaitingMessages`, or a flag on the existing helper.
- Input: current messages + dying `wrapperInstanceId`.
- For each matching unadmitted queued message: clear `wrapperInstanceId`, keep `state: 'queued'`, keep the existing `attachFailures` count.
- Quarantine path in `SandboxSession` uses this for the dying wrapper, then still fails accepted / attach-committed work as today.
- After unbind, the existing replacement admission / queue drain must pick the message up. Do not add a second retry protocol.

Do not invent a new receipt type. If an attach operation authorization exists for that message on the dying wrapper, drop or ignore it the same way a failed attach already does; do not carry it onto the replacement.

## Tests

Add one focused queue test before changing production behaviour:

1. Message `queued`, bound to wrapper A, last dispatch retryable `not_ready` at attach, never accepted.
2. `failWaitingMessages` / quarantine for wrapper A.
3. Message remains `queued`, `wrapperInstanceId` is unset, `failedIds` does not include it.
4. A sibling `accepted` message on wrapper A still fails.
5. Drain against wrapper B attaches and can complete.

Keep the external-kill E2E contract for **accepted** post-kill work (`failed` or `completed`). Tighten it only if this unit path is proven: the racing **unadmitted** message must complete on the replacement, not fail.

## Out of scope

- Replaying `session.prompt` or any attach that returned `attached: true`
- Changing feed-loss or credential-refresh retirement
- Uploading sandbox file logs (separate follow-up)
- Wrapper heartbeat diagnostic mapping (already landed)

## Relevant code

- `services/cloud-agent-next/src/sandbox-session/session-message-queue.ts` (`failWaitingMessages`, `incrementDeliveryFailure`, `ATTACH_FAILURE_LIMIT`)
- `services/cloud-agent-next/src/sandbox-session/SandboxSession.ts` (`recordDeliveryFailure`, quarantine / `failWaitingMessages`)
- `services/cloud-agent-next/src/sandbox-session/recovery/warm-death-fails-waiting-queue.test.ts`
- `services/cloud-agent-next/test/e2e/lifecycle.ts` (external-kill allows failed-or-completed on the affected turn)
