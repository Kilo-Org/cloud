# KiloClaw Provider Interface

## Summary

KiloClaw should support multiple infrastructure providers without replacing the
existing per-instance control model. The `KiloClawInstance` Durable Object stays
the single authority for lifecycle state and orchestration. Provider modules are
compiled into `services/kiloclaw`, can use helper Durable Objects internally,
and are responsible only for runtime, persistent storage, and routing concerns.

The key design decision is to use a layered model rather than a total
abstraction:

- Core instance lifecycle stays in `KiloClawInstance`
- Provider runtime actions move behind a provider adapter
- In-machine OpenClaw/controller actions remain explicit and separate
- Provider-specific admin/debug flows remain capability-gated, not part of the
  minimum shared contract

## Goals

- Support Fly.io and future providers such as Northflank, AWS, and Kubernetes
  without rewriting instance lifecycle logic per provider
- Preserve the current single-writer, per-instance Durable Object model
- Keep discrete operations explicit instead of forcing them through an
  over-generic interface
- Require every provider to support:
  - runtime provisioning
  - persistent `/root` storage
  - routable HTTP/WebSocket ingress usable by the worker
- Allow admin-only cross-provider migration later, without making provider
  changes part of ordinary lifecycle methods

## Architectural Rules

- `KiloClawInstance` is the only source of truth for user-visible lifecycle
  state such as `provisioned`, `starting`, `running`, `stopped`, `destroying`,
  `restoring`, and `recovering`
- Provider helper Durable Objects are allowed, including per-instance helpers
  when justified, but they are subordinate implementation detail
- Provider helper DOs must not become a second lifecycle authority
- Provider state needed for recovery must be persisted by `KiloClawInstance`
- Providers are compiled modules under `services/kiloclaw/src/providers/`
- Provider changes are steady-state immutable; moving an instance to another
  provider is an admin migration workflow

## Layered Operation Model

### 1. Core Instance Lifecycle

These operations belong to `KiloClawInstance` and continue to own state
transitions:

- `provision`
- `start`
- `stop`
- `destroy`
- `reconcile`
- `forceRetryRecovery`
- future `migrateProvider`

These methods decide:

- whether an action is legal in the current status
- when status changes happen
- when alarms should be scheduled
- when recovery or destroy retry paths run
- when provider observations should be persisted

### 2. Provider Runtime Actions

These operations belong to the provider adapter and describe how the runtime is
hosted:

- ensure durable root storage exists
- start runtime attached to storage
- stop runtime
- redeploy runtime with new image, env, or runtime spec
- inspect runtime state
- recover provider references from the control plane
- destroy runtime
- destroy storage
- return a routing target that the worker and controller client can use

These actions cover things like:

- Fly machine start/update/destroy and volume management
- Northflank service deploy/redeploy and persistent volume setup
- ECS/Fargate task or service updates plus storage and ingress setup
- Kubernetes workload, PVC, and ingress/service handling

### 3. In-Machine Controller / OpenClaw Actions

These actions should remain explicit and not be pushed into the provider
adapter:

- gateway process status/start/stop/restart
- config read/replace/patch/restore
- file tree/read/write
- env patch
- `kilo run`
- pairing flows
- `runDoctor`

These are workload semantics, not hosting semantics. They should go through a
controller client that consumes a provider-derived routing target.

### 4. Provider-Specific Admin / Debug Capabilities

These are not part of the shared minimum contract:

- snapshot listing and restore
- candidate volume discovery
- volume reassociation
- direct provider cleanup endpoints such as destroy-Fly-machine

These should remain explicit capabilities that only exist for providers that
support them.

## Current Action Inventory

This inventory covers the current operational actions in `services/kiloclaw`:

- `KiloClawInstance` RPC methods
- route-level actions that call into the DO or perform direct provider work
- background/reconciliation actions that materially change state or runtime

It does not attempt to classify every pure helper function or schema/parser.

### Core Actions

These should remain owned by `KiloClawInstance` because they mutate or report
authoritative instance state rather than provider transport or in-machine
controller behavior.

#### Lifecycle and orchestration

- `provision`
- `start`
- `startAsync`
- `stop`
- `destroy`
- `forceRetryRecovery`
- `alarm`
- `recoverUnexpectedStopInBackground`

#### Persisted instance configuration and metadata

- `updateKiloCodeConfig`
- `updateExecPreset`
- `updateChannels`
- `updateSecrets`
- `updateGoogleCredentials`
- `clearGoogleCredentials`
- `updateGmailHistoryId`
- `getGmailOidcEmail`
- `updateGmailNotifications`
- `getConfig`

#### Read-only instance state and diagnostics

- `getStatus`
- `getDebugState`
- `getStreamChatCredentials`
- `tryMarkInstanceReady`
- `recordDiskStats`

#### Recovery and restore orchestration

- `cleanupRecoveryPreviousVolume`
- `destroyMachineForRestore`
- `setPendingRestoreVolumeId`
- `completeSnapshotRestore`
- `failSnapshotRestore`

#### Current route actions that map to core methods

- `/api/kiloclaw/config`
- `/api/kiloclaw/status`
- `/api/kiloclaw/chat-credentials`
- `/api/admin/google-credentials` GET/POST/DELETE
- platform routes for:
  - provision
  - start
  - stop
  - destroy
  - get status
  - get debug state
  - update KiloCode config
  - update exec preset
  - update channels
  - update secrets
  - update Google credentials
  - clear Google credentials
  - update Gmail history id
  - get Gmail OIDC email
  - enable or disable Gmail notifications
  - get Stream Chat credentials
  - force retry recovery
  - cleanup retained recovery volume
- controller check-in support:
  - `/api/controller/checkin`
  - `tryMarkInstanceReady`
  - `recordDiskStats`

#### Current core helper modules

- `src/durable-objects/kiloclaw-instance/index.ts`
- `src/durable-objects/kiloclaw-instance/reconcile.ts`
- `src/durable-objects/kiloclaw-instance/recovery.ts`

### Provider Actions

These are runtime-hosting actions and should move behind the provider adapter.

#### Shared provider-runtime concepts

- ensure persistent `/root` storage exists
- start runtime
- stop runtime
- redeploy runtime with new image and env
- inspect runtime state
- recover provider resource references
- destroy runtime
- destroy storage
- return a routing target usable by the worker and controller client

#### Current Fly-specific provider actions

- `restartMachine`
- `restartMachineInBackground`
- `listVolumeSnapshots`
- `listCandidateVolumes`
- `reassociateVolume`
- `enqueueSnapshotRestore`
- snapshot restore queue orchestration
- ensure app exists and app secrets exist
- ensure volume exists
- replace stranded volume
- start existing machine
- create new machine
- delete volume and attached machine
- inspect machine state
- inspect volume state
- metadata recovery from Fly metadata tags
- mount repair
- machine stop/start/update/destroy
- volume create/list/get/delete/snapshot operations
- direct Fly proxy routing via `*.fly.dev`
- provider-specific routing headers such as `fly-force-instance-id`

#### Current provider-related routes

- `/api/admin/machine/restart`
- `/api/admin/gateway/restart` alias
- platform routes for:
  - volume snapshots
  - candidate volumes
  - reassociate volume
  - restore volume snapshot
  - destroy Fly machine
  - region configuration
- catch-all proxy and `/i/:instanceId/*` routing in `src/index.ts`

#### Current provider files

- `src/durable-objects/kiloclaw-instance/fly-machines.ts`
- `src/fly/client.ts`
- `src/fly/apps.ts`
- `src/fly/secrets.ts`
- `src/fly/types.ts`
- `src/durable-objects/machine-config.ts`
- `src/queue/snapshot-restore.ts`
- `src/index.ts`
- `src/utils/proxy-headers.ts`

### Controller Actions

These are explicit workload or in-machine operations and should stay separate
from the provider adapter. They should consume provider-derived routing targets.

#### Gateway and controller status/actions

- `getGatewayProcessStatus`
- `startGatewayProcess`
- `stopGatewayProcess`
- `restartGatewayProcess`
- `getControllerVersion`
- `getGatewayReady`
- `waitForHealthy`

#### Config and env actions inside the runtime

- `restoreConfig`
- `patchConfigOnMachine`
- `patchOpenclawConfig`
- `getOpenclawConfig`
- `replaceConfigOnMachine`
- `patchEnvOnMachine`

#### File management inside the runtime

- `getFileTree`
- `readFile`
- `writeFile`

#### Pairing and workflow actions inside the runtime

- `listPairingRequests`
- `approvePairingRequest`
- `listDevicePairingRequests`
- `approveDevicePairingRequest`
- `runDoctor`
- `startKiloCliRun`
- `getKiloCliRunStatus`
- `cancelKiloCliRun`

#### Current controller-related platform routes

- gateway status
- gateway ready
- controller version
- gateway start
- gateway stop
- gateway restart
- config restore
- config read
- config replace
- config patch
- file tree
- file read
- file write
- doctor run
- CLI run start/status/cancel
- pairing list/approve
- device pairing list/approve

#### Current controller files

- `src/durable-objects/kiloclaw-instance/gateway.ts`
- `src/durable-objects/kiloclaw-instance/pairing.ts`
- `src/durable-objects/kiloclaw-instance/kilo-cli-run.ts`

### Explicit Boundary Notes

- `restartMachine` is a provider action, not a controller action
- `restartGatewayProcess` is a controller action, not a provider action
- config and file mutations inside the runtime are controller actions
- persisted instance config updates in DO storage are core actions
- snapshot and reassociation flows are currently Fly-specific provider
  capabilities, not part of the minimum shared provider contract

## Shared Provider Contract

The minimum shared provider contract should cover only runtime, storage, and
routing.

```ts
export type ProviderId = 'fly' | 'northflank' | 'aws' | 'k8s';

export type DesiredRuntime = {
  owner: {
    userId: string;
    sandboxId: string;
    orgId: string | null;
    instanceId?: string;
  };
  imageTag: string;
  env: Record<string, string>;
  machineSize: MachineSize | null;
  rootDisk: {
    sizeGb: number;
    mountPath: '/root';
    preferredRegions: string[];
  };
  metadata: Record<string, string>;
};

export type ProviderObservation = {
  runtimeId: string | null;
  storageId: string | null;
  region: string | null;
  runtimeState: 'starting' | 'running' | 'stopped' | 'failed' | 'destroyed' | 'unknown';
};

export type RoutingTarget = {
  baseUrl: string;
  headers: Record<string, string>;
};

export interface ProviderRuntimeAdapter<TState = unknown> {
  readonly id: ProviderId;
  readonly capabilities: {
    snapshots?: boolean;
    storageReassociation?: boolean;
    directExec?: boolean;
  };

  ensureStorage(spec: DesiredRuntime, state: TState): Promise<TState>;
  startRuntime(
    spec: DesiredRuntime,
    state: TState
  ): Promise<{ state: TState; observation: ProviderObservation }>;
  stopRuntime(state: TState): Promise<TState>;
  redeployRuntime(
    spec: DesiredRuntime,
    state: TState,
    intent: 'restart' | 'sync-config' | 'upgrade-image' | 'repair-storage'
  ): Promise<{ state: TState; observation: ProviderObservation }>;
  inspectRuntime(state: TState): Promise<ProviderObservation>;
  recoverRuntime(
    identity: { userId: string; sandboxId: string | null },
    state: TState,
    opts?: { skipCooldown?: boolean }
  ): Promise<{ state: TState; recovered: boolean }>;
  destroyRuntime(state: TState): Promise<TState>;
  destroyStorage(state: TState): Promise<TState>;
  routingTarget(state: TState): Promise<RoutingTarget | null>;
}
```

## Persisted State Shape

Introduce an explicit provider record in DO state.

Keep old Fly fields temporarily for compatibility with existing routes and admin
UI until callers migrate.

```ts
type ProviderRecord =
  | { provider: 'fly'; state: FlyProviderState }
  | { provider: 'northflank'; state: NorthflankProviderState }
  | { provider: 'aws'; state: AwsProviderState }
  | { provider: 'k8s'; state: K8sProviderState };
```

Add generic status output fields:

- `provider`
- `runtimeId`
- `storageId`
- `region`

Keep temporary compatibility fields:

- `flyAppName`
- `flyMachineId`
- `flyVolumeId`
- `flyRegion`

## Provider Module Layout

Create:

- `services/kiloclaw/src/providers/types.ts`
- `services/kiloclaw/src/providers/index.ts`
- `services/kiloclaw/src/providers/fly/`
- `services/kiloclaw/src/providers/northflank/`
- `services/kiloclaw/src/providers/aws/`
- `services/kiloclaw/src/providers/k8s/`

Registry shape:

```ts
type ProviderPlugin = {
  id: ProviderId;
  create(env: KiloClawEnv): ProviderRuntimeAdapter;
};
```

Then `KiloClawInstance` resolves the adapter from persisted `provider` and calls
its runtime methods.

## Routing Design

The worker and controller client should no longer construct Fly URLs directly.
Instead:

- provider returns `routingTarget()`
- worker proxy uses `routingTarget.baseUrl` and merges `routingTarget.headers`
- controller client does the same for controller RPCs

This removes Fly-specific routing knowledge from:

- `src/index.ts`
- `src/utils/proxy-headers.ts`
- `src/durable-objects/kiloclaw-instance/gateway.ts`

and replaces it with provider-neutral routing transport.

## Provider Helper Durable Objects

Allowed, but private to the provider module.

Appropriate uses:

- cluster/project/account bootstrap
- serialization of provider-specific naming or shared resource allocation
- caching expensive control-plane lookups
- throttling provider API calls
- per-instance helper orchestration where truly useful

Not appropriate:

- becoming the canonical store of lifecycle state
- exposing a second user-visible status model that competes with
  `KiloClawInstance`

For Kubernetes specifically, helper DOs would make sense for things like:

- cluster-level bootstrap and auth material
- namespace or shared ingress coordination
- provider-side routing discovery cache

but not as a duplicate pod/PVC state machine when Kubernetes itself already
holds those resources.

## Provider Mutability And Migration

- `provider` is immutable for normal lifecycle operations
- changing provider is an admin-only migration flow
- migration should be modeled as explicit orchestration owned by
  `KiloClawInstance`
- normal methods such as `start`, `stop`, `destroy`, and `restartMachine` act
  only on the active provider

Likely future persisted shape:

```ts
type ProviderMigrationState = null | {
  from: ProviderId;
  to: ProviderId;
  phase: 'preparing' | 'copying' | 'cutting_over' | 'cleaning_up' | 'failed';
  targetState: unknown;
  error: string | null;
};
```

## Implementation Sequence

### Phase 1: Fly Parity Extraction

- Add provider id and provider-state schema
- Implement `providers/fly` using the current Fly logic
- Update `KiloClawInstance` to resolve a provider adapter internally
- Preserve current behavior and current public routes

### Phase 2: Routing Neutralization

Goal:

- Make request routing provider-derived instead of Fly-derived while preserving
  all current public routes and Fly behavior

Concrete scope:

- Add a minimal routing contract to the provider layer
  - add a provider return type such as:

    ```ts
    type ProviderRoutingTarget = {
      baseUrl: string;
      headers: Record<string, string>;
    };
    ```

  - add `getRoutingTarget(...)` to the internal provider adapter contract
  - implement it first in `src/providers/fly/index.ts`
    - `baseUrl` should remain `https://${appName}.fly.dev`
    - provider headers should include `fly-force-instance-id`

- Move worker proxy URL/header construction behind provider routing
  - update `src/index.ts`
  - remove direct `https://${appName}.fly.dev...` construction in:
    - `/i/:instanceId/*`
    - the user-keyed catch-all proxy path
    - WebSocket forwarding paths
  - replace direct Fly header wiring with provider-derived headers merged into
    the existing forwarded headers
- Split generic proxy auth headers from provider transport headers
  - update `src/utils/proxy-headers.ts`
  - keep `x-kiloclaw-proxy-token` and other proxy/auth logic there
  - remove Fly-only header assumptions from that helper
  - likely change the helper to accept `providerHeaders?: Record<string, string>`
- Move controller RPC transport behind provider routing
  - update `src/durable-objects/kiloclaw-instance/gateway.ts`
  - replace `requireGatewayControllerContext()` with a provider-aware routing
    context resolver
  - stop constructing `https://${appName}.fly.dev${path}` directly
  - stop writing `fly-force-instance-id` directly
  - keep gateway bearer-token auth unchanged
- Add a small internal DO-facing helper for routing resolution if needed
  - if `gateway.ts` and the worker need the same routing shape, add a shared
    helper under `src/providers/` or `src/durable-objects/kiloclaw-instance/`
  - do not let worker routes read provider state ad hoc from storage fields
- Preserve phase-1 behavior boundaries
  - no public route changes
  - no new provider support yet
  - no capability-gating work yet
  - no destroy/reconcile/recovery refactor unless required for routing parity

Expected file touch list:

- `services/kiloclaw/src/providers/types.ts`
- `services/kiloclaw/src/providers/fly/index.ts`
- `services/kiloclaw/src/providers/index.ts`
- `services/kiloclaw/src/index.ts`
- `services/kiloclaw/src/utils/proxy-headers.ts`
- `services/kiloclaw/src/durable-objects/kiloclaw-instance/gateway.ts`
- possibly small shared helpers/tests adjacent to those files

Verification for phase 2:

- add or update tests proving worker proxy still forwards HTTP correctly
- add or update tests proving WebSocket upgrade paths still forward correctly
- add or update tests proving controller RPCs still hit the same Fly target and
  still send the same auth semantics
- run `pnpm --filter kiloclaw typecheck`
- run focused `kiloclaw` tests covering proxy and gateway/controller behavior

Known implementation risks:

- routing logic currently exists in two places, `src/index.ts` and
  `gateway.ts`; moving only one will leave the system half-neutralized
- `buildForwardHeaders()` currently mixes proxy auth and Fly transport details,
  so the helper boundary needs to be cleaned up without regressing proxy auth
- WebSocket paths may have slightly different header handling than normal HTTP
  proxying and should be verified explicitly

### Phase 3: State Migration

- Persist generic provider state
- Expose generic provider status fields
- Keep legacy Fly fields until all callers migrate

### Phase 4: Capability Gating

- Mark snapshot, reassociation, and other Fly-only flows as optional provider
  capabilities
- Update platform routes to reject unsupported provider capabilities clearly

### Phase 5: First Non-Fly Provider

- Add either Northflank, AWS, or Kubernetes after Fly parity is green
- Reuse the same core lifecycle and controller layers

## Test Plan

- Fly parity tests for:
  - provision
  - start
  - stop
  - destroy
  - restart/redeploy
  - metadata recovery
  - mount repair
  - destroy retry behavior
- Worker proxy parity tests for HTTP and WebSocket routing via provider targets
- Controller parity tests for:
  - gateway status/start/stop/restart
  - config read/replace/patch/restore
  - file operations
  - pairing
  - CLI run
- Backward-compat tests for existing DO state with no explicit provider
- Capability tests proving provider-specific admin flows fail clearly when the
  active provider does not support them
- Contract tests for provider adapters so new providers must satisfy runtime,
  storage, and routing guarantees

## Defaults And Assumptions

- Default provider for existing flows is `fly`
- Controller/OpenClaw behavior is intended to remain provider-independent
- Provider adapters abstract hosting and transport, not workload semantics
- Provider helper DOs are optional implementation detail
- Cross-provider migration is deferred until steady-state provider support is in
  place
