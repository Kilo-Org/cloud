# KiloClaw Provider Interface Deviations

## Purpose

Track intentional phase-by-phase deviations, compatibility shims, and deferrals
during the provider-interface extraction work. This log is expected to be used
across phases and reviews.

## Phase 1

### D1. Legacy Fly fields remain persisted compatibility mirrors

- Status payloads and many internal helpers still read `flyAppName`,
  `flyMachineId`, `flyVolumeId`, and `flyRegion` directly.
- Phase 3 makes `providerState` the canonical provider record for the primary
  lifecycle path, but the legacy Fly fields still remain in persisted state and
  must be mirrored for compatibility.
- Reason: preserve current behavior and public routes while existing callers
  and helper modules still consume the legacy Fly fields.

### D2. Worker and controller routing remain Fly-specific in phase 1

- `src/index.ts`, `src/utils/proxy-headers.ts`, and parts of the controller
  routing client still know about `*.fly.dev` and `fly-force-instance-id`.
- Reason: routing neutralization is phase 2 work; phase 1 focuses on lifecycle
  extraction with Fly parity.

### D3. Provider-specific admin/debug flows remain direct Fly operations

- Snapshot restore, candidate volumes, reassociation, and direct destroy of a
  Fly machine remain Fly-specific and are not moved behind the minimum provider
  contract in phase 1.
- Reason: capability-gating and shared/provider-specific admin separation are
  later phases.

### D4. Phase 1 adapter wiring covers only the primary lifecycle path

- The provider adapter is wired into `provision`, `start`, `stop`, and runtime
  restart/redeploy behavior.
- Reconciliation, destroy retry helpers, metadata recovery, snapshot restore
  internals, and several admin/debug paths still call Fly logic directly.
- Reason: the goal of phase 1 is Fly-parity extraction of the primary lifecycle
  path without widening the change surface too far.

### D5. The internal phase-1 adapter contract is still Fly-shaped

- The new provider adapter interface currently accepts Fly-oriented runtime
  config objects and lifecycle inputs rather than a provider-neutral desired
  runtime spec.
- Reason: phase 1 prioritizes extracting the current Fly implementation with
  behavior parity; a provider-neutral runtime contract is deferred to a later
  phase once the seam is proven.

### D6. The persisted provider-state schema is Fly-only in phase 1

- `provider` now persists as a generic provider id, but `providerState` only
  validates and hydrates the Fly variant.
- Reason: phase 1 only needs a safe persistence seam for the extracted Fly
  adapter. Additional provider-state variants will be added alongside real
  non-Fly adapters in later phases.

### D7. Only Fly is wired in the provider registry

- Request validation now accepts future provider ids, but the registry only
  resolves `fly`; `aws`, `northflank`, and `k8s` currently throw
  "not implemented yet".
- Reason: preserve a forward-compatible API shape without implying support for
  providers that do not yet have runtime implementations.

### D8. Restart sequencing still depends on a DO-owned Fly parity flag

- Background restart still uses the persisted `restartUpdateSent` flag and a
  storage status re-check around `updateMachine` to preserve current timeout and
  concurrent-destroy behavior.
- Reason: this is part of the existing restart reconciliation contract. Making
  restart progress tracking provider-neutral is deferred until later phases.

## Phase 2

### D9. Worker proxy routability checks still read legacy Fly status fields

- The worker proxy now fetches provider-derived transport coordinates through
  `getRoutingTarget()`, but it still uses `getStatus()` and legacy Fly fields
  such as `flyMachineId` to decide whether an instance is proxyable.
- Reason: phase 2 only neutralizes the transport layer while preserving current
  public status payloads and route behavior. Generic routability/status fields
  remain deferred until a later phase.

## Phase 3

### D10. Canonical provider state is only wired through the primary lifecycle path

- `provision`, `start`, `stop`, and restart/redeploy now apply explicit
  provider results through `KiloClawInstance`, with `providerState` treated as
  canonical provider data.
- Direct Fly-only reconcile, recovery, snapshot, and admin/debug code paths
  still mutate legacy Fly fields in place and rely on the storage sync bridge
  for compatibility.
- Reason: phase 3 starts with the main adapter-managed lifecycle path before
  widening the refactor across all remaining Fly-only helper flows.

### D11. Legacy Fly-field writes still exist outside the adapter-managed path

- Several existing Fly reconciliation and recovery helpers still assign
  `flyAppName`, `flyMachineId`, `flyVolumeId`, and `flyRegion` directly on the
  mutable state object.
- A comment convention and the storage sync helper now document that those
  writes must be followed by `persist()` or a storage sync call, but the code
  base does not yet enforce this mechanically.
- Reason: removing every direct Fly-field write is broader than the initial
  phase-3 slice; stronger enforcement or full removal is deferred.

### D12. Adapter parity still requires mid-operation provider-result callbacks

- To preserve Fly parity, the adapter-managed lifecycle path can emit
  intermediate provider results back to `KiloClawInstance` before long waits or
  retries, for example when a new machine ID or replacement volume ID must be
  persisted immediately.
- The adapter no longer writes DO storage directly, but the contract is not yet
  a single final-result model.
- Reason: existing Fly behavior depends on persisting certain provider changes
  before startup waits, timeout handling, and retry paths complete.

### D13. Fly-only helper internals remain Fly-shaped after phase 4

- The provider adapter boundary now accepts a provider-neutral runtime spec
  instead of `FlyMachineConfig`.
- Existing Fly-only helper layers such as `fly-machines.ts`, recovery, and
  reconcile internals still translate or consume Fly machine config types under
  the adapter boundary.
- Reason: phase 4 neutralizes the public adapter contract first. Fully
  rewriting every remaining Fly-only helper to a neutral internal model is
  deferred while those paths are still Fly-specific.
