# Session continuity E2E catalog

Requirement source: `.specs/cloud-agent-session.md` -- `Persistence` and
`Continuity`. This file maps that contract to the shared lifecycle scenarios in
`scenarios-shared.ts` and its `scenarios-shared-*.ts` modules. The local-only
registry and its bodies were removed; every runnable scenario is a shared
definition dispatched by `run.ts`, so this file is the single inventory.

## The contract in one line

A chat must work like a colleague across a long relationship: many turns, walk
away, come back, interrupt, ask questions, open more chats -- and **any
transient failure must be recoverable by sending another message in the same
chat**. Creating a new chat to continue the same work is a defect, except for a
narrow, documented set of unrecoverable causes.

## What "pass" means

- **Recovery**: after an induced transient failure, the next message on the
  SAME `workspace_*` session completes. No new session, no manual workaround.
- **No permanent wedge**: a chat reaches a terminal, recoverable state; the only
  hard-failed messages are genuinely unrecoverable causes.
- **Continuity**: history/transcript is restored after a cold environment;
  uncommitted files are explicitly not guaranteed (see Data loss below).
- **Isolation**: siblings in one worktree share files but not chat state or
  questions. The runtime serializes streaming model turns, so isolation is
  per-chat control/state, not concurrent streaming.
- **Repeatability**: each scenario is green across N repeats with no unexplained
  flake.

Status legend: `PASS` verified live | `PARTIAL` exists but does not assert the
full contract | `PLANNED` not written | `GAP` no shared scenario covers it.

## Scenario catalog

### A. Single-session continuity (the core promise)

| ID | Scenario (name) | Asserts | Status |
|---|---|---|---|
| A1 | `long-conversation` | One cold turn plus twelve hot turns -- nine `echo:<token>`, one paced `slow`, and a real `file:write`/`file:read` pair whose parsed echo body equals a writer nonce generated independently of the reader-visible path and tag. Every hot turn completes with no re-preparation and a stable allocation reference. | PARTIAL -- does not reach 20+ turns |
| A2 | `leave-and-return` | Boots, leaves the session unattended, requires the allocation to disappear, then resumes on a distinct non-null allocation with the boot marker replayed from a fresh stream. | PARTIAL -- no two-sided history or stable Git HEAD assertion |
| A3 | `warm-cold-cycles` | work -> idle -> resume twice in one session | GAP -- the local-only scenario was removed; `question-idle-resume` covers one idle cycle |
| A4 | `interrupt-then-continue` | Interrupts an actively running paced turn, asserts `cloud.message.failed reason=interrupted`, then completes a follow-up on the same session. | PASS |
| A5 | `recover-same-session` | Induce a transient failure and have the next message on the SAME session complete | PARTIAL -- the shared `external-kill`/`kill-mid-flight`/`wrapper-freeze-*` scenarios prove the user-visible recovery on a distinct allocation, without identity-correlated heartbeat attribution for a generic lapse |
| A6 | `cold` / `hot` | one-turn and warm follow-up chats | PARTIAL -- no repeat/open-close loop |

### B. Multi-chat / worktree

| ID | Scenario (name) | Asserts | Status |
|---|---|---|---|
| B1 | `worktree-chat` | Creates a worktree chat through the public tRPC surface; verifies workspace/worktree identity, idempotent same-key replay, a cold echo boot, and one hot echo turn with stable allocation references. | PASS |
| B2 | `worktree-multi-chat` | Two chats in one worktree with shared worktree identity, chat-content isolation, and a shared-checkout write/overwrite/read proof. | PARTIAL -- does not cover a three-chat chain |
| B3 | `many-siblings` | 3-5 chats interleaved; targeted interrupt/delete | PARTIAL -- `worktree-multi-chat` covers two chats, a lazy sibling create, sequential question ownership (asked in the root while the sibling is idle), targeted interrupt of the sibling while the root holds a paced turn (root nonterminal, allocation-stable, then completing), and targeted delete of the sibling leaving the root accepting another turn. Three-plus siblings stay uncovered. |
| B4 | `concurrent-chats` | Two independent sessions each hold a paced turn with proven overlapping `running`, and both reach a completed terminal (or recover) on their own chat. | PASS |

### C. Interactive tools

| ID | Scenario (name) | Asserts | Status |
|---|---|---|---|
| C1 | `question-isolation` | Ask in the root while the sibling is idle: the question is visible only on the root's stream, the sibling cannot answer it, and a reconnect replays the same id with no new model request. | PASS -- `worktree-multi-chat` |
| C2 | `unanswered-question-idle` | An unanswered question does not pin the environment; idle winds it down; restore then continue. | PARTIAL -- `question-idle-resume` requires `toolResults.question=0`, the allocation to disappear inside the 15-minute idle window, the parked message terminal before the continuation, and a distinct non-null replacement. Sibling isolation is not claimed |
| C3 | `targeted-cancel` | Cancelling a sibling does not disturb the other root. | PASS -- `worktree-multi-chat` targeted interrupt (`reason=interrupted`, root still running, allocation unchanged) and targeted delete (`survivor-completes`) |

### D. Liveness under load

| ID | Scenario (name) | Asserts | Status |
|---|---|---|---|
| D1 | `large-stream` | Stages a real `file:seed` write and asks the model to read it; requires a correlated completed read whose persisted echo meets the 48 KiB floor, plus a paced follow-up. | PARTIAL -- the write tool argument carries the large payload; the measured proof is the read-back echo |
| D2 | `concurrent-chats` | Several sessions each doing turns at once; no wedged session without a completed same-chat follow-up. | PARTIAL -- reports the clean-vs-recovered split; does not prove the exact load that triggers recovery |
| D3 | `long-slow-turn` | One long streamed turn; heartbeat keeps flowing; turn completes | GAP -- `interrupt-mid-stream` covers abort, not sustained length |
| D4 | `stall-injection` | Deterministically stall the wrapper; the worker recovers the SAME session | GAP -- no shared scenario injects a heartbeat lapse with attribution |
| D5 | `feed-stale-recovery` | Silence a shared worktree runtime's `global/event` feed while the wrapper/container stay alive; no feed-stale retirement | GAP -- the local-only scenario is not replaced by a shared one |
| D6 | `wrapper-freeze-settled-reap` | Freeze only the identity-matched control-wrapper process after a completed turn; recovery exhausts without a re-ready runtime and reaps with the settled cause, then a distinct replacement serves the session. | PASS locally -- requires the identity-matched `recovery_settled_reap` `physical_committed running -> stopping` cause/stopCause, a terminal `provider_stop`, the `heartbeat_expired/started` recovery outcome, no `wrapper_ready` after the freeze, and a distinct replacement. Needs `sandboxFaults`, so unsupported deployed |
| D7 | `wrapper-freeze-inflight-reap` | The incident shape: freeze the control-wrapper process while a paced turn is held; the message terminalises `runtime_unhealthy`, the route stays stale-active, recovery reaps with the settled cause, and the SAME session continues on a replacement. | PASS locally -- adds the `runtime_unhealthy` accepted-reconciliation matched to the held message and a still-active heartbeat to the D6 evidence; distinct replacement on the same `workspace_*` session. Needs `sandboxFaults`, so unsupported deployed |

The freeze scenarios must NOT report a stop when the frozen wrapper sends a
`wrapper_ready` frame after the freeze: the readiness veto defers the settled
reap, so a re-readied run is deferred, not terminalised. Both assert no
identity-matched `wrapper_ready` after the freeze before accepting the cause.

`external-kill` and `kill-mid-flight` cover the user-visible outcome: the
affected turn reaches a matching durable terminal and a follow-up on the same
session completes on a distinct non-null allocation reference.

### E. Delivery correctness

| ID | Scenario (name) | Asserts | Status |
|---|---|---|---|
| E1 | `exactly-once-retry` | An ambiguous send retried produces exactly one turn | PLANNED |
| E2 | `send-while-in-flight` | A follow-up while a turn is running is queued and delivered in order | PASS -- `queue-while-busy` |
| E3 | `send-during-recovery` | A send during recovery is queued and delivered, not terminalized | PLANNED |

## Data loss is out of scope (for now)

Uncommitted file changes are not guaranteed across environment replacement
(spec Persistence rule 4). `worktree-multi-chat` proves a sibling reads the
root's uncommitted file within one live worktree; it does not assert survival
across an environment replacement.

## Running

```bash
export E2E_USER_EMAIL=evgeny@kilocode.ai
export WORKER_URL=http://localhost:11294
export FAKE_LLM_URL=http://localhost:11311
pnpm -C services/cloud-agent-next exec tsx test/e2e/run.ts <scenario> _
```

Wrapper source changes need a sandbox image rebuild before they take effect
(restart `cloud-agent-next`; confirm a new `cloudflare-dev/sandbox:*` image).

Run each scenario N times for flake detection. Record the environment (load,
concurrent chats) on the run, and never treat "a fresh run passed" as recovery.

## Registry

Every runnable lifecycle is a shared definition in `scenarios-shared.ts` and its
`scenarios-shared-*.ts` modules. `run.ts` dispatches only `SHARED_SCENARIOS`:
`cold`, `hot`, `cold-hot`, `worktree-chat`, `worktree-multi-chat`,
`long-conversation`, `leave-and-return`, `large-stream`, `concurrent-chats`,
`external-kill`, `kill-mid-flight`, `wrapper-freeze-settled-reap`,
`wrapper-freeze-inflight-reap`, `queue-while-busy`, `queue-rapid-fire-no-gate`,
`queue-overflow`, `queue-interrupt-clears`, `llm-error`, `chunked-streaming`,
`empty-response`, `interrupt-mid-stream`, `interrupt-then-continue`,
`question-idle-resume`, `unknown-model`, `auth-reject`, `callback-completion`,
`callback-batch-followup`, `callback-interrupt`.

Each definition either carries its own `defaultTimeoutMs` (1–30 minutes) or
relies on the scenario function's own default timeout; `run.ts` accepts
`--timeout-ms` for exactly the registry names, and the deployed smoke budget is
derived from the effective per-scenario defaults. All long scenarios require the
unified API, `kilo/fake-deterministic`, and control-plane + worktree enrollment.
