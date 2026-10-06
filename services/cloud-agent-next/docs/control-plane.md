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
| Worker | Authentication, organization and worktree access, billing eligibility on send, tRPC, `/stream` and terminal WebSocket upgrade | Message, route or sandbox state |
| Session DO, one per session | Message queue and message states, route view, event log and client stream, question/permission projection, per-message reports and batch callback, current runtime authorization and delegated Kilo token renewal | Sandbox lifecycle, preparation steps, Kilo health, turn outcome |
| Sandbox DO, one per `sandboxId` | Allocation lifecycle through the provider adapter, wrapper socket, per-session routes, forwarding in both directions, activity, idle stop and provider lease, billing admission and attribution, wrapper and session credentials | Message states, Kilo health, turn outcome, workspace steps, physical billing intervals (container lifecycle owns them) |
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
  Sessions in one worktree share the checkout. A Kilo runtime serves one directory, or one session
  when runtime isolation is per session.
- Compatible routes reference one Sandbox-owned credential scope. Scope membership includes every
  eligible root Kilo session; it does not merge modern per-session runtime authorization.
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
are derived from the owners' timers so the backstop never ends work that its owner still runs:
queued = reconnect window (90 s) + one preparation attempt (12 min) + 3 min, which covers the
longest normal wait (a message sent while the socket is down, then a fresh attempt on a new
sandbox); accepted = turn hard cap (120 min) + 5 min. After every message change the Session DO sets
the alarm to the earliest backstop, transport-recovery, report or callback obligation, and clears it
when none remains (for example after Stop and successful terminal reporting).

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

### Allocation state

| State | Leaves to | On | Timer |
|---|---|---|---|
| `stopped` | `creating` | `prepare` for a session | — |
| `creating` | `starting` | Provider created the sandbox and launched the supervisor | Provider call 2 min |
| `creating` | `creating` or `stopped` | Transient create error: retry after a 10 s pause while a route deadline remains, else stop | — |
| `creating` | `stopping` or `stopped` | Classified permanent create/launch error: fail preparing routes immediately; an owned physical ref uses the existing stop ladder | Existing ladder when a ref exists |
| `starting` | `connected` | Wrapper `hello` accepted | 5 min without `hello` → `stopping` |
| `connected` | `disconnected` | Socket closed, or no heartbeat for 45 s | — |
| `connected` | `stopping` | No activity for 10 min, or explicit stop or delete | Idle 10 min |
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

The wrapper heartbeat (every 5 s) carries `active`. The sandbox is active while a route prepares,
a Kilo session is busy or finalizing and not waiting for the user, a terminal has input, or a message
was delivered in the last minute. After 10 minutes without activity the Sandbox DO stops the
sandbox. Waiting on a question or permission is not activity. While the sandbox is active, the
Sandbox DO renews the provider lease (`ensureLeaseAtLeast`) so the provider does not expire a busy
sandbox on its own.

### Billing, credentials and deletion

These keep their current owners and evidence; the rewrite ports them, it does not redesign them.

- Compute billing follows the physical container lifecycle (`metered-billing-lifecycle.ts`), not
  the routing state.
- The Sandbox DO mints the wrapper launch credential and owns one canonical Git/Kilo grant per
  compatible credential scope in DO SQLite. Route rows reference that owner rather than storing
  writable grant copies. Compatibility requires the same user, organization, worktree/directory,
  repository authority, targets, provider/physical binding, containment and backing authorization
  class. A scope cannot replace a legacy backing token with a modern delegated token. Repository-only
  mixed scopes use separate canonical identities per authorization class; mixed managed-SCM scopes
  and other incompatible scope or directory reuse fail closed without changing the surviving grant. Modern handles stay
  per session. It serves contained outbound credential lookups
  (`resolveCredential`), runtime proxy authorization and Vercel network policy as today. Grants
  last 4 hours. When less than 1 hour remains, `deliver` re-issues the grant with freshly selected
  Git and legacy Kilo material and sends them in a `session.credentials` frame before the prompts;
  the wrapper installs them into the running route and Kilo runtime. Modern runtime-authorized
  sessions use a per-session runtime proxy handle on Cloudflare Sandbox, Cloudflare Containers and
  Vercel instead of a Kilo capability wrapping the registration token. The Session DO owns the
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
  and new scopes retain normal shared legacy membership and per-session modern authorization.
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

- **Key.** When a route is first prepared, the Sandbox DO hashes the owner and the repository URL
  with HMAC-SHA256 under a Worker secret. Env is not part of the key: setup re-runs on every start.
  It stores the digest on the route (`repo_key`) and keeps it across attempts. No key is computed, and
  no snapshot used, when the owner is not enrolled (`CONTAINER_REPO_SNAPSHOT_IDS`, or the legacy
  org-only `CONTAINER_REPO_SNAPSHOT_ORG_IDS`), the route
  has no repository, the provider cannot capture, or the secret is missing. Scope is per user;
  per org is a change to that one field.
- **Start.** `launch` receives the key of the routes waiting for the allocation: exactly one key,
  else none. `SandboxContainers` appends the image, and starts from the
  repository snapshot in the `REPO_SNAPSHOTS` KV index when it has one for that digest, else from
  the image. `launch` returns `startSource`. A failed repository start removes the index entry.
- **First start only.** The Sandbox DO remembers how the previous allocation started and whether its
  wrapper connected. When a repository start never connected (for example the first-connect timeout
  stopped it), the next launch discards the entry and starts from the image. A broken snapshot
  costs one attempt.
- **Capture.** `session.prepare` carries `capture: true` when the route has a key and the provider
  can capture. The wrapper decides whether to capture (a fresh clone, or an adopted snapshot that is
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
  cold. The platform keeps an unused snapshot for 30 days; there is no list or delete API.

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

- Connect, send `hello` (`wrapperId`, `allocationId`, protocol version), wait for `welcome` or
  `shutdown`. On `shutdown`, permanently close the connection and exit with code 0, even when the
  rejection arrives before `welcome`. Terminal admission rejection must not become an HTTP 401
  reconnect loop. The wrapper passes the signed launch envelope as its bearer unchanged.
- Reconnect forever with backoff from 1 s to 30 s plus jitter. Never exit because the connection
  failed. SIGUSR1 closes and reopens the connection (existing test hook).
- While disconnected, keep outbound frames in one bounded buffer (for example 1,000 frames or 8 MB).
  Keep outcome and route frames; drop the oldest event frames first and send one `events_dropped`
  frame to the Sandbox DO as internal loss evidence. It has no public marker/Session forwarding contract.

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
no Kilo home and no git credential. Process env never reaches the disk. Files setup wrote from env stay in
the snapshot; setup re-runs on every start and rewrites them.

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
  remediation blocker or a requirement for a Kilo/SDK change. Ordinary prompts still reach Kilo
  during model execution through `prompt_async`. Kilo owns its native queue and execution; the
  wrapper must not add a shadow native queue or concurrent HTTP to bypass command ordering.
- The wrapper tracks each Kilo root session through Kilo's status, idle, turn-close and error events,
  and remembers the last submitted `messageId`.
- Outcome frame: `sessionId`, `status`, optional `reason`, `lastMessageId`.
  - `completed`: Kilo emitted `session.turn.close` with reason `completed`, finalization is done,
    and no later prompt remains unfinished. `session.idle` and a `superseded` turn-close are not
    completion signals. The wrapper does not keep a copy of Kilo's native prompt queue.
  - `failed`: Kilo reports a final error; 7 minutes without real progress while no tool part is
    running; the 120-minute hard cap; Kilo restarted during the turn after real progress, or a
    second time; prompt submission failed. For no progress and the cap, the wrapper aborts the
    Kilo session first. Real progress is text, reasoning or tool events from the routed root
    session or any session resolved into its descendant tree; busy, retry and heartbeat events are
    not, and waiting on the user pauses the clock. The turn owns a set of running tool parts keyed
    by Kilo session ID and part ID: a part that is `running` in the routed root session or its
    resolved descendant tree holds the no-progress clock until Kilo reports that part completed or
    errored; Kilo owns each tool's own timeout, and the 120-minute cap still applies.
  - `cancelled`: the turn was aborted.
- Finalization (auto-commit, condense) runs after Kilo's completed turn-close. The wrapper sends a `finalizing`
  event when it starts. Its failures are warning events; the outcome stays `completed`. A prompt
  that arrives during finalization follows the same submission rules, including an accepted wait
  behind a pending command/summary response; finalization itself does not block submission. The
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
- That recovery selection occurs only in the restart-completion turn transition. It invalidates
  the retired submission chain and rebuilds the existing inbox in original message order, without
  waiting for held retired HTTP results. Restart-caused transport rejection is recognized by the
  retired client identity even after replacement completes, and cannot independently fail the turn
  as `prompt_failed`. Native application and attachment errors still fail; Stop/release/new-turn
  fencing rejects late effects. Materialization is shared by first dispatch and recovery.
- Only actual resubmission spends the once-only allowance. A turn received during restart whose
  prompts were never dispatched gets its first dispatch without spending it. Recovery preserves
  the turn's existing clocks, progress, user-wait pause and allowance; credential maintenance does
  not reset them. MCP-isolated runtime keys remain independent.
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

The provider launch command is not the only starter. On the native Cloudflare Containers runtime the
container main process is the supervisor: `start()` is issued with `['/bin/sh', supervisor-path]` as
its entrypoint, and PID 1 identity (`/proc/1/cmdline`) is the issuance confirmation, bounded by the
wrapper readiness deadline. PID 1 identity is not wrapper readiness: the wrapper socket and the
Sandbox DO `starting` timer stay the readiness owner, and no provider poll or wrapper-child probe is
added for that path. Sandbox SDK and Vercel still exec the supervisor against a living PID 1.

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
| Sandbox DO | Wrapper first connect | 5 min from launch | Stop the sandbox |
| Sandbox DO | Unbound wrapper hello | 30 s from socket admission, not scaled | Close candidate only; attachment deadline survives hibernation and participates in the existing alarm even while stopped |
| Sandbox DO | Heartbeat | 45 s | Treat the socket as lost |
| Sandbox DO | Reconnect | 90 s from the last frame received | Stop the sandbox |
| Sandbox DO | Route preparation | 12 min per preparation attempt | Route `failed` (`preparation_timeout`) |
| Sandbox DO | Session notification | 2 s from enqueue including queue wait and RPC retries, not scaled | Drop expired queued work before RPC; bounded best-effort loss, existing Session backstop |
| Sandbox DO | Idle | 10 min without activity | Stop the sandbox |
| Sandbox DO | Provider lease | Existing lease length, renewed while active | Provider may stop an inactive sandbox |
| Sandbox DO | Credential grant | 4 h; re-issued on `deliver` below 1 h | — |
| Sandbox DO | Provider stop | Existing ladder | Log unconfirmed stop; routing state `stopped` |
| Sandbox DO | Repository capture call | 5 min 5 s (container DO: 5 min) | Answer `ok: false`; preparation continues |
| Wrapper | Preparation steps | Section 7 | Route `failed` with the step reason |
| Wrapper | Adopt a repository snapshot | 2 min | Empty the directory and clone |
| Wrapper | Wait for a capture | 5 min 10 s | Continue without a snapshot |
| Wrapper | SSE silence | 30 s | Health request |
| Wrapper | Kilo health request | 5 s | Restart Kilo |
| Wrapper | SSE reconnects | 6 in 2 min | Restart Kilo |
| Wrapper | Kilo restart budget | 3 in 10 min | Routes `failed` (`agent_unavailable`) |
| Wrapper | No real progress and no running tool | 7 min | Abort; `failed` (`no_progress`) |
| Wrapper | Turn hard cap | 120 min | Abort; `failed` (`execution_limit`) |
| Wrapper | Reconnect backoff | 1 s to 30 s, forever | — |
| Supervisor | Wrapper restarts | 5 in 10 min | Stop restarting |

## 9. Failures

| Failure | Detected by | Recovery | Message effect |
|---|---|---|---|
| Transient provider create error | Sandbox DO | Retry after a 10 s pause, within the unchanged route deadline | Queued fail at the deadline |
| Actual compute credit denial | Provider adapter / existing Vercel billing admission | New message after adding credits | Queued fail promptly (`billing_blocked`) |
| Proven invalid/unsupported provider configuration | Provider adapter | New message after correcting configuration | Queued fail promptly (`invalid_configuration`) |
| Wrapper never connects | Sandbox DO, 5 min | Stop; new allocation within the route deadline | Queued fail at the deadline |
| Clone network error | Wrapper | 3 attempts | Queued fail (`workspace_setup_failed`) |
| Repository snapshot cannot be used (start, adopt) | Container DO, wrapper | Start from the image, or clone | None; a cold start |
| Repository capture fails or times out | Sandbox DO, wrapper | Continue without a snapshot | None |
| Setup command fails | Wrapper | None | Queued fail with the command output visible |
| Socket drops, wrapper returns | Sandbox DO | Wrapper reconnects | None |
| Socket down 90 s | Sandbox DO | Stop the sandbox | Accepted fail (`connection_lost`); queued re-prepare |
| Wrapper crash | Supervisor | Restart wrapper; routes re-prepared | Accepted fail (`agent_restarted`) |
| Kilo hang (no events, no HTTP answer) | Wrapper, about 35 s | Restart Kilo, at most 3 in 10 min | Busy turn without real progress: submitted again once; otherwise accepted fail (`agent_restarted`) |
| Kilo crash or dead event stream | Wrapper | Restart Kilo, at most 3 in 10 min | Same as Kilo hang |
| Kilo restart budget used up | Wrapper | None until the next message | Queued and accepted fail (`agent_unavailable`) |
| Kilo final error | Wrapper | None (Kilo already retried) | Accepted fail with Kilo's reason |
| No real progress and no running tool 7 min | Wrapper | Abort the turn | Accepted fail (`no_progress`) |
| Turn over 120 min | Wrapper | Abort the turn | Accepted fail (`execution_limit`) |
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
`release(sessionId)`, `status(sessionId)` (passive read).

Sandbox DO → Session DO (RPC notifications): `onRoute(update)` where the update is a route view
(`preparing(step)`, `ready`, `reconnecting`, `failed(reason)`) or `lost(reason)`, `onEvents(events)`,
`onOutcome(outcome)`.

Other callers of the Sandbox DO keep their current RPC: contained outbound credential lookup
(`resolveCredential`), runtime credential proxy, worktree deletion, sandbox status.

### Runtime credential proxy

Modern runtime authorization uses the existing Worker facade for model, backend and native
ingest/export requests on every supported provider. Each outbound request resolves the current
Session-owned token through its renewing authorization path. No modern backing token reaches the
wrapper, and no capability or direct-token fallback can redeem the registration snapshot. Legacy
non-policy-bearing tokens retain their existing credential paths and access limits.

Handles remain per session, including in a shared checkout. They are bound to user, organization,
authorization, Cloud Agent session, Kilo root session, current allocation/provider instance and
wrapper identity. A socket reconnect on the same wrapper keeps the handle valid; allocation or
wrapper replacement and authorization revocation invalidate it. Renewal checks current principal
and organization membership bindings and never extends the delegation lifetime.

The stored admission containment selection determines the proxy grant's `direct` or `contained`
mode. The environment default is captured at registration when admission omitted a selection;
callers cannot choose proxy mode independently. Runtime authorization does not require SCM
containment: Cloudflare Sandbox and Cloudflare Containers support both modes, while Vercel still
requires containment. Unsupported modes and invalid modern facade configuration are rejected
before queuing work. Contained SCM resolution and Vercel policy remain enforced, and MCP still
requires independent per-session runtimes.

Sandbox DO ↔ wrapper (WebSocket frames): `hello`, `welcome`, `shutdown`, `heartbeat`, `heartbeat_ack`,
`session.prepare`, `session.progress`, `session.ready`, `session.failed`, `workspace.capture`,
`workspace.captured`, `session.credentials`, `session.prompt`, `session.abort`, `session.answer`, `session.release`, `session.events`,
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
| Route `preparing(step)` | `preparing` v2 row (`attemptId` = route attempt, `triggerMessageId` = oldest queued message; the step's detail is its `latestDetail`) and `cloud.status` `preparing`. A stepless view for the same attempt keeps the current step | — | — |
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
| `billing_blocked` (actual compute credit denial) | `pre_dispatch` / `payment_required` |
| `billing_unavailable` (existing Vercel admission failure) | `pre_dispatch` / `admission_billing_unavailable` |
| `invalid_configuration` (proven provider configuration failure) | `pre_dispatch` / `sandbox_connect_failed` |
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
3. **Follow-up during an ordinary prompt turn.** B goes to Kilo promptly; A and B complete together
   from one outcome; one callback. This does not require bypassing a pending command/summary response.
4. **Kilo final error with A and B accepted.** Both fail with Kilo's reason; the next message
   works.
5. **Two chats in one worktree, two worktrees in one sandbox.** Turns stream at the same time; Stop
    in one chat does not affect the others; deleting the runtime creator leaves surviving model,
    Git and native history access usable. Deleted-root ingestion/export and deleted modern handles
    are denied; last-member release retires the scope.
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
16. **No progress.** A turn with no real progress and no running tool part for 7 minutes fails
    (`no_progress`). A turn whose only activity is a tool part `running` in the routed root session
    or its resolved descendant tree is not failed until Kilo reports that part completed or errored,
    or until the 120-minute hard cap (`execution_limit`).
17. **Auto-commit fails.** The turn completes with a visible warning.
18. **Question answered live.** A question during a turn is answered; the same turn continues and
    completes.
19. **Kilo hangs before the first model call** (Kilo frozen with SIGSTOP while the fake LLM holds
    the first token). The wrapper restarts Kilo within about 1 minute and submits the message
    again; it completes; Kilo history has the user message once. A second hang in the same turn
     fails it (`agent_restarted`).
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

Fault scenarios use existing harness faults (container kill, pause, socket recycle through the
wrapper's SIGUSR1 handler) plus harness additions for Kilo and wrapper process kill. Timer overrides keep long scenarios short. A local run does not prove
provider stop reliability, billing or hosted timing; those are checked on a deployed test Worker.

## 12. Accepted risks and out of scope

- A delivery retried after an unclear failure can make Kilo process a prompt twice.
- A turn submitted again after a Kilo restart can cost a second model request when the first one
  reached the provider but produced no output yet.
- The cause of the Kilo hang is inside Kilo and is not fixed here; the restart only recovers it.
- A running tool part holds the turn until it completes or errors. A hung tool with no effective
  timeout (a subagent, or an MCP call that resets on progress) or a part whose completion was lost
  in an event-stream gap therefore fails at the 120-minute cap (`execution_limit`) instead of after
  seven minutes (`no_progress`). The general turn cap is now 120 minutes and the lost-outcome
  Session backstop is 125 minutes; a turn with nothing running still fails `no_progress` after
  seven minutes.
- A prompt frame lost when the socket breaks stays `accepted` until the next outcome or the backstop.
- Notifications are best effort; the Session DO backstop bounds a lost one.
- An unconfirmed provider stop is logged; the container may run until the provider stops it.
- A killed container is not found by polling the provider. It is a wrapper connection that does not
  return. The user waits at most the reconnect window, then the message fails `connection_lost`.
- The reconnect window is short so a queued message does not wait long on a wrapper that is gone. A
  live wrapper reconnects within seconds (backoff 1 s to 30 s; supervisor restart 1 s to 16 s), but
  one cut off from the Sandbox DO for longer than 90 s, for example during a platform outage, loses
  its accepted turn (`connection_lost`).
- Out of scope: Kilo and model-provider retry policy, workspace file recovery after sandbox loss,
  the legacy plane.
