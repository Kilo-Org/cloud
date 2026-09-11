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
| A2 | `cold-resume-history` | auto idle-stop -> resume on a new container -> message history restored -> next turn completes | PARTIAL -- `cold-resume` reaches resume but hard-gates on file bytes before history; see Data loss |
| A3 | `warm-cold-cycles` | work -> idle -> resume -> work -> idle -> resume in one session | PLANNED (existing `cold-hot` covers one warm/cold transition) |
| A4 | `interrupt-then-continue` | interrupt mid-turn; the next message continues the same chat, in the SAME container while the idle timer has not fired | PARTIAL -- `interrupt-mid-stream` interrupts but does not continue afterwards |
| A5 | `recover-same-session` | induce a transient failure (heartbeat lapse / wrapper crash / allocation loss); the next message on the SAME session completes | PLANNED -- highest priority; needs deterministic fault injection |
| A6 | `short-sessions` | one-turn chats opened, completed, and repeated | PARTIAL -- `cold`/`hot` approximate it; no repeat/open-close loop |

### B. Multi-chat / worktree

| ID | Scenario (name) | Asserts | Status |
|---|---|---|---|
| B1 | `new-chat-after-completed` | a chat completes a turn, then a sibling chat is created and works | PASS -- `multi-session-collab`, fixed this cycle |
| B2 | `three-chat-chain` | planner -> implementer -> reviewer artifacts across three chats | PASS -- `multi-session-collab` |
| B3 | `many-siblings` | 3-5 chats interleaved; simultaneous gates; targeted cancel | PARTIAL -- `worktree-shared` covers 2 siblings + simultaneous gates + targeted cancel |
| B4 | `parallel-sessions` | two independent sessions running turns at the same time | PLANNED |

### C. Interactive tools

| ID | Scenario (name) | Asserts | Status |
|---|---|---|---|
| C1 | `question-isolation` | a question is answerable in its own chat only; sibling isolation; replay after refresh | PASS -- `worktree-shared` (`question=isolated; questionRefresh=replayed`) |
| C2 | `unanswered-question-idle` | an unanswered question does not pin the environment; idle winds it down; restore then answer/continue | PLANNED -- needs a question directive that leaves the question open through idle |
| C3 | `targeted-cancel` | cancelling a sibling does not disturb the other root | PASS -- `worktree-shared` `targetedCancellation` |

### D. Liveness under load

| ID | Scenario (name) | Asserts | Status |
|---|---|---|---|
| D1 | `rapid-varied-turns` | back-to-back turns at varied token rates, plus large streamed tool output (bash/file reads) | PARTIAL -- `queue-rapid-fire-no-gate`, `chunked-streaming`, `realistic` exist; no varied tok/s or big tool-output streams |
| D2 | `concurrent-sessions` | several sessions each doing turns at once; no heartbeat expiry, no failed messages | PLANNED |
| D3 | `long-slow-turn` | one long streamed turn; heartbeat keeps flowing; turn completes | PARTIAL -- `interrupt-mid-stream`/`hang` cover abort, not sustained length |
| D4 | `stall-injection` | deterministically stall the wrapper; the worker recovers the SAME session | PLANNED -- needs a fault-injection seam |

### E. Delivery correctness

| ID | Scenario (name) | Asserts | Status |
|---|---|---|---|
| E1 | `exactly-once-retry` | an ambiguous send that is retried produces exactly one turn | PLANNED |
| E2 | `send-while-in-flight` | a follow-up while a turn is running is queued and delivered in order | PASS -- `queue-while-busy` (FIFO through `cloud.message.*`) |
| E3 | `send-during-recovery` | a send during recovery is queued and delivered, not terminalized | PLANNED |

## Data loss is out of scope (for now)

Uncommitted file changes are not guaranteed across environment replacement
(spec Persistence rule 4). `cold-resume` currently hard-gates on file bytes and
therefore fails at that gate; the history assertion is behind it. Near-term
treatment: keep the gate documented, or split `cold-resume-history` to assert
history first and record file survival as an observation only.

## Enablers to build

1. **Fake directives**
   - `big-stream:<bytes>[:chunkBytes]` -- large content stream to stress framing.
   - `tool-stream:<tool>:<bytes>` -- a bash/read tool returning large output.
   - `rate:<chunks>:<ms>` and rate variation around `realistic` for token/sec.
   - `question-open:<tag>:<text>` -- raise a question and leave it unanswered
     (no gate release) so C2 can idle out with the question still pending.
2. **Fault injection (test-only seams)**
   - Stall the wrapper control heartbeat for a bounded window (D4, A5).
   - Force a wrapper process exit / reconnect (A5).
   - Reuse existing `external-kill` / `kill-mid-flight` loss paths, but fix their
     cleanup ownership probe first (it currently throws on restore paths).
3. **Observability (needed to root-cause, not just detect)**
   - Heartbeat: last *sent* (wrapper) vs *received* and *accepted/rearmed*
     (worker), per connection, plus what armed the expiry (`readyAt` vs
     heartbeat). A lapse must be attributable, not guessed.
   - Dispatch: phase, failure category, attempt count, retry decision, and the
     outcome that made the same-session retry succeed.
   - Recovery: which cause triggered it and the recovery resolution.

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
`callback-batch-followup`, `callback-interrupt`, `gate-0`.

Gaps not mapped above: none of the existing scenarios assert **same-session
recovery after an induced failure** (A5) -- that is the new core.
