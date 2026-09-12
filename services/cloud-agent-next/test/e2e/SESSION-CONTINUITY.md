# Session continuity E2E catalog

Requirement source: `.specs/cloud-agent-session.md` -- `Persistence` and
`Continuity`. This file maps that contract to concrete, reusable lifecycle
scenarios. It is the working plan for the harness; update the status column as
scenarios land.

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
  questions.
- **Repeatability**: each scenario is green across N repeats with no unexplained
  flake.

Status legend: `PASS` verified live | `PARTIAL` exists but does not assert the
full contract | `PLANNED` not written | `BLOCKED` needs an enabler.

## Scenario catalog

### A. Single-session continuity (the core promise)

| ID | Scenario (name) | Asserts | Status |
|---|---|---|---|
| A1 | `long-session-20` | 20+ turns, real writes/reads/edits, one sandbox the whole time | PARTIAL -- `long-session` does 11 turns and asserts checkpoint identity; extend the count |
| A2 | `cold-resume-history` | auto idle-stop -> resume on a new container -> message history restored -> next turn completes | PARTIAL -- `cold-resume` asserts history first and a stable Git HEAD; dirty-file survival is observed only (not guaranteed across environment replacement) |
| A3 | `warm-cold-cycles` | work -> idle -> resume -> work -> idle -> resume in one session | PARTIAL -- `warm-cold-cycles` runs two full cycles with independent idle-stop evidence, old-primary absence, distinct replacement container, history, and a completed ordered-lifecycle follow-up; each cycle records its resumed message id and dirty-file survival (non-gating), and completed cycles are retained even if a later cycle fails |
| A4 | `interrupt-then-continue` | interrupt mid-turn; the next message continues the same chat, in the SAME container while the idle timer has not fired | PASS -- `interrupt-then-continue` asserts `cloud.message.failed reason=interrupted`, a completed follow-up, and an unchanged container id |
| A5 | `recover-same-session` | induce a transient failure (heartbeat lapse / wrapper crash / allocation loss); the next message on the SAME session completes | PARTIAL -- `recover-same-session` captures the target connection by `sandboxId` + connection/wrapper identity, requires a matched `deadline_fired deadlineId=heartbeatExpiry` followed by a matched `recovery_outcome cause=heartbeat_expired outcome=started` before any recovery send, and completes a new ordered-lifecycle message on the original session. Proven: heartbeat-expiry attribution for the captured connection. Not proven: disconnect-classified runs are generic same-session recovery, not heartbeat coverage; and the wrapper pre-pause last-send line is captured but not used for classification |
| A6 | `short-sessions` | one-turn chats opened, completed, and repeated | PARTIAL -- `cold`/`hot` approximate it; no repeat/open-close loop |

### B. Multi-chat / worktree

| ID | Scenario (name) | Asserts | Status |
|---|---|---|---|
| B1 | `new-chat-after-completed` | a chat completes a turn, then a sibling chat is created and works | PASS -- `multi-session-collab`, fixed this cycle |
| B2 | `three-chat-chain` | planner -> implementer -> reviewer artifacts across three chats | PASS -- `multi-session-collab` |
| B3 | `many-siblings` | 3-5 chats interleaved; simultaneous gates; targeted cancel | PARTIAL -- `worktree-shared` covers 2 siblings + simultaneous gates + targeted cancel |
| B4 | `parallel-sessions` | two independent sessions running turns at the same time | PASS -- `concurrent-chats` runs three independent sessions behind simultaneous gates, proves overlapping `running`, and splits clean-load vs recovered-under-load |

### C. Interactive tools

| ID | Scenario (name) | Asserts | Status |
|---|---|---|---|
| C1 | `question-isolation` | a question is answerable in its own chat only; sibling isolation; replay after refresh | PASS -- `worktree-shared` (`question=isolated; questionRefresh=replayed`) |
| C2 | `unanswered-question-idle` | an unanswered question does not pin the environment; idle winds it down; restore then answer/continue | PARTIAL -- `question-idle-resume` requires a positive `inspectControlPlaneQuestions` observation scoped to the captured question while the primary is inspectable (inspection failure is INCONCLUSIVE), the parked turn to settle terminal (`failed`/`interrupted`) before continuing (the exact-match target heartbeat payload `reportedState`/allocation-wide `pendingMessages` plus payload-derived `sessionState`/`sessionWaitingOn` is the input-wait proof and may be absent once terminal), idle-stop within budget, and continued work on a replacement container. Sibling isolation is not claimed |
| C3 | `targeted-cancel` | cancelling a sibling does not disturb the other root | PASS -- `worktree-shared` `targetedCancellation` |

### D. Liveness under load

| ID | Scenario (name) | Asserts | Status |
|---|---|---|---|
| D1 | `rapid-varied-turns` | back-to-back turns at varied token rates, plus large streamed tool output (bash/file reads) | PARTIAL -- `large-stream` requests a 256 KiB real read-tool output plus a paced follow-up; coverage is claimed only for the exact `call_<tag>_read` completed read whose streamed part is correlated AND whose persisted output meets the request, otherwise `requestedBytes`/`observedBytes`/`writtenFileBytes` are recorded and coverage is not claimed |
| D2 | `concurrent-sessions` | several sessions each doing turns at once; no heartbeat expiry, no failed messages | PARTIAL -- `concurrent-chats` classifies each of three sessions `completed_clean`/`completed_after_recovery`/`wedged`/`failed` from matched `recovery_outcome` evidence, sends a same-chat follow-up where the turn did not complete, and reports the clean-vs-recovered split. Proven: no session wedges or fails without a completed same-chat follow-up. Not proven: the exact load level that triggers recovery, or a clean run with zero expiries every time |
| D3 | `long-slow-turn` | one long streamed turn; heartbeat keeps flowing; turn completes | PARTIAL -- `interrupt-mid-stream`/`hang` cover abort, not sustained length |
| D4 | `stall-injection` | deterministically stall the wrapper; the worker recovers the SAME session | PARTIAL -- `recover-same-session` freezes the owned primary with `docker pause` and requires the identity-matched heartbeat-expiry recovery chain; a generic `control_disconnected` outcome proves same-session recovery, not heartbeat-lapse coverage |

### E. Delivery correctness

| ID | Scenario (name) | Asserts | Status |
|---|---|---|---|
| E1 | `exactly-once-retry` | an ambiguous send that is retried produces exactly one turn | PLANNED |
| E2 | `send-while-in-flight` | a follow-up while a turn is running is queued and delivered in order | PASS -- `queue-while-busy` (FIFO through `cloud.message.*`) |
| E3 | `send-during-recovery` | a send during recovery is queued and delivered, not terminalized | PLANNED |

## Data loss is out of scope (for now)

Uncommitted file changes are not guaranteed across environment replacement
(spec Persistence rule 4). `cold-resume` asserts message history and a stable
Git HEAD first, and records dirty-file survival as a non-gating observation
(`fileSurvived=true|false (observed, exact-equality)`, or
`fileSurvived=error:<reason>` when the inspection itself fails). It no longer
fails the scenario when the sentinel is missing.

## Enablers to build

1. **Fake directives**
   - `big-stream:<bytes>[:chunkBytes]` -- large content stream to stress framing.
   - `tool-stream:<tag>:<bytes>` -- landed; writes `bytes` with the real write
     tool, reads it back with the real read tool, then completes. `large-stream`
     uses it.
   - `rate:<chunks>:<ms>` and rate variation around `realistic` for token/sec.
   - `question:<tag>:<text>` -- landed; raises a real Kilo question that stays
     open until answered. The parked turn settles either by the fenced
     five-minute inactivity abort or by idle shutdown, so C2 proves the
     question does not pin the environment.
2. **Fault injection (test-only seams)**
   - `pauseOwnedPrimary`/`unpauseOwnedPrimary` (chunk 2) freeze and unfreeze the
     exact owned primary; `recover-same-session` uses this to lapse heartbeats.
   - Force a wrapper process exit / reconnect (A5) -- still uses existing kill paths.
   - Reuse existing `external-kill` / `kill-mid-flight` loss paths, but fix their
     cleanup ownership probe first (it currently throws on restore paths).
3. **Observability (needed to root-cause, not just detect)**
   - Heartbeat: last *sent* (wrapper) vs *received* and *accepted/rearmed*
     (worker), per connection, plus what armed the expiry (`readyAt` vs
     heartbeat). A lapse must be attributable, not guessed.
   - Dispatch: phase, failure category, attempt count, retry decision, and the
     outcome that made the same-session retry succeed.
   - Recovery: which cause triggered it and the recovery resolution. The worker
     emits a synchronous `recovery_outcome` diagnostic (`cause`,
     `outcome: started|skipped`, connection/wrapper/sandbox/allocation ids,
     `deadlineId`, `committedAt`). `recover-same-session` requires a matched
     `deadline_fired deadlineId=heartbeatExpiry` followed by a matched
     `recovery_outcome cause=heartbeat_expired outcome=started`; a
     `control_disconnected` started outcome is generic same-session recovery,
     and `skipped`/missing/ambiguous ordering is INCONCLUSIVE. Timestamp-only
     correlation is not accepted.
   - Heartbeat per-session evidence: the worker heartbeat diagnostic emits a
     bounded `.`-joined `sessionReport` plus, when the DO has exactly one route,
     exact `kiloSessionId`/`sessionState`/`sessionWaitingOn` fields.
     `question-idle-resume` reads only an exact target `kiloSessionId` match on
     the captured connection; missing target evidence is INCONCLUSIVE.

## Running

```bash
export E2E_USER_EMAIL=evgeny@kilocode.ai
export WORKER_URL=http://localhost:8894
export FAKE_LLM_URL=http://localhost:8911
export KILO_SESSION_INGEST_URL=http://localhost:8900
pnpm -C services/cloud-agent-next exec tsx test/e2e/run.ts <scenario> _
```

Wrapper source changes need a sandbox image rebuild before they take effect
(restart `cloud-agent-next`; confirm a new `cloudflare-dev/sandbox:*` image).

Run each scenario N times for flake detection. Record the environment (load,
concurrent chats) on the run, and never treat "a fresh run passed" as recovery.

## Existing scenario inventory (for reuse)

`run.ts` lifecycle names today: `cold`, `hot`, `followup`, `cold-hot`,
`worktree-shared`, `long-session`, `cold-resume`, `multi-session-collab`,
`external-kill`, `kill-mid-flight`, `queue-while-busy`,
`queue-rapid-fire-no-gate`, `queue-overflow`, `queue-interrupt-clears`,
`llm-error`, `chunked-streaming`, `empty-response`, `interrupt-mid-stream`,
`unknown-model`, `waiters-clean`, `callback-completion`,
`callback-batch-followup`, `callback-interrupt`, `gate-0`, plus the continuity
scenarios: `recover-same-session`, `interrupt-then-continue`,
`warm-cold-cycles`, `question-idle-resume`, `large-stream`, `concurrent-chats`.

Continuity scenario default timeouts (`CONTINUITY_SCENARIO_TIMEOUT_MS` in
`lifecycle-continuity.ts`): 8, 6, 25, 20, 10, and 15 minutes in the order above.
All six require the unified API, `kilo/fake-deterministic`, and control-plane +
worktree enrollment, like the file-state scenarios.

Status gaps: the six continuity scenarios exercise the same-session recovery core
(A3/A4/A5/C2/D1/D2/D4), but A5/D4 remain PARTIAL: a run attributed to
`heartbeat_expiry` proves heartbeat-lapse recovery for the captured connection,
while a `control_disconnected` run proves only generic same-session recovery.
A3/A4/A5/C2/D1/D2/D4 are not a live pass claim until the scenario is run and
observed green; that result is recorded per run, not asserted here. Remaining
gaps are E1/E3 and repeat/flake counts.
