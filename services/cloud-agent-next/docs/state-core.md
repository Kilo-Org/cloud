# Sandbox state core

The sandbox lifecycle is three small state machines. Each decides one thing, each stores one
canonical aggregate, and public status is derived from them rather than stored. This document
records what each machine owns and the invariants a change must not break. The design rationale
lives in the commit history and in the pull request that introduced the core.

## Machines

| Machine | What it decides | States | Owner |
|---|---|---|---|
| Allocation | the sandbox container's lifecycle | `stopped`, `creating`, `allocated`, `stopping`, `unknown` | `src/sandbox-state/allocation/` |
| Health | runtime liveness inside an allocation | `connecting`, `healthy`, `recovering`, `unhealthy` | `src/sandbox-state/health/`, embedded in the allocation key (`allocated.<health>`) |
| Session / message | one chat message's journey | `queued`, `accepted`, `completed`, `failed`, `cancelled` | `src/sandbox-state/session/` |

The allocation machine lives in the `SandboxControl` Durable Object; the session machine lives in
`SandboxSession`. They are separate aggregates, so a change to one must not reach into the other.

`allocationStateKey` renders an allocation state as one charset-safe label — `stopping.<step>`,
`allocated.<health>`, or the bare kind — and is the canonical way to name a state in logs and in
tests. Do not re-derive those labels.

## Invariants

1. **One writer per decision.** A decision is made in exactly one reducer (`decideAllocation`,
   `decideHealth`, `decideSession`) and persisted by exactly one writer.
2. **One clock.** The active state declares a single `deadlineAt`; the Durable Object alarm is
   derived from it and fires one `DEADLINE` event. No machine reads the clock independently.
3. **Projection is derived, never stored.** Public status is a pure function of state, evidence and
   `now` (`src/sandbox-state/project/status.ts`). It is never written back.
4. **Fail closed.** An unknown stored shape is logged and left alone. Provider uncertainty becomes
   `unknown` with a bounded observation, never a destructive action.
5. **Commands are data.** A reducer returns commands and a deadline; effects run outside it, and a
   command failure returns as an event rather than as an exception that bypasses the reducer.

## Transition log

Every allocation or health transition emits one structured diagnostic line:

```
diagnosticEvent=allocation_transition aggregate=allocation from=<state> to=<state>
event=<event> deadline=<n|null> at=<n> [allocationId] [incarnation] [reason]
sandboxId=<id> provider=<p> [connectionId] [wrapperInstanceId]
```

- It is emitted at the single commit boundary, `createAllocationController.dispatch`, after the
  state is persisted, through a non-throwing sink. Reporting must never block the committed
  decision or its commands.
- `src/sandbox-control/allocation-transition.ts` owns the record, the no-op predicate and the
  projection. A decision that leaves the record unchanged and issues no commands does not emit; a
  heartbeat renewal that re-arms the deadline does.
- Values must be charset-safe: the diagnostic logger redacts any string outside
  `[a-zA-Z0-9_.:-]+` or longer than 128 characters (`src/sandbox-control/diagnostics.ts`), so
  optional identifiers and stop reasons may appear as `redacted`.

## Deferred

| Item | Why deferred | Trigger | Acceptance test | Owner |
|---|---|---|---|---|
| Session/message transition log | The session aggregate has no commit-aware dispatch seam: `decideSession` has six pure callers and persistence is spread across `saveMessages*` call sites in a separate Durable Object, so a line emitted at the decision would report changes that are never persisted (`cancelPendingMessage` returns `{dropped:false}` without persisting). | A single session dispatch/commit boundary exists — the analogue of `createAllocationController.dispatch`. | A session transition emits `{aggregate:'session', from, to, event, deadline}` at that one writer, and no line is emitted for a decision the writer does not persist. | unassigned (board item filed 2026-09-21) |
