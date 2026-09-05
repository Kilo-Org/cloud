import { DurableObject } from 'cloudflare:workers';
import {
  cloudAgentWorktreeIdSchema,
  WORKTREE_RUNTIME_HISTORY_UNAVAILABLE,
} from '@kilocode/session-ingest-contracts';
import { resolveSandboxExclusivity } from '../sandbox-control/worktree-ownership.js';
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
import { z } from 'zod';
import type { Env } from '../types.js';
import { resolveSecret } from '../auth.js';
import {
  getSandboxProvider,
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
  hasScopedStopMaintenanceFields,
  parseScopedStopMaintenance,
  stopAbortWirePayload,
} from '../sandbox-control/scoped-stop-maintenance.js';
import {
  createSessionForwarding,
  SessionForwardingError,
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
  sessionOperationAckSchema,
  sessionOperationAuthorizationSchema,
  sessionOperationExpiresAt,
  sessionOperationLookupResultSchema,
  sessionAttachResultSchema,
  sessionAttachPayloadSchema,
  sessionAbortPayloadSchema,
  sessionAbortResultSchema,
  sessionNativeRuntimeRetirementPayloadSchema,
  sessionRequestIdentitySchema,
  wrapperInstanceIdSchema,
  type ResponseFrame,
  type SessionAttachPayload,
  type SessionOperationAck,
  type SessionOperationAuthorization,
  type SessionOperationDelivery,
  type SandboxHeartbeatPayload,
  type SessionEventIdentity,
  type SessionEventPayload,
  type SessionPreparingPayload,
  type SessionRequestIdentity,
} from '../shared/sandbox-control-protocol.js';
import {
  armDeadline,
  cancelDeadline,
  DEADLINE_MS,
  dueDeadlines,
  emptyDeadlines,
  leaseAtLeastMs,
  nextAlarmAt,
  type DeadlineId,
  type DeadlineTable,
} from '../sandbox-control/deadlines.js';
import {
  confirmRunning,
  confirmStopped,
  claimCreate,
  beginStop,
  exhaustStopRetries,
  fail,
  observe,
  recordStopAttempt,
  sameAllocation,
  getWorktreeCredentialContainment,
  WORKTREE_CREDENTIAL_CONTAINMENT,
  type CredentialContainmentRequirements,
  type ObserveResult,
  type PhysicalRecord,
} from '../sandbox-control/physical-lifecycle.js';
import {
  applyReportedSessionState,
  attachRoute,
  detachRoute,
  getRouteBySessionId,
  hasActiveWork,
  resolveSessionEventRoute,
  type AttachRouteInput,
  type SessionRoute,
} from '../sandbox-control/session-routes.js';
import {
  projectReportedStatus,
  projectSandboxStatus,
  type ConnectionState,
  type ReportedSandboxStatus,
  type WorkState,
} from '../sandbox-control/status-projection.js';
import {
  appendTransition,
  connectionTransition,
  credentialTransition,
  deadlineTransition,
  physicalTransition,
  routeTransition,
  sessionStateTransition,
  type TransitionRow,
} from '../sandbox-control/transition-log.js';
import {
  eraseSandboxRecord,
  loadDeadlines,
  loadPhysicalRecord,
  initialRuntimeMetadata,
  loadRuntimeMetadata,
  saveRuntimeMetadata,
  loadRouteTable,
  loadTransitionLog,
  readSandboxControlState,
  saveDeadlines,
  savePhysicalRecord,
  saveRouteTable,
  saveTransitionLog,
  loadSessionCredentialGrants,
  saveSessionCredentialGrants,
  loadNativeRuntimeRetirements,
  saveNativeRuntimeRetirements,
  type NativeRuntimeRetirementReceipt,
  loadRecoveryDecisions,
  saveRecoveryDecisions,
} from '../sandbox-control/durable-state.js';
import * as controlRecovery from '../sandbox-control/control-recovery.js';
import { createRecoveryExecution } from '../sandbox-control/recovery-execution.js';
import { createRecoveryAuthority } from '../sandbox-control/recovery-authority.js';
import {
  canRecoveryRetirementStopAllocation,
  createRecoveryCleanup,
  RECOVERY_CLEANUP_REASON,
} from '../sandbox-control/recovery-cleanup.js';
import {
  createNativeRuntimeRetirementWorkflow,
  matchesNativeRuntimeRetirementAllocation,
  releaseNativeRuntimeRetirement,
  sameNativeRuntimeRetirement,
  type NativeRuntimeRetirementConnection,
  type NativeRuntimeRetirementWorkflow,
} from '../sandbox-control/native-runtime-retirement.js';
import {
  buildControlNetworkPolicy,
  prepareSessionCredentials as prepareCredentials,
  removeSessionCredentialMembership,
  resolveSessionCredential,
  type SessionCredentialGrant,
} from '../sandbox-control/session-credentials.js';
import { parseControlPlaneCredential } from '../sandbox-control/managed-credential.js';
import {
  diagnosticCause,
  diagnosticConnection,
  diagnosticEventType,
  logControlDiagnostic,
  withControlDORetry as withDORetry,
  type ControlDiagnosticFields,
} from '../sandbox-control/diagnostics.js';
import type {
  ProviderAdapter,
  ProviderObservation,
  StopResult,
} from '../sandbox-control/provider.js';
import { nextEnsureReadyStep } from '../sandbox-control/ensure-ready.js';
import {
  planReconciliation,
  shouldRearmReconciliation,
} from '../sandbox-control/reconciliation.js';
import {
  createCloudflareProviderAdapter,
  decodeCloudflareProviderRef,
} from '../sandbox-control/cloudflare-provider.js';
import {
  createVercelProviderAdapter,
  decodeVercelProviderRef,
  vercelProviderLocatorSchema,
  type VercelProviderLocator,
} from '../sandbox-control/vercel-provider.js';
import type { VercelSandboxNetworkPolicy } from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import {
  parseVercelSandboxRuntimeConfig,
  resolveVercelSandboxRuntimeConfig,
} from '../agent-sandbox/vercel/vercel-runtime-config.js';
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
  validateTerminalBillingRuntime,
  type SandboxTerminalAccessInput,
  type SandboxTerminalAccessResult,
} from '../sandbox-control/terminal-billing.js';
import type { AgentSandboxProvider } from '../types.js';
import {
  safeSandboxRuntimeVersion,
  type SandboxRuntimeMetadata,
  type SandboxStatusSnapshot,
} from '../shared/sandbox-status.js';

const CREDENTIAL_HASH_KEY = 'wrapper_credential_hash';
const OWNER_ID_KEY = 'owner_id';
const WRAPPER_READY_AT_KEY = 'wrapper_ready_at';
const ACTIVE_WRAPPER_RUNTIME_KEY = 'active_wrapper_runtime';
const DIAGNOSTIC_BUNDLE_KEY = 'diagnostic_bundle';
const PROVIDER_KIND_KEY = 'provider_kind';
const PROVIDER_LOCATOR_KEY = 'provider_locator';
const BILLING_INPUT_KEY = 'billing_input';
const ACQUISITION_RECEIPTS_KEY = 'acquisition_receipts';
const CREDENTIAL_POLICY_DIRTY_KEY = 'credential_policy_dirty';
const TERMINAL_CREDENTIAL_RENEWAL_WINDOW_MS = 60 * 60 * 1000;

const sandboxAcquisitionSchema = z.object({
  id: z.string().min(1).max(128),
  deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const allocationIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('intent'), id: z.string().min(1) }),
  z.object({ kind: z.literal('provider'), id: z.string().min(1) }),
]);
const acquisitionReceiptsSchema = z.array(
  sandboxAcquisitionSchema.extend({ allocation: allocationIdentitySchema })
);

export type SandboxAcquisition = z.infer<typeof sandboxAcquisitionSchema>;

function assertAcquisitionDeadline(acquisition: SandboxAcquisition): void {
  if (Date.now() >= acquisition.deadlineAt) throw new Error('Sandbox acquisition expired');
}

function allocationIdentity(physical: PhysicalRecord) {
  if (physical.state === 'stopped') return undefined;
  if (physical.createIntent !== null && physical.createIntent !== undefined) {
    return allocationIdentitySchema.parse({ kind: 'intent', id: physical.createIntent.intentId });
  }
  return physical.providerRef === null
    ? undefined
    : allocationIdentitySchema.parse({ kind: 'provider', id: physical.providerRef });
}

type PersistedWrapperRuntime = SandboxControlConnectionIdentity & {
  readyConnectionId?: string;
};

type TerminalRuntimeSnapshot = {
  allowed: true;
  connection: SandboxControlConnectionIdentity;
  physical: PhysicalRecord;
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

export type AttachSessionInput = AttachRouteInput;

export type SandboxControlStatus = {
  reported: ReportedSandboxStatus;
  physical: PhysicalRecord['state'];
  connection: ConnectionState;
  work: WorkState;
  wrapperInstanceId?: string;
  operationResults?: true;
};

export type RuntimeQuarantineResult =
  | { quarantined: true; disposition: 'native_retired' | 'native_pending' | 'physical_stopping' }
  | { quarantined: false; disposition: 'physical_stopped' | 'wrapper_replaced' | 'unconfirmed' };

export class SandboxControl extends DurableObject<Env> {
  readonly sandboxId: string;
  private socketHandler: SandboxControlSocketHandler;
  private kiloReady = false;
  private activeConnection: SandboxControlConnectionIdentity | null = null;
  private readyConnectionId: string | null = null;
  private providerKind: AgentSandboxProvider = 'cloudflare';
  private readonly sessionForwarding = createSessionForwarding();
  private readonly forwarding = {
    enqueued: 0,
    settled: 0,
    waiting: 0,
    inFlight: 0,
    highWater: 0,
    dropped: 0,
    notApplied: 0,
    failed: 0,
    bufferedBytes: 0,
    maxQueueWaitMs: 0,
    maxRpcWaitMs: 0,
    maxTotalForwardMs: 0,
  };
  private lastAcceptedHeartbeat: { connectionId: string; at: number } | null = null;
  private credentialUpdates: Promise<void> = Promise.resolve();
  private provider: ProviderAdapter;
  private stopAttemptInFlight: {
    physical: PhysicalRecord;
    promise: Promise<PhysicalRecord>;
  } | null = null;
  private providerStopInFlight: {
    physical: PhysicalRecord;
    promise: Promise<StopResult>;
  } | null = null;
  private vercelLocator: VercelProviderLocator | undefined;
  private readonly deletingWorktrees = new Set<string>();
  private exclusiveDeletionWorktreeId: string | undefined;
  private runtimeDeleted = false;
  private readonly readinessOperations = new Set<Promise<unknown>>();
  private readonly lifecycleOperations = new Set<Promise<unknown>>();
  private worktreeDeletionChain: Promise<unknown> = Promise.resolve();
  private operationalInitialization: Promise<void> | null = null;
  private readonly nativeRuntimeRetirement: NativeRuntimeRetirementWorkflow;
  private readonly recoveryAuthority: ReturnType<typeof createRecoveryAuthority>;
  private readonly recoveryCleanup: ReturnType<typeof createRecoveryCleanup>;
  private readonly recoveryExecution = createRecoveryExecution({
    storage: this.ctx.storage,
    sendRequest: request => this.socketHandler.sendRequest(request),
    loadPhysical: () => loadPhysicalRecord(this.ctx.storage),
    loadAuthority: recovery => this.recoveryAuthority.load(recovery),
    onReady: (identity, recovery) => this.commitWrapperReady(identity, recovery),
    reconcileStops: authority => this.recoveryAuthority.reconcileStops(authority),
    reconcileOperations: authority => this.recoveryAuthority.reconcileOperations(authority),
    onActivated: identity => this.activateWrapperReady(identity),
    scheduleAlarm: deadlines => this.scheduleAlarm(deadlines),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sandboxId = ctx.id.name ?? ctx.id.toString();
    this.recoveryAuthority = createRecoveryAuthority({
      storage: ctx.storage,
      env,
      sandboxId: this.sandboxId,
    });
    this.recoveryCleanup = createRecoveryCleanup({
      storage: ctx.storage,
      retirement: { retire: input => this.nativeRuntimeRetirement.retire(input) },
      getConnection: () =>
        this.nativeRetirementConnection(
          this.socketHandler.getConnectionIdentity() ?? this.activeConnection
        ),
      supportsTargetedRetirement: () => this.supportsNativeRuntimeRetirement(),
      persistPhysical: (from, to, reason) => this.persistPhysicalState(from, to, reason),
      onPhysicalStop: async (from, to, reason) => {
        await this.afterPhysicalPersistence(from, to, reason, to.stopTombstone?.wrapperInstanceId);
        this.ctx.waitUntil(this.recordStopAttempt());
      },
      scheduleAlarm: deadlines => this.scheduleAlarm(deadlines),
    });
    this.provider = this.createProviderAdapter('cloudflare');
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(SANDBOX_CONTROL_AUTO_PING, SANDBOX_CONTROL_AUTO_PONG)
    );
    this.socketHandler = createSandboxControlSocketHandler(ctx, this.sandboxId, undefined, {
      validateHandshake: providerInstanceId => this.validateHandshake(providerInstanceId),
      onHandshakeComplete: (identity, runtime) => this.onHandshakeComplete(identity, runtime),
      onReady: identity => this.onWrapperReady(identity),
      onHeartbeat: (payload, identity) => this.onHeartbeat(payload, identity),
      onSessionEvent: (sessionIdentity, payload, identity, receiptId, receiptHash, sequence) =>
        this.onSessionEvent(sessionIdentity, payload, identity, receiptId, receiptHash, sequence),
      onSessionPreparing: (sessionIdentity, payload, identity, receiptId, receiptHash, sequence) =>
        this.onSessionPreparing(
          sessionIdentity,
          payload,
          identity,
          receiptId,
          receiptHash,
          sequence
        ),
      onOperationResult: (session, delivery, identity) =>
        this.onOperationResult(session, delivery, identity),
      onNativeRuntimeRetired: (payload, identity) => this.onNativeRuntimeRetired(payload, identity),
      onSocketClosed: (handshakeComplete, identity) =>
        this.onSocketClosed(handshakeComplete, identity),
    });
    this.nativeRuntimeRetirement = createNativeRuntimeRetirementWorkflow({
      storage: ctx.storage,
      currentIncarnation: {
        isCurrent: connection => this.isCurrentConnection(connection),
        getConnection: () => {
          const connection = this.socketHandler.getConnectionIdentity();
          return connection ? (this.nativeRetirementConnection(connection) ?? null) : null;
        },
        sameLifetime: (left, right) =>
          left.providerInstanceId === right.providerInstanceId &&
          left.wrapperInstanceId === right.wrapperInstanceId,
      },
      transport: {
        supportsTargetedRetirement: () => this.supportsNativeRuntimeRetirement(),
        abortNativeRuntime: input => this.abortNativeRuntime(input),
        invalidateRecipients: receipt => this.invalidateNativeRetirementRecipients(receipt),
        notifyRecipients: receipt => this.notifyNativeRetirementRecipients(receipt),
      },
      physicalEscalation: {
        beginIfCurrent: receipt => this.beginNativeRetirementPhysicalFallback(receipt),
      },
      scheduleAlarm: deadlines => this.scheduleAlarm(deadlines),
    });
  }

  private ensureOperationalInitialized(): Promise<void> {
    return (this.operationalInitialization ??= this.ctx.blockConcurrencyWhile(async () => {
      const ctx = this.ctx;
      const [readyAt, runtime, kind, physical, recovery] = await Promise.all([
        ctx.storage.get<number>(WRAPPER_READY_AT_KEY),
        ctx.storage.get<PersistedWrapperRuntime>(ACTIVE_WRAPPER_RUNTIME_KEY),
        ctx.storage.get<AgentSandboxProvider>(PROVIDER_KIND_KEY),
        loadPhysicalRecord(ctx.storage),
        loadRecoveryDecisions(ctx.storage),
      ]);
      this.vercelLocator = vercelProviderLocatorSchema
        .optional()
        .parse(await ctx.storage.get(PROVIDER_LOCATOR_KEY));
      this.providerKind = kind ?? 'cloudflare';
      this.provider = this.createProviderAdapter(this.providerKind, physical);
      this.runtimeDeleted = (await ctx.storage.get(RUNTIME_DELETED_KEY)) === true;
      this.exclusiveDeletionWorktreeId = cloudAgentWorktreeIdSchema
        .optional()
        .parse(await ctx.storage.get(EXCLUSIVE_DELETION_KEY));
      for (const key of (await ctx.storage.list({ prefix: WORKTREE_DELETION_PREFIX })).keys()) {
        this.deletingWorktrees.add(
          cloudAgentWorktreeIdSchema.parse(key.slice(WORKTREE_DELETION_PREFIX.length))
        );
      }
      await this.repairLifecycleScheduling(physical);
      this.ctx.waitUntil(this.nativeRuntimeRetirement.resume());
      if (
        physical.stopTombstone ||
        (physical.state !== 'running' && physical.state !== 'creating')
      ) {
        this.socketHandler.closeAll('Sandbox runtime unavailable');
        return;
      }
      const current = this.socketHandler.getConnectionIdentity();
      this.activeConnection = runtime ?? current;
      if (
        runtime &&
        current &&
        this.sameConnection(runtime, current) &&
        runtime.readyConnectionId === current.connectionId &&
        readyAt !== undefined
      ) {
        if (recovery.every(item => item.activationAcknowledgedAt !== undefined)) {
          this.readyConnectionId = current.connectionId;
          this.kiloReady = true;
        }
      } else {
        this.kiloReady =
          !runtime && current !== null && readyAt !== undefined && recovery.length === 0;
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
    await this.armDeadlineAndAlarm('socketHandshake', Date.now() + DEADLINE_MS.socketHandshake);
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
    const deadlines = await loadDeadlines(this.ctx.storage);
    for (const id of dueDeadlines(deadlines, now)) {
      const before = await loadDeadlines(this.ctx.storage);
      if (before[id] === undefined || before[id] > now) continue;
      this.logDiagnostic('deadline_fired', {
        deadlineId: id,
        deadlineAt: before[id],
        latenessMs: Math.max(0, now - before[id]),
        heartbeatDeadlineAt: before.heartbeatExpiry,
        idleDeadlineAt: before.idleStop,
        connectionState: this.connectionState(),
        lastAcceptedHeartbeatAt:
          this.lastAcceptedHeartbeat?.connectionId === this.activeConnection?.connectionId
            ? this.lastAcceptedHeartbeat?.at
            : undefined,
        ...diagnosticConnection(this.activeConnection),
        ...this.forwarding,
      });
      await this.appendLog(deadlineTransition(now, id, 'fired'));
      await this.handleDeadline(id);
      await this.ctx.storage.transaction(async () => {
        const latest = await loadDeadlines(this.ctx.storage);
        const armedAt = latest[id];
        const next = armedAt !== undefined && armedAt <= now ? cancelDeadline(latest, id) : latest;
        await saveDeadlines(this.ctx.storage, next);
        await this.scheduleAlarm(next);
      });
    }
    await this.ctx.storage.transaction(async () => {
      await this.scheduleAlarm(await loadDeadlines(this.ctx.storage));
    });
  }

  async setWrapperCredentialHash(hash: string): Promise<void> {
    await this.ensureOperationalInitialized();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error('Invalid wrapper credential hash');
    }
    const previous = this.activeConnection ?? this.socketHandler.getConnectionIdentity();
    await this.ctx.storage.transaction(async () => {
      const physical = await loadPhysicalRecord(this.ctx.storage);
      let deadlines = await loadDeadlines(this.ctx.storage);
      deadlines = cancelDeadline(cancelDeadline(deadlines, 'heartbeatExpiry'), 'socketHandshake');
      if (physical.state === 'running' && !physical.stopTombstone) {
        deadlines = cancelDeadline(cancelDeadline(deadlines, 'startup'), 'idleStop');
        deadlines = armDeadline(
          deadlines,
          'wrapperReadiness',
          Date.now() + DEADLINE_MS.wrapperReadiness
        );
      }
      await this.ctx.storage.put(CREDENTIAL_HASH_KEY, hash);
      await this.ctx.storage.delete([ACTIVE_WRAPPER_RUNTIME_KEY, WRAPPER_READY_AT_KEY]);
      await saveDeadlines(this.ctx.storage, deadlines);
      await this.scheduleAlarm(deadlines);
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

  async request(input: SandboxControlOutboundRequest): Promise<ResponseFrame> {
    await this.ensureOperationalInitialized();
    if (input.operation === 'session.git.summary') return this.requestWorktreeChanges(input);
    const scopedStop =
      input.operation === 'session.abort' ? parseScopedStopMaintenance(input.payload) : undefined;
    if (
      input.operation === 'session.abort' &&
      hasScopedStopMaintenanceFields(input.payload) &&
      scopedStop === undefined
    )
      throw new Error('Invalid scoped Stop maintenance request');
    const maintenance =
      input.operation === 'session.operation.get' || input.operation === 'session.operation.ack';
    if (!maintenance && !scopedStop) await this.assertRequestWorktreeAdmission(input);
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
    const usesMaintenanceChannel = maintenance || scopedStop !== undefined || recoveryInteraction;
    const runtime = usesMaintenanceChannel
      ? this.socketHandler.getConnectionIdentity()
      : this.readyWrapperRuntime();
    if (!runtime) throw new Error('Sandbox runtime is not ready');
    if (
      expectedWrapperInstanceId !== undefined &&
      runtime.wrapperInstanceId !== expectedWrapperInstanceId
    ) {
      throw new Error('Sandbox wrapper runtime changed');
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
    if (
      !usesMaintenanceChannel &&
      input.session &&
      !controlRecovery.admitsRecoveryRequest(
        await loadRecoveryDecisions(this.ctx.storage),
        runtime,
        input.session
      )
    )
      throw new Error('Session recovery is not ready');
    const physical = await loadPhysicalRecord(this.ctx.storage);
    if (
      ((!maintenance || scopedStop !== undefined) && physical.state !== 'running') ||
      ((!maintenance || scopedStop !== undefined) && physical.stopTombstone) ||
      physical.providerRef !== runtime.providerInstanceId ||
      !isCurrent()
    ) {
      throw new Error('Sandbox runtime is not ready');
    }
    const scopedSession = scopedStop
      ? sessionRequestIdentitySchema.safeParse(input.session)
      : undefined;
    let scopedRoute: SessionRoute | undefined;
    if (scopedStop) {
      if (!scopedSession?.success || expectedWrapperInstanceId === undefined)
        throw new Error('Scoped Stop identity is required');
      const route = (await loadRouteTable(this.ctx.storage)).get(scopedSession.data.sessionId);
      if (
        !route ||
        route.kiloSessionId !== scopedSession.data.kiloSessionId ||
        route.directory !== scopedSession.data.directory ||
        runtime.wrapperInstanceId !== expectedWrapperInstanceId
      )
        throw new Error('Scoped Stop target is stale');
      this.assertWorktreeAdmission(route.worktreeId);
      scopedRoute = route;
    }
    if (input.operation === 'session.attach' || input.operation === 'session.prompt') {
      const payload = parseOperationPayload(input.operation, input.payload);
      if (!payload.ok) throw new Error(payload.error.message);
      const identity = sessionRequestIdentitySchema.safeParse(input.session);
      if (!identity.success) throw new Error('session identity is required');
      await this.ctx.storage.transaction(async () => {
        const current = await loadPhysicalRecord(this.ctx.storage);
        const table = await loadRouteTable(this.ctx.storage);
        const route = table.get(identity.data.sessionId);
        if (
          current.state !== 'running' ||
          current.stopTombstone ||
          current.providerRef !== runtime.providerInstanceId ||
          !sameAllocation(physical, current) ||
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
        if (
          !controlRecovery.admitsRecoveryRequest(
            await loadRecoveryDecisions(this.ctx.storage),
            runtime,
            identity.data
          )
        )
          throw new Error('Session recovery is not ready');
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
        const deadlines = await loadDeadlines(this.ctx.storage);
        const next = armDeadline(
          deadlines,
          'idleStop',
          Math.max(deadlines.idleStop ?? 0, now + DEADLINE_MS.idleStop)
        );
        await saveDeadlines(this.ctx.storage, next);
        if (deadlines.idleStop === undefined) {
          await this.appendLog(deadlineTransition(now, 'idleStop', 'armed'));
        }
        await this.scheduleAlarm(next);
        if (!isCurrent()) throw new Error('Sandbox wrapper runtime changed');
      });
    }
    if (!usesMaintenanceChannel) await this.assertRequestWorktreeAdmission(input);
    if (recoveryInteraction) await this.assertRecoveryInteraction(input, runtime, physical);
    if (!isCurrent()) throw new Error('Sandbox wrapper runtime changed');
    if (scopedStop) {
      const payload = sessionAbortPayloadSchema.parse(input.payload);
      const nativeRuntimeId = scopedRoute?.nativeRuntimeId;
      const retirementConnection = this.nativeRetirementConnection(runtime);
      const retirement =
        nativeRuntimeId !== undefined && scopedRoute !== undefined && retirementConnection
          ? await this.nativeRuntimeRetirement.begin({
              connection: retirementConnection,
              physical,
              route: scopedRoute,
              nativeRuntimeId,
              reason: 'Scoped Stop cleanup',
              operationId: scopedStop.operationId,
              cleanupDeadlineAt: scopedStop.cleanupDeadlineAt,
            })
          : undefined;
      if (retirement && retirement.operationId !== scopedStop.operationId)
        return errorResponse(
          crypto.randomUUID(),
          'not_ready',
          'Native runtime retirement is already in progress',
          true
        );
      const retirementAttempt = retirement
        ? await this.nativeRuntimeRetirement.claimTargetedAttempt(retirement)
        : undefined;
      if (retirement && !retirementAttempt)
        return errorResponse(
          crypto.randomUUID(),
          'not_ready',
          'Native runtime retirement is already in progress',
          true
        );
      let response: ResponseFrame;
      try {
        const cleanupDeadlineAt = retirement?.cleanupDeadlineAt ?? scopedStop.cleanupDeadlineAt;
        response = await this.socketHandler.sendRequest({
          ...input,
          payload: stopAbortWirePayload(
            { ...payload, cleanupDeadlineAt },
            this.socketHandler.supportsScopedStopAbort()
          ),
          deadlineAt: cleanupDeadlineAt,
        });
      } catch (error) {
        if (retirementAttempt) await this.nativeRuntimeRetirement.defer(retirementAttempt);
        throw error;
      }
      const result = response.ok ? sessionAbortResultSchema.safeParse(response.result) : undefined;
      if (
        result?.success &&
        result.data.runtimeRetired === true &&
        result.data.nativeRuntimeId !== undefined &&
        nativeRuntimeId === result.data.nativeRuntimeId &&
        retirementAttempt &&
        this.supportsNativeRuntimeRetirement() &&
        expectedWrapperInstanceId !== undefined
      ) {
        const invalidated = await this.nativeRuntimeRetirement.complete(retirementAttempt);
        if (!invalidated)
          return errorResponse(
            response.requestId,
            'not_ready',
            'Native runtime retirement invalidation is pending',
            true
          );
      } else if (retirementAttempt && result?.success) {
        await this.nativeRuntimeRetirement.release(retirementAttempt);
      } else if (retirementAttempt) {
        await this.nativeRuntimeRetirement.defer(retirementAttempt);
      }
      return response;
    }
    const outbound =
      input.operation === 'session.attach' && this.supportsNativeRuntimeRetirement()
        ? {
            ...input,
            payload: {
              ...sessionAttachPayloadSchema.parse(input.payload),
              captureNativeRuntimeId: true,
            },
          }
        : input;
    const response = await this.socketHandler.sendRequest(outbound);
    if (input.operation === 'session.attach' && response.ok) {
      const result = sessionAttachResultSchema.safeParse(response.result);
      const session = sessionRequestIdentitySchema.safeParse(input.session);
      if (result.success && session.success && result.data.nativeRuntimeId !== undefined) {
        await this.recordNativeRuntime(
          runtime,
          physical,
          session.data,
          result.data.nativeRuntimeId,
          authorization?.success ? authorization.data : undefined
        );
      }
    }
    if (
      input.operation === 'session.operation.get' &&
      response.ok &&
      this.supportsNativeRuntimeRetirement()
    ) {
      const lookup = sessionOperationLookupResultSchema.safeParse(response.result);
      const session = sessionRequestIdentitySchema.safeParse(input.session);
      if (
        lookup.success &&
        lookup.data.state === 'completed' &&
        lookup.data.delivery.authorization.operation === 'session.attach' &&
        lookup.data.delivery.result.ok &&
        session.success
      ) {
        const attached = sessionAttachResultSchema.safeParse(lookup.data.delivery.result.result);
        if (attached.success && attached.data.nativeRuntimeId !== undefined) {
          await this.recordNativeRuntime(
            runtime,
            physical,
            session.data,
            attached.data.nativeRuntimeId,
            lookup.data.delivery.authorization
          );
        }
      }
    }
    return response;
  }

  private async assertRecoveryInteraction(
    input: SandboxControlOutboundRequest,
    runtime: SandboxControlConnectionIdentity,
    physical: PhysicalRecord
  ): Promise<void> {
    const session = sessionRequestIdentitySchema.parse(input.session);
    const payload = parseOperationPayload(input.operation, input.payload);
    if (!payload.ok) throw new Error(payload.error.message);
    await this.ctx.storage.transaction(async tx => {
      const current = await loadPhysicalRecord(tx);
      const route = (await loadRouteTable(tx)).get(session.sessionId);
      const recovery = (await loadRecoveryDecisions(tx)).find(item =>
        controlRecovery.sameRuntime(item, runtime)
      );
      const authority = recovery?.authority;
      const root = authority?.roots?.find(item => item.sessionId === session.sessionId);
      if (
        this.runtimeDeleted ||
        !runtime.recoveryCapable ||
        !this.isCurrentConnection(runtime) ||
        current.state !== 'running' ||
        current.stopTombstone !== null ||
        !sameAllocation(physical, current) ||
        current.providerRef !== runtime.providerInstanceId ||
        !route ||
        route.kiloSessionId !== session.kiloSessionId ||
        route.directory !== session.directory ||
        route.retiringNativeRuntimeId !== undefined ||
        (!recovery && !this.readyWrapperRuntime()) ||
        (recovery &&
          (!controlRecovery.sameConnection(recovery, runtime) ||
            (root?.decision !== 'ready' &&
              (recovery.exhaustedAt !== undefined ||
                Date.now() >= (recovery.activationCommitDeadlineAt ?? recovery.deadlineAt))))) ||
        (authority &&
          (authority.allocation.providerRef !== current.providerRef ||
            authority.allocation.createIntentId !== current.createIntent?.intentId ||
            !root ||
            root.ownerId !== route.ownerId ||
            root.kiloSessionId !== route.kiloSessionId ||
            root.directory !== route.directory ||
            root.nativeRuntimeId !== route.nativeRuntimeId ||
            root.observation === 'stale' ||
            root.decision === 'stop_pending' ||
            root.decision === 'execution_expired'))
      )
        throw new Error('Session interaction scope is stale');
      this.assertWorktreeAdmission(route.worktreeId);
      this.assertWorktreeAdmission(this.worktreeIdFromDirectory(session.directory));
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
    const physical = await loadPhysicalRecord(this.ctx.storage);
    const routes = await loadRouteTable(this.ctx.storage);
    const route = session ? routes.get(session.sessionId) : undefined;
    const runtime = this.readyWrapperRuntime();
    const socket = this.socketHandler.getReadySocket();
    this.assertWorktreeAdmission(route?.worktreeId);
    if (
      physical.state !== 'running' ||
      physical.stopTombstone ||
      !runtime ||
      physical.providerRef !== runtime.providerInstanceId ||
      !matchesRoute(route) ||
      !socket
    ) {
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
    const currentPhysical = await loadPhysicalRecord(this.ctx.storage);
    const currentRoutes = await loadRouteTable(this.ctx.storage);
    const currentRoute = session ? currentRoutes.get(session.sessionId) : undefined;
    await this.assertRequestWorktreeAdmission(input);
    this.assertWorktreeAdmission(currentRoute?.worktreeId);
    const currentRuntime = this.readyWrapperRuntime();
    if (
      currentPhysical.state !== 'running' ||
      currentPhysical.stopTombstone ||
      currentPhysical.providerRef !== physical.providerRef ||
      !sameAllocation(physical, currentPhysical) ||
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

  async quarantineRuntime(input: {
    ownerId: string;
    sessionId: string;
    wrapperInstanceId: string;
    reason: string;
    nativeRuntimeId?: string;
    authorization?: SessionOperationAuthorization;
  }): Promise<RuntimeQuarantineResult> {
    await this.ensureOperationalInitialized();
    const nativeRuntimeId =
      input.nativeRuntimeId === undefined
        ? undefined
        : z.string().uuid().safeParse(input.nativeRuntimeId);
    const authorization =
      input.authorization === undefined
        ? undefined
        : sessionOperationAuthorizationSchema.safeParse(input.authorization);
    if (
      typeof input.ownerId !== 'string' ||
      !input.ownerId ||
      typeof input.sessionId !== 'string' ||
      !input.sessionId ||
      typeof input.wrapperInstanceId !== 'string' ||
      !input.wrapperInstanceId ||
      typeof input.reason !== 'string' ||
      !input.reason ||
      input.reason.length > 256 ||
      (nativeRuntimeId !== undefined &&
        (!nativeRuntimeId.success ||
          !authorization?.success ||
          authorization.data.operation !== 'session.attach' ||
          authorization.data.session.sessionId !== input.sessionId ||
          authorization.data.wrapperInstanceId !== input.wrapperInstanceId)) ||
      (nativeRuntimeId === undefined && authorization !== undefined)
    ) {
      throw new Error('Invalid sandbox quarantine request');
    }
    const [ownerId, physical] = await Promise.all([
      this.readOwner(),
      loadPhysicalRecord(this.ctx.storage),
    ]);
    if (ownerId !== input.ownerId) throw new Error('Sandbox owner mismatch');
    if (nativeRuntimeId?.success && authorization?.success) {
      const retired = (await loadNativeRuntimeRetirements(this.ctx.storage)).some(
        receipt =>
          receipt.state === 'completed' &&
          receipt.disposition === 'retired' &&
          receipt.nativeRuntimeId === nativeRuntimeId.data &&
          receipt.connection.wrapperInstanceId === input.wrapperInstanceId &&
          receipt.recipients.some(
            recipient =>
              recipient.ownerId === input.ownerId &&
              recipient.sessionId === authorization.data.session.sessionId &&
              recipient.kiloSessionId === authorization.data.session.kiloSessionId &&
              recipient.directory === authorization.data.session.directory &&
              recipient.nativeRuntimeId === nativeRuntimeId.data
          )
      );
      if (retired) return { quarantined: true, disposition: 'native_retired' };
    }
    if (physical.state === 'stopped')
      return { quarantined: false, disposition: 'physical_stopped' };
    const connection = this.activeConnection ?? this.socketHandler.getConnectionIdentity();
    if (connection?.wrapperInstanceId && connection.wrapperInstanceId !== input.wrapperInstanceId) {
      return { quarantined: false, disposition: 'wrapper_replaced' };
    }
    const retirementConnection = this.nativeRetirementConnection(connection);
    const wrapperInstanceId =
      physical.stopTombstone?.wrapperInstanceId ?? connection?.wrapperInstanceId;
    if (wrapperInstanceId !== input.wrapperInstanceId)
      return { quarantined: false, disposition: 'unconfirmed' };
    const route = (await loadRouteTable(this.ctx.storage)).get(input.sessionId);
    const targetRoute =
      nativeRuntimeId?.success && authorization?.success
        ? route &&
          route.ownerId === input.ownerId &&
          route.kiloSessionId === authorization.data.session.kiloSessionId &&
          route.directory === authorization.data.session.directory &&
          route.nativeRuntimeId === nativeRuntimeId.data
          ? route
          : undefined
        : route;
    if (nativeRuntimeId?.success && !targetRoute)
      return { quarantined: false, disposition: 'unconfirmed' };
    if (
      targetRoute &&
      targetRoute.ownerId === input.ownerId &&
      retirementConnection &&
      targetRoute.nativeRuntimeId !== undefined &&
      !physical.stopTombstone
    ) {
      const retirement = await this.nativeRuntimeRetirement.retire({
        connection: retirementConnection,
        physical,
        route: targetRoute,
        reason: input.reason,
        cleanupDeadlineAt: Date.now() + DEADLINE_MS.stopAttempt,
      });
      if (retirement === 'retired') return { quarantined: true, disposition: 'native_retired' };
      if (retirement === 'pending') return { quarantined: true, disposition: 'native_pending' };
    }
    if (nativeRuntimeId?.success) return { quarantined: false, disposition: 'unconfirmed' };
    if (!physical.stopTombstone) {
      const next = beginStop(physical, input.reason, Date.now(), wrapperInstanceId);
      await this.persistPhysical(physical, next, input.reason);
      this.ctx.waitUntil(this.recordStopAttempt());
    } else {
      await this.repairLifecycleScheduling(physical);
    }
    return { quarantined: true, disposition: 'physical_stopping' };
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
    const provider = getSandboxProvider(metadata);
    await this.pinProvider(provider);
    const physical = await loadPhysicalRecord(this.ctx.storage);
    const requiredContainment = getWorktreeCredentialContainment(
      requiresContainmentSandbox(metadata)
    );
    if (!this.matchesContainment(physical, requiredContainment)) {
      throw new Error('Sandbox credential containment is unavailable');
    }
    const outboundContainerId =
      provider === 'cloudflare' && requiredContainment.kilocode
        ? getOutboundContainerId(
            this.env,
            decodeCloudflareProviderRef(physical.providerRef)?.sandboxId ??
              physical.createIntent?.allocationName ??
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
      const currentPhysical = await loadPhysicalRecord(this.ctx.storage);
      if (
        (deadlineAt !== undefined && Date.now() >= deadlineAt) ||
        !sameAllocation(physical, currentPhysical) ||
        !this.matchesContainment(currentPhysical, requiredContainment)
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
        const deadlines = await loadDeadlines(this.ctx.storage);
        const next = armDeadline(
          deadlines,
          'credentialExpiry',
          Math.min(...updated.map(grant => grant.expiresAt))
        );
        await saveDeadlines(this.ctx.storage, next);
        if (deadlines.credentialExpiry === undefined) {
          await this.appendLog(deadlineTransition(Date.now(), 'credentialExpiry', 'armed'));
        }
        await this.scheduleAlarm(next);
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
        const physical = await loadPhysicalRecord(this.ctx.storage);
        const native = decodeCloudflareProviderRef(physical.providerRef);
        if (
          alias?.sandboxId !== this.sandboxId ||
          this.providerKind !== 'cloudflare' ||
          physical.state !== 'running' ||
          !native ||
          input.outboundContainerId !==
            getOutboundContainerId(this.env, native.sandboxId, { managedScmContainment: true })
        ) {
          return null;
        }
        if (!this.matchesContainment(physical, WORKTREE_CREDENTIAL_CONTAINMENT)) return null;
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
            const current = await loadPhysicalRecord(this.ctx.storage);
            if (
              current.providerRef !== physical.providerRef ||
              !sameAllocation(current, physical) ||
              !this.matchesContainment(current, WORKTREE_CREDENTIAL_CONTAINMENT) ||
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

  ensureReady(input: {
    ownerId: string;
    sessionId: string;
    provider?: AgentSandboxProvider;
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
    const requiredContainment = getWorktreeCredentialContainment(
      requiresContainmentSandbox(metadata)
    );
    if (input.worktreeId !== undefined && input.worktreeId !== worktreeId) {
      throw new Error('Worktree identity conflict');
    }
    this.assertWorktreeAdmission(worktreeId);
    if (this.runtimeDeleted) {
      await this.ctx.storage.delete(RUNTIME_DELETED_KEY);
      this.runtimeDeleted = false;
    }
    await this.pinProvider(input.provider);
    if (acquisition && this.providerKind !== 'cloudflare') {
      throw new Error('Sandbox acquisition is only supported for Cloudflare');
    }
    const billing = await this.billingInput(ownerId, input.billing, worktreeId);
    let physical: PhysicalRecord;
    let creating = false;
    if (acquisition) {
      let selected = await this.acquirePhysical(acquisition, requiredContainment, worktreeId);
      if (selected.action === 'wait') {
        const step = nextEnsureReadyStep(selected.physical.state, true);
        if (step === 'release-failed') {
          await this.releaseIfAuthoritativelyDead(selected.physical);
          selected = await this.acquirePhysical(acquisition, requiredContainment, worktreeId);
        } else if (step === 'observe-unknown') {
          await this.observeCurrentProvider(selected.physical);
          selected = await this.acquirePhysical(acquisition, requiredContainment, worktreeId);
        }
      }
      if (selected.action === 'wait') return this.statusForPhysical(selected.physical);
      physical = selected.physical;
      creating = selected.action === 'create';
    } else {
      const allowCreate = input.allowCreate === true;
      physical = await loadPhysicalRecord(this.ctx.storage, this.provider.resumable);
      if (nextEnsureReadyStep(physical.state, allowCreate) === 'release-failed') {
        physical = await this.releaseIfAuthoritativelyDead(physical);
      }
      if (nextEnsureReadyStep(physical.state, allowCreate) === 'observe-unknown') {
        physical = await this.observeCurrentProvider(physical);
      }
      if (nextEnsureReadyStep(physical.state, allowCreate) === 'create') {
        physical = await this.withCredentialUpdate(async () => {
          const current = await loadPhysicalRecord(this.ctx.storage, this.provider.resumable);
          if (nextEnsureReadyStep(current.state, allowCreate) !== 'create') return current;
          const intentId = crypto.randomUUID();
          const allocationName = await deriveSandboxAllocationId(this.sandboxId, intentId);
          this.assertWorktreeAdmission(worktreeId);
          const claimed = await this.claimCreate(
            intentId,
            this.provider.resumable,
            allocationName,
            requiredContainment
          );
          creating = true;
          return claimed;
        });
      }
    }
    const currentStatus = () =>
      acquisition ? this.acquisitionStatus(acquisition, physical) : this.getStatus();
    if (creating) this.provider = this.createProviderAdapter(this.providerKind, physical);
    if (physical.stopTombstone || (physical.state !== 'creating' && physical.state !== 'running')) {
      return currentStatus();
    }
    if (!this.matchesContainment(physical, requiredContainment)) {
      if (this.matchesWorktreeContainment(physical)) {
        throw new Error('Sandbox containment mode conflicts with the session');
      }
      await this.beginStop('credential_containment_unavailable');
      await this.recordStopAttempt();
      return currentStatus();
    }
    if (!creating && physical.state === 'running' && physical.providerRef !== null) {
      await withTimeout(
        this.provider.ensureBillingAdmission(physical.providerRef, billing),
        DEADLINE_MS.stopAttempt,
        'Sandbox billing admission timed out'
      );
      const current = await loadPhysicalRecord(this.ctx.storage);
      if (
        !sameAllocation(current, physical) ||
        current.providerRef !== physical.providerRef ||
        current.state !== 'running' ||
        current.stopTombstone
      ) {
        throw new Error('Sandbox runtime changed during billing admission');
      }
    }
    const preparationDeadline = Math.min(
      acquisition?.deadlineAt ?? Number.MAX_SAFE_INTEGER,
      Date.now() + DEADLINE_MS.startup
    );
    let attachment: SessionAttachPayload;
    try {
      attachment = await withTimeout(
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
      const current = await loadPhysicalRecord(this.ctx.storage);
      if (
        creating &&
        sameAllocation(current, physical) &&
        !current.stopTombstone &&
        (current.state === 'creating' || current.state === 'running')
      ) {
        await this.markFailed();
      }
      throw error;
    }
    if (creating) {
      this.provider = this.createProviderAdapter(this.providerKind, physical);
      const intent = physical.createIntent;
      if (!intent) throw new Error('Sandbox create intent is unavailable');
      const networkPolicy =
        this.providerKind === 'vercel' && requiredContainment.kilocode
          ? await this.withCredentialUpdate(async () =>
              buildControlNetworkPolicy(
                (await loadSessionCredentialGrants(this.ctx.storage)).filter(
                  grant => grant.expiresAt > Date.now()
                )
              )
            )
          : undefined;
      const credential = generateSandboxCredential();
      const credentialHash = await hashSandboxCredential(credential);
      const beforeCreate = await loadPhysicalRecord(this.ctx.storage);
      if (!sameAllocation(beforeCreate, physical) || beforeCreate.stopTombstone) {
        return currentStatus();
      }
      await this.ctx.storage.put(CREDENTIAL_HASH_KEY, credentialHash);
      await this.appendLog(credentialTransition(Date.now(), 'issued'));
      const provider = this.provider;
      let phase: 'create' | 'launch' = 'create';
      let startedAt = Date.now();
      let timedOut = false;
      try {
        this.assertWorktreeAdmission(worktreeId);
        if (acquisition) assertAcquisitionDeadline(acquisition);
        this.logDiagnostic('allocation_launch', {
          allocationId: intent.intentId,
          phase,
          result: 'started',
        });
        const created = await withTimeout(
          provider.create({
            ...intent,
            ...(billing ? { billing } : {}),
            ...(networkPolicy ? { networkPolicy } : {}),
          }),
          DEADLINE_MS.startup,
          'Sandbox allocation timed out',
          () => {
            timedOut = true;
          }
        );
        this.logDiagnostic('allocation_launch', {
          allocationId: intent.intentId,
          phase,
          result: 'providerRef' in created ? 'completed' : 'unresolved',
          durationMs: Date.now() - startedAt,
        });
        if ('providerRef' in created) {
          const launchEnv = await this.wrapperLaunchEnv(credential, intent.intentId);
          const current = await loadPhysicalRecord(this.ctx.storage);
          if (!sameAllocation(current, physical)) return currentStatus();
          if (current.stopTombstone) {
            await savePhysicalRecord(this.ctx.storage, {
              ...current,
              providerRef: created.providerRef,
            });
            return currentStatus();
          }
          await this.confirmInstance(created.providerRef);
          const allocated = await loadPhysicalRecord(this.ctx.storage);
          if (!sameAllocation(allocated, physical) || allocated.stopTombstone) {
            return currentStatus();
          }
          this.assertWorktreeAdmission(worktreeId);
          if (acquisition) assertAcquisitionDeadline(acquisition);
          phase = 'launch';
          startedAt = Date.now();
          this.logDiagnostic('allocation_launch', {
            allocationId: intent.intentId,
            phase,
            result: 'started',
          });
          await withTimeout(
            provider.launch(created.providerRef, launchEnv),
            DEADLINE_MS.startup,
            'Sandbox wrapper launch timed out',
            () => {
              timedOut = true;
            }
          );
          this.logDiagnostic('allocation_launch', {
            allocationId: intent.intentId,
            phase,
            result: 'completed',
            durationMs: Date.now() - startedAt,
          });
        }
      } catch {
        this.logDiagnostic(
          'allocation_launch',
          {
            result: timedOut ? 'timed_out' : 'failed',
            phase,
            durationMs: Date.now() - startedAt,
            allocationId: physical.createIntent?.intentId,
          },
          'warn'
        );
        const current = await loadPhysicalRecord(this.ctx.storage);
        if (
          sameAllocation(current, physical) &&
          !current.stopTombstone &&
          !this.readyWrapperRuntime() &&
          (current.state === 'creating' || current.state === 'running')
        ) {
          await this.markFailed();
        }
      }
    }
    if (
      this.providerKind === 'vercel' &&
      (await loadPhysicalRecord(this.ctx.storage)).state === 'running'
    ) {
      await this.enforceWorktreeNetworkPolicy(ownerId);
    }
    const status = await this.ctx.storage.transaction(async () => {
      const current = await loadPhysicalRecord(this.ctx.storage);
      if (
        !sameAllocation(current, physical) ||
        (physical.providerRef !== null && current.providerRef !== physical.providerRef) ||
        (acquisition && !(await this.bindAcquisition(acquisition, current)))
      ) {
        throw new Error('Sandbox allocation changed during readiness');
      }
      return this.statusForPhysical(current);
    });
    return { ...status, attachment };
  }

  private async acquirePhysical(
    acquisition: SandboxAcquisition,
    requiredContainment: CredentialContainmentRequirements,
    worktreeId?: string
  ): Promise<{
    physical: PhysicalRecord;
    action: 'create' | 'reuse' | 'wait';
  }> {
    const intentId = crypto.randomUUID();
    const allocationName = await deriveSandboxAllocationId(this.sandboxId, intentId);
    return this.ctx.storage.transaction(async () => {
      const physical = await loadPhysicalRecord(this.ctx.storage, this.provider.resumable);
      this.assertWorktreeAdmission(worktreeId);
      if (
        this.matchesWorktreeContainment(physical) &&
        !this.matchesContainment(physical, requiredContainment)
      ) {
        throw new Error('Sandbox containment mode conflicts with the session');
      }
      if (await this.bindAcquisition(acquisition, physical)) return { physical, action: 'reuse' };
      if (physical.state !== 'stopped' || physical.stopTombstone) {
        return { physical, action: 'wait' };
      }
      const next = claimCreate(physical, intentId, Date.now(), allocationName, requiredContainment);
      await this.persistPhysicalState(physical, next, 'demand');
      await this.bindAcquisition(acquisition, next);
      return { physical: next, action: 'create' };
    });
  }

  private async bindAcquisition(
    acquisition: SandboxAcquisition,
    physical: PhysicalRecord
  ): Promise<boolean> {
    const raw = await this.ctx.storage.get<unknown>(ACQUISITION_RECEIPTS_KEY);
    const stored = raw === undefined ? [] : acquisitionReceiptsSchema.parse(raw);
    assertAcquisitionDeadline(acquisition);
    const receipts = stored.filter(receipt => receipt.deadlineAt > Date.now());
    const receipt = stored.find(receipt => receipt.id === acquisition.id);
    const allocation = allocationIdentity(physical);
    if (receipt) {
      if (receipt.deadlineAt !== acquisition.deadlineAt) {
        throw new Error('Sandbox acquisition deadline changed');
      }
      if (
        !allocation ||
        receipt.allocation.kind !== allocation.kind ||
        receipt.allocation.id !== allocation.id
      ) {
        throw new Error('Sandbox acquisition no longer owns this allocation');
      }
    }
    const available =
      !physical.stopTombstone && (physical.state === 'creating' || physical.state === 'running');
    if (!receipt && available) {
      if (!allocation) throw new Error('Sandbox allocation identity is unavailable');
      receipts.push({ ...acquisition, allocation });
    }
    if (receipts.length !== stored.length || (!receipt && available)) {
      await this.ctx.storage.put(ACQUISITION_RECEIPTS_KEY, receipts);
    }
    return receipt !== undefined || available;
  }

  private async acquisitionStatus(
    acquisition: SandboxAcquisition,
    expected: PhysicalRecord
  ): Promise<SandboxControlStatus> {
    return this.ctx.storage.transaction(async () => {
      const current = await loadPhysicalRecord(this.ctx.storage);
      if (
        !sameAllocation(expected, current) ||
        !(await this.bindAcquisition(acquisition, current))
      ) {
        throw new Error('Sandbox acquisition no longer owns this allocation');
      }
      return this.statusForPhysical(current);
    });
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
    const physical = await loadPhysicalRecord(this.ctx.storage);
    if (physical.state !== 'running' || physical.providerRef === null) {
      throw new Error('Sandbox network policy requires a running instance');
    }
    const providerRef = physical.providerRef;
    if (!this.matchesProviderReference(physical, providerRef)) {
      throw new Error('Sandbox network policy requires an exact provider reference');
    }
    if (
      (!input.requiredContainment.kilocode && !input.requiredContainment.github) ||
      !this.matchesContainment(physical, input.requiredContainment)
    ) {
      throw new Error('Sandbox credential containment mismatch');
    }
    const provider = this.provider;
    if (!provider.updateNetworkPolicy) {
      throw new Error('Sandbox provider does not support network policy updates');
    }
    await withTimeout(
      provider.updateNetworkPolicy(providerRef, input.networkPolicy),
      DEADLINE_MS.stopAttempt,
      'Sandbox network policy update timed out'
    );

    const currentProviderKind = await this.ctx.storage.get<AgentSandboxProvider>(PROVIDER_KIND_KEY);
    const currentPhysical = await loadPhysicalRecord(this.ctx.storage);
    const currentOwnerId = await this.readOwner();
    if (
      currentProviderKind !== 'vercel' ||
      currentOwnerId !== ownerId ||
      currentPhysical.state !== 'running' ||
      currentPhysical.providerRef !== providerRef ||
      !this.matchesContainment(currentPhysical, input.requiredContainment)
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
        !this.matchesContainment(
          await loadPhysicalRecord(this.ctx.storage),
          getWorktreeCredentialContainment(grant.containmentEnabled !== false)
        )
      ) {
        throw new Error('Sandbox credential containment mismatch');
      }
      const result = await this.mutateRoutes(table => {
        this.assertWorktreeAdmission(worktreeId);
        const attached = attachRoute(table, input, ownerId);
        return { value: attached, changed: attached.changed };
      });
      if (result.changed) {
        await this.appendLog(
          routeTransition(Date.now(), 'attach', input.sessionId, input.kiloSessionId)
        );
      }
      return result.route;
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
          const detached = runtimeDetached
            ? detachRoute(table, sessionId)
            : { table, existed: false };
          await saveRouteTable(this.ctx.storage, detached.table);
          const grants = await loadSessionCredentialGrants(this.ctx.storage);
          if (grants.some(grant => grant.members.some(member => member.sessionId === sessionId))) {
            if (this.providerKind === 'vercel') {
              await this.ctx.storage.put(CREDENTIAL_POLICY_DIRTY_KEY, true);
            }
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
        this.sessionForwarding.delete(sessionId);
        await this.appendLog(routeTransition(Date.now(), 'detach', sessionId));
      }
      if (!hasActiveWork(result.table)) {
        const physical = await loadPhysicalRecord(this.ctx.storage);
        if (physical.state === 'running' && !physical.stopTombstone) {
          await this.armDeadlineIfAbsent('idleStop', Date.now() + DEADLINE_MS.idleStop);
        }
      }
    }
    return { existed };
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
      await this.pinProvider(input.location.provider);
      return this.provider;
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
        if ((await loadPhysicalRecord(this.ctx.storage)).state !== 'stopped') await getProvider();
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
    const detached = await this.mutateRoutes(table => {
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
      return { value: sessionIds, changed: sessionIds.length > 0 };
    });
    await Promise.allSettled(detached.flatMap(id => this.sessionForwarding.get(id) ?? []));
    for (const id of detached) this.sessionForwarding.delete(id);
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
      await this.ctx.storage.deleteAlarm();
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

  private async stopDeletedWorktreeRuntime(): Promise<PhysicalRecord> {
    const physical = await this.beginStop('worktree_deleted');
    if (physical.state === 'stopped') return physical;
    if ((physical.stopTombstone?.attempts ?? 0) >= DEADLINE_MS.stopAttemptLadder.length) {
      return this.observeCurrentProvider(physical);
    }
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
      const receipts = await loadWorktreeDeletionJournals(this.ctx.storage);
      const releasedWorktreeIds = [...receipts]
        .filter(([, receipt]) => receipt.resourcesCleaned)
        .map(([id]) => id);
      const released = new Set<string>(releasedWorktreeIds);
      const requestedIds = new Set(input.sessionIds);
      const otherRoutes = [...(await loadRouteTable(this.ctx.storage)).values()].some(route => {
        const worktreeId = route.worktreeId ?? this.worktreeIdFromDirectory(route.directory);
        if (worktreeId && released.has(worktreeId)) return false;
        return (
          route.directory !== directory ||
          !requestedIds.has(route.kiloSessionId) ||
          (worktreeId !== undefined && worktreeId !== input.worktreeId)
        );
      });
      const exclusive =
        !otherRoutes &&
        (await withTimeout(
          resolveSandboxExclusivity(this.env, {
            worktreeId: input.worktreeId,
            kiloUserId: input.kiloUserId,
            organizationId: input.organizationId,
            location: input.location,
            releasedWorktreeIds,
          }),
          DEADLINE_MS.stopAttempt,
          'Worktree ownership lookup timed out'
        ));
      if (exclusive) return true;
    } catch (error) {
      await this.releaseWorktreeAdmission(input.worktreeId);
      throw error;
    }
    await this.releaseWorktreeAdmission(input.worktreeId);
    return false;
  }

  private async releaseWorktreeAdmission(worktreeId: string): Promise<void> {
    if (this.exclusiveDeletionWorktreeId !== worktreeId) return;
    await this.ctx.storage.delete(EXCLUSIVE_DELETION_KEY);
    this.exclusiveDeletionWorktreeId = undefined;
    if (!this.runtimeDeleted) await this.scheduleAlarm(await loadDeadlines(this.ctx.storage));
  }

  private worktreeIdFromDirectory(directory: string): string | undefined {
    const parsed = cloudAgentWorktreeIdSchema.safeParse(directory.split('/').at(-1));
    return parsed.success ? parsed.data : undefined;
  }

  private async assertRequestWorktreeAdmission(
    input: SandboxControlOutboundRequest
  ): Promise<void> {
    const session = input.session;
    if (!session) return;
    const worktreeId = this.worktreeIdFromDirectory(session.directory);
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

    const enforced = isCloudAgentContainerBillingEnabled(this.env, {
      userId: input.ownerId,
      ...(input.organizationId ? { orgId: input.organizationId } : {}),
    });
    if (!enforced) return this.renewTerminalCredentialLease(input, runtime);
    if (runtime.provider !== 'cloudflare') {
      return { allowed: false, reason: 'billing_policy_unavailable' };
    }

    let billing: SandboxTerminalAccessResult;
    try {
      const providerRef = decodeCloudflareProviderRef(runtime.physical.providerRef);
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
      left.physical.providerRef === right.physical.providerRef &&
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

    const deadlines = await loadDeadlines(this.ctx.storage);
    if (!this.isCurrentConnection(runtime.connection)) {
      return { allowed: false, reason: 'runtime_changed' };
    }
    const nextDeadline = Math.max(deadlines.idleStop ?? 0, Date.now() + DEADLINE_MS.idleStop);
    if (nextDeadline !== deadlines.idleStop) {
      await this.armDeadlineAndAlarm('idleStop', nextDeadline);
    }
    if (!this.isCurrentConnection(runtime.connection)) {
      return { allowed: false, reason: 'runtime_changed' };
    }
    await this.renewProviderLease(runtime.connection);
    return { allowed: true };
  }

  async getStatus(): Promise<SandboxControlStatus> {
    await this.ensureOperationalInitialized();
    return this.statusForPhysical(await loadPhysicalRecord(this.ctx.storage));
  }

  private async statusForPhysical(physical: PhysicalRecord): Promise<SandboxControlStatus> {
    const connection = this.connectionState();
    const work = await this.workState();
    const runtime = this.readyWrapperRuntime();
    return {
      reported: projectReportedStatus({ physical: physical.state, connection, work }),
      physical: physical.state,
      connection,
      work,
      ...(physical.state === 'running' && runtime?.wrapperInstanceId
        ? { wrapperInstanceId: runtime.wrapperInstanceId }
        : {}),
      ...(typeof this.socketHandler.supportsOperationResults === 'function' &&
      this.socketHandler.supportsOperationResults()
        ? { operationResults: true as const }
        : {}),
    };
  }

  async getSandboxStatus(input: {
    ownerId: string;
    provider: AgentSandboxProvider;
  }): Promise<SandboxStatusSnapshot> {
    const [stored, ownerId, provider, runtime] = await Promise.all([
      readSandboxControlState(this.ctx.storage),
      this.readOwner(),
      this.ctx.storage.get<unknown>(PROVIDER_KIND_KEY),
      this.ctx.storage.get<unknown>(ACTIVE_WRAPPER_RUNTIME_KEY),
    ]);
    const matches =
      ownerId !== null &&
      ownerId === input.ownerId &&
      (provider === 'cloudflare' || provider === 'vercel') &&
      provider === input.provider;
    return projectSandboxStatus({
      stored: matches ? stored : { physical: null, deadlines: null, routes: null },
      connection: readSandboxControlConnection(
        this.ctx,
        stored.physical?.providerRef ?? null,
        runtime
      ),
      ownerId,
      provider: matches ? provider : undefined,
      now: Date.now(),
    });
  }

  async getPhysicalRecord(): Promise<PhysicalRecord> {
    await this.ensureOperationalInitialized();
    return loadPhysicalRecord(this.ctx.storage);
  }

  async getTransitionLog(): Promise<TransitionRow[]> {
    await this.ensureOperationalInitialized();
    return loadTransitionLog(this.ctx.storage);
  }

  async claimCreate(
    intentId: string,
    resumable = false,
    allocationName?: string,
    containment?: CredentialContainmentRequirements
  ): Promise<PhysicalRecord> {
    await this.ensureOperationalInitialized();
    return this.ctx.storage.transaction(async () => {
      const current = await loadPhysicalRecord(this.ctx.storage, resumable);
      this.assertWorktreeAdmission();
      const next = claimCreate(current, intentId, Date.now(), allocationName, containment);
      const vercel =
        this.providerKind === 'vercel' ? parseVercelSandboxRuntimeConfig(this.env) : undefined;
      if (vercel && next.createIntent) {
        const { projectId, snapshotId, runtimeBuildId, runtime } = vercel;
        next.createIntent = {
          ...next.createIntent,
          vercel: { projectId, snapshotId, runtimeBuildId, runtime },
        };
        this.vercelLocator = vercelProviderLocatorSchema.parse({
          teamId: vercel.teamId,
          projectId,
          snapshotId,
          runtimeBuildId,
          runtime,
        });
        await this.ctx.storage.put(PROVIDER_LOCATOR_KEY, this.vercelLocator);
        this.provider = this.createProviderAdapter('vercel', next);
      }
      await this.persistPhysicalState(current, next, 'demand');
      return next;
    });
  }

  async confirmInstance(providerRef: string): Promise<PhysicalRecord> {
    await this.ensureOperationalInitialized();
    const current = await loadPhysicalRecord(this.ctx.storage);
    const next = confirmRunning(current, providerRef, Date.now());
    await this.persistPhysical(current, next, 'instance confirmed');
    return next;
  }

  async observeProvider(result: ObserveResult): Promise<PhysicalRecord> {
    await this.ensureOperationalInitialized();
    const current = await loadPhysicalRecord(this.ctx.storage);
    let next = observe(current, result);
    if ((next.state === 'failed' || next.state === 'unknown') && !next.stopTombstone) {
      next = {
        ...next,
        stopTombstone: beginStop(
          next,
          next.state === 'unknown' ? 'provider_unknown' : 'environment_failed',
          Date.now(),
          this.activeConnection?.wrapperInstanceId
        ).stopTombstone,
      };
    }
    await this.persistPhysical(current, next, `observe:${result}`);
    if (shouldRearmReconciliation(next.state)) {
      await this.rearmReconciliation(next);
    }
    return next;
  }

  async beginStop(reason: string): Promise<PhysicalRecord> {
    await this.ensureOperationalInitialized();
    const current = await loadPhysicalRecord(this.ctx.storage);
    if (current.state === 'stopped' || current.stopTombstone) return current;
    const next = beginStop(current, reason, Date.now(), this.activeConnection?.wrapperInstanceId);
    await this.persistPhysical(current, next, reason);
    return next;
  }

  async recordStopAttempt(): Promise<PhysicalRecord> {
    await this.ensureOperationalInitialized();
    const current = await loadPhysicalRecord(this.ctx.storage);
    if (this.stopAttemptInFlight && sameAllocation(this.stopAttemptInFlight.physical, current)) {
      this.logDiagnostic('stop_coalesced', {
        allocationId: current.createIntent?.intentId,
        stopAttempts: current.stopTombstone?.attempts,
      });
      return this.stopAttemptInFlight.promise;
    }
    const pending = { physical: current, promise: this.performStopAttempt(current) };
    this.stopAttemptInFlight = pending;
    try {
      return await pending.promise;
    } finally {
      if (this.stopAttemptInFlight === pending) this.stopAttemptInFlight = null;
    }
  }

  private async performStopAttempt(current: PhysicalRecord): Promise<PhysicalRecord> {
    if (!current.stopTombstone || current.state === 'stopped') return current;
    if (current.stopTombstone.attempts >= DEADLINE_MS.stopAttemptLadder.length) {
      if (current.state === 'stopping') return this.exhaustStop();
      await this.repairLifecycleScheduling(current);
      return current;
    }
    const next = recordStopAttempt(beginStop(current, current.stopTombstone.reason, Date.now()));
    await this.persistPhysical(current, next, 'stop attempt');
    let target = next;
    if (target.providerRef === null) {
      target = await this.observeCurrentProvider(target);
    }
    if (sameAllocation(target, next) && target.providerRef !== null && target.state !== 'stopped') {
      const terminal = await this.stopCurrentProvider(target);
      const latest = await loadPhysicalRecord(this.ctx.storage);
      if (!sameAllocation(latest, next)) return latest;
      if (terminal && !this.isCreationSettling(latest)) return this.confirmStopped();
      await this.observeCurrentProvider(latest);
    }
    const latest = await loadPhysicalRecord(this.ctx.storage);
    if (!sameAllocation(latest, next) || !latest.stopTombstone) return latest;
    const attempts = latest.stopTombstone.attempts;
    if (attempts >= DEADLINE_MS.stopAttemptLadder.length) {
      return this.exhaustStop();
    }
    const delay = DEADLINE_MS.stopAttemptLadder[attempts - 1] ?? DEADLINE_MS.stopAttempt;
    await this.armDeadlineAndAlarm('stopAttempt', Date.now() + delay);
    return latest;
  }

  private async stopCurrentProvider(physical: PhysicalRecord): Promise<boolean> {
    let pending = this.providerStopInFlight;
    if (!pending || !sameAllocation(pending.physical, physical)) {
      const startedAt = Date.now();
      const diagnostic = {
        allocationId: physical.createIntent?.intentId,
        wrapperInstanceId: physical.stopTombstone?.wrapperInstanceId,
        stopAttempts: physical.stopTombstone?.attempts,
        physicalState: physical.state,
        cleanupAgeMs: physical.stopTombstone
          ? startedAt - physical.stopTombstone.createdAt
          : undefined,
      };
      let timedOut = false;
      this.logDiagnostic('provider_stop', { ...diagnostic, result: 'started' });
      pending = {
        physical,
        promise: withTimeout(
          this.provider.stop(physical.providerRef, physical.createIntent),
          DEADLINE_MS.stopAttempt,
          'Sandbox stop attempt timed out',
          () => {
            timedOut = true;
          }
        ).then(
          result => {
            this.logDiagnostic('provider_stop', {
              ...diagnostic,
              result,
              durationMs: Date.now() - startedAt,
            });
            return result;
          },
          error => {
            this.logDiagnostic(
              'provider_stop',
              {
                ...diagnostic,
                result: timedOut ? 'timed_out' : 'failed',
                durationMs: Date.now() - startedAt,
              },
              'warn'
            );
            throw error;
          }
        ),
      };
      this.providerStopInFlight = pending;
      const issued = pending;
      const clear = () => {
        if (this.providerStopInFlight === issued) this.providerStopInFlight = null;
      };
      void issued.promise.then(clear, clear);
    }
    try {
      return (await pending.promise) === 'terminal';
    } catch {
      return false;
    }
  }

  private isCreationSettling(physical: PhysicalRecord): boolean {
    return (
      physical.createIntent !== null &&
      !physical.stopTombstone?.wrapperInstanceId &&
      Date.now() < physical.createIntent.createdAt + DEADLINE_MS.createSettle
    );
  }

  private shouldSlowReap(physical: PhysicalRecord): boolean {
    return (
      this.providerKind === 'cloudflare' &&
      physical.state !== 'stopped' &&
      physical.stopTombstone !== null &&
      physical.stopTombstone.attempts >= DEADLINE_MS.stopAttemptLadder.length
    );
  }

  private async reapExhaustedAllocation(physical: PhysicalRecord): Promise<void> {
    const target = await this.ctx.storage.transaction(async () => {
      const current = await loadPhysicalRecord(this.ctx.storage);
      const deadlines = await loadDeadlines(this.ctx.storage);
      if (
        !sameAllocation(current, physical) ||
        !this.shouldSlowReap(current) ||
        deadlines.reconciliation === undefined ||
        deadlines.reconciliation > Date.now()
      )
        return null;
      const next = armDeadline(
        deadlines,
        'reconciliation',
        Date.now() + DEADLINE_MS.reconciliation
      );
      await saveDeadlines(this.ctx.storage, next);
      await this.scheduleAlarm(next);
      return current;
    });
    if (!target) return;
    this.logDiagnostic('slow_reap', {
      allocationId: target.createIntent?.intentId,
      stopAttempts: target.stopTombstone?.attempts,
      cleanupAgeMs: target.stopTombstone ? Date.now() - target.stopTombstone.createdAt : undefined,
    });
    const observed = await this.observeCurrentProvider(target);
    if (!sameAllocation(observed, physical) || !this.shouldSlowReap(observed)) return;
    const terminal = await this.stopCurrentProvider(observed);
    const current = await loadPhysicalRecord(this.ctx.storage);
    if (
      sameAllocation(current, physical) &&
      this.shouldSlowReap(current) &&
      terminal &&
      !this.isCreationSettling(current)
    ) {
      await this.confirmStopped();
    }
  }

  async confirmStopped(): Promise<PhysicalRecord> {
    await this.ensureOperationalInitialized();
    const current = await loadPhysicalRecord(this.ctx.storage);
    const next = confirmStopped(current);
    await this.persistPhysical(current, next, 'terminal');
    return next;
  }

  async markFailed(): Promise<PhysicalRecord> {
    await this.ensureOperationalInitialized();
    const current = await loadPhysicalRecord(this.ctx.storage);
    const next = fail(current, Date.now());
    await this.persistPhysical(current, next, 'failed');
    await this.ctx.storage.put(DIAGNOSTIC_BUNDLE_KEY, {
      at: Date.now(),
      from: current.state,
      to: next.state,
      connection: this.connectionState(),
      logTail: (await loadTransitionLog(this.ctx.storage)).slice(-20),
    });
    return next;
  }

  async eraseRecord(options?: { preserveAcquisitionReceipts: true }): Promise<void> {
    await this.ensureOperationalInitialized();
    await eraseSandboxRecord(this.ctx.storage);
    await this.ctx.storage.delete([
      OWNER_ID_KEY,
      CREDENTIAL_HASH_KEY,
      WRAPPER_READY_AT_KEY,
      ACTIVE_WRAPPER_RUNTIME_KEY,
      DIAGNOSTIC_BUNDLE_KEY,
      PROVIDER_KIND_KEY,
      BILLING_INPUT_KEY,
      CREDENTIAL_POLICY_DIRTY_KEY,
      PROVIDER_LOCATOR_KEY,
      ...(options?.preserveAcquisitionReceipts ? [] : [ACQUISITION_RECEIPTS_KEY]),
    ]);
    this.vercelLocator = undefined;
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
      await this.armDeadlineAndAlarm('credentialExpiry', expiry);
    } else {
      await this.cancelDeadlineAndAlarm('credentialExpiry');
    }
  }

  private refreshWorktreeNetworkPolicy(ownerId: string): Promise<void> {
    return this.withCredentialUpdate(async () => {
      if (this.providerKind !== 'vercel') return;
      await this.ctx.storage.put(CREDENTIAL_POLICY_DIRTY_KEY, true);
      const physical = await loadPhysicalRecord(this.ctx.storage);
      if (physical.state === 'stopped') {
        await this.ctx.storage.delete(CREDENTIAL_POLICY_DIRTY_KEY);
        return;
      }
      if (
        this.matchesWorktreeContainment(physical) &&
        !(physical.createIntent?.containment ?? physical.containment)?.kilocode
      ) {
        await this.ctx.storage.delete(CREDENTIAL_POLICY_DIRTY_KEY);
        await this.cancelDeadlineAndAlarm('credentialExpiry');
        return;
      }
      if (physical.state !== 'running') {
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
    const expected = await loadPhysicalRecord(this.ctx.storage);
    try {
      await this.refreshWorktreeNetworkPolicy(ownerId);
    } catch {
      let physical = await loadPhysicalRecord(this.ctx.storage);
      if (
        !sameAllocation(physical, expected) ||
        (expected.providerRef !== null && physical.providerRef !== expected.providerRef)
      ) {
        return;
      }
      if (physical.state === 'running' || physical.state === 'creating') {
        physical = await this.markFailed();
      }
      if (physical.state === 'failed') {
        physical = await this.releaseIfAuthoritativelyDead(physical);
      }
      if (
        this.providerKind === 'vercel' &&
        physical.state === 'unknown' &&
        physical.stopTombstone &&
        physical.stopTombstone.attempts >= DEADLINE_MS.stopAttemptLadder.length &&
        Date.now() >= physical.stopTombstone.createdAt + DEADLINE_MS.reconciliationWindow
      ) {
        const observed = await this.observeCurrentProvider(physical);
        if (!sameAllocation(physical, observed)) return;
        physical = observed;
      }
      if (physical.state !== 'stopped') {
        throw new Error('Sandbox credential revocation is pending');
      }
    }
  }

  private createProviderAdapter(
    kind: AgentSandboxProvider,
    physical?: PhysicalRecord
  ): ProviderAdapter {
    const allocationName = physical?.createIntent?.allocationName ?? this.sandboxId;
    if (kind === 'vercel') {
      const locator = physical?.state === 'stopped' ? undefined : this.vercelLocator;
      const config = resolveVercelSandboxRuntimeConfig(
        this.env,
        physical?.createIntent?.vercel ?? locator
      );
      return createVercelProviderAdapter({
        sandboxName: allocationName,
        config: config && locator ? { ...config, teamId: locator.teamId } : config,
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

  private async pinProvider(requested?: AgentSandboxProvider): Promise<void> {
    const stored = await this.ctx.storage.get<AgentSandboxProvider>(PROVIDER_KIND_KEY);
    const kind = stored ?? requested ?? 'cloudflare';
    if (stored !== undefined && requested !== undefined && stored !== requested) {
      throw new Error('Sandbox provider mismatch');
    }
    if (kind === 'vercel' && parseVercelSandboxRuntimeConfig(this.env) === undefined) {
      throw new Error('Vercel sandbox runtime configuration is unavailable');
    }
    if (stored === undefined) {
      await this.ctx.storage.put(PROVIDER_KIND_KEY, kind);
    }
    this.providerKind = kind;
    this.provider = this.createProviderAdapter(kind, await loadPhysicalRecord(this.ctx.storage));
  }

  private async billingInput(
    ownerId: string,
    supplied?: SandboxBillingInput,
    worktreeId?: string
  ): Promise<SandboxBillingInput | undefined> {
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

  private matchesProviderReference(physical: PhysicalRecord, providerRef: string): boolean {
    if (physical.providerRef !== null && physical.providerRef !== providerRef) return false;
    const allocationName = physical.createIntent?.allocationName ?? this.sandboxId;
    if (this.providerKind === 'vercel') {
      return decodeVercelProviderRef(providerRef)?.sandboxName === allocationName;
    }
    const native = decodeCloudflareProviderRef(providerRef);
    const containment = physical.createIntent?.containment ?? physical.containment;
    return (
      native?.sandboxId === allocationName &&
      containment !== undefined &&
      native.containment === (containment.kilocode || containment.github) &&
      (!physical.createIntent || native.instanceId === physical.createIntent.intentId)
    );
  }

  private matchesWorktreeContainment(physical: PhysicalRecord): boolean {
    const containment =
      physical.state === 'creating' ? physical.createIntent?.containment : physical.containment;
    return (
      containment?.worktreeScoped === true &&
      containment.kilocode === containment.github &&
      this.matchesContainment(physical, containment)
    );
  }

  private matchesContainment(
    physical: PhysicalRecord,
    requiredContainment: CredentialContainmentRequirements
  ): boolean {
    if (physical.stopTombstone) return false;
    if (physical.state === 'creating') {
      const containment = physical.createIntent?.containment;
      return (
        containment !== undefined &&
        containment.kilocode === requiredContainment.kilocode &&
        containment.github === requiredContainment.github &&
        containment.worktreeScoped === requiredContainment.worktreeScoped
      );
    }
    if (physical.state !== 'running' || physical.providerRef === null) {
      return false;
    }
    const referenceMatches = this.matchesProviderReference(physical, physical.providerRef);
    const containment = physical.containment;
    return (
      referenceMatches &&
      containment !== undefined &&
      containment.providerRef === physical.providerRef &&
      containment.kilocode === requiredContainment.kilocode &&
      containment.github === requiredContainment.github &&
      containment.worktreeScoped === requiredContainment.worktreeScoped
    );
  }

  private async exhaustStop(): Promise<PhysicalRecord> {
    const current = await loadPhysicalRecord(this.ctx.storage);
    const next = exhaustStopRetries(current);
    await this.persistPhysical(current, next, 'stop retries exhausted');
    return next;
  }

  private async handleDeadline(id: DeadlineId): Promise<void> {
    if (id === 'socketHandshake') {
      this.socketHandler.closeProvisionalSockets();
      return;
    }
    if (id === 'wrapperReadiness' || id === 'startup') {
      const [physical, runtime, recovery, readyAt] = await Promise.all([
        loadPhysicalRecord(this.ctx.storage),
        this.ctx.storage.get<PersistedWrapperRuntime>(ACTIVE_WRAPPER_RUNTIME_KEY),
        loadRecoveryDecisions(this.ctx.storage),
        this.ctx.storage.get<number>(WRAPPER_READY_AT_KEY),
      ]);
      if (
        runtime?.recoveryCapable &&
        runtime.providerInstanceId === physical.providerRef &&
        (readyAt !== undefined ||
          recovery.some(
            item =>
              controlRecovery.sameRuntime(item, runtime) &&
              (item.cause !== 'activation_pending' || controlRecovery.activationCommitted(item))
          ))
      ) {
        await this.exhaustExpiredRecovery(Date.now());
        await this.reconcileExhaustedRecovery();
        return;
      }
      if (physical.state === 'creating' || physical.state === 'running') {
        await this.markFailed();
      }
      return;
    }
    if (id === 'heartbeatExpiry') {
      const connection = this.activeConnection;
      if (connection?.recoveryCapable) {
        await this.beginControlRecovery(connection, 'heartbeat_expired');
        this.socketHandler.closeHandshakenSockets(4002, 'application_report_expired');
      } else if (connection) await this.quarantineConnection(connection, 'heartbeat_expired');
      return;
    }
    if (id === 'recoveryExpiry') {
      await this.exhaustExpiredRecovery(Date.now());
      await this.reconcileExhaustedRecovery();
      return;
    }
    if (id === 'recoveryRetry') {
      await this.reconcileExhaustedRecovery();
      const connection = this.activeConnection;
      if (connection?.recoveryCapable)
        this.ctx.waitUntil(
          this.recoveryExecution.reconcile({
            identity: connection,
            isCurrent: () => this.isCurrentConnection(connection),
            acceptsPhysical: physical =>
              physical.state === 'running' &&
              physical.stopTombstone === null &&
              physical.providerRef === connection.providerInstanceId,
          })
        );
      return;
    }
    if (id === 'idleStop') {
      const physical = await loadPhysicalRecord(this.ctx.storage);
      if (physical.state === 'running') {
        await this.beginStop('idle');
        await this.recordStopAttempt();
      }
      return;
    }
    if (id === 'stopAttempt') {
      await this.recordStopAttempt();
      return;
    }
    if (id === 'credentialExpiry') {
      try {
        await this.enforceWorktreeNetworkPolicy(await this.requireOwner());
      } catch {
        await this.armDeadlineAndAlarm('credentialExpiry', Date.now() + DEADLINE_MS.reconciliation);
      }
      return;
    }
    if (id === 'nativeRetirement') {
      await this.nativeRuntimeRetirement.resume();
      return;
    }
    if (id === 'reconciliation') {
      const physical = await loadPhysicalRecord(this.ctx.storage);
      if (this.shouldSlowReap(physical)) {
        await this.reapExhaustedAllocation(physical);
      } else if (planReconciliation(physical.state) !== 'none') {
        await this.observeCurrentProvider(physical);
      }
    }
  }

  private async validateHandshake(providerInstanceId: string): Promise<boolean> {
    const physical = await loadPhysicalRecord(this.ctx.storage);
    return (
      (this.providerKind !== 'vercel' || physical.state === 'running') &&
      this.matchesProviderReference(physical, providerInstanceId) &&
      this.matchesWorktreeContainment(physical)
    );
  }

  private async onHandshakeComplete(
    identity: SandboxControlConnectionIdentity,
    runtime?: Pick<SandboxRuntimeMetadata, 'wrapperVersion'>
  ): Promise<void> {
    const socketConnection = this.socketHandler.getConnectionIdentity();
    if (!socketConnection || !this.sameConnection(socketConnection, identity)) return;

    const physical = await loadPhysicalRecord(this.ctx.storage);
    if (
      physical.stopTombstone ||
      (physical.state !== 'running' && physical.state !== 'creating') ||
      (this.providerKind === 'vercel' && physical.state !== 'running') ||
      !this.matchesProviderReference(physical, identity.providerInstanceId) ||
      !this.matchesWorktreeContainment(physical)
    ) {
      this.socketHandler.closeAll('Sandbox runtime unavailable');
      return;
    }
    const previous = this.activeConnection;
    const sameRuntime =
      previous?.recoveryCapable === true &&
      identity.recoveryCapable === true &&
      controlRecovery.sameRuntime(previous, identity);
    if (previous && !this.sameConnection(previous, identity) && !sameRuntime) {
      await this.quarantineConnection(previous, 'control_replaced');
      return;
    }
    const now = Date.now();
    const activated = await this.ctx.storage.transaction(async () => {
      const [current, storedRuntime] = await Promise.all([
        loadPhysicalRecord(this.ctx.storage),
        loadRuntimeMetadata(this.ctx.storage),
      ]);
      const connection = this.socketHandler.getConnectionIdentity();
      if (
        !connection ||
        !this.sameConnection(connection, identity) ||
        !sameAllocation(current, physical) ||
        current.stopTombstone ||
        (current.state !== 'creating' && current.state !== 'running') ||
        !this.matchesProviderReference(current, identity.providerInstanceId)
      )
        return false;
      await saveRuntimeMetadata(this.ctx.storage, {
        ...(storedRuntime ?? initialRuntimeMetadata(this.sandboxId)),
        wrapperVersion: safeSandboxRuntimeVersion(runtime?.wrapperVersion),
        kiloCliVersion: null,
      });
      const recovery = await loadRecoveryDecisions(this.ctx.storage);
      const nextRecovery =
        identity.recoveryCapable && identity.wrapperInstanceId
          ? (() => {
              const resumed = controlRecovery.beginRecovery(
                recovery.find(item => item.wrapperInstanceId === identity.wrapperInstanceId),
                { ...identity, wrapperInstanceId: identity.wrapperInstanceId },
                sameRuntime ? 'control_disconnected' : 'activation_pending',
                now
              );
              const next =
                !controlRecovery.activationCommitted(resumed) &&
                resumed.exhaustedAt === undefined &&
                now >= resumed.deadlineAt
                  ? controlRecovery.exhaustRecovery(resumed, now)
                  : resumed;
              return [...recovery.filter(item => item.episodeId !== next.episodeId), next];
            })()
          : recovery;
      await this.ctx.storage.put(ACTIVE_WRAPPER_RUNTIME_KEY, identity);
      await this.ctx.storage.delete(WRAPPER_READY_AT_KEY);
      if (current.state === 'creating') {
        const providerRef =
          current.providerRef ??
          (this.providerKind === 'cloudflare' ? identity.providerInstanceId : undefined);
        if (providerRef !== undefined) {
          await savePhysicalRecord(this.ctx.storage, confirmRunning(current, providerRef, now));
          await this.appendLog(
            physicalTransition(now, physical.state, 'running', 'hello', providerRef)
          );
        }
      }
      let deadlines = await loadDeadlines(this.ctx.storage);
      deadlines = cancelDeadline(cancelDeadline(deadlines, 'heartbeatExpiry'), 'socketHandshake');
      const establishedRecovery = nextRecovery.some(
        item =>
          identity.recoveryCapable &&
          controlRecovery.sameRuntime(item, identity) &&
          (item.cause !== 'activation_pending' || controlRecovery.activationCommitted(item))
      );
      deadlines = establishedRecovery
        ? cancelDeadline(cancelDeadline(deadlines, 'startup'), 'wrapperReadiness')
        : armDeadline(
            cancelDeadline(deadlines, 'startup'),
            'wrapperReadiness',
            Math.min(deadlines.wrapperReadiness ?? Infinity, now + DEADLINE_MS.wrapperReadiness)
          );
      deadlines = controlRecovery.recoveryDeadlines(deadlines, nextRecovery);
      await saveRecoveryDecisions(this.ctx.storage, nextRecovery);
      await saveDeadlines(this.ctx.storage, deadlines);
      await this.scheduleAlarm(deadlines);
      await this.appendLog(connectionTransition(now, 'disconnected', 'connected', 'hello'));
      return true;
    });
    if (!activated) return;
    this.activeConnection = identity;
    this.readyConnectionId = null;
    this.kiloReady = false;
    this.logDiagnostic('handshake_committed', diagnosticConnection(identity));
    this.socketHandler.closeProvisionalSockets();
  }

  private async onWrapperReady(identity: SandboxControlConnectionIdentity): Promise<void> {
    if (identity.recoveryCapable) {
      this.ctx.waitUntil(
        this.recoveryExecution.reconcile({
          identity,
          isCurrent: () => this.isCurrentConnection(identity),
          acceptsPhysical: physical =>
            physical.state === 'running' &&
            physical.stopTombstone === null &&
            physical.providerRef === identity.providerInstanceId,
        })
      );
      return;
    }
    await this.commitWrapperReady(identity);
  }

  private async commitWrapperReady(
    identity: SandboxControlConnectionIdentity,
    recovery?: controlRecovery.SandboxRecoveryDecision
  ): Promise<boolean> {
    const physical = await loadPhysicalRecord(this.ctx.storage);
    if (
      !this.isCurrentConnection(identity) ||
      physical.state === 'stopped' ||
      physical.providerRef !== identity.providerInstanceId
    )
      return false;
    const now = Date.now();
    const committed = await this.ctx.storage.transaction(async tx => {
      const current = await loadPhysicalRecord(tx);
      if (
        !this.isCurrentConnection(identity) ||
        current.state === 'stopped' ||
        current.stopTombstone !== null ||
        current.providerRef !== identity.providerInstanceId
      )
        return false;
      if (recovery) {
        const records = await loadRecoveryDecisions(tx);
        const currentRecovery = records.find(item => item.episodeId === recovery.episodeId);
        if (
          !currentRecovery ||
          !controlRecovery.sameConnection(currentRecovery, identity) ||
          currentRecovery.attempt !== recovery.attempt
        )
          return false;
        await saveRecoveryDecisions(
          tx,
          records.map(item =>
            item === currentRecovery ? controlRecovery.commitRecoveryActivation(item, now) : item
          )
        );
      }
      await tx.put({
        [ACTIVE_WRAPPER_RUNTIME_KEY]: {
          ...identity,
          readyConnectionId: identity.connectionId,
        } satisfies PersistedWrapperRuntime,
        [WRAPPER_READY_AT_KEY]: now,
      });
      let deadlines = cancelDeadline(await loadDeadlines(tx), 'wrapperReadiness');
      deadlines = armDeadline(deadlines, 'heartbeatExpiry', now + DEADLINE_MS.heartbeatExpiry);
      deadlines = armDeadline(
        deadlines,
        'idleStop',
        deadlines.idleStop ?? now + DEADLINE_MS.idleStop
      );
      deadlines = recovery
        ? controlRecovery.recoveryDeadlines(deadlines, await loadRecoveryDecisions(tx))
        : deadlines;
      await saveDeadlines(tx, deadlines);
      await this.appendLog(connectionTransition(now, 'connected', 'ready', 'sandbox.ready'));
      return true;
    });
    if (committed) await this.scheduleAlarm(await loadDeadlines(this.ctx.storage));
    if (!committed || recovery) return committed;
    this.activateWrapperReady(identity);
    return true;
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
      ...this.forwarding,
    };
    if (!this.isCurrentConnection(identity)) {
      this.logDiagnostic('heartbeat', { ...diagnostic, decision: 'stale_connection' });
      return;
    }
    if (!payload.kilo.ready) {
      this.logDiagnostic(
        'heartbeat',
        {
          ...diagnostic,
          decision: 'kilo_unhealthy',
          reason: payload.kilo.reason ?? 'unknown',
        },
        'warn'
      );
      await this.quarantineConnection(identity, 'kilo_unhealthy');
      return;
    }
    if (!this.readyWrapperRuntime() && !identity.recoveryCapable) {
      this.logDiagnostic('heartbeat', { ...diagnostic, decision: 'runtime_not_ready' });
      return;
    }

    const now = Date.now();
    const applied = await this.ctx.storage
      .transaction(async () => {
        const physical = await loadPhysicalRecord(this.ctx.storage);
        const table = await loadRouteTable(this.ctx.storage);
        if (
          !this.isCurrentConnection(identity) ||
          physical.state !== 'running' ||
          physical.stopTombstone ||
          physical.providerRef !== identity.providerInstanceId
        )
          return;
        if (payload.kilo.version !== undefined) {
          const runtime =
            (await loadRuntimeMetadata(this.ctx.storage)) ?? initialRuntimeMetadata(this.sandboxId);
          const kiloCliVersion = safeSandboxRuntimeVersion(payload.kilo.version);
          if (!this.isCurrentConnection(identity)) return;
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
        const previousDeadlines = await loadDeadlines(this.ctx.storage);
        let deadlines = armDeadline(
          previousDeadlines,
          'heartbeatExpiry',
          now + DEADLINE_MS.heartbeatExpiry
        );
        if (
          payload.state !== 'idle' ||
          (payload.pendingMessages ?? 0) > 0 ||
          hasActiveWork(table)
        ) {
          deadlines = cancelDeadline(deadlines, 'idleStop');
        } else {
          deadlines = armDeadline(
            deadlines,
            'idleStop',
            deadlines.idleStop ?? now + DEADLINE_MS.idleStop
          );
        }
        await saveDeadlines(this.ctx.storage, deadlines);
        await this.scheduleAlarm(deadlines);
        return {
          routeCount: table.size,
          missingRoutes,
          activeRoutes,
          finalizingRoutes,
          inputWaitingRoutes,
          heartbeatDeadlineAt: deadlines.heartbeatExpiry,
          idleDeadlineAt: deadlines.idleStop ?? null,
          idleDeadlineAction:
            deadlines.idleStop === undefined
              ? 'cancelled'
              : previousDeadlines.idleStop === undefined
                ? 'armed'
                : 'retained',
        };
      })
      .catch(error => {
        this.logDiagnostic('heartbeat', { ...diagnostic, decision: 'apply_failed' }, 'warn');
        throw error;
      });
    if (applied) this.lastAcceptedHeartbeat = { connectionId: identity.connectionId, at: now };
    this.logDiagnostic('heartbeat', {
      ...diagnostic,
      ...applied,
      decision: applied ? 'accepted' : 'stale_during_apply',
    });
    await this.renewProviderLease(identity);
  }

  private async renewProviderLease(identity: SandboxControlConnectionIdentity): Promise<void> {
    const physical = await loadPhysicalRecord(this.ctx.storage);
    const diagnostic = {
      ...diagnosticConnection(identity),
      allocationId: physical.createIntent?.intentId,
      physicalState: physical.state,
      hasTombstone: physical.stopTombstone !== null,
      requestedLeaseMs: leaseAtLeastMs(),
    };
    if (
      !this.isCurrentConnection(identity) ||
      !this.readyWrapperRuntime() ||
      physical.state !== 'running' ||
      physical.stopTombstone !== null ||
      physical.providerRef === null
    ) {
      this.logDiagnostic('lease', { ...diagnostic, result: 'skipped_authority' });
      return;
    }
    const startedAt = Date.now();
    let timedOut = false;
    this.logDiagnostic('lease', { ...diagnostic, result: 'started' });
    try {
      await withTimeout(
        this.provider.ensureLeaseAtLeast(physical.providerRef, leaseAtLeastMs()),
        DEADLINE_MS.stopAttempt,
        'Sandbox lease renewal timed out',
        () => {
          timedOut = true;
        }
      );
      this.logDiagnostic('lease', {
        ...diagnostic,
        result: 'completed',
        durationMs: Date.now() - startedAt,
      });
    } catch {
      this.logDiagnostic(
        'lease',
        {
          ...diagnostic,
          result: timedOut ? 'timed_out' : 'failed',
          durationMs: Date.now() - startedAt,
        },
        'warn'
      );
    }
  }

  private async onSessionEvent(
    identity: SessionEventIdentity | undefined,
    payload: SessionEventPayload,
    connection: SandboxControlConnectionIdentity,
    receiptId?: string,
    receiptHash?: string,
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
      connection,
      { identity, payload, ...(receiptId ? { receiptId, receiptHash, sequence } : {}) },
      (route, fields, physical) =>
        this.forwardSessionFrame(
          route,
          physical,
          connection,
          fields,
          'receiveSandboxControlEvent',
          stub =>
            stub.receiveSandboxControlEvent({
              identity,
              payload,
              wrapperInstanceId: connection.wrapperInstanceId,
              ...(receiptId ? { receiptId, receiptHash, sequence } : {}),
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
    receiptHash?: string,
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
      connection,
      { identity, payload, ...(receiptId ? { receiptId, receiptHash, sequence } : {}) },
      (route, fields, physical) =>
        this.forwardSessionFrame(
          route,
          physical,
          connection,
          fields,
          'receiveSandboxControlPreparing',
          stub =>
            stub.receiveSandboxControlPreparing({
              identity,
              payload,
              wrapperInstanceId: connection.wrapperInstanceId,
              ...(receiptId ? { receiptId, receiptHash, sequence } : {}),
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

  private async onNativeRuntimeRetired(
    input: unknown,
    connection: SandboxControlConnectionIdentity
  ): Promise<{ retired: true } | undefined> {
    const payload = sessionNativeRuntimeRetirementPayloadSchema.parse(input);
    if (!this.supportsNativeRuntimeRetirement()) return undefined;
    const retirementConnection = this.nativeRetirementConnection(connection);
    if (!retirementConnection) return undefined;
    return this.nativeRuntimeRetirement.receiveRetired({
      connection: retirementConnection,
      ...payload,
    });
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
    const [table, physical, ownerId] = await Promise.all([
      loadRouteTable(this.ctx.storage),
      loadPhysicalRecord(this.ctx.storage),
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
      physical.state === 'stopped' ||
      physical.providerRef !== connection.providerInstanceId ||
      !this.matchesWorktreeContainment(physical) ||
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
    this.forwarding.enqueued++;
    const fields = {
      ...diagnostic,
      sessionId: route.sessionId,
      forwardSequence: this.forwarding.enqueued,
      queuedAt,
    };
    this.logDiagnostic('forward_enqueued', { ...fields, ...this.forwarding });
    const forwardDeadlineAt = Math.min(deadlineAt, Date.now() + DEADLINE_MS.stopAttempt);
    const next = this.sessionForwarding.enqueueFenced({
      sessionId: route.sessionId,
      bytes: frameBytes,
      deadlineAt: forwardDeadlineAt,
      fence: async () => current(),
      forward: async () => {
        const queueWaitMs = Date.now() - queuedAt;
        this.forwarding.maxQueueWaitMs = Math.max(this.forwarding.maxQueueWaitMs, queueWaitMs);
        this.logDiagnostic('forward_started', { ...fields, queueWaitMs, ...this.forwarding });
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
            const [routes, nextPhysical] = await Promise.all([
              loadRouteTable(this.ctx.storage),
              loadPhysicalRecord(this.ctx.storage),
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
              !sameAllocation(nextPhysical, physical) ||
              nextPhysical.state === 'stopped' ||
              nextPhysical.providerRef !== connection.providerInstanceId ||
              !this.matchesWorktreeContainment(nextPhysical) ||
              this.runtimeDeleted ||
              this.exclusiveDeletionWorktreeId !== undefined ||
              (nextRoute.worktreeId !== undefined &&
                this.deletingWorktrees.has(nextRoute.worktreeId)) ||
              !current()
            )
              throw new SandboxControlConnectionError('Operation result fence changed', false);
          };
          let attempts = 0;
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
          this.logDiagnostic('forward_result', {
            ...fields,
            operation: 'receiveSandboxOperationResult',
            attempts,
            result: 'delivered',
          });
          return parsed.data;
        } catch (error) {
          this.forwarding.failed++;
          this.logDiagnostic(
            'forward_result',
            {
              ...fields,
              operation: 'receiveSandboxOperationResult',
              result: 'failed',
            },
            'warn'
          );
          throw error instanceof SandboxControlConnectionError
            ? error
            : error instanceof SessionForwardingError
              ? new SandboxControlConnectionError(error.message, error.retryable)
              : new SandboxControlConnectionError('Operation result forwarding failed');
        } finally {
          this.forwarding.settled++;
          const totalForwardMs = Date.now() - queuedAt;
          this.forwarding.maxTotalForwardMs = Math.max(
            this.forwarding.maxTotalForwardMs,
            totalForwardMs
          );
          this.logDiagnostic('forward_settled', { ...fields, totalForwardMs, ...this.forwarding });
        }
      },
    });
    const delivered = next.catch(error => {
      throw error instanceof SessionForwardingError
        ? new SandboxControlConnectionError(error.message, error.retryable)
        : error;
    });
    this.ctx.waitUntil(delivered.catch(() => undefined));
    return delivered;
  }

  private async forwardRoutedSessionFrame(
    identity: SessionEventIdentity,
    eventType: string,
    connection: SandboxControlConnectionIdentity,
    frame: unknown,
    forward: (
      route: SessionRoute,
      diagnostic: ControlDiagnosticFields,
      physical: PhysicalRecord
    ) => Promise<SandboxControlEventResult>
  ): Promise<SandboxControlEventResult> {
    const diagnostic = {
      ...diagnosticConnection(connection),
      eventType: diagnosticEventType(eventType),
    };
    const table = await loadRouteTable(this.ctx.storage);
    if (!this.isCurrentConnection(connection)) {
      this.recordForwardDrop('stale_before_enqueue', diagnostic);
      return { applied: false };
    }
    const route = resolveSessionEventRoute(table, identity);
    if (!route) {
      this.recordForwardDrop('unroutable', { ...diagnostic, routeCount: table.size });
      return { applied: false };
    }
    const physical = await loadPhysicalRecord(this.ctx.storage);
    if (
      physical.state !== 'running' ||
      physical.stopTombstone ||
      physical.providerRef !== connection.providerInstanceId ||
      !this.matchesWorktreeContainment(physical) ||
      !this.isCurrentConnection(connection)
    ) {
      this.recordForwardDrop('runtime_not_current', diagnostic);
      return { applied: false };
    }
    let frameBytes: number;
    try {
      frameBytes = sessionForwardFrameBytes(frame);
    } catch {
      this.recordForwardDrop('forwarding_frame_invalid', diagnostic);
      return { applied: false };
    }
    const queuedAt = Date.now();
    this.forwarding.enqueued++;
    const fields = {
      ...diagnostic,
      sessionId: route.sessionId,
      forwardSequence: this.forwarding.enqueued,
      queuedAt,
    };
    this.logDiagnostic('forward_enqueued', { ...fields, ...this.forwarding });
    const next = this.sessionForwarding.enqueueFenced({
      sessionId: route.sessionId,
      bytes: frameBytes,
      deadlineAt: Date.now() + DEADLINE_MS.stopAttempt,
      fence: async () => this.isCurrentConnection(connection),
      forward: async () => {
        const queueWaitMs = Date.now() - queuedAt;
        this.forwarding.maxQueueWaitMs = Math.max(this.forwarding.maxQueueWaitMs, queueWaitMs);
        this.logDiagnostic('forward_started', {
          ...fields,
          queueWaitMs,
          ...this.forwarding,
        });
        try {
          if (this.isCurrentConnection(connection)) return forward(route, fields, physical);
          this.recordForwardDrop('stale_before_send', fields);
          return { applied: false, retryable: true };
        } finally {
          this.forwarding.settled++;
          const totalForwardMs = Date.now() - queuedAt;
          this.forwarding.maxTotalForwardMs = Math.max(
            this.forwarding.maxTotalForwardMs,
            totalForwardMs
          );
          this.logDiagnostic('forward_settled', {
            ...fields,
            totalForwardMs,
            ...this.forwarding,
          });
        }
      },
    });
    this.ctx.waitUntil(
      next.catch(error => {
        this.recordForwardDrop(
          error instanceof SessionForwardingError && !error.retryable
            ? 'forwarding_frame_rejected'
            : 'forwarding_capacity_exhausted',
          fields
        );
      })
    );
    return next.catch(() => ({ applied: false, retryable: true }));
  }

  private recordForwardDrop(reason: string, fields: ControlDiagnosticFields): void {
    this.forwarding.dropped++;
    this.logDiagnostic('forward_dropped', { ...fields, reason, ...this.forwarding });
  }

  private async isCurrentSessionForward(
    route: SessionRoute,
    connection: SandboxControlConnectionIdentity,
    expectedPhysical: PhysicalRecord
  ): Promise<boolean> {
    if (!this.isCurrentConnection(connection)) return false;
    const [routes, physical] = await Promise.all([
      loadRouteTable(this.ctx.storage),
      loadPhysicalRecord(this.ctx.storage),
    ]);
    const current = routes.get(route.sessionId);
    return (
      current?.ownerId === route.ownerId &&
      current.kiloSessionId === route.kiloSessionId &&
      current.directory === route.directory &&
      current.worktreeId === route.worktreeId &&
      current.nativeRuntimeId === route.nativeRuntimeId &&
      sameAllocation(physical, expectedPhysical) &&
      physical.state === 'running' &&
      !physical.stopTombstone &&
      physical.providerRef === connection.providerInstanceId &&
      this.matchesWorktreeContainment(physical) &&
      !this.runtimeDeleted &&
      !this.exclusiveDeletionWorktreeId &&
      !(route.worktreeId && this.deletingWorktrees.has(route.worktreeId)) &&
      this.isCurrentConnection(connection)
    );
  }

  private async forwardSessionFrame(
    route: SessionRoute,
    physical: PhysicalRecord,
    connection: SandboxControlConnectionIdentity,
    diagnostic: ControlDiagnosticFields,
    operation: 'receiveSandboxControlEvent' | 'receiveSandboxControlPreparing',
    send: (
      stub: ReturnType<typeof getSandboxSessionStub>
    ) => Promise<{ applied: boolean; retryable?: boolean }>,
    requireApplied: boolean
  ): Promise<SandboxControlEventResult> {
    if (!(await this.isCurrentSessionForward(route, connection, physical))) {
      this.recordForwardDrop('stale_before_send', diagnostic);
      return { applied: false, retryable: true };
    }
    const startedAt = Date.now();
    let timedOut = false;
    let skipped = false;
    let attempts = 0;
    const delivered = await withTimeout(
      withDORetry(
        () => getSandboxSessionStub(this.env, route.ownerId, route.sessionId),
        async (stub): Promise<{ applied: boolean; retryable?: boolean }> => {
          skipped = !(await this.isCurrentSessionForward(route, connection, physical));
          if (skipped) {
            this.recordForwardDrop('stale_retry', diagnostic);
            return Promise.resolve({ applied: true });
          }
          attempts++;
          const result = await send(stub);
          if (!(await this.isCurrentSessionForward(route, connection, physical))) {
            skipped = true;
            this.recordForwardDrop('stale_after_send', diagnostic);
            return { applied: false };
          }
          return result;
        },
        operation
      ),
      DEADLINE_MS.stopAttempt,
      operation === 'receiveSandboxControlEvent'
        ? 'Sandbox event forwarding timed out'
        : 'Sandbox preparation forwarding timed out',
      () => {
        timedOut = true;
      }
    ).then(
      result => {
        const rpcWaitMs = Date.now() - startedAt;
        this.forwarding.maxRpcWaitMs = Math.max(this.forwarding.maxRpcWaitMs, rpcWaitMs);
        if (!skipped && result?.applied === false) this.forwarding.notApplied++;
        this.logDiagnostic('forward_result', {
          ...diagnostic,
          operation,
          attempts,
          result: skipped ? 'skipped' : 'delivered',
          applied: skipped ? undefined : result?.applied,
          rpcWaitMs,
          ...this.forwarding,
        });
        if (skipped) return { applied: false, retryable: true };
        if (!requireApplied || result?.applied === true) return { applied: true };
        return {
          applied: false,
          retryable: result?.retryable === true || operation === 'receiveSandboxControlPreparing',
        };
      },
      async () => {
        const rpcWaitMs = Date.now() - startedAt;
        this.forwarding.maxRpcWaitMs = Math.max(this.forwarding.maxRpcWaitMs, rpcWaitMs);
        this.forwarding.failed++;
        this.logDiagnostic(
          'forward_result',
          {
            ...diagnostic,
            operation,
            attempts,
            result: timedOut ? 'timed_out' : 'failed',
            rpcWaitMs,
            ...this.forwarding,
          },
          'warn'
        );
        if (!requireApplied) await this.quarantineForwardingFailure(route, connection);
        return { applied: false, retryable: true };
      }
    );
    return delivered;
  }

  private async quarantineForwardingFailure(
    route: SessionRoute,
    connection: SandboxControlConnectionIdentity
  ): Promise<void> {
    const table = await loadRouteTable(this.ctx.storage);
    const current = table.get(route.sessionId);
    if (
      !this.isCurrentConnection(connection) ||
      !current ||
      current.ownerId !== route.ownerId ||
      current.directory !== route.directory ||
      current.kiloSessionId !== route.kiloSessionId ||
      current.nativeRuntimeId !== route.nativeRuntimeId
    ) {
      this.logDiagnostic('forward_quarantine_skipped', {
        sessionId: route.sessionId,
        ...diagnosticConnection(connection),
      });
      return;
    }
    await this.quarantineConnection(connection, 'session_delivery_failed');
  }

  private async onSocketClosed(
    handshakeComplete: boolean,
    identity?: SandboxControlConnectionIdentity
  ): Promise<void> {
    if (!handshakeComplete || !identity || !this.isActiveConnection(identity)) return;
    const replacement = this.socketHandler.getConnectionIdentity();
    if (replacement && !this.sameConnection(replacement, identity)) return;
    if (identity.recoveryCapable) await this.beginControlRecovery(identity, 'control_disconnected');
    else await this.quarantineConnection(identity, 'control_disconnected');
  }

  private exhaustExpiredRecovery(now: number): Promise<void> {
    return this.recoveryCleanup.exhaustExpired(now);
  }

  private reconcileExhaustedRecovery(): Promise<void> {
    return this.recoveryCleanup.reconcile();
  }

  private async beginControlRecovery(
    identity: SandboxControlConnectionIdentity,
    cause: 'control_disconnected' | 'heartbeat_expired'
  ): Promise<void> {
    if (!identity.wrapperInstanceId || !this.isActiveConnection(identity)) return;
    const wrapperInstanceId = identity.wrapperInstanceId;
    const started = await this.ctx.storage.transaction(async tx => {
      const physical = await loadPhysicalRecord(tx);
      if (
        physical.state !== 'running' ||
        physical.stopTombstone !== null ||
        physical.providerRef !== identity.providerInstanceId ||
        !this.isActiveConnection(identity)
      )
        return undefined;
      const recovery = await loadRecoveryDecisions(tx);
      const resumed = controlRecovery.beginRecovery(
        recovery.find(item => item.wrapperInstanceId === wrapperInstanceId),
        { ...identity, wrapperInstanceId },
        cause,
        Date.now()
      );
      const next =
        !controlRecovery.activationCommitted(resumed) &&
        resumed.exhaustedAt === undefined &&
        Date.now() >= resumed.deadlineAt
          ? controlRecovery.exhaustRecovery(resumed, Date.now())
          : resumed;
      const nextRecovery = [...recovery.filter(item => item.episodeId !== next.episodeId), next];
      await saveRecoveryDecisions(tx, nextRecovery);
      await tx.put(ACTIVE_WRAPPER_RUNTIME_KEY, identity);
      await tx.delete(WRAPPER_READY_AT_KEY);
      const deadlines = controlRecovery.recoveryDeadlines(
        cancelDeadline(await loadDeadlines(tx), 'heartbeatExpiry'),
        nextRecovery
      );
      await saveDeadlines(tx, deadlines);
      await this.scheduleAlarm(deadlines);
      return next;
    });
    this.readyConnectionId = null;
    this.kiloReady = false;
    if (!started || started.authority || started.exhaustedAt !== undefined) return;
    const authority = await this.recoveryAuthority.load(started);
    if (!authority) return;
    await this.ctx.storage.transaction(async tx => {
      const recovery = await loadRecoveryDecisions(tx);
      const current = recovery.find(item => item.episodeId === started.episodeId);
      if (!current || current.authority || current.exhaustedAt !== undefined) return;
      await saveRecoveryDecisions(
        tx,
        recovery.map(item =>
          item === current ? controlRecovery.replaceRecoveryAuthority(item, authority) : item
        )
      );
    });
  }

  private async quarantineConnection(
    identity: SandboxControlConnectionIdentity,
    reason: string
  ): Promise<void> {
    const physical = await loadPhysicalRecord(this.ctx.storage);
    if (
      !this.isActiveConnection(identity) ||
      physical.state === 'stopped' ||
      physical.stopTombstone
    ) {
      this.logDiagnostic('quarantine_skipped', {
        ...diagnosticConnection(identity),
        cause: diagnosticCause(reason),
        physicalState: physical.state,
        hasTombstone: physical.stopTombstone !== null,
      });
      return;
    }
    const next = beginStop(physical, reason, Date.now(), identity.wrapperInstanceId);
    await this.persistPhysical(physical, next, reason);
    this.ctx.waitUntil(this.recordStopAttempt());
  }

  private async releaseIfAuthoritativelyDead(physical: PhysicalRecord): Promise<PhysicalRecord> {
    if (!physical.stopTombstone) await this.beginStop('environment_failed');
    return this.recordStopAttempt();
  }

  private async observeCurrentProvider(physical: PhysicalRecord): Promise<PhysicalRecord> {
    if (shouldRearmReconciliation(physical.state)) {
      await this.rearmReconciliation(physical);
    }
    const startedAt = Date.now();
    let timedOut = false;
    let failed = false;
    let result: ProviderObservation;
    try {
      result = await withTimeout(
        this.provider.observe(physical.providerRef, physical.createIntent),
        DEADLINE_MS.stopAttempt,
        'Sandbox observation timed out',
        () => {
          timedOut = true;
        }
      );
    } catch {
      failed = true;
      result = { status: 'unknown' };
    }
    const current = await loadPhysicalRecord(this.ctx.storage);
    const stale = !sameAllocation(current, physical) || current.state === 'stopped';
    this.logDiagnostic('provider_observation', {
      allocationId: physical.createIntent?.intentId,
      physicalState: physical.state,
      observation: result.status,
      result: timedOut ? 'timed_out' : failed ? 'failed' : 'completed',
      stale,
      durationMs: Date.now() - startedAt,
    });
    if (stale) return current;
    if (result.providerRef && current.providerRef === null) {
      await savePhysicalRecord(this.ctx.storage, { ...current, providerRef: result.providerRef });
    }
    return this.observeProvider(result.status);
  }

  private async rearmReconciliation(physical: PhysicalRecord): Promise<void> {
    if (this.shouldSlowReap(physical)) {
      await this.armDeadlineIfAbsent('reconciliation', Date.now() + DEADLINE_MS.reconciliation);
      return;
    }
    const startedAt = physical.stopTombstone?.createdAt ?? physical.createIntent?.createdAt;
    if (startedAt !== undefined && Date.now() >= startedAt + DEADLINE_MS.reconciliationWindow) {
      await this.cancelDeadlineAndAlarm('reconciliation');
      return;
    }
    await this.armDeadlineAndAlarm('reconciliation', Date.now() + DEADLINE_MS.reconciliation);
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

  private supportsNativeRuntimeRetirement(): boolean {
    return (
      this.socketHandler.supportsOperationResults() &&
      this.socketHandler.supportsNativeRuntimeRetirement?.() === true
    );
  }

  private nativeRetirementConnection(
    connection: SandboxControlConnectionIdentity | null
  ): NativeRuntimeRetirementConnection | undefined {
    if (!connection?.wrapperInstanceId) return undefined;
    return {
      connectionId: connection.connectionId,
      providerInstanceId: connection.providerInstanceId,
      wrapperInstanceId: connection.wrapperInstanceId,
    };
  }

  private async abortNativeRuntime(input: {
    receipt: NativeRuntimeRetirementReceipt;
    route: SessionRoute;
  }): Promise<boolean> {
    const response = await this.socketHandler.sendRequest({
      operation: 'session.abort',
      session: {
        sessionId: input.route.sessionId,
        kiloSessionId: input.route.kiloSessionId,
        directory: input.route.directory,
      },
      payload: {
        reason: input.receipt.reason,
        nativeRuntimeId: input.receipt.nativeRuntimeId,
        cleanupDeadlineAt: input.receipt.cleanupDeadlineAt,
      },
      expectedWrapperInstanceId: input.receipt.connection.wrapperInstanceId,
      deadlineAt: input.receipt.cleanupDeadlineAt,
      timeoutMs: Math.max(1, input.receipt.cleanupDeadlineAt - Date.now()),
    });
    const result = response.ok ? sessionAbortResultSchema.safeParse(response.result) : undefined;
    return (
      result?.success === true &&
      result.data.runtimeRetired === true &&
      result.data.nativeRuntimeId === input.receipt.nativeRuntimeId
    );
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

    const [ownerId, routes, physical, grants] = await Promise.all([
      this.readOwner(),
      loadRouteTable(this.ctx.storage),
      loadPhysicalRecord(this.ctx.storage),
      loadSessionCredentialGrants(this.ctx.storage),
    ]);
    if (ownerId !== input.ownerId) return { allowed: false, reason: 'owner_mismatch' };
    const route = routes.get(input.sessionId);
    if (!route || route.ownerId !== input.ownerId) {
      return { allowed: false, reason: 'session_not_attached' };
    }
    const worktreeId = route.worktreeId ?? this.worktreeIdFromDirectory(route.directory);
    if (
      this.runtimeDeleted ||
      this.exclusiveDeletionWorktreeId ||
      (worktreeId && this.deletingWorktrees.has(worktreeId))
    ) {
      return { allowed: false, reason: 'worktree_deleting' };
    }
    if (physical.state !== 'running' || physical.stopTombstone || physical.providerRef === null) {
      return { allowed: false, reason: 'runtime_not_running' };
    }
    if (!this.matchesWorktreeContainment(physical)) {
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
      !this.matchesContainment(
        physical,
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

    return { allowed: true, connection, physical, provider: this.providerKind, route, grant };
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

  private async repairLifecycleScheduling(physical: PhysicalRecord): Promise<void> {
    if (physical.stopTombstone || (physical.state !== 'running' && physical.state !== 'creating')) {
      const next =
        physical.state === 'stopping' &&
        (physical.stopTombstone?.attempts ?? 0) >= DEADLINE_MS.stopAttemptLadder.length
          ? exhaustStopRetries(physical)
          : physical;
      await this.persistPhysical(physical, next, 'recovered');
      return;
    }
    await this.ctx.storage.transaction(async () => {
      let deadlines = await loadDeadlines(this.ctx.storage);
      if (
        deadlines.startup === undefined &&
        deadlines.wrapperReadiness === undefined &&
        deadlines.heartbeatExpiry === undefined
      ) {
        const runtime = await this.ctx.storage.get<PersistedWrapperRuntime>(
          ACTIVE_WRAPPER_RUNTIME_KEY
        );
        const readyAt = await this.ctx.storage.get<number>(WRAPPER_READY_AT_KEY);
        if (
          runtime &&
          runtime.readyConnectionId === runtime.connectionId &&
          readyAt !== undefined
        ) {
          deadlines = armDeadline(
            deadlines,
            'heartbeatExpiry',
            readyAt + DEADLINE_MS.heartbeatExpiry
          );
        } else if (physical.state === 'creating') {
          deadlines = armDeadline(
            deadlines,
            'startup',
            (physical.createIntent?.createdAt ?? Date.now()) + DEADLINE_MS.startup
          );
        } else {
          deadlines = armDeadline(
            deadlines,
            'wrapperReadiness',
            Date.now() + DEADLINE_MS.wrapperReadiness
          );
        }
      }
      await saveDeadlines(this.ctx.storage, deadlines);
      await this.scheduleAlarm(deadlines);
    });
  }

  private async persistPhysical(
    from: PhysicalRecord,
    to: PhysicalRecord,
    cause: string
  ): Promise<void> {
    const wrapperInstanceId =
      to.stopTombstone?.wrapperInstanceId ??
      from.stopTombstone?.wrapperInstanceId ??
      this.activeConnection?.wrapperInstanceId;
    if (to.stopTombstone && wrapperInstanceId && !to.stopTombstone.wrapperInstanceId) {
      to = { ...to, stopTombstone: { ...to.stopTombstone, wrapperInstanceId } };
    }
    await this.ctx.storage.transaction(() => this.persistPhysicalState(from, to, cause));
    await this.afterPhysicalPersistence(from, to, cause, wrapperInstanceId);
  }

  private async afterPhysicalPersistence(
    from: PhysicalRecord,
    to: PhysicalRecord,
    cause: string,
    wrapperInstanceId: string | undefined
  ): Promise<void> {
    const changed =
      from.state !== to.state || (from.stopTombstone === null && to.stopTombstone !== null);
    const unavailable =
      to.stopTombstone !== null || (to.state !== 'creating' && to.state !== 'running');
    this.logDiagnostic('physical_committed', {
      allocationId: to.createIntent?.intentId ?? from.createIntent?.intentId,
      wrapperInstanceId,
      fromState: from.state,
      toState: to.state,
      cause: diagnosticCause(cause),
      stopCause: to.stopTombstone ? diagnosticCause(to.stopTombstone.reason) : undefined,
      stopAttempts: to.stopTombstone?.attempts ?? from.stopTombstone?.attempts,
      cleanupAgeMs: from.stopTombstone ? Date.now() - from.stopTombstone.createdAt : undefined,
      hasTombstone: to.stopTombstone !== null,
      ...this.forwarding,
    });
    if (!unavailable) return;
    this.activeConnection = null;
    this.readyConnectionId = null;
    this.kiloReady = false;
    this.socketHandler.closeAll('Sandbox runtime unavailable');
    if (changed && wrapperInstanceId) {
      this.ctx.waitUntil(this.invalidateTerminalRuntime(wrapperInstanceId, to.state === 'stopped'));
      this.ctx.waitUntil(
        this.notifyAttachedSessions(
          to.stopTombstone?.reason ??
            (to.state === 'unknown' ? 'provider_unknown' : 'environment_stopped'),
          wrapperInstanceId
        )
      );
    }
  }

  private async beginNativeRetirementPhysicalFallback(
    receipt: NativeRuntimeRetirementReceipt
  ): Promise<boolean> {
    const committed = await this.ctx.storage.transaction(async () => {
      const [physical, receipts, decisions, routes] = await Promise.all([
        loadPhysicalRecord(this.ctx.storage),
        loadNativeRuntimeRetirements(this.ctx.storage),
        loadRecoveryDecisions(this.ctx.storage),
        loadRouteTable(this.ctx.storage),
      ]);
      const currentReceipt = receipts.find(
        current =>
          sameNativeRuntimeRetirement(current, {
            directory: receipt.directory,
            nativeRuntimeId: receipt.nativeRuntimeId,
            connection: receipt.connection,
          }) && current.operationId === receipt.operationId
      );
      if (
        !currentReceipt ||
        currentReceipt.state !== 'unconfirmed' ||
        physical.stopTombstone ||
        physical.state === 'stopped' ||
        !matchesNativeRuntimeRetirementAllocation(currentReceipt, physical) ||
        ((currentReceipt.reason === RECOVERY_CLEANUP_REASON ||
          decisions.some(decision =>
            controlRecovery.sameRuntime(decision, currentReceipt.connection)
          )) &&
          (!canRecoveryRetirementStopAllocation(
            currentReceipt,
            decisions,
            physical,
            routes,
            Date.now()
          ) ||
            (this.activeConnection !== null &&
              !controlRecovery.sameRuntime(this.activeConnection, currentReceipt.connection))))
      )
        return undefined;
      const next = beginStop(
        physical,
        currentReceipt.reason,
        Date.now(),
        currentReceipt.connection.wrapperInstanceId
      );
      await this.persistPhysicalState(physical, next, currentReceipt.reason);
      return { physical, next, reason: currentReceipt.reason };
    });
    if (!committed) return false;
    await this.afterPhysicalPersistence(
      committed.physical,
      committed.next,
      committed.reason,
      committed.next.stopTombstone?.wrapperInstanceId
    );
    this.ctx.waitUntil(this.recordStopAttempt());
    return true;
  }

  private async persistPhysicalState(
    from: PhysicalRecord,
    to: PhysicalRecord,
    cause: string
  ): Promise<void> {
    const changed =
      from.state !== to.state || (from.stopTombstone === null && to.stopTombstone !== null);
    const unavailable =
      to.stopTombstone !== null || (to.state !== 'creating' && to.state !== 'running');
    await savePhysicalRecord(this.ctx.storage, to);
    if (from.state === 'stopped' && to.state === 'creating') {
      await saveRuntimeMetadata(this.ctx.storage, initialRuntimeMetadata(this.sandboxId));
    }
    if (to.state === 'stopped') {
      await saveSessionCredentialGrants(this.ctx.storage, []);
      await saveRecoveryDecisions(this.ctx.storage, []);
      await this.ctx.storage.delete(CREDENTIAL_POLICY_DIRTY_KEY);
      const [routes, receipts] = await Promise.all([
        loadRouteTable(this.ctx.storage),
        loadNativeRuntimeRetirements(this.ctx.storage),
      ]);
      const retired = receipts.filter(receipt =>
        matchesNativeRuntimeRetirementAllocation(receipt, from)
      );
      for (const receipt of retired) releaseNativeRuntimeRetirement(routes, receipt, true);
      if (retired.length > 0) {
        await saveRouteTable(this.ctx.storage, routes);
        await saveNativeRuntimeRetirements(
          this.ctx.storage,
          receipts.filter(receipt => !retired.includes(receipt))
        );
      }
    }
    if (changed) {
      await this.appendLog(
        physicalTransition(Date.now(), from.state, to.state, cause, to.providerRef)
      );
    }
    const deadlines = await loadDeadlines(this.ctx.storage);
    let next = deadlines;
    if (to.state === 'creating') {
      if (from.state === 'stopped') {
        await this.ctx.storage.delete([
          CREDENTIAL_HASH_KEY,
          ACTIVE_WRAPPER_RUNTIME_KEY,
          WRAPPER_READY_AT_KEY,
        ]);
      }
      next = { startup: (to.createIntent?.createdAt ?? Date.now()) + DEADLINE_MS.startup };
    } else if (to.state === 'running' && from.state === 'unknown' && !unavailable) {
      const id = this.connectionState() === 'ready' ? 'heartbeatExpiry' : 'wrapperReadiness';
      next = { [id]: Date.now() + DEADLINE_MS[id] };
    } else if (unavailable) {
      await this.ctx.storage.delete([
        CREDENTIAL_HASH_KEY,
        ACTIVE_WRAPPER_RUNTIME_KEY,
        WRAPPER_READY_AT_KEY,
      ]);
      next = {};
      if (to.state !== 'stopped') {
        const attempted = (to.stopTombstone?.attempts ?? 0) > (from.stopTombstone?.attempts ?? 0);
        if (
          to.stopTombstone &&
          (attempted || to.stopTombstone.attempts < DEADLINE_MS.stopAttemptLadder.length)
        ) {
          next = {
            stopAttempt: attempted
              ? Date.now() + DEADLINE_MS.stopAttempt
              : (deadlines.stopAttempt ?? Date.now() + DEADLINE_MS.stopAttemptLadder[0]),
          };
        } else {
          const startedAt = to.stopTombstone?.createdAt ?? to.createIntent?.createdAt;
          if (
            this.shouldSlowReap(to) ||
            deadlines.reconciliation !== undefined ||
            startedAt === undefined ||
            Date.now() < startedAt + DEADLINE_MS.reconciliationWindow
          ) {
            next = {
              reconciliation: deadlines.reconciliation ?? Date.now() + DEADLINE_MS.reconciliation,
            };
          }
        }
      }
    }
    if (to.state !== 'stopped' && deadlines.credentialExpiry !== undefined) {
      next = armDeadline(next, 'credentialExpiry', deadlines.credentialExpiry);
    }
    await saveDeadlines(this.ctx.storage, next);
    await this.scheduleAlarm(next);
  }

  private async recordNativeRuntime(
    connection: SandboxControlConnectionIdentity,
    physical: PhysicalRecord,
    session: SessionRequestIdentity,
    nativeRuntimeId: string,
    authorization?: SessionOperationAuthorization
  ): Promise<boolean> {
    const wrapperInstanceId = connection.wrapperInstanceId;
    if (!this.isCurrentConnection(connection) || !wrapperInstanceId) return false;
    const recordedRoute = await this.ctx.storage.transaction(async () => {
      const [currentPhysical, routes] = await Promise.all([
        loadPhysicalRecord(this.ctx.storage),
        loadRouteTable(this.ctx.storage),
      ]);
      const route = routes.get(session.sessionId);
      if (
        !route ||
        route.kiloSessionId !== session.kiloSessionId ||
        route.directory !== session.directory ||
        (route.nativeRuntimeId !== undefined && route.nativeRuntimeId !== nativeRuntimeId) ||
        route.retiringNativeRuntimeId !== undefined ||
        !this.isCurrentConnection(connection) ||
        currentPhysical.state !== 'running' ||
        currentPhysical.stopTombstone ||
        currentPhysical.providerRef !== connection.providerInstanceId ||
        !sameAllocation(physical, currentPhysical)
      )
        return undefined;
      routes.set(route.sessionId, { ...route, nativeRuntimeId });
      await saveRouteTable(this.ctx.storage, routes);
      return route;
    });
    if (!recordedRoute) return false;
    try {
      await withTimeout(
        withDORetry(
          () => getSandboxSessionStub(this.env, recordedRoute.ownerId, recordedRoute.sessionId),
          stub =>
            stub.recordNativeRuntime({
              sandboxId: this.sandboxId,
              wrapperInstanceId,
              nativeRuntimeId,
              ...(authorization ? { authorization } : {}),
            }),
          'recordNativeRuntime'
        ),
        DEADLINE_MS.stopAttempt,
        'Native runtime route registration timed out'
      );
      return true;
    } catch {
      return false;
    }
  }

  private async invalidateNativeRetirementRecipients(
    receipt: NativeRuntimeRetirementReceipt
  ): Promise<boolean> {
    const invalidated = await Promise.all(
      receipt.recipients.map(recipient =>
        withTimeout(
          withDORetry(
            () => getSandboxSessionStub(this.env, recipient.ownerId, recipient.sessionId),
            stub =>
              stub.invalidateTerminalRuntime({
                sandboxId: this.sandboxId,
                wrapperInstanceId: receipt.connection.wrapperInstanceId,
                confirmed: true,
                nativeRuntimeId: receipt.nativeRuntimeId,
              }),
            'invalidateTerminalRuntime'
          ),
          Math.max(1, receipt.replayUntil - Date.now()),
          'Native runtime terminal invalidation timed out'
        ).then(
          () => true,
          () => false
        )
      )
    );
    return invalidated.every(Boolean);
  }

  private async notifyNativeRetirementRecipients(
    receipt: NativeRuntimeRetirementReceipt
  ): Promise<boolean> {
    const notified = await Promise.all(
      receipt.recipients.map(recipient =>
        withTimeout(
          withDORetry(
            () => getSandboxSessionStub(this.env, recipient.ownerId, recipient.sessionId),
            stub =>
              stub.failWaitingMessages(
                receipt.reason,
                receipt.connection.wrapperInstanceId,
                receipt.nativeRuntimeId
              ),
            'failWaitingMessages'
          ),
          Math.max(1, receipt.replayUntil - Date.now()),
          'Native runtime failure notification timed out'
        ).then(
          () => true,
          () => false
        )
      )
    );
    return notified.every(Boolean);
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

  private async notifyAttachedSessions(
    reason: string,
    wrapperInstanceId: string,
    directory?: string
  ): Promise<boolean> {
    const table = await loadRouteTable(this.ctx.storage);
    const notified = await Promise.all(
      [...table.values()]
        .filter(route => directory === undefined || route.directory === directory)
        .map(route =>
          withTimeout(
            withDORetry(
              () => getSandboxSessionStub(this.env, route.ownerId, route.sessionId),
              stub => stub.failWaitingMessages(reason, wrapperInstanceId),
              'failWaitingMessages'
            ),
            DEADLINE_MS.stopAttempt,
            'Sandbox failure notification timed out'
          ).then(
            () => true,
            () => false
          )
        )
    );
    return notified.every(Boolean);
  }

  private mutateRoutes<T>(
    mutation: (table: Map<string, SessionRoute>) => { value: T; changed: boolean }
  ): Promise<T> {
    return this.ctx.storage.transaction(async () => {
      const table = await loadRouteTable(this.ctx.storage);
      const updated = mutation(table);
      if (updated.changed) await saveRouteTable(this.ctx.storage, table);
      return updated.value;
    });
  }

  private async armDeadlineIfAbsent(id: DeadlineId, at: number): Promise<void> {
    await this.armDeadlineAndAlarm(id, at, true);
  }

  private async armDeadlineAndAlarm(id: DeadlineId, at: number, ifAbsent = false): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      const current = await loadDeadlines(this.ctx.storage);
      const wasArmed = current[id] !== undefined;
      if (ifAbsent && wasArmed) return;
      const scheduledAt = id === 'idleStop' ? Math.max(current[id] ?? 0, at) : at;
      const deadlines = armDeadline(current, id, scheduledAt);
      await saveDeadlines(this.ctx.storage, deadlines);
      if (!wasArmed) {
        await this.appendLog(deadlineTransition(Date.now(), id, 'armed'));
      }
      await this.scheduleAlarm(deadlines);
    });
  }

  private async cancelDeadlineAndAlarm(id: DeadlineId): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      const current = await loadDeadlines(this.ctx.storage);
      if (current[id] === undefined) return;
      const deadlines = cancelDeadline(current, id);
      await saveDeadlines(this.ctx.storage, deadlines);
      await this.appendLog(deadlineTransition(Date.now(), id, 'cancelled'));
      await this.scheduleAlarm(deadlines);
    });
  }

  private async scheduleAlarm(deadlines: DeadlineTable = emptyDeadlines()): Promise<void> {
    const next = nextAlarmAt(deadlines);
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(next);
  }

  private async appendLog(row: TransitionRow): Promise<void> {
    const log = await loadTransitionLog(this.ctx.storage);
    await saveTransitionLog(this.ctx.storage, appendTransition(log, row));
  }

  private logDiagnostic(
    event: string,
    fields: ControlDiagnosticFields,
    level: 'info' | 'warn' = 'info'
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
