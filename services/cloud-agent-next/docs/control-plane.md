# Cloud Agent control plane (`workspace_*` sessions)

This is the single design and acceptance spec for the `workspace_*` control plane: the Session DO
(`SandboxSession`), the Sandbox DO (`SandboxControl`), the in-container supervisor and the control
wrapper. Product rules stay in `.specs/cloud-agent-session.md`. The legacy `agent_*` plane
(`CloudAgentSession`, legacy wrapper `wrapper/src/main.ts`) is out of scope.

## 1. Principles

1. **Cloud Agent is infrastructure around Kilo.** It keeps a sandbox and Kilo running, passes
   messages from the user to Kilo, passes events and turn outcomes back, and stops idle sandboxes.
   Agent behavior belongs to Kilo.
2. **Best effort in a forgiving environment.** Every wait is bounded. There is no exactly-once
   delivery; a rare duplicate or lost prompt is accepted. A new message or Stop always starts
   recovery, so a session is never stuck.
3. **One owner per decision and per timer.** The component that runs a step owns its timeout and
   retries. A requester keeps at most one backstop timer and never guesses the result of work that
   another component owns.
4. **Short calls and notifications.** No RPC stays open while a long step runs. Long steps end with
   a notification.
5. **One state value per entity.** Each message, route and allocation has exactly one state from a
   small closed set. No side flags, proofs or counters that together encode a state.
6. **No backward compatibility.** Sessions created before the rewrite are not supported. There is
   no data migration and no support for older wrapper versions. A Durable Object instance that
   still holds old-plane storage is wiped on first access; the Sandbox DO first stops the old
   allocation so no old container keeps running.
7. **Public surfaces stay stable.** The tRPC API, the `/stream` event schema
   (`src/shared/protocol.ts`), reports and callbacks keep their current shapes.

## 2. Components

| Component | Owns | Does not own |
|---|---|---|
| Worker | Authentication, organization and worktree access, billing eligibility on send, tRPC, `/stream` and terminal WebSocket upgrade | Message, route or sandbox state |
| Session DO, one per session | Message queue and message states, route view, event log and client stream, question/permission projection, per-message reports and batch callback | Sandbox lifecycle, preparation steps, Kilo health, turn outcome |
| Sandbox DO, one per `sandboxId` | Allocation lifecycle through the provider adapter, wrapper socket, per-session routes, forwarding in both directions, activity, idle stop and provider lease, billing admission and attribution, wrapper and session credentials | Message states, Kilo health, turn outcome, workspace steps, physical billing intervals (container lifecycle owns them) |
| Supervisor, inside the container | Restart a crashed wrapper, bounded | Anything else |
| Wrapper, one per sandbox | Connection to the Sandbox DO, route preparation (clone, checkout, setup commands, Kilo runtime, Kilo session), Kilo supervision and restart, prompt submission, event streaming, turn outcome, finalization (auto-commit, condense), activity heartbeat, terminals, worktree changes | Sandbox lifecycle, message states |
| Kilo | Agent execution, provider retries, native history published to session-ingest | Infrastructure |

## 3. Topology and identities

- One Session DO per `sessionId` (`workspace_*`). One Sandbox DO per `sandboxId`. A shared sandbox
  (`usr-`, `org-`, `bot-`, `ubt-`) hosts many sessions and worktrees; an isolated sandbox hosts one.
- A **route** is one session on one sandbox: `sessionId`, worktree directory, `kiloSessionId`.
  Sessions in one worktree share the checkout. A Kilo runtime serves one directory, or one session
  when runtime isolation is per session.
- `messageId` is the permanent message identity. The wrapper passes it to Kilo as the user message
  ID.
- `allocationId` identifies one physical allocation. `wrapperId` is random per wrapper process. A new
  `wrapperId` on the same allocation means the wrapper restarted and its Kilo state is gone.

## 4. Normal flow

1. The user sends a message. The Worker checks access and billing, then calls the Session DO.
2. The Session DO stores the message as `queued`.
3. If the route is `ready`, go to step 7. Otherwise the Session DO calls `prepare` on the Sandbox DO.
   `prepare` is idempotent and returns at once.
4. The Sandbox DO makes sure an allocation is `connected`: create the sandbox, launch the
   supervisor and wrapper, wait for the wrapper to connect.
5. The Sandbox DO sends `session.prepare` to the wrapper. The wrapper runs the workspace steps and
   reports progress, then `session.ready` or `session.failed`.
6. The Sandbox DO notifies the Session DO: progress, `ready` or `failed`. On `failed` the Session DO
   fails its queued messages.
7. On `ready` the Session DO calls `deliver` with all queued messages in order. The Sandbox DO
   writes them to the wrapper socket and returns `sent`, or `not_ready` if it cannot write. The
   Session DO marks sent messages `accepted` and keeps the others `queued`.
8. The wrapper submits each prompt to Kilo at once, also while a turn runs. Kilo events stream back
   through the Sandbox DO to the Session DO and the client.
9. When the turn ends, the wrapper sends one outcome. The Session DO applies it to the accepted
   messages.

## 5. Session DO

### Message state

`queued` → `accepted` → `completed` | `failed` | `cancelled`. A terminal state is final.

A message stores `messageId`, its immutable intent (turn, agent, model, attachments,
finalization), `state`, `createdAt`, `acceptedAt`, `settledAt` and a failure `reason` when
terminal. Nothing else.

| Event | Effect |
|---|---|
| Send | Append `queued`. Route `ready`: deliver. Otherwise: `prepare`, and act on the view it returns. |
| Route ready | Deliver all `queued` in order. |
| Deliver returns `sent` | Those messages become `accepted`. |
| Deliver returns `not_ready` | Keep `queued`; call `prepare` and act on the view it returns. |
| Route progress | Show the preparation step. No message change. |
| Route reconnecting | Store the view. No message change and no client-visible change. |
| Route failed (reason) | All `queued` and `accepted` → `failed` with the reason. |
| Route lost (reason) | All `accepted` → `failed` with the reason. `queued` stay; if any, call `prepare`. |
| Outcome (status, reason, `lastMessageId`) | Every `accepted` message up to and including `lastMessageId` takes the status. If `lastMessageId` is unknown, every `accepted` message does. |
| Stop | All `queued` and `accepted` → `cancelled`; send `abort` (best effort). |
| Cancel one queued message | That message → `cancelled`. |
| Backstop alarm | `queued` older than 20 minutes → `failed` (`preparation_timeout`). `accepted` older than 65 minutes → `failed` (`no_outcome`). |

Stop still forwards a best-effort abort to an existing ready Kilo route when no
message is queued or accepted and the wrapper has no active turn. It does not
rewrite terminal message outcomes or prepare/wake a stopped sandbox.

Late outcomes and notifications for terminal messages are ignored. The backstop exists only for
lost notifications; the Sandbox DO and the wrapper settle every normal case earlier. Both values
are derived from the owners' timers so the backstop never ends work that its owner still runs:
queued = reconnect window (5 min) + one preparation attempt (12 min) + 3 min, which covers the
longest normal wait (a message sent while the socket is down, then a fresh attempt on a new
sandbox); accepted = turn hard cap (60 min) + 5 min. After every message change the Session DO sets
the alarm to the earliest backstop deadline of the open messages, and clears it when no message is
`queued` or `accepted` (for example after Stop).

### Route view

`unknown` | `preparing(step)` | `ready` | `reconnecting` | `failed(reason)`. It is the last view
from the Sandbox DO, from a notification or from the return value of `prepare`. It decides between
`prepare` and `deliver`, and drives the preparation rows and `cloud.status` (section 10). The
public stream has no reconnecting status today, so `reconnecting` changes no client-visible state.

### Events, questions and callbacks

- Wrapper events are appended to the event log and broadcast on `/stream` with the current schema.
  The Session DO emits `cloud.message.*` events on message changes and `preparing` events from route
  progress.
- Pending questions and permissions are projected from events. Answers go to the wrapper through the
  Sandbox DO. If the turn already settled, for example because the sandbox stopped, the answer is
  sent as a new message.
- Each terminal message produces one report. The batch callback fires when no `queued` or
  `accepted` message remains (current callback semantics).

## 6. Sandbox DO

### Allocation state

| State | Leaves to | On | Timer |
|---|---|---|---|
| `stopped` | `creating` | `prepare` for a session | — |
| `creating` | `starting` | Provider created the sandbox and launched the supervisor | Provider call 2 min |
| `creating` | `creating` or `stopped` | Create error: retry after a 10 s pause while a route deadline remains, else stop | — |
| `starting` | `connected` | Wrapper `hello` accepted | 5 min without `hello` → `stopping` |
| `connected` | `disconnected` | Socket closed, or no heartbeat for 45 s | — |
| `connected` | `stopping` | No activity for 10 min, or explicit stop or delete | Idle 10 min |
| `disconnected` | `connected` | Wrapper `hello`, same or new `wrapperId` | — |
| `disconnected` | `stopping` | No activity for 10 min, or 5 min after the last heartbeat, or explicit stop or delete | Idle 10 min, or reconnect 5 min, whichever is earlier |
| `stopping` | `stopped` | Provider confirms stop, or the existing stop ladder ends | Existing ladder |
| any | `stopped` | Provider reports the sandbox gone | — |

- A `hello` from a stale `allocationId`, an older protocol version or a bad credential gets
  `shutdown`. The wrapper exits with code 0 and the supervisor does not restart it.
- A `prepare` during `stopping` stores the route as `preparing` and returns its view at once. The
  Sandbox DO starts `creating` after `stopped`.
- On `stopping` or `stopped`, every `ready` route is removed and its session gets `route lost`. A
  session with queued messages calls `prepare` again, which creates a new allocation.
- A `preparing` route stays across a failed allocation (create error, connect timeout, sandbox gone)
  while its attempt deadline remains; the Sandbox DO creates a new allocation for it. At the
  deadline the route fails.
- `stopped` is a routing state. When the stop ladder ends without provider confirmation, the stop is
  logged as unconfirmed and a later `prepare` may create again. Billing and worktree deletion do not
  read `stopped` as proof of physical stop (see below).

### Route state (per session)

`preparing` → `ready` → `failed`. Each preparation attempt has a 12-minute deadline. An attempt
starts when a route enters `preparing`: the first `prepare`, a `prepare` after `failed`, or a
re-prepare after a wrapper restart. A repeated `prepare`, a reconnect or a new allocation inside the
attempt keeps its deadline.

`prepare` returns the route view that the Sandbox DO would notify: `ready` only when the route is
ready and the wrapper is connected, `reconnecting` when the route is ready but the socket is down,
otherwise `preparing` or `failed`. The Session DO acts on this return value exactly as on a
notification, so a lost notification never leaves it waiting.

| Event | Effect |
|---|---|
| `prepare`, no route | Add route `preparing`; send `session.prepare` once connected. |
| `prepare`, route `failed` | New attempt with a new deadline. |
| `prepare`, route `preparing` or `ready` | No change; return the current view. |
| Wrapper progress | Forward to the session. |
| Wrapper `session.ready` | `ready`; notify. |
| Wrapper `session.failed` (while preparing, or later when Kilo is unavailable) | `failed`; notify. |
| Deadline while `preparing` | `failed` (`preparation_timeout`); notify. |
| Socket lost | Notify `reconnecting`. Route state unchanged. |
| `hello`, same `wrapperId` | Notify `ready` again for ready routes; send `session.prepare` again for preparing routes. |
| `hello`, new `wrapperId` | Ready routes → `preparing`; notify `route lost` (`agent_restarted`); send `session.prepare` again. |
| `release` (session deleted) | Remove the route; send `session.release`. |

### Forwarding

- `deliver`: if `connected` and the route is `ready`, write one `session.prompt` frame per message and
  return `sent`; otherwise return `not_ready`. A frame counts as sent when the socket write succeeds.
- `abort` and answers: write if connected, else drop and return `not_connected`.
- Wrapper frames for a session (events, outcome, route progress/ready/failed) are sent to that
  Session DO with a short bounded retry, then dropped.
- Terminals keep the current topology: the Sandbox DO forwards only the terminal connect request;
  the browser and wrapper terminal sockets are bridged by the Session DO (`terminal-bridge.ts`).

### Activity, idle stop and provider lease

The wrapper heartbeat (every 15 s) carries `active`. The sandbox is active while a route prepares,
a Kilo session is busy or finalizing and not waiting for the user, a terminal has input, or a message
was delivered in the last minute. After 10 minutes without activity the Sandbox DO stops the
sandbox. Waiting on a question or permission is not activity. While the sandbox is active, the
Sandbox DO renews the provider lease (`ensureLeaseAtLeast`) so the provider does not expire a busy
sandbox on its own.

### Billing, credentials and deletion

These keep their current owners and evidence; the rewrite ports them, it does not redesign them.

- Compute billing follows the physical container lifecycle (`metered-billing-lifecycle.ts`), not
  the routing state.
- The Sandbox DO mints the wrapper launch credential and the per-session Git and Kilo credential
  grant it adds to `session.prepare`. It serves contained outbound credential lookups
  (`resolveCredential`), runtime proxy authorization and Vercel network policy as today. Grants
  last 4 hours. When less than 1 hour remains, `deliver` re-issues the grant with freshly selected
  Git and Kilo tokens and sends them in a `session.credentials` frame before the prompts; the
  wrapper installs them into the running route and Kilo runtime (the current runtime credential
  refresh). A long warm route therefore never runs on expired credentials.
- Worktree deletion reports an incomplete, retryable result when the provider has not confirmed the
  stop or cleanup (Shared Worktrees rule 13).

## 7. Wrapper

### Connection

- Connect, send `hello` (`wrapperId`, `allocationId`, protocol version), wait for `welcome` or
  `shutdown`. On `shutdown`, exit with code 0.
- Reconnect forever with backoff from 1 s to 30 s plus jitter. Never exit because the connection
  failed. SIGUSR1 closes and reopens the connection (existing test hook).
- While disconnected, keep outbound frames in one bounded buffer (for example 1,000 frames or 8 MB).
  Keep outcome and route frames; drop the oldest event frames first and send one `events_dropped`
  marker.

### Preparation (`session.prepare`, idempotent per session)

The wrapper owns the step timeouts and retries:

| Step | Bound | Retry |
|---|---|---|
| Clone or fetch | 6 min total | Network errors: 3 attempts with backoff |
| Checkout, branch restore | In the clone budget | No |
| Setup commands | Current per-command limits | No; a failure fails preparation |
| Kilo runtime start | 2 min | 1 retry |
| Kilo session: use the one Kilo has on disk; if missing (new sandbox), restore from the snapshot; else create | 2 min | 1 retry |

Each step sends progress. A route already prepared in this process (checkout present, Kilo session
open) returns `session.ready` at once. A `session.prepare` for a failed route starts fresh,
including a new Kilo restart budget.

### Prompts and turn outcome

- `session.prompt` is submitted to Kilo with `messageID` = `messageId`, in arrival order, also while
  a turn runs. A prompt turn uses `prompt_async` after attachments are materialized. `/compact`
  calls Kilo session summarization. Other command turns use Kilo's command endpoint. While Kilo
  restarts, prompts wait in a per-session inbox. The wrapper publishes Kilo's command catalog as
  `commands.available`.
- The wrapper tracks each Kilo root session through Kilo's status, idle, turn-close and error events,
  and remembers the last submitted `messageId`.
- Outcome frame: `sessionId`, `status`, optional `reason`, `lastMessageId`.
  - `completed`: Kilo emitted `session.turn.close` with reason `completed`, finalization is done,
    and no later prompt remains unfinished. `session.idle` and a `superseded` turn-close are not
    completion signals. The wrapper does not keep a copy of Kilo's native prompt queue.
  - `failed`: Kilo reports a final error; 7 minutes without real progress; the 60-minute hard cap;
    Kilo restarted during the turn after real progress, or a second time; prompt submission failed.
    For no progress and the cap, the wrapper aborts the Kilo session first. Real progress is text, reasoning or tool events from that
    session; busy, retry and heartbeat events are not, and waiting on the user pauses the clock.
  - `cancelled`: the turn was aborted.
- Finalization (auto-commit, condense) runs after Kilo's completed turn-close. The wrapper sends a `finalizing`
  event when it starts. Its failures are warning events; the outcome stays `completed`. A prompt that arrives during finalization goes to Kilo at once, and the
  wrapper does not send `completed` for that earlier close. Each finalization step has one timeout that
  covers the whole step. A finalization timeout or failure never aborts the Kilo session, so it
  cannot cancel a newer prompt.

### Kilo supervision

- SSE silence for 30 s: send one health request (`GET /global/health`, 5 s timeout). No answer:
  Kilo is hung; restart it at once. An answer: reconnect the event stream; after 6 reconnects in 2
  minutes, restart Kilo. A reconnected stream gets 12 s to deliver a real event, because Kilo's
  first heartbeat comes 10 s after connect; a stream that stays silent is replaced at the next
  check, 15 s after the reconnect. Kilo sends heartbeats every 10–15 s, so silence means a real
  fault. Local runs on Kilo 7.6.2 and 7.8.1 show an intermittent hang after a prompt is accepted:
  Kilo stops emitting, never calls the model and does not answer HTTP.
- Kilo process exit: restart Kilo.
- From the detected silence until Kilo is back, new prompts wait in the per-session inbox.
- Restart: kill the Kilo process group and start Kilo. Kilo continues its sessions from its own
  storage on disk. Routes stay `ready`.
- Busy turns on a restarted runtime: a turn with no real progress since it started is submitted
  again, once. Its prompts go back to the front of the inbox in order, with the same `messageID`s
  (Kilo stores messages by ID). No real progress means no tool events, so no tool work repeats. A
  turn with real progress, or one already submitted again, gets `failed` (`agent_restarted`).
- Budget: 3 restarts in 10 minutes per runtime. After that, routes on it report `failed`
  (`agent_unavailable`).
- Degraded state (event stream reconnecting, Kilo restarting) goes in the heartbeat. The Sandbox DO
  forwards it to sessions as information only.

### Crash resistance

- The wrapper does not exit on disconnect, reconnect failure, Kilo failure or unhandled promise
  rejection; it logs them. It exits only on `shutdown`, SIGTERM or an uncaught exception.
- Each Kilo spawn writes a pidfile with PID and process start time. At startup the wrapper kills the
  process groups of stale pidfiles whose PID and start time still match, before it starts Kilo.

### Supervisor

The provider launch command starts a small supervisor loop that runs the wrapper. After a non-zero
exit it restarts the wrapper with 1 s to 30 s backoff, at most 5 times in 10 minutes. Exit code 0
ends the loop. If the loop gives up, the Sandbox DO `starting` or `disconnected` timer stops the
sandbox.

## 8. Timers

Each timer has one owner. All values live in one constants module per side. Local E2E may shorten
them through one development-only override.

| Owner | Timer | Value | On expiry |
|---|---|---|---|
| Session DO | Queued backstop | 20 min from send (reconnect + attempt + 3 min) | `failed` (`preparation_timeout`) |
| Session DO | Accepted backstop | 65 min from accept | `failed` (`no_outcome`) |
| Sandbox DO | Provider create call | 2 min | Retry after the pause below while a route deadline remains |
| Sandbox DO | Provider create retry pause | 10 s after a failed create | Create again |
| Sandbox DO | Wrapper first connect | 5 min from launch | Stop the sandbox |
| Sandbox DO | Heartbeat | 45 s | Treat the socket as lost |
| Sandbox DO | Reconnect | 5 min from the last frame received | Stop the sandbox |
| Sandbox DO | Route preparation | 12 min per preparation attempt | Route `failed` (`preparation_timeout`) |
| Sandbox DO | Idle | 10 min without activity | Stop the sandbox |
| Sandbox DO | Provider lease | Existing lease length, renewed while active | Provider may stop an inactive sandbox |
| Sandbox DO | Credential grant | 4 h; re-issued on `deliver` below 1 h | — |
| Sandbox DO | Provider stop | Existing ladder | Log unconfirmed stop; routing state `stopped` |
| Wrapper | Preparation steps | Section 7 | Route `failed` with the step reason |
| Wrapper | SSE silence | 30 s | Health request |
| Wrapper | Kilo health request | 5 s | Restart Kilo |
| Wrapper | SSE reconnects | 6 in 2 min | Restart Kilo |
| Wrapper | Kilo restart budget | 3 in 10 min | Routes `failed` (`agent_unavailable`) |
| Wrapper | No real progress | 7 min | Abort; `failed` (`no_progress`) |
| Wrapper | Turn hard cap | 60 min | Abort; `failed` (`execution_limit`) |
| Wrapper | Reconnect backoff | 1 s to 30 s, forever | — |
| Supervisor | Wrapper restarts | 5 in 10 min | Stop restarting |

## 9. Failures

| Failure | Detected by | Recovery | Message effect |
|---|---|---|---|
| Provider create error | Sandbox DO | Retry after a 10 s pause, within the route deadline | Queued fail at the deadline |
| Wrapper never connects | Sandbox DO, 5 min | Stop; new allocation within the route deadline | Queued fail at the deadline |
| Clone network error | Wrapper | 3 attempts | Queued fail (`workspace_setup_failed`) |
| Setup command fails | Wrapper | None | Queued fail with the command output visible |
| Socket drops, wrapper returns | Sandbox DO | Wrapper reconnects | None |
| Socket down 5 min | Sandbox DO | Stop the sandbox | Accepted fail (`connection_lost`); queued re-prepare |
| Wrapper crash | Supervisor | Restart wrapper; routes re-prepared | Accepted fail (`agent_restarted`) |
| Kilo hang (no events, no HTTP answer) | Wrapper, about 35 s | Restart Kilo, at most 3 in 10 min | Busy turn without real progress: submitted again once; otherwise accepted fail (`agent_restarted`) |
| Kilo crash or dead event stream | Wrapper | Restart Kilo, at most 3 in 10 min | Same as Kilo hang |
| Kilo restart budget used up | Wrapper | None until the next message | Queued and accepted fail (`agent_unavailable`) |
| Kilo final error | Wrapper | None (Kilo already retried) | Accepted fail with Kilo's reason |
| No real progress 7 min | Wrapper | Abort the turn | Accepted fail (`no_progress`) |
| Turn over 60 min | Wrapper | Abort the turn | Accepted fail (`execution_limit`) |
| Idle 10 min, question pending | Sandbox DO | Stop the sandbox | Accepted fail (`sandbox_stopped`); a later answer is a new message |
| Sandbox gone | Provider via Sandbox DO | New allocation on next `prepare` | Accepted fail (`sandbox_lost`); queued re-prepare |
| Notification lost | Session DO backstop | — | Fail at 20 or 65 min |
| User Stop | Session DO | Abort the Kilo session only | Queued and accepted `cancelled` |
| Auto-commit or condense fails | Wrapper | None | Warning event; turn `completed` |
| Provider stop not confirmed | Sandbox DO | Logged; next `prepare` may create again | None; worktree deletion reports incomplete |

## 10. Interfaces

Session DO → Sandbox DO (RPC, returns at once): `prepare(route spec)` → route view,
`deliver(sessionId, messages)` → `sent` | `not_ready`, `abort(sessionId)`, `answer(sessionId,
reply)`, terminal create/resize/close/connect requests, worktree-change requests,
`release(sessionId)`, `status(sessionId)` (passive read).

Sandbox DO → Session DO (RPC notifications): `onRoute(update)` where the update is a route view
(`preparing(step)`, `ready`, `reconnecting`, `failed(reason)`) or `lost(reason)`, `onEvents(events)`,
`onOutcome(outcome)`.

Other callers of the Sandbox DO keep their current RPC: contained outbound credential lookup
(`resolveCredential`), runtime credential proxy, worktree deletion, sandbox status.

Sandbox DO ↔ wrapper (WebSocket frames): `hello`, `welcome`, `shutdown`, `heartbeat`,
`session.prepare`, `session.progress`, `session.ready`, `session.failed`, `session.credentials`,
`session.prompt`, `session.abort`, `session.answer`, `session.release`, `session.events`,
`session.outcome`, `events_dropped`, terminal control requests, worktree-change requests,
worktree-deletion requests (`worktree.prepareDeletion`, `worktree.delete`; both answer with
`worktree.result`). Terminal
bytes use the existing wrapper-to-Session-DO terminal socket.

### Public mapping

New states map onto the current public contracts; no public shape changes.

| New state | `/stream` (`src/shared/protocol.ts`) | Report `run.status` | Callback `status` |
|---|---|---|---|
| Message `queued` | `cloud.message.queued` | `queued` | — |
| Message `accepted` | `cloud.message.sent` | `accepted` | — |
| Message `completed` | `cloud.message.completed` | `completed` | `completed` |
| Message `failed` | `cloud.message.failed`, `status: 'failed'`, reason | `failed` with stage and code | `failed` |
| Message `cancelled` | `cloud.message.failed`, `status: 'interrupted'`, reason `interrupted` | `interrupted` | `interrupted` |
| Route `preparing(step)` | `preparing` v2 row (`attemptId` = route attempt, `triggerMessageId` = oldest queued message) and `cloud.status` `preparing` | — | — |
| Route `ready` | `cloud.status` `ready` | — | — |
| Route `failed` | `cloud.status` `error` | — | — |
| Finalization running | `cloud.status` `finalizing`, from a wrapper `finalizing` event; `ready` again on the outcome | — | — |

Reports carry `failureStage` and `failureCode` from the closed pairs in
`packages/worker-utils/src/cloud-agent-queue-report.ts`. `classifyControlPlaneFailure`
(`src/telemetry/control-plane-failure.ts`) stays the one owner of this mapping; its cases change to
the new reasons. The `session_message_committed` diagnostic keeps its name and fields so the
failure monitors keep working.

| Reason | Stage / code |
|---|---|
| `preparation_timeout` | `pre_dispatch` / `wrapper_start_failed` |
| `workspace_setup_failed` with the failed step's subtype | `pre_dispatch` / `workspace_setup_failed` |
| `agent_unavailable` | queued: `pre_dispatch` / `kilo_server_failed`; accepted: `post_dispatch_no_activity` / `wrapper_disconnected` |
| `connection_lost`, `sandbox_lost`, `agent_restarted` | `post_dispatch_no_activity` / `wrapper_disconnected` |
| `no_progress`, `no_outcome` | `post_dispatch_no_activity` / `wrapper_no_output` |
| `prompt_failed` | `post_dispatch_no_activity` / `wrapper_error_before_activity` |
| `sandbox_stopped` (idle while waiting on the user), `execution_limit` | `interruption` / `system_interrupt` |
| Kilo final error | `agent_activity` / `assistant_error`; responsibility from the existing assistant-failure helpers, so Kilo and provider errors stay attributed to them |
| Stop | `interruption` / `user_interrupt` |
| `missing_metadata`, `invalid_model`, payment required | Unchanged |

## 11. Acceptance scenarios

Each scenario runs on the real local stack (Worker, both DOs, sandbox container, supervisor,
wrapper, Kilo, fake LLM) and checks durable message states, stream events, report and callback
counts.

1. **Cold first message.** Preparation steps are visible; the message completes; one callback.
2. **Warm follow-up.** No preparation rows; the message completes.
3. **Follow-up during a running turn.** B goes to Kilo at once; A and B complete together from one
   outcome; one callback.
4. **Kilo final error with A and B accepted.** Both fail with Kilo's reason; the next message
   works.
5. **Two chats in one worktree, two worktrees in one sandbox.** Turns stream at the same time; Stop
   in one chat does not affect the others; deleting one chat leaves the others usable.
6. **Slash commands and attachment.** `/compact` summarizes the session; another known command runs
   as a command; an attachment reaches the model.
7. **Contained credentials.** Clone and Kilo calls work through contained outbound credential
   lookup, not only with direct credentials.
8. **Stop during a turn.** Messages `cancelled` at once; Kilo aborted; the sandbox and the other
   routes keep running; the next message works on the warm route.
9. **Setup command fails.** Queued message fails with a visible reason; after fixing the setup the
   next message prepares again.
10. **Socket drop, wrapper returns within 5 minutes.** The turn completes; no message fails.
11. **Socket down for 5 minutes.** The sandbox stops; accepted messages fail (`connection_lost`);
    the next message creates a new sandbox in the same chat with restored history.
12. **Kilo killed after the turn made progress.** The wrapper restarts Kilo; accepted messages fail
    (`agent_restarted`); the next message works without a new sandbox.
13. **Wrapper killed.** The supervisor restarts it; old Kilo processes are gone; accepted messages
    fail (`agent_restarted`); the next message works in the same container.
14. **Container killed.** Not a separate detector. The wrapper connection closes, or the heartbeat
    deadline (45 s) closes it. That is scenario 11: after the reconnect window, accepted messages
    fail (`connection_lost`) and the next message creates a new sandbox. `sandbox_lost` is not this
    reason: it is a confirmed provider stop during worktree deletion, or a Vercel network-policy
    failure on session release. The plane does not poll the provider for a dead container.
15. **Idle stop with a pending question.** After 10 idle minutes the sandbox stops and the turn
    fails (`sandbox_stopped`); the answer or a new message continues the chat on a new sandbox.
16. **No progress.** A turn with no real progress for 7 minutes fails (`no_progress`).
17. **Auto-commit fails.** The turn completes with a visible warning.
18. **Question answered live.** A question during a turn is answered; the same turn continues and
    completes.
19. **Kilo hangs before the first model call** (Kilo frozen with SIGSTOP while the fake LLM holds
    the first token). The wrapper restarts Kilo within about 1 minute and submits the message
    again; it completes; Kilo history has the user message once. A second hang in the same turn
    fails it (`agent_restarted`).

Fault scenarios use existing harness faults (container kill, pause, socket recycle through the
wrapper's SIGUSR1 handler) plus harness additions for Kilo and wrapper process kill. Timer overrides keep long scenarios short. A local run does not prove
provider stop reliability, billing or hosted timing; those are checked on a deployed test Worker.

## 12. Accepted risks and out of scope

- A delivery retried after an unclear failure can make Kilo process a prompt twice.
- A turn submitted again after a Kilo restart can cost a second model request when the first one
  reached the provider but produced no output yet.
- The cause of the Kilo hang is inside Kilo and is not fixed here; the restart only recovers it.
- A prompt frame lost when the socket breaks stays `accepted` until the next outcome or the backstop.
- Notifications are best effort; the Session DO backstop bounds a lost one.
- An unconfirmed provider stop is logged; the container may run until the provider stops it.
- A killed container is not found by polling the provider. It is a wrapper connection that does not
  return. The user waits at most the reconnect window, then the message fails `connection_lost`.
- Out of scope: Kilo and model-provider retry policy, workspace file recovery after sandbox loss,
  the legacy plane.
