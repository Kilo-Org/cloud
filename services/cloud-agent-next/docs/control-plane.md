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
6. **No old-plane backward compatibility.** Sessions created before the rewrite are not supported. There is
   no old-plane data migration and no support for older wrapper versions. A Durable Object instance that
   still holds old-plane storage is wiped on first access; the Sandbox DO first stops the old
   allocation so no old container keeps running.
   Current-generation SQLite contract upgrades are not old-plane storage.
7. **Public surfaces stay stable.** The tRPC API, the `/stream` event schema
   (`src/shared/protocol.ts`), reports and callbacks keep their current shapes.

## 2. Components

| Component | Owns | Does not own |
|---|---|---|
| Worker | Authentication, organization and worktree access, billing eligibility on send, tRPC, `/stream` and terminal WebSocket upgrade, preview on/off (`PREVIEW_HOST_SUFFIX`) and UI gate (`PREVIEW_ENABLED_IDS`), `/preview/open` hop, preview hostname dispatch, entry-ticket validation, session-token cookie, entry 303, per-request access checks, and preview request/response header sanitisation (`src/shared/preview-headers.ts`), runtime artifact downloads by grant, startup-failure report admission | Message, route or sandbox state |
| Session DO, one per session | Message queue and message states, route view, event log and client stream, question/permission projection, per-message reports and batch callback, current runtime authorization and delegated Kilo token renewal, preview eligibility and sandbox lookup | Sandbox lifecycle, preparation steps, Kilo health, turn outcome |
| Sandbox DO, one per `sandboxId` | Allocation lifecycle through the provider adapter, startup mode and startup command, wrapper socket, per-session routes, forwarding in both directions, activity, idle stop and provider lease, billing admission and attribution, wrapper and session credentials, preview target coordinates | Message states, Kilo health, turn outcome, workspace steps, physical billing intervals (container lifecycle owns them) |
| Bootstrap, inside the container, `downloaded` mode only | Verify and install the selected runtime, exec the supervisor, report one startup failure | Allocation decisions, retries |
| Supervisor, inside the container | Restart a crashed wrapper, bounded | Anything else |
| Wrapper, one per sandbox | Connection to the Sandbox DO, route preparation (clone, checkout, setup commands, Kilo runtime, Kilo session), Kilo supervision and restart, prompt submission, event streaming, turn outcome, finalization (auto-commit, condense), activity heartbeat, terminals, worktree changes | Sandbox lifecycle, message states |
| Kilo | Agent execution, provider retries, native history published to session-ingest | Infrastructure |

Wrapper upgrades are authenticated before Sandbox DO stub lookup. The Worker validates a bounded
HS256 launch envelope using the existing signing secret, with a domain-separated
`cloud-agent-control-wrapper-launch` audience and `control_wrapper_launch` purpose. It binds the
original random launch credential to the exact sandbox ID and allocation UUID. It has no clock
expiry or refresh protocol: admission lasts for that allocation, subject to the Sandbox DO's
authoritative current-allocation and credential-hash checks. There is no unsigned-wrapper bypass.
Missing/malformed bearer headers and invalid IDs are rejected without DO lookup. Invalid signatures,
wrong-purpose/sandbox envelopes and credentials invalidated by signing-key rotation receive
`shutdown` and prompt closure on a short-lived Worker-local socket, without DO lookup. A temporarily
unavailable signing secret returns 503, so ordinary bounded-backoff reconnect remains possible.

## 3. Topology and identities

- One Session DO per `sessionId` (`workspace_*`). One Sandbox DO per `sandboxId`. A shared sandbox
  (`usr-`, `org-`, `bot-`, `ubt-`) hosts many sessions and worktrees; an isolated sandbox hosts one.
- A **route** is one session on one sandbox: `sessionId`, worktree directory, `kiloSessionId`.
  New allocations with a compatible wrapper share one Kilo runtime per directory.
  Existing allocations retain their original `runtimeIsolation` and HOME keys until normal replacement.
  MCP servers are workspace configuration in shared runtimes.
- Compatible routes reference one Sandbox-owned credential scope. Scope membership includes every
  eligible root Kilo session. Shared runtimes use **one handle per worktree scope**.
  Existing allocations retain per-session handles. A modern grant never merges with a legacy grant.
- `messageId` is the permanent message identity. The wrapper passes it to Kilo as the user message
  ID.
- `allocationId` identifies one physical allocation. `wrapperId` is random per wrapper process. A new
  `wrapperId` on the same allocation means the wrapper restarted and its Kilo state is gone.

## 4. Normal flow

1. The user sends a message. The Worker checks access and billing, then calls the Session DO.
2. For a fresh message while existing work is preparing, the Session DO first confirms the owner
   within the transport bound and settles a known failed old attempt's existing work. It then stores
   the new message as `queued`; unavailable confirmation retains the existing queued intent.
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
8. The wrapper submits ordinary prompts to Kilo promptly, also while a turn runs. Submission stays
   sequential: a command or summarization response may delay later messages until it returns.
   Kilo events stream back through the Sandbox DO to the Session DO and the client.
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
| Send | Before a fresh admission with existing preparing work, confirm the owner and settle a known failed old attempt's existing work. Append `queued`. Route `ready`: deliver. Otherwise: `prepare`, and act on the view it returns. |
| Route ready | Deliver all `queued` in order. |
| Deliver returns `sent` | Those messages become `accepted`. |
| Deliver returns `not_ready` | Keep `queued`; call `prepare` and act on the view it returns. |
| Route progress | Show the preparation step. No message change. |
| Route reconnecting | Store the view. No message change and no client-visible change. |
| Route failed (reason) | All `queued` and `accepted` → `failed` with the reason. |
| Route lost (reason) | All `accepted` → `failed` with the reason. `queued` stay; if any, call `prepare`. |
| Owner view names a replacement attempt | Before storing the new view, all old `accepted` → `failed` (`agent_restarted`). Never replay them; keep `queued` for the new owner. |
| Outcome (status, reason, `lastMessageId`) | Every `accepted` message up to and including `lastMessageId` takes the status. If `lastMessageId` is unknown, every `accepted` message does. |
| Stop | All `queued` and `accepted` → `cancelled`; send `abort` (best effort). |
| Cancel one queued message | That message → `cancelled`. |
| Backstop alarm | `queued` older than 16.5 minutes → `failed` (`preparation_timeout`). `accepted` older than 125 minutes → `failed` (`no_outcome`). |

Stop still forwards a best-effort abort to an existing ready Kilo route when no
message is queued or accepted and the wrapper has no active turn. It does not
rewrite terminal message outcomes or prepare/wake a stopped sandbox.

Late outcomes and notifications for terminal messages are ignored. The backstop exists only for
lost notifications; the Sandbox DO and the wrapper settle every normal case earlier. Both values
are derived from the owners' timers so the backstop does not end work within its owner's bound:
queued = reconnect window (90 s) + one preparation attempt (12 min) + 3 min, which covers the
longest normal wait (a message sent while the socket is down, then a fresh attempt on a new
sandbox); accepted = turn hard cap (120 min) + 5 min. The hard cap bounds one native execution, not
an accepted message, so a batch whose follow-up waits behind a serialized command spans several
executions and can outlive the accepted backstop (see "Prompts and turn outcome" in section 7).
After every message change the Session DO sets the alarm to the earliest backstop,
transport-recovery, report or callback obligation, and clears it when none remains (for example
after Stop and successful terminal reporting).

### Queued transport recovery

The Session DO bounds each complete Sandbox transport pass (status, prepare and/or deliver,
including RPC retries) by one caller-owned two-second deadline through `withDORetry`.
Best-effort abort forwarding has the same bound, after messages are durably cancelled. Timed-out
RPCs may still finish remotely; queued replay keeps immutable IDs/intents and accepts ambiguous
duplicate delivery. Accepted messages are never replayed and terminal messages remain final.

Exhausted transport retries preserve queued intent and schedule at most one durable Session-level
deadline, 15 seconds later, folded into the existing alarm. The alarm consumes it before one
bounded recovery pass. It reads the passive `status(sessionId).view`, then prepares unknown/old
failed work or delivers ready work. A returned ready view after `not_ready` does not recursively
deliver. A failed recovery pass does not self-rearm: owner notifications and the original backstops
remain, and a fresh user interaction or new authoritative recovery hint permits another opportunity.
Delivered/terminal queued work and normal preparing/reconnecting owner views cancel the obligation.
Reconstruction honors the stored deadline without moving message or Sandbox-owned deadlines.

When queued work still names a failed attempt, transport recovery is unresolved, or a preparing
route receives terminal/readiness or different-attempt hints, notifications first confirm the
Sandbox's current passive view. That authority, never UUID ordering,
rebinds the attempt fence. New-attempt progress/ready is adopted; genuinely failed new attempts settle
work with their own reason. The old failed attempt cannot settle an unstarted retry; if still current,
preparation is retried within the bounded pass. Failed confirmation keeps the existing scheduled
obligation, but cannot rearm a consumed pass for a replay of that old attempt. Stale notifications
remain rejected after rebinding, and transport errors never synthesize an `unknown` route view.
Matching preparing notifications retain their step; matching failed notifications retain their
subtype only when the passive view also confirms the failure reason, before terminal settlement.

Attempt replacement owns retirement even if the old `lost` notification arrives later: accepted
work fails before the new attempt is stored, including a ready return after `not_ready`. A later
new-attempt outcome cannot complete the old accepted work. Fresh admission confirms existing
preparing work before adding a new message, so a known retired attempt's queued work can fail
explicitly without failing that new message. A queued message has no per-attempt ledger: when
confirmation is unavailable, or replacement already occurred without a known failure boundary,
old and new queued intent cannot safely be split retroactively. Keep that queued intent for the
authoritative owner rather than guess membership from IDs or timestamps. These are bounded
user/notification-triggered reads, not periodic preparation polling; original backstops remain.

### Route view

`unknown` | `preparing(step)` | `ready` | `reconnecting` | `failed(reason)`. It is the last view
from the Sandbox DO, from a notification, `prepare` or the passive recovery `status(...).view`.
It decides between `prepare` and `deliver`, and drives the preparation rows and `cloud.status` (section 10). The
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

### Startup modes

The Sandbox DO selects the first process of a sandbox. The provider runs it and does not interpret it.
The mode says where the runtime (Kilo and the supervisor) comes from: the image or a download.

- **Contract.** `launch(ref, { command, env }, options)` takes the command as an argv; a script is
  `['/bin/sh', '-c', script]`. Native uses it as the start entrypoint, and as the exec on a
  `sleep infinity` main process. Vercel runs it without a login shell. The Sandbox SDK runs it
  with `startProcess`. A provider never chooses a Kilo version, reads a release descriptor or owns
  a deadline other than `deadlineAt`.
- **`preinstalled`.** `preinstalled-startup.ts` supplies `['/bin/sh', CONTROL_SUPERVISOR_PATH]`.
  The image holds Kilo and the supervisor. There is no download and no grant.
- **`downloaded`.** `downloaded-startup.ts` reads the release descriptor, confirms both payload
  objects, mints an artifact grant and renders the bootstrap (`runtime-bootstrap.ts`). The bootstrap
  installs the CLI and control payloads under `/opt/kilo-cloud`, points the stable paths at them,
  removes the grant and execs the same supervisor argv. The native PID 1 check, the `pgrep` probe
  and the SDK process scan stay unchanged.
- **Selection.** `startup-selection.ts` reads the mode and the native image from Worker
  configuration once per create attempt. Absent configuration means `preinstalled`. Mode and image
  are independent, but the runtime-free image requires `downloaded`. `downloaded` is native only:
  SDK and Vercel pins on a downloaded target use `preinstalled`. Any other pair, a native
  `downloaded` pin without a descriptor, or a missing descriptor or payload object fails
  `invalid_configuration` before provider work. An R2 read error is a transient create error.
- **State.** The repository-launch record stores the allocation's mode, and both record writers
  keep it. There is no other new
  allocation state. Install time is inside the wrapper first-connect timer. Success is the wrapper
  `hello`; failure is one bootstrap report. Neither adds a provider poll.
- **Grant.** It names only the two selected payload hashes and the artifact audience. It expires at
  `createDeadlineAt` plus the first-connect timer, because the install can continue in `starting`. It
  is never persisted or logged, and never reaches the supervisor or Kilo env or arguments.
- **URLs.** Artifact and report URLs come from `WORKER_URL`. The native egress allowlist already
  holds that host, so restricted egress needs no new rule. There is no separate artifact origin.

**Startup failure report.** The bootstrap sends `{ allocationId, code }` with the wrapper launch
credential. Admission is the same as `hello`: the Worker checks the signed launch binding before DO
lookup, then the Sandbox DO checks the credential hash and the current allocation. The DO applies
`startup-failed` only in `creating` or `starting`. The first accepted report leaves those states,
so a later report changes nothing.

| Code (exit) | Kind |
|---|---|
| `artifact_unavailable` (70), `base_incompatible` (72), `install_interrupted` (74), `deadline_exceeded` (75) | Retryable |
| `artifact_unauthorized` (71), `artifact_invalid` (73), `cli_probe_failed` (76), `supervisor_missing` (77) | Permanent |

- A permanent code fails the preparing routes at once with `runtime_<code>`. A retryable code keeps
  them `preparing` for a new allocation within the route deadline, like a transient create error.
- After a repository start the wrapper never connected, so the existing first-start rule starts
  the next allocation from the image. `runCreate` never overlaps, so `recordLaunch` writes the
  source before the next start reads it, also for a report in `creating`. `base_incompatible` on a
  fresh image is a configuration error that the deploy blocks; if it happens, routes fail at the
  deadline with `preparation_timeout`.
- The report itself is not a snapshot failure and does not count against the snapshot failure
  budget. A bootstrap that exits before the first PID 1 check of a repository start is still one
  under the baseline rule when the provider failure wins: the in-attempt image fallback runs once,
  and its credential rotation rejects the first launch's report. When the report wins, the
  allocation leaves `creating` and the fallback does not run.
- If the report cannot reach the Worker, the first-connect timer applies.
- A retryable report can stop an allocation while its launch is still pending. Preparing work
  keeps an alarm at the existing create-retry interval. After instance loss, that alarm resumes
  allocation with the same route attempt and deadline. It makes no provider call while the
  original launch remains in flight. A lost launch result keeps the baseline unresolved-source
  behavior; the report does not create source evidence.

### Allocation state

| State | Leaves to | On | Timer |
|---|---|---|---|
| `stopped` | `creating` | `prepare` for a session or pending retry work after reconstruction | Existing route retry interval when work remains |
| `creating` | `starting` | Provider created the sandbox and launched the startup command | Provider call 2 min |
| `creating` or `starting` | `stopping` | Accepted `startup-failed` report: a permanent code fails preparing routes at once; a retryable code keeps them `preparing` | Existing ladder |
| `creating` | `creating` or `stopped` | Transient create error: retry after a 10 s pause while a route deadline remains, else stop | — |
| `creating` | `stopping` or `stopped` | Classified permanent create/launch error: fail preparing routes immediately; an owned physical ref uses the existing stop ladder | Existing ladder when a ref exists |
| `starting` | `connected` | Wrapper `hello` accepted | 5 min without `hello` → `stopping` |
| `connected` | `disconnected` | Socket closed, or no heartbeat for 45 s | — |
| `connected` | `stopping` | Inactive heartbeat after 1 min for unattended routes, no activity for 10 min otherwise, or explicit stop or delete | Unattended idle 1 min; existing idle backstop 10 min |
| `disconnected` | `connected` | Wrapper `hello`, same or new `wrapperId` | — |
| `disconnected` | `stopping` | No activity for 10 min, or 90 s after the last frame received, or explicit stop or delete | Idle 10 min, or reconnect 90 s, whichever is earlier |
| `stopping` | `stopped` | Provider confirms stop, or the existing stop ladder ends | Existing ladder |
| any | `stopped` | Provider reports the sandbox gone | — |

- A `hello` from a stale `allocationId`, an older protocol version or a bad credential gets
  `shutdown`. The wrapper exits with code 0 and the supervisor does not restart it.
- Before retaining a wrapper socket, the Sandbox DO verifies the signed launch binding, its
  credential hash and the current allocation. A correctly signed retired allocation receives
  `shutdown` without retaining a candidate. Signature validity alone is not allocation authority.
- At most two unbound candidates per allocation may handshake concurrently. Capacity overflow
  closes a short-lived socket with 1013, permitting ordinary reconnect rather than terminal shutdown.
  A candidate never displaces the healthy bound connection until a valid `hello` completes. The
  existing protocol, allocation, credential and connection-identity fences remain authoritative.
- Each unbound socket stores one 30-second `hello` deadline in its hibernation attachment. Its
  earliest deadline participates in the existing Sandbox alarm, including during in-flight create
  and in `stopped`. Reconstruction retains the original deadline; malformed/non-hello frames do not
  extend it. A late `hello` is not accepted. Successful hello removes that obligation. Expiry closes
  only the unbound socket, not the allocation or routes, and causes no activity, heartbeat loss,
  billing/provider work or physical start/stop.
- A `prepare` during `stopping` stores the route as `preparing` and returns its view at once. The
  Sandbox DO starts `creating` after `stopped`.
- On `stopping` or `stopped`, every `ready` route is removed and its session gets `route lost`. A
  session with queued messages calls `prepare` again, which creates a new allocation.
- A `preparing` route stays across a failed allocation (create error, connect timeout, sandbox gone)
  while its attempt deadline remains, except a classified permanent creation failure; the Sandbox DO creates a new allocation for it. At the
  deadline the route fails.
- Provider adapters preserve structured admission causes. Only actual `insufficient_credits` fails
  as `billing_blocked`; `stopping`, meter outages, network/5xx, throttling and recoverable conflicts
  retain the ten-second retry pause and the original attempt deadline. Error text or an HTTP 4xx
  alone never proves permanence. Proven local invalid/unsupported configuration fails as
  `invalid_configuration`; Vercel's local REST validation kinds, not remote status codes, establish it.
- A permanent error applies only while its allocation is still current and `creating`. It fails
  preparing routes through the normal fenced route notification/message settlement path, without
  waiting for physical cleanup. An owned physical ref enters the allocation owner's existing stop
  ladder, retaining unconfirmed evidence; no ref follows the existing failed-create transition.
  Late-create/hello fences and Vercel billing admission remain unchanged. A new message starts a fresh
  attempt when the condition clears; failed routes never automatically retry permanent errors.
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
| Allocation enters `creating`, `starting` or `stopping` | Notify each preparing route of the sandbox step (`sandbox_create`, `sandbox_start`; a create retry or a pending stop adds a detail). `prepare` and `status` return the same step while the allocation is in one of those states (`creating`, `starting`, `stopping`, `stopped`). |
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
  Session DO through one Sandbox-owned in-memory dispatcher. There is no durable notification
  outbox, receipt, replay reconciliation or second event log. Reconstruction starts with an empty
  dispatcher; notifications remain best effort.
- The dispatcher retains at most 1,000 entries and 8 MiB of serialized UTF-8 notification envelopes,
  including routing identity and active entries. At most four session lanes run concurrently, with one active notification
  per session. Eligible session heads are selected round-robin, not by draining one session first.
- The existing two-second notification deadline starts at enqueue, including queue wait and all
  `withDORetry` attempts. A queued entry that expires is removed without a Session RPC; a selected
  entry uses only the remaining budget. Deadline/retirement cancellation bounds local transport
  work, not proof that an already-started remote RPC was cancelled.
- Compatible adjacent pending event batches for the same session coalesce in event order, retaining
  the oldest enqueue time/deadline. Coalescing never crosses a route transition or outcome. Retained
  earlier events precede that session's outcome; transitions from different attempts remain distinct.
- At capacity, evict the oldest pending event traffic before critical route/outcome notifications.
  Active work is not evicted. If only critical work remains, drop the newest incoming notification
  rather than overwrite a retained transition. Critical work has the same finite capacity and age
  budget. Four slow lanes can exhaust a fifth session's budget: fairness is not guaranteed delivery.
- Loss is an internal bounded aggregate by cause (capacity, expiry, failure, retirement, wrapper),
  with dropped count/bytes, maximum queue age and at most one safe session-identity sample per cause.
  Counters saturate and diagnostics flush at most once per two-second window, retaining no payload
  or per-session loss history. `events_dropped` is internal wrapper-loss evidence only, not a Session
  notification or a public stream marker; unknown wrapper-loss bytes/age are recorded as zero.
- Notification work stays outside the Sandbox operation queue and never gates heartbeat processing,
  allocation alarms, provider stop or socket reconnect. Completion, dropping and session/worktree
  release retire queued references; retirement aborts any remaining local retry budget for that lane.
- Terminals keep the current topology: the Sandbox DO forwards only the terminal connect request;
  the browser and wrapper terminal sockets are bridged by the Session DO (`terminal-bridge.ts`).

### Activity, idle stop and provider lease

The wrapper heartbeat (every 5 s) carries `active`. Each Kilo process owns a native
session supervisor that observes every session before Cloud route filtering, including
unrouted sessions, subagents and autonomous continuations. Its running or stopping
executions keep compute active independently of accepted Cloud messages and UI selection.
Preparation, bounded prompt delivery and finalization also contribute.
The 2-minute delivery budget excludes legitimate serialized command/summarization waits
described below. A follow-up waiting behind a serialized command adds no compute activity of
its own; the command's live native execution decides it. An accepted UI turn alone is not activity.

Terminal presence and browser-to-PTY input do not contribute activity or renew the provider
lease. Recent terminal input is tracked for diagnostics only. An interactive terminal without
an agent turn lets the sandbox stop after the applicable idle window, even if terminal input
continues. This is the intended trade-off, not a regression: terminal-only workloads must not
keep a sandbox alive indefinitely.

A session blocked only on questions or permissions does not need compute. Pending requests
are tracked separately; answering one does not clear another, and an independent runnable
tool still counts. A parent waiting on a blocked child can sleep, while another working
session or descendant retains compute. Once a connected sandbox has had no activity for
1 minute, the next inactive heartbeat stops it if all routes are unattended. A sandbox
with at least one interactive origin (`cloud-agent-web`), a route still preparing,
no routes, or an unreadable stored origin keeps the 10-minute idle window. Unrecognized
or missing origins are unattended. The Sandbox DO derives this policy from its routes
without a cache.

The 1-minute rule is checked only on an inactive heartbeat, never on a disconnect or
reconnect. The existing allocation idle backstop (10 min), heartbeat deadline (45 s),
reconnect window (90 s), and provider lease (11 min) are unchanged. Active heartbeats
refresh `lastActivityAt` and renew that provider lease (`ensureLeaseAtLeast`). Accepted `hello`
and heartbeat frames still update `lastFrameAt` for liveness; inactive heartbeats do not refresh
activity or renew the lease. A reconnect also updates liveness only: it does not reset `lastActivityAt`,
extend the existing idle window or renew the provider lease.
Native supervision does not schedule future wakeups after compute has stopped.

### Billing, credentials and deletion

These keep their current owners and evidence; the rewrite ports them, it does not redesign them.

- Compute billing follows the physical container lifecycle (`metered-billing-lifecycle.ts`), not
  the routing state.
- The Sandbox DO mints the wrapper launch credential and owns one canonical Git/Kilo grant per
  compatible credential scope in DO SQLite. Route rows reference that owner rather than storing
  writable grant copies. Compatibility requires the same user, organization, worktree/directory,
  repository authority, targets, provider/physical binding, containment and backing authorization
  class. A scope cannot replace a legacy backing token with a modern delegated token. A checkout
  directory in a negotiated shared allocation uses exactly one credential class: if another grant serves the joining
  route's directory with a different runtime-proxy presence (modern vs legacy, either direction), the
  join fails closed before any prepare frame, recorded as the distinct `mixed_credential_class`
  diagnostic stage. Existing allocations retain the repository-only mixed-class allowance for isolated
  runtimes. Other incompatible scope or directory reuse fails without changing the surviving grant. A modern worktree scope
  adopts one canonical runtime-proxy handle shared by its members: the first prepare mints through its
  requesting member and each joiner copies that string. A pre-adoption per-session scope, which has
  stored member rows but no accepted entry at this fence, cannot enter a shared allocation and fails
  with `scope_handle_conflict`. Existing allocations bypass adoption and this guard, so siblings can
  join and refresh credentials during deployment. Only a new allocation can enable sharing.
  A shared allocation admits at most 32 member roots per worktree; an extra joiner fails `workspace_setup_failed`
  without touching incumbents. It serves contained outbound credential lookups (`resolveCredential`),
  runtime proxy authorization and Vercel network policy as today. Grants last 4 hours. When less than
  1 hour remains, `deliver` re-issues the grant with freshly selected Git and legacy Kilo material and
  sends them in a `session.credentials` frame before the prompts; the wrapper installs them into the
  running route and Kilo runtime. Modern runtime-authorized sessions use one runtime proxy handle per
  worktree scope, shared by every member of the scope, on Cloudflare Sandbox, Cloudflare Containers
  and Vercel instead of a Kilo capability wrapping the registration token. The Session DO owns the
  current delegated token and its renewal; registration credentials are route configuration, not
  authority to reuse a create-time delegated token. Grant renewal does not renew delegation.
- Repeated preparation, new preparation attempts and warm renewal reuse the canonical grant's
  aliases. Renewal refreshes backing material and expiry without revoking credentials installed in
  a busy runtime. The contained resolver and Vercel policy use this same canonical grant set.
  Prepare, renewal and runtime-handle binding apply the candidate provider policy before publishing
  the candidate grant; policy failure leaves the previous owner unchanged and sends no new
  credentials. A valid previous grant remains usable; an expired grant fails the affected route.
- Current-generation 2 storage may still contain pre-canonical serialized route grants. After the
  generated schema migration, initialization retires these snapshots rather than guessing which
  sibling's aliases the existing runtime and checkout installed. It also retires a credential-bearing
  ready route whose canonical owner is missing. Scope retirement, failed route state and the physical
  stop obligation are written atomically before serving calls. The existing stop ladder starts from
  the allocation alarm; initialization performs no provider calls and does not invent a new state,
  generation or compatibility flag. Ready sessions receive `lost(agent_restarted)`: accepted work
  fails, queued work can reprepare. Preparing sessions receive `failed(agent_restarted)` and their
  pending work fails explicitly. Credential sources remain available for a fresh user send/prepare,
  which starts a new attempt on the replacement allocation. Old aliases/modern handles are denied
  immediately by DO resolution and the modern facade. A legacy backing credential already injected
  by Vercel's existing network policy can remain usable until the physical stop removes that
  allocation; constructor retirement is not proof of policy revocation or physical stop and makes
  no synchronous provider calls. The existing stop ladder owns that physical cleanup,
  and new scopes retain normal shared legacy membership and worktree-scoped modern authorization.
  Already canonical storage reconstructs without this retirement.
- Release removes only that route's membership, native ingestion/export permissions and modern
  handle. The shared aliases and runtime survive while another member remains; the last member
  retires the grant. A Vercel revocation-policy failure still stops the physical sandbox fail closed.
  Route failure is not release: it retains shared scope material, while a failed modern route cannot
  obtain a runtime authorization fence. Physical replacement retires scope material through the
  allocation hooks and rebinds preparing routes before sending credentials to the new wrapper,
  without resetting attempt deadlines or starting a sandbox merely to obtain credentials.
- Worktree deletion reports an incomplete, retryable result when the provider has not confirmed the
  stop or cleanup (Shared Worktrees rule 13).

### Repository snapshots

Scope: `workspace_*` routes on `cloudflare-containers` whose directory is the constant isolated
path `/workspace/app`. A snapshot holds one repository at one path, so any other route has no key.

- **Key.** When a route is first prepared, the Sandbox DO hashes the owner, the repository URL and
  the setup commands with HMAC-SHA256 under a Worker secret. Env is not part of the key: setup
  re-runs on every start and rewrites what it derives from the env. The setup commands join the
  hash so a snapshot is reused only by a route with the same setup; a different setup for one
  repository gets its own key. It stores the digest on the route (`repo_key`) and keeps it across
  attempts. No key is computed, and no snapshot used, when the owner is not enrolled
  (`CONTAINER_REPO_SNAPSHOT_IDS`), the route has no repository, the provider cannot capture, or the
  secret is missing. Scope is per user; per org is a change to that one field. The Sandbox DO
  adds the allocation's startup mode to the key for `launch` and capture, so a snapshot captured
  in one mode is never restored in the other.
- **Start.** `launch` receives the key of the routes waiting for the allocation: exactly one key,
  else none. `SandboxContainers` appends the image, and starts from the
  repository snapshot in the `REPO_SNAPSHOTS` KV index when it has one for that digest, else from
   the image. `launch` returns `startSource`. A failed repository start retains the index entry
   and asks the Sandbox DO to clean up the failed container and launch the image for the same
   allocation. Cleanup and fallback only run while that allocation is still creating; a wrapper
   that already connected is never destroyed by fallback. Before cleanup, the Sandbox DO rotates
   the launch credential so a late wrapper from the failed snapshot cannot connect. The snapshot attempt, cleanup and image fallback share the original
   launch deadline. No separate half-budget reservation exists.
   Each later sandbox start retries the snapshot once, up to ten failed starts per snapshot ID
   in that sandbox's durable record. After that it uses the image; a replacement snapshot gets
   its own failure budget. Failure never deletes or changes the shared snapshot index.
- **First start only.** The Sandbox DO remembers how the previous allocation started and whether its
  wrapper connected. When a repository start never connected (for example the first-connect timeout
   stopped it), the next launch skips the snapshot and starts from the image without deleting
   the entry. A completed image fallback records `image`, so the next start tries the retained
   snapshot again unless its failure budget is exhausted.
- **Capture.** `session.prepare` carries `capture: true` when the route has a key and the provider
  can capture. The key names the setup commands as well as the user and the repository, because
  capture runs after setup: a snapshot built with one setup is never adopted by a route with
  another. The
  wrapper decides whether to capture (a fresh clone, or an adopted snapshot that is
  due for a refresh) and then sends `workspace.capture` after setup, with origin bare. The Sandbox DO
  calls the provider off its serial queue, bounded at 5 min 5 s, and answers `workspace.captured`
  (`ok: false` at once when nothing can be saved). `SandboxContainers` snapshots the running
  container (bounded at 5 min), and writes `{ snapshotId, commit }` to the index with a 10-day TTL,
  which only expires a snapshot nobody uses (the platform keeps one for 30 days).
  It does not take its operation queue, so a stop or launch is never delayed by a capture. The
  snapshot is published only while that allocation is still the running one.
  Each capture logs one line with its `outcome` (`stored`, `index_unavailable`, `abandoned` or
  `failed`) and the `durationMs` of the platform snapshot, to tune the bound from real durations.
- **No session snapshots.** A stop destroys the container without a snapshot. A restarted session
  uses the repository snapshot, then restores its Kilo history from session-ingest.
- **Image tie.** A deploy that changes the image changes the index key, so the next start per key is
  cold. The platform keeps an unused snapshot for 30 days; there is no list or delete API. The
  runtime-free image changes only when its own inputs change, so a runtime-only deploy keeps
  `downloaded` snapshots. A restored `downloaded` sandbox runs the bootstrap first; the captured
  runtime never starts.

## 7. Wrapper

### Connection

- A new wrapper advertises optional `heartbeatAck: true` in `hello`; the Sandbox DO echoes it
  in `welcome` only when offered. It sends `{ type: 'heartbeat_ack' }` after applying each valid
  heartbeat from the current bound allocation/connection. Invalid, unbound, stale and terminal
  allocation frames are not acknowledged. Negotiation lives in the socket attachment across hibernation.
- Only a negotiated welcome starts the wrapper's 15 s acknowledgement deadline. Each acknowledgement
  resets it; other frames do not. Expiry detaches/fences the socket and schedules the existing
  reconnect backoff independently of close delivery. Old socket messages and callbacks cannot affect
  the replacement. Explicit recycle clears timers, detaches the old socket and reconnects immediately
  without waiting for close. Shutdown cancels all timers permanently. This does not restart Kilo or change billing.
- Older v2 DOs strictly reject the capability-bearing hello. If still awaiting welcome after 1 s,
  the wrapper sends the original hello on the same socket. A legacy welcome enables periodic
  heartbeats without an acknowledgement deadline; old wrappers receive neither the optional field
  nor acknowledgement frames. Duplicate hello on a bound socket is ignored.
- A wrapper that redacts named secrets advertises optional `redactsNamedSecrets: true` in `hello`; the
  Sandbox DO stores it on the socket attachment like `heartbeatAck`. Encrypted secrets ride only the
  DO-private credential source (`encryptedSecrets`) and are decrypted into the frame. A secret-bearing
  `session.prepare` carries the names as frame-only `secretEnvKeys`, never written to the route row; a
  frame with no secrets omits the field and stays valid for a version-3 wrapper. A secret-bearing
  prepare is never sent to a wrapper that did not advertise the capability: the attempt fails
   `workspace_setup_failed`. Worktree chats inherit their source chat's profile, environment, and
   secrets and share its directory runtime and HOME. Separate worktree directories retain separate
   runtimes; read-only Bitbucket reviews carry no profile secrets, like the withheld MCP snapshot.

- Connect, send `hello` (`wrapperId`, `allocationId`, protocol version), wait for `welcome` or
  `shutdown`. On `shutdown`, permanently close the connection and exit with code 0, even when the
  rejection arrives before `welcome`. Terminal admission rejection must not become an HTTP 401
  reconnect loop. The wrapper passes the signed launch envelope as its bearer unchanged.
- Reconnect forever with backoff from 1 s to 30 s plus jitter. Never exit because the connection
  failed. SIGUSR1 closes and reopens the connection (existing test hook).
- Each connect attempt, from socket creation through `welcome` and the outbox flush, is bounded by
  30 s so a hung upgrade or welcome cannot consume the Sandbox DO's 90 s reconnect window. A socket
  error, a failed write or a write to a socket that is no longer open ends the socket immediately and
  schedules the reconnect backoff without waiting for close. Reconnect keeps the same `wrapperId`;
  transport loss never restarts Kilo.
- While disconnected, keep outbound frames in one bounded buffer (1,000 frames and 8 MiB of serialized
  UTF-8). At capacity, evict the oldest event frames first, then the oldest `session.progress` frames
  (display-only; they never change route state). Route transitions (`session.ready`,
  `session.failed`), outcomes and request results are never evicted: if only they remain, reject the
  newest incoming frame and log its type. An event frame never evicts progress, and nothing is
  evicted for a frame that cannot fit anyway. Every dropped event frame is counted in one
  `events_dropped` frame sent to the Sandbox DO as internal loss evidence. It has no public
  marker/Session forwarding contract.
- After `welcome`, the wrapper writes `events_dropped` and then the buffer in order, removing each
  frame only after its write succeeds. It reports itself connected (and starts heartbeats) only after
  the whole flush succeeds; a failed flush is a failed connect attempt and keeps the unsent suffix.

### Preparation (`session.prepare`, idempotent per session)

The wrapper owns the step timeouts and retries:

| Step | Bound | Retry |
|---|---|---|
| Clone or fetch | 6 min total | Network errors: 3 attempts with backoff |
| Use a prepared repository (`restore`) | 2 min | Network errors: 3 attempts; any other failure falls back to a clone |
| Checkout, branch restore | In the clone budget | No |
| Setup commands | Current per-command limits | No; a failure fails preparation |
| Save the repository (`snapshot`) | 5 min 10 s wait | No; a failure is logged and preparation continues |
| Kilo runtime start | 2 min | 1 retry |
| Kilo session: use the one Kilo has on disk; if missing (new sandbox), restore from the snapshot; else create | 2 min | 1 retry |

Each step sends progress. Long steps also send a short, throttled `detail` line within the step
(git clone and checkout percentages, clone retries, session history loading); the detail is display
text, not route state. A route already prepared in this process (checkout present, Kilo session
open) returns `session.ready` at once. A `session.prepare` for a failed route starts fresh,
including a new Kilo restart budget.

Eligible managed GitHub HTTPS preparation clone and fetch, and only those invocations, pass two
invocation-scoped options together: `proactiveAuth=basic` so the first request carries the existing
URL-bound control alias, and `followRedirects=false` so every redirect fails instead of letting Git
reattach the alias to a redirected request. The credential remains the existing control alias; the
only credential flow is contained resolution, repository-authorized redemption, and the bounded
Retry-After handler. Every redirect fails the operation, including a same-origin redirect from a
renamed or transferred repository, so the caller must use the current direct repository URL. The
options are command arguments, not Git config.

#### Workspace stamp

A prepared workspace carries `.git/kilo-workspace.json` (`{ allocationId, commit, capturedAt,
generation }`; beside the directory when there is no repository). It replaces the boolean bootstrap marker. At
`session.prepare` the wrapper decides from the filesystem alone:

| Found | Meaning | Work |
|---|---|---|
| No `.git` | Image start | Clone, checkout, setup, stamp, then capture when asked |
| `.git`, no stamp | A preparation that did not finish | Reuse the clone: checkout, setup, stamp. Never captured. |
| Stamp from this allocation | A sibling session or a wrapper restart | Nothing |
| Stamp from another allocation | A restored repository snapshot | **Adopt** |

Adopt makes the snapshot equal to a fresh clone, then runs the ordinary steps:

1. Point `origin` at this route's credential.
2. `fetch --prune`, then refresh the remote default branch.
3. Detach at the remote default branch, so a new branch starts from its tip.
4. Delete every local branch. The captured session's branch, or this session's own from an earlier
   capture, would otherwise shadow a newer `origin/<branch>`.
5. Check out this route's branch (working branch, explicit branch or review ref) and set the git
   author, as after a clone.
6. Run the setup commands, then write the stamp.

Any failure empties the directory and clones. The Kilo session step is unchanged: the snapshot has
no Kilo home, so nothing stale shadows the restore from session-ingest. `session.ready` reports
`workspace: 'cloned' | 'same' | 'adopted'`.

Before starting Kilo, materialize the session's profile skills (including companion files) into
`HOME/.kilocode/skills`. Custom agents and Kilo commands use a profile config file under HOME,
selected by `KILO_CONFIG`, so large prompts and templates do not enlarge the process environment.
Chats in one worktree share this HOME and runtime. Worktree chats inherit their source chat's
profile, so every member materializes the same collections; registration does not isolate them.
Preparation replaces stale profile artifacts from restored homes, and credential refresh retains
the same profile config path. Read-only Bitbucket reviews withhold these collections, matching
the legacy profile restrictions.

#### Capture

A route captures only when `session.prepare` carries `capture: true`, and then when it cloned
(generation 0) or when the snapshot it adopted is due for a **refresh**: captured 4 days ago or
more. A refresh captures the adopted workspace, so it costs the incremental setup rather than a cold
clone and install. A snapshot that is not due keeps its `capturedAt` and generation in the new
stamp, so its age keeps counting. Each capture stacks on the last, so after 4 refreshes a due
snapshot is **rebuilt** instead: the wrapper does not adopt it, empties the directory, clones, and
captures a new generation 0. That bounds what stacked captures accumulate (deleted files, untracked
leftovers). Concurrent sessions that adopt a due snapshot each capture, and the last write wins.
After
setup the wrapper writes the stamp (before the snapshot, so a restored container sees another
allocation's stamp), sets `origin` to the bare URL, clears the reflogs and `FETCH_HEAD`, sends
`workspace.capture` and waits for `workspace.captured`. It then restores the authenticated URL,
whatever the outcome, and continues to the Kilo runtime. A snapshot therefore holds no agent edits,
no Kilo home and no git credential. Process env never reaches the disk. Capture runs after setup, so
the key names the setup commands too: a snapshot is reused only by a route with the same setup.

### Prompts and turn outcome

- `session.prompt` is submitted to Kilo with `messageID` = `messageId`, in arrival order, also while
  a turn runs. A prompt turn uses `prompt_async` after attachments are materialized. `/compact`
  calls Kilo session summarization. Other command turns use Kilo's command endpoint. While Kilo
  restarts, prompts wait in a per-session inbox. The wrapper publishes Kilo's command catalog as
  `commands.available`.
- Credential installation records the refreshed Kilo environment before Git maintenance, without
  restarting Kilo itself. The turn owner authorizes an idle credential restart only when no turn
  on that runtime exists, including pending attachment materialization/submission, finalization and
  shared siblings. After native idle/PTY inspection, the runtime rechecks that authorization and
  the inspected client identity, then reserves retirement synchronously before yielding. A prompt
  received after reservation waits for the replacement rather than receiving a retiring client.
- Commands and summarization keep sequential wrapper submission: later messages may wait for the
  current command/summary HTTP response before reaching Kilo. This wait is accepted and is not a
  remediation blocker or a requirement for a Kilo/SDK change. A later message waiting behind a
  dispatched command/summary Kilo has already observed and still supervises does not consume its
  2-minute prompt-delivery budget; that budget stays current while the wait holds, so it does not
  expire the instant the response clears. The native 20-minute no-progress bound applies while
  executing; its clock pauses during user waits, and the 120-minute wall-clock cap still bounds
  the wait, not the batch: the follower starts a new native execution once the response clears, so a
  batch spanning several executions can outlive the accepted backstop and fail `no_outcome`. A command
  that is not currently observed, or a plain prompt, still expires as a stuck intake.
  Ordinary prompts still reach Kilo during model execution through `prompt_async`. Kilo owns its
  native queue and execution; the wrapper must not add a shadow native queue or concurrent HTTP to
  bypass command ordering.
- A summary's HTTP response can overtake its `session.turn.close` on the feed. Later messages
  therefore also wait until the summary's completed close is processed, directly or through a
  reconciled idle, so that close cannot complete newer work. The wait adds no compute activity.
  While the summary's native execution is live, its supervisor bounds the wait. After that, the
  2-minute delivery deadline bounds it, paused and refreshed by a memory hold like any delivery
  wait. A close that does not arrive in time fails `prompt_failed`.
- The wrapper tracks each Kilo root session through Kilo's status, idle, turn-close and error events,
  and remembers the last submitted `messageId`.
- Outcome frame: `sessionId`, `status`, optional `reason`, `lastMessageId`.
  - `completed`: Kilo emitted `session.turn.close` with reason `completed`, finalization is done,
    and no later prompt remains unfinished. `session.idle` and a `superseded` turn-close are not
    completion signals. The wrapper does not keep a copy of Kilo's native prompt queue.
  - `failed`: Kilo reports a final error; native execution exceeds 20 minutes without real
    progress or the separate 120-minute wall-clock cap; Kilo restarts after real progress or
    a second time; prompt delivery fails. The native supervisor chooses `no_progress` or
    `execution_limit` once, settles accepted messages with that reason, then performs a
    bounded tree abort. A `no_progress` stall in Kilo's model retry loop (a `retry` status
    since the last progress, in the execution or a descendant it stops) settles as the
    assistant failure Kilo was retrying, such as a rate limit, not as `no_progress`. Kilo
    sets `retry` only from its model-provider retry policy, so retry text the classifier does
    not recognize settles as `provider_unavailable`, never `unknown`. Stopping remains compute
    activity until cancellation is confirmed; unconfirmed cancellation uses the existing
    runtime restart owner. A later native abort
    event cannot overwrite the outcome or settle a newly queued message.
    A `superseded` turn-close is Kilo handing off to a queued follow-up, so the native
    execution and both of its clocks continue into the next turn. Follow-ups therefore cannot
    extend a run past 120 minutes from its start; if no turn follows, the next idle snapshot
    finishes the execution.
    Assistant text/reasoning changes and actual tool output/state changes are progress.
    User input, repeated parts, metadata, busy/retry status and transport heartbeats are not.
    Useful descendant progress advances its ancestors, never unrelated roots. User waits and a
    memory hold of the Kilo runtime (see Kilo supervision) pause only no-progress time;
    overlapping pauses count once. Silent running tools have no exemption. The hard cap
    includes user waits. A tool's own shorter timeout can still interrupt it earlier.
    Without a current Cloud turn, a routed native deadline emits an existing `session.error` event
    for replay/UI without inventing a message ID or rewriting the prior outcome.
  - `cancelled`: the turn was aborted.
- Finalization (auto-commit, condense) runs after Kilo's completed turn-close. The wrapper sends a `finalizing`
  event when it starts. Its failures are warning events; the outcome stays `completed`. A prompt
  that arrives during finalization follows the same submission rules, including an accepted wait
  behind a pending command/summary response; finalization itself does not block submission. The
  wrapper does not send `completed` for that earlier close. Each finalization step has one timeout that
  covers the whole step. A finalization timeout or failure never aborts the Kilo session, so it
  cannot cancel a newer prompt.

### Kilo supervision

`session-supervisor.ts` owns native execution state and deadlines, independently of
`turn.ts`, which owns Cloud admission, ordered delivery, finalization and outcomes.
`kilo-runtime.ts` owns one supervisor per actual process lifetime through
`runtime-activity.ts`. `main.ts` composes their aggregate heartbeat.

The global feed is subscribed before a bounded initial snapshot. Reconciliation repeats
on reconnect and every 30 seconds, single-flight with a 10-second request budget. It
covers owned and discovered directories, status, in-flight parts and pending interactions;
newer stream observations fence older snapshots. Reconnecting to the same process preserves
execution clocks. Failed/partial observations preserve known activity briefly and suspend
inactivity decisions. If observations cannot be recovered within the existing 2-minute
window, the runtime sends the existing bounded health request. A failed health probe uses
the genuine-hang recovery path. A healthy probe and meaningful assistant/tool progress
within the last 30 seconds permit continued snapshot retries, with health and progress
rechecked on each 5-second watchdog tick. This extension ends no later than 4 minutes
from the original observation failure; progress and heartbeats never move that deadline.
A healthy runtime without recent meaningful progress, or with observations still failed
at that bound, restarts with an activity-observation trigger, not proof of unresponsiveness.
A successful snapshot ends the observation episode. The existing memory hold takes precedence,
including its bounded expiry and out-of-memory outcome. Snapshot and abort requests,
late events and callbacks are fenced by process/feed identity and cancelled on retirement.
Credential replacement uses the same native activity plus the existing Cloud-work and PTY
protections.


- SSE silence for 30 s: send one health request (`GET /global/health`, 5 s timeout). No answer:
  Kilo is hung; restart it at once. An answer: reconnect the event stream; after 6 reconnects in 2
  minutes, restart Kilo. A reconnected stream gets 12 s to deliver a real event, because Kilo's
  first heartbeat comes 10 s after connect; a stream that stays silent is replaced at the next
  check, 15 s after the reconnect. Kilo sends heartbeats every 10–15 s, so silence means a real
  fault. Local runs on Kilo 7.6.2 and 7.8.1 show an intermittent hang after a prompt is accepted:
  Kilo stops emitting, never calls the model and does not answer HTTP.
- Tool memory isolation: the workload reserves 1 GiB for the wrapper and keeps the tool cap
  1.5 GiB below the shared workload cap. Kilo has OOM protection. Its tool descendants inherit
  that protection, so the process sweep removes it before attempting tool cgroup migration.
  This adjustment does not depend on migration success and retries for existing group members.
  A failed move must not leave an oversized tool immune to OOM kills at the shared cap.
  Memory allocated before migration stays charged to the original group; server-group memory
  and OOM counters therefore do not identify the Kilo process itself.
- Memory hold: the wrapper samples the shared workload cgroup at every 5 s check. Usage within
  256 MiB of `memory.max` with the `memory.events` `max` count risen since the previous sample
  means Kilo is stalled in reclaim, not hung. Before a hang restart (no health answer, the
  reconnect budget, or failed activity observation), the wrapper then keeps Kilo running and
  decides again at each check; an answer reconnects the stream as above, and failed observation
  keeps reading snapshots. The hold ends as recovered once Kilo delivers events and its activity
  is observable. It ends with the restart as above after two quiet samples in a row while Kilo is
  still unhealthy, or after two minutes; one episode holds at most two minutes. A cap that is full
  of idle page cache does not raise the count, so it does not hold a restart. The cost: a genuine
  hang during real memory pressure waits up to two extra minutes. This permits transient recovery
  but bounds the wait when pressure cannot clear. While held, the runtime's executions
  pause their no-progress clocks, and the 120 s prompt delivery deadline does not run; it starts
  again when the hold ends. Each turn on the held runtime, including one that starts during the
  hold, gets a non-fatal `error` event saying Kilo is not responding while the sandbox is low on
  memory; nothing acts on it. Hold start and end are logged (`kilo_memory_hold_started`,
  `kilo_memory_hold_ended`).
- Kilo process exit: restart Kilo.
- From the detected silence until Kilo is back, new prompts wait in the per-session inbox.
- Restart: kill the Kilo process group and start Kilo. Kilo continues its sessions from its own
  storage on disk. Routes stay `ready`.
- Busy turns on a restarted runtime: a turn with no real progress since it started is submitted
  again, once. Its prompts go back to the front of the inbox in order, with the same `messageID`s
  (Kilo stores messages by ID). No real progress means no tool events, so no tool work repeats. A
  turn with real progress, or one already submitted again, gets `failed`: `sandbox_out_of_memory`
  after a hang restart that ends an expired memory hold, `agent_unresponsive` after any other hang
  restart except one for exhausted activity capacity or healthy failed activity observation,
  otherwise `agent_restarted`.
- That recovery selection occurs only in the restart-completion turn transition. It invalidates
  the retired submission chain and rebuilds the existing inbox in original message order, without
  waiting for held retired HTTP results. Restart-caused transport rejection is recognized by the
  retired client identity even after replacement completes, and cannot independently fail the turn
  as `prompt_failed`. Native application and attachment errors still fail; Stop/release/new-turn
  fencing rejects late effects. Materialization is shared by first dispatch and recovery.
- Only actual resubmission spends the once-only allowance. A turn received during restart whose
  prompts were never dispatched gets its first dispatch without spending it. Recovery preserves
  the turn's existing clocks, progress, user-wait pause and allowance; credential maintenance does
  not reset them, and the runtime stays keyed by its directory rather than by session.
- Budget: 3 restarts in 10 minutes per runtime. After that, routes on it report `failed`
  (`agent_unavailable`).
- Degraded state (event stream reconnecting, Kilo restarting) goes in the heartbeat. The Sandbox DO
  forwards it to sessions as information only.

### Crash resistance

- The wrapper does not exit on disconnect, reconnect failure, Kilo failure or unhandled promise
  rejection; it logs them. It exits only on `shutdown` (exit 0, terminal), SIGTERM (exit 1) or an
  uncaught exception (exit 1).
- The wrapper cannot tell a stray SIGTERM from one the supervisor forwards, so it always exits 1 and
  records `wrapper.lifecycle` `stopping`, not `failed`. The supervisor owns the outcome: a SIGTERM
  sent to the wrapper alone restarts it within the existing budget, while the supervisor's own
  TERM/INT trap forwards SIGTERM and then exits terminally.
- Each Kilo spawn writes a pidfile with PID and process start time. At startup the wrapper kills the
  process groups of stale pidfiles whose PID and start time still match, before it starts Kilo.

### Supervisor

The startup command starts a small supervisor loop that runs the wrapper. After a non-zero
exit it restarts the wrapper with 1 s to 30 s backoff, at most 5 times in 10 minutes. Exit code 0
ends the loop; that is the wrapper's terminal `shutdown` path, while a SIGTERM sent to the wrapper
alone is non-zero and restarts. If the loop gives up, the Sandbox DO `starting` or `disconnected`
timer stops the sandbox.

On the native Cloudflare Containers runtime the container main process is the startup command:
`start()` is issued with it as the entrypoint. In `preinstalled` mode that is
`['/bin/sh', supervisor-path]`. In `downloaded` mode it is the bootstrap, which execs the same argv
after install. PID 1 identity (`/proc/1/cmdline`) is the issuance confirmation when it is either
argv, bounded by the wrapper readiness deadline. PID 1 identity is not wrapper readiness: the
wrapper socket and the Sandbox DO `starting` timer stay the readiness owner, and no provider poll or
wrapper-child probe is added for that path. Sandbox SDK and Vercel run the preinstalled startup
command against a living PID 1; downloaded startup is native-only.

A native attempt that already issued the main process does not start another supervisor when that
process is gone; the persisted `exec_pending` fence is not reset, and the next allocation may start a
new one. Native supervisor exit stops the container, and the Sandbox DO timer still owns stop.
Operational stderr (including the supervisor script's native-gated JSON lines) is native-only and is
not a substitute for the R2 file archive or the diagnostic upload. It also carries the wrapper's
periodic 60 s status line and its normal prepare/outcome/start/exit transitions; those are
native-only and are not an upload substitute either.

## 8. Timers

Each timer has one owner. All values live in one constants module per side. Local E2E may shorten
them through one development-only override.

| Owner | Timer | Value | On expiry |
|---|---|---|---|
| Session DO | Queued backstop | 16.5 min from send (reconnect + attempt + 3 min) | `failed` (`preparation_timeout`) |
| Session DO | Accepted backstop | 125 min from accept | `failed` (`no_outcome`) |
| Session DO | Sandbox transport pass / best-effort abort | 2 s including RPC retries, not scaled | Retain queued intent / return from abort |
| Session DO | Queued transport recovery | 15 s after exhaustion; development-only scaling | Consume once; passive status then bounded prepare/deliver, no self-rearm |
| Sandbox DO | Provider create call | 2 min | Retry after the pause below while a route deadline remains |
| Sandbox DO | Provider create retry pause | 10 s after a transient failed create | Create again within the unchanged route attempt; classified permanent errors fail promptly |
| Sandbox DO | Wrapper first connect | 5 min from launch; includes the `downloaded` install | Stop the sandbox |
| Sandbox DO | Unbound wrapper hello | 30 s from socket admission, not scaled | Close candidate only; attachment deadline survives hibernation and participates in the existing alarm even while stopped |
| Sandbox DO | Heartbeat | 45 s | Treat the socket as lost |
| Sandbox DO | Reconnect | 90 s from the last frame received | Stop the sandbox |
| Sandbox DO | Route preparation | 12 min per preparation attempt | Route `failed` (`preparation_timeout`) |
| Sandbox DO | Session notification | 2 s from enqueue including queue wait and RPC retries, not scaled | Drop expired queued work before RPC; bounded best-effort loss, existing Session backstop |
| Sandbox DO | Idle | 10 min without activity | Stop the sandbox |
| Sandbox DO | Provider lease | Existing lease length, renewed while active | Provider may stop an inactive sandbox |
| Sandbox DO | Credential grant | 4 h; re-issued on `deliver` below 1 h | — |
| Sandbox DO | Artifact grant | `createDeadlineAt` plus first connect | Downloads are rejected |
| Bootstrap | Install | Until the first-connect deadline, rendered by the Worker | Report `deadline_exceeded` and exit |
| Sandbox DO | Provider stop | Existing ladder | Log unconfirmed stop; routing state `stopped` |
| Sandbox DO | Repository capture call | 5 min 5 s (container DO: 5 min) | Answer `ok: false`; preparation continues |
| Wrapper | Preparation steps | Section 7 | Route `failed` with the step reason |
| Wrapper | Adopt a repository snapshot | 2 min | Empty the directory and clone |
| Wrapper | Wait for a capture | 5 min 10 s | Continue without a snapshot |
| Wrapper | SSE silence | 30 s | Health request |
| Wrapper | Kilo health request | 5 s | Restart Kilo |
| Wrapper | SSE reconnects | 6 in 2 min | Restart Kilo |
| Wrapper | Kilo restart budget | 3 in 10 min | Routes `failed` (`agent_unavailable`) |
| Wrapper | Native execution without real progress, including silent tools | 20 min excluding user waits | Bounded tree abort; `no_progress` outcome or routed error, or the retried assistant failure when Kilo is retrying the model request |
| Wrapper | Native execution hard cap | 120 min including user waits | Bounded tree abort; `execution_limit` outcome or routed error |
| Wrapper | Reconnect backoff | 1 s to 30 s, forever | — |
| Wrapper | Connect attempt (upgrade, `hello`, `welcome`, outbox flush) | 30 s from socket creation | Detach the socket and use the reconnect backoff; Kilo keeps running |
| Supervisor | Wrapper restarts | 5 in 10 min | Stop restarting |

## 9. Failures

| Failure | Detected by | Recovery | Message effect |
|---|---|---|---|
| Transient provider create error | Sandbox DO | Retry after a 10 s pause, within the unchanged route deadline | Queued fail at the deadline |
| Actual compute credit denial | Provider adapter / existing Vercel billing admission | New message after adding credits | Queued fail promptly (`billing_blocked`) |
| Proven invalid/unsupported provider configuration | Provider adapter | New message after correcting configuration | Queued fail promptly (`invalid_configuration`) |
| Wrapper never connects | Sandbox DO, 5 min | Stop; new allocation within the route deadline | Queued fail at the deadline |
| Startup configuration, release descriptor or payload missing | `startup-selection.ts`, `downloaded-startup.ts` | New message after the configuration is corrected | Queued fail promptly (`invalid_configuration`) |
| Runtime install fails permanently | Bootstrap report | None until the next message | Queued fail promptly (`runtime_<code>`) |
| Runtime install fails transiently, or the base is incompatible | Bootstrap report | Stop; new allocation within the route deadline, from the image after a restore | Queued fail at the deadline |
| Startup report lost | Sandbox DO, 5 min | Same as "Wrapper never connects" | Queued fail at the deadline |
| Clone network error | Wrapper | 3 attempts | Queued fail (`workspace_setup_failed`) |
| Repository snapshot cannot be used (start, adopt) | Container DO, wrapper | Start from the image, or clone | None; a cold start |
| Repository capture fails or times out | Sandbox DO, wrapper | Continue without a snapshot | None |
| Setup command fails | Wrapper | None | Queued fail with the command output visible |
| Socket drops, wrapper returns | Sandbox DO | Wrapper reconnects | None |
| Socket down 90 s | Sandbox DO | Stop the sandbox | Accepted fail (`connection_lost`); queued re-prepare |
| Wrapper crash | Supervisor | Restart wrapper; routes re-prepared | Accepted fail (`agent_restarted`) |
| Kilo hang (no events, no HTTP answer) | Wrapper, about 35 s; up to two extra minutes while the workload reclaims at its memory cap | Restart Kilo, at most 3 in 10 min | Busy turn without real progress: submitted again once; otherwise accepted fail (`agent_unresponsive`, or `sandbox_out_of_memory` when the memory hold expired) |
| Kilo crash | Wrapper | Restart Kilo, at most 3 in 10 min | Same as Kilo hang, but the reason is `agent_restarted` |
| Dead event stream (Kilo still answers health) | Wrapper, after 6 reconnects in 2 min | Restart Kilo, at most 3 in 10 min | Same as Kilo hang (`agent_unresponsive`, or `sandbox_out_of_memory` when the memory hold expired) |
| Kilo restart budget used up | Wrapper | None until the next message | Queued and accepted fail (`agent_unavailable`) |
| Kilo final error | Wrapper | None (Kilo already retried) | Accepted fail with Kilo's reason |
| No real progress for 20 min, including silent tools | Native session supervisor | Bounded tree abort; runtime recovery if unconfirmed | Accepted fail (`no_progress`, or the retried assistant failure during a Kilo model retry), or routed error without a current turn |
| Native execution over 120 min | Native session supervisor | Bounded tree abort | Accepted fail (`execution_limit`), or routed error without a current turn |
| Idle 10 min, question pending | Sandbox DO | Stop the sandbox | Accepted fail (`sandbox_stopped`); a later answer is a new message |
| Sandbox gone | Provider via Sandbox DO | New allocation on next `prepare` | Accepted fail (`sandbox_lost`); queued re-prepare |
| Notification lost | Session DO backstop | — | Fail at 16.5 or 125 min |
| User Stop | Session DO | Abort the Kilo session only | Queued and accepted `cancelled` |
| Auto-commit or condense fails | Wrapper | None | Warning event; turn `completed` |
| Provider stop not confirmed | Sandbox DO | Logged; next `prepare` may create again | None; worktree deletion reports incomplete |

## 10. Interfaces

Session DO → Sandbox DO (RPC, returns at once): `prepare(route spec)` → route view,
`deliver(sessionId, messages)` → `sent` | `not_ready`, `abort(sessionId)`, `answer(sessionId,
reply)`, terminal create/resize/close/connect requests, worktree-change requests,
`release(sessionId)`, `status(sessionId)` (passive read). Preview resolves off the operation queue:
the Session DO `resolvePreviewTarget()` does a passive read of the Sandbox DO `previewTarget` and
returns provider coordinates; it enqueues nothing (see Preview).

Sandbox DO → Session DO (RPC notifications): `onRoute(update)` where the update is a route view
(`preparing(step)`, `ready`, `reconnecting`, `failed(reason)`) or `lost(reason)`, `onEvents(events)`,
`onOutcome(outcome)`.

Other callers of the Sandbox DO keep their current RPC: contained outbound credential lookup
(`resolveCredential`), runtime credential proxy, worktree deletion, sandbox status.

Bootstrap → Worker (HTTPS on the `WORKER_URL` host, `downloaded` mode only): `GET` one payload with
the artifact grant, and `POST` one startup-failure report with the wrapper launch credential. The
Worker forwards an admitted report to the Sandbox DO as `startup-failed`.

### Startup mode rollout

- A deploy does not replace a running native container, so an existing allocation keeps its mode.
- CI publishes runtime payloads create-only by content hash, and the descriptor last. The deploy
  reads an immutable handoff for the exact commit, and verifies the base image digest and both
  payloads before it deploys a `downloaded` target.
- Roll out on an isolated target first: `downloaded` on the all-in-one image, then `downloaded` on
  the runtime-free image, then production. Roll back the first step by mode and the second by image.
- The runtime-free image change relies on B1 (#7914), which is already merged: a running container
  captures under the image that it started with, including after DO reconstruction.
- `runtime-targets.json` owns mode and image. Deployment renders Worker vars and the native image
  from it. Real-provider qualification remains an explicit approval gate; see `runtime-rollout.md`.

### Runtime credential proxy

Modern runtime authorization uses the existing Worker facade for model, backend and native
ingest/export requests on every supported provider. Each outbound request resolves the current
Session-owned token through its renewing authorization path. No modern backing token reaches the
wrapper, and no capability or direct-token fallback can redeem the registration snapshot.

A legacy non-policy-bearing token uses the broker-issued Kilo capability whenever the sandbox has
any credential containment (Kilo, GitHub or Bitbucket), because that sandbox class carries the
outbound credential interceptor. A sandbox without containment has no broker boundary; such a
session is denied unless its token has modern runtime authorization, in which case it uses the
session-bound runtime credential proxy. A native user token is never projected into a route spec,
`session.prepare` frame or sandbox environment.

### Compatibility and rollout

Sessions created before containment metadata was stored, or while containment was disabled, may
have no safe Kilo credential path. Their first start, restore or resume after this change fails
quickly with `workspace_setup_failed`; the route diagnostic records the
`credential_upgrade_required` stage and the user is told to start a new session. No broad token is
substituted. Operators can re-enable containment (`CREDENTIAL_CONTAINMENT_ENABLED`) or modern
resource-token issuance for local development; contained sessions and managed SCM direct-token
paths continue to work. Existing sessions do not need a production migration: unsafe operations
fail closed when attempted.

Handles are per worktree scope, including in a shared checkout: one handle serves every member of
the scope. A handle is bound to the user, organization, authorization, worktree scope, current
allocation/provider instance and wrapper identity; the attestation `resourceId` is the member that
served it. A socket reconnect on the same wrapper keeps the handle valid; allocation or wrapper
replacement and authorization revocation invalidate it. Renewal checks current principal and
organization membership bindings and never extends the delegation lifetime.

Because the handle is scope-wide, revoking one member's handle no longer stops another member's
in-flight model calls while a surviving member can still serve; that member's **new** sends are still
denied. The usage `session_id` attribute on a forwarded request is the wrapper's forwarded
`X-KILOCODE-TASKID`; it is not verified in this repository that Kilo sets it per chat.

A modern worktree scope adopts one canonical handle shared by all of its member roots. When less than
the 1-hour proactive threshold remains on that canonical, `deliver` re-mints through an active member
whose live delegation outlives it (a joining prepare instead mints through itself and reads no
delegation), adopts the new handle for every member row, and fans the new `session.credentials` out to
every ready or preparing member; a superseded handle stays accepted and keeps its provider rules until
its own `exp`. While the current canonical
is still valid the route continues on it. Once it has verifiably expired the route fails
(`workspace_setup_failed`), whether no member's delegation is still live or a live member's handoff
mint failed: the verified-expiry check immediately before send is the gate. A ready member that missed a fanout is
reconciled with the current canonical immediately before its next prompt, and a preparing member on
`session.ready`, before it is published ready. An already-ended canonical is recovered through any
member that is still live. A fresh Git/Kilo grant re-issue still sends its frame even when the handle
string is unchanged, because Git material is independent of the proxy handle.

A turn or PTY that crosses handle expiry still receives a 401 from the facade; that is existing
behavior. Kilo's reaction to a 401 and its descendant-abort semantics are not verified in this
repository.

### Runtime compatibility and rolling deployment

No admission pause or fleet shutdown is required. Existing allocations keep their runtime keys,
HOME paths, per-session handles, and repository-only mixed credential compatibility.
They can finish active work, accept new work, admit sibling sessions, and renew credentials.

The Sandbox DO stores one runtime contract per allocation in `allocation_runtime_contract`:

- A missing record means an existing allocation and preserves legacy behavior.
- A new allocation starts `pending`. Its first authenticated wrapper selects `legacy` or `worktree`.
- The wrapper advertises `x-kilo-worktree-runtime: 1` on the WebSocket upgrade.
  Old Workers ignore this header; their strict `hello` schema remains unchanged.
- The contract stays fixed across reconnects, wrapper replacement, and DO restarts.
  A shared allocation rejects a wrapper without the capability before replacing its working socket.
- Normal allocation replacement clears the contract and permits fresh negotiation.

Registration retains `runtimeIsolation` for compatibility. The Sandbox removes it only from frames
for a negotiated shared allocation. Updated wrappers still honor it for legacy allocations.
This preserves old runtime and HOME identities. Shared HOME uses
`sha256(scopeId + "\0" + directory)` under the wrapper home root.

Deploy in this order:

1. Deploy `services/session-ingest` from the first stack PR. Wait for deployment success.
2. Deploy `services/cloud-agent-next` and its wrapper image from the complete stack, including these
   compatibility fixes. Keep API, web, and automated callers running.
3. Check an existing allocation: send a follow-up and add a sibling session.
   Check a fresh allocation: prepare a profile/permission session and two chats in one worktree.
   The fresh compatible allocation must share a runtime and handle; the existing allocation must keep its layout.

Use the `Deploy Cloudflare Workers` workflow (`deploy-workers.yml`) with the selected release ref.
Set `worker` to the service path above and `target_environment` to the target environment.
Its automatic changed-worker matrix runs services concurrently, so deploy the ingest prerequisite
separately before releasing the remaining stack.

The corrected intermediate wrapper PR preserves per-session behavior and can run with the old Worker.
Only the complete stack advertises worktree sharing. An old image starting during deployment remains
compatible and uses legacy behavior for that allocation's lifetime.

For `SandboxContainers` (`scheduling_policy: "durable_object"`), the new named image map affects future
starts. It does not replace running containers. Existing allocations migrate through their normal
lifecycle. See [Cloudflare scheduling policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/#configure-named-images).
Other providers retain their existing deployment and allocation lifecycle behavior.

After sharing activates, retain this contract negotiation in any Worker rollback build.
A pre-compatibility Worker cannot safely serve allocations already using shared handles.
Do not downgrade such allocations to an old wrapper image. Roll forward with a corrected compatible
build instead; no fleet shutdown is part of this rollout.

The stored admission containment selection determines the proxy grant's `direct` or `contained`
mode. The environment default is captured at registration when admission omitted a selection;
callers cannot choose proxy mode independently. Runtime authorization does not require SCM
containment: Cloudflare Sandbox and Cloudflare Containers support both modes, while Vercel still
requires containment. Unsupported modes and invalid modern facade configuration are rejected
before queuing work. Contained SCM resolution and Vercel policy remain enforced. MCP servers are
workspace configuration: sessions in one worktree share one runtime, and a session whose MCP set
differs from the warm runtime's fails with `Kilo worktree MCP configuration mismatch` rather than
running with another session's servers.

Sandbox DO ↔ wrapper (WebSocket frames): `hello`, `welcome`, `shutdown`, `heartbeat`, `heartbeat_ack`,
`session.prepare`, `session.progress`, `session.ready`, `session.failed`, `workspace.capture`,
`workspace.captured`, `session.credentials`, `session.prompt`, `session.abort`, `session.answer`, `session.release`, `session.events`,
`session.outcome`, `events_dropped`, terminal control requests, worktree-change requests,
worktree-deletion requests (`worktree.prepareDeletion`, `worktree.delete`; both answer with
`worktree.result`). Terminal bytes use the existing wrapper-to-Session-DO terminal socket.

### Startup mode rollout

- An image change requires capture to key a snapshot with the image that the allocation started
  with. Capture uses that recorded image, including after a Worker deploy. A legacy running
  allocation with no recorded image skips capture until the next allocation.

### Preview

Preview reaches a dev server in a live interactive (`workspace_*`) sandbox through a dedicated
per-port hostname. It handles ordinary HTTP and WebSocket upgrades.

- **Hostname dispatch.** Before any route match, the Worker tests the request hostname against its
  `PREVIEW_HOST_SUFFIX`: a hostname of exactly `<label>.<suffix>` is a preview request, and every
  other hostname falls through to the normal routes. The label is `p<port>-<workspace-uuid-hex>`
  (port 1024-65535; at most 63 characters). The Worker derives the session and port from the label
  alone and never selects a session from a path prefix, query or header.
- **Availability.** `PREVIEW_HOST_SUFFIX` turns preview on. `PREVIEW_ENABLED_IDS` (user or org
  IDs, `*` for all) limits who sees the preview UI; it is a UI gate only, and entry and proxying do
  not check it. The web app reads both through the Worker's
  `getPreviewOptions({ cloudAgentSessionId, organizationId? })` query, which answers the session's
  preview hostname with a `{port}` placeholder (`p{port}-<hex>.<suffix>`) or `enabled: false`. The
  `organizationId` is the web route's org and is not verified. The web app
  has no preview configuration and no copy of the label format; it adds the browser-facing Worker
  scheme and port, as the open hop does. One gate (preview enabled, the viewer can open a terminal,
  a `workspace_*` session) controls both the preview button and preview links in the chat: an
  assistant link to a loopback address with a port in range (`localhost`, `127.0.0.1`, `0.0.0.0`,
  `[::1]`, `[::]`) shows the real preview URL with its path, and a click mints a ticket for that
  port and path. A copied preview URL opened without the cookie gets the 401 below.
- **Entry exchange.** The web app mints a 60-second HS256 entry ticket (audience
  `cloud-agent-preview`, purpose `preview`, claims `userId`, `cloudAgentSessionId`, optional
  `organizationId`, `port`) and opens `<worker>/preview/open?ticket=<jwt>[&path=<path>]` on the
  Worker host. That hop verifies the ticket, derives the label from its claims, and answers **303**
  to `<label>.<suffix>/.kilo-preview/enter?ticket=<jwt>[&path=<path>]` on the same scheme and port;
  it does not run the access check or consume the ticket. A `GET`/`HEAD` on the enter path with
  a valid ticket runs the access check once, then consumes the ticket `nonce` through
  `StreamTicketNonceDO` (single use, as for stream and terminal tickets), sets a host-bound 1-hour
  session token (audience
  `cloud-agent-preview-session`, type `preview_session`) as a cookie, and answers **303** to the
  requested path with the ticket removed. The path is client input, so the enter step owns its
  check (`src/preview/return-path.ts`): only a same-host path that starts with one `/`, has no
  backslash or control character, is at most 2048 characters and is not under `/.kilo-preview` is
  kept; any other value lands on `/`. Cookie names are scheme-owned: `__Host-kilo_preview` over https,
  `kilo_preview` over http (local dev); both are HttpOnly, `SameSite=Lax`, `Path=/`, no `Domain`,
  `Secure` only over https. The entry ticket never reaches the document URL. Any method other than
  `GET`/`HEAD` answers 405.
- **Per-request access check.** Every proxied request (asset, form POST, WebSocket upgrade) validates
  the session token (signature, audience, type, exp, derived label) and re-runs
  `requireCurrentSessionAccess`. There is no in-isolate cache, so revocation takes effect on the next
  request, subject to any Hyperdrive query caching of the access query. A database outage fails the
  request instead of hiding revocation. Both tokens share one claims check; the label derived from
  the claims must equal the request label, which also proves the port and the `workspace_` session.
- **Off-queue transport and the physical boundary.** The Worker resolves coordinates with an
  off-queue path: Session DO `resolvePreviewTarget()` (eligibility and `sandboxId` only) → Sandbox DO
  `previewTarget` (the only owner of route and allocation state for preview; one storage pass, no
  enqueue, no wrapper traffic). The Worker then calls `fetch()` on the physical Durable Object
  that owns the port; the request carries the reserved `x-kilo-preview-*` markers so the physical DO
  selects the preview port path rather than the control path. The markers are a dispatch selector,
  not authentication: the trust boundary is the private DO binding plus ingress stripping, and the
  DO never falls through to the SDK `fetch()` (which can start a container) for a marked request.
  The path exists because a WebSocket `Response` cannot cross an RPC boundary back to the Worker,
  while a `fetch()` response can. The Worker strips client-supplied `x-kilo-preview-*` headers once,
  at the top of its default `fetch`, so no route can forward one into a sandbox DO.
- **No start, no wake.** Preview never starts, resumes or wakes an allocation. A request for a
  session whose sandbox is stopped or asleep fails without creating a generation; the user starts
  the session again.
- **Activity.** Preview does not update SandboxControl's activity anchor or request an explicit
  activity lease. SandboxControl's existing idle deadline still stops the allocation, even with
  preview/HMR traffic. Normal active-agent heartbeats still renew leases.
- **Reserved ports.** The physical DO refuses the provider's own control port with 403 before it
  opens the container port: 3000 for `cloudflare`; `cloudflare-containers` reserves none (`vercel`
  23456 is listed but unreachable while Vercel is unsupported). The physical DO owns this check
  because it is the one check a leaked marker cannot bypass. Only 1024-65535 are eligible. The table
  (`src/shared/reserved-ports.ts`) also feeds the Cloud Agent rules file, which tells the agent not
  to start servers on the reserved port, to use the port that its server prints, and to report the
  exact `http://localhost:<port>` URL. Legacy writers and the V2 wrapper (through
  `CONTROL_SANDBOX_PROVIDER` in its launch env) write the same `~/.kilocode/rules/cloud-agent.md`.
- **Origin and WebSocket.** A WebSocket upgrade, and any non-GET/HEAD request, is admitted only when
  `Origin` equals the preview origin; a foreign, `null` or missing `Origin` is 403 before the
  resolver or fetch. Ordinary GET/HEAD requests do not use `Origin` for admission. Upstream requests
  always carry `Host: localhost:<port>`. Every upstream request also forces `Origin:
  http://localhost:<port>`, not only when the browser sent the preview origin; this is a recorded
  deviation from the original plan (which rewrote only a matching origin) and is safer, because a
  sibling preview's origin is never forwarded to the app.

**Status map.** Every body is fixed text; the ticket and upstream error text are never returned.
Request and response bodies stream; there is no body-size cap.

| Condition | Status | Body |
|---|---|---|
| `/preview/open` or enter method other than `GET`/`HEAD`; proxied `TRACE`/`CONNECT` | 405 | `Method not allowed` |
| `/preview/open` while `PREVIEW_HOST_SUFFIX` is unset | 404 | `Preview is not configured` |
| Invalid or missing entry ticket on `/preview/open` or the enter path (signature, audience, purpose, claims, `exp`, `nonce`), or a label derived from it that does not name the host | 401 | `Preview ticket is missing or invalid` |
| Entry ticket whose `nonce` was already consumed | 401 | `Preview ticket was already used. Open the preview again from the chat.` |
| Ticket nonce store (`StreamTicketNonceDO`) throws on entry | 503 + `Retry-After: 1` | `Preview is temporarily unavailable` |
| Missing, invalid, expired or wrong-audience/type session token, or a derived label that does not name the host | 401 | `Preview session is missing or expired. Open the preview again from the chat.` |
| Proxied `/.kilo-preview/*` path | 404 | `Not found` |
| WebSocket upgrade or non-`GET`/`HEAD` with a foreign, `null` or missing `Origin` | 403 | `Cross-origin preview request rejected` |
| Access denied | 403 | `Session access denied` |
| Reserved port (`cloudflare` 3000), refused by the physical DO | 403 | `That port is reserved` |
| Access database unavailable | 503 | `Session access is temporarily unavailable` |
| Ineligible platform | 409 | `Preview is only available for interactive Cloud Agent sessions` |
| Unsupported provider | 409 | `Preview is not available for this sandbox provider` |
| Route preparing, or no session metadata yet | 503 + `Retry-After: 1` | `The sandbox is not ready` |
| Resolver RPC failure (after `withDORetry` retries a retryable DO error) or physical DO `fetch()` throw | 503 + `Retry-After: 1` | `Preview is temporarily unavailable` |
| Sandbox route failed or absent for this session, allocation stopped/stopping, no current `providerRef`, or the physical DO not running | 503 | `The sandbox is not running` |
| Request headers over the cap (40 forwarded, name > 128, value > 8192; bounds header work before the access query and DO calls) | 431 | `Preview request headers are too large` |
| Connection refused on the container port | 502 | `Nothing is listening on that port` |
| No upstream response headers within 60 s (a dev server can compile a page on first request) | 504 | `The server on that port did not respond in time` |

- **Accepted residuals.** The SDK physical DO name is the stable pinned sandbox id, so a
  resolve-to-fetch race can reach a replacement container of the same owner scope / same session
  sandbox (SandboxContainers is fenced by `allocationRef` + state; SandboxControl rejects other
  owners, and the per-request access check still applies). Kilo's `serve` listener binds loopback
  on 4096 or a random port, so a preview can reach it; the wrapper starts every `kilo serve` with
  its own random `KILO_SERVER_PASSWORD` and sends Basic auth on each of its own connections, so a
  preview request to that port gets 401 from Kilo. The physical boundary is still the
  sandbox/workspace (owner scope for shared sandboxes), not the individual chat. An entry ticket
  is single use and expires after 60 seconds, so a stolen ticket yields a session only if the thief
  uses it before its owner does. Service workers are not blocked, so an app on a stable
  `(session, port)` origin can register one. Established WebSockets are not re-authorised after
  upgrade: revocation applies to new requests and upgrades only. Cookie jars are not guaranteed
  independent: the preview zone must be a separate registrable site from every trusted app origin,
  but apps can still set parent-domain cookies, and `*.localhost` is not a faithful site-isolation
  model. The entry ticket is not bound to the browser that asked for it. Any user can mint a ticket
  for their own session and send the `/preview/open` link to another user, whose browser then runs
  the sender's app on a sibling host of the zone. Until the zone is on the Public Suffix List, that
  app can set `Domain=<zone>` cookies: they make the other user's preview requests fail with 431,
  or they put cookies into that user's dev apps. The enablement checklist makes the list entry a
  prerequisite. The entry ticket is carried in the `/preview/open` and enter URLs, so platform
  observability or Logpush may capture it; single use and the 60-second TTL bound replay.
  The `@cloudflare/containers` `Container` constructor calls `renewActivityTimeout()` when an evicted
  DO wakes, so a preview request that wakes an evicted DO can extend the SDK sleep timer; our code
  paths never call it.
- **Enablement checklist.** Put the preview zone on a separate registrable site from every trusted
  app origin. Add the zone to the Public Suffix List, and set `PREVIEW_HOST_SUFFIX` in production
  only after the main browsers ship that entry. `PREVIEW_ENABLED_IDS` does not reduce this exposure:
  it gates only the UI, so with the suffix set any user can mint a ticket and send the link. A pilot
  before the entry ships needs a server-side gate on ticket mint and entry, which does not exist.
  With the entry, each `<label>.<zone>` is its own site: a sibling host cannot set zone-wide
  cookies, and `SameSite` treats it as cross-site. (We did not choose a browser-bound ticket, such
  as a POST open hop with an `Origin` allow-list: the browser sends `Origin: null` after a
  cross-origin redirect, so the web app would have to post to the preview host directly.) Add DNS
  `*.<zone>`; add the Worker route `*.<zone>/*`; issue a certificate covering the wildcard label;
  set the Worker `PREVIEW_HOST_SUFFIX` to `<zone>`; redeploy the Worker. The web app needs no
  change: it shows the preview button once the Worker reports preview as enabled. The `kilo serve`
  password is in the wrapper, so ship a sandbox image with it before you enable preview; an older
  image leaves `kilo serve` open to a preview of its port.
- **Second hosted provider (follow-up).** A provider-native inbound port is the eventual second
  path, but it needs ports declared at sandbox creation: `createSandbox` in
  `src/agent-sandbox/vercel/vercel-sandbox-rest-client.ts` sends none, and the creation response
  carries `routes[{ url, subdomain, port }]`. Routing would follow those routes. The published URLs
  are public, so a Worker proxy behind this auth would be required to keep the access check.
  Until that exists the resolver returns 409 `unsupported_provider` without a provider call.

### Public mapping

New states map onto the current public contracts; no public shape changes.

| New state | `/stream` (`src/shared/protocol.ts`) | Report `run.status` | Callback `status` |
|---|---|---|---|
| Message `queued` | `cloud.message.queued` | `queued` | — |
| Message `accepted` | `cloud.message.sent` | `accepted` | — |
| Message `completed` | `cloud.message.completed` | `completed` | `completed` |
| Message `failed` | `cloud.message.failed`, `status: 'failed'`, reason; `error` is the reason's text from `failure-messages.ts` (Kilo text passes through) | `failed` with stage and code | `failed` |
| Message `cancelled` | `cloud.message.failed`, `status: 'interrupted'`, reason `interrupted` | `interrupted` | `interrupted` |
| Route `preparing(step)` | `preparing` v2 row (`attemptId` = route attempt, `triggerMessageId` = oldest queued message; the step's detail is its `latestDetail`) and `cloud.status` `preparing`. A stepless view for the same attempt keeps the current step | — | — |
| Route `ready` | `cloud.status` `ready` | — | — |
| Route `failed` | `cloud.status` `error` | — | — |
| Finalization running | `cloud.status` `finalizing`, from a wrapper `finalizing` event; `ready` again on the outcome | — | — |
| Stale Kilo `busy` after a turn ends | When Kilo's last root status is `busy` or `retry`, an accepted message settled after it, and none is accepted now, `connected` carries `sessionStatus: idle`, so a reload after a hang or kill does not apply that stale status. Otherwise `connected` omits it and Kilo's replayed status applies, including native work without a Cloud message | — | — |

Reports carry `failureStage` and `failureCode` from the closed pairs in
`packages/worker-utils/src/cloud-agent-queue-report.ts`. `classifyControlPlaneFailure`
(`src/telemetry/control-plane-failure.ts`) stays the one owner of this mapping; its cases change to
the new reasons. The `session_message_committed` diagnostic keeps its name and fields so the
failure monitors keep working.

| Reason | Stage / code |
|---|---|
| `preparation_timeout` | `pre_dispatch` / `wrapper_start_failed` |
| `workspace_setup_failed` with the failed step's subtype | `pre_dispatch` / `workspace_setup_failed` |
| `billing_blocked` (actual compute credit denial) | `pre_dispatch` / `payment_required` |
| `billing_unavailable` (existing Vercel admission failure) | `pre_dispatch` / `admission_billing_unavailable` |
| `invalid_configuration` (proven provider configuration failure) | `pre_dispatch` / `sandbox_connect_failed` |
| `agent_unavailable` | queued: `pre_dispatch` / `kilo_server_failed`; accepted: `post_dispatch_no_activity` / `wrapper_disconnected` |
| `connection_lost`, `sandbox_lost`, `agent_restarted`, `agent_unresponsive`, `sandbox_out_of_memory` | `post_dispatch_no_activity` / `wrapper_disconnected` |
| `no_progress`, `no_outcome` | `post_dispatch_no_activity` / `wrapper_no_output` |
| `prompt_failed` | `post_dispatch_no_activity` / `wrapper_error_before_activity` |
| `sandbox_stopped` (idle while waiting on the user), `execution_limit` | `interruption` / `system_interrupt` |
| Kilo final error, or `no_progress` during a Kilo model retry | `agent_activity` / `assistant_error`; responsibility from the existing assistant-failure helpers, so Kilo and provider errors stay attributed to them |
| Stop | `interruption` / `user_interrupt` |
| `runtime_artifact_unauthorized`, `runtime_artifact_invalid`, `runtime_cli_probe_failed`, `runtime_supervisor_missing` | `pre_dispatch` / `wrapper_start_failed` |
| `missing_metadata`, `invalid_model`, payment required | Unchanged |

## 11. Acceptance scenarios

Each scenario runs on the real local stack (Worker, both DOs, sandbox container, supervisor,
wrapper, Kilo, fake LLM) and checks durable message states, stream events, report and callback
counts.

1. **Cold first message.** Preparation steps are visible; the message completes; one callback.
2. **Warm follow-up.** No preparation rows; the message completes.
3. **Follow-up during an ordinary prompt turn.** B goes to Kilo promptly; A and B complete together
   from one outcome; one callback. This does not require bypassing a pending command/summary response.
4. **Kilo final error with A and B accepted.** Both fail with Kilo's reason; the next message
   works.
5. **Two chats in one worktree, two worktrees in one sandbox.** Turns stream at the same time; Stop
   in one chat does not affect the others. Deleting the chat that issued the scope handle leaves
   surviving chats usable: their in-flight model calls keep working through a surviving member, whose
   attestation `resourceId` is that member, while the deleted root's ingestion/export and title writes
   are denied. Revoking the deleted member's handle does not stop a surviving chat's in-flight model
   calls while another member can serve, but a revoked member's new sends are denied. The usage
   `session_id` stays the forwarded `X-KILOCODE-TASKID`; this repository does not verify that Kilo
   sets it per chat. Last-member release retires the scope.
6. **Slash commands and attachment.** `/compact` summarizes the session; another known command runs
   as a command; an attachment reaches the model.
   A follow-up may wait for the command/summary response, then reaches Kilo in arrival order;
   immediate intake during those operations is not a completion gate. Credential refresh with
   native idle inspection and attachments held in either release order must not retire a pending
   or sibling submission client.
7. **Contained credentials.** Clone and Kilo calls work through contained outbound credential
   lookup, not only with direct credentials. Compatible legacy siblings can both publish/export
   native history through the installed shared alias. Busy renewal and a new preparation attempt
   leave that alias usable with fresh backing material. Policy failure never publishes rejected
   credentials; physical replacement rejects old aliases and preserves attempt deadlines. Eligible
   managed GitHub HTTPS clone and fetch carry the control alias on the first request and reject
   every redirect, while the credential flow stays contained resolution, repository-authorized
   redemption, and the bounded Retry-After handler.
8. **Stop during a turn.** Messages `cancelled` at once; Kilo aborted; the sandbox and the other
   routes keep running; the next message works on the warm route.
9. **Setup command fails.** Queued message fails with a visible reason; after fixing the setup the
   next message prepares again. Exhausted prepare/deliver transport retries recover through one
   scheduled pass without another send. A hung RPC releases admission and Stop within their transport
   bounds; late completions cannot revive cancelled messages. If attempt B starts but its prepare
   response is lost, B progress/ready is adopted from passive authority and stale A ready/failed cannot
   settle B's work. Reconstruction retains recovery/backstop deadlines; Stop, cancellation and deletion
   clear queued recovery without dispatch or duplicate reports/callbacks. Persistent transport loss
   exhausts the one pass without polling preparation or replaying accepted work.
10. **Socket drop, wrapper returns within 90 seconds.** The turn completes; no message fails.
11. **Socket down for 90 seconds.** The sandbox stops; accepted messages fail (`connection_lost`);
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
16. **No progress.** Every native execution, including autonomous work without a Cloud turn,
    is interrupted after 20 minutes without real progress (`no_progress`). A silent running
    tool gets the same bound. User waits pause no-progress time; the separate 120-minute
    wall-clock cap (`execution_limit`) remains in force. A stall while Kilo retries the model
    request fails as the retried assistant failure, for example `rate_limited`, so a provider
    condition is not counted as a platform failure. After confirmed interruption, an
    otherwise idle sandbox stops after its normal 10-minute grace; active siblings retain it.
17. **Auto-commit fails.** The turn completes with a visible warning.
18. **Question answered live.** A question during a turn is answered; the same turn continues and
    completes.
19. **Kilo hangs during a model call.** The wrapper restarts Kilo within about 1 minute.
     Before any real progress, it may submit the message again once; a second hang fails it
     (`agent_restarted`). After observed assistant output, the progressed turn fails
     `agent_restarted` and a fresh message recovers the same chat. The real `first-token`
     fixture exercises this latter path: it emits a native text delta before the freeze.
     The failed original message remains present once in Kilo history.
     Held retired submissions rejected before or after the recovery callback cannot emit
     `prompt_failed` or block redispatch. A prompt first received during restart keeps that one
     recovery allowance; genuine application errors and real-progress work are not replayed as
      recoverable transport failures. Stop/release/new-turn fencing remains effective.
20. **Wrapper socket admission.** Missing/malformed, forged and wrong-sandbox credentials never
    resolve a Sandbox DO stub. Correctly signed retired allocations receive shutdown; terminal
    Worker-local rejection and stale-allocation rejection exit the wrapper cleanly, while ordinary
    network failure still reconnects. Silent, malformed-frame and non-hello candidates close at their
    original deadline after reconstruction, even while stopped, without changing allocation/route
    state or initializing provider work. Two concurrent candidates and overflow leave a healthy
    bound socket unchanged until an authorized reconnect completes; late closes retain their fence.
21. **Notification backpressure.** Flood events while a Session peer stalls: retained entries and
    UTF-8 bytes stay within 1,000 / 8 MiB, queued age uses the original two-second deadline and at most
    four lanes run. Healthy siblings can receive ready/outcome independently; retained per-session
    events and route transitions stay ordered before outcomes. More than four sessions are selected
    round-robin, but four occupied slow lanes may cause bounded fifth-session loss. Critical-only
    overflow drops newest, loss diagnostics stay bounded/internal and expired queue heads make no RPC.
    Heartbeats, alarms, stop and reconnect continue while notifications are held. Release retires
    references; reconstruction replays no notification backlog. Public events, reports, callbacks
    and the 16.5/125-minute lost-notification backstops are unchanged.
22. **Permanent versus transient creation failure.** Balance lost after send preflight fails queued
    work promptly with `billing_blocked`, not preparation timeout. Proven local invalid configuration
    fails promptly with `invalid_configuration`. The safe stream reason, durable route/message,
    report stage/code and one report/callback per terminal batch stay consistent; no raw provider
    detail is forwarded. Stopping, meter outages, network/5xx, throttling and recoverable conflicts
    keep the ten-second pause, immutable attempt and original deadline, then can succeed. Owned refs
    use the existing stop ladder and retain unconfirmed physical evidence. Late results after hello
    cannot fail a healthy sibling or clean up its allocation. After restoration, a new message in
    the same session succeeds without changing the earlier terminal message or duplicating effects.
23. **Preview over the preview host (local fixture).** With Worker `PREVIEW_HOST_SUFFIX=localhost`,
    fetch the Worker with `Host: <label>.localhost` and a web-minted entry URL: the 303 sets an
    HttpOnly `kilo_preview` cookie and its `Location: /` carries no ticket; a follow-up GET loads the
    fixture; a form POST with the preview `Origin` echoes the body and never sees `kilo_preview`; a
    foreign or `null` `Origin` POST is 403; a WebSocket echo round-trips; `GET /health` on the worker
    host still returns health JSON; a reserved port (3000) is 403 well under 5 s and never reaches
    the fixture; a closed port is 502 well under 5 s; a chunked or over-2 MiB body returns intact. A
    local run does not prove hosted DNS/TLS/providers, the native Containers path, or no-wake.
24. **Downloaded runtime start and restore.** A fresh `downloaded` start runs the selected CLI and
    wrapper. A snapshot captured with runtime A, restored with runtime B, runs only B: A never
    reaches `hello`. User files and configuration stay. Absent configuration keeps `preinstalled`
    unchanged.
25. **Downloaded runtime startup failure.** An unauthorized download or a failed CLI probe fails
    queued work promptly with `runtime_<code>`, before the first-connect timer. If the bootstrap
    exits before the first PID 1 check of a repository start and the provider failure wins, one
    in-attempt image start runs first. `base_incompatible` after a restore starts the next
    allocation from the image, also when the report arrives before `launch` returns.

Fault scenarios use existing harness faults (container kill, pause, socket recycle through the
wrapper's SIGUSR1 handler) plus harness additions for Kilo and wrapper process kill. Timer overrides keep long scenarios short. A local run does not prove
provider stop reliability, billing or hosted timing; those are checked on a deployed test Worker.

## 12. Accepted risks and out of scope

- A delivery retried after an unclear failure can make Kilo process a prompt twice.
- A turn submitted again after a Kilo restart can cost a second model request when the first one
  reached the provider but produced no output yet.
- The cause of the Kilo hang is inside Kilo and is not fixed here; the restart only recovers it.
- A legitimate operation that remains completely silent for 20 minutes is interrupted,
  including long-running tools. This is a resource policy, not proof the operation was broken.
  The separate native execution cap is 120 minutes and the lost-outcome Session backstop
  remains 125 minutes. Observation gaps use bounded runtime recovery instead of claiming
  the session made no progress.
- A prompt frame lost when the socket breaks stays `accepted` until the next outcome or the backstop.
- Notifications are best effort; the Session DO backstop bounds a lost one.
- An unconfirmed provider stop is logged; the container may run until the provider stops it.
- Until the bootstrap execs the supervisor, the artifact grant is in the PID 1 argv and in provider
  start metadata. Its narrow scope and short expiry bound the exposure.
- A restored snapshot is trusted like its owner's own container. The bootstrap does not defend
  against a replaced host tool in the root filesystem.
- Remote native qualification of `downloaded` is pending: restore from A to B, install time on the
  minimum instance, and provider retention of start metadata.
- A killed container is not found by polling the provider. It is a wrapper connection that does not
  return. The user waits at most the reconnect window, then the message fails `connection_lost`.
- The reconnect window is short so a queued message does not wait long on a wrapper that is gone. A
  live wrapper reconnects within seconds (backoff 1 s to 30 s; supervisor restart 1 s to 16 s), but
  one cut off from the Sandbox DO for longer than 90 s, for example during a platform outage, loses
  its accepted turn (`connection_lost`).
- Sibling chats in one directory are not compared for profile environment differences: `ensure`
  guards only the credential class and the MCP set, and the last `installCredentials` frame decides
  the desired environment after the next restart. This predates the directory-key flip for legacy
  shared directories.
- Out of scope: Kilo and model-provider retry policy, workspace file recovery after sandbox loss,
  the legacy plane.
