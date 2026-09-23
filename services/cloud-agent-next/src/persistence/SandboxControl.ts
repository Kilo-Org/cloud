import { DurableObject } from 'cloudflare:workers';
import {
  cloudAgentWorktreeIdSchema,
  WORKTREE_RUNTIME_HISTORY_UNAVAILABLE,
} from '@kilocode/session-ingest-contracts';
import {
  RECONCILIATION_LIMITS,
  reconcileSandboxReferences,
} from '../sandbox-control/worktree-ownership.js';
import {
  addSessionReference,
  hasForeignReference,
  markReferencesReconciled,
  removeSessionReference,
  removeWorktreeReferences,
  worktreeIdFromDirectory,
  type SessionReferenceState,
} from '../sandbox-control/session-references.js';
import { getWorktreeWorkspacePath } from '../workspace.js';
import {
  cleanWorktreeRuntime,
  isUnallocatedControlRuntime,
  loadWorktreeDeletionJournal,
  loadWorktreeDeletionJournals,
  sandboxWorktreeCleanupInputSchema,
  WORKTREE_DELETION_PREFIX,
  EXCLUSIVE_DELETION_KEY,
  RUNTIME_DELETED_KEY,
  type SandboxWorktreeCleanupInput,
} from '../sandbox-control/worktree-deletion.js';
import { getSandbox } from '@cloudflare/sandbox';
import { DEFAULT_DO_RETRY_CONFIG, withTimeout } from '@kilocode/worker-utils';
import {
  getSandboxAllocationInstance,
  getSandboxAllocationResources,
  type CloudflareContainersInstance,
  vercelSandboxResourcesSchema,
  type VercelSandboxResources,
} from '@kilocode/worker-utils/sandbox-allocation';
import { z } from 'zod';
import type { Env } from '../types.js';
import { resolveSecret } from '../auth.js';
import {
  getSandboxProviderBinding,
  requiresContainmentSandbox,
  type SessionMetadata,
} from './session-metadata.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import {
  createSandboxControlSocketHandler,
  type SandboxControlConnectionIdentity,
  type SandboxControlEventResult,
  readSandboxControlConnection,
  type SandboxControlOutboundRequest,
  type SandboxControlSocketHandler,
} from '../sandbox-control/socket.js';
import { SandboxControlConnectionError } from '../sandbox-control/waiters.js';
import {
  createSessionForwarding,
  SessionForwardingError,
  type SessionForwardRunMember,
} from '../sandbox-control/session-forwarding.js';
import { errorResponse, parseOperationPayload } from '../sandbox-control/frames.js';
import {
  generateSandboxCredential,
  hashSandboxCredential,
  parseBearerCredential,
  sandboxCredentialMatchesHash,
} from '../sandbox-control/credential.js';
import {
  SANDBOX_CONTROL_AUTO_PING,
  SANDBOX_CONTROL_AUTO_PONG,
  SandboxAcquisitionLostError,
  sessionOperationAckSchema,
  sessionOperationAuthorizationSchema,
  sessionOperationExpiresAt,
  sessionAttachPayloadSchema,
  sessionRequestIdentitySchema,
  sameSessionEventIdentity,
  wrapperInstanceIdSchema,
  type ResponseFrame,
  type SandboxEventBatchItemOutcome,
  type SandboxEventBatchPayload,
  type SandboxEventBatchResult,
  type SessionAttachPayload,
  type SessionOperationAck,
  type SessionOperationDelivery,
  type SandboxHeartbeatPayload,
  type SessionEventIdentity,
  type SessionEventPayload,
  type SessionPreparingPayload,
  type SessionRequestIdentity,
} from '../shared/sandbox-control-protocol.js';
import { DEADLINE_MS, leaseAtLeastMs } from '../sandbox-control/deadlines.js';
import {
  applyReportedSessionState,
  attachRoute,
  detachRoute,
  getRouteBySessionId,
  hasActiveWork,
  hasEnvironmentPinningWork,
  resolveSessionEventRoute,
  type AttachRouteInput,
  type SessionRoute,
} from '../sandbox-control/session-routes.js';
import { projectStatusSnapshot } from '../sandbox-control/status-snapshot.js';
import { legacyPhysicalState } from '../sandbox-state/project/physical-label.js';
import { projectStatus, type StatusProjection } from '../sandbox-state/project/status.js';
import {
  type AllocationController,
  isLiveAllocation,
} from '../sandbox-control/allocation-controller.js';
import {
  controlAlarmAnchorAt,
  dueControlAlarmAnchors,
  importLegacyControlAlarmAnchors,
  loadControlAlarmAnchors,
  scheduleControlAlarm,
  setControlAlarmAnchor,
  setControlAlarmAnchorSync,
  type ControlAlarmAnchorId,
} from '../sandbox-control/control-alarm.js';
import {
  createHealthController,
  type HealthController,
  type HealthObservation,
} from '../sandbox-control/health-controller.js';
import {
  createControlEffectPort,
  type ControlEffectObserveResult,
  type ControlEffectProvider,
  type ControlEffectStopResult,
  type NotifySessionPort,
} from '../sandbox-control/control-effect-port.js';
import {
  createControlOrchestrator,
  type ControlOrchestrator,
} from '../sandbox-control/control-orchestration.js';
import type { NotifyEffectResult } from '../sandbox-control/control-effects.js';
import { createReconcilePort } from '../sandbox-state/ports/reconcile.js';
import { loadAllocation as loadAllocationResult } from '../sandbox-state/persist/load.js';
import { POLICY } from '../sandbox-state/schedule.js';
import {
  WORKTREE_CREDENTIAL_CONTAINMENT,
  getWorktreeCredentialContainment,
  allocatedConnecting,
  type AllocatedAllocation,
  type AllocationContainment,
  type AllocationRecord,
  type AllocationTarget,
  type CreatingAllocation,
  type OnPremAllocationConfig,
  type StopProof,
  type CredentialContainmentRequirements,
} from '../sandbox-state/model/allocation.js';
import { connectingAt } from '../sandbox-state/health/reduce.js';
import type { AcquireEvent, AllocationInputEvent, DemandEvent } from '../sandbox-state/events.js';
import type { Command } from '../sandbox-state/commands.js';
import { operationId } from '../sandbox-state/commands.js';
import {
  appendTransition,
  connectionTransition,
  credentialTransition,
  deadlineTransition,
  routeTransition,
  sessionStateTransition,
  type TransitionRow,
} from '../sandbox-control/transition-log.js';
import {
  ALLOCATION_TRANSITION_EVENT,
  allocationTransitionFields,
  type AllocationTransition,
} from '../sandbox-control/allocation-transition.js';
import {
  eraseSandboxRecord,
  loadAllocation,
  loadAllocationSync,
  initialRuntimeMetadata,
  loadRuntimeMetadata,
  saveRuntimeMetadata,
  saveRuntimeMetadataSync,
  storeAllocation,
  loadRouteTable,
  loadRouteTableSync,
  loadTransitionLog,
  saveRouteTable,
  loadSessionReferences,
  saveSessionReferences,
  saveTransitionLog,
  loadSessionCredentialGrants,
  saveSessionCredentialGrants,
  saveSessionCredentialGrantsSync,
} from '../sandbox-control/durable-state.js';
import {
  buildControlNetworkPolicy,
  prepareSessionCredentials as prepareCredentials,
  removeSessionCredentialMembership,
  resolveSessionCredential,
  type SessionCredentialGrant,
} from '../sandbox-control/session-credentials.js';
import { adaptSessionAttachPayloadForWrapper } from '../sandbox-session/attach-payload.js';
import { parseControlPlaneCredential } from '../sandbox-control/managed-credential.js';
import { verifyRuntimeCredentialProxyHandle } from '../runtime-credential-proxy.js';
import {
  CONTROL_DIAGNOSTIC_STRING_CHARSET,
  CONTROL_DIAGNOSTIC_STRING_MAX_LENGTH,
  diagnosticConnection,
  diagnosticEventType,
  logControlDiagnostic,
  withControlDORetry as withDORetry,
  type ControlDiagnosticFields,
} from '../sandbox-control/diagnostics.js';
import {
  sandboxProviderConfigurationSchema,
  type ProviderAdapter,
  type ProviderAllocationIntent,
  type ProviderCreateIntent,
  type ProviderObservation,
  type SandboxProviderConfiguration,
} from '../sandbox-control/provider.js';
import { ControlRequestError } from '../sandbox-session/control-dispatch.js';
import {
  createCloudflareProviderAdapter,
  decodeCloudflareProviderRef,
} from '../sandbox-control/cloudflare-provider.js';
import { createCloudflareContainersProviderAdapter } from '../sandbox-control/cloudflare-containers-provider.js';
import {
  createVercelProviderAdapter,
  decodeVercelProviderRef,
  vercelProviderLocatorSchema,
  type VercelProviderLocator,
} from '../sandbox-control/vercel-provider.js';
import {
  VercelSandboxRestError,
  type VercelSandboxNetworkPolicy,
} from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import {
  parseVercelSandboxRuntimeConfig,
  parseVercelSandboxRuntimeDefaults,
  resolveVercelSandboxRuntimeConfig,
  type VercelSandboxRuntimeConfig,
} from '../agent-sandbox/vercel/vercel-runtime-config.js';
import {
  ByocCredentialMissingError,
  ByocCredentialResolverError,
  ByocVercelNotReadyError,
  projectByocVercelSnapshotMissing,
  resolveByocVercelCredentials,
  resolveByocVercelRuntimeConfig,
  type ByocVercelRuntimeSnapshot,
} from '../byoc/vercel-credential-resolver.js';
import {
  createOnPremProviderAdapter,
  OnPremAcknowledgementPendingError,
  OnPremLifetimeError,
  parseOnPremCreateIntent,
} from '../sandbox-control/onprem-provider.js';
import {
  getAllocation as getOnPremAllocation,
  resolveProfile as resolveOnPremProfile,
} from '../onprem/client.js';
import { resolveOnPremCredentialGrant } from '../sandbox-control/onprem-credentials.js';
import {
  onPremCredentialRpcInputSchema,
  type OnPremCredentialRpcInput,
  type OnPremCredentialResolution,
} from '../shared/onprem-credential-protocol.js';
import {
  decodeOnPremProviderRef,
  onPremProfileSchema,
  type OnPremProfile,
  type OnPremProviderBinding,
} from '../shared/onprem-protocol.js';
import {
  bindingFromLegacyProvider,
  isManagedContainerBillingExempt,
  providerKindFromBinding,
  SandboxProviderBindingSchema,
  sameSandboxProviderBinding,
  type SandboxProviderBinding,
} from '../sandbox-provider-binding.js';
import { buildControlWrapperLaunchEnv } from '../sandbox-control/wrapper-launch-env.js';
import {
  forceDestroyControlPlaneSandbox,
  getSandboxBillingRuntimeStatus,
  parseSandboxBillingInput,
  type SandboxBillingInput,
} from '../container-usage-context.js';
import { isCloudAgentContainerBillingEnabled } from '../container-billing-rollout.js';
import {
  deriveSandboxAllocationId,
  getOutboundContainerId,
  getSandboxNamespace,
} from '../sandbox-id.js';
import {
  validateContainersTerminalBillingRuntime,
  validateTerminalBillingRuntime,
  type SandboxTerminalAccessInput,
  type SandboxTerminalAccessResult,
} from '../sandbox-control/terminal-billing.js';
import { agentSandboxProviderSchema, type AgentSandboxProvider } from '../types.js';
import {
  safeSandboxRuntimeVersion,
  type ConnectionState,
  type PhysicalState,
  type SandboxRuntimeMetadata,
  type SandboxStatusSnapshot,
} from '../shared/sandbox-status.js';

const CREDENTIAL_HASH_KEY = 'wrapper_credential_hash';
const OWNER_ID_KEY = 'owner_id';
const WRAPPER_READY_AT_KEY = 'wrapper_ready_at';
const WRAPPER_HEARTBEAT_OBSERVATION_KEY = 'wrapper_heartbeat_observation';
const ACTIVE_WRAPPER_RUNTIME_KEY = 'active_wrapper_runtime';
const DIAGNOSTIC_BUNDLE_KEY = 'diagnostic_bundle';
const PROVIDER_KIND_KEY = 'provider_kind';
const PROVIDER_LOCATOR_KEY = 'provider_locator';
const PROVIDER_CONFIGURATION_KEY = 'provider_configuration';
const PROVIDER_BINDING_KEY = 'provider_binding';
const FAILURE_REASON_KEY = 'failure_reason';
const NEXT_LEASE_CHECK_AT_KEY = 'next_lease_check_at';
const BYOC_SNAPSHOT_RECOVERY_KEY = 'byoc_snapshot_recovery';
const SNAPSHOT_VALIDATOR_REF_KEY = 'snapshot_validator_ref';
const BILLING_INPUT_KEY = 'billing_input';
const ACQUISITION_RECEIPTS_KEY = 'acquisition_receipts';
const CREDENTIAL_POLICY_DIRTY_KEY = 'credential_policy_dirty';
const ONPREM_ACKNOWLEDGEMENT_KEY = 'onprem_acknowledgement';
const TERMINAL_CREDENTIAL_RENEWAL_WINDOW_MS = 60 * 60 * 1000;
const BYOC_SNAPSHOT_RECOVERY_MAX_ATTEMPTS = 5;

const byocVercelRuntimeSnapshotSchema = z.object({
  organizationId: z.string().min(1),
  credentialId: z.string().min(1),
  buildGeneration: z.string().min(1),
  runtimeSnapshotId: z.string().min(1),
});

const byocSnapshotRecoverySchema = z.object({
  snapshot: byocVercelRuntimeSnapshotSchema,
  attempts: z.number().int().nonnegative(),
});

type ByocSnapshotRecovery = z.infer<typeof byocSnapshotRecoverySchema>;

/** Identity of a pending projection: the attempt count and the exact snapshot. */
function sameByocSnapshotRecovery(
  left: ByocSnapshotRecovery,
  right: ByocSnapshotRecovery
): boolean {
  return (
    left.attempts === right.attempts &&
    left.snapshot.organizationId === right.snapshot.organizationId &&
    left.snapshot.credentialId === right.snapshot.credentialId &&
    left.snapshot.buildGeneration === right.snapshot.buildGeneration &&
    left.snapshot.runtimeSnapshotId === right.snapshot.runtimeSnapshotId
  );
}

const sandboxAcquisitionSchema = z.object({
  id: z.string().min(1).max(128),
  deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const onPremAcknowledgementSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('waiting'),
      providerRef: z.string().min(1).max(128),
      deadlineAt: sandboxAcquisitionSchema.shape.deadlineAt,
    })
    .strict(),
  z
    .object({
      state: z.literal('acknowledged'),
      providerRef: z.string().min(1).max(128),
    })
    .strict(),
]);

export type SandboxAcquisition = z.infer<typeof sandboxAcquisitionSchema>;

const snapshotValidatorInputSchema = z.object({
  build: z.object({
    organizationId: z.uuid(),
    credentialId: z.uuid(),
    generation: z.uuid(),
  }),
  allocation: z.object({
    providerRef: z.string().min(1),
    locator: vercelProviderLocatorSchema,
    createdAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().positive().safe(),
  }),
  credentialHash: z.string().regex(/^[0-9a-f]{64}$/),
});

function assertAcquisitionDeadline(acquisition: SandboxAcquisition): void {
  if (Date.now() >= acquisition.deadlineAt) throw new Error('Sandbox acquisition expired');
}

/** Same canonical allocation: the create intent id, else the provider reference. */
function sameCanonicalAllocation(left: AllocationRecord, right: AllocationRecord): boolean {
  const leftIntent = left.state.kind === 'stopped' ? undefined : left.state.createIntent?.intentId;
  const rightIntent =
    right.state.kind === 'stopped' ? undefined : right.state.createIntent?.intentId;
  if (leftIntent !== undefined || rightIntent !== undefined) return leftIntent === rightIntent;
  const leftRef = canonicalProviderRefOf(left);
  const rightRef = canonicalProviderRefOf(right);
  return leftRef !== null && leftRef === rightRef;
}

function canonicalProviderRefOf(record: AllocationRecord): string | null {
  const state = record.state;
  if (state.kind === 'stopped') return null;
  return state.target?.providerRef ?? null;
}

/** The stop-intent a canonical cleanup episode is fenced to, if one is attached. */
function canonicalStopIntent(record: AllocationRecord) {
  const state = record.state;
  return state.kind === 'stopping' || state.kind === 'unknown' ? state.stopIntent : null;
}

function canonicalStopWrapperInstanceId(record: AllocationRecord): string | undefined {
  return canonicalStopIntent(record)?.wrapperInstanceId;
}

/**
 * Canonical change predicate for commit side effects: the state kind changed, or
 * a stop cleanup episode was attached. The flat compatibility projection may
 * label the same canonical input differently, so it never gates an effect.
 */
function canonicalAllocationChanged(from: AllocationRecord, to: AllocationRecord): boolean {
  if (from.state.kind !== to.state.kind) return true;
  return canonicalStopIntent(from) === null && canonicalStopIntent(to) !== null;
}

/** The containment a canonical creating/allocated record is built with. */
function canonicalContainmentOf(record: AllocationRecord) {
  const state = record.state;
  if (state.kind === 'creating') return state.target.containment;
  if (state.kind === 'allocated') return state.target.resolvedContainment;
  return undefined;
}

/** Canonical ensure-ready routing (mirrors the legacy flat `nextEnsureReadyStep`). */
function canonicalEnsureReadyStep(
  record: AllocationRecord,
  allowCreate: boolean,
  now: number
): 'release-failed' | 'observe-unknown' | 'advance' | 'create' | 'return' {
  const state = record.state;
  if (state.kind === 'unknown') {
    if (state.reason === 'legacy_failed') return 'release-failed';
    // An unresolved create/launch retains its startup deadline and must stay
    // identity-stable for the in-flight readiness caller; observe only once the
    // retained deadline is due.
    if (state.deadlineAt > now) return 'return';
    return 'observe-unknown';
  }
  // A fresh authorized demand advances an exhausted stop; the reducer owns the
  // `DEMAND`/`ACQUIRE` transition and `check_required` has no automatic timer.
  if (state.kind === 'stopping' && state.step === 'check_required' && allowCreate) return 'advance';
  if (state.kind === 'stopped' && allowCreate) return 'create';
  return 'return';
}

/** The event that advances one canonical stop attempt for the current state. */
function canonicalStopEvent(
  record: AllocationRecord,
  reason?: string
): AllocationInputEvent | undefined {
  const state = record.state;
  if (state.kind === 'allocated') {
    return { type: 'CANCEL', scope: 'allocation', reason: reason ?? 'environment_stopped' };
  }
  if (state.kind === 'stopping') {
    return state.step === 'check_required'
      ? { type: 'CHECK' }
      : { type: 'CANCEL', scope: 'allocation', reason: state.stopIntent.reason };
  }
  if (state.kind === 'creating' || state.kind === 'unknown') return { type: 'DEADLINE' };
  return undefined;
}

type PersistedWrapperRuntime = SandboxControlConnectionIdentity & {
  readyConnectionId?: string;
};

type WrapperHeartbeatDecision =
  | 'accepted'
  | 'kilo_unhealthy'
  | 'runtime_not_ready'
  | 'stale_during_apply';

// One observation belongs to the currently armed connection. `armedAt` is the
// deadline basis time (`now` on accept, `readyAt` on ready/repair); it is not
// `armedExpiryAt` (the scheduled expiry). This is report-only: the deadline
// logic remains the single source of truth.
type WrapperHeartbeatObservation = {
  connectionId: string;
  wrapperInstanceId?: string;
  lastReceivedAt?: number;
  lastAcceptedAt?: number;
  armedAt?: number;
  armedExpiryAt?: number;
  armedBasis: 'wrapper_ready' | 'heartbeat_receipt';
  lastDecision?: WrapperHeartbeatDecision;
};

// Per-session heartbeat evidence is report-only and bounded by the
// `logControlDiagnostic` string shape (see diagnostics.ts). Entries are whole or
// omitted: a `kiloSessionId` is never truncated.
function packSessionReport(sessions: SandboxHeartbeatPayload['sessions']): string | undefined {
  let report = '';
  for (const session of sessions) {
    // A field outside the diagnostic alphabet would redact the whole joined
    // string, so omit that entry instead of losing every session.
    if (!CONTROL_DIAGNOSTIC_STRING_CHARSET.test(session.kiloSessionId)) continue;
    const entry = `${session.kiloSessionId}:${session.state}:${session.waitingOn ?? 'none'}`;
    const candidate = report.length === 0 ? entry : `${report}.${entry}`;
    if (candidate.length > CONTROL_DIAGNOSTIC_STRING_MAX_LENGTH) continue;
    report = candidate;
  }
  return report.length > 0 ? report : undefined;
}

type TerminalRuntimeSnapshot = {
  allowed: true;
  connection: SandboxControlConnectionIdentity;
  physical: AllocationRecord;
  provider: AgentSandboxProvider;
  route: SessionRoute;
  grant: SessionCredentialGrant;
};

type TerminalRuntimeRejection = {
  allowed: false;
  reason: string;
};

function sessionForwardFrameBytes(frame: unknown): number {
  return new TextEncoder().encode(JSON.stringify(frame)).byteLength;
}

function batchOutcomes(
  payload: SandboxEventBatchPayload,
  status: SandboxEventBatchItemOutcome['status'],
  retryable?: boolean
): SandboxEventBatchResult {
  return {
    outcomes: payload.items.map(item => ({
      receiptId: item.receiptId,
      status,
      ...(retryable === undefined ? {} : { retryable }),
    })),
  };
}

type BatchForwardMember = {
  payload: SandboxEventBatchPayload;
  fields: ControlDiagnosticFields;
  queuedAt: number;
};

function batchCoalescingIdentity(
  identity: SessionEventIdentity,
  connection: SandboxControlConnectionIdentity,
  admission: { sessionId: string; nativeRuntimeId?: string }
): string {
  return JSON.stringify([
    identity.directory,
    identity.kiloSessionId ?? null,
    identity.rootKiloSessionId ?? null,
    identity.nativeRuntimeId ?? null,
    connection.connectionId,
    connection.wrapperInstanceId ?? null,
    connection.providerInstanceId,
    admission.sessionId,
    admission.nativeRuntimeId ?? null,
  ]);
}

type ForwardOperation =
  | 'receiveSandboxControlEvent'
  | 'receiveSandboxControlPreparing'
  | 'receiveSandboxControlEventBatch';

type SessionFrameDelivery = {
  applied: boolean;
  retryable?: boolean;
  skipped: boolean;
  timedOut: boolean;
  attempts: number;
  rpcWaitMs: number;
  failed: boolean;
};

export type AttachSessionInput = AttachRouteInput;

/** Aggregate work observed across the attached session routes. */
export type WorkState = 'idle' | 'active' | 'finalizing';

/**
 * Derived control read model. The status label and detail code are the
 * canonical projection of the allocation, health and `now`; the observation
 * fields remain for the session dispatch decisions that read them.
 */
export type SandboxControlStatus = StatusProjection & {
  physical: PhysicalState;
  connection: ConnectionState;
  work: WorkState;
  wrapperInstanceId?: string;
  /**
   * The canonical allocation's health incarnation while an allocation is
   * allocated (the returned provider reference). Omitted when nothing is
   * allocated. Never `allocationIdentity`.
   */
  allocationIncarnation?: string;
  operationResults?: true;
  runtimeRecovery?: true;
  hardStopAt?: number;
  failureReason?: SandboxProviderFailureReason;
};

export type SandboxProviderFailureReason =
  | 'byoc_credential_missing'
  | 'byoc_vercel_not_ready'
  | 'byoc_vercel_forbidden'
  | 'byoc_vercel_capacity'
  | 'environment_failed'
  | 'onprem_unavailable'
  | 'onprem_lifetime_exhausted';

function providerFailureReason(
  binding: SandboxProviderBinding,
  error: unknown
): SandboxProviderFailureReason | undefined {
  if (binding.kind === 'onprem') {
    return error instanceof OnPremLifetimeError
      ? 'onprem_lifetime_exhausted'
      : 'onprem_unavailable';
  }
  if (error instanceof ByocCredentialMissingError) return 'byoc_credential_missing';
  if (error instanceof ByocVercelNotReadyError) return 'byoc_vercel_not_ready';
  if (
    binding.kind !== 'vercel' ||
    binding.source.kind !== 'byoc' ||
    !(error instanceof VercelSandboxRestError)
  ) {
    return undefined;
  }
  if (error.operation === 'create' && error.status === 410) return 'byoc_vercel_not_ready';
  if (error.status === 401 || error.status === 403) return 'byoc_vercel_forbidden';
  if (error.status === 429) return 'byoc_vercel_capacity';
  return undefined;
}

export type ControlRuntimeCredentialProxyFence = {
  plane: 'control';
  allocationId: string;
  providerInstanceId: string;
  connectionId: string;
  wrapperInstanceId: string;
};

export class SandboxControl extends DurableObject<Env> {
  readonly sandboxId: string;
  private socketHandler: SandboxControlSocketHandler;
  private kiloReady = false;
  private activeConnection: SandboxControlConnectionIdentity | null = null;
  private readyConnectionId: string | null = null;
  private providerBinding: SandboxProviderBinding = { kind: 'cloudflare' };

  /** The provider kind always derives from the binding; there is one owner. */
  private get providerKind(): AgentSandboxProvider {
    return providerKindFromBinding(this.providerBinding);
  }

  private vercelResources: VercelSandboxResources | undefined;
  private containersInstance: CloudflareContainersInstance | undefined;
  private readonly sessionForwarding = createSessionForwarding();
  private forwardSequence = 0;
  private credentialUpdates: Promise<void> = Promise.resolve();
  private provider: ProviderAdapter;
  private readonly allocationOrchestrator: ControlOrchestrator;
  private readonly healthController: HealthController;
  /**
   * Transient handoff of the create-effect credential to the launch effect. The
   * canonical port always calls `provider.create` then `provider.launch` inside
   * one `create` execution (`control-effect-port.ts`), so this only spans two
   * calls in that execution — never a persistence boundary. It is fenced on
   * `providerRef`, so a stale or replayed launch cannot consume another create's
   * credential; a DO eviction between the two calls fails the whole RPC and the
   * reducer re-drives it.
   */
  private controlLaunchCredential: {
    providerRef: string;
    credential: string;
    intentId: string;
  } | null = null;
  /**
   * The deadline of the acquisition that is driving the in-flight create, if
   * any. The atomic create+launch effect re-checks it immediately before
   * launch so an acquisition that expires while the provider create is
   * outstanding never launches a wrapper (the legacy `assertAcquisitionDeadline`
   * before `provider.launch`).
   */
  private controlAcquisitionDeadline: number | null = null;
  private stopAttemptInFlight: {
    record: AllocationRecord;
    promise: Promise<AllocationRecord>;
  } | null = null;
  private vercelLocator: VercelProviderLocator | undefined;
  private readonly deletingWorktrees = new Set<string>();
  private exclusiveDeletionWorktreeId: string | undefined;
  private runtimeDeleted = false;
  private readonly readinessOperations = new Set<Promise<unknown>>();
  private readonly lifecycleOperations = new Set<Promise<unknown>>();
  private worktreeDeletionChain: Promise<unknown> = Promise.resolve();
  private operationalInitialization: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sandboxId = ctx.id.name ?? ctx.id.toString();
    this.provider = this.createProviderAdapter('cloudflare');
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(SANDBOX_CONTROL_AUTO_PING, SANDBOX_CONTROL_AUTO_PONG)
    );
    this.socketHandler = createSandboxControlSocketHandler(ctx, this.sandboxId, undefined, {
      validateHandshake: providerInstanceId => this.validateHandshake(providerInstanceId),
      onHandshakeComplete: (identity, runtime) => this.onHandshakeComplete(identity, runtime),
      onReady: identity => this.onWrapperReady(identity),
      onHeartbeat: (payload, identity) => this.onHeartbeat(payload, identity),
      onSessionEvent: (sessionIdentity, payload, identity, receiptId, sequence) =>
        this.onSessionEvent(sessionIdentity, payload, identity, receiptId, sequence),
      onSessionPreparing: (sessionIdentity, payload, identity, receiptId, sequence) =>
        this.onSessionPreparing(sessionIdentity, payload, identity, receiptId, sequence),
      onSessionEventBatch: (payload, identity) => this.onSessionEventBatch(payload, identity),
      onOperationResult: (session, delivery, identity) =>
        this.onOperationResult(session, delivery, identity),
      onSocketClosed: (handshakeComplete, identity) =>
        this.onSocketClosed(handshakeComplete, identity),
    });
    this.allocationOrchestrator = createControlOrchestrator({
      storage: ctx.storage,
      effects: createControlEffectPort({
        provider: this.liveControlProvider(),
        notifySession: this.liveNotifySession(),
        reconcile: createReconcilePort(request => this.socketHandler.sendRequest(request)),
      }),
      resumable: this.provider.resumable,
      shouldDeferRecovery: () => this.shouldDeferRecovery(),
      onTransition: transition => this.recordAllocationTransition(transition),
    });
    this.healthController = createHealthController({
      dispatch: (event, now) => this.allocationOrchestrator.dispatch(event, now),
    });
  }

  /** The canonical allocation machine: the single dispatcher for allocation and health. */
  private get allocationController(): AllocationController {
    return this.allocationOrchestrator.controller;
  }

  /** One structured line per committed, non-no-op allocation/health transition. */
  private recordAllocationTransition(transition: AllocationTransition): void {
    this.logDiagnostic(ALLOCATION_TRANSITION_EVENT, {
      ...allocationTransitionFields(transition),
      ...diagnosticConnection(this.activeConnection),
    });
  }

  /**
   * Whether a recovery attempt must be deferred rather than failed. Defer while
   * the runtime is either reconnectable or still coming up, so its attempt budget
   * is not spent before it gets a chance: no handshaken socket with a
   * recovery-capable wrapper expected to reconnect, or a handshaken socket whose
   * replacement has not signalled ready yet. The absolute recovery deadline still
   * terminates the wait. This is the single predicate; the command runner owns
   * applying it.
   */
  private shouldDeferRecovery(): boolean {
    if (this.activeConnection === null) return false;
    if (!this.socketHandler.hasHandshakenSocket()) {
      return this.activeConnection.recoveryCapable === true;
    }
    return this.readyConnectionId === null;
  }

  private async observeHealth(observation: HealthObservation): Promise<void> {
    const before = await this.readCanonicalAllocation();
    const decision = await this.healthController.observe(observation);
    if (decision !== undefined) {
      await this.allocationOrchestrator.run(decision.commands);
      await this.afterCanonicalCommit(before, await this.readCanonicalAllocation());
    }
    await this.scheduleAlarm();
  }

  private ensureOperationalInitialized(): Promise<void> {
    return (this.operationalInitialization ??= this.ctx.blockConcurrencyWhile(async () => {
      const ctx = this.ctx;
      const [readyAt, runtime, storedBinding, configuration, allocation] = await Promise.all([
        ctx.storage.get<number>(WRAPPER_READY_AT_KEY),
        ctx.storage.get<PersistedWrapperRuntime>(ACTIVE_WRAPPER_RUNTIME_KEY),
        ctx.storage.get<unknown>(PROVIDER_BINDING_KEY),
        this.readProviderConfiguration(),
        loadAllocationResult(ctx.storage),
      ]);
      if (!allocation.ok) {
        throw new Error(`Invalid canonical allocation: ${allocation.reason}`);
      }
      let record = allocation.value;
      if (
        record.state.kind === 'allocated' &&
        record.state.health.kind === 'connecting' &&
        record.state.target.providerRef !== null &&
        (allocation.source === 'legacy' ||
          record.state.health.incarnation === record.state.createIntent.intentId)
      ) {
        record = {
          ...record,
          state: {
            ...record.state,
            health: {
              kind: 'connecting',
              incarnation: record.state.target.providerRef,
              deadlineAt: Date.now() + POLICY.connectingDeadlineMs,
            },
          },
        };
        await storeAllocation(ctx.storage, record);
      }
      // One-time pre-cutover import, owned by the alarm module and run before
      // any anchor mutation at this boot boundary.
      await importLegacyControlAlarmAnchors(ctx.storage, Date.now());
      this.vercelLocator = vercelProviderLocatorSchema
        .optional()
        .parse(await ctx.storage.get(PROVIDER_LOCATOR_KEY));
      this.providerBinding =
        storedBinding !== undefined
          ? SandboxProviderBindingSchema.parse(storedBinding)
          : bindingFromLegacyProvider(configuration?.provider ?? 'cloudflare');
      this.vercelResources =
        configuration?.provider === 'vercel' ? configuration.resources : undefined;
      this.containersInstance =
        configuration?.provider === 'cloudflare-containers' ? configuration.instance : undefined;
      if (!this.isByocBinding()) {
        this.provider = this.createProviderAdapter(this.providerKind, record);
      }
      await this.syncOnPremHardStop(record);
      this.runtimeDeleted = (await ctx.storage.get(RUNTIME_DELETED_KEY)) === true;
      this.exclusiveDeletionWorktreeId = cloudAgentWorktreeIdSchema
        .optional()
        .parse(await ctx.storage.get(EXCLUSIVE_DELETION_KEY));
      for (const key of (await ctx.storage.list({ prefix: WORKTREE_DELETION_PREFIX })).keys()) {
        this.deletingWorktrees.add(
          cloudAgentWorktreeIdSchema.parse(key.slice(WORKTREE_DELETION_PREFIX.length))
        );
      }
      if (
        canonicalStopIntent(record) !== null ||
        (record.state.kind !== 'allocated' && record.state.kind !== 'creating')
      ) {
        this.socketHandler.closeAll('Sandbox runtime unavailable');
        return;
      }
      const current = this.socketHandler.getConnectionIdentity();
      this.activeConnection = runtime ?? current;
      // Readiness is the canonical allocation/connection state only. The legacy
      // recovery-decision records no longer gate it; they stay inert for C3c.
      if (
        runtime &&
        current &&
        this.sameConnection(runtime, current) &&
        runtime.readyConnectionId === current.connectionId &&
        readyAt !== undefined
      ) {
        this.readyConnectionId = current.connectionId;
        this.kiloReady = true;
      } else {
        this.kiloReady = !runtime && current !== null && readyAt !== undefined;
      }
    }));
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureOperationalInitialized();
    const upgrade = request.headers.get('Upgrade');
    if (upgrade?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const authorized = await this.authorizeWrapper(request);
    if (!authorized) {
      this.logDiagnostic('socket_auth', { result: 'rejected' }, 'warn');
      return new Response('Unauthorized', { status: 401 });
    }

    const response = this.socketHandler.accept();
    await this.armInfrastructureAnchor('socketHandshake', Date.now() + DEADLINE_MS.socketHandshake);
    return response;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ensureOperationalInitialized();
    if (this.runtimeDeleted) return;
    await this.trackLifecycleOperation(
      Promise.resolve(this.socketHandler.handleMessage(ws, message))
    );
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.ensureOperationalInitialized();
    if (this.runtimeDeleted) return;
    await this.trackLifecycleOperation(Promise.resolve(this.socketHandler.handleClose(ws)));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    await this.ensureOperationalInitialized();
    if (this.runtimeDeleted) return;
    await this.trackLifecycleOperation(this.runAlarm());
  }

  private trackLifecycleOperation<T>(operation: Promise<T>): Promise<T> {
    this.lifecycleOperations.add(operation);
    return operation.finally(() => this.lifecycleOperations.delete(operation));
  }

  private async runAlarm(): Promise<void> {
    const now = Date.now();
    const anchors = await loadControlAlarmAnchors(this.ctx.storage);
    for (const id of dueControlAlarmAnchors(anchors, now)) {
      const before = controlAlarmAnchorAt(await loadControlAlarmAnchors(this.ctx.storage), id);
      if (before === null || before > now) continue;
      try {
        this.logDiagnostic('deadline_fired', {
          deadlineId: id,
          deadlineAt: before,
          latenessMs: Math.max(0, now - before),
          connectionState: this.connectionState(),
          ...diagnosticConnection(this.activeConnection),
        });
      } catch {
        // Report-only: the deadline action must run even if diagnostics fail.
      }
      await this.appendLog(deadlineTransition(now, id, 'fired'));
      await this.handleInfrastructureDeadline(id);
      await this.ctx.storage.transaction(async () => {
        const latest = controlAlarmAnchorAt(await loadControlAlarmAnchors(this.ctx.storage), id);
        if (latest !== null && latest <= now) {
          await setControlAlarmAnchor(this.ctx.storage, id, null);
        }
      });
    }
    await this.driveCanonicalDeadline(now);
    await this.scheduleAlarm();
  }

  /**
   * One canonical `DEADLINE` per alarm. The allocation/health reducers own the
   * transition (idle stop, health expiry, recovery exhaustion, create/stop
   * deadlines); this only dispatches the event, runs its effects and commits.
   */
  private async driveCanonicalDeadline(now: number): Promise<void> {
    const record = await this.readCanonicalAllocation();
    if (record.state.kind === 'stopped') return;
    const decision = await this.allocationOrchestrator.dispatch({ type: 'DEADLINE' }, now);
    if (decision === undefined) return;
    await this.allocationOrchestrator.run(decision.commands, now);
    await this.afterCanonicalCommit(record, await this.readCanonicalAllocation());
  }

  async setWrapperCredentialHash(hash: string): Promise<void> {
    await this.ensureOperationalInitialized();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error('Invalid wrapper credential hash');
    }
    const previous = this.activeConnection ?? this.socketHandler.getConnectionIdentity();
    await this.ctx.storage.transaction(async () => {
      // The socket is closed below, so the provisional-handshake anchor no longer
      // applies. The allocation-owned deadlines are the canonical machine's.
      await setControlAlarmAnchor(this.ctx.storage, 'socketHandshake', null);
      await this.ctx.storage.put(CREDENTIAL_HASH_KEY, hash);
      await this.ctx.storage.delete([
        ACTIVE_WRAPPER_RUNTIME_KEY,
        WRAPPER_READY_AT_KEY,
        WRAPPER_HEARTBEAT_OBSERVATION_KEY,
      ]);
      await this.scheduleAlarm();
      await this.appendLog(credentialTransition(Date.now(), 'rotated'));
    });
    this.activeConnection = null;
    this.readyConnectionId = null;
    this.kiloReady = false;
    this.socketHandler.closeAll('Credential rotated');
    if (previous?.wrapperInstanceId) {
      await this.invalidateTerminalRuntime(previous.wrapperInstanceId, true);
    }
  }

  /**
   * Seed a BYOC Vercel snapshot validator control. The validator sandbox was
   * created out-of-band by the snapshot build, so the control adopts it as an
   * allocated Vercel allocation bound to the customer credential instead of
   * demanding one. A re-run with the same reference only rotates the wrapper
   * credential.
   */
  async initializeSnapshotValidator(
    input: z.infer<typeof snapshotValidatorInputSchema>
  ): Promise<void> {
    await this.ensureOperationalInitialized();
    const { build, allocation, credentialHash } = snapshotValidatorInputSchema.parse(input);
    const expectedId = `ses-byoc-validator-${build.generation.replaceAll('-', '')}`;
    const reference = decodeVercelProviderRef(allocation.providerRef);
    if (this.sandboxId !== expectedId || !reference) {
      throw new Error('Snapshot validator identity mismatch');
    }
    const binding: SandboxProviderBinding = {
      kind: 'vercel',
      source: {
        kind: 'byoc',
        organizationId: build.organizationId,
        credentialId: build.credentialId,
      },
    };
    const intentId = `byoc-validator-${build.generation}`;
    await this.ctx.storage.transaction(async () => {
      const record = await this.readCanonicalAllocation();
      const registered = await this.ctx.storage.get<string>(SNAPSHOT_VALIDATOR_REF_KEY);
      const storedBinding = SandboxProviderBindingSchema.optional().parse(
        await this.ctx.storage.get(PROVIDER_BINDING_KEY)
      );
      if (registered !== undefined) {
        const locator = vercelProviderLocatorSchema
          .optional()
          .parse(await this.ctx.storage.get(PROVIDER_LOCATOR_KEY));
        const target = record.state.kind === 'stopped' ? null : record.state.target;
        if (
          registered !== allocation.providerRef ||
          !storedBinding ||
          !sameSandboxProviderBinding(storedBinding, binding) ||
          JSON.stringify(locator) !== JSON.stringify(allocation.locator) ||
          record.state.kind !== 'allocated' ||
          target?.providerRef !== allocation.providerRef ||
          record.state.createIntent.intentId !== intentId ||
          target.allocationName !== reference.sandboxName
        ) {
          throw new Error('Snapshot validator allocation changed');
        }
        if ((await this.ctx.storage.get(CREDENTIAL_HASH_KEY)) === credentialHash) return;
        if (
          (await this.ctx.storage.get(ACTIVE_WRAPPER_RUNTIME_KEY)) !== undefined ||
          this.ctx.getWebSockets().length > 0
        ) {
          throw new Error('Snapshot validator wrapper already connected');
        }
        await this.ctx.storage.put(CREDENTIAL_HASH_KEY, credentialHash);
        await this.appendLog(credentialTransition(Date.now(), 'rotated'));
        return;
      }
      if (
        record.state.kind !== 'stopped' ||
        record.state.summary !== null ||
        storedBinding !== undefined ||
        (await this.ctx.storage.get(PROVIDER_KIND_KEY)) !== undefined ||
        (await this.readOwner()) !== null ||
        this.runtimeDeleted ||
        allocation.expiresAt <= Math.max(Date.now(), allocation.createdAt)
      ) {
        throw new Error('Snapshot validator control is unavailable');
      }
      const { teamId: _teamId, ...vercel } = allocation.locator;
      const containment = getWorktreeCredentialContainment(false);
      const target: AllocationTarget = {
        provider: 'vercel',
        providerRef: allocation.providerRef,
        allocationName: reference.sandboxName,
        capabilities: { persistentWorkspace: true, destroysOnStop: false },
        containment,
        resolvedContainment: { ...containment, providerRef: allocation.providerRef },
        vercel,
      };
      const now = Date.now();
      const health = connectingAt(allocation.providerRef, now);
      const next: AllocationRecord = {
        v: 2,
        resumable: false,
        state: allocatedConnecting(target, { intentId, createdAt: allocation.createdAt }, health),
      };
      await storeAllocation(this.ctx.storage, next);
      await this.ctx.storage.put({
        [PROVIDER_BINDING_KEY]: binding,
        [PROVIDER_KIND_KEY]: binding.kind,
        [PROVIDER_LOCATOR_KEY]: allocation.locator,
        [SNAPSHOT_VALIDATOR_REF_KEY]: allocation.providerRef,
        [CREDENTIAL_HASH_KEY]: credentialHash,
        [NEXT_LEASE_CHECK_AT_KEY]: allocation.expiresAt - leaseAtLeastMs(),
      });
      await this.scheduleAlarm();
      await this.appendLog(credentialTransition(Date.now(), 'issued'));
    });
    this.providerBinding = binding;
    this.vercelLocator = allocation.locator;
  }

  /** Confirm the snapshot validator's allocation is gone and release its control. */
  async confirmSnapshotValidatorStopped(providerRef: string): Promise<void> {
    await this.ensureOperationalInitialized();
    if (
      !/^ses-byoc-validator-[0-9a-f]{32}$/i.test(this.sandboxId) ||
      !decodeVercelProviderRef(providerRef)
    ) {
      throw new Error('Snapshot validator identity mismatch');
    }
    await this.ctx.storage.transaction(async () => {
      const registered = await this.ctx.storage.get<string>(SNAPSHOT_VALIDATOR_REF_KEY);
      const record = await this.readCanonicalAllocation();
      if (registered === undefined && record.state.kind === 'stopped') {
        await this.ctx.storage.put(SNAPSHOT_VALIDATOR_REF_KEY, providerRef);
      } else if (registered !== providerRef) {
        throw new Error('Snapshot validator allocation changed');
      }
      if (record.state.kind !== 'stopped') {
        if (canonicalProviderRefOf(record) !== providerRef) {
          throw new Error('Snapshot validator allocation changed');
        }
        const summary = record.state.target?.allocationName;
        const stopped: AllocationRecord = {
          v: 2,
          resumable: record.resumable,
          state: {
            kind: 'stopped',
            summary: {
              providerRef,
              ...(summary === undefined ? {} : { allocationName: summary }),
            },
          },
        };
        await storeAllocation(this.ctx.storage, stopped);
      }
    });
    this.activeConnection = null;
    this.readyConnectionId = null;
    this.kiloReady = false;
    this.socketHandler.closeAll('Snapshot validator stopped');
  }

  async initializeOwner(ownerId: string): Promise<{ ownerId: string }> {
    await this.ensureOperationalInitialized();
    const normalized = typeof ownerId === 'string' ? ownerId.trim() : '';
    if (normalized.length === 0) {
      throw new Error('ownerId must be a non-empty string');
    }

    const stored = await this.readOwner();
    if (stored !== null) {
      if (stored !== normalized) {
        throw new Error('Sandbox owner mismatch');
      }
      return { ownerId: stored };
    }

    await this.ctx.storage.put(OWNER_ID_KEY, normalized);
    return { ownerId: normalized };
  }

  async getOwner(): Promise<string | null> {
    await this.ensureOperationalInitialized();
    return this.readOwner();
  }

  async getRuntimeCredentialProxyFence(input: {
    ownerId: string;
    sessionId: string;
    kiloSessionId: string;
    directory: string;
  }): Promise<ControlRuntimeCredentialProxyFence | null> {
    await this.ensureOperationalInitialized();
    if (
      typeof input.ownerId !== 'string' ||
      typeof input.sessionId !== 'string' ||
      typeof input.kiloSessionId !== 'string' ||
      typeof input.directory !== 'string'
    ) {
      return null;
    }
    const [ownerId, routes, record, grants] = await Promise.all([
      this.readOwner(),
      loadRouteTable(this.ctx.storage),
      this.readCanonicalAllocation(),
      loadSessionCredentialGrants(this.ctx.storage),
    ]);
    if (ownerId !== input.ownerId) return null;
    const route = routes.get(input.sessionId);
    const provisioned = grants.some(
      grant =>
        grant.userId === input.ownerId &&
        grant.directory === input.directory &&
        grant.expiresAt > Date.now() &&
        grant.members.some(
          member =>
            member.sessionId === input.sessionId && member.kiloSessionId === input.kiloSessionId
        )
    );
    if (
      (!route && !provisioned) ||
      (route &&
        (route.ownerId !== input.ownerId ||
          route.kiloSessionId !== input.kiloSessionId ||
          route.directory !== input.directory))
    ) {
      return null;
    }
    const worktreeId = route?.worktreeId ?? worktreeIdFromDirectory(input.directory);
    if (
      this.runtimeDeleted ||
      this.exclusiveDeletionWorktreeId ||
      (worktreeId && this.deletingWorktrees.has(worktreeId)) ||
      record.state.kind !== 'allocated' ||
      canonicalStopIntent(record) !== null ||
      canonicalProviderRefOf(record) === null
    ) {
      return null;
    }
    const runtime = this.establishedWrapperForAllocation(record);
    if (
      !runtime ||
      !runtime.wrapperInstanceId ||
      runtime.providerInstanceId !== canonicalProviderRefOf(record)
    ) {
      return null;
    }
    return {
      plane: 'control',
      allocationId: record.state.createIntent.intentId,
      providerInstanceId: runtime.providerInstanceId,
      connectionId: runtime.connectionId,
      wrapperInstanceId: runtime.wrapperInstanceId,
    };
  }

  async request(input: SandboxControlOutboundRequest): Promise<ResponseFrame> {
    await this.ensureOperationalInitialized();
    if (input.operation === 'session.git.summary' || input.operation === 'session.git.snapshot') {
      return this.requestWorktreeChanges(input);
    }
    const maintenance =
      input.operation === 'session.operation.get' || input.operation === 'session.operation.ack';
    if (!maintenance) await this.assertRequestWorktreeAdmission(input);
    if (input.operation === 'worktree.delete' || input.operation === 'worktree.prepareDeletion') {
      throw new Error('Worktree cleanup requires the deletion coordinator');
    }
    const expectedWrapperInstanceId =
      input.expectedWrapperInstanceId === undefined
        ? undefined
        : wrapperInstanceIdSchema.parse(input.expectedWrapperInstanceId);
    const authorization = input.authorization
      ? sessionOperationAuthorizationSchema.safeParse(input.authorization)
      : undefined;
    const maintenanceAck =
      input.operation === 'session.operation.ack'
        ? sessionOperationAckSchema.safeParse(input.payload)
        : undefined;
    const maintenanceAuthorization =
      input.operation === 'session.operation.get'
        ? sessionOperationAuthorizationSchema.safeParse(input.payload)
        : maintenanceAck?.success
          ? sessionOperationAuthorizationSchema.safeParse(maintenanceAck.data.authorization)
          : undefined;
    if (
      authorization &&
      (!authorization.success ||
        !this.socketHandler.supportsOperationResults() ||
        (input.operation !== 'session.attach' && input.operation !== 'session.prompt') ||
        authorization.data.operation !== input.operation ||
        input.session === undefined ||
        authorization.data.session.sessionId !== input.session.sessionId ||
        authorization.data.session.kiloSessionId !== input.session.kiloSessionId ||
        authorization.data.session.directory !== input.session.directory ||
        (expectedWrapperInstanceId !== undefined &&
          authorization.data.wrapperInstanceId !== expectedWrapperInstanceId) ||
        Date.now() >= authorization.data.dispatchDeadlineAt)
    )
      throw new Error('Invalid session operation authorization');
    if (
      maintenance &&
      (!maintenanceAuthorization ||
        !maintenanceAuthorization.success ||
        input.session === undefined ||
        maintenanceAuthorization.data.session.sessionId !== input.session.sessionId ||
        maintenanceAuthorization.data.session.kiloSessionId !== input.session.kiloSessionId ||
        maintenanceAuthorization.data.session.directory !== input.session.directory ||
        Date.now() >= sessionOperationExpiresAt(maintenanceAuthorization.data))
    )
      throw new Error('Invalid session operation maintenance authorization');
    const recoveryInteraction =
      (input.operation === 'session.permission.resolve' ||
        input.operation === 'session.question.resolve') &&
      this.socketHandler.supportsConnectionRecovery();
    const usesMaintenanceChannel = maintenance || recoveryInteraction;
    const runtime = usesMaintenanceChannel
      ? this.socketHandler.getConnectionIdentity()
      : this.readyWrapperRuntime();
    if (!runtime)
      throw new ControlRequestError({
        code: 'not_ready',
        message: 'Sandbox runtime is not ready',
        retryable: true,
        admission: 'not-admitted',
      });
    if (
      expectedWrapperInstanceId !== undefined &&
      runtime.wrapperInstanceId !== expectedWrapperInstanceId
    ) {
      throw new Error('Sandbox wrapper runtime changed');
    }
    if (
      input.expectedConnection &&
      (runtime.connectionId !== input.expectedConnection.connectionId ||
        runtime.providerInstanceId !== input.expectedConnection.providerInstanceId ||
        runtime.wrapperInstanceId !== input.expectedConnection.wrapperInstanceId)
    ) {
      throw new Error('Sandbox control connection changed');
    }
    if (
      authorization?.success &&
      authorization.data.wrapperInstanceId !== runtime.wrapperInstanceId
    )
      throw new Error('Sandbox wrapper runtime changed');
    const isCurrent = () => {
      const current = usesMaintenanceChannel
        ? this.socketHandler.getConnectionIdentity()
        : this.readyWrapperRuntime();
      return current !== null && this.sameConnection(current, runtime);
    };
    if (
      maintenanceAuthorization?.success &&
      maintenanceAuthorization.data.wrapperInstanceId !== runtime.wrapperInstanceId
    )
      throw new Error('Sandbox wrapper runtime changed');
    const allocation = await this.readCanonicalAllocation();
    if (
      (!maintenance && allocation.state.kind !== 'allocated') ||
      (!maintenance && canonicalStopIntent(allocation) !== null) ||
      canonicalProviderRefOf(allocation) !== runtime.providerInstanceId ||
      !this.matchesLiveOnPremProviderReference(allocation, runtime.providerInstanceId) ||
      !isCurrent()
    ) {
      throw new ControlRequestError({
        code: 'not_ready',
        message: 'Sandbox runtime is not ready',
        retryable: true,
        admission: 'not-admitted',
      });
    }
    if (input.operation === 'session.attach' || input.operation === 'session.prompt') {
      const payload = parseOperationPayload(input.operation, input.payload);
      if (!payload.ok) throw new Error(payload.error.message);
      const attach =
        input.operation === 'session.attach'
          ? sessionAttachPayloadSchema.parse(payload.payload)
          : undefined;
      if (attach?.runtimeIsolation === 'per-session') {
        if (runtime.runtimeIsolation !== true) {
          throw new Error('Sandbox wrapper does not support per-session runtime isolation');
        }
      }
      const identity = sessionRequestIdentitySchema.safeParse(input.session);
      if (!identity.success) throw new Error('session identity is required');
      let pinned: { from: AllocationRecord; to: AllocationRecord } | undefined;
      await this.ctx.storage.transaction(async () => {
        const current = await this.readCanonicalAllocation();
        const table = await loadRouteTable(this.ctx.storage);
        const route = table.get(identity.data.sessionId);
        if (
          current.state.kind !== 'allocated' ||
          canonicalStopIntent(current) !== null ||
          canonicalProviderRefOf(current) !== runtime.providerInstanceId ||
          !this.matchesLiveOnPremProviderReference(current, runtime.providerInstanceId) ||
          !sameCanonicalAllocation(allocation, current) ||
          !isCurrent()
        ) {
          throw new Error('Sandbox wrapper runtime changed');
        }
        if (
          !route ||
          route.kiloSessionId !== identity.data.kiloSessionId ||
          route.directory !== identity.data.directory ||
          route.retiringNativeRuntimeId !== undefined
        ) {
          throw new Error('Session is not attached to a ready sandbox runtime');
        }
        this.assertWorktreeAdmission(route.worktreeId);
        const now = Date.now();
        if (input.operation === 'session.prompt') {
          const previous = route.lastState;
          applyReportedSessionState(
            table,
            route.kiloSessionId,
            { state: 'active', idleForMs: 0, waitingOn: 'model' },
            now
          );
          await saveRouteTable(this.ctx.storage, table);
          if (previous !== 'active') {
            await this.appendLog(
              sessionStateTransition(now, route.kiloSessionId, previous, 'active')
            );
          }
        }
        // Validated demand pins the canonical allocation: clear the idle anchor
        // so the idle deadline cannot stop the runtime mid-request. The next
        // pinned heartbeat keeps it clear and an idle heartbeat re-arms it.
        const record = await this.readCanonicalAllocation();
        if (record.state.kind === 'allocated' && record.state.idleAt !== null) {
          const decision = await this.allocationOrchestrator.dispatch({
            type: 'DEMAND',
            requestId: crypto.randomUUID(),
            target: record.state.target,
            createIntent: record.state.createIntent,
          });
          if (decision !== undefined) pinned = { from: record, to: decision.state };
        }
        await this.scheduleAlarm();
        if (!isCurrent()) throw new Error('Sandbox wrapper runtime changed');
      });
      if (pinned) await this.afterCanonicalCommit(pinned.from, pinned.to);
    }
    if (!usesMaintenanceChannel) await this.assertRequestWorktreeAdmission(input);
    if (recoveryInteraction) await this.assertRecoveryInteraction(input, runtime, allocation);
    if (!isCurrent()) throw new Error('Sandbox wrapper runtime changed');
    const outbound =
      input.operation === 'session.attach'
        ? {
            ...input,
            payload: {
              ...adaptSessionAttachPayloadForWrapper(
                sessionAttachPayloadSchema.parse(input.payload),
                this.socketHandler.supportsWorkingBranches?.() === true
              ),
              ...(this.supportsNativeRuntimeIdCapture()
                ? { captureNativeRuntimeId: true as const }
                : {}),
            },
          }
        : input;
    return this.socketHandler.sendRequest(outbound);
  }

  private supportsNativeRuntimeIdCapture(): boolean {
    return (
      this.socketHandler.supportsOperationResults() &&
      this.socketHandler.supportsNativeRuntimeIdCapture() === true
    );
  }

  private async assertRecoveryInteraction(
    input: SandboxControlOutboundRequest,
    runtime: SandboxControlConnectionIdentity,
    allocation: AllocationRecord
  ): Promise<void> {
    const session = sessionRequestIdentitySchema.parse(input.session);
    const payload = parseOperationPayload(input.operation, input.payload);
    if (!payload.ok) throw new Error(payload.error.message);
    await this.ctx.storage.transaction(async tx => {
      const current = await this.readCanonicalAllocation();
      const route = (await loadRouteTable(tx)).get(session.sessionId);
      // The canonical/current-connection contract: the interaction is admitted
      // only for the active recovery-capable connection whose allocation,
      // provider identity and session route all still match. The legacy recovery
      // authority records no longer gate it.
      if (
        this.runtimeDeleted ||
        !runtime.recoveryCapable ||
        !this.isCurrentConnection(runtime) ||
        current.state.kind !== 'allocated' ||
        canonicalStopIntent(current) !== null ||
        !sameCanonicalAllocation(allocation, current) ||
        canonicalProviderRefOf(current) !== runtime.providerInstanceId ||
        !route ||
        route.kiloSessionId !== session.kiloSessionId ||
        route.directory !== session.directory ||
        route.retiringNativeRuntimeId !== undefined
      )
        throw new Error('Session interaction scope is stale');
      this.assertWorktreeAdmission(route.worktreeId);
      this.assertWorktreeAdmission(worktreeIdFromDirectory(session.directory));
    });
  }

  private async requestWorktreeChanges(
    input: SandboxControlOutboundRequest
  ): Promise<ResponseFrame> {
    await this.assertRequestWorktreeAdmission(input);
    const session = input.session;
    const matchesRoute = (route: SessionRoute | undefined) =>
      session !== undefined &&
      route?.kiloSessionId === session.kiloSessionId &&
      route.directory === session.directory;
    const allocation = await this.readCanonicalAllocation();
    const routes = await loadRouteTable(this.ctx.storage);
    const route = session ? routes.get(session.sessionId) : undefined;
    const runtime = this.readyWrapperRuntime();
    const socket = this.socketHandler.getReadySocket();
    const allocationStopping = canonicalStopIntent(allocation) !== null;
    this.assertWorktreeAdmission(route?.worktreeId);
    if (
      allocation.state.kind !== 'allocated' ||
      allocationStopping ||
      !runtime ||
      canonicalProviderRefOf(allocation) !== runtime.providerInstanceId ||
      !matchesRoute(route) ||
      !socket
    ) {
      const guard =
        allocation.state.kind !== 'allocated'
          ? 'physical_not_running'
          : allocationStopping
            ? 'physical_stopping'
            : !runtime
              ? 'runtime_not_ready'
              : canonicalProviderRefOf(allocation) !== runtime.providerInstanceId
                ? 'provider_mismatch'
                : !matchesRoute(route)
                  ? 'route_mismatch'
                  : 'socket_not_ready';
      logControlDiagnostic('worktree_changes_not_ready', { guard }, 'warn');
      return errorResponse(crypto.randomUUID(), 'not_ready', 'Worktree is not attached and ready');
    }
    if (
      input.expectedWrapperInstanceId !== undefined &&
      wrapperInstanceIdSchema.parse(input.expectedWrapperInstanceId) !== runtime.wrapperInstanceId
    ) {
      return errorResponse(
        crypto.randomUUID(),
        'protocol_error',
        'Worktree capture context changed'
      );
    }

    let response: ResponseFrame;
    try {
      response = await this.socketHandler.sendRequest(input);
    } catch {
      return errorResponse(crypto.randomUUID(), 'protocol_error', 'Worktree capture failed');
    }
    const currentAllocation = await this.readCanonicalAllocation();
    const currentRoutes = await loadRouteTable(this.ctx.storage);
    const currentRoute = session ? currentRoutes.get(session.sessionId) : undefined;
    await this.assertRequestWorktreeAdmission(input);
    this.assertWorktreeAdmission(currentRoute?.worktreeId);
    const currentRuntime = this.readyWrapperRuntime();
    if (
      currentAllocation.state.kind !== 'allocated' ||
      canonicalStopIntent(currentAllocation) !== null ||
      canonicalProviderRefOf(currentAllocation) !== canonicalProviderRefOf(allocation) ||
      !sameCanonicalAllocation(allocation, currentAllocation) ||
      !currentRuntime ||
      !this.sameConnection(runtime, currentRuntime) ||
      !matchesRoute(currentRoute) ||
      currentRoute?.ownerId !== route?.ownerId ||
      currentRoute?.worktreeId !== route?.worktreeId ||
      this.socketHandler.getReadySocket() !== socket
    ) {
      return errorResponse(
        response.requestId,
        'protocol_error',
        'Worktree capture context changed'
      );
    }
    return response;
  }

  async prepareSessionCredentials(input: {
    ownerId: string;
    sessionId: string;
  }): Promise<SessionAttachPayload> {
    await this.initializeOwner(input.ownerId);
    return this.withCredentialUpdate(() => this.prepareOwnedSessionCredentials(input));
  }

  private async prepareOwnedSessionCredentials(
    input: { ownerId: string; sessionId: string },
    terminal?: { access: SandboxTerminalAccessInput; runtime: TerminalRuntimeSnapshot },
    deadlineAt?: number
  ): Promise<SessionAttachPayload> {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      throw new Error('Sandbox credential preparation expired');
    }
    const metadata = await this.readCredentialMetadata(input);
    const binding = getSandboxProviderBinding(metadata);
    await this.pinProvider(binding, {
      resources: getSandboxAllocationResources(metadata.workspace?.sandboxAllocation),
      instance: getSandboxAllocationInstance(metadata.workspace?.sandboxAllocation),
    });
    const provider = binding.kind;
    const record = await this.readCanonicalAllocation();
    const requiredContainment =
      provider === 'onprem'
        ? WORKTREE_CREDENTIAL_CONTAINMENT
        : getWorktreeCredentialContainment(requiresContainmentSandbox(metadata));
    if (
      (provider === 'onprem' &&
        (record.state.kind !== 'allocated' || record.state.target.providerRef === null)) ||
      !this.matchesCanonicalContainment(record, requiredContainment)
    ) {
      throw new Error('Sandbox credential containment is unavailable');
    }
    const resolvedProviderRef = canonicalProviderRefOf(record);
    const outboundContainerId =
      provider === 'cloudflare' && requiredContainment.kilocode
        ? getOutboundContainerId(
            this.env,
            decodeCloudflareProviderRef(resolvedProviderRef)?.sandboxId ??
              (record.state.kind === 'stopped' ? undefined : record.state.target?.allocationName) ??
              this.sandboxId,
            { managedScmContainment: requiredContainment.kilocode }
          )
        : undefined;
    const grants = await loadSessionCredentialGrants(this.ctx.storage);
    const scopeId = metadata.workspace?.worktreeId ?? metadata.identity.sessionId;
    const existing = grants.find(grant => grant.scopeId === scopeId);
    const prepared = await prepareCredentials({
      env: this.env,
      metadata,
      sandboxId: this.sandboxId,
      ...(outboundContainerId ? { outboundContainerId } : {}),
      ...(existing ? { existing } : {}),
    });
    if (
      grants.some(
        grant =>
          grant.scopeId !== scopeId &&
          (grant.directory === prepared.grant.directory ||
            grant.members.some(
              member =>
                member.sessionId === metadata.identity.sessionId ||
                member.kiloSessionId === metadata.auth.kiloSessionId
            ))
      )
    ) {
      throw new Error('Worktree credential scope mismatch');
    }
    const current = await this.readCredentialMetadata(input);
    if (
      JSON.stringify([current.identity, current.auth, current.repository, current.workspace]) !==
      JSON.stringify([metadata.identity, metadata.auth, metadata.repository, metadata.workspace])
    ) {
      throw new Error('Session changed during credential preparation');
    }
    await this.ctx.storage.transaction(async () => {
      const currentRecord = await this.readCanonicalAllocation();
      if (
        (deadlineAt !== undefined && Date.now() >= deadlineAt) ||
        !sameCanonicalAllocation(record, currentRecord) ||
        (provider === 'onprem' &&
          (currentRecord.state.kind !== 'allocated' ||
            currentRecord.state.target.providerRef !== resolvedProviderRef)) ||
        !this.matchesCanonicalContainment(currentRecord, requiredContainment)
      ) {
        throw new Error('Sandbox changed during credential preparation');
      }
      if (terminal) {
        const currentRuntime = await this.readTerminalRuntime(terminal.access, true);
        if (
          !currentRuntime.allowed ||
          !this.sameTerminalRuntime(currentRuntime, terminal.runtime) ||
          prepared.grant.scopeId !== terminal.runtime.grant.scopeId ||
          (prepared.grant.containmentEnabled !== false) !==
            (terminal.runtime.grant.containmentEnabled !== false) ||
          prepared.grant.kilo.alias !== terminal.runtime.grant.kilo.alias
        ) {
          throw new Error('Terminal runtime changed during credential preparation');
        }
      }
      this.assertWorktreeAdmission(metadata.workspace?.worktreeId);
      const updated = [...grants.filter(grant => grant.scopeId !== scopeId), prepared.grant];
      if (provider === 'vercel' && requiredContainment.kilocode) {
        await this.ctx.storage.put(CREDENTIAL_POLICY_DIRTY_KEY, true);
      }
      await saveSessionCredentialGrants(this.ctx.storage, updated);
      if (provider === 'vercel' && requiredContainment.kilocode) {
        const current = await loadControlAlarmAnchors(this.ctx.storage);
        await setControlAlarmAnchor(
          this.ctx.storage,
          'credentialExpiry',
          Math.min(...updated.map(grant => grant.expiresAt))
        );
        if (current.credentialExpiryAt === null) {
          await this.appendLog(deadlineTransition(Date.now(), 'credentialExpiry', 'armed'));
        }
        await this.scheduleAlarm();
      }
    });
    return prepared.payload;
  }

  async resolveCredential(input: {
    credential: string;
    outboundContainerId: string;
    url: string;
    method: string;
  }): Promise<{ credential: string; organizationId?: string } | null> {
    await this.ensureOperationalInitialized();
    return this.withCredentialUpdate(async () => {
      try {
        const alias = parseControlPlaneCredential(input.credential);
        const allocation = await this.readCanonicalAllocation();
        const providerRef = canonicalProviderRefOf(allocation);
        const native = decodeCloudflareProviderRef(providerRef);
        if (
          alias?.sandboxId !== this.sandboxId ||
          this.providerKind !== 'cloudflare' ||
          allocation.state.kind !== 'allocated' ||
          !native ||
          input.outboundContainerId !==
            getOutboundContainerId(this.env, native.sandboxId, { managedScmContainment: true })
        ) {
          return null;
        }
        if (!this.matchesCanonicalContainment(allocation, WORKTREE_CREDENTIAL_CONTAINMENT))
          return null;
        const ownerId = await this.requireOwner();
        const grants = await loadSessionCredentialGrants(this.ctx.storage);
        for (const grant of grants) {
          const expected = alias.purpose === 'kilo' ? grant.kilo.alias : grant.scm?.alias;
          if (
            grant.userId !== ownerId ||
            this.deletingWorktrees.has(grant.scopeId) ||
            !expected ||
            !(await sandboxCredentialMatchesHash(
              input.credential,
              await hashSandboxCredential(expected)
            ))
          ) {
            continue;
          }
          const resolved = await resolveSessionCredential({ env: this.env, grant, ...input });
          if (!resolved) return null;
          return await this.ctx.storage.transaction(async () => {
            const current = await this.readCanonicalAllocation();
            if (
              canonicalProviderRefOf(current) !== providerRef ||
              !sameCanonicalAllocation(current, allocation) ||
              !this.matchesCanonicalContainment(current, WORKTREE_CREDENTIAL_CONTAINMENT) ||
              Date.now() >= resolved.grant.expiresAt ||
              this.deletingWorktrees.has(grant.scopeId)
            ) {
              return null;
            }
            await saveSessionCredentialGrants(
              this.ctx.storage,
              grants.map(value => (value.scopeId === grant.scopeId ? resolved.grant : value))
            );
            return {
              credential: resolved.credential,
              ...(alias.purpose === 'kilo'
                ? { organizationId: resolved.organizationId ?? '' }
                : {}),
            };
          });
        }
        return null;
      } catch {
        return null;
      }
    });
  }

  /**
   * Resolve a proxied request the on-prem installation forwards from the pod's
   * network namespace. The installation is the authority on whether the
   * allocation is still active and acknowledged, so the request is re-verified
   * against it before any grant is revealed.
   */
  async resolveOnPremCredential(
    input: OnPremCredentialRpcInput
  ): Promise<OnPremCredentialResolution | null> {
    try {
      const parsed = onPremCredentialRpcInputSchema.safeParse(input);
      if (!parsed.success) return null;
      const { binding, providerRef, podUid, ...request } = parsed.data;
      return await this.withCredentialUpdate(async () => {
        const record = await this.readCanonicalAllocation();
        const ownerId = await this.requireOwner();
        if (
          this.providerBinding.kind !== 'onprem' ||
          !sameSandboxProviderBinding(this.providerBinding, binding) ||
          record.state.kind !== 'allocated' ||
          record.state.target.providerRef !== providerRef ||
          !this.matchesCanonicalContainment(record, WORKTREE_CREDENTIAL_CONTAINMENT) ||
          this.runtimeDeleted ||
          this.exclusiveDeletionWorktreeId
        ) {
          return null;
        }
        const allocation = await withTimeout(
          getOnPremAllocation(this.env, binding.organizationId, providerRef),
          DEADLINE_MS.stopAttempt,
          'On-prem credential allocation verification timed out'
        );
        if (
          !allocation ||
          allocation.sandboxId !== this.sandboxId ||
          allocation.providerRef !== providerRef ||
          allocation.pod?.uid !== podUid ||
          !sameSandboxProviderBinding(allocation.binding, binding) ||
          allocation.phase !== 'launched' ||
          allocation.status !== 'active' ||
          !allocation.acknowledgementFresh ||
          allocation.acknowledgedAt === null ||
          allocation.acknowledgedAt > Date.now()
        ) {
          return null;
        }
        return this.ctx.storage.transaction(async () => {
          const grants = await loadSessionCredentialGrants(this.ctx.storage);
          const currentOwnerId = await this.readOwner();
          const current = await this.readCanonicalAllocation();
          const now = Date.now();
          if (
            this.providerBinding.kind !== 'onprem' ||
            !sameSandboxProviderBinding(this.providerBinding, binding) ||
            currentOwnerId !== ownerId ||
            current.state.kind !== 'allocated' ||
            current.state.target.providerRef !== providerRef ||
            !sameCanonicalAllocation(current, record) ||
            !this.matchesCanonicalContainment(current, WORKTREE_CREDENTIAL_CONTAINMENT) ||
            this.runtimeDeleted ||
            this.exclusiveDeletionWorktreeId ||
            now >= allocation.hardStopAt
          ) {
            return null;
          }
          const createIntent = current.state.createIntent;
          const target = current.state.target;
          const onprem = target.onprem;
          if (
            onprem === undefined ||
            target.allocationName === undefined ||
            allocation.allocationId !== createIntent.intentId ||
            allocation.createdAt !== createIntent.createdAt ||
            allocation.allocationName !== target.allocationName ||
            allocation.profile.id !== onprem.profile.id ||
            allocation.profile.revision !== onprem.profile.revision ||
            allocation.hardStopAt !== onprem.hardStopAt
          ) {
            return null;
          }
          for (const grant of grants) {
            if (
              grant.provider !== 'onprem' ||
              grant.sandboxId !== this.sandboxId ||
              grant.userId !== ownerId ||
              grant.orgId !== binding.organizationId ||
              this.deletingWorktrees.has(grant.scopeId)
            ) {
              continue;
            }
            const resolved = resolveOnPremCredentialGrant({ grant, request, now });
            if (resolved) {
              const expiresAt = Math.min(resolved.expiresAt, allocation.hardStopAt);
              return expiresAt > Date.now() ? { headers: resolved.headers, expiresAt } : null;
            }
          }
          return null;
        });
      });
    } catch {
      return null;
    }
  }

  ensureReady(input: {
    ownerId: string;
    sessionId: string;
    provider?: AgentSandboxProvider;
    providerBinding?: SandboxProviderBinding;
    resources?: VercelSandboxResources;
    instance?: CloudflareContainersInstance;
    allowCreate?: boolean;
    acquisition?: SandboxAcquisition;
    billing?: SandboxBillingInput;
    worktreeId?: string;
  }): Promise<SandboxControlStatus & { attachment?: SessionAttachPayload }> {
    const operation = this.runEnsureReady(input);
    this.readinessOperations.add(operation);
    return operation.finally(() => this.readinessOperations.delete(operation));
  }

  private async runEnsureReady(
    input: Parameters<SandboxControl['ensureReady']>[0]
  ): Promise<SandboxControlStatus & { attachment?: SessionAttachPayload }> {
    await this.ensureOperationalInitialized();
    this.assertWorktreeAdmission(input.worktreeId);
    const acquisition =
      input.acquisition === undefined
        ? undefined
        : sandboxAcquisitionSchema.parse(input.acquisition);
    if (acquisition) assertAcquisitionDeadline(acquisition);
    const { ownerId } = await this.initializeOwner(input.ownerId);
    const metadata = await withTimeout(
      this.readCredentialMetadata(input),
      Math.max(
        1,
        Math.min(DEADLINE_MS.startup, (acquisition?.deadlineAt ?? Infinity) - Date.now())
      ),
      'Sandbox credential metadata timed out'
    );
    const worktreeId = metadata.workspace?.worktreeId;
    const metadataBinding = getSandboxProviderBinding(metadata);
    const requiredContainment =
      metadataBinding.kind === 'onprem'
        ? WORKTREE_CREDENTIAL_CONTAINMENT
        : getWorktreeCredentialContainment(requiresContainmentSandbox(metadata));
    if (input.worktreeId !== undefined && input.worktreeId !== worktreeId) {
      throw new Error('Worktree identity conflict');
    }
    this.assertWorktreeAdmission(worktreeId);
    if (this.runtimeDeleted) {
      await this.ctx.storage.delete(RUNTIME_DELETED_KEY);
      this.runtimeDeleted = false;
    }
    const requestedBinding =
      input.providerBinding !== undefined
        ? SandboxProviderBindingSchema.parse(input.providerBinding)
        : input.provider !== undefined
          ? bindingFromLegacyProvider(input.provider)
          : undefined;
    if (
      requestedBinding !== undefined &&
      input.provider !== undefined &&
      input.provider !== requestedBinding.kind
    ) {
      throw new Error('Sandbox provider binding mismatch');
    }
    const declaredBinding = metadata.workspace?.sandboxProviderBinding;
    if (
      declaredBinding !== undefined &&
      requestedBinding !== undefined &&
      !sameSandboxProviderBinding(declaredBinding, requestedBinding)
    ) {
      throw new Error('Sandbox provider binding mismatch');
    }
    const binding = await this.pinProvider(requestedBinding ?? metadataBinding, {
      resources: input.resources,
      instance: input.instance,
    });
    if (acquisition && binding.kind !== 'cloudflare' && binding.kind !== 'onprem') {
      throw new Error('Sandbox acquisition is only supported for Cloudflare and on-prem');
    }
    if (binding.kind === 'onprem' && !acquisition) {
      throw new Error('On-prem sandboxes require an acquisition receipt');
    }
    const billing = await this.billingInput(ownerId, input.billing, worktreeId);
    let record: AllocationRecord;
    let createCommands: Command[] | undefined;
    if (acquisition) {
      let selected = await this.acquireCanonicalAllocation(
        acquisition,
        requiredContainment,
        worktreeId,
        input.sessionId
      );
      if (
        selected.action === 'reuse' &&
        selected.record.state.kind === 'allocated' &&
        this.readyWrapperRuntime() === null
      ) {
        const established = this.establishedWrapperForAllocation(selected.record);
        if (established?.wrapperInstanceId) {
          await this.observeCanonicalLoss(selected.record);
          selected = await this.acquireCanonicalAllocation(
            acquisition,
            requiredContainment,
            worktreeId,
            input.sessionId
          );
        }
      }
      if (selected.action === 'wait' && selected.record.state.kind === 'unknown') {
        await this.observeCanonicalUnknown(selected.record);
        selected = await this.acquireCanonicalAllocation(
          acquisition,
          requiredContainment,
          worktreeId,
          input.sessionId
        );
      }
      if (selected.action === 'wait') {
        return this.waitingAcquisitionStatus(selected.record);
      }
      record = selected.record;
      createCommands = selected.action === 'create' ? selected.commands : undefined;
    } else {
      const allowCreate = input.allowCreate === true;
      let current = await this.readCanonicalAllocation();
      if (canonicalEnsureReadyStep(current, allowCreate, Date.now()) === 'release-failed') {
        current = await this.releaseCanonicalIfDead(current);
      }
      if (canonicalEnsureReadyStep(current, allowCreate, Date.now()) === 'observe-unknown') {
        current = await this.observeCanonicalUnknown(current);
      }
      if (canonicalEnsureReadyStep(current, allowCreate, Date.now()) === 'advance') {
        current = await this.advanceCanonicalCheckRequired(current);
      }
      if (canonicalEnsureReadyStep(current, allowCreate, Date.now()) === 'create') {
        const demanded = await this.withCredentialUpdate(() =>
          this.demandCanonicalAllocation(requiredContainment, worktreeId)
        );
        current = demanded.record;
        createCommands = demanded.commands;
      }
      record = current;
    }
    const creating = record.state.kind === 'creating';
    const currentStatus = () =>
      acquisition
        ? this.acquisitionStatusCanonical(acquisition, record, input.sessionId)
        : this.getStatus();
    if (creating) {
      // Only a fresh demand pins the locator from the current environment. A
      // resumed create must keep the locator its intent was created with, so a
      // config rotation cannot redirect recovery or cleanup at a new project.
      if (!this.isByocBinding() && this.providerKind === 'vercel' && createCommands !== undefined) {
        const vercel = parseVercelSandboxRuntimeConfig(this.env);
        if (vercel) {
          this.vercelLocator = vercelProviderLocatorSchema.parse({
            teamId: vercel.teamId,
            projectId: vercel.projectId,
            snapshotId: vercel.snapshotId,
            runtimeBuildId: vercel.runtimeBuildId,
            runtime: vercel.runtime,
          });
          await this.ctx.storage.put(PROVIDER_LOCATOR_KEY, this.vercelLocator);
        }
      }
      if (!this.isByocBinding()) {
        this.provider = this.createProviderAdapter(this.providerKind, record);
      }
    }
    if (record.state.kind !== 'creating' && record.state.kind !== 'allocated') {
      return currentStatus();
    }
    if (!this.matchesCanonicalContainment(record, requiredContainment)) {
      if (this.matchesCanonicalWorktreeContainment(record)) {
        throw new Error('Sandbox containment mode conflicts with the session');
      }
      await this.beginCanonicalStop(record, 'credential_containment_unavailable');
      return currentStatus();
    }
    if (
      !creating &&
      record.state.kind === 'allocated' &&
      record.state.target.providerRef !== null
    ) {
      await withTimeout(
        (await this.providerFor(record.state.target)).ensureBillingAdmission(
          record.state.target.providerRef,
          billing
        ),
        DEADLINE_MS.stopAttempt,
        'Sandbox billing admission timed out'
      );
      const current = await this.readCanonicalAllocation();
      const currentRef = canonicalProviderRefOf(current);
      const recordRef = canonicalProviderRefOf(record);
      const tombstoned =
        current.state.kind === 'stopping' ||
        (current.state.kind === 'unknown' && current.state.stopIntent !== null);
      const ownershipLost =
        !sameCanonicalAllocation(current, record) || currentRef !== recordRef || tombstoned;
      if (ownershipLost || current.state.kind !== 'allocated') {
        const error = 'Sandbox runtime changed during billing admission';
        if (acquisition && ownershipLost) throw new SandboxAcquisitionLostError(error);
        throw new Error(error);
      }
    }
    const readyRuntime = this.readyWrapperRuntime();
    if (
      this.providerBinding.kind === 'onprem' &&
      !creating &&
      record.state.kind === 'allocated' &&
      record.state.target.providerRef !== null &&
      readyRuntime
    ) {
      try {
        await this.verifyOnPremLifetime(
          record,
          Math.min(acquisition?.deadlineAt ?? Infinity, Date.now() + DEADLINE_MS.stopAttempt),
          readyRuntime
        );
      } catch (error) {
        // The installation never acknowledged within the bound, or the
        // allocation changed underneath the wait. Record the failure against the
        // exact allocation that was verified and stop only that one: a stale
        // lookup that resolves after a replacement must not touch the successor.
        const reason = providerFailureReason(this.providerBinding, error) ?? 'onprem_unavailable';
        const stopped = await this.stopVerifiedCanonicalAllocation({
          record,
          reason,
          identity: readyRuntime,
        });
        if (!stopped) {
          if (acquisition) {
            throw new SandboxAcquisitionLostError(
              'Sandbox allocation changed during lifetime verification'
            );
          }
          return currentStatus();
        }
        const settled = await this.readCanonicalAllocation();
        return this.statusForAllocation(settled, this.allocationIncarnationOf(settled));
      }
    }
    const preparationDeadline = Math.min(
      acquisition?.deadlineAt ?? Number.MAX_SAFE_INTEGER,
      Date.now() + DEADLINE_MS.startup
    );
    const prepareAttachment = async (): Promise<SessionAttachPayload> => {
      try {
        return await withTimeout(
          this.withCredentialUpdate(() =>
            withTimeout(
              this.prepareOwnedSessionCredentials(
                { ownerId, sessionId: input.sessionId },
                undefined,
                preparationDeadline
              ),
              Math.max(1, preparationDeadline - Date.now()),
              'Sandbox credential preparation timed out'
            )
          ),
          Math.max(1, preparationDeadline - Date.now()),
          'Sandbox credential preparation timed out'
        );
      } catch (error) {
        const current = await this.readCanonicalAllocation();
        if (creating && sameCanonicalAllocation(current, record)) {
          if (current.state.kind === 'creating') {
            if (this.providerBinding.kind === 'onprem') {
              await this.ctx.storage.put(
                FAILURE_REASON_KEY,
                providerFailureReason(this.providerBinding, error) ?? 'onprem_unavailable'
              );
            }
            await this.failCanonicalCreate(current, 'credential_preparation_failed');
          } else if (
            this.providerBinding.kind === 'onprem' &&
            current.state.kind === 'allocated'
          ) {
            // On-prem credentials are prepared only after create/launch, so this
            // failure leaves a live allocation rather than a `creating` record.
            // Stop that same allocation instead of leaving it running.
            await this.stopVerifiedCanonicalAllocation({
              record: current,
              reason: providerFailureReason(this.providerBinding, error) ?? 'onprem_unavailable',
            });
          }
        }
        throw error;
      }
    };
    let attachment: SessionAttachPayload | undefined;
    if (this.providerBinding.kind !== 'onprem' || !creating) attachment = await prepareAttachment();
    if (creating && createCommands) {
      const intent = record.state.kind === 'creating' ? record.state.createIntent : undefined;
      const intentId = intent?.intentId;
      const allocationName =
        record.state.kind === 'creating' ? record.state.target.allocationName : undefined;
      let timedOut = false;
      const startedAt = Date.now();
      try {
        this.assertWorktreeAdmission(worktreeId);
        if (acquisition) assertAcquisitionDeadline(acquisition);
        this.logDiagnostic('allocation_launch', {
          allocationId: intentId,
          physicalSandboxId: allocationName,
          phase: 'create',
          result: 'started',
        });
        this.controlAcquisitionDeadline = acquisition?.deadlineAt ?? null;
        try {
          await withTimeout(
            this.allocationOrchestrator.run(createCommands),
            DEADLINE_MS.startup,
            'Sandbox allocation timed out',
            () => {
              timedOut = true;
            }
          );
        } finally {
          this.controlAcquisitionDeadline = null;
        }
        const after = await this.readCanonicalAllocation();
        this.logDiagnostic('allocation_launch', {
          allocationId: intentId,
          physicalSandboxId: allocationName,
          phase: 'launch',
          result: after.state.kind === 'allocated' ? 'completed' : 'unresolved',
          durationMs: Date.now() - startedAt,
        });
      } catch {
        this.logDiagnostic(
          'allocation_launch',
          {
            result: timedOut ? 'timed_out' : 'failed',
            phase: 'create',
            durationMs: Date.now() - startedAt,
            allocationId: intentId,
            physicalSandboxId: allocationName,
          },
          'warn'
        );
        const current = await this.readCanonicalAllocation();
        if (
          sameCanonicalAllocation(current, record) &&
          current.state.kind === 'creating' &&
          !this.readyWrapperRuntime()
        ) {
          await this.markCanonicalCreateUnknown(
            current,
            timedOut ? 'create_timed_out' : 'create_failed'
          );
        }
      }
    }
    if (creating && this.providerBinding.kind === 'onprem') {
      // On-prem credentials require a bound, acknowledged allocation, so the
      // attachment is prepared after the create/launch effect settles instead of
      // while the record is still `creating`.
      const afterCreate = await this.readCanonicalAllocation();
      if (afterCreate.state.kind === 'allocated') {
        attachment = await prepareAttachment();
        const prepared = await this.readCanonicalAllocation();
        if (!sameCanonicalAllocation(prepared, record) || prepared.state.kind === 'stopped') {
          return currentStatus();
        }
      }
    }
    if (this.providerKind === 'vercel') {
      const afterCreate = await this.readCanonicalAllocation();
      if (afterCreate.state.kind === 'allocated') {
        await this.enforceWorktreeNetworkPolicy(ownerId);
      }
    }
    const status = await this.ctx.storage.transaction(async () => {
      const current = await this.readCanonicalAllocation();
      const allocationChanged = !sameCanonicalAllocation(current, record);
      const providerChanged =
        canonicalProviderRefOf(record) !== null &&
        canonicalProviderRefOf(current) !== canonicalProviderRefOf(record);
      if (
        allocationChanged ||
        providerChanged ||
        (acquisition &&
          !(await this.allocationController.bindAcquisition(current, acquisition, Date.now())))
      ) {
        const error = 'Sandbox allocation changed during readiness';
        if (acquisition && (allocationChanged || providerChanged))
          throw new SandboxAcquisitionLostError(error);
        throw new Error(error);
      }
      return this.statusForAllocation(current, this.allocationIncarnationOf(current));
    });
    return { ...status, attachment };
  }

  private async acquireCanonicalAllocation(
    acquisition: SandboxAcquisition,
    requestedContainment: CredentialContainmentRequirements,
    worktreeId: string | undefined,
    sessionId: string
  ): Promise<
    | { action: 'create'; record: AllocationRecord; commands: Command[] }
    | { action: 'reuse'; record: AllocationRecord }
    | { action: 'advance'; record: AllocationRecord; from: AllocationRecord; commands: Command[] }
    | { action: 'wait'; record: AllocationRecord }
  > {
    void sessionId;
    const requiredContainment =
      this.providerBinding.kind === 'onprem'
        ? WORKTREE_CREDENTIAL_CONTAINMENT
        : requestedContainment;
    const vercel = await this.vercelIntentConfigForDemand();
    // Phase 1 decides reuse, cleanup and wait from persisted state alone. The
    // on-prem profile resolver is a network call that gates only a fresh
    // allocation, so warm reuse and cleanup progression never require it.
    const selection = await this.ctx.storage.transaction(async () => {
      const record = await this.readCanonicalAllocation();
      this.assertWorktreeAdmission(worktreeId);
      if (
        this.matchesCanonicalWorktreeContainment(record) &&
        !this.matchesCanonicalContainment(record, requiredContainment)
      ) {
        throw new Error('Sandbox containment mode conflicts with the session');
      }
      const bound = await this.allocationController.bindAcquisition(
        record,
        acquisition,
        Date.now()
      );
      if (bound && isLiveAllocation(record)) {
        return { action: 'reuse' as const, record, from: record, commands: undefined };
      }
      if (record.state.kind === 'stopping' && record.state.step === 'check_required') {
        // `check_required` has no timer and exits only on fresh demand. A
        // replayed *live* receipt (`bound`) waits. A request that reopened this
        // cleanup is recorded by the acquisition owner so its own later polls
        // wait too, instead of restarting the exhausted ladder each poll; a
        // genuinely different request is unrecorded and advances (plan
        // 1332-1333). A request bound to a different allocation threw
        // `SandboxAcquisitionLostError` in the fence above.
        if (bound) {
          return { action: 'wait' as const, record, from: record, commands: undefined };
        }
        const reopened = await this.allocationController.reopenCleanup(
          record,
          acquisition,
          Date.now()
        );
        if (reopened) {
          return { action: 'wait' as const, record, from: record, commands: undefined };
        }
        // The reducer owns the transition (`ACQUIRE` re-drives the stop effect).
        const decision = await this.allocationOrchestrator.dispatch({
          type: 'ACQUIRE',
          requestId: acquisition.id,
          target: record.state.target,
          createIntent: record.state.createIntent,
          deliveryDeadlineAt: acquisition.deadlineAt,
        });
        if (decision === undefined) {
          return { action: 'wait' as const, record, from: record, commands: undefined };
        }
        await this.scheduleAlarm();
        return {
          action: 'advance' as const,
          record: decision.state,
          from: record,
          commands: decision.commands,
        };
      }
      if (record.state.kind !== 'stopped') {
        return { action: 'wait' as const, record, from: record, commands: undefined };
      }
      return { action: 'fresh' as const, record, from: record, commands: undefined };
    });
    if (selection.action === 'reuse') return { action: 'reuse', record: selection.record };
    if (selection.action === 'wait') return { action: 'wait', record: selection.record };
    if (selection.action === 'advance') {
      await this.allocationOrchestrator.run(selection.commands);
      const after = await this.readCanonicalAllocation();
      await this.afterCanonicalCommit(selection.from, after);
      return { action: 'wait', record: after };
    }
    // A fresh allocation needs the on-prem installation profile. Resolve it
    // outside the storage transaction, then recheck admission and that the
    // record is still stopped before committing the new target.
    const onpremResolution = await this.resolveDemandOnPremProfile();
    if (onpremResolution !== undefined && !onpremResolution.resolved) {
      return { action: 'wait' as const, record: await this.readCanonicalAllocation() };
    }
    const onpremBinding = onpremResolution?.binding;
    const onpremProfile = onpremResolution?.profile;
    const committed = await this.ctx.storage.transaction(async () => {
      const record = await this.readCanonicalAllocation();
      this.assertWorktreeAdmission(worktreeId);
      if (record.state.kind !== 'stopped') {
        return { action: 'wait' as const, record, from: record, commands: undefined };
      }
      const intentId = crypto.randomUUID();
      const allocationName = await deriveSandboxAllocationId(this.sandboxId, intentId);
      const createdAt = Date.now();
      const target = this.canonicalTarget(
        requiredContainment,
        allocationName,
        vercel,
        onpremBinding === undefined || onpremProfile === undefined
          ? undefined
          : {
              binding: onpremBinding,
              profile: onpremProfile,
              hardStopAt: createdAt + onpremProfile.maxLifetimeMs,
            }
      );
      const event: AcquireEvent = {
        type: 'ACQUIRE',
        requestId: acquisition.id,
        target,
        createIntent: { intentId, createdAt },
        deliveryDeadlineAt: acquisition.deadlineAt,
      };
      const decision = await this.allocationOrchestrator.dispatch(event);
      if (decision === undefined) throw new Error('Sandbox allocation demand was rejected');
      await this.allocationController.bindAcquisition(decision.state, acquisition, Date.now());
      await this.scheduleAlarm();
      return {
        action: 'create' as const,
        record: decision.state,
        from: record,
        commands: decision.commands,
      };
    });
    if (committed.action === 'create') {
      await this.afterCanonicalCommit(committed.from, committed.record);
    }
    return committed;
  }

  private async demandCanonicalAllocation(
    requiredContainment: CredentialContainmentRequirements,
    worktreeId: string | undefined
  ): Promise<{ record: AllocationRecord; commands: Command[] }> {
    // A fresh demand starts from a stopped record, so any reason recorded by the
    // previous attempt is obsolete: a transient failure of this attempt must not
    // surface it to the head. A permanent failure records its own reason below.
    // The clear is fenced to the stopped record so it can never erase the
    // failure of a live allocation.
    this.ctx.storage.transactionSync(() => {
      const current = this.readCanonicalAllocationSync();
      if (current.state.kind !== 'stopped') return;
      this.clearObsoleteProviderFailure();
    });
    const resolution = await this.resolveDemandVercelIntent();
    if (!resolution.resolved) {
      // A permanent BYOC configuration failure recorded its specific reason, and
      // a transient credential-backend failure recorded nothing. Either way the
      // allocation stays stopped: the head terminalizes with the specific
      // reason, or the bounded queue retry re-drives the demand.
      return { record: await this.readCanonicalAllocation(), commands: [] };
    }
    const vercel = resolution.vercel;
    const committed = await this.ctx.storage.transaction(async () => {
      const record = await this.readCanonicalAllocation();
      this.assertWorktreeAdmission(worktreeId);
      const intentId = crypto.randomUUID();
      const allocationName = await deriveSandboxAllocationId(this.sandboxId, intentId);
      const target = this.canonicalTarget(requiredContainment, allocationName, vercel);
      const event: DemandEvent = {
        type: 'DEMAND',
        requestId: crypto.randomUUID(),
        target,
        createIntent: { intentId, createdAt: Date.now() },
      };
      const decision = await this.allocationOrchestrator.dispatch(event);
      if (decision === undefined) throw new Error('Sandbox allocation demand was rejected');
      await this.scheduleAlarm();
      return { record: decision.state, from: record, commands: decision.commands };
    });
    await this.afterCanonicalCommit(committed.from, committed.record);
    return { record: committed.record, commands: committed.commands };
  }

  private async observeCanonicalUnknown(record: AllocationRecord): Promise<AllocationRecord> {
    if (record.state.kind !== 'unknown') return record;
    const decision = await this.allocationOrchestrator.dispatch({ type: 'DEADLINE' });
    if (decision === undefined) return record;
    await this.allocationOrchestrator.run(decision.commands);
    const after = await this.readCanonicalAllocation();
    await this.afterCanonicalCommit(record, after);
    return after;
  }

  /**
   * A legacy `failed` record is an `unknown` that was never observed; driving the
   * unknown observe path either settles it to `stopped` (absent) or re-arms it.
   */
  private async releaseCanonicalIfDead(record: AllocationRecord): Promise<AllocationRecord> {
    return this.observeCanonicalUnknown(record);
  }

  /**
   * A fresh authorized demand advances a `stopping.check_required` allocation.
   * The reducer owns the transition (`DEMAND`/`ACQUIRE` re-drives the stop
   * effect); this only dispatches the demand, runs its commands and commits.
   */
  private async advanceCanonicalCheckRequired(record: AllocationRecord): Promise<AllocationRecord> {
    if (record.state.kind !== 'stopping' || record.state.step !== 'check_required') return record;
    const decision = await this.allocationOrchestrator.dispatch({
      type: 'DEMAND',
      requestId: crypto.randomUUID(),
      target: record.state.target,
      createIntent: record.state.createIntent,
    });
    if (decision === undefined) return record;
    await this.allocationOrchestrator.run(decision.commands);
    const after = await this.readCanonicalAllocation();
    await this.afterCanonicalCommit(record, after);
    return after;
  }

  private async beginCanonicalStop(record: AllocationRecord, reason: string): Promise<void> {
    if (record.state.kind !== 'allocated') return;
    const decision = await this.allocationOrchestrator.dispatch({
      type: 'CANCEL',
      scope: 'allocation',
      reason,
    });
    if (decision === undefined) return;
    await this.allocationOrchestrator.run(decision.commands);
    await this.afterCanonicalCommit(record, await this.readCanonicalAllocation());
  }

  /**
   * Stop the exact allocation a caller verified, and record the failure reason
   * with it. The `CANCEL` carries the allocation's create intent and provider
   * reference, so the reducer rejects it once a replacement is committed: a
   * stale lifetime failure never stops or marks the successor. The optional
   * connection identity fences the caller's own runtime; when it is supplied and
   * no longer current the caller has lost ownership and nothing changes.
   * Returns whether the fenced stop was applied.
   */
  private async stopVerifiedCanonicalAllocation(input: {
    record: AllocationRecord;
    reason: SandboxProviderFailureReason;
    identity?: SandboxControlConnectionIdentity;
  }): Promise<boolean> {
    if (input.record.state.kind !== 'allocated') return false;
    const fence = {
      intentId: input.record.state.createIntent.intentId,
      providerRef: input.record.state.target.providerRef,
    };
    const decision = await this.ctx.storage.transaction(async () => {
      if (input.identity !== undefined && !this.isCurrentConnection(input.identity)) {
        return undefined;
      }
      const decided = await this.allocationOrchestrator.dispatch({
        type: 'CANCEL',
        scope: 'allocation',
        reason: input.reason,
        fence,
      });
      if (decided === undefined) return undefined;
      await this.ctx.storage.put(FAILURE_REASON_KEY, input.reason);
      return decided;
    });
    if (decision === undefined) return false;
    await this.allocationOrchestrator.run(decision.commands);
    await this.afterCanonicalCommit(input.record, await this.readCanonicalAllocation());
    return true;
  }

  private async failCanonicalCreate(record: AllocationRecord, reason: string): Promise<void> {
    if (record.state.kind !== 'creating') return;
    const intentId = record.state.createIntent.intentId;
    const decision = await this.allocationOrchestrator.dispatch({
      type: 'CREATE_FAILED',
      fence: {
        operationId: operationId('create', intentId),
        providerRef: record.state.target.providerRef,
        incarnation: null,
      },
      reason,
      at: Date.now(),
    });
    if (decision === undefined) return;
    await this.afterCanonicalCommit(record, decision.state);
  }

  /**
   * An inconclusive create (deadline expiry while the provider request is still
   * outstanding) is `unknown`, not a proven failure: the create intent is
   * retained so the observe deadline can settle it. This mirrors the effect
   * runner's `CREATE_UNKNOWN` mapping and keeps the flat `failed` shape.
   */
  private async markCanonicalCreateUnknown(
    record: AllocationRecord,
    reason: string
  ): Promise<void> {
    if (record.state.kind !== 'creating') return;
    const intentId = record.state.createIntent.intentId;
    const decision = await this.allocationOrchestrator.dispatch({
      type: 'CREATE_UNKNOWN',
      fence: {
        operationId: operationId('create', intentId),
        providerRef: record.state.target.providerRef,
        incarnation: null,
      },
      reason,
      at: Date.now(),
    });
    if (decision === undefined) return;
    await this.afterCanonicalCommit(record, decision.state);
  }

  private async acquisitionStatusCanonical(
    acquisition: SandboxAcquisition,
    expected: AllocationRecord,
    sessionId: string
  ): Promise<SandboxControlStatus> {
    void sessionId;
    return this.ctx.storage.transaction(async () => {
      const current = await this.readCanonicalAllocation();
      if (
        !sameCanonicalAllocation(expected, current) ||
        !(await this.allocationController.bindAcquisition(current, acquisition, Date.now()))
      ) {
        throw new SandboxAcquisitionLostError();
      }
      return this.statusForAllocation(current, this.allocationIncarnationOf(current));
    });
  }

  /**
   * Side effects of a canonical allocation commit: reset runtime metadata on a
   * fresh create, tear down the socket for an unavailable target, and re-arm the
   * control alarm. The committed transition itself is reported from the single
   * dispatch boundary (`recordAllocationTransition`), not here.
   */
  private async afterCanonicalCommit(from: AllocationRecord, to: AllocationRecord): Promise<void> {
    const changed = canonicalAllocationChanged(from, to);
    const unavailable = to.state.kind !== 'creating' && to.state.kind !== 'allocated';
    const creatingCleanup = from.state.kind === 'stopped' && to.state.kind === 'creating';
    const wrapperInstanceId =
      canonicalStopWrapperInstanceId(to) ??
      canonicalStopWrapperInstanceId(from) ??
      this.activeConnection?.wrapperInstanceId;
    const kv = this.ctx.storage.kv;
    // Synchronous: an explicit `ctx.storage.transaction()` on this path aborts the
    // workerd isolate, so the atomic read-decide-delete uses `transactionSync`.
    const cleanedUnavailable = this.ctx.storage.transactionSync(() => {
      const current = loadAllocationSync(kv, this.provider.resumable);
      const cleanupUnavailable =
        unavailable && (sameCanonicalAllocation(from, current) || current.state.kind === 'stopped');
      const cleanupCreating = creatingCleanup && sameCanonicalAllocation(to, current);
      // An authoritative recovery commits a non-allocated record to `allocated`
      // (BYOC Vercel adopts a failed-but-active allocation). The failure that
      // preceded recovery is obsolete and must not outrank the recovered
      // readiness. Fenced both to the committed record (`to`) and to the record
      // the transition started from (`from`): a delayed observation of a
      // replaced allocation can commit `(from: old, to: current)` with no
      // recovery at all, and must never clear the replacement's failure.
      const recovered =
        to.state.kind === 'allocated' &&
        from.state.kind !== 'allocated' &&
        sameCanonicalAllocation(from, to) &&
        sameCanonicalAllocation(to, current);
      if (recovered) this.clearObsoleteProviderFailure();
      if (cleanupCreating) {
        saveRuntimeMetadataSync(kv, initialRuntimeMetadata(this.sandboxId));
      }
      if (cleanupCreating || cleanupUnavailable) {
        for (const key of [
          CREDENTIAL_HASH_KEY,
          ACTIVE_WRAPPER_RUNTIME_KEY,
          WRAPPER_READY_AT_KEY,
          WRAPPER_HEARTBEAT_OBSERVATION_KEY,
        ]) {
          kv.delete(key);
        }
      }
      if (cleanupUnavailable && to.state.kind === 'stopped') {
        saveSessionCredentialGrantsSync(kv, []);
        kv.delete(CREDENTIAL_POLICY_DIRTY_KEY);
        // No grants remain, so the credential-expiry anchor is meaningless and
        // must not keep an alarm armed.
        setControlAlarmAnchorSync(kv, 'credentialExpiry', null);
      }
      return cleanupUnavailable;
    });
    if (cleanedUnavailable) {
      this.activeConnection = null;
      this.readyConnectionId = null;
      this.kiloReady = false;
      this.socketHandler.closeAll('Sandbox runtime unavailable');
      if (changed && wrapperInstanceId) {
        this.ctx.waitUntil(
          this.invalidateTerminalRuntime(wrapperInstanceId, to.state.kind === 'stopped')
        );
      }
    }
    if (to.state.kind === 'allocated' && from.state.kind !== 'allocated') {
      await this.scheduleNextLeaseCheck('initial', Date.now());
    }
    await this.syncOnPremHardStop(to);
    await this.scheduleAlarm();
  }

  async updateNetworkPolicy(input: {
    ownerId: string;
    networkPolicy: VercelSandboxNetworkPolicy;
    requiredContainment: CredentialContainmentRequirements;
  }): Promise<void> {
    const ownerId = await this.requireOwner();
    if (ownerId !== input.ownerId) {
      throw new Error('Sandbox owner mismatch');
    }
    const providerKind = await this.ctx.storage.get<AgentSandboxProvider>(PROVIDER_KIND_KEY);
    if (providerKind !== 'vercel') {
      throw new Error('Sandbox network policy requires a Vercel provider');
    }
    const record = await this.readCanonicalAllocation();
    const providerRef = canonicalProviderRefOf(record);
    if (record.state.kind !== 'allocated' || providerRef === null) {
      throw new Error('Sandbox network policy requires a running instance');
    }
    if (!this.matchesCanonicalProviderReference(record.state, providerRef)) {
      throw new Error('Sandbox network policy requires an exact provider reference');
    }
    if (
      (!input.requiredContainment.kilocode && !input.requiredContainment.github) ||
      !this.matchesCanonicalContainment(record, input.requiredContainment)
    ) {
      throw new Error('Sandbox credential containment mismatch');
    }
    const provider = await this.providerFor(record.state.target);
    if (!provider.updateNetworkPolicy) {
      throw new Error('Sandbox provider does not support network policy updates');
    }
    await withTimeout(
      provider.updateNetworkPolicy(providerRef, input.networkPolicy),
      DEADLINE_MS.stopAttempt,
      'Sandbox network policy update timed out'
    );

    const currentProviderKind = await this.ctx.storage.get<AgentSandboxProvider>(PROVIDER_KIND_KEY);
    const currentRecord = await this.readCanonicalAllocation();
    const currentOwnerId = await this.readOwner();
    if (
      currentProviderKind !== 'vercel' ||
      currentOwnerId !== ownerId ||
      currentRecord.state.kind !== 'allocated' ||
      canonicalProviderRefOf(currentRecord) !== providerRef ||
      !this.matchesCanonicalContainment(currentRecord, input.requiredContainment)
    ) {
      throw new Error('Sandbox instance changed during network policy update');
    }
  }

  async attachSession(input: AttachSessionInput): Promise<SessionRoute> {
    return this.withCredentialUpdate(async () => {
      const ownerId = await this.requireOwner();
      const grants = await loadSessionCredentialGrants(this.ctx.storage);
      const grant = grants.find(
        value =>
          value.userId === ownerId &&
          value.directory === input.directory &&
          value.expiresAt > Date.now() &&
          value.members.some(
            member =>
              member.sessionId === input.sessionId && member.kiloSessionId === input.kiloSessionId
          )
      );
      const worktreeId = grant?.scopeId.startsWith('worktree_') ? grant.scopeId : undefined;
      if (!grant || worktreeId !== input.worktreeId) {
        throw new Error('Session has no matching worktree credential grant');
      }
      if (
        !this.matchesCanonicalContainment(
          await this.readCanonicalAllocation(),
          getWorktreeCredentialContainment(grant.containmentEnabled !== false)
        )
      ) {
        throw new Error('Sandbox credential containment mismatch');
      }
      const result = await this.mutateRoutesAndReferences((table, references) => {
        this.assertWorktreeAdmission(worktreeId);
        const attached = attachRoute(table, input, ownerId);
        const added = addSessionReference(references, {
          sessionId: input.sessionId,
          kiloSessionId: input.kiloSessionId,
          directory: input.directory,
          ...(worktreeId !== undefined ? { worktreeId } : {}),
        });
        return {
          value: attached,
          routesChanged: attached.changed,
          referencesChanged: added.changed,
        };
      });
      if (result.changed) {
        await this.appendLog(
          routeTransition(Date.now(), 'attach', input.sessionId, input.kiloSessionId)
        );
      }
      return result.route;
    });
  }

  async bindRuntimeCredentialProxyHandle(input: {
    ownerId: string;
    sessionId: string;
    kiloSessionId: string;
    directory: string;
    handle: string;
  }): Promise<{ bound: true }> {
    return this.withCredentialUpdate(async () => {
      if (
        typeof input.handle !== 'string' ||
        input.handle.length === 0 ||
        input.handle.length > 4096
      ) {
        throw new Error('Invalid runtime credential proxy handle');
      }
      const ownerId = await this.requireOwner();
      if (ownerId !== input.ownerId) throw new Error('Sandbox owner mismatch');
      if (this.providerKind !== 'vercel' || this.runtimeDeleted) {
        throw new Error('Sandbox credential containment mismatch');
      }
      const grants = await loadSessionCredentialGrants(this.ctx.storage);
      const now = Date.now();
      const index = grants.findIndex(
        grant =>
          grant.userId === ownerId &&
          grant.directory === input.directory &&
          grant.expiresAt > now &&
          grant.members.some(
            member =>
              member.sessionId === input.sessionId && member.kiloSessionId === input.kiloSessionId
          ) &&
          grant.kilo.runtimeProxy !== undefined
      );
      if (index < 0) throw new Error('Session has no matching runtime proxy credential grant');
      const grant = grants[index];
      if (!grant) throw new Error('Session has no matching runtime proxy credential grant');
      const claims = await verifyRuntimeCredentialProxyHandle(this.env, input.handle);
      if (
        !claims ||
        !('sessionId' in claims) ||
        claims.userId !== ownerId ||
        claims.sessionId !== input.sessionId ||
        claims.kiloSessionId !== input.kiloSessionId
      ) {
        throw new Error('Invalid runtime credential proxy member handle');
      }
      const existingProxy = grant.kilo.runtimeProxy;
      if (!existingProxy) throw new Error('Session has no matching runtime proxy credential grant');
      const updated = grants.map((value, current) =>
        current === index
          ? {
              ...value,
              kilo: {
                ...value.kilo,
                runtimeProxy: value.kilo.runtimeProxy
                  ? {
                      ...value.kilo.runtimeProxy,
                      members: [
                        ...value.kilo.runtimeProxy.members.filter(
                          member => member.sessionId !== input.sessionId
                        ),
                        {
                          sessionId: input.sessionId,
                          kiloSessionId: input.kiloSessionId,
                          handle: input.handle,
                        },
                      ],
                    }
                  : undefined,
              },
            }
          : value
      );
      await saveSessionCredentialGrants(this.ctx.storage, updated);
      await this.updateNetworkPolicy({
        ownerId,
        networkPolicy: buildControlNetworkPolicy(updated.filter(value => value.expiresAt > now)),
        requiredContainment: WORKTREE_CREDENTIAL_CONTAINMENT,
      });
      await this.ctx.storage.delete(CREDENTIAL_POLICY_DIRTY_KEY);
      return { bound: true };
    });
  }

  async detachSession(sessionId: string): Promise<{ existed: boolean }> {
    await this.ensureOperationalInitialized();
    const route = (await loadRouteTable(this.ctx.storage)).get(sessionId);
    let runtimeDetached = false;
    let existed = false;
    try {
      if (route && this.socketHandler.hasHandshakenSocket()) {
        const response = await this.socketHandler.sendRequest({
          operation: 'session.detach',
          session: {
            sessionId: route.sessionId,
            kiloSessionId: route.kiloSessionId,
            directory: route.directory,
          },
          payload: {},
        });
        if (!response.ok) throw new Error(response.error?.message ?? 'session.detach failed');
      }
      runtimeDetached = true;
    } finally {
      const result = await this.withCredentialUpdate(() =>
        this.ctx.storage.transaction(async () => {
          const table = await loadRouteTable(this.ctx.storage);
          const removing = runtimeDetached ? table.get(sessionId) : undefined;
          const detached = runtimeDetached
            ? detachRoute(table, sessionId)
            : { table, existed: false };
          await saveRouteTable(this.ctx.storage, detached.table);
          if (detached.existed && removing) {
            const references = await loadSessionReferences(this.ctx.storage);
            const tombstoned = addSessionReference(references, {
              sessionId: removing.sessionId,
              kiloSessionId: removing.kiloSessionId,
              directory: removing.directory,
              ...(removing.worktreeId !== undefined ? { worktreeId: removing.worktreeId } : {}),
            });
            if (tombstoned.changed) await saveSessionReferences(this.ctx.storage, references);
          }
          const grants = await loadSessionCredentialGrants(this.ctx.storage);
          if (grants.some(grant => grant.members.some(member => member.sessionId === sessionId))) {
            await this.ctx.storage.put(CREDENTIAL_POLICY_DIRTY_KEY, true);
            await saveSessionCredentialGrants(
              this.ctx.storage,
              removeSessionCredentialMembership(grants, sessionId)
            );
          }
          return detached;
        })
      );
      if (
        this.providerKind === 'vercel' &&
        (await this.ctx.storage.get<boolean>(CREDENTIAL_POLICY_DIRTY_KEY))
      ) {
        await this.enforceWorktreeNetworkPolicy(await this.requireOwner());
      }
      existed = result.existed;
      if (existed) {
        await this.appendLog(routeTransition(Date.now(), 'detach', sessionId));
      }
      if (!hasActiveWork(result.table)) {
        await this.armCanonicalIdleIfAbsent(Date.now() + DEADLINE_MS.idleStop);
      }
    }
    return { existed };
  }

  async forgetSessionReference(sessionId: string): Promise<void> {
    await this.ensureOperationalInitialized();
    await this.ctx.storage.transaction(async () => {
      const references = await loadSessionReferences(this.ctx.storage);
      if (removeSessionReference(references, sessionId).changed) {
        await saveSessionReferences(this.ctx.storage, references);
      }
    });
  }

  deleteWorktreeResources(
    raw: SandboxWorktreeCleanupInput
  ): Promise<{ deleted: true; sessionIds: string[] }> {
    const input = sandboxWorktreeCleanupInputSchema.parse(raw);
    const operation = this.worktreeDeletionChain
      .catch(() => undefined)
      .then(() => this.runWorktreeDeletion(input));
    this.worktreeDeletionChain = operation;
    return operation;
  }

  private async runWorktreeDeletion(
    input: SandboxWorktreeCleanupInput
  ): Promise<{ deleted: true; sessionIds: string[] }> {
    if (input.location.sandboxId !== this.sandboxId) throw new Error('Sandbox identity conflict');
    await this.initializeOwner(input.kiloUserId);
    const previous = await loadWorktreeDeletionJournal(this.ctx.storage, input.worktreeId);
    if (previous?.completed && previous.destroyed) {
      await this.releaseWorktreeAdmission(input.worktreeId);
      return {
        deleted: true,
        sessionIds: [...new Set([...previous.sessionIds, ...input.sessionIds])],
      };
    }
    if (this.exclusiveDeletionWorktreeId && this.exclusiveDeletionWorktreeId !== input.worktreeId) {
      throw new Error('worktree_teardown_in_progress');
    }
    if (previous?.exclusiveTeardown && this.exclusiveDeletionWorktreeId !== input.worktreeId) {
      throw new Error(WORKTREE_RUNTIME_HISTORY_UNAVAILABLE);
    }
    const getProvider = async () => {
      const binding = await this.pinProvider();
      if (
        binding.kind !== input.location.provider ||
        (binding.kind === 'vercel' &&
          binding.source.kind === 'byoc' &&
          binding.source.organizationId !== input.organizationId) ||
        (binding.kind === 'onprem' && binding.organizationId !== input.organizationId)
      ) {
        throw new Error('Sandbox provider binding mismatch');
      }
      const record = await this.readCanonicalAllocation();
      return withTimeout(
        this.providerFor(
          record.state.kind === 'stopped' ? undefined : (record.state.target ?? undefined)
        ),
        DEADLINE_MS.stopAttempt,
        'Sandbox provider resolution timed out'
      );
    };
    this.deletingWorktrees.add(input.worktreeId);
    await this.ctx.storage.put(
      `${WORKTREE_DELETION_PREFIX}${input.worktreeId}`,
      previous ?? {
        sessionIds: input.sessionIds,
        resourcesCleaned: false,
        destroyed: false,
      }
    );
    const directory = getWorktreeWorkspacePath(
      input.organizationId,
      input.kiloUserId,
      input.worktreeId
    );
    let journal: Awaited<ReturnType<typeof cleanWorktreeRuntime>>;
    try {
      const admittedTeardown =
        previous?.exclusiveTeardown === true &&
        this.exclusiveDeletionWorktreeId === input.worktreeId;
      const exclusive =
        previous?.destroyed === true ||
        admittedTeardown ||
        (await this.fenceAndCheckWorktreeExclusivity(input, directory));
      if (!exclusive) {
        if ((await this.readCanonicalAllocation()).state.kind !== 'stopped') await getProvider();
        await this.revokeWorktreeCredentials(input.worktreeId);
      }
      journal = await cleanWorktreeRuntime({
        request: input,
        directory,
        storage: this.ctx.storage,
        getProvider,
        stopRuntime: () => this.stopDeletedWorktreeRuntime(),
        hasConnection: () => this.socketHandler.hasHandshakenSocket(),
        sendRequest: request => this.socketHandler.sendRequest(request),
        exclusive,
      });
    } finally {
      await this.revokeWorktreeCredentials(input.worktreeId);
    }
    const deletedIds = new Set(journal.sessionIds);
    const detached = await this.mutateRoutesAndReferences((table, references) => {
      const sessionIds: string[] = [];
      for (const [sessionId, route] of table) {
        if (
          route.worktreeId === input.worktreeId ||
          (route.directory === directory && deletedIds.has(route.kiloSessionId))
        ) {
          table.delete(sessionId);
          sessionIds.push(sessionId);
        }
      }
      const removed = removeWorktreeReferences(references, input.worktreeId);
      return {
        value: sessionIds,
        routesChanged: sessionIds.length > 0,
        referencesChanged: removed.changed,
      };
    });
    await Promise.allSettled(detached.flatMap(id => this.sessionForwarding.get(id) ?? []));
    if (
      !journal.destroyed &&
      (await this.fenceAndCheckWorktreeExclusivity(
        { ...input, sessionIds: journal.sessionIds },
        directory
      ))
    ) {
      journal = await cleanWorktreeRuntime({
        request: { ...input, sessionIds: journal.sessionIds },
        directory,
        storage: this.ctx.storage,
        getProvider,
        stopRuntime: () => this.stopDeletedWorktreeRuntime(),
        hasConnection: () => this.socketHandler.hasHandshakenSocket(),
        sendRequest: request => this.socketHandler.sendRequest(request),
        exclusive: true,
      });
    }
    if (journal.destroyed) {
      this.runtimeDeleted = true;
      this.kiloReady = false;
      await this.ctx.storage.put(RUNTIME_DELETED_KEY, true);
      this.socketHandler.closeAll('Worktree deleted');
      await Promise.allSettled([...this.lifecycleOperations]);
      await this.eraseRecord({ preserveAcquisitionReceipts: true });
      await this.scheduleAlarm();
      for (const [worktreeId, receipt] of await loadWorktreeDeletionJournals(this.ctx.storage)) {
        if (receipt.resourcesCleaned) {
          await this.ctx.storage.put(`${WORKTREE_DELETION_PREFIX}${worktreeId}`, {
            ...receipt,
            completed: true,
            destroyed: true,
          });
        }
      }
    }
    await this.ctx.storage.put(`${WORKTREE_DELETION_PREFIX}${input.worktreeId}`, {
      ...journal,
      completed: true,
    });
    await this.releaseWorktreeAdmission(input.worktreeId);
    return { deleted: true, sessionIds: journal.sessionIds };
  }

  private async stopDeletedWorktreeRuntime(): Promise<AllocationRecord> {
    const record = await this.beginStop('worktree_deleted');
    if (record.state.kind === 'stopped') return record;
    return this.recordStopAttempt();
  }

  private async revokeWorktreeCredentials(worktreeId: string): Promise<void> {
    await this.withCredentialUpdate(() =>
      this.ctx.storage.transaction(async () => {
        const grants = await loadSessionCredentialGrants(this.ctx.storage);
        if (!grants.some(grant => grant.scopeId === worktreeId)) return;
        if (this.providerKind === 'vercel') {
          await this.ctx.storage.put(CREDENTIAL_POLICY_DIRTY_KEY, true);
        }
        await saveSessionCredentialGrants(
          this.ctx.storage,
          grants.filter(grant => grant.scopeId !== worktreeId)
        );
      })
    );
    if (
      this.providerKind === 'vercel' &&
      (await this.ctx.storage.get<boolean>(CREDENTIAL_POLICY_DIRTY_KEY))
    ) {
      await this.enforceWorktreeNetworkPolicy(await this.requireOwner());
    }
  }

  private async fenceAndCheckWorktreeExclusivity(
    input: SandboxWorktreeCleanupInput,
    directory: string
  ): Promise<boolean> {
    this.exclusiveDeletionWorktreeId = input.worktreeId;
    await this.ctx.storage.put(EXCLUSIVE_DELETION_KEY, input.worktreeId);
    try {
      await Promise.allSettled([...this.readinessOperations, ...this.lifecycleOperations]);
      if (
        await isUnallocatedControlRuntime(this.ctx.storage, () =>
          this.socketHandler.hasHandshakenSocket()
        )
      )
        return true;
      const storage = this.ctx.storage;
      const receipts = await loadWorktreeDeletionJournals(storage);
      const released = new Set(
        [...receipts].filter(([, receipt]) => receipt.resourcesCleaned).map(([id]) => id)
      );
      const target = {
        worktreeId: input.worktreeId,
        directory,
        sessionIds: new Set(input.sessionIds),
        releasedWorktreeIds: released,
      };
      const references = await loadSessionReferences(storage);
      const foreignEvidence = async () => [
        ...references.entries,
        ...(await loadRouteTable(storage)).values(),
      ];
      if (hasForeignReference(references, await foreignEvidence(), target)) {
        await this.releaseWorktreeAdmission(input.worktreeId);
        return false;
      }
      if (!references.reconciled) {
        const result = await reconcileSandboxReferences(
          this.env,
          {
            worktreeId: input.worktreeId,
            kiloUserId: input.kiloUserId,
            organizationId: input.organizationId,
            location: input.location,
            releasedWorktreeIds: [...released],
          },
          RECONCILIATION_LIMITS
        );
        if (!result.complete || result.foreign || result.unavailable) {
          await this.releaseWorktreeAdmission(input.worktreeId);
          return false;
        }
        const confirmed = await storage.transaction(async () => {
          const current = await loadSessionReferences(storage);
          if (current.reconciled) return true;
          const routes = await loadRouteTable(storage);
          if (hasForeignReference(current, [...current.entries, ...routes.values()], target)) {
            return false;
          }
          await saveSessionReferences(storage, markReferencesReconciled(current));
          return true;
        });
        if (!confirmed) {
          await this.releaseWorktreeAdmission(input.worktreeId);
          return false;
        }
      }
      return true;
    } catch (error) {
      await this.releaseWorktreeAdmission(input.worktreeId);
      throw error;
    }
  }

  private async releaseWorktreeAdmission(worktreeId: string): Promise<void> {
    if (this.exclusiveDeletionWorktreeId !== worktreeId) return;
    await this.ctx.storage.delete(EXCLUSIVE_DELETION_KEY);
    this.exclusiveDeletionWorktreeId = undefined;
    if (!this.runtimeDeleted) await this.scheduleAlarm();
  }

  private async assertRequestWorktreeAdmission(
    input: SandboxControlOutboundRequest
  ): Promise<void> {
    const session = input.session;
    if (!session) return;
    const worktreeId = worktreeIdFromDirectory(session.directory);
    if (input.operation === 'session.sync' && this.exclusiveDeletionWorktreeId) {
      const allowed = await this.ctx.storage.transaction(async () => {
        const exclusiveWorktreeId = this.exclusiveDeletionWorktreeId;
        if (!exclusiveWorktreeId) return false;
        const route = (await loadRouteTable(this.ctx.storage)).get(session.sessionId);
        const routeWorktreeId = route?.worktreeId ?? worktreeId;
        if (
          !route ||
          route.kiloSessionId !== session.kiloSessionId ||
          route.directory !== session.directory ||
          routeWorktreeId === exclusiveWorktreeId ||
          (routeWorktreeId && this.deletingWorktrees.has(routeWorktreeId)) ||
          (worktreeId && this.deletingWorktrees.has(worktreeId))
        ) {
          return false;
        }
        const journal = await loadWorktreeDeletionJournal(this.ctx.storage, exclusiveWorktreeId);
        return (
          this.exclusiveDeletionWorktreeId === exclusiveWorktreeId &&
          journal?.exclusiveTeardown === false
        );
      });
      if (allowed) return;
    }
    this.assertWorktreeAdmission(worktreeId);
  }

  private assertWorktreeAdmission(worktreeId?: string): void {
    if (
      this.exclusiveDeletionWorktreeId ||
      (worktreeId && this.deletingWorktrees.has(worktreeId))
    ) {
      throw new Error('worktree_deleting');
    }
  }

  async listRoutes(): Promise<SessionRoute[]> {
    await this.ensureOperationalInitialized();
    const table = await loadRouteTable(this.ctx.storage);
    return [...table.values()];
  }

  async validateTerminalAccess(
    input: SandboxTerminalAccessInput
  ): Promise<SandboxTerminalAccessResult> {
    const runtime = await this.readTerminalRuntime(input, true);
    if (!runtime.allowed) return runtime;

    if (this.providerBinding.kind === 'onprem') {
      return this.renewTerminalCredentialLease(input, runtime);
    }
    const enforced = isCloudAgentContainerBillingEnabled(this.env, {
      userId: input.ownerId,
      ...(input.organizationId ? { orgId: input.organizationId } : {}),
    });
    if (!enforced) return this.renewTerminalCredentialLease(input, runtime);
    if (runtime.provider !== 'cloudflare' && runtime.provider !== 'cloudflare-containers') {
      return { allowed: false, reason: 'billing_policy_unavailable' };
    }

    let billing: SandboxTerminalAccessResult;
    try {
      if (runtime.provider === 'cloudflare') {
        const providerRef = decodeCloudflareProviderRef(canonicalProviderRefOf(runtime.physical));
        if (!providerRef) return { allowed: false, reason: 'runtime_not_running' };
        const allocationId = providerRef.sandboxId;
        const namespace = getSandboxNamespace(this.env, allocationId, {
          managedScmContainment: providerRef.containment,
        });
        const sandbox = getSandbox(namespace, allocationId);
        billing = validateTerminalBillingRuntime({
          access: runtime.route.worktreeId
            ? {
                ...input,
                sessionId: `workspace_${runtime.route.worktreeId.slice('worktree_'.length)}`,
              }
            : input,
          sandboxId: allocationId,
          providerInstanceId: runtime.connection.providerInstanceId,
          sandboxDurableObjectId: namespace.idFromName(allocationId).toString(),
          runtime: await withTimeout(
            getSandboxBillingRuntimeStatus(sandbox),
            DEADLINE_MS.stopAttempt,
            'Sandbox billing runtime observation timed out'
          ),
        });
      } else {
        const namespace = this.env.SANDBOX_CONTAINERS;
        const container = namespace.getByName(this.sandboxId);
        billing = validateContainersTerminalBillingRuntime({
          access: runtime.route.worktreeId
            ? {
                ...input,
                sessionId: `workspace_${runtime.route.worktreeId.slice('worktree_'.length)}`,
              }
            : input,
          sandboxId: this.sandboxId,
          providerInstanceId: runtime.connection.providerInstanceId,
          sandboxDurableObjectId: namespace.idFromName(this.sandboxId).toString(),
          runtime: await withTimeout(
            container.getBillingRuntimeStatus(),
            DEADLINE_MS.stopAttempt,
            'Sandbox billing runtime observation timed out'
          ),
        });
      }
    } catch {
      return { allowed: false, reason: 'billing_runtime_unavailable' };
    }
    if (!billing.allowed) return billing;

    const current = await this.readTerminalRuntime(input, true);
    if (!current.allowed) return current;
    if (!this.sameTerminalRuntime(current, runtime)) {
      return { allowed: false, reason: 'runtime_changed' };
    }
    return this.renewTerminalCredentialLease(input, current);
  }

  private sameTerminalRuntime(
    left: TerminalRuntimeSnapshot,
    right: TerminalRuntimeSnapshot
  ): boolean {
    return (
      this.sameConnection(left.connection, right.connection) &&
      left.provider === right.provider &&
      canonicalProviderRefOf(left.physical) === canonicalProviderRefOf(right.physical) &&
      left.route.kiloSessionId === right.route.kiloSessionId &&
      left.route.directory === right.route.directory &&
      left.grant.scopeId === right.grant.scopeId &&
      (left.grant.containmentEnabled !== false) === (right.grant.containmentEnabled !== false) &&
      left.grant.kilo.alias === right.grant.kilo.alias
    );
  }

  private async renewTerminalCredentialLease(
    input: SandboxTerminalAccessInput,
    runtime: TerminalRuntimeSnapshot
  ): Promise<SandboxTerminalAccessResult> {
    if (runtime.grant.containmentEnabled === false) {
      return runtime.grant.expiresAt > Date.now()
        ? { allowed: true }
        : { allowed: false, reason: 'credential_reattach_required' };
    }
    if (runtime.grant.expiresAt > Date.now() + TERMINAL_CREDENTIAL_RENEWAL_WINDOW_MS) {
      return { allowed: true };
    }
    try {
      await this.withCredentialUpdate(async () => {
        const current = await this.readTerminalRuntime(input, true);
        if (!current.allowed || !this.sameTerminalRuntime(current, runtime)) {
          throw new Error('Terminal runtime changed before credential renewal');
        }
        if (current.grant.expiresAt > Date.now() + TERMINAL_CREDENTIAL_RENEWAL_WINDOW_MS) return;
        await this.prepareOwnedSessionCredentials(
          { ownerId: input.ownerId, sessionId: input.sessionId },
          { access: input, runtime: current }
        );
      });
      if (runtime.provider === 'vercel') {
        await this.enforceWorktreeNetworkPolicy(input.ownerId);
      }
    } catch {
      return { allowed: false, reason: 'credential_scope_unavailable' };
    }
    const current = await this.readTerminalRuntime(input);
    if (!current.allowed) return current;
    return this.sameTerminalRuntime(current, runtime)
      ? { allowed: true }
      : { allowed: false, reason: 'runtime_changed' };
  }

  async recordTerminalActivity(
    input: SandboxTerminalAccessInput
  ): Promise<SandboxTerminalAccessResult> {
    const access = await this.validateTerminalAccess(input);
    if (!access.allowed) return access;

    const runtime = await this.readTerminalRuntime(input);
    if (!runtime.allowed) return runtime;

    if (!this.isCurrentConnection(runtime.connection)) {
      return { allowed: false, reason: 'runtime_changed' };
    }
    await this.armCanonicalIdle(Date.now() + DEADLINE_MS.idleStop);
    if (!this.isCurrentConnection(runtime.connection)) {
      return { allowed: false, reason: 'runtime_changed' };
    }
    await this.renewProviderLease(runtime.connection);
    if (runtime.provider === 'onprem' && !this.isCurrentConnection(runtime.connection)) {
      return { allowed: false, reason: 'runtime_changed' };
    }
    return { allowed: true };
  }

  /**
   * Canonical allocation read for the live path. A fail-closed load throws; the
   * flat record key is not read here, only the canonical aggregate
   * (with the legacy decoder as the one-time bootstrap inside `loadAllocation`).
   */
  private async readCanonicalAllocation(): Promise<AllocationRecord> {
    return loadAllocation(this.ctx.storage, this.provider.resumable);
  }

  /**
   * Synchronous canonical read for the frame/batch forwarding fences, which must
   * not perform awaited storage reads. Shares the decision and fail-closed
   * behaviour with `readCanonicalAllocation` through `loadAllocationSync`.
   */
  private readCanonicalAllocationSync(): AllocationRecord {
    return loadAllocationSync(this.ctx.storage.kv, this.provider.resumable);
  }

  /** The canonical incarnation while an allocation is allocated, else nothing. */
  private allocationIncarnationOf(record: AllocationRecord): string | undefined {
    return record.state.kind === 'allocated' ? record.state.health.incarnation : undefined;
  }

  /** Canonical create target: the identity fields the lossy legacy schema dropped. */
  private canonicalTarget(
    requiredContainment: CredentialContainmentRequirements,
    allocationName: string,
    vercel: ProviderAllocationIntent['vercel'],
    onprem?: OnPremAllocationConfig
  ): AllocationTarget {
    const provider =
      onprem !== undefined ? 'onprem' : this.providerKind === 'vercel' ? 'vercel' : 'cloudflare';
    const capabilities =
      provider === 'vercel'
        ? { persistentWorkspace: true, destroysOnStop: false }
        : { persistentWorkspace: false, destroysOnStop: true };
    return {
      provider,
      providerRef: null,
      allocationName,
      capabilities,
      containment: requiredContainment,
      ...(vercel === undefined ? {} : { vercel }),
      ...(onprem === undefined ? {} : { onprem }),
    };
  }

  private matchesCanonicalProviderReference(
    state: CreatingAllocation | AllocatedAllocation,
    providerRef: string
  ): boolean {
    // A bound reference is exact: a decoded-name match is not enough, or a
    // different physical session of the same sandbox would be accepted as the
    // current one.
    if (state.target.providerRef !== null && state.target.providerRef !== providerRef) return false;
    const allocationName = state.target.allocationName ?? this.sandboxId;
    if (this.providerBinding.kind === 'onprem') {
      const onprem = state.target.onprem;
      const ref = decodeOnPremProviderRef(providerRef);
      return (
        ref !== null &&
        onprem !== undefined &&
        ref.installationId === onprem.binding.installationId &&
        ref.allocationId === state.createIntent.intentId &&
        Date.now() < onprem.hardStopAt
      );
    }
    if (this.providerKind === 'vercel') {
      return decodeVercelProviderRef(providerRef)?.sandboxName === allocationName;
    }
    const native = decodeCloudflareProviderRef(providerRef);
    const containment = state.target.containment ?? state.target.resolvedContainment;
    return (
      native?.sandboxId === allocationName &&
      containment !== undefined &&
      native.containment === (containment.kilocode || containment.github) &&
      native.instanceId === state.createIntent.intentId
    );
  }

  /**
   * Request-admission predicate for an on-prem allocation: the live provider
   * reference must still match the allocation's pinned identity and the fixed
   * lifetime must not be exhausted. The canonical predicate owns both checks so
   * admission never re-derives the expiry. Non-on-prem providers admit on the
   * generic reference check.
   */
  private matchesLiveOnPremProviderReference(
    record: AllocationRecord,
    providerRef: string
  ): boolean {
    if (this.providerBinding.kind !== 'onprem') return true;
    const state = record.state;
    if (state.kind !== 'creating' && state.kind !== 'allocated') return false;
    return this.matchesCanonicalProviderReference(state, providerRef);
  }

  /** Canonical form of `matchesContainment`, over the aggregate state kinds. */
  private matchesCanonicalContainment(
    record: AllocationRecord,
    requiredContainment: CredentialContainmentRequirements
  ): boolean {
    const state = record.state;
    if (this.providerBinding.kind === 'onprem') {
      // On-prem containment is always the full worktree containment, and a
      // reached fixed-lifetime cap makes the credentials unavailable even before
      // the stop effect runs. Otherwise fall through to the generic checks.
      const onprem =
        state.kind === 'creating' || state.kind === 'allocated' || state.kind === 'stopping'
          ? state.target.onprem
          : undefined;
      if (
        !requiredContainment.kilocode ||
        !requiredContainment.github ||
        !requiredContainment.worktreeScoped ||
        (onprem !== undefined && Date.now() >= onprem.hardStopAt)
      ) {
        return false;
      }
    }
    if (state.kind === 'creating') {
      const containment = state.target.containment;
      return (
        containment !== undefined &&
        containment.kilocode === requiredContainment.kilocode &&
        containment.github === requiredContainment.github &&
        containment.worktreeScoped === requiredContainment.worktreeScoped
      );
    }
    if (state.kind !== 'allocated' || state.target.providerRef === null) return false;
    const containment = state.target.resolvedContainment;
    return (
      this.matchesCanonicalProviderReference(state, state.target.providerRef) &&
      containment !== undefined &&
      containment.providerRef === state.target.providerRef &&
      containment.kilocode === requiredContainment.kilocode &&
      containment.github === requiredContainment.github &&
      containment.worktreeScoped === requiredContainment.worktreeScoped
    );
  }

  /** Canonical form of `matchesWorktreeContainment`. */
  private matchesCanonicalWorktreeContainment(record: AllocationRecord): boolean {
    const state = record.state;
    if (state.kind !== 'creating' && state.kind !== 'allocated') return false;
    const containment =
      state.kind === 'creating' ? state.target.containment : state.target.resolvedContainment;
    return (
      containment?.worktreeScoped === true &&
      containment.kilocode === containment.github &&
      this.matchesCanonicalContainment(record, containment)
    );
  }

  async getStatus(): Promise<SandboxControlStatus> {
    await this.ensureOperationalInitialized();
    const record = await this.readCanonicalAllocation();
    return this.statusForAllocation(record, this.allocationIncarnationOf(record));
  }

  private async statusForAllocation(
    record: AllocationRecord,
    allocationIncarnation?: string
  ): Promise<SandboxControlStatus> {
    const connection = this.connectionState();
    const work = await this.workState();
    const runtime = this.readyWrapperRuntime();
    const physical = legacyPhysicalState(record);
    const projection = projectStatus({ allocation: record, ownerPresent: true, now: Date.now() });
    const failureReason =
      await this.ctx.storage.get<SandboxProviderFailureReason>(FAILURE_REASON_KEY);
    const hardStopAt =
      this.providerBinding.kind === 'onprem' &&
      (record.state.kind === 'creating' ||
        record.state.kind === 'allocated' ||
        record.state.kind === 'stopping')
        ? record.state.target.onprem?.hardStopAt
        : undefined;
    return {
      ...projection,
      physical,
      connection,
      work,
      ...(failureReason === undefined ? {} : { failureReason }),
      ...(hardStopAt === undefined ? {} : { hardStopAt }),
      ...(record.state.kind === 'allocated' && runtime?.wrapperInstanceId
        ? { wrapperInstanceId: runtime.wrapperInstanceId }
        : {}),
      ...(allocationIncarnation === undefined ? {} : { allocationIncarnation }),
      ...(typeof this.socketHandler.supportsOperationResults === 'function' &&
      this.socketHandler.supportsOperationResults()
        ? { operationResults: true as const }
        : {}),
      ...(runtime?.runtimeRecovery ? { runtimeRecovery: true as const } : {}),
    };
  }

  /**
   * An acquisition that could not bind is not sendable even when the shared
   * wrapper is healthy. The allocated record stays intact, but the ready
   * connection and wrapper identity are withheld from this acquisition result
   * so the caller takes its bounded wait path instead of dispatching against an
   * allocation this session is still fenced from. The wrapper itself stays
   * healthy: only this result is downgraded.
   */
  private async waitingAcquisitionStatus(record: AllocationRecord): Promise<SandboxControlStatus> {
    const status = await this.statusForAllocation(record);
    if (status.connection !== 'ready') return status;
    const { wrapperInstanceId: _withheld, ...rest } = status;
    return { ...rest, connection: 'connected' };
  }

  async getSandboxStatus(input: {
    ownerId: string;
    provider: AgentSandboxProvider;
  }): Promise<SandboxStatusSnapshot> {
    const [allocation, ownerId, provider, wrapperRuntime, routes, runtime] = await Promise.all([
      loadAllocationResult(this.ctx.storage, this.provider.resumable),
      this.readOwner(),
      this.ctx.storage.get<unknown>(PROVIDER_KIND_KEY),
      this.ctx.storage.get<unknown>(ACTIVE_WRAPPER_RUNTIME_KEY),
      loadRouteTable(this.ctx.storage),
      loadRuntimeMetadata(this.ctx.storage),
    ]);
    const matches =
      ownerId !== null &&
      ownerId === input.ownerId &&
      agentSandboxProviderSchema.safeParse(provider).success &&
      provider === input.provider;
    // A never-provisioned sandbox (`initial`) is `unknown`, not `stopped`: the
    // canonical initial record must not read as a real sleeping allocation.
    const record =
      matches && allocation.ok && allocation.source !== 'initial' ? allocation.value : null;
    return projectStatusSnapshot({
      allocation: record,
      ownerId,
      provider: matches ? provider : undefined,
      runtime,
      routes: [...routes.values()],
      connection: readSandboxControlConnection(
        this.ctx,
        record ? canonicalProviderRefOf(record) : null,
        wrapperRuntime
      ),
      now: Date.now(),
    });
  }

  async getAllocationRecord(): Promise<AllocationRecord> {
    await this.ensureOperationalInitialized();
    return this.readCanonicalAllocation();
  }

  async getTransitionLog(): Promise<TransitionRow[]> {
    await this.ensureOperationalInitialized();
    return loadTransitionLog(this.ctx.storage);
  }

  async beginStop(reason: string): Promise<AllocationRecord> {
    await this.ensureOperationalInitialized();
    const record = await this.readCanonicalAllocation();
    return this.driveCanonicalStop(record, reason);
  }

  async recordStopAttempt(): Promise<AllocationRecord> {
    await this.ensureOperationalInitialized();
    const record = await this.readCanonicalAllocation();
    if (
      this.stopAttemptInFlight &&
      sameCanonicalAllocation(this.stopAttemptInFlight.record, record)
    ) {
      this.logDiagnostic('stop_coalesced', {
        allocationId:
          record.state.kind === 'stopped' ? undefined : record.state.createIntent?.intentId,
        stopAttempts: record.state.kind === 'stopping' ? record.state.attempts : undefined,
      });
      return this.stopAttemptInFlight.promise;
    }
    const pending = {
      record,
      promise: this.driveCanonicalStop(record),
    };
    this.stopAttemptInFlight = pending;
    try {
      return await pending.promise;
    } finally {
      if (this.stopAttemptInFlight === pending) this.stopAttemptInFlight = null;
    }
  }

  /**
   * One canonical stop attempt. `CANCEL` drives an allocated or already-stopping
   * allocation (re-emitting the Stop/Destroy effect for the current attempt);
   * `CHECK` advances a `check_required` step through Observe; `DEADLINE` walks a
   * creating or unknown allocation to its observation. The reducer owns the
   * attempt counter and the retry/deadline ladder, so this method only dispatches
   * the event, runs the resulting effect commands, and commits the side effects.
   */
  private async driveCanonicalStop(
    record: AllocationRecord,
    reason?: string
  ): Promise<AllocationRecord> {
    const event = canonicalStopEvent(record, reason);
    if (event === undefined) return record;
    const decision = await this.allocationOrchestrator.dispatch(event);
    if (decision === undefined) return this.readCanonicalAllocation();
    await this.allocationOrchestrator.run(decision.commands);
    const after = await this.readCanonicalAllocation();
    await this.afterCanonicalCommit(record, after);
    return after;
  }

  async confirmStopped(): Promise<AllocationRecord> {
    await this.ensureOperationalInitialized();
    const record = await this.readCanonicalAllocation();
    return this.driveCanonicalStop(record);
  }

  async markFailed(): Promise<AllocationRecord> {
    await this.ensureOperationalInitialized();
    const before = await this.readCanonicalAllocation();
    const after = await this.driveCanonicalStop(before, 'environment_failed');
    await this.ctx.storage.put(DIAGNOSTIC_BUNDLE_KEY, {
      at: Date.now(),
      from: legacyPhysicalState(before),
      to: legacyPhysicalState(after),
      connection: this.connectionState(),
      logTail: (await loadTransitionLog(this.ctx.storage)).slice(-20),
    });
    return after;
  }

  async eraseRecord(options?: { preserveAcquisitionReceipts: true }): Promise<void> {
    await this.ensureOperationalInitialized();
    await eraseSandboxRecord(this.ctx.storage);
    await this.ctx.storage.delete([
      OWNER_ID_KEY,
      CREDENTIAL_HASH_KEY,
      WRAPPER_READY_AT_KEY,
      WRAPPER_HEARTBEAT_OBSERVATION_KEY,
      ACTIVE_WRAPPER_RUNTIME_KEY,
      DIAGNOSTIC_BUNDLE_KEY,
      PROVIDER_KIND_KEY,
      PROVIDER_CONFIGURATION_KEY,
      PROVIDER_BINDING_KEY,
      FAILURE_REASON_KEY,
      NEXT_LEASE_CHECK_AT_KEY,
      BYOC_SNAPSHOT_RECOVERY_KEY,
      ONPREM_ACKNOWLEDGEMENT_KEY,
      BILLING_INPUT_KEY,
      CREDENTIAL_POLICY_DIRTY_KEY,
      PROVIDER_LOCATOR_KEY,
      ...(options?.preserveAcquisitionReceipts ? [] : [ACQUISITION_RECEIPTS_KEY]),
    ]);
    this.vercelLocator = undefined;
    this.vercelResources = undefined;
    this.containersInstance = undefined;
    this.providerBinding = { kind: 'cloudflare' };
    this.activeConnection = null;
    this.readyConnectionId = null;
    this.kiloReady = false;
  }

  private withCredentialUpdate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.credentialUpdates.then(operation);
    this.credentialUpdates = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async readCredentialMetadata(input: {
    ownerId: string;
    sessionId: string;
  }): Promise<SessionMetadata> {
    if (typeof input.sessionId !== 'string' || !input.sessionId.startsWith('workspace_')) {
      throw new Error('Control-plane session credentials are required');
    }
    const metadata = await withDORetry<
      ReturnType<typeof getSandboxSessionStub>,
      SessionMetadata | null
    >(
      () => getSandboxSessionStub(this.env, input.ownerId, input.sessionId),
      stub => stub.getCredentialMetadata(),
      'getCredentialMetadata'
    );
    if (
      !metadata ||
      metadata.identity.userId !== input.ownerId ||
      metadata.identity.sessionId !== input.sessionId ||
      metadata.workspace?.sandboxId !== this.sandboxId
    ) {
      throw new Error('Session credential ownership mismatch');
    }
    this.assertWorktreeAdmission(metadata.workspace?.worktreeId);
    return metadata;
  }

  private async scheduleCredentialExpiry(grants: SessionCredentialGrant[]): Promise<void> {
    const expiry = Math.min(...grants.map(grant => grant.expiresAt));
    if (Number.isFinite(expiry)) {
      await this.armInfrastructureAnchor('credentialExpiry', expiry);
    } else {
      await this.cancelInfrastructureAnchor('credentialExpiry');
    }
  }

  private refreshWorktreeNetworkPolicy(ownerId: string): Promise<void> {
    return this.withCredentialUpdate(async () => {
      if (this.providerKind !== 'vercel') return;
      await this.ctx.storage.put(CREDENTIAL_POLICY_DIRTY_KEY, true);
      const record = await this.readCanonicalAllocation();
      if (record.state.kind === 'stopped') {
        await this.ctx.storage.delete(CREDENTIAL_POLICY_DIRTY_KEY);
        return;
      }
      if (
        this.matchesCanonicalWorktreeContainment(record) &&
        !canonicalContainmentOf(record)?.kilocode
      ) {
        await this.ctx.storage.delete(CREDENTIAL_POLICY_DIRTY_KEY);
        await this.cancelInfrastructureAnchor('credentialExpiry');
        return;
      }
      if (record.state.kind !== 'allocated') {
        throw new Error('Sandbox credential policy is unavailable');
      }
      const grants = await loadSessionCredentialGrants(this.ctx.storage);
      const now = Date.now();
      const authorized = grants.filter(grant => grant.preparedAt <= now && grant.expiresAt > now);
      await this.updateNetworkPolicy({
        ownerId,
        networkPolicy: buildControlNetworkPolicy(authorized),
        requiredContainment: WORKTREE_CREDENTIAL_CONTAINMENT,
      });
      await this.scheduleCredentialExpiry(authorized);
      await this.ctx.storage.delete(CREDENTIAL_POLICY_DIRTY_KEY);
    });
  }

  private async enforceWorktreeNetworkPolicy(ownerId: string): Promise<void> {
    const expected = await this.readCanonicalAllocation();
    try {
      await this.refreshWorktreeNetworkPolicy(ownerId);
    } catch {
      const current = await this.readCanonicalAllocation();
      const expectedRef = canonicalProviderRefOf(expected);
      if (
        !sameCanonicalAllocation(current, expected) ||
        (expectedRef !== null && canonicalProviderRefOf(current) !== expectedRef)
      ) {
        return;
      }
      // The reducer owns attempts, deadlines and cleanup progression: dispatch
      // the canonical event for the current state and let the stop/observe
      // ladder settle it. No legacy retry budget or reconciliation window is
      // consulted, and a concurrent replacement is left untouched.
      const after = await this.driveCanonicalStop(current, 'environment_failed');
      if (!sameCanonicalAllocation(after, expected)) return;
      if (after.state.kind !== 'stopped') {
        throw new Error('Sandbox credential revocation is pending');
      }
    }
  }

  private createProviderAdapter(
    kind: AgentSandboxProvider,
    record?: AllocationRecord
  ): ProviderAdapter {
    const state = record?.state;
    const allocationName =
      state !== undefined && state.kind !== 'stopped'
        ? (state.target?.allocationName ?? this.sandboxId)
        : this.sandboxId;
    if (kind === 'vercel') {
      const locator = state?.kind === 'stopped' ? undefined : this.vercelLocator;
      const persisted =
        state !== undefined && state.kind !== 'stopped' ? state.target?.vercel : undefined;
      const persistedResources =
        persisted?.resources === undefined
          ? undefined
          : vercelSandboxResourcesSchema.parse(persisted.resources);
      const resources = persistedResources ?? this.vercelResources;
      const configuration =
        persisted !== undefined
          ? {
              ...(persisted.projectId === undefined ? {} : { projectId: persisted.projectId }),
              ...(persisted.snapshotId === undefined ? {} : { snapshotId: persisted.snapshotId }),
              ...(persisted.runtimeBuildId === undefined
                ? {}
                : { runtimeBuildId: persisted.runtimeBuildId }),
              ...(persisted.runtime === undefined ? {} : { runtime: persisted.runtime }),
              ...(resources === undefined ? {} : { resources }),
            }
          : locator === undefined
            ? undefined
            : { ...locator, ...(resources === undefined ? {} : { resources }) };
      const config = resolveVercelSandboxRuntimeConfig(this.env, configuration);
      return createVercelProviderAdapter({
        sandboxName: allocationName,
        config: config && locator ? { ...config, teamId: locator.teamId } : config,
      });
    }
    if (kind === 'cloudflare-containers') {
      return createCloudflareContainersProviderAdapter({
        logicalSandboxId: this.sandboxId,
        allocationName,
        instance: this.containersInstance,
        getContainer: id => this.env.SANDBOX_CONTAINERS.getByName(id),
      });
    }
    if (kind === 'onprem') {
      if (this.providerBinding.kind !== 'onprem') {
        throw new Error('On-prem provider adapter requires an on-prem binding');
      }
      const live =
        state !== undefined &&
        (state.kind === 'creating' || state.kind === 'allocated' || state.kind === 'stopping');
      const target = live && state !== undefined ? state.target : undefined;
      const createIntent = live && state !== undefined ? state.createIntent : null;
      return createOnPremProviderAdapter({
        env: this.env,
        binding: this.providerBinding,
        sandboxId: this.sandboxId,
        intent:
          target !== undefined && createIntent !== null
            ? {
                intentId: createIntent.intentId,
                createdAt: createIntent.createdAt,
                ...(target.allocationName === undefined
                  ? {}
                  : { allocationName: target.allocationName }),
                ...(target.containment === undefined ? {} : { containment: target.containment }),
                ...(target.onprem === undefined ? {} : { onprem: target.onprem }),
              }
            : null,
      });
    }
    return createCloudflareProviderAdapter({
      sandboxId: allocationName,
      getSandbox: (id, options) =>
        getSandbox(
          getSandboxNamespace(this.env, id, { managedScmContainment: options.containment }),
          id
        ),
      destroy: (id, options) =>
        forceDestroyControlPlaneSandbox(
          getSandboxNamespace(this.env, id, {
            managedScmContainment: options.containment,
          }).getByName(id)
        ),
    });
  }

  private isByocBinding(): boolean {
    return this.providerBinding.kind === 'vercel' && this.providerBinding.source.kind === 'byoc';
  }

  /**
   * The provider adapter for the current binding. A BYOC Vercel binding builds an
   * adapter per operation from the customer credential (the access token is never
   * persisted); every other binding uses the pinned adapter. The canonical target
   * carries the demand-time Vercel block, so observe/stop/launch target the same
   * build the create bound.
   */
  private async providerFor(target?: AllocationTarget): Promise<ProviderAdapter> {
    if (this.providerBinding.kind === 'onprem') {
      // The on-prem adapter is rebuilt per operation from the pinned canonical
      // target, like BYOC: the installation runner is a per-request destination,
      // never in-memory connection state.
      return this.createProviderAdapter('onprem', await this.readCanonicalAllocation());
    }
    if (!this.isByocBinding()) return this.provider;
    if (this.providerBinding.kind !== 'vercel' || this.providerBinding.source.kind !== 'byoc') {
      return this.provider;
    }
    const allocationName = target?.allocationName ?? this.sandboxId;
    const config = await this.resolveByocRuntimeConfig(target);
    return createVercelProviderAdapter({ sandboxName: allocationName, config });
  }

  /**
   * The single owner of the obsolete-failure decision: a stored provider
   * failure and the missing-snapshot projection it armed are cleared together.
   * The projection is only meaningful while the failure that recorded it is
   * current, so clearing the veto without it would leave recovery armed against
   * a snapshot that was just observed active. Attempt/exhaustion bookkeeping
   * stays with `retryByocSnapshotRecovery`, which owns the pending record.
   */
  private clearObsoleteProviderFailure(): void {
    const kv = this.ctx.storage.kv;
    kv.delete(FAILURE_REASON_KEY);
    kv.delete(BYOC_SNAPSHOT_RECOVERY_KEY);
  }

  private async recordProviderFailure(error: unknown): Promise<void> {
    const reason =
      providerFailureReason(this.providerBinding, error) ??
      (this.isByocBinding() &&
      ((error instanceof VercelSandboxRestError &&
        error.status !== undefined &&
        error.status >= 500) ||
        error instanceof ByocCredentialResolverError)
        ? 'environment_failed'
        : undefined);
    if (reason === undefined) return;
    await this.ctx.storage.put(FAILURE_REASON_KEY, reason);
    if (reason === 'byoc_vercel_not_ready') {
      const snapshot = await this.byocRuntimeSnapshotForRecovery();
      if (snapshot === undefined) return;
      // Record the missing snapshot and arm the retry anchor. The alarm owns
      // every projection attempt, so a failed projection is retried and
      // eventually cleared instead of being written and forgotten.
      await this.ctx.storage.put(BYOC_SNAPSHOT_RECOVERY_KEY, {
        snapshot,
        attempts: 0,
      });
      await this.armInfrastructureAnchor(
        'byocSnapshotRecovery',
        Date.now() + DEADLINE_MS.reconciliation
      );
    }
  }

  /**
   * The missing-snapshot identity of the current canonical allocation, rebuilt
   * from the persisted binding and demand-time target. The identity must not
   * live in instance state: a DO eviction between the demand and the failing
   * provider call would lose it and never arm recovery.
   */
  private async byocRuntimeSnapshotForRecovery(): Promise<ByocVercelRuntimeSnapshot | undefined> {
    const binding = this.providerBinding;
    if (binding.kind !== 'vercel' || binding.source.kind !== 'byoc') return undefined;
    const state = (await this.readCanonicalAllocation()).state;
    if (state.kind === 'stopped') return undefined;
    const vercel = state.target?.vercel;
    if (vercel?.buildGeneration === undefined || vercel.snapshotId === undefined) return undefined;
    return {
      organizationId: binding.source.organizationId,
      credentialId: binding.source.credentialId,
      buildGeneration: vercel.buildGeneration,
      runtimeSnapshotId: vercel.snapshotId,
    };
  }

  /**
   * The single owner of the pending missing-snapshot projection. Each firing
   * attempts the backend projection, then settles its own record: a settled
   * attempt clears the key, an unsettled one is retried a bounded number of
   * times before terminal cleanup. The settlement is applied only while the
   * stored record is still the attempted one, so an attempt that overlapped a
   * newer pending projection never deletes or rewrites it.
   */
  private async retryByocSnapshotRecovery(): Promise<void> {
    const raw = await this.ctx.storage.get(BYOC_SNAPSHOT_RECOVERY_KEY);
    if (raw === undefined) return;
    const parsed = byocSnapshotRecoverySchema.safeParse(raw);
    if (!parsed.success) {
      await this.ctx.storage.delete(BYOC_SNAPSHOT_RECOVERY_KEY);
      this.logDiagnostic('byoc_snapshot_recovery', { result: 'discarded' }, 'warn');
      return;
    }
    const attempted = parsed.data;
    const settled = await this.recoverMissingByocSnapshot(attempted.snapshot);
    const attempts = attempted.attempts + 1;
    const exhausted = attempts >= BYOC_SNAPSHOT_RECOVERY_MAX_ATTEMPTS;
    const applied = await this.ctx.storage.transaction(async () => {
      const current = byocSnapshotRecoverySchema.safeParse(
        await this.ctx.storage.get(BYOC_SNAPSHOT_RECOVERY_KEY)
      );
      if (!current.success || !sameByocSnapshotRecovery(current.data, attempted)) return false;
      if (settled || exhausted) {
        await this.ctx.storage.delete(BYOC_SNAPSHOT_RECOVERY_KEY);
        return true;
      }
      await this.ctx.storage.put(BYOC_SNAPSHOT_RECOVERY_KEY, {
        snapshot: attempted.snapshot,
        attempts,
      });
      return true;
    });
    if (!applied) return;
    if (settled) {
      this.logDiagnostic('byoc_snapshot_recovery', { result: 'settled' });
      return;
    }
    if (exhausted) {
      this.logDiagnostic('byoc_snapshot_recovery', { result: 'exhausted', attempts }, 'warn');
      return;
    }
    await this.armInfrastructureAnchor(
      'byocSnapshotRecovery',
      Date.now() + DEADLINE_MS.reconciliation
    );
  }

  /**
   * Tell the backend that the customer's BYOC runtime snapshot is gone, so the
   * enrollment is marked failed and re-provisioned instead of every session
   * retrying against a snapshot that no longer exists. Returns true when the
   * projection is settled: it landed, or the credential itself is gone. The
   * caller owns deleting the pending record, so this never touches storage.
   */
  private async recoverMissingByocSnapshot(snapshot: ByocVercelRuntimeSnapshot): Promise<boolean> {
    try {
      await withTimeout(
        projectByocVercelSnapshotMissing(this.env, snapshot),
        DEADLINE_MS.stopAttempt,
        'BYOC Vercel snapshot recovery timed out'
      );
      return true;
    } catch (error) {
      if (error instanceof ByocCredentialMissingError) return true;
      this.logDiagnostic('byoc_snapshot_recovery', { result: 'failed' }, 'warn');
      return false;
    }
  }

  private async resolveByocRuntimeConfig(
    target?: AllocationTarget
  ): Promise<VercelSandboxRuntimeConfig> {
    if (this.providerBinding.kind !== 'vercel' || this.providerBinding.source.kind !== 'byoc') {
      throw new Error('BYOC Vercel runtime configuration is unavailable');
    }
    const defaults = parseVercelSandboxRuntimeDefaults(this.env);
    if (!defaults) throw new Error('Vercel sandbox runtime configuration is unavailable');
    const persisted = target?.vercel;
    if (
      persisted === undefined ||
      persisted.projectId === undefined ||
      persisted.snapshotId === undefined ||
      persisted.runtimeBuildId === undefined
    ) {
      return resolveByocVercelRuntimeConfig(this.env, this.providerBinding.source);
    }
    const credentials = await resolveByocVercelCredentials(this.env, this.providerBinding.source);
    const resources = vercelSandboxResourcesSchema
      .optional()
      .parse(persisted.resources ?? this.vercelResources);
    return {
      ...defaults,
      ...credentials,
      projectId: persisted.projectId,
      snapshotId: persisted.snapshotId,
      runtimeBuildId: persisted.runtimeBuildId,
      runtime: persisted.runtime === 'node24' ? persisted.runtime : defaults.runtime,
      ...(resources === undefined ? {} : { resources }),
    };
  }

  /**
   * Resolve the demand-time Vercel intent before any provider side effect. A
   * permanent BYOC configuration failure (deleted credential, unfinished
   * enrollment) records the specific reason so the head terminalizes with it. A
   * transient credential-backend failure records nothing and reports unresolved,
   * so the allocation stays stopped and the bounded queue retry re-drives the
   * demand. Any other error propagates.
   */
  private async resolveDemandVercelIntent(): Promise<
    { resolved: true; vercel: ProviderAllocationIntent['vercel'] } | { resolved: false }
  > {
    try {
      return { resolved: true, vercel: await this.vercelIntentConfigForDemand() };
    } catch (error) {
      if (providerFailureReason(this.providerBinding, error) !== undefined) {
        await this.recordProviderFailure(error);
        return { resolved: false };
      }
      if (error instanceof ByocCredentialResolverError) {
        this.logDiagnostic('byoc_credential_resolution', { result: 'retry' }, 'warn');
        return { resolved: false };
      }
      throw error;
    }
  }

  /**
   * Resolve the on-prem profile before any provider side effect and pin it onto
   * the demand-time target. The profile is installation-owned state, so the
   * allocation cannot be created without it: a resolution failure records the
   * reason and reports unresolved, leaving the allocation stopped for the head
   * to terminalize with it.
   */
  private async resolveDemandOnPremProfile(): Promise<
    | { resolved: true; binding: OnPremProviderBinding; profile: OnPremProfile }
    | { resolved: false }
    | undefined
  > {
    if (this.providerBinding.kind !== 'onprem') return undefined;
    const binding = this.providerBinding;
    try {
      const profile = onPremProfileSchema.parse(
        await withTimeout(
          resolveOnPremProfile(this.env, binding),
          DEADLINE_MS.startup,
          'On-prem profile resolution timed out'
        )
      );
      return { resolved: true, binding, profile };
    } catch (error) {
      if (providerFailureReason(binding, error) !== undefined) {
        await this.recordProviderFailure(error);
        return { resolved: false };
      }
      throw error;
    }
  }

  /**
   * The demand-time Vercel intent block. For a BYOC binding it resolves the
   * customer credential and persists the credential's build generation on the
   * block, so the missing-snapshot projection survives a DO eviction; for a
   * platform binding it reconstructs the pinned environment block.
   */
  private async vercelIntentConfigForDemand(): Promise<ProviderAllocationIntent['vercel']> {
    if (!this.isByocBinding()) return this.controlVercelIntentConfig();
    if (this.providerBinding.kind !== 'vercel' || this.providerBinding.source.kind !== 'byoc') {
      return undefined;
    }
    let buildGeneration: string | undefined;
    const config = await resolveByocVercelRuntimeConfig(
      this.env,
      this.providerBinding.source,
      snapshot => {
        buildGeneration = snapshot.buildGeneration;
      }
    );
    const resources = config.resources === undefined ? this.vercelResources : config.resources;
    return {
      projectId: config.projectId,
      snapshotId: config.snapshotId,
      runtimeBuildId: config.runtimeBuildId,
      ...(buildGeneration === undefined ? {} : { buildGeneration }),
      runtime: config.runtime,
      ...(resources === undefined ? {} : { resources }),
    };
  }

  private async readProviderConfiguration(): Promise<SandboxProviderConfiguration | undefined> {
    const [raw, legacyKind] = await Promise.all([
      this.ctx.storage.get<unknown>(PROVIDER_CONFIGURATION_KEY),
      this.ctx.storage.get<unknown>(PROVIDER_KIND_KEY),
    ]);
    const legacy =
      legacyKind === undefined
        ? undefined
        : sandboxProviderConfigurationSchema.parse({ provider: legacyKind });
    if (raw === undefined) return legacy;
    const configuration = sandboxProviderConfigurationSchema.parse(raw);
    if (legacy && legacy.provider !== configuration.provider) {
      throw new Error('Sandbox provider mismatch');
    }
    return configuration;
  }

  private async pinProvider(
    requested?: SandboxProviderBinding | AgentSandboxProvider,
    allocation?: { resources?: VercelSandboxResources; instance?: CloudflareContainersInstance }
  ): Promise<SandboxProviderBinding> {
    const requestedBinding =
      requested === undefined
        ? undefined
        : typeof requested === 'string'
          ? bindingFromLegacyProvider(requested)
          : requested;
    const committed = await this.ctx.storage.transaction(async () => {
      const stored = await this.readProviderConfiguration();
      const storedRaw = await this.ctx.storage.get<unknown>(PROVIDER_BINDING_KEY);
      const storedBinding =
        storedRaw === undefined ? undefined : SandboxProviderBindingSchema.parse(storedRaw);
      const resources =
        allocation !== undefined
          ? allocation.resources
          : stored?.provider === 'vercel'
            ? stored.resources
            : undefined;
      const instance =
        allocation?.instance ??
        (stored?.provider === 'cloudflare-containers' ? stored.instance : undefined);
      const binding =
        requestedBinding ??
        storedBinding ??
        bindingFromLegacyProvider(stored?.provider ?? 'cloudflare');
      const provider = binding.kind;
      if (stored && stored.provider !== provider) {
        throw new Error('Sandbox provider mismatch');
      }
      if (storedBinding && !sameSandboxProviderBinding(storedBinding, binding)) {
        throw new Error('Sandbox provider binding mismatch');
      }
      const next = sandboxProviderConfigurationSchema.parse({
        provider,
        ...(resources === undefined ? {} : { resources }),
        ...(instance === undefined ? {} : { instance }),
      });
      if (
        stored?.provider === 'vercel' &&
        next.provider === 'vercel' &&
        (stored.resources?.vcpus !== next.resources?.vcpus ||
          stored.resources?.memory !== next.resources?.memory)
      ) {
        throw new Error('Sandbox resources mismatch');
      }
      if (
        stored?.provider === 'cloudflare-containers' &&
        next.provider === 'cloudflare-containers' &&
        next.instance !== undefined &&
        stored.instance !== next.instance
      ) {
        throw new Error('Sandbox instance mismatch');
      }
      const isByoc = binding.kind === 'vercel' && binding.source.kind === 'byoc';
      if (
        !isByoc &&
        next.provider === 'vercel' &&
        parseVercelSandboxRuntimeConfig(this.env) === undefined
      ) {
        throw new Error('Vercel sandbox runtime configuration is unavailable');
      }
      await this.ctx.storage.put({
        [PROVIDER_KIND_KEY]: next.provider,
        [PROVIDER_CONFIGURATION_KEY]: next,
        [PROVIDER_BINDING_KEY]: binding,
      });
      return { next, binding };
    });
    this.providerBinding = committed.binding;
    this.vercelResources =
      committed.next.provider === 'vercel' ? committed.next.resources : undefined;
    this.containersInstance =
      committed.next.provider === 'cloudflare-containers' ? committed.next.instance : undefined;
    if (!this.isByocBinding()) {
      this.provider = this.createProviderAdapter(
        committed.next.provider,
        await this.readCanonicalAllocation()
      );
    }
    return committed.binding;
  }

  private async billingInput(
    ownerId: string,
    supplied?: SandboxBillingInput,
    worktreeId?: string
  ): Promise<SandboxBillingInput | undefined> {
    if (isManagedContainerBillingExempt(this.providerBinding)) return undefined;
    const raw = await this.ctx.storage.get<unknown>(BILLING_INPUT_KEY);
    const stored = raw === undefined ? undefined : parseSandboxBillingInput(raw);
    let input = supplied === undefined ? stored : parseSandboxBillingInput(supplied);
    if (input?.sessionId !== undefined && worktreeId) {
      input = { ...input, sessionId: `workspace_${worktreeId.slice('worktree_'.length)}` };
    }
    const enforced = isCloudAgentContainerBillingEnabled(this.env, {
      userId: ownerId,
      ...(input?.subject.type === 'org' ? { orgId: input.subject.id } : {}),
    });
    if (!input) {
      if (enforced) throw new Error('Sandbox billing attribution is required');
      return undefined;
    }
    if (
      input.sandboxId !== this.sandboxId ||
      (input.subject.type === 'user' && input.subject.id !== ownerId) ||
      (input.actor.type === 'user' && input.actor.id !== ownerId)
    ) {
      throw new Error('Sandbox billing owner mismatch');
    }
    if (
      stored &&
      (stored.subject.type !== input.subject.type ||
        stored.subject.id !== input.subject.id ||
        stored.actor.type !== input.actor.type ||
        stored.actor.id !== input.actor.id ||
        stored.sessionId !== input.sessionId)
    ) {
      throw new Error('Sandbox billing allocation mismatch');
    }
    const billing = {
      ...input,
      enforcementRequested: input.enforcementRequested === true || enforced,
    };
    await this.ctx.storage.put(BILLING_INPUT_KEY, billing);
    return billing;
  }

  private async wrapperLaunchEnv(
    credential: string,
    allocationId: string
  ): Promise<Record<string, string>> {
    const signingSecret = await withTimeout(
      resolveSecret(this.env.NEXTAUTH_SECRET),
      1_000,
      'Diagnostic signing secret lookup timed out'
    ).catch(() => null);
    const launchEnv = buildControlWrapperLaunchEnv({
      workerUrl: this.env.WORKER_URL,
      sandboxId: this.sandboxId,
      credential,
      diagnostics: { allocationId, signingSecret },
    });
    this.logDiagnostic('wrapper_log_upload', {
      allocationId,
      configured: Boolean(launchEnv.CONTROL_LOG_UPLOAD_GRANT),
      wrapperInstanceId: launchEnv.CONTROL_WRAPPER_INSTANCE_ID,
    });
    return launchEnv;
  }

  /**
   * Infrastructure deadlines the canonical allocation machine does not own:
   * the provisional-socket handshake window and the credential expiry anchor.
   * Every allocation-owned deadline is handled by the canonical `DEADLINE`
   * dispatch in `driveCanonicalDeadline`.
   */
  private async handleInfrastructureDeadline(id: ControlAlarmAnchorId): Promise<void> {
    if (id === 'socketHandshake') {
      this.socketHandler.closeProvisionalSockets();
      return;
    }
    if (id === 'byocSnapshotRecovery') {
      await this.retryByocSnapshotRecovery();
      return;
    }
    if (id === 'hardStop') {
      const record = await this.readCanonicalAllocation();
      const hardStopAt =
        record.state.kind === 'creating' ||
        record.state.kind === 'allocated' ||
        record.state.kind === 'stopping'
          ? record.state.target.onprem?.hardStopAt
          : undefined;
      if (
        this.providerBinding.kind === 'onprem' &&
        record.state.kind === 'allocated' &&
        hardStopAt !== undefined &&
        hardStopAt <= Date.now()
      ) {
        await this.ctx.storage.put(FAILURE_REASON_KEY, 'onprem_lifetime_exhausted');
        await this.beginCanonicalStop(record, 'onprem_lifetime_exhausted');
      }
      return;
    }
    if (id === 'credentialExpiry') {
      try {
        await this.enforceWorktreeNetworkPolicy(await this.requireOwner());
      } catch {
        await this.armInfrastructureAnchor(
          'credentialExpiry',
          Date.now() + DEADLINE_MS.reconciliation
        );
      }
    }
  }

  private async validateHandshake(providerInstanceId: string): Promise<boolean> {
    const record = await this.readCanonicalAllocation();
    const state = record.state;
    if (state.kind !== 'creating' && state.kind !== 'allocated') return false;
    if (
      (this.providerKind === 'vercel' || this.providerBinding.kind === 'onprem') &&
      state.kind !== 'allocated'
    ) {
      return false;
    }
    return (
      this.matchesCanonicalProviderReference(state, providerInstanceId) &&
      this.matchesCanonicalWorktreeContainment(record)
    );
  }

  private async onHandshakeComplete(
    identity: SandboxControlConnectionIdentity,
    runtime?: Pick<SandboxRuntimeMetadata, 'wrapperVersion'>
  ): Promise<void> {
    const socketConnection = this.socketHandler.getConnectionIdentity();
    if (!socketConnection || !this.sameConnection(socketConnection, identity)) return;

    const record = await this.readCanonicalAllocation();
    const state = record.state;
    if (
      (state.kind !== 'creating' && state.kind !== 'allocated') ||
      ((this.providerKind === 'vercel' || this.providerBinding.kind === 'onprem') &&
        state.kind !== 'allocated') ||
      !this.matchesCanonicalProviderReference(state, identity.providerInstanceId) ||
      !this.matchesCanonicalWorktreeContainment(record)
    ) {
      this.socketHandler.closeAll('Sandbox runtime unavailable');
      return;
    }
    const previous = this.activeConnection;
    const sameRuntime =
      previous?.recoveryCapable === true &&
      identity.recoveryCapable === true &&
      this.sameWrapperRuntime(previous, identity);
    if (previous && !this.sameConnection(previous, identity) && !sameRuntime) {
      await this.beginCanonicalStop(record, 'control_replaced');
      return;
    }
    const now = Date.now();
    const activated = await this.ctx.storage.transaction(async () => {
      const [current, storedRuntime] = await Promise.all([
        this.readCanonicalAllocation(),
        loadRuntimeMetadata(this.ctx.storage),
      ]);
      const connection = this.socketHandler.getConnectionIdentity();
      const currentState = current.state;
      if (
        !connection ||
        !this.sameConnection(connection, identity) ||
        !sameCanonicalAllocation(current, record) ||
        (currentState.kind !== 'creating' && currentState.kind !== 'allocated') ||
        !this.matchesCanonicalProviderReference(currentState, identity.providerInstanceId)
      )
        return false;
      await saveRuntimeMetadata(this.ctx.storage, {
        ...(storedRuntime ?? initialRuntimeMetadata(this.sandboxId)),
        wrapperVersion: safeSandboxRuntimeVersion(runtime?.wrapperVersion),
        kiloCliVersion: null,
      });
      await this.ctx.storage.put(ACTIVE_WRAPPER_RUNTIME_KEY, identity);
      await this.ctx.storage.delete([WRAPPER_READY_AT_KEY, WRAPPER_HEARTBEAT_OBSERVATION_KEY]);
      await this.appendLog(connectionTransition(now, 'disconnected', 'connected', 'hello'));
      return true;
    });
    if (!activated) return;
    this.activeConnection = identity;
    this.readyConnectionId = null;
    this.kiloReady = false;
    this.logDiagnostic('handshake_committed', diagnosticConnection(identity));
    this.socketHandler.closeProvisionalSockets();
    await this.cancelInfrastructureAnchor('socketHandshake');
    await this.observeHealth({
      kind: 'handshake',
      incarnation: identity.providerInstanceId,
      at: now,
      ...(identity.wrapperInstanceId !== undefined
        ? { expectedWrapperInstanceId: identity.wrapperInstanceId }
        : {}),
    });
  }

  private async onWrapperReady(identity: SandboxControlConnectionIdentity): Promise<void> {
    if (!this.isCurrentConnection(identity)) return;
    const now = Date.now();
    const committed = await this.ctx.storage.transaction(async () => {
      const connection = this.socketHandler.getConnectionIdentity();
      if (!connection || !this.sameConnection(connection, identity)) return false;
      await this.ctx.storage.put({
        [ACTIVE_WRAPPER_RUNTIME_KEY]: {
          ...identity,
          readyConnectionId: identity.connectionId,
        } satisfies PersistedWrapperRuntime,
        [WRAPPER_READY_AT_KEY]: now,
        [WRAPPER_HEARTBEAT_OBSERVATION_KEY]: {
          connectionId: identity.connectionId,
          ...(identity.wrapperInstanceId ? { wrapperInstanceId: identity.wrapperInstanceId } : {}),
          armedAt: now,
          armedExpiryAt: now + DEADLINE_MS.heartbeatExpiry,
          armedBasis: 'wrapper_ready',
        } satisfies WrapperHeartbeatObservation,
      });
      await this.appendLog(connectionTransition(now, 'connected', 'ready', 'sandbox.ready'));
      return true;
    });
    if (!committed) return;
    this.activateWrapperReady(identity);
    await this.observeHealth({
      kind: 'ready',
      incarnation: identity.providerInstanceId,
      at: now,
      ...(identity.wrapperInstanceId !== undefined
        ? { expectedWrapperInstanceId: identity.wrapperInstanceId }
        : {}),
    });
    await this.armCanonicalIdle(now + DEADLINE_MS.idleStop);
  }

  private activateWrapperReady(identity: SandboxControlConnectionIdentity): void {
    if (!this.isCurrentConnection(identity)) return;
    const now = Date.now();
    this.readyConnectionId = identity.connectionId;
    this.kiloReady = true;
    this.logDiagnostic('wrapper_ready', {
      ...diagnosticConnection(identity),
      heartbeatDeadlineAt: now + DEADLINE_MS.heartbeatExpiry,
    });
  }

  private async onHeartbeat(
    payload: SandboxHeartbeatPayload,
    identity: SandboxControlConnectionIdentity
  ): Promise<void> {
    const diagnostic = {
      ...diagnosticConnection(identity),
      reportedState: payload.state,
      kiloReady: payload.kilo.ready,
      reportedSessions: payload.sessions.length,
      pendingMessages: payload.pendingMessages,
      activeKiloSessions: payload.activeKiloSessions,
      ...(await this.heartbeatSessionFields(payload.sessions)),
      ...this.sessionForwarding.stats(),
    };
    if (!this.isCurrentConnection(identity)) {
      // Log-only: a stale connection must not overwrite the armed connection's
      // accept/arm history.
      this.logDiagnostic('heartbeat', { ...diagnostic, decision: 'stale_connection' });
      return;
    }
    if (!payload.kilo.ready) {
      const now = Date.now();
      const stored = await this.readHeartbeatObservationBestEffort();
      this.logDiagnostic(
        'heartbeat',
        {
          ...diagnostic,
          decision: 'kilo_unhealthy',
          reason: payload.kilo.reason ?? 'unknown',
          ...this.heartbeatLogFields(stored, identity.connectionId),
          lastReceivedHeartbeatAt: now,
        },
        'warn'
      );
      await this.overlayHeartbeatObservation(identity, 'kilo_unhealthy', now);
      await this.observeHealth({
        kind: 'heartbeat',
        incarnation: identity.providerInstanceId,
        at: now,
        ready: false,
        ...(identity.wrapperInstanceId !== undefined
          ? { expectedWrapperInstanceId: identity.wrapperInstanceId }
          : {}),
      });
      return;
    }
    if (!this.readyWrapperRuntime() && !identity.recoveryCapable) {
      const now = Date.now();
      const stored = await this.readHeartbeatObservationBestEffort();
      this.logDiagnostic('heartbeat', {
        ...diagnostic,
        decision: 'runtime_not_ready',
        ...this.heartbeatLogFields(stored, identity.connectionId),
        lastReceivedHeartbeatAt: now,
      });
      await this.overlayHeartbeatObservation(identity, 'runtime_not_ready', now);
      return;
    }

    const now = Date.now();
    const applied = await this.ctx.storage
      .transaction(async () => {
        const current = await this.readCanonicalAllocation();
        const table = await loadRouteTable(this.ctx.storage);
        if (
          !this.isCurrentConnection(identity) ||
          current.state.kind !== 'allocated' ||
          current.state.target.providerRef !== identity.providerInstanceId
        )
          return undefined;
        if (payload.kilo.version !== undefined) {
          const runtime =
            (await loadRuntimeMetadata(this.ctx.storage)) ?? initialRuntimeMetadata(this.sandboxId);
          const kiloCliVersion = safeSandboxRuntimeVersion(payload.kilo.version);
          if (!this.isCurrentConnection(identity)) return undefined;
          if (runtime.kiloCliVersion !== kiloCliVersion) {
            await saveRuntimeMetadata(this.ctx.storage, { ...runtime, kiloCliVersion });
          }
        }
        const reported = new Map(payload.sessions.map(session => [session.kiloSessionId, session]));
        let missingRoutes = 0;
        let activeRoutes = 0;
        let finalizingRoutes = 0;
        let inputWaitingRoutes = 0;
        for (const route of table.values()) {
          const report = reported.get(route.kiloSessionId) ?? {
            state: 'idle' as const,
            idleForMs: 0,
          };
          if (!reported.has(route.kiloSessionId)) missingRoutes++;
          if (report.state === 'active') activeRoutes++;
          if (report.state === 'finalizing') finalizingRoutes++;
          if ('waitingOn' in report && report.waitingOn === 'input') inputWaitingRoutes++;
          const previousState = route.lastState;
          const applied = applyReportedSessionState(table, route.kiloSessionId, report, now);
          if (applied.changed) {
            await this.appendLog(
              sessionStateTransition(now, route.kiloSessionId, previousState, report.state)
            );
          }
        }
        await saveRouteTable(this.ctx.storage, table);
        await this.ctx.storage.put(WRAPPER_HEARTBEAT_OBSERVATION_KEY, {
          connectionId: identity.connectionId,
          ...(identity.wrapperInstanceId ? { wrapperInstanceId: identity.wrapperInstanceId } : {}),
          lastReceivedAt: now,
          lastAcceptedAt: now,
          armedAt: now,
          armedExpiryAt: now + DEADLINE_MS.heartbeatExpiry,
          armedBasis: 'heartbeat_receipt',
          lastDecision: 'accepted',
        } satisfies WrapperHeartbeatObservation);
        return {
          routeCount: table.size,
          missingRoutes,
          activeRoutes,
          finalizingRoutes,
          inputWaitingRoutes,
          pinned: hasEnvironmentPinningWork(table, payload),
          idleAt: current.state.idleAt,
        };
      })
      .catch(error => {
        this.logDiagnostic('heartbeat', { ...diagnostic, decision: 'apply_failed' }, 'warn');
        throw error;
      });
    this.logDiagnostic('heartbeat', {
      ...diagnostic,
      ...applied,
      decision: applied ? 'accepted' : 'stale_during_apply',
    });
    if (applied) {
      await this.observeHealth({
        kind: 'heartbeat',
        incarnation: identity.providerInstanceId,
        at: now,
        ready: true,
        ...(identity.wrapperInstanceId !== undefined
          ? { expectedWrapperInstanceId: identity.wrapperInstanceId }
          : {}),
      });
      // The idle anchor is armed once when pinning work stops and cleared when
      // pinning work resumes; a heartbeat never resets an armed anchor.
      if (!applied.pinned && applied.idleAt === null) {
        const decision = await this.allocationOrchestrator.dispatch({
          type: 'IDLE',
          idleAt: now + DEADLINE_MS.idleStop,
        });
        if (decision !== undefined) await this.allocationOrchestrator.run(decision.commands);
      } else if (applied.pinned && applied.idleAt !== null) {
        const record = await this.readCanonicalAllocation();
        if (record.state.kind === 'allocated') {
          const decision = await this.allocationOrchestrator.dispatch({
            type: 'DEMAND',
            requestId: crypto.randomUUID(),
            target: record.state.target,
            createIntent: record.state.createIntent,
          });
          if (decision !== undefined) await this.allocationOrchestrator.run(decision.commands);
        }
      }
      await this.scheduleAlarm();
    }
    await this.renewProviderLease(identity);
  }

  /**
   * Confirm the on-prem installation still owns the allocation and has
   * acknowledged it. The installation runner reports observation asynchronously,
   * so a lease renewal before the first acknowledgement is expected to be
   * pending; the wait is bounded by the acknowledgement deadline, then by
   * `DEADLINE_MS.startup` past the create intent, so a runner that never
   * acknowledges cannot keep the allocation alive forever.
   */
  private async verifyOnPremLifetime(
    record: AllocationRecord,
    deadlineAt: number,
    identity: SandboxControlConnectionIdentity
  ): Promise<void> {
    const binding = this.providerBinding;
    if (
      binding.kind !== 'onprem' ||
      record.state.kind !== 'allocated' ||
      record.state.target.providerRef === null ||
      record.state.target.onprem === undefined
    ) {
      throw new Error('On-prem lifetime requires a registered allocation');
    }
    const providerRef = record.state.target.providerRef;
    const intent = parseOnPremCreateIntent(
      {
        intentId: record.state.createIntent.intentId,
        createdAt: record.state.createIntent.createdAt,
        ...(record.state.target.allocationName === undefined
          ? {}
          : { allocationName: record.state.target.allocationName }),
        ...(record.state.target.containment === undefined
          ? {}
          : { containment: record.state.target.containment }),
        onprem: record.state.target.onprem,
      },
      binding
    );
    const provider = await this.providerFor(record.state.target);
    let verificationDeadline = deadlineAt;
    const readAcknowledgement = async () => {
      const stored = onPremAcknowledgementSchema
        .optional()
        .parse(await this.ctx.storage.get(ONPREM_ACKNOWLEDGEMENT_KEY));
      return stored?.providerRef === providerRef ? stored : undefined;
    };
    const assertCurrent = async () => {
      const current = await this.readCanonicalAllocation();
      const currentState = current.state;
      if (Date.now() >= verificationDeadline) {
        throw new Error('On-prem lifetime verification timed out');
      }
      if (
        currentState.kind !== 'allocated' ||
        currentState.target.providerRef !== providerRef ||
        !sameCanonicalAllocation(current, record) ||
        !sameSandboxProviderBinding(this.providerBinding, binding) ||
        !this.matchesCanonicalProviderReference(currentState, providerRef) ||
        !this.isCurrentConnection(identity)
      ) {
        throw new Error('On-prem allocation changed during lifetime verification');
      }
    };
    while (true) {
      const acknowledgement = await this.ctx.storage.transaction(async () => {
        await assertCurrent();
        const current = await readAcknowledgement();
        if (current?.state === 'acknowledged') return current;
        const waiting: z.infer<typeof onPremAcknowledgementSchema> = {
          state: 'waiting',
          providerRef,
          deadlineAt: Math.min(
            verificationDeadline,
            intent.createdAt + DEADLINE_MS.startup,
            current?.deadlineAt ?? Infinity
          ),
        };
        if (current?.deadlineAt !== waiting.deadlineAt) {
          await this.ctx.storage.put(ONPREM_ACKNOWLEDGEMENT_KEY, waiting);
        }
        return waiting;
      });
      if (acknowledgement.state === 'waiting') {
        verificationDeadline = Math.min(verificationDeadline, acknowledgement.deadlineAt);
      }
      await assertCurrent();
      try {
        await withTimeout(
          provider.ensureLeaseAtLeast(providerRef, leaseAtLeastMs()),
          Math.max(1, verificationDeadline - Date.now()),
          'On-prem lifetime verification timed out'
        );
        await this.ctx.storage.transaction(async () => {
          const current = await readAcknowledgement();
          if (current?.state === 'waiting') {
            verificationDeadline = Math.min(verificationDeadline, current.deadlineAt);
          }
          await assertCurrent();
          await this.ctx.storage.put(ONPREM_ACKNOWLEDGEMENT_KEY, {
            state: 'acknowledged',
            providerRef,
          });
        });
        return;
      } catch (error) {
        if (
          !(error instanceof OnPremAcknowledgementPendingError) ||
          acknowledgement.state === 'acknowledged'
        ) {
          throw error;
        }
        await assertCurrent();
        await new Promise<void>(resolve =>
          setTimeout(resolve, Math.min(1_000, verificationDeadline - Date.now()))
        );
      }
    }
  }

  private async renewProviderLease(identity: SandboxControlConnectionIdentity): Promise<void> {
    const record = await this.readCanonicalAllocation();
    const state = record.state;
    const diagnostic = {
      ...diagnosticConnection(identity),
      allocationId: state.kind === 'stopped' ? undefined : state.createIntent?.intentId,
      physicalState: legacyPhysicalState(record),
      hasTombstone: state.kind === 'stopping' || state.kind === 'unknown',
      requestedLeaseMs: leaseAtLeastMs(),
    };
    if (
      !this.isCurrentConnection(identity) ||
      !this.readyWrapperRuntime() ||
      state.kind !== 'allocated' ||
      state.health.kind !== 'healthy' ||
      state.target.providerRef === null
    ) {
      this.logDiagnostic('lease', { ...diagnostic, result: 'skipped_authority' });
      return;
    }
    const providerRef = state.target.providerRef;
    if (this.providerBinding.kind === 'vercel') {
      const nextLeaseCheckAt = await this.ctx.storage.get<number>(NEXT_LEASE_CHECK_AT_KEY);
      if (nextLeaseCheckAt !== undefined && nextLeaseCheckAt > Date.now()) return;
    }
    const startedAt = Date.now();
    let timedOut = false;
    this.logDiagnostic('lease', { ...diagnostic, result: 'started' });
    try {
      if (this.providerBinding.kind === 'onprem') {
        await this.verifyOnPremLifetime(record, Date.now() + DEADLINE_MS.stopAttempt, identity);
      } else {
        await withTimeout(
          (await this.providerFor(state.target)).ensureLeaseAtLeast(providerRef, leaseAtLeastMs()),
          DEADLINE_MS.stopAttempt,
          'Sandbox lease renewal timed out',
          () => {
            timedOut = true;
          }
        );
      }
      this.logDiagnostic('lease', {
        ...diagnostic,
        result: 'completed',
        durationMs: Date.now() - startedAt,
      });
      await this.scheduleNextLeaseCheck('renewal', Date.now());
    } catch (error) {
      this.logDiagnostic(
        'lease',
        {
          ...diagnostic,
          result: timedOut ? 'timed_out' : 'failed',
          durationMs: Date.now() - startedAt,
        },
        'warn'
      );
      if (this.providerBinding.kind === 'onprem') {
        // Fenced to the allocation and connection that were verified: a stale
        // acknowledgement failure must not stop a replacement allocation.
        await this.stopVerifiedCanonicalAllocation({
          record,
          reason: providerFailureReason(this.providerBinding, error) ?? 'onprem_unavailable',
          identity,
        });
      }
    }
  }

  /**
   * The next time a Vercel lease renewal is worth attempting. Renewals extend
   * the lease by a fixed window, so re-checking before the current window is
   * close to expiring only burns provider calls. Non-Vercel providers have no
   * lease and no check.
   */
  private async scheduleNextLeaseCheck(phase: 'initial' | 'renewal', now: number): Promise<void> {
    if (this.providerBinding.kind !== 'vercel') return;
    const defaults = parseVercelSandboxRuntimeDefaults(this.env);
    if (!defaults) return;
    const minimumLeaseMs = leaseAtLeastMs();
    const delay =
      phase === 'initial'
        ? Math.max(0, defaults.initialTimeoutMs - minimumLeaseMs)
        : Math.min(
            Math.max(0, defaults.extendDurationMs - minimumLeaseMs),
            minimumLeaseMs - DEADLINE_MS.idleStopLeaseMargin
          );
    await this.ctx.storage.put(NEXT_LEASE_CHECK_AT_KEY, now + delay);
  }

  private async onSessionEvent(
    identity: SessionEventIdentity | undefined,
    payload: SessionEventPayload,
    connection: SandboxControlConnectionIdentity,
    receiptId?: string,
    sequence?: number
  ): Promise<SandboxControlEventResult> {
    const diagnostic = {
      ...diagnosticConnection(connection),
      eventType: diagnosticEventType(payload.type),
    };
    if (!this.isCurrentConnection(connection)) {
      this.recordForwardDrop('stale_before_enqueue', diagnostic);
      return { applied: false };
    }
    if (!identity) {
      this.recordForwardDrop('missing_identity', diagnostic);
      return { applied: false };
    }
    const forwarded = this.forwardRoutedSessionFrame(
      identity,
      payload.type,
      'receiveSandboxControlEvent',
      connection,
      { identity, payload, ...(receiptId ? { receiptId, sequence } : {}) },
      1,
      (route, fields, allocation) =>
        this.forwardSessionFrame(
          route,
          allocation,
          connection,
          fields,
          'receiveSandboxControlEvent',
          stub =>
            stub.receiveSandboxControlEvent({
              identity,
              payload,
              wrapperInstanceId: connection.wrapperInstanceId,
              ...(receiptId ? { receiptId, sequence } : {}),
            }),
          receiptId !== undefined
        )
    );
    if (!receiptId) {
      this.ctx.waitUntil(forwarded.then(() => undefined));
      return { applied: true };
    }
    return forwarded;
  }

  private async onSessionPreparing(
    identity: SessionEventIdentity | undefined,
    payload: SessionPreparingPayload,
    connection: SandboxControlConnectionIdentity,
    receiptId?: string,
    sequence?: number
  ): Promise<SandboxControlEventResult> {
    const diagnostic = {
      ...diagnosticConnection(connection),
      eventType: 'session.preparing',
    };
    if (!this.isCurrentConnection(connection)) {
      this.recordForwardDrop('stale_before_enqueue', diagnostic);
      return { applied: false };
    }
    if (!identity) {
      this.recordForwardDrop('missing_identity', diagnostic);
      return { applied: false };
    }
    const forwarded = this.forwardRoutedSessionFrame(
      identity,
      'session.preparing',
      'receiveSandboxControlPreparing',
      connection,
      { identity, payload, ...(receiptId ? { receiptId, sequence } : {}) },
      1,
      (route, fields, allocation) =>
        this.forwardSessionFrame(
          route,
          allocation,
          connection,
          fields,
          'receiveSandboxControlPreparing',
          stub =>
            stub.receiveSandboxControlPreparing({
              identity,
              payload,
              wrapperInstanceId: connection.wrapperInstanceId,
              ...(receiptId ? { receiptId, sequence } : {}),
            }),
          receiptId !== undefined
        )
    );
    if (!receiptId) {
      this.ctx.waitUntil(forwarded.then(() => undefined));
      return { applied: true };
    }
    return forwarded;
  }

  private async onSessionEventBatch(
    payload: SandboxEventBatchPayload,
    connection: SandboxControlConnectionIdentity
  ): Promise<SandboxEventBatchResult> {
    const diagnostic = {
      ...diagnosticConnection(connection),
      eventType: 'session.event.batch',
    };
    if (!this.isCurrentConnection(connection)) {
      this.recordForwardDrop('stale_before_enqueue', diagnostic);
      return batchOutcomes(payload, 'unattempted', true);
    }
    const identity = payload.items[0]?.session;
    if (
      !identity ||
      !payload.items.every(item => sameSessionEventIdentity(item.session, identity))
    ) {
      return batchOutcomes(payload, 'rejected', false);
    }
    if (!connection.wrapperInstanceId) {
      this.recordForwardDrop('missing_wrapper_identity', diagnostic);
      return batchOutcomes(payload, 'rejected', false);
    }
    return this.forwardRoutedSessionBatch(identity, connection, payload);
  }

  private async onOperationResult(
    session: SessionRequestIdentity,
    delivery: SessionOperationDelivery,
    identity: SandboxControlConnectionIdentity
  ): Promise<SessionOperationAck | undefined> {
    const connection = this.socketHandler.getConnectionIdentity();
    if (!connection || connection.connectionId !== identity.connectionId) return undefined;
    const authorization = delivery.authorization;
    if (
      !identity.wrapperInstanceId ||
      authorization.wrapperInstanceId !== identity.wrapperInstanceId ||
      session.sessionId !== authorization.session.sessionId ||
      session.kiloSessionId !== authorization.session.kiloSessionId ||
      session.directory !== authorization.session.directory
    )
      return undefined;
    const deadlineAt = sessionOperationExpiresAt(authorization);
    const current = () => this.isCurrentConnection(connection) && Date.now() < deadlineAt;
    if (!current()) return undefined;
    const [table, allocation, ownerId] = await Promise.all([
      loadRouteTable(this.ctx.storage),
      this.readCanonicalAllocation(),
      this.readOwner(),
    ]);
    const route = getRouteBySessionId(table, session.sessionId);
    if (
      !route ||
      route.ownerId !== ownerId ||
      route.kiloSessionId !== session.kiloSessionId ||
      route.directory !== session.directory ||
      this.runtimeDeleted ||
      this.exclusiveDeletionWorktreeId !== undefined ||
      (route.worktreeId !== undefined && this.deletingWorktrees.has(route.worktreeId)) ||
      !current()
    )
      throw new SandboxControlConnectionError('Operation result route is not current', false);
    if (
      allocation.state.kind === 'stopped' ||
      canonicalProviderRefOf(allocation) !== connection.providerInstanceId ||
      !this.matchesCanonicalWorktreeContainment(allocation) ||
      !current()
    )
      throw new SandboxControlConnectionError('Operation result runtime is not current', false);
    let frameBytes: number;
    try {
      frameBytes = sessionForwardFrameBytes({ session, delivery });
    } catch {
      throw new SandboxControlConnectionError('Operation result cannot be serialized', false);
    }
    const diagnostic = {
      ...diagnosticConnection(connection),
      eventType: diagnosticEventType('session.operation.result'),
    };
    const queuedAt = Date.now();
    this.forwardSequence++;
    const fields = {
      ...diagnostic,
      sessionId: route.sessionId,
      forwardSequence: this.forwardSequence,
      frameBytes,
      frameItems: 1,
      queuedAt,
    };
    const rejectionFields = { ...fields, operation: 'receiveSandboxOperationResult' };
    const forwardDeadlineAt = Math.min(deadlineAt, Date.now() + DEADLINE_MS.stopAttempt);
    const next = this.sessionForwarding.enqueue<undefined, SessionOperationAck>({
      sessionId: route.sessionId,
      identity: null,
      bytes: frameBytes,
      items: 1,
      item: undefined,
      run: async members => {
        const rpcStartedAt = Date.now();
        const queueWaitMs = rpcStartedAt - queuedAt;
        const sessionAdmissionDepth = members[0]?.admissionDepth ?? 0;
        let attempts = 0;
        let succeeded = false;
        try {
          if (!current())
            throw new SandboxControlConnectionError('Operation result expired', false);
          const wrapperInstanceId = identity.wrapperInstanceId;
          if (!wrapperInstanceId)
            throw new SandboxControlConnectionError(
              'Operation result wrapper is not current',
              false
            );
          const assertCurrent = async () => {
            if (!current() || Date.now() >= forwardDeadlineAt)
              throw new SandboxControlConnectionError('Operation result forwarding expired', false);
            const [routes, nextAllocation] = await Promise.all([
              loadRouteTable(this.ctx.storage),
              this.readCanonicalAllocation(),
            ]);
            const nextRoute = routes.get(route.sessionId);
            if (
              !current() ||
              !nextRoute ||
              nextRoute.ownerId !== route.ownerId ||
              nextRoute.kiloSessionId !== session.kiloSessionId ||
              nextRoute.directory !== session.directory ||
              nextRoute.worktreeId !== route.worktreeId ||
              Date.now() >= forwardDeadlineAt ||
              !sameCanonicalAllocation(nextAllocation, allocation) ||
              nextAllocation.state.kind === 'stopped' ||
              canonicalProviderRefOf(nextAllocation) !== connection.providerInstanceId ||
              !this.matchesCanonicalWorktreeContainment(nextAllocation) ||
              this.runtimeDeleted ||
              this.exclusiveDeletionWorktreeId !== undefined ||
              (nextRoute.worktreeId !== undefined &&
                this.deletingWorktrees.has(nextRoute.worktreeId)) ||
              !current()
            )
              throw new SandboxControlConnectionError('Operation result fence changed', false);
          };
          const ack = await withDORetry(
            () => getSandboxSessionStub(this.env, route.ownerId, route.sessionId),
            async stub => {
              await assertCurrent();
              attempts++;
              const result = await stub.receiveSandboxOperationResult({
                session,
                wrapperInstanceId,
                delivery,
              });
              await assertCurrent();
              if (!result)
                throw new SandboxControlConnectionError('Operation result was not acknowledged');
              return result;
            },
            'receiveSandboxOperationResult',
            {
              ...DEFAULT_DO_RETRY_CONFIG,
              scope: {
                deadlineAt: forwardDeadlineAt,
                assertCurrent: () => {
                  if (!current())
                    throw new SandboxControlConnectionError(
                      'Operation result forwarding expired',
                      false
                    );
                },
              },
            }
          );
          if (!current())
            throw new SandboxControlConnectionError('Operation result expired', false);
          const parsed = sessionOperationAckSchema.safeParse(ack);
          if (!parsed.success)
            throw new SandboxControlConnectionError(
              'Operation result acknowledgement is invalid',
              false
            );
          succeeded = true;
          return [parsed.data];
        } catch (error) {
          throw error instanceof SandboxControlConnectionError
            ? error
            : error instanceof SessionForwardingError
              ? new SandboxControlConnectionError(error.message, error.retryable)
              : new SandboxControlConnectionError('Operation result forwarding failed');
        } finally {
          this.logForwardRun(
            {
              sessionId: route.sessionId,
              operation: 'receiveSandboxOperationResult',
              eventType: diagnostic.eventType,
              runMembers: 1,
              sentItems: 1,
              sentBytes: frameBytes,
              frameBytes,
              queueWaitMs,
              sessionAdmissionDepth,
              attempts,
              result: succeeded ? 'delivered' : 'failed',
              rpcWaitMs: Date.now() - rpcStartedAt,
              appliedCount: succeeded ? 1 : 0,
              rejectedCount: 0,
              unknownCount: !succeeded && attempts > 0 ? 1 : 0,
              unattemptedCount: !succeeded && attempts === 0 ? 1 : 0,
            },
            succeeded ? undefined : 'warn'
          );
        }
      },
    });
    this.ctx.waitUntil(next.catch(error => this.recordForwardRejection(error, rejectionFields)));
    const delivered = next.catch(error => {
      throw error instanceof SessionForwardingError
        ? new SandboxControlConnectionError(error.message, error.retryable)
        : error;
    });
    this.ctx.waitUntil(delivered.catch(() => undefined));
    return delivered;
  }

  private resolveForwardingAdmission(
    identity: SessionEventIdentity
  ): { sessionId: string; nativeRuntimeId?: string } | undefined {
    const route = resolveSessionEventRoute(loadRouteTableSync(this.ctx.storage.kv), identity);
    if (!route) return undefined;
    return {
      sessionId: route.sessionId,
      ...(route.nativeRuntimeId !== undefined ? { nativeRuntimeId: route.nativeRuntimeId } : {}),
    };
  }

  private resolveForwardEligibility(
    identity: SessionEventIdentity,
    connection: SandboxControlConnectionIdentity,
    admission: { sessionId: string; nativeRuntimeId?: string }
  ):
    | { ok: true; route: SessionRoute; allocation: AllocationRecord }
    | { ok: false; reason: string; fields: ControlDiagnosticFields; retryable: boolean } {
    const table = loadRouteTableSync(this.ctx.storage.kv);
    if (!this.isCurrentConnection(connection))
      return { ok: false, reason: 'stale_before_enqueue', fields: {}, retryable: false };
    const route = resolveSessionEventRoute(table, identity);
    if (!route)
      return {
        ok: false,
        reason: 'unroutable',
        fields: { routeCount: table.size },
        retryable: false,
      };
    if (route.sessionId !== admission.sessionId)
      return {
        ok: false,
        reason: 'admission_route_changed',
        fields: { sessionId: route.sessionId, admittedSessionId: admission.sessionId },
        retryable: false,
      };
    if (
      admission.nativeRuntimeId !== undefined &&
      route.nativeRuntimeId !== admission.nativeRuntimeId
    )
      return {
        ok: false,
        reason: 'runtime_not_current',
        fields: { sessionId: route.sessionId },
        retryable: true,
      };
    const allocation = this.readCanonicalAllocationSync();
    if (
      allocation.state.kind !== 'allocated' ||
      canonicalStopIntent(allocation) !== null ||
      canonicalProviderRefOf(allocation) !== connection.providerInstanceId ||
      !this.matchesCanonicalWorktreeContainment(allocation) ||
      !this.isCurrentConnection(connection)
    )
      return {
        ok: false,
        reason: 'runtime_not_current',
        fields: { sessionId: route.sessionId },
        retryable: false,
      };
    return { ok: true, route, allocation };
  }

  private async forwardRoutedSessionFrame(
    identity: SessionEventIdentity,
    eventType: string,
    operation: ForwardOperation,
    connection: SandboxControlConnectionIdentity,
    frame: unknown,
    frameItems: number,
    forward: (
      route: SessionRoute,
      diagnostic: ControlDiagnosticFields,
      allocation: AllocationRecord
    ) => Promise<SandboxControlEventResult>
  ): Promise<SandboxControlEventResult> {
    const diagnostic = {
      ...diagnosticConnection(connection),
      eventType: diagnosticEventType(eventType),
    };
    let frameBytes: number;
    try {
      frameBytes = sessionForwardFrameBytes(frame);
    } catch {
      this.recordForwardDrop('forwarding_frame_invalid', diagnostic);
      return { applied: false };
    }
    const queuedAt = Date.now();
    const admission = this.resolveForwardingAdmission(identity);
    if (!admission) {
      this.recordForwardDrop('unroutable', diagnostic);
      return { applied: false };
    }
    this.forwardSequence++;
    const fields = {
      ...diagnostic,
      sessionId: admission.sessionId,
      forwardSequence: this.forwardSequence,
      frameBytes,
      frameItems,
      queuedAt,
    };
    const next = this.sessionForwarding.enqueue<undefined, SandboxControlEventResult>({
      sessionId: admission.sessionId,
      identity: null,
      bytes: frameBytes,
      items: 1,
      item: undefined,
      run: async members => {
        const eligibility = this.resolveForwardEligibility(identity, connection, admission);
        if (!eligibility.ok) {
          this.recordForwardDrop(eligibility.reason, { ...fields, ...eligibility.fields });
          this.logSkippedForwardRun({
            sessionId: fields.sessionId,
            operation,
            eventType: fields.eventType,
            queueWaitMs: Date.now() - queuedAt,
            sessionAdmissionDepth: members[0]?.admissionDepth ?? 0,
            runMembers: 1,
            sentItems: frameItems,
            sentBytes: frameBytes,
          });
          return [eligibility.retryable ? { applied: false, retryable: true } : { applied: false }];
        }
        return [
          await forward(
            eligibility.route,
            {
              ...fields,
              sessionId: eligibility.route.sessionId,
              sessionAdmissionDepth: members[0]?.admissionDepth ?? 0,
            },
            eligibility.allocation
          ),
        ];
      },
    });
    this.ctx.waitUntil(
      next.catch(error => {
        this.recordForwardRejection(error, fields);
      })
    );
    return next.catch(() => ({ applied: false, retryable: true }));
  }

  private async forwardRoutedSessionBatch(
    identity: SessionEventIdentity,
    connection: SandboxControlConnectionIdentity,
    payload: SandboxEventBatchPayload
  ): Promise<SandboxEventBatchResult> {
    const diagnostic = {
      ...diagnosticConnection(connection),
      eventType: diagnosticEventType('session.event.batch'),
    };
    let frameBytes: number;
    try {
      frameBytes = sessionForwardFrameBytes({ items: payload.items });
    } catch {
      this.recordForwardDrop('forwarding_frame_invalid', diagnostic);
      return batchOutcomes(payload, 'unattempted', true);
    }
    const queuedAt = Date.now();
    const admission = this.resolveForwardingAdmission(identity);
    if (!admission) {
      this.recordForwardDrop('unroutable', diagnostic);
      return batchOutcomes(payload, 'unattempted', true);
    }
    this.forwardSequence++;
    const fields: ControlDiagnosticFields = {
      ...diagnostic,
      sessionId: admission.sessionId,
      forwardSequence: this.forwardSequence,
      frameBytes,
      frameItems: payload.items.length,
      queuedAt,
    };
    const member: BatchForwardMember = { payload, fields, queuedAt };
    const next = this.sessionForwarding.enqueue<BatchForwardMember, SandboxEventBatchResult>({
      sessionId: admission.sessionId,
      identity: batchCoalescingIdentity(identity, connection, admission),
      bytes: frameBytes,
      items: payload.items.length,
      item: member,
      run: members => this.forwardSessionBatchRun(members, connection, identity, admission),
    });
    this.ctx.waitUntil(
      next.catch(error => {
        this.recordForwardRejection(error, fields);
      })
    );
    return next.catch(() => batchOutcomes(payload, 'unattempted', true));
  }

  private async forwardSessionBatchRun(
    members: readonly SessionForwardRunMember<BatchForwardMember>[],
    connection: SandboxControlConnectionIdentity,
    identity: SessionEventIdentity,
    admission: { sessionId: string; nativeRuntimeId?: string }
  ): Promise<SandboxEventBatchResult[]> {
    return this.deliverBatchRun(members, connection, identity, admission);
  }

  private logForwardRun(fields: ControlDiagnosticFields, level: 'info' | 'warn' = 'info'): void {
    this.logDiagnostic('forward_run', fields, level);
  }

  private forwardRunOutcome(delivery: SessionFrameDelivery): {
    result: 'delivered' | 'delivered_late' | 'skipped' | 'timed_out' | 'failed';
    level: 'info' | 'warn';
    delivered: boolean;
  } {
    const result = delivery.failed
      ? delivery.timedOut
        ? 'timed_out'
        : 'failed'
      : delivery.skipped
        ? 'skipped'
        : delivery.timedOut
          ? 'delivered_late'
          : 'delivered';
    return {
      result,
      level: delivery.failed ? 'warn' : 'info',
      delivered: !delivery.failed && !delivery.skipped,
    };
  }

  private logSkippedForwardRun(input: {
    sessionId: string | number | boolean | null | undefined;
    operation: ForwardOperation;
    eventType: string | number | boolean | null | undefined;
    queueWaitMs: number;
    sessionAdmissionDepth: number;
    runMembers: number;
    sentItems: number;
    sentBytes: number;
  }): void {
    this.logForwardRun({
      ...input,
      attempts: 0,
      result: 'skipped',
      rpcWaitMs: 0,
      appliedCount: 0,
      rejectedCount: 0,
      unknownCount: 0,
      unattemptedCount: input.sentItems,
    });
  }

  private async deliverBatchRun(
    members: readonly SessionForwardRunMember<BatchForwardMember>[],
    connection: SandboxControlConnectionIdentity,
    identity: SessionEventIdentity,
    admission: { sessionId: string; nativeRuntimeId?: string }
  ): Promise<SandboxEventBatchResult[]> {
    const queueWaitMs = Date.now() - (members[0]?.item.queuedAt ?? Date.now());
    const sessionAdmissionDepth = members[0]?.admissionDepth ?? 0;
    const eventType = members[0]?.item.fields.eventType;
    const sentItems = members.reduce((sum, member) => sum + member.items, 0);
    const sentBytes = members.reduce((sum, member) => sum + member.bytes, 0);
    const eligibility = this.resolveForwardEligibility(identity, connection, admission);
    if (!eligibility.ok) {
      for (const member of members)
        this.recordForwardDrop(eligibility.reason, {
          ...member.item.fields,
          ...eligibility.fields,
        });
      this.logSkippedForwardRun({
        sessionId: admission.sessionId,
        operation: 'receiveSandboxControlEventBatch',
        eventType,
        queueWaitMs,
        sessionAdmissionDepth,
        runMembers: members.length,
        sentItems,
        sentBytes,
      });
      return members.map(member => batchOutcomes(member.item.payload, 'unattempted', true));
    }
    const { route, allocation } = eligibility;
    if (!this.isCurrentSessionForward(route, connection, allocation)) {
      for (const member of members) this.recordForwardDrop('stale_before_send', member.item.fields);
      this.logSkippedForwardRun({
        sessionId: admission.sessionId,
        operation: 'receiveSandboxControlEventBatch',
        eventType,
        queueWaitMs,
        sessionAdmissionDepth,
        runMembers: members.length,
        sentItems,
        sentBytes,
      });
      return members.map(member => batchOutcomes(member.item.payload, 'unattempted', true));
    }
    const wrapperInstanceId = connection.wrapperInstanceId;
    const items = members.flatMap(member => member.item.payload.items);
    const captured = new Array<SandboxEventBatchResult | undefined>(members.length);
    const delivery = await this.deliverSessionFrame(
      route,
      allocation,
      connection,
      members.map(member => member.item.fields),
      'receiveSandboxControlEventBatch',
      async stub => {
        const result = await stub.receiveSandboxControlEventBatch({ items, wrapperInstanceId });
        let offset = 0;
        let allApplied = true;
        for (let index = 0; index < members.length; index++) {
          const count = members[index].item.payload.items.length;
          const outcomes = result.outcomes.slice(offset, offset + count);
          offset += count;
          captured[index] = { outcomes };
          const applied =
            outcomes.length === count && outcomes.every(outcome => outcome.status === 'applied');
          allApplied = allApplied && applied;
        }
        return { applied: allApplied };
      }
    );
    const results = members.map(
      (member, index) =>
        captured[index] ??
        batchOutcomes(member.item.payload, delivery.attempts > 0 ? 'unknown' : 'unattempted', true)
    );
    let appliedCount = 0;
    let rejectedCount = 0;
    let unknownCount = 0;
    let unattemptedCount = 0;
    for (const result of results)
      for (const outcome of result.outcomes) {
        if (outcome.status === 'applied') appliedCount++;
        else if (outcome.status === 'rejected') rejectedCount++;
        else if (outcome.status === 'unknown') unknownCount++;
        else unattemptedCount++;
      }
    const outcome = this.forwardRunOutcome(delivery);
    this.logForwardRun(
      {
        sessionId: admission.sessionId,
        operation: 'receiveSandboxControlEventBatch',
        eventType,
        runMembers: members.length,
        sentItems,
        sentBytes,
        queueWaitMs,
        sessionAdmissionDepth,
        attempts: delivery.attempts,
        result: outcome.result,
        applied: outcome.delivered ? appliedCount === sentItems : undefined,
        rpcWaitMs: delivery.rpcWaitMs,
        appliedCount,
        rejectedCount,
        unknownCount,
        unattemptedCount,
      },
      outcome.level
    );
    return results;
  }

  private recordForwardRejection(error: unknown, fields: ControlDiagnosticFields): void {
    if (error instanceof SessionForwardingError) {
      if (error.retryable) {
        this.recordForwardDrop('forwarding_capacity_exhausted', fields);
        return;
      }
      this.recordForwardDrop(
        'forwarding_frame_rejected',
        error.stage === undefined ? fields : { ...fields, rejectStage: error.stage }
      );
      return;
    }
    this.recordForwardDrop('forwarding_failed', fields);
  }

  private recordForwardDrop(reason: string, fields: ControlDiagnosticFields): void {
    const level =
      reason === 'forwarding_frame_rejected'
        ? fields.rejectStage === 'before_forward'
          ? 'error'
          : 'warn'
        : reason === 'forwarding_failed' || reason === 'forwarding_capacity_exhausted'
          ? 'warn'
          : 'info';
    this.logDiagnostic(
      'forward_dropped',
      {
        ...fields,
        reason,
        queueWaitMs: typeof fields.queuedAt === 'number' ? Date.now() - fields.queuedAt : undefined,
        globalWaitingAtDrop: this.sessionForwarding.stats().waiting,
      },
      level
    );
  }

  private isCurrentSessionForward(
    route: SessionRoute,
    connection: SandboxControlConnectionIdentity,
    expectedAllocation: AllocationRecord
  ): boolean {
    if (!this.isCurrentConnection(connection)) return false;
    const routes = loadRouteTableSync(this.ctx.storage.kv);
    const allocation = this.readCanonicalAllocationSync();
    const current = routes.get(route.sessionId);
    return (
      current?.ownerId === route.ownerId &&
      current.kiloSessionId === route.kiloSessionId &&
      current.directory === route.directory &&
      current.worktreeId === route.worktreeId &&
      current.nativeRuntimeId === route.nativeRuntimeId &&
      sameCanonicalAllocation(allocation, expectedAllocation) &&
      allocation.state.kind === 'allocated' &&
      canonicalStopIntent(allocation) === null &&
      canonicalProviderRefOf(allocation) === connection.providerInstanceId &&
      this.matchesCanonicalWorktreeContainment(allocation) &&
      !this.runtimeDeleted &&
      !this.exclusiveDeletionWorktreeId &&
      !(route.worktreeId && this.deletingWorktrees.has(route.worktreeId)) &&
      this.isCurrentConnection(connection)
    );
  }

  private async forwardSessionFrame(
    route: SessionRoute,
    allocation: AllocationRecord,
    connection: SandboxControlConnectionIdentity,
    diagnostic: ControlDiagnosticFields,
    operation:
      | 'receiveSandboxControlEvent'
      | 'receiveSandboxControlPreparing'
      | 'receiveSandboxControlEventBatch',
    send: (
      stub: ReturnType<typeof getSandboxSessionStub>
    ) => Promise<{ applied: boolean; retryable?: boolean }>,
    requireApplied: boolean
  ): Promise<SandboxControlEventResult> {
    const queueWaitMs =
      typeof diagnostic.queuedAt === 'number' ? Date.now() - diagnostic.queuedAt : undefined;
    if (!this.isCurrentSessionForward(route, connection, allocation)) {
      this.recordForwardDrop('stale_before_send', diagnostic);
      this.logSkippedForwardRun({
        sessionId: diagnostic.sessionId,
        operation,
        eventType: diagnostic.eventType,
        queueWaitMs: queueWaitMs ?? 0,
        sessionAdmissionDepth:
          typeof diagnostic.sessionAdmissionDepth === 'number'
            ? diagnostic.sessionAdmissionDepth
            : 0,
        runMembers: 1,
        sentItems: typeof diagnostic.frameItems === 'number' ? diagnostic.frameItems : 1,
        sentBytes: typeof diagnostic.frameBytes === 'number' ? diagnostic.frameBytes : 0,
      });
      return { applied: false, retryable: true };
    }
    const delivery = await this.deliverSessionFrame(
      route,
      allocation,
      connection,
      [diagnostic],
      operation,
      send
    );
    const applied = delivery.applied === true;
    const outcome = this.forwardRunOutcome(delivery);
    this.logForwardRun(
      {
        sessionId: diagnostic.sessionId,
        operation,
        eventType: diagnostic.eventType,
        runMembers: 1,
        sentItems: diagnostic.frameItems,
        sentBytes: diagnostic.frameBytes,
        queueWaitMs,
        sessionAdmissionDepth: diagnostic.sessionAdmissionDepth,
        attempts: delivery.attempts,
        result: outcome.result,
        applied: outcome.delivered ? applied : undefined,
        rpcWaitMs: delivery.rpcWaitMs,
        appliedCount: outcome.delivered && applied ? 1 : 0,
        rejectedCount: outcome.delivered && !applied ? 1 : 0,
        unknownCount: !outcome.delivered && delivery.attempts > 0 ? 1 : 0,
        unattemptedCount: !outcome.delivered && delivery.attempts === 0 ? 1 : 0,
      },
      outcome.level
    );
    if (delivery.failed) return { applied: false, retryable: true };
    if (delivery.skipped) return { applied: false, retryable: true };
    if (!requireApplied || delivery.applied === true) return { applied: true };
    return {
      applied: false,
      retryable: delivery.retryable === true || operation === 'receiveSandboxControlPreparing',
    };
  }

  private async deliverSessionFrame(
    route: SessionRoute,
    allocation: AllocationRecord,
    connection: SandboxControlConnectionIdentity,
    diagnostics: readonly ControlDiagnosticFields[],
    operation: ForwardOperation,
    send: (
      stub: ReturnType<typeof getSandboxSessionStub>
    ) => Promise<{ applied: boolean; retryable?: boolean }>
  ): Promise<SessionFrameDelivery> {
    const startedAt = Date.now();
    let timedOut = false;
    let skipped = false;
    let attempts = 0;
    const timeout = setTimeout(() => {
      timedOut = true;
      for (const diagnostic of diagnostics)
        this.logDiagnostic('forward_response_timeout', {
          ...diagnostic,
          operation,
          attempts,
        });
    }, DEADLINE_MS.stopAttempt);
    timeout.unref();
    return withDORetry(
      () => getSandboxSessionStub(this.env, route.ownerId, route.sessionId),
      async (stub): Promise<{ applied: boolean; retryable?: boolean }> => {
        const currentSession = this.isCurrentSessionForward(route, connection, allocation);
        skipped = !currentSession;
        if (skipped) {
          for (const diagnostic of diagnostics) this.recordForwardDrop('stale_retry', diagnostic);
          return { applied: true };
        }
        attempts++;
        const result = await send(stub);
        const stillCurrent = this.isCurrentSessionForward(route, connection, allocation);
        if (!stillCurrent) {
          skipped = true;
          for (const diagnostic of diagnostics)
            this.recordForwardDrop('stale_after_send', diagnostic);
          return { applied: false };
        }
        return result;
      },
      operation,
      DEFAULT_DO_RETRY_CONFIG
    ).then(
      result => {
        clearTimeout(timeout);
        return {
          applied: result?.applied === true,
          retryable: result?.retryable,
          skipped,
          timedOut,
          attempts,
          rpcWaitMs: Date.now() - startedAt,
          failed: false,
        };
      },
      () => {
        clearTimeout(timeout);
        return {
          applied: false,
          retryable: true,
          skipped,
          timedOut,
          attempts,
          rpcWaitMs: Date.now() - startedAt,
          failed: true,
        };
      }
    );
  }

  private async onSocketClosed(
    handshakeComplete: boolean,
    identity?: SandboxControlConnectionIdentity
  ): Promise<void> {
    if (!handshakeComplete || !identity || !this.isActiveConnection(identity)) return;
    const replacement = this.socketHandler.getConnectionIdentity();
    if (replacement && !this.sameConnection(replacement, identity)) return;
    await this.observeHealth({
      kind: 'socket-closed',
      incarnation: identity.providerInstanceId,
      at: Date.now(),
      ...(identity.wrapperInstanceId !== undefined
        ? { expectedWrapperInstanceId: identity.wrapperInstanceId }
        : {}),
    });
  }

  // Non-waking probe for a bound running allocation whose wrapper incarnation
  // is established but not ready now. A terminal provider observation drives the
  // canonical health machine to unhealthy and its stop; a non-terminal result is
  // a no-op. The canonical record is re-checked before dispatch.
  private async observeCanonicalLoss(record: AllocationRecord): Promise<void> {
    const state = record.state;
    const target = state.kind === 'stopped' ? null : state.target;
    const incarnation = this.allocationIncarnationOf(record);
    if (incarnation === undefined) return;
    const startedAt = Date.now();
    let timedOut = false;
    let failed = false;
    let result: ProviderObservation;
    try {
      result = await withTimeout(
        (await this.providerFor(target ?? undefined)).observe(target?.providerRef ?? null),
        DEADLINE_MS.stopAttempt,
        'Sandbox loss observation timed out',
        () => {
          timedOut = true;
        }
      );
    } catch {
      failed = true;
      result = { status: 'unknown' };
    }
    const current = await this.readCanonicalAllocation();
    const stale = !sameCanonicalAllocation(record, current) || current.state.kind === 'stopped';
    this.logDiagnostic('provider_observation', {
      allocationId: state.kind === 'stopped' ? undefined : state.createIntent?.intentId,
      physicalSandboxId: target?.allocationName,
      physicalState: legacyPhysicalState(record),
      observation: result.status,
      result: timedOut ? 'timed_out' : failed ? 'failed' : 'completed',
      stale,
      durationMs: Date.now() - startedAt,
    });
    if (stale || result.status !== 'terminal') return;
    const decision = await this.allocationOrchestrator.dispatch({
      type: 'HEALTH_OBSERVED',
      incarnation,
      at: Date.now(),
      providerState: 'terminal',
    });
    if (decision === undefined) return;
    await this.allocationOrchestrator.run(decision.commands);
    await this.afterCanonicalCommit(record, await this.readCanonicalAllocation());
  }

  private sameConnection(
    left: SandboxControlConnectionIdentity,
    right: SandboxControlConnectionIdentity
  ): boolean {
    return (
      left.connectionId === right.connectionId &&
      left.providerInstanceId === right.providerInstanceId &&
      left.wrapperInstanceId === right.wrapperInstanceId
    );
  }

  private isActiveConnection(identity: SandboxControlConnectionIdentity): boolean {
    return this.activeConnection !== null && this.sameConnection(this.activeConnection, identity);
  }

  // Same wrapper incarnation across a reconnect: the provider instance and the
  // wrapper instance id match, so a recovery-capable replacement is not treated
  // as a genuinely new runtime. The connection id may legitimately change.
  private sameWrapperRuntime(
    left: SandboxControlConnectionIdentity,
    right: SandboxControlConnectionIdentity
  ): boolean {
    return (
      left.providerInstanceId === right.providerInstanceId &&
      left.wrapperInstanceId !== undefined &&
      left.wrapperInstanceId === right.wrapperInstanceId
    );
  }

  private isCurrentConnection(identity: SandboxControlConnectionIdentity): boolean {
    const current = this.socketHandler.getConnectionIdentity();
    return (
      current !== null &&
      this.sameConnection(current, identity) &&
      this.isActiveConnection(identity)
    );
  }

  private readyWrapperRuntime(): SandboxControlConnectionIdentity | null {
    const current = this.socketHandler.getConnectionIdentity();
    if (
      !current ||
      !this.isActiveConnection(current) ||
      !this.kiloReady ||
      this.readyConnectionId !== current.connectionId
    ) {
      return null;
    }
    return current;
  }

  // Matching evidence that this exact allocation ever established a wrapper
  // incarnation. Recovery-capable close keeps the identity after the ready
  // socket is gone, so it is the discriminator between a warmed runtime and a
  // `running` record that only committed `confirmInstance` before launch.
  private establishedWrapperForAllocation(
    record: AllocationRecord
  ): SandboxControlConnectionIdentity | null {
    const connection = this.activeConnection;
    const providerRef = canonicalProviderRefOf(record);
    if (
      !connection ||
      !connection.wrapperInstanceId ||
      providerRef === null ||
      connection.providerInstanceId !== providerRef
    ) {
      return null;
    }
    return connection;
  }

  private async readHeartbeatObservation(): Promise<WrapperHeartbeatObservation | undefined> {
    return this.ctx.storage.get<WrapperHeartbeatObservation>(WRAPPER_HEARTBEAT_OBSERVATION_KEY);
  }

  // Report-only diagnostics must never block recovery: a failing read degrades
  // to "no observation" and the caller proceeds with its lifecycle action.
  private async readHeartbeatObservationBestEffort(): Promise<
    WrapperHeartbeatObservation | undefined
  > {
    try {
      return await this.readHeartbeatObservation();
    } catch {
      return undefined;
    }
  }

  // Report-only view of the stored observation. Never the deadline authority.
  // Stored fields are omitted unless the observation belongs to `connectionId`,
  // so evidence for a stale connection cannot be reported as current.
  private heartbeatLogFields(
    observation: WrapperHeartbeatObservation | undefined,
    connectionId: string | undefined
  ): ControlDiagnosticFields {
    if (!observation || connectionId === undefined || observation.connectionId !== connectionId) {
      return {};
    }
    return {
      lastReceivedHeartbeatAt: observation.lastReceivedAt,
      lastAcceptedHeartbeatAt: observation.lastAcceptedAt,
      armedAt: observation.armedAt,
      armedExpiryAt: observation.armedExpiryAt,
      heartbeatArmedBasis: observation.armedBasis,
      lastDecision: observation.lastDecision,
      observationConnectionId: observation.connectionId,
      observationWrapperInstanceId: observation.wrapperInstanceId,
    };
  }

  // Bounded report-only per-session heartbeat evidence. The single-route fields
  // come from the payload row that exactly matches the DO's one route, never
  // from route-table `lastState` and never from an implicit "only" row.
  private async heartbeatSessionFields(
    sessions: SandboxHeartbeatPayload['sessions']
  ): Promise<ControlDiagnosticFields> {
    const fields: ControlDiagnosticFields = {};
    const report = packSessionReport(sessions);
    if (report !== undefined) fields.sessionReport = report;
    let routeKiloSessionIds: string[] = [];
    try {
      const table = await loadRouteTable(this.ctx.storage);
      routeKiloSessionIds = [...table.values()].map(route => route.kiloSessionId);
    } catch {
      routeKiloSessionIds = [];
    }
    if (routeKiloSessionIds.length !== 1) return fields;
    const target = sessions.find(session => session.kiloSessionId === routeKiloSessionIds[0]);
    if (!target) return fields;
    fields.kiloSessionId = target.kiloSessionId;
    fields.sessionState = target.state;
    fields.sessionWaitingOn = target.waitingOn ?? 'none';
    return fields;
  }

  // Bounded matching-identity overlay: only the armed connection's observation
  // is updated, and its accept/arm history is preserved.
  private async overlayHeartbeatObservation(
    identity: SandboxControlConnectionIdentity,
    lastDecision: WrapperHeartbeatDecision,
    lastReceivedAt: number
  ): Promise<void> {
    try {
      const existing = await this.readHeartbeatObservation();
      if (!existing || existing.connectionId !== identity.connectionId) return;
      await this.ctx.storage.put(WRAPPER_HEARTBEAT_OBSERVATION_KEY, {
        ...existing,
        lastReceivedAt,
        lastDecision,
      } satisfies WrapperHeartbeatObservation);
    } catch {
      this.logDiagnostic('heartbeat_observation_failed', diagnosticConnection(identity));
    }
  }

  private async readTerminalRuntime(
    input: SandboxTerminalAccessInput,
    allowExpiredCredentials = false
  ): Promise<TerminalRuntimeSnapshot | TerminalRuntimeRejection> {
    await this.ensureOperationalInitialized();
    if (
      typeof input.sessionId !== 'string' ||
      input.sessionId.length === 0 ||
      typeof input.ownerId !== 'string' ||
      input.ownerId.length === 0 ||
      typeof input.wrapperInstanceId !== 'string' ||
      input.wrapperInstanceId.length === 0 ||
      (input.organizationId !== undefined &&
        (typeof input.organizationId !== 'string' || input.organizationId.length === 0)) ||
      (input.botId !== undefined && (typeof input.botId !== 'string' || input.botId.length === 0))
    ) {
      return { allowed: false, reason: 'invalid_terminal_access' };
    }

    const [ownerId, routes, allocation, grants] = await Promise.all([
      this.readOwner(),
      loadRouteTable(this.ctx.storage),
      this.readCanonicalAllocation(),
      loadSessionCredentialGrants(this.ctx.storage),
    ]);
    if (ownerId !== input.ownerId) return { allowed: false, reason: 'owner_mismatch' };
    const route = routes.get(input.sessionId);
    if (!route || route.ownerId !== input.ownerId) {
      return { allowed: false, reason: 'session_not_attached' };
    }
    const worktreeId = route.worktreeId ?? worktreeIdFromDirectory(route.directory);
    if (
      this.runtimeDeleted ||
      this.exclusiveDeletionWorktreeId ||
      (worktreeId && this.deletingWorktrees.has(worktreeId))
    ) {
      return { allowed: false, reason: 'worktree_deleting' };
    }
    if (
      allocation.state.kind !== 'allocated' ||
      canonicalStopIntent(allocation) !== null ||
      canonicalProviderRefOf(allocation) === null
    ) {
      return { allowed: false, reason: 'runtime_not_running' };
    }
    if (!this.matchesCanonicalWorktreeContainment(allocation)) {
      return { allowed: false, reason: 'credential_containment_unavailable' };
    }
    const grant = grants.find(
      grant =>
        grant.userId === input.ownerId &&
        grant.orgId === input.organizationId &&
        grant.sandboxId === this.sandboxId &&
        grant.provider === this.providerKind &&
        grant.directory === route.directory &&
        grant.preparedAt <= Date.now() &&
        (allowExpiredCredentials || grant.expiresAt > Date.now()) &&
        grant.members.some(
          member =>
            member.sessionId === input.sessionId && member.kiloSessionId === route.kiloSessionId
        )
    );
    if (
      !grant ||
      !this.matchesCanonicalContainment(
        allocation,
        getWorktreeCredentialContainment(grant.containmentEnabled !== false)
      )
    ) {
      return { allowed: false, reason: 'credential_scope_unavailable' };
    }

    const connection = this.readyWrapperRuntime();
    if (!connection) return { allowed: false, reason: 'runtime_not_ready' };
    if (!connection.wrapperInstanceId) {
      return { allowed: false, reason: 'terminal_not_supported' };
    }
    if (connection.wrapperInstanceId !== input.wrapperInstanceId) {
      return { allowed: false, reason: 'wrapper_instance_mismatch' };
    }

    return {
      allowed: true,
      connection,
      physical: allocation,
      provider: this.providerKind,
      route,
      grant,
    };
  }

  private connectionState(): ConnectionState {
    const current = this.socketHandler.getConnectionIdentity();
    if (!current || !this.isActiveConnection(current)) return 'disconnected';
    return this.readyWrapperRuntime() ? 'ready' : 'connected';
  }

  private async workState(): Promise<WorkState> {
    const table = await loadRouteTable(this.ctx.storage);
    for (const route of table.values()) {
      if (route.lastState === 'finalizing') return 'finalizing';
    }
    if (hasActiveWork(table)) return 'active';
    return 'idle';
  }

  private async invalidateTerminalRuntime(
    wrapperInstanceId: string,
    confirmed: boolean,
    directory?: string
  ): Promise<boolean> {
    const routes = await loadRouteTable(this.ctx.storage);
    const invalidated = await Promise.all(
      [...routes.values()]
        .filter(route => directory === undefined || route.directory === directory)
        .map(route => {
          return withTimeout(
            withDORetry(
              () => getSandboxSessionStub(this.env, route.ownerId, route.sessionId),
              stub =>
                stub.invalidateTerminalRuntime({
                  sandboxId: this.sandboxId,
                  wrapperInstanceId,
                  confirmed,
                }),
              'invalidateTerminalRuntime'
            ),
            DEADLINE_MS.stopAttempt,
            'Sandbox terminal invalidation timed out'
          ).then(
            () => true,
            () => false
          );
        })
    );
    return invalidated.every(Boolean);
  }

  private mutateRoutesAndReferences<T>(
    mutation: (
      table: Map<string, SessionRoute>,
      references: SessionReferenceState
    ) => { value: T; routesChanged: boolean; referencesChanged: boolean }
  ): Promise<T> {
    return this.ctx.storage.transaction(async () => {
      const table = await loadRouteTable(this.ctx.storage);
      const references = await loadSessionReferences(this.ctx.storage);
      const updated = mutation(table, references);
      if (updated.routesChanged) await saveRouteTable(this.ctx.storage, table);
      if (updated.referencesChanged) await saveSessionReferences(this.ctx.storage, references);
      return updated.value;
    });
  }

  /**
   * Arms the canonical idle anchor monotonically: an already-armed anchor is
   * never shortened. The allocation machine owns the anchor (`state.idleAt`) and
   * the composed alarm; allocation-owned deadlines are not written to the legacy
   * table.
   */
  private armCanonicalIdle(at: number): Promise<void> {
    return this.commitCanonicalIdle(current => Math.max(current ?? 0, at));
  }

  /** Arms the canonical idle anchor only when it is absent; never resets one. */
  private armCanonicalIdleIfAbsent(at: number): Promise<void> {
    return this.commitCanonicalIdle(current => current ?? at);
  }

  private async commitCanonicalIdle(resolve: (current: number | null) => number): Promise<void> {
    const record = await this.readCanonicalAllocation();
    if (record.state.kind !== 'allocated') return;
    const next = resolve(record.state.idleAt);
    if (next === record.state.idleAt) return;
    const decision = await this.allocationOrchestrator.dispatch({ type: 'IDLE', idleAt: next });
    if (decision !== undefined) await this.allocationOrchestrator.run(decision.commands);
    await this.scheduleAlarm();
  }

  /**
   * Keep the on-prem hard-stop anchor in step with the canonical allocation: an
   * on-prem allocation is capped by the profile's fixed lifetime, and the cap is
   * the canonical target's, not a side record. The anchor is armed only while the
   * allocation is running, so the canonical stop ladder (not a re-fired past
   * deadline) owns teardown once the cap is reached.
   */
  private async syncOnPremHardStop(record: AllocationRecord): Promise<void> {
    if (this.providerBinding.kind !== 'onprem') return;
    const state = record.state;
    const live = state.kind === 'creating' || state.kind === 'allocated';
    const hardStopAt = live ? state.target.onprem?.hardStopAt : undefined;
    const anchors = await loadControlAlarmAnchors(this.ctx.storage);
    const armed = anchors.hardStopAt ?? null;
    if (hardStopAt === undefined || !live) {
      if (armed !== null) {
        await this.cancelInfrastructureAnchor('hardStop');
      }
      if (await this.ctx.storage.get(ONPREM_ACKNOWLEDGEMENT_KEY)) {
        await this.ctx.storage.delete(ONPREM_ACKNOWLEDGEMENT_KEY);
      }
      return;
    }
    if (armed !== hardStopAt) {
      await this.armInfrastructureAnchor('hardStop', hardStopAt);
    }
  }

  private async armInfrastructureAnchor(id: ControlAlarmAnchorId, at: number): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      const current = await loadControlAlarmAnchors(this.ctx.storage);
      const wasArmed = controlAlarmAnchorAt(current, id) !== null;
      await setControlAlarmAnchor(this.ctx.storage, id, at);
      if (!wasArmed) {
        await this.appendLog(deadlineTransition(Date.now(), id, 'armed'));
      }
      await this.scheduleAlarm();
    });
  }

  private async cancelInfrastructureAnchor(id: ControlAlarmAnchorId): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      const current = await loadControlAlarmAnchors(this.ctx.storage);
      if (controlAlarmAnchorAt(current, id) === null) return;
      await setControlAlarmAnchor(this.ctx.storage, id, null);
      await this.appendLog(deadlineTransition(Date.now(), id, 'cancelled'));
      await this.scheduleAlarm();
    });
  }

  private async scheduleAlarm(): Promise<void> {
    const record = await this.readCanonicalAllocation();
    const anchors = await loadControlAlarmAnchors(this.ctx.storage);
    await scheduleControlAlarm(
      {
        setAlarm: at => this.ctx.storage.setAlarm(at),
        deleteAlarm: () => this.ctx.storage.deleteAlarm(),
      },
      {
        allocation: record,
        credentialExpiryAt: anchors.credentialExpiryAt,
        socketHandshakeAt: anchors.socketHandshakeAt,
        byocSnapshotRecoveryAt: anchors.byocSnapshotRecoveryAt ?? null,
        hardStopAt: anchors.hardStopAt ?? null,
      }
    );
  }

  /**
   * The live `ControlEffectProvider` bound to the DO's provider adapter. The
   * `create` effect rebuilds the provider create intent from the canonical
   * target/intent — never from an in-memory request — and owns credential
   * generation; `launch` consumes the transient credential handed off by
   * `create`. Stop and destroy are one provider effect (`ProviderAdapter.stop`);
   * the reducer's command kind is the policy, not a second provider call.
   */
  private liveControlProvider(): ControlEffectProvider {
    return {
      create: input => this.controlCreateEffect(input),
      launch: input => this.controlLaunchEffect(input),
      stop: input => this.controlProviderStop(input),
      destroy: input => this.controlProviderStop(input),
      observe: input => this.controlObserveEffect(input),
    };
  }

  private async controlCreateEffect(input: {
    target: AllocationTarget;
    intentId: string;
  }): Promise<
    | { providerRef: string; incarnation: string; resolvedContainment?: AllocationContainment }
    | { unresolved: true }
  > {
    const { target, intentId } = input;
    const record = await this.readCanonicalAllocation();
    const createdAt =
      record.state.kind === 'creating' && record.state.createIntent.intentId === intentId
        ? record.state.createIntent.createdAt
        : Date.now();
    const ownerId = await this.readOwner();
    if (ownerId === null) throw new Error('Sandbox owner is unavailable');
    const billing = await this.billingInput(ownerId);
    const networkPolicy =
      this.providerKind === 'vercel' && target.containment?.kilocode === true
        ? buildControlNetworkPolicy(
            (await loadSessionCredentialGrants(this.ctx.storage)).filter(
              grant => grant.expiresAt > Date.now()
            )
          )
        : undefined;
    const credential = generateSandboxCredential();
    await this.ctx.storage.put(CREDENTIAL_HASH_KEY, await hashSandboxCredential(credential));
    await this.appendLog(credentialTransition(Date.now(), 'issued'));
    const vercel = this.vercelCreateIntent(target);
    const intent: ProviderCreateIntent = {
      intentId,
      createdAt,
      ...(target.allocationName === undefined ? {} : { allocationName: target.allocationName }),
      ...(vercel === undefined ? {} : { vercel }),
      ...(target.onprem === undefined ? {} : { onprem: target.onprem }),
      ...(target.containment === undefined ? {} : { containment: target.containment }),
      ...(billing === undefined ? {} : { billing }),
      ...(networkPolicy === undefined ? {} : { networkPolicy }),
    };
    let created: Awaited<ReturnType<ProviderAdapter['create']>>;
    try {
      created = await (await this.providerFor(target)).create(intent);
    } catch (error) {
      await this.recordProviderFailure(error);
      throw error;
    }
    if ('unresolved' in created) return { unresolved: true };
    this.clearObsoleteProviderFailure();
    this.controlLaunchCredential = { providerRef: created.providerRef, credential, intentId };
    return {
      providerRef: created.providerRef,
      incarnation: created.providerRef,
      ...(target.containment === undefined
        ? {}
        : { resolvedContainment: { ...target.containment, providerRef: created.providerRef } }),
    };
  }

  private async controlLaunchEffect(input: {
    providerRef: string;
    target: AllocationTarget;
  }): Promise<void> {
    const pending = this.controlLaunchCredential;
    this.controlLaunchCredential = null;
    if (!pending || pending.providerRef !== input.providerRef) {
      throw new Error('Sandbox launch credential is unavailable');
    }
    if (this.controlAcquisitionDeadline !== null && Date.now() >= this.controlAcquisitionDeadline) {
      throw new Error('Sandbox acquisition expired');
    }
    try {
      await (
        await this.providerFor(input.target)
      ).launch(
        input.providerRef,
        await this.wrapperLaunchEnv(pending.credential, pending.intentId)
      );
    } catch (error) {
      await this.recordProviderFailure(error);
      throw error;
    }
  }

  private async controlProviderStop(input: {
    target: AllocationTarget;
    reason: string;
    incarnation?: string;
  }): Promise<ControlEffectStopResult> {
    const intent = await this.controlCreateIntentFor(input.target);
    let result: Awaited<ReturnType<ProviderAdapter['stop']>>;
    try {
      result = await withTimeout(
        (await this.providerFor(input.target)).stop(input.target.providerRef, intent),
        DEADLINE_MS.stopAttempt,
        'Sandbox stop timed out'
      );
    } catch (error) {
      await this.recordProviderFailure(error);
      throw error;
    }
    const wrapper =
      this.readyWrapperRuntime()?.wrapperInstanceId ?? this.activeConnection?.wrapperInstanceId;
    return {
      result,
      incarnation:
        input.incarnation ?? intent?.intentId ?? input.target.providerRef ?? this.sandboxId,
      ...(wrapper === undefined ? {} : { wrapper }),
    };
  }

  private async controlObserveEffect(input: {
    target: AllocationTarget;
    incarnation?: string;
  }): Promise<ControlEffectObserveResult> {
    const intent = await this.controlCreateIntentFor(input.target);
    const observed = await withTimeout(
      (await this.providerFor(input.target)).observe(input.target.providerRef, intent),
      DEADLINE_MS.stopAttempt,
      'Sandbox observation timed out'
    );
    // Carry the discovered reference in the fence so the reducer can adopt it
    // when the target never bound one (by-name observation of a lost create).
    const providerRef = observed.providerRef ?? input.target.providerRef;
    const recoverable = this.isByocBinding() && observed.status === 'active';
    return {
      status: observed.status,
      providerRef,
      incarnation:
        input.incarnation ?? intent?.intentId ?? input.target.providerRef ?? this.sandboxId,
      ...(recoverable ? { recoverable: true } : {}),
      // The recovery policy also binds the create intent's containment to the
      // adopted reference, using the same formula as the create effect, so the
      // reducer never re-derives it.
      ...(recoverable && providerRef !== null && input.target.containment !== undefined
        ? { resolvedContainment: { ...input.target.containment, providerRef } }
        : {}),
    };
  }

  /**
   * Rebuild the provider create intent from the canonical record and the
   * command's target. Only the provider's own create-settle fence consumes the
   * `createdAt`; the target supplies the identity fields the lossy legacy schema
   * dropped.
   */
  private async controlCreateIntentFor(
    target: AllocationTarget
  ): Promise<ProviderAllocationIntent | null> {
    const state = (await this.readCanonicalAllocation()).state;
    if (state.kind === 'stopped') return null;
    const createIntent = state.createIntent;
    if (createIntent === null) return null;
    const vercel = this.vercelCreateIntent(target);
    return {
      intentId: createIntent.intentId,
      createdAt: createIntent.createdAt,
      ...(target.allocationName === undefined ? {} : { allocationName: target.allocationName }),
      ...(vercel === undefined ? {} : { vercel }),
      ...(target.onprem === undefined ? {} : { onprem: target.onprem }),
      ...(target.containment === undefined ? {} : { containment: target.containment }),
    };
  }

  /**
   * The Vercel runtime block for a provider effect. The canonical target
   * persists the demand-time configuration (including request-scoped
   * `resources`), which must win over the current environment: a later env
   * rotation must not make an outstanding create/observe target the new
   * build. Only a target without a persisted block (e.g. a legacy record)
   * falls back to the pinned environment.
   */
  private vercelCreateIntent(target: AllocationTarget): ProviderAllocationIntent['vercel'] {
    const persisted = target.vercel;
    if (persisted === undefined) return this.controlVercelIntentConfig();
    const resources = vercelSandboxResourcesSchema
      .optional()
      .parse(persisted.resources ?? this.vercelResources);
    const config = resolveVercelSandboxRuntimeConfig(this.env, {
      ...(persisted.projectId === undefined ? {} : { projectId: persisted.projectId }),
      ...(persisted.snapshotId === undefined ? {} : { snapshotId: persisted.snapshotId }),
      ...(persisted.runtimeBuildId === undefined
        ? {}
        : { runtimeBuildId: persisted.runtimeBuildId }),
      ...(persisted.runtime === undefined ? {} : { runtime: persisted.runtime }),
      ...(resources === undefined ? {} : { resources }),
    });
    if (config === undefined) return undefined;
    return {
      projectId: config.projectId,
      snapshotId: config.snapshotId,
      runtimeBuildId: config.runtimeBuildId,
      runtime: config.runtime,
      ...(config.resources === undefined ? {} : { resources: config.resources }),
    };
  }

  /**
   * Reconstruct the provider create intent's Vercel runtime block the same way
   * the live `claimCreate` does, from the pinned environment configuration
   * rather than the lossy canonical target (whose Vercel fields are optional).
   */
  private controlVercelIntentConfig(): ProviderAllocationIntent['vercel'] {
    if (this.providerKind !== 'vercel') return undefined;
    const vercel = parseVercelSandboxRuntimeConfig(this.env);
    if (vercel === undefined) return undefined;
    return {
      projectId: vercel.projectId,
      snapshotId: vercel.snapshotId,
      runtimeBuildId: vercel.runtimeBuildId,
      runtime: vercel.runtime,
      ...(this.vercelResources === undefined ? {} : { resources: this.vercelResources }),
    };
  }

  private liveNotifySession(): NotifySessionPort {
    return { notifyStopped: input => this.notifySessionStopped(input) };
  }

  /**
   * Route-table fan-out for the `NotifySession` effect. Every attached route is
   * notified; each session fences the `STOPPED` on its own persisted
   * incarnation, so only the bound session terminalizes. A retryable session
   * failure (`stop_attachment_unresolved`/`stop_proof_missing`) is retried within
   * the stop-attempt budget; the allocation settles regardless.
   */
  private async notifySessionStopped(input: {
    stopProof: StopProof | undefined;
    reason: string;
  }): Promise<NotifyEffectResult> {
    const table = await loadRouteTable(this.ctx.storage);
    const results = await Promise.all(
      [...table.values()].map(route => this.notifyStoppedRoute(route, input))
    );
    return results.every(Boolean)
      ? { outcome: 'delivered' }
      : { outcome: 'failed', reason: 'notify_incomplete' };
  }

  private async notifyStoppedRoute(
    route: SessionRoute,
    input: { stopProof: StopProof | undefined; reason: string }
  ): Promise<boolean> {
    const deadlineAt = Date.now() + DEADLINE_MS.stopAttempt;
    for (let attempt = 0; attempt < 3 && Date.now() < deadlineAt; attempt += 1) {
      let result: NotifyEffectResult;
      try {
        result = await withTimeout(
          withDORetry(
            () => getSandboxSessionStub(this.env, route.ownerId, route.sessionId),
            stub => stub.notifyStopped(input) as Promise<NotifyEffectResult>,
            'notifyStopped'
          ),
          Math.max(1, deadlineAt - Date.now()),
          'Sandbox stopped notification timed out'
        );
      } catch {
        result = { outcome: 'failed', reason: 'notify_failed' };
      }
      if (result.outcome === 'delivered') return true;
      if (
        result.reason !== 'stop_attachment_unresolved' &&
        result.reason !== 'stop_proof_missing'
      ) {
        return false;
      }
    }
    return false;
  }

  private async appendLog(row: TransitionRow): Promise<void> {
    const log = await loadTransitionLog(this.ctx.storage);
    await saveTransitionLog(this.ctx.storage, appendTransition(log, row));
  }

  private logDiagnostic(
    event: string,
    fields: ControlDiagnosticFields,
    level: 'info' | 'warn' | 'error' = 'info'
  ): void {
    logControlDiagnostic(
      event,
      { sandboxId: this.sandboxId, provider: this.providerKind, ...fields },
      level
    );
  }

  private async requireOwner(): Promise<string> {
    await this.ensureOperationalInitialized();
    const ownerId = await this.readOwner();
    if (ownerId === null) throw new Error('Sandbox owner is not initialized');
    return ownerId;
  }

  private async readOwner(): Promise<string | null> {
    const stored = await this.ctx.storage.get<string>(OWNER_ID_KEY);
    return typeof stored === 'string' && stored.length > 0 ? stored : null;
  }

  private async authorizeWrapper(request: Request): Promise<boolean> {
    const credential = parseBearerCredential(request.headers.get('Authorization'));
    if (credential === null) return false;

    const storedHash = await this.ctx.storage.get<string>(CREDENTIAL_HASH_KEY);
    if (typeof storedHash !== 'string' || storedHash.length === 0) return false;
    return sandboxCredentialMatchesHash(credential, storedHash);
  }
}
