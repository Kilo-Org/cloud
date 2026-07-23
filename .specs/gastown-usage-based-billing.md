# Gastown Usage-Based Billing

## Role of This Document

This spec defines how Gastown charges Kilo credits for Cloudflare Container usage. It is the
source of truth for pricing, payer attribution, metering lifecycle, budget enforcement, and
user-visible behavior. The `@kilocode/container-usage` interface described here is proposed
and is not yet available in production.

## Status

Draft -- created 2026-07-21.

## Conventions

The key words "MUST", "MUST NOT", "SHOULD", and "MAY" are to be interpreted as described in
BCP 14 when they appear in all capitals.

## Overview

Gastown will charge the owner of a town for the time its Cloudflare Container is awake. Charges
settle continuously against the owner's Kilo credit balance through the future
`@kilocode/container-usage` service. Gastown remains responsible for reporting lifecycle events
and enforcing budget verdicts; the metering service owns usage calculation, pricing, ledger
debits, idempotency, and balance evaluation.

The initial price is **three times the attributable Cloudflare Container cost**. This is a
usage-based charge, not a subscription or flat-rate entitlement.

## Definitions

- **Interval**: One continuous runtime of a town's container, from a successful
  `recordStart` through `recordStop`.
- **Awake time**: Seconds during which Cloudflare reports the container as running. Sleeping or
  stopped time is not billable.
- **Payer**: The Kilo user or organization whose credits are debited.
- **Actor**: The user or Gastown automation that caused the container to run.
- **SKU**: The metering catalog entry for the configured Cloudflare Container instance type.

## Pricing

1. The customer charge MUST equal `3 x attributable Cloudflare Container cost` for the measured
   awake time.
2. The attributable cost MUST be calculated by the metering service from a versioned SKU catalog.
   Gastown MUST send the catalog SKU and MUST NOT embed Cloudflare prices in application code.
3. The initial production SKU is `gastown-standard-2026-07`, representing Gastown's configured
   `standard-4` container. A container-size or price change MUST use a new catalog SKU.
4. Charges MUST settle in Kilo credits. One dollar of calculated charge uses one dollar of Kilo
   credit balance under the existing credit conversion rules.
5. The initial scope includes Cloudflare Container compute and memory costs represented by the
   SKU. Token inference, external model usage, network egress, and durable workspace storage are
   outside this meter unless later added to the catalog explicitly.

## Payer Attribution

1. An org-owned town MUST debit `{ type: "org", id: owner_id }`.
2. A user-owned town MUST debit `{ type: "user", id: owner_id }`.
3. Legacy user towns without `owner_id` MAY fall back to `owner_user_id`. A town with no reliable
   payer MUST NOT start billable work.
4. Interactive work SHOULD identify the authenticated user as the actor. Autonomous scheduling
   MUST use a stable Gastown bot identity with `onBehalfOf` equal to the billing subject.
5. Payer, SKU, and interval start time MUST remain immutable for an open interval. An ownership or
   SKU change takes effect on the next container runtime.

## Metering Lifecycle

Gastown's `TownContainerDO` is the producer for `service: "gastown"`. It MUST durably retain enough
interval state to retry every call after a Durable Object restart.

1. **Start:** Gastown MUST await a successful `recordStart` before starting the container. The
   context MUST include the Town Container DO ID as `instanceId`, the town ID as `sessionId`, the
   configured SKU, payer, actor, and `metadata.townId`. The current meter rejects missing,
   incompatible, or closed SKUs; transport or persistence failure MUST fail the cold start closed.
2. **Heartbeat:** Approximately every five minutes while `getState()` confirms the container is
   running, Gastown MUST await `recordHeartbeat` with monotonic `seq`, measured
   `usageSinceLast`, and the original context for self-healing. Gastown MUST NOT infer billable
   time merely from the existence of a Town or Durable Object.
3. **Stop:** Every observed container stop MUST eventually produce an acknowledged `recordStop`.
   Gastown MUST retry it durably until acknowledged, including after eviction, idle shutdown,
   explicit destruction, health recovery, or budget enforcement.
4. All idempotency keys MUST follow the metering contract. Retries and `dedup: true` responses MUST
   never create duplicate charges or intervals.
5. Gastown's existing agent heartbeats MUST NOT substitute for container metering heartbeats: a
   town may contain many agents, but it has one billable container interval.

Stop reasons map as follows:

| Gastown event | Meter reason |
|---|---|
| Natural container exit | `exit` |
| Idle timeout or `sleepAfter` | `activity_expired` |
| Budget stop, explicit stop, eviction, destroy, or watchdog restart | `runtime_signal` |

## Technical Architecture

### Responsibility split

| Component | Responsibility |
|---|---|
| UBB / `@kilocode/container-usage` | Typed client/contracts, SKU validation, usage ledger, idempotency, and reconciliation; wallet admission and budget debits remain follow-up work |
| `TownDO` | Resolve payer and actor, gate every dispatch path, expose billing state to the UI, stop scheduling after a budget stop, and request usage heartbeats from the container DO |
| `TownContainerDO` | Own the durable interval state, guard cold starts, call `recordStart`/`recordHeartbeat`/`recordStop`, observe actual container runtime, and stop the container when instructed |
| Gastown tRPC | Verify town access, pass the authenticated actor to `TownDO`, return stable billing errors/status, and never make an independent billing decision |
| Web UI | Display estimates and meter status, prevent known-invalid actions, link to the correct credit owner, and recover after top-up |

Gastown MUST receive the metering WorkerEntrypoint through a Cloudflare service binding. Production,
development, and test Wrangler configurations MUST bind the same typed interface; tests MAY use an
in-memory fake ledger.

The initial integration binds `CONTAINER_USAGE` to the `container-usage-meter` Worker and its
`ContainerUsageMeter` entrypoint. It records real intervals and SKU-rated seconds. The merged
foundation currently returns `continue` for every heartbeat and does not expose wallet admission,
reservations, credit debits, or remaining balance. Therefore `GASTOWN_BILLING_ENABLED` MUST remain
off for customer charging until those ledger capabilities are implemented; the current integration
is suitable for shadow metering and reconciliation.

### Required admission contract before customer charging

The current three recording calls are not sufficient by themselves to prevent a cold start:
`recordStart` returns no budget verdict, while `recordHeartbeat` is defined only after
`getState()` confirms that the container is running. UBB therefore MUST provide an upstream
admission operation before paid rollout. This is a fourth operation, but it is not a usage-recording
call.

Conceptually:

```ts
type AuthorizeStartResult =
  | {
      verdict: 'allow';
      authorizationId: string;
      expiresAt: number;
      remaining?: number;
      minimumRequired: number;
    }
  | {
      verdict: 'deny';
      remaining: number;
      minimumRequired: number;
    };
```

1. `authorizeStart` MUST atomically evaluate the payer's current available balance and reserve the
   configured minimum-start amount. This prevents several towns owned by one payer from passing the
   same balance check concurrently.
2. The reservation SHOULD cover at least one maximum-price heartbeat window. The exact minimum is
   catalog configuration, not a Gastown constant.
3. Gastown MUST include the `authorizationId` in `recordStart` metadata. Opening the interval MUST
   consume the reservation or associate it with that interval. An expired authorization MUST be
   re-authorized, not reused.
4. A denied authorization MUST return `remaining` and `minimumRequired` so Gastown can produce an
   actionable response without querying a second balance source.
5. If UBB chooses not to implement reservations initially, it MUST document the bounded race: two
   concurrent cold starts may both pass against the same credits and can consume up to one
   heartbeat window before being stopped. This weaker mode is acceptable only during shadow rollout.

An equivalent design MAY add an atomic budget verdict and reservation to `recordStart`, provided it
can complete before the Cloudflare container is started. A browser-only check against
`user.getContextBalance` is useful for UX but MUST NOT be the authoritative admission gate because
autonomous scheduling and direct service calls bypass the browser.

### Durable interval state

`TownContainerDO` SHOULD persist one state record with these conceptual fields:

```ts
type ContainerUsageState =
  | { phase: 'idle' }
  | {
      phase: 'starting' | 'running' | 'stopping';
      context: UsageContext;
      authorizationId: string;
      startEpochMs: number;
      seq: number;
      lastReportedAt: number;
      pendingHeartbeat?: {
        seq: number;
        observedAt: number;
        usageSinceLast: number;
        idempotencyKey: string;
      };
      stopReason?: 'exit' | 'runtime_signal' | 'activity_expired';
    };
```

The concrete layout MAY differ, but it MUST provide these guarantees:

1. Exactly one open interval exists per `TownContainerDO`.
2. The heartbeat sequence and payload are persisted before the RPC. A retry after a timeout or DO
   restart sends the identical sequence, usage, observation time, and idempotency key.
3. `lastReportedAt` advances only after an ack. A lost response therefore retries rather than
   dropping usage.
4. A pending stop is retained until `recordStop` is acknowledged. Starting a new runtime creates a
   new `startEpochMs`; it never reopens or reuses the old interval.
5. Heartbeat, stop, and restart transitions are serialized so the final usage slice cannot race a
   normal heartbeat.

### Reporting awake time

1. `TownContainerDO` lifecycle observations are the source of truth for billable runtime. Agent
   count, PTY connections, bead status, and browser presence MUST NOT directly produce usage.
2. Awake time begins when the Cloudflare container runtime starts and ends when it stops. The ten
   minute `sleepAfter` period and any other time the runtime remains awake are billable because they
   incur Cloudflare cost.
3. The existing `TownDO` alarm loop SHOULD call a rate-limited
   `TownContainerDO.recordUsageHeartbeat()` operation. That operation MUST no-op until approximately
   five minutes have passed, then confirm runtime state and report usage. This avoids introducing an
   alarm implementation that may conflict with the `Container` base class's sleep behavior.
4. While agents are active, the Town alarm currently runs every five seconds; while idle, it runs
   every five minutes. Both paths MUST eventually invoke the same rate-limited usage operation.
5. `onStart` and `onStop` SHOULD enqueue lifecycle work with `ctx.waitUntil`. `onStop` MUST report the
   final partial window even when fewer than five minutes elapsed.
6. Usage MUST be measured from persisted runtime timestamps, rounded according to the UBB contract,
   and submitted as awake seconds. Gastown MUST NOT derive cost locally.
7. If an open interval is found after a restart but the runtime is stopped, Gastown MUST close it
   using the last reliable observation and flag it for reconciliation rather than inventing an
   unbounded runtime duration.

### Cold-start gate

All paths that can wake a container MUST converge on one gate. Today these include eager mayor
startup, mayor messages, bead dispatch, alarm-driven `ensureContainerReady`, health recovery,
terminal/stream proxy requests, and direct container fetches.

The gate behaves as follows:

1. If the runtime is already running and has an open interval, allow the request. Admission is not
   repeated for every agent because the town has one shared container.
2. If the town is in `billing_stopping` or `billing_blocked`, reject new dispatch and do not call a
   container proxy that would wake the runtime.
3. For a cold start, resolve payer and actor, persist the context in `TownContainerDO`, await the
   real package client's `recordStart`, and only then call `startAndWaitForPorts` or a proxy operation
   that can boot the container. Once wallet admission exists, `authorizeStart` precedes this step.
4. Current SKU admission failures return `BILLING_UNAVAILABLE` and do not mutate a bead or agent to
   `working`. Future wallet denial returns `INSUFFICIENT_CREDITS` with payer type, remaining balance,
   and minimum required balance.
5. If admission infrastructure is unavailable, return `BILLING_UNAVAILABLE` and fail closed for the
   cold start. An already-running interval continues and fails open as described under Failure
   Handling.
6. If container startup fails after `recordStart`, close the zero- or near-zero-usage interval with
   `runtime_signal`; once reservations exist, release the unused reservation.
7. `TownContainerDO` MUST defend the boundary as well as `TownDO`: a request that could cold-start
   the runtime without prepared metering context MUST be rejected. This prevents a new proxy route
   from accidentally bypassing billing.

The scheduler currently marks a bead and agent as active before asynchronous dispatch. Billing
admission MUST happen before those transitions, or a denied start MUST synchronously restore the
previous states. The preferred implementation is to move admission before the state mutation.

### Heartbeat and low-balance stop

The response to `recordHeartbeat` is authoritative for a running interval:

1. On `continue`, persist the ack, publish the new remaining balance to `TownDO`, and schedule the
   next report.
2. On `warn`, do the same and persist a `billing_warning` state. Existing work continues and new work
   MAY still dispatch while the shared container remains running. Gastown MUST de-duplicate user
   notifications for the same low-balance episode.
3. On `stop`, atomically persist `billing_stopping` before any network operation. The Town scheduler
   MUST stop dispatching new agents and `ensureContainerReady` MUST not restart the runtime.
4. Gastown MUST trigger the existing graceful eviction/drain path so active agents save checkpoints,
   database snapshots, and WIP branches. Shutdown receives a configurable deadline; after it expires,
   Gastown MAY force-stop the container to cap additional spend.
5. After the drain, call `container.stop()`, report the final usage slice, and retry `recordStop` until
   acknowledged. Then persist `billing_blocked` with the latest `remaining` value.
6. Container `onStop` and the explicit budget-stop path MUST be idempotent. Either may observe the
   stop first, but together they produce one final usage segment and one metering stop record.
7. The ordinary alarm reconciler and health watchdog MUST treat `billing_stopping` and
   `billing_blocked` as intentional downtime. They MUST NOT classify it as a failed container or
   auto-restart it.
8. A later explicit user action or pending scheduler action MAY re-run admission. On success,
   Gastown clears `billing_blocked`, opens a new interval, restores saved work, and resumes. A balance
   query alone MUST NOT wake the container.

### Gastown API changes

Gastown SHOULD expose a typed billing status through tRPC and the Town status WebSocket:

```ts
type GastownBillingStatus = {
  state: 'idle' | 'starting' | 'running' | 'warning' | 'stopping' | 'blocked' | 'degraded';
  payer: { type: 'user' | 'org'; id: string };
  remaining?: number;
  minimumRequired?: number;
  estimatedHourlyCharge?: number;
  intervalStartedAt?: number;
  lastReportedAt?: number;
};
```

1. A `getBillingStatus` query MUST verify town access and return only the caller-safe status. It MUST
   NOT expose ledger internals, admission IDs, idempotency keys, or another payer's data.
2. The Town status WebSocket SHOULD publish state transitions so warning and stop UX does not wait
   for polling.
3. Interactive mutations that can cold-start a town MUST return stable error codes for
   `INSUFFICIENT_CREDITS` and `BILLING_UNAVAILABLE`. The frontend MUST NOT parse human-readable error
   strings to choose behavior.
4. The authenticated user ID from tRPC MUST be passed as the actor for interactive starts. Alarm and
   reconciler starts use a stable bot actor.
5. Admin access MUST not shift the charge to the admin. Support actions use the town's configured
   payer and identify the admin only as actor.

### Expected code changes

| Area | Expected change |
|---|---|
| `services/gastown/wrangler.jsonc` and test config | Add the default-off `GASTOWN_BILLING_ENABLED` flag; add the production UBB binding when that Worker is provisioned. |
| `services/gastown/worker-configuration.d.ts` | Add the typed admission and recording RPC contract until generated binding types provide it. |
| `services/gastown/package.json` | Add `@kilocode/container-usage` once the package exists. |
| `services/gastown/src/dos/TownContainer.do.ts` | Persist interval state, guard cold starts, report lifecycle calls, expose a rate-limited usage heartbeat, and make stop handling idempotent. |
| `services/gastown/src/dos/Town.do.ts` | Resolve billing context, retain public billing state, invoke usage reporting from the existing alarm, and suppress restart while billing-blocked. |
| `services/gastown/src/dos/town/scheduling.ts` | Run admission before mutating beads and agents to active states. |
| `services/gastown/src/dos/town/container-dispatch.ts` | Route all cold starts through the metered gate and carry the actor/context. |
| `services/gastown/src/trpc/schemas.ts` and `router.ts` | Add billing status outputs, stable billing errors, and authenticated actor propagation. |
| `apps/web/src/components/gastown/TerminalBar.tsx` and `MayorChat.tsx` | Remove mount-time `ensureMayor`, render billing states, and stop terminal reconnect loops while blocked. |
| Gastown town page shell | Add the compact usage indicator, warning/paused banner, and payer-aware credit action. |

The exact module split MAY change during implementation, but no route or scheduler path may retain a
direct, unmetered cold start.

## Budget Enforcement

1. Gastown MUST enforce the `budget.verdict` returned by each heartbeat.
2. On `continue`, Gastown MUST keep running and schedule the next heartbeat. This includes the
   metering service's fail-open response when its ledger is temporarily unreadable.
3. On `warn`, Gastown MUST keep running and SHOULD notify connected users that the town is nearing
   its credit limit. The warning SHOULD include `remaining` when supplied.
4. On `stop`, Gastown MUST stop dispatching new work, request the container's existing graceful
   drain/save behavior, then stop the container and close the interval. Work already in a
   non-interruptible save step MAY finish before shutdown.
5. A budget stop MUST preserve the town's durable control state and recoverable agent work to the
   same standard as a platform eviction. Adding credits MUST allow the next request or scheduler
   action to start a new interval and continue the town.
6. Gastown MUST NOT independently calculate a balance floor or override a `stop` verdict based on
   a cached balance.

## User Experience

### Do not bill for viewing a town

The current Mayor UI calls `ensureMayor` on mount, and `ensureMayor` eagerly starts an idle container.
Paid rollout MUST remove this behavior. Loading a town page, polling status, or expanding the
terminal MUST NOT by itself create container usage.

The page SHOULD first show the saved town state and a stopped terminal. A container starts only when
the user sends work, explicitly selects **Start Mayor**, or autonomous queued work is eligible to
run. If product requirements retain eager prewarming, the UI MUST disclose that opening the town
starts billable usage; the default remains no eager start.

### Status and controls

The UI SHOULD use the server's `GastownBillingStatus` rather than calculate state from a separately
cached balance. A personal balance query or `user.getContextBalance` MAY prefetch display data, but
server admission remains authoritative.

| State | UI behavior |
|---|---|
| `idle` | Show the estimated active hourly charge near the start control. Do not show a running cost counter. |
| `starting` | Disable duplicate starts and show `Starting Gas Town...` |
| `running` | Show a compact active-usage indicator with elapsed runtime, estimated charge so far, and remaining credits when available. |
| `warning` | Show a persistent warning banner and keep the terminal usable. Primary action: **Add credits**. |
| `stopping` | Disable new work and show `Saving work and pausing Gas Town...` Do not show a retry action until save/stop completes. |
| `blocked` | Replace reconnect loops with a paused state explaining the required balance. Primary action: **Add credits**; after funding, **Resume Gas Town**. |
| `degraded` | Keep running. Avoid alarming the user for a transient buffered write; show service degradation only if action is required or the delay is prolonged. |

### User circuit breaker

Every billing-enabled town MUST expose a durable `automatic | paused_by_user` container run policy.
Turning automatic starts off MUST persist `paused_by_user` before stopping the container, stop new
dispatch, gracefully save active work, leave queued work pending, and prevent every cold-start path
from restarting the container. The Town scheduler and Town Container boundary MUST both enforce the
policy. Credit top-ups, alarms, PTY reconnects, and health checks MUST NOT clear a user pause.

The UI MUST confirm before pausing and show the estimated charge accumulated by the current runtime.
Turning automatic starts back on removes the circuit breaker but MUST NOT itself boot an idle
container; pending eligible work or an explicit user start may boot it afterward. A user pause is
distinct from an insufficient-credit block and uses different recovery copy and controls.

Recommended copy:

- Before start: `Container usage is billed at an estimated {rate}/hour while Gas Town is running.`
- Admission denied: `Gas Town needs at least {minimum} in credits to start. {remaining} is available.`
- Warning: `Credits are running low. Gas Town will save its work and pause when the balance reaches the limit.`
- Stopping: `Saving work and pausing Gas Town...`
- Paused: `Gas Town is paused. Your work was saved. Add credits, then resume when you are ready.`
- Billing unavailable: `Gas Town cannot verify billing right now. Try starting it again in a minute.`

The warning UI MUST use the warning status domain, while a completed budget pause is informational,
not destructive: the user's town and work have not been deleted. **Add credits** is the single
primary CTA. Amounts and usage counters SHOULD use tabular numerals.

### Personal and organization payers

1. Personal towns link **Add credits** to `/credits` and preserve a return URL to the town.
2. Organization towns link users with billing permission to the organization's credit-management
   surface and preserve the return URL.
3. Organization members without billing permission SHOULD see who can resolve the issue and an
   action such as **View organization billing** rather than a purchase control they cannot use.
4. Every balance message MUST name the payer context, for example `Your credits` or
   `Acme organization credits`, so users understand which wallet controls the town.

### Estimates and receipts

1. Estimates MUST be labeled as estimates because the final debit comes from measured awake time.
2. The displayed hourly estimate MUST come from the same versioned SKU price used by UBB, including
   the `3x` multiplier. The frontend MUST NOT duplicate the rate card.
3. The running cost estimate MAY be calculated from the interval start and hourly estimate for
   responsiveness, but it MUST be replaced by settled usage when available and MUST NOT be presented
   as an exact ledger balance.
4. Customer billing history SHOULD group debits by town and interval, showing town name, runtime,
   customer rate, total charge, start/stop timestamps, and stop reason. Base Cloudflare cost and the
   internal multiplier belong in staff-only reconciliation tooling, not customer receipts.
5. Warning and pause states MUST work on mobile, remain keyboard accessible, and be announced through
   an appropriate live region without repeatedly announcing every balance refresh.

## Failure Handling

1. The current meter acknowledges durable Postgres writes only. Its typed client retries transient
   RPC failures with the same generated idempotency key.
2. If a heartbeat remains unavailable after client retries, Gastown SHOULD fail open for the running
   interval, retain its pending segment, and alert. It MUST NOT terminate customer work solely
   because the billing service is temporarily unreachable.
3. If `recordStop` cannot be acknowledged during shutdown, the pending stop MUST survive and retry
   later. A missing stop ack MUST NOT cause the next runtime to reuse the previous interval.
4. Metering errors and retries MUST NOT log credit balances, tokens, or other credentials.
5. If the meter reports that a locally open interval is missing, Gastown MUST replay the same
   idempotent `recordStart` and retry the heartbeat or stop. Pre-WorkerEntrypoint development state
   MUST be version-migrated so obsolete authorization and credit-block fields cannot strand a town.

## Rollout And Acceptance

Rollout SHOULD proceed through a single default-off backend flag:

1. **Contract and catalog:** Ship `gastown-standard-2026-07`, its `3x` customer rate, the
   `CONTAINER_USAGE` binding to `ContainerUsageMeter`, and the package client behind
   `GASTOWN_BILLING_ENABLED=false`. The SKU row is an operational prerequisite and MUST exist in the
   production catalog before the flag is enabled; schema migrations intentionally do not seed its
   environment-specific rate.
2. **Shadow reporting:** Emit complete intervals and calculated charges without reserving or
   debiting credits and without enforcing `warn`/`stop`.
3. **Admission and UX:** Enable authoritative cold-start admission and all blocked/warning UI while
   usage debits remain shadowed. Exercise personal and organization payer flows.
4. **Charging:** Enable ledger debits while heartbeat `stop` remains observable but unenforced for a
   short canary period.
5. **Enforcement:** Enable graceful budget stops for internal users, then a percentage rollout, then
   all paid Gastown traffic.

Before charging customers, shadow data MUST demonstrate that starts and stops reconcile with
Cloudflare runtime observations, duplicate RPCs do not duplicate charges, and aggregate base cost is
reasonably consistent with the Cloudflare invoice. `GASTOWN_BILLING_ENABLED` controls metering,
admission, debits, warnings, and stops together. A separate default-off
`GASTOWN_BILLING_ANNOUNCEMENT_ENABLED` web flag MAY show advance notice while actual billing remains
disabled; it MUST NOT alter backend billing behavior. Both flags are always enabled in local
development while retaining default-off production behavior.

Dashboards MUST expose awake seconds, base Cloudflare cost, customer charge, gross multiplier,
unclosed intervals, SKU admission denials, RPC failures, graceful-stop duration, forced stops, and
counts of `warn` and `stop` verdicts.

### Required verification

1. Unit tests MUST cover every durable interval transition, identical retry payloads, dedup acks,
   stop/heartbeat races, ownership mapping, and billing-blocked scheduler behavior.
2. Worker integration tests MUST use a fake UBB binding to cover successful and rejected SKU starts,
   total failure, all three heartbeat verdicts, lost responses, DO restart between calls, idle stop,
   watchdog restart, and final partial-window settlement.
3. Before wallet admission ships, concurrency tests MUST prove two towns cannot consume the same
   minimum-start reservation for one payer.
4. End-to-end tests MUST cover a personal town and an organization town through start, warning,
   graceful pause, top-up, and resume. They MUST also prove that merely opening the town page creates
   no interval and no Cloudflare container start.
5. Reconciliation tests MUST compare sampled intervals with Cloudflare runtime data and verify the
   configured customer charge is exactly three times catalog base cost, subject only to documented
   rounding.
6. UX verification MUST cover desktop and mobile layouts, keyboard operation, live-region
   announcements, organization members without billing permission, and a prolonged billing-service
   outage.

## Open Decisions

1. Confirm which Cloudflare cost components belong in the initial SKU, especially disk and egress.
2. Choose the exact town-shell placement for the active estimate, warning banner, and interval
   receipt link.
3. Define the maximum graceful-drain duration after a `stop` verdict.
4. Confirm whether legacy towns with ambiguous ownership are migrated or blocked from paid use.
5. Finalize whether admission is a separate `authorizeStart` RPC or an atomic extension to
   `recordStart`.
6. Set the minimum-start reservation and `warn` threshold from the final SKU rate and desired
   graceful-save window.

## Changelog

### 2026-07-22 -- User circuit breaker

- Added a durable user-controlled automatic-start policy, forced graceful shutdown, and per-run cost
  estimate.

### 2026-07-21 -- Technical design expansion

- Added admission, durable metering state, reporting, low-balance shutdown, API, UI, rollout, and
  verification design.

### 2026-07-21 -- Initial draft

- Defined `3x` Cloudflare Container cost pricing and the proposed
  `@kilocode/container-usage` integration for Gastown.
