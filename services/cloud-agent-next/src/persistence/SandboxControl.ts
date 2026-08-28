import { DurableObject } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { withTimeout } from '@kilocode/worker-utils';
import { z } from 'zod';
import type { Env } from '../types.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import { logger } from '../logger.js';
import {
  createSandboxControlSocketHandler,
  type SandboxControlConnectionIdentity,
  type SandboxControlOutboundRequest,
  type SandboxControlSocketHandler,
} from '../sandbox-control/socket.js';
import { parseOperationPayload } from '../sandbox-control/frames.js';
import {
  generateSandboxCredential,
  hashSandboxCredential,
  parseBearerCredential,
  sandboxCredentialMatchesHash,
} from '../sandbox-control/credential.js';
import {
  SANDBOX_CONTROL_AUTO_PING,
  SANDBOX_CONTROL_AUTO_PONG,
  sessionRequestIdentitySchema,
  wrapperInstanceIdSchema,
  type ResponseFrame,
  type SandboxHeartbeatPayload,
  type SessionEventIdentity,
  type SessionEventPayload,
  type SessionPreparingPayload,
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
  type ObserveResult,
  type PhysicalRecord,
} from '../sandbox-control/physical-lifecycle.js';
import {
  applyReportedSessionState,
  attachRoute,
  detachRoute,
  hasActiveWork,
  resolveSessionEventRoute,
  type AttachRouteInput,
  type SessionRoute,
} from '../sandbox-control/session-routes.js';
import {
  projectReportedStatus,
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
  loadRouteTable,
  loadTransitionLog,
  saveDeadlines,
  savePhysicalRecord,
  saveRouteTable,
  saveTransitionLog,
} from '../sandbox-control/durable-state.js';
import { withDORetry } from '../utils/do-retry.js';
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
import { createCloudflareProviderAdapter } from '../sandbox-control/cloudflare-provider.js';
import { createVercelProviderAdapter } from '../sandbox-control/vercel-provider.js';
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
import { deriveSandboxAllocationId, getSandboxNamespace } from '../sandbox-id.js';
import {
  validateTerminalBillingRuntime,
  type SandboxTerminalAccessInput,
  type SandboxTerminalAccessResult,
} from '../sandbox-control/terminal-billing.js';
import type { AgentSandboxProvider } from '../types.js';

const CREDENTIAL_HASH_KEY = 'wrapper_credential_hash';
const OWNER_ID_KEY = 'owner_id';
const WRAPPER_READY_AT_KEY = 'wrapper_ready_at';
const ACTIVE_WRAPPER_RUNTIME_KEY = 'active_wrapper_runtime';
const DIAGNOSTIC_BUNDLE_KEY = 'diagnostic_bundle';
const PROVIDER_KIND_KEY = 'provider_kind';
const BILLING_INPUT_KEY = 'billing_input';
const ACQUISITION_RECEIPTS_KEY = 'acquisition_receipts';

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
};

type TerminalRuntimeRejection = {
  allowed: false;
  reason: string;
};

export type AttachSessionInput = AttachRouteInput;

export type SandboxControlStatus = {
  reported: ReportedSandboxStatus;
  physical: PhysicalRecord['state'];
  connection: ConnectionState;
  work: WorkState;
  wrapperInstanceId?: string;
};

export class SandboxControl extends DurableObject<Env> {
  readonly sandboxId: string;
  private socketHandler: SandboxControlSocketHandler;
  private kiloReady = false;
  private activeConnection: SandboxControlConnectionIdentity | null = null;
  private readyConnectionId: string | null = null;
  private providerKind: AgentSandboxProvider = 'cloudflare';
  private readonly sessionForwardChains = new Map<string, Promise<void>>();
  private provider: ProviderAdapter;
  private stopAttemptInFlight: {
    physical: PhysicalRecord;
    promise: Promise<PhysicalRecord>;
  } | null = null;
  private providerStopInFlight: {
    physical: PhysicalRecord;
    promise: Promise<StopResult>;
  } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sandboxId = ctx.id.name ?? ctx.id.toString();
    this.provider = this.createProviderAdapter('cloudflare');
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(SANDBOX_CONTROL_AUTO_PING, SANDBOX_CONTROL_AUTO_PONG)
    );
    this.socketHandler = createSandboxControlSocketHandler(ctx, this.sandboxId, undefined, {
      onHandshakeComplete: identity => this.onHandshakeComplete(identity),
      onReady: identity => this.onWrapperReady(identity),
      onHeartbeat: (payload, identity) => this.onHeartbeat(payload, identity),
      onSessionEvent: (sessionIdentity, payload, identity) =>
        this.onSessionEvent(sessionIdentity, payload, identity),
      onSessionPreparing: (sessionIdentity, payload, identity) =>
        this.onSessionPreparing(sessionIdentity, payload, identity),
      onSocketClosed: (handshakeComplete, identity) =>
        this.onSocketClosed(handshakeComplete, identity),
    });
    void ctx.blockConcurrencyWhile(async () => {
      const [readyAt, runtime, kind, physical] = await Promise.all([
        ctx.storage.get<number>(WRAPPER_READY_AT_KEY),
        ctx.storage.get<PersistedWrapperRuntime>(ACTIVE_WRAPPER_RUNTIME_KEY),
        ctx.storage.get<AgentSandboxProvider>(PROVIDER_KIND_KEY),
        loadPhysicalRecord(ctx.storage),
      ]);
      this.providerKind = kind ?? 'cloudflare';
      this.provider = this.createProviderAdapter(this.providerKind, physical);
      await this.repairLifecycleScheduling(physical);
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
        this.readyConnectionId = current.connectionId;
        this.kiloReady = true;
      } else {
        this.kiloReady = !runtime && current !== null && readyAt !== undefined;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get('Upgrade');
    if (upgrade?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const authorized = await this.authorizeWrapper(request);
    if (!authorized) {
      logger.withFields({ sandboxId: this.sandboxId }).warn('Sandbox control rejected credential');
      return new Response('Unauthorized', { status: 401 });
    }

    const response = this.socketHandler.accept();
    await this.armDeadlineAndAlarm('socketHandshake', Date.now() + DEADLINE_MS.socketHandshake);
    return response;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.socketHandler.handleMessage(ws, message);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.socketHandler.handleClose(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.socketHandler.handleClose(ws);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const deadlines = await loadDeadlines(this.ctx.storage);
    for (const id of dueDeadlines(deadlines, now)) {
      const before = await loadDeadlines(this.ctx.storage);
      if (before[id] === undefined || before[id] > now) continue;
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
    return this.readOwner();
  }

  async request(input: SandboxControlOutboundRequest): Promise<ResponseFrame> {
    const expectedWrapperInstanceId =
      input.expectedWrapperInstanceId === undefined
        ? undefined
        : wrapperInstanceIdSchema.parse(input.expectedWrapperInstanceId);
    const runtime = this.readyWrapperRuntime();
    if (!runtime) throw new Error('Sandbox runtime is not ready');
    if (
      expectedWrapperInstanceId !== undefined &&
      runtime.wrapperInstanceId !== expectedWrapperInstanceId
    ) {
      throw new Error('Sandbox wrapper runtime changed');
    }
    const isCurrent = () => {
      const current = this.readyWrapperRuntime();
      return current !== null && this.sameConnection(current, runtime);
    };
    const physical = await loadPhysicalRecord(this.ctx.storage);
    if (
      physical.state !== 'running' ||
      physical.stopTombstone ||
      physical.providerRef !== runtime.providerInstanceId ||
      !isCurrent()
    ) {
      throw new Error('Sandbox runtime is not ready');
    }
    if (input.operation === 'session.attach' || input.operation === 'session.prompt') {
      const payload = parseOperationPayload(input.operation, input.payload);
      if (!payload.ok) throw new Error(payload.error.message);
      const identity = sessionRequestIdentitySchema.safeParse(input.session);
      if (!identity.success) throw new Error('session identity is required');
      await this.ctx.storage.transaction(async () => {
        const current = await loadPhysicalRecord(this.ctx.storage);
        const route = (await loadRouteTable(this.ctx.storage)).get(identity.data.sessionId);
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
          route.directory !== identity.data.directory
        ) {
          throw new Error('Session is not attached to this sandbox runtime');
        }
        const deadlines = await loadDeadlines(this.ctx.storage);
        const next = armDeadline(
          deadlines,
          'idleStop',
          Math.max(deadlines.idleStop ?? 0, Date.now() + DEADLINE_MS.idleStop)
        );
        await saveDeadlines(this.ctx.storage, next);
        if (deadlines.idleStop === undefined) {
          await this.appendLog(deadlineTransition(Date.now(), 'idleStop', 'armed'));
        }
        await this.scheduleAlarm(next);
        if (!isCurrent()) throw new Error('Sandbox wrapper runtime changed');
      });
    }
    if (!isCurrent()) throw new Error('Sandbox wrapper runtime changed');
    return this.socketHandler.sendRequest(input);
  }

  async quarantineRuntime(input: {
    ownerId: string;
    sessionId: string;
    wrapperInstanceId: string;
    reason: string;
  }): Promise<{ quarantined: boolean }> {
    if (
      typeof input.ownerId !== 'string' ||
      !input.ownerId ||
      typeof input.sessionId !== 'string' ||
      !input.sessionId ||
      typeof input.wrapperInstanceId !== 'string' ||
      !input.wrapperInstanceId ||
      typeof input.reason !== 'string' ||
      !input.reason ||
      input.reason.length > 256
    ) {
      throw new Error('Invalid sandbox quarantine request');
    }
    const [ownerId, physical] = await Promise.all([
      this.readOwner(),
      loadPhysicalRecord(this.ctx.storage),
    ]);
    if (ownerId !== input.ownerId) throw new Error('Sandbox owner mismatch');
    if (physical.state === 'stopped') return { quarantined: false };
    const wrapperInstanceId =
      physical.stopTombstone?.wrapperInstanceId ?? this.activeConnection?.wrapperInstanceId;
    if (wrapperInstanceId !== input.wrapperInstanceId) return { quarantined: false };
    if (!physical.stopTombstone) {
      const next = beginStop(physical, input.reason, Date.now(), wrapperInstanceId);
      await this.persistPhysical(physical, next, input.reason);
      this.ctx.waitUntil(this.recordStopAttempt());
    } else {
      await this.repairLifecycleScheduling(physical);
    }
    return { quarantined: true };
  }

  async ensureReady(input: {
    ownerId: string;
    provider?: AgentSandboxProvider;
    kiloToken?: string;
    allowCreate?: boolean;
    acquisition?: SandboxAcquisition;
    billing?: SandboxBillingInput;
  }): Promise<SandboxControlStatus> {
    const acquisition =
      input.acquisition === undefined
        ? undefined
        : sandboxAcquisitionSchema.parse(input.acquisition);
    if (acquisition) assertAcquisitionDeadline(acquisition);
    const { ownerId } = await this.initializeOwner(input.ownerId);
    await this.pinProvider(input.provider);
    if (acquisition && this.providerKind !== 'cloudflare') {
      throw new Error('Sandbox acquisition is only supported for Cloudflare');
    }
    const billing = await this.billingInput(ownerId, input.billing);
    let physical: PhysicalRecord;
    let creating = false;
    if (acquisition) {
      let selected = await this.acquirePhysical(acquisition);
      if (selected.action === 'wait') {
        const step = nextEnsureReadyStep(selected.physical.state, true);
        if (step === 'release-failed') {
          await this.releaseIfAuthoritativelyDead(selected.physical);
          selected = await this.acquirePhysical(acquisition);
        } else if (step === 'observe-unknown') {
          await this.observeCurrentProvider(selected.physical);
          selected = await this.acquirePhysical(acquisition);
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
        const intentId = crypto.randomUUID();
        const allocationName = await deriveSandboxAllocationId(this.sandboxId, intentId);
        physical = await this.claimCreate(intentId, this.provider.resumable, allocationName);
        creating = true;
      }
    }
    const currentStatus = () =>
      acquisition ? this.acquisitionStatus(acquisition, physical) : this.getStatus();
    if (creating) {
      this.provider = this.createProviderAdapter(this.providerKind, physical);
      const intent = physical.createIntent;
      if (!intent) throw new Error('Sandbox create intent is unavailable');
      const credential = generateSandboxCredential();
      const credentialHash = await hashSandboxCredential(credential);
      const beforeCreate = await loadPhysicalRecord(this.ctx.storage);
      if (!sameAllocation(beforeCreate, physical) || beforeCreate.stopTombstone) {
        return currentStatus();
      }
      await this.ctx.storage.put(CREDENTIAL_HASH_KEY, credentialHash);
      await this.appendLog(credentialTransition(Date.now(), 'issued'));
      try {
        if (acquisition) assertAcquisitionDeadline(acquisition);
        const created = await withTimeout(
          this.provider.create({ ...intent, ...(billing ? { billing } : {}) }),
          DEADLINE_MS.startup,
          'Sandbox allocation timed out'
        );
        if ('providerRef' in created) {
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
          if (acquisition) assertAcquisitionDeadline(acquisition);
          await withTimeout(
            this.provider.launch(
              created.providerRef,
              this.wrapperLaunchEnv(credential, input.kiloToken)
            ),
            DEADLINE_MS.startup,
            'Sandbox wrapper launch timed out'
          );
        }
      } catch {
        logger
          .withFields({ sandboxId: this.sandboxId })
          .warn('Sandbox allocation or launch failed');
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
    } else if (
      physical.state === 'running' &&
      physical.providerRef !== null &&
      !physical.stopTombstone
    ) {
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
    return currentStatus();
  }

  private async acquirePhysical(acquisition: SandboxAcquisition): Promise<{
    physical: PhysicalRecord;
    action: 'create' | 'reuse' | 'wait';
  }> {
    const intentId = crypto.randomUUID();
    const allocationName = await deriveSandboxAllocationId(this.sandboxId, intentId);
    return this.ctx.storage.transaction(async () => {
      const physical = await loadPhysicalRecord(this.ctx.storage, this.provider.resumable);
      if (await this.bindAcquisition(acquisition, physical)) return { physical, action: 'reuse' };
      if (physical.state !== 'stopped' || physical.stopTombstone) {
        return { physical, action: 'wait' };
      }
      const next = claimCreate(physical, intentId, Date.now(), allocationName);
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

  async attachSession(input: AttachSessionInput): Promise<SessionRoute> {
    const ownerId = await this.requireOwner();
    const table = await loadRouteTable(this.ctx.storage);
    const result = attachRoute(table, input, ownerId);
    await saveRouteTable(this.ctx.storage, result.table);
    if (result.changed) {
      await this.appendLog(
        routeTransition(Date.now(), 'attach', input.sessionId, input.kiloSessionId)
      );
    }
    return result.route;
  }

  async detachSession(sessionId: string): Promise<{ existed: boolean }> {
    const table = await loadRouteTable(this.ctx.storage);
    const result = detachRoute(table, sessionId);
    await saveRouteTable(this.ctx.storage, result.table);
    if (result.existed) {
      await this.appendLog(routeTransition(Date.now(), 'detach', sessionId));
    }
    if (!hasActiveWork(result.table)) {
      const physical = await loadPhysicalRecord(this.ctx.storage);
      if (physical.state === 'running') {
        await this.armDeadlineIfAbsent('idleStop', Date.now() + DEADLINE_MS.idleStop);
      }
    }
    return { existed: result.existed };
  }

  async listRoutes(): Promise<SessionRoute[]> {
    const table = await loadRouteTable(this.ctx.storage);
    return [...table.values()];
  }

  async validateTerminalAccess(
    input: SandboxTerminalAccessInput
  ): Promise<SandboxTerminalAccessResult> {
    const runtime = await this.readTerminalRuntime(input);
    if (!runtime.allowed) return runtime;

    const enforced = isCloudAgentContainerBillingEnabled(this.env, {
      userId: input.ownerId,
      ...(input.organizationId ? { orgId: input.organizationId } : {}),
    });
    if (!enforced) return { allowed: true };
    if (runtime.provider !== 'cloudflare') {
      return { allowed: false, reason: 'billing_policy_unavailable' };
    }

    let billing: SandboxTerminalAccessResult;
    try {
      const allocationId = runtime.physical.providerRef;
      if (!allocationId) return { allowed: false, reason: 'runtime_not_running' };
      const namespace = getSandboxNamespace(this.env, allocationId);
      const sandbox = getSandbox(namespace, allocationId);
      billing = validateTerminalBillingRuntime({
        access: input,
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

    const current = await this.readTerminalRuntime(input);
    if (!current.allowed) return current;
    if (
      !this.sameConnection(current.connection, runtime.connection) ||
      current.provider !== runtime.provider ||
      current.physical.providerRef !== runtime.physical.providerRef ||
      current.route.kiloSessionId !== runtime.route.kiloSessionId ||
      current.route.directory !== runtime.route.directory
    ) {
      return { allowed: false, reason: 'runtime_changed' };
    }
    return { allowed: true };
  }

  async recordTerminalActivity(
    input: SandboxTerminalAccessInput
  ): Promise<SandboxTerminalAccessResult> {
    const access = await this.validateTerminalAccess(input);
    if (!access.allowed) return access;

    const runtime = await this.readTerminalRuntime(input);
    if (!runtime.allowed) return runtime;
    if (runtime.provider === 'vercel') return { allowed: true };

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
    };
  }

  async getPhysicalRecord(): Promise<PhysicalRecord> {
    return loadPhysicalRecord(this.ctx.storage);
  }

  async getTransitionLog(): Promise<TransitionRow[]> {
    return loadTransitionLog(this.ctx.storage);
  }

  async claimCreate(
    intentId: string,
    resumable = false,
    allocationName?: string
  ): Promise<PhysicalRecord> {
    return this.ctx.storage.transaction(async () => {
      const current = await loadPhysicalRecord(this.ctx.storage, resumable);
      const next = claimCreate(current, intentId, Date.now(), allocationName);
      const vercel =
        this.providerKind === 'vercel' ? parseVercelSandboxRuntimeConfig(this.env) : undefined;
      if (vercel && next.createIntent) {
        const { projectId, snapshotId, runtimeBuildId, runtime } = vercel;
        next.createIntent = {
          ...next.createIntent,
          vercel: { projectId, snapshotId, runtimeBuildId, runtime },
        };
      }
      await this.persistPhysicalState(current, next, 'demand');
      return next;
    });
  }

  async confirmInstance(providerRef: string): Promise<PhysicalRecord> {
    const current = await loadPhysicalRecord(this.ctx.storage);
    const next = confirmRunning(current, providerRef, Date.now());
    await this.persistPhysical(current, next, 'instance confirmed');
    return next;
  }

  async observeProvider(result: ObserveResult): Promise<PhysicalRecord> {
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
    const current = await loadPhysicalRecord(this.ctx.storage);
    if (current.state === 'stopped' || current.stopTombstone) return current;
    const next = beginStop(current, reason, Date.now(), this.activeConnection?.wrapperInstanceId);
    await this.persistPhysical(current, next, reason);
    return next;
  }

  async recordStopAttempt(): Promise<PhysicalRecord> {
    const current = await loadPhysicalRecord(this.ctx.storage);
    if (this.stopAttemptInFlight && sameAllocation(this.stopAttemptInFlight.physical, current)) {
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
      pending = {
        physical,
        promise: withTimeout(
          this.provider.stop(physical.providerRef, physical.createIntent),
          DEADLINE_MS.stopAttempt,
          'Sandbox stop attempt timed out'
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
      logger.withFields({ sandboxId: this.sandboxId }).warn('Sandbox stop attempt failed');
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
    const current = await loadPhysicalRecord(this.ctx.storage);
    const next = confirmStopped(current);
    await this.persistPhysical(current, next, 'terminal');
    return next;
  }

  async markFailed(): Promise<PhysicalRecord> {
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

  async eraseRecord(): Promise<void> {
    await eraseSandboxRecord(this.ctx.storage);
    await this.ctx.storage.delete([
      OWNER_ID_KEY,
      CREDENTIAL_HASH_KEY,
      WRAPPER_READY_AT_KEY,
      ACTIVE_WRAPPER_RUNTIME_KEY,
      DIAGNOSTIC_BUNDLE_KEY,
      PROVIDER_KIND_KEY,
      BILLING_INPUT_KEY,
      ACQUISITION_RECEIPTS_KEY,
    ]);
  }

  private createProviderAdapter(
    kind: AgentSandboxProvider,
    physical?: PhysicalRecord
  ): ProviderAdapter {
    if (kind === 'vercel') {
      return createVercelProviderAdapter({
        sandboxName: this.sandboxId,
        config: resolveVercelSandboxRuntimeConfig(this.env, physical?.createIntent?.vercel),
      });
    }
    return createCloudflareProviderAdapter({
      sandboxId: this.sandboxId,
      getSandbox: id => getSandbox(getSandboxNamespace(this.env, id), id),
      destroy: id =>
        forceDestroyControlPlaneSandbox(getSandboxNamespace(this.env, id).getByName(id)),
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
    supplied?: SandboxBillingInput
  ): Promise<SandboxBillingInput | undefined> {
    const raw = await this.ctx.storage.get<unknown>(BILLING_INPUT_KEY);
    const stored = raw === undefined ? undefined : parseSandboxBillingInput(raw);
    const input = supplied === undefined ? stored : parseSandboxBillingInput(supplied);
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

  private wrapperLaunchEnv(credential: string, kiloToken?: string): Record<string, string> {
    return buildControlWrapperLaunchEnv({
      workerUrl: this.env.WORKER_URL,
      sandboxId: this.sandboxId,
      credential,
      kiloToken,
      kiloTargetEnv: this.env,
    });
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
      const physical = await loadPhysicalRecord(this.ctx.storage);
      if (physical.state === 'creating' || physical.state === 'running') {
        await this.markFailed();
      }
      return;
    }
    if (id === 'heartbeatExpiry') {
      const connection = this.activeConnection;
      if (connection) await this.quarantineConnection(connection, 'heartbeat_expired');
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
    if (id === 'reconciliation') {
      const physical = await loadPhysicalRecord(this.ctx.storage);
      if (this.shouldSlowReap(physical)) {
        await this.reapExhaustedAllocation(physical);
      } else if (planReconciliation(physical.state) !== 'none') {
        await this.observeCurrentProvider(physical);
      }
    }
  }

  private async onHandshakeComplete(identity: SandboxControlConnectionIdentity): Promise<void> {
    const socketConnection = this.socketHandler.getConnectionIdentity();
    if (!socketConnection || !this.sameConnection(socketConnection, identity)) return;

    const physical = await loadPhysicalRecord(this.ctx.storage);
    if (
      physical.stopTombstone ||
      (physical.state !== 'running' && physical.state !== 'creating') ||
      (physical.providerRef !== null && physical.providerRef !== identity.providerInstanceId) ||
      (this.providerKind === 'cloudflare' &&
        physical.createIntent?.allocationName !== undefined &&
        physical.createIntent.allocationName !== identity.providerInstanceId)
    ) {
      this.socketHandler.closeAll('Sandbox runtime unavailable');
      return;
    }
    const previous = this.activeConnection;
    if (previous && !this.sameConnection(previous, identity)) {
      await this.quarantineConnection(previous, 'control_replaced');
      return;
    }
    const now = Date.now();
    await this.ctx.storage.transaction(async () => {
      await this.ctx.storage.put(ACTIVE_WRAPPER_RUNTIME_KEY, identity);
      await this.ctx.storage.delete(WRAPPER_READY_AT_KEY);
      if (physical.state === 'creating') {
        const providerRef =
          physical.providerRef ??
          (this.providerKind === 'cloudflare' ? identity.providerInstanceId : undefined);
        if (providerRef !== undefined) {
          await savePhysicalRecord(this.ctx.storage, confirmRunning(physical, providerRef, now));
          await this.appendLog(
            physicalTransition(now, physical.state, 'running', 'hello', providerRef)
          );
        }
      }
      let deadlines = await loadDeadlines(this.ctx.storage);
      deadlines = cancelDeadline(cancelDeadline(deadlines, 'heartbeatExpiry'), 'socketHandshake');
      deadlines = armDeadline(
        cancelDeadline(deadlines, 'startup'),
        'wrapperReadiness',
        now + DEADLINE_MS.wrapperReadiness
      );
      await saveDeadlines(this.ctx.storage, deadlines);
      await this.scheduleAlarm(deadlines);
      await this.appendLog(connectionTransition(now, 'disconnected', 'connected', 'hello'));
    });
    this.activeConnection = identity;
    this.readyConnectionId = null;
    this.kiloReady = false;
    this.socketHandler.closeProvisionalSockets();
  }

  private async onWrapperReady(identity: SandboxControlConnectionIdentity): Promise<void> {
    const physical = await loadPhysicalRecord(this.ctx.storage);
    if (
      !this.isCurrentConnection(identity) ||
      physical.state !== 'running' ||
      physical.stopTombstone ||
      physical.providerRef !== identity.providerInstanceId
    )
      return;
    const now = Date.now();
    await this.ctx.storage.transaction(async () => {
      await this.ctx.storage.put({
        [ACTIVE_WRAPPER_RUNTIME_KEY]: {
          ...identity,
          readyConnectionId: identity.connectionId,
        } satisfies PersistedWrapperRuntime,
        [WRAPPER_READY_AT_KEY]: now,
      });
      let deadlines = cancelDeadline(await loadDeadlines(this.ctx.storage), 'wrapperReadiness');
      deadlines = armDeadline(deadlines, 'heartbeatExpiry', now + DEADLINE_MS.heartbeatExpiry);
      deadlines = armDeadline(
        deadlines,
        'idleStop',
        deadlines.idleStop ?? now + DEADLINE_MS.idleStop
      );
      await saveDeadlines(this.ctx.storage, deadlines);
      await this.scheduleAlarm(deadlines);
      await this.appendLog(connectionTransition(now, 'connected', 'ready', 'sandbox.ready'));
    });
    if (!this.isCurrentConnection(identity)) return;
    this.readyConnectionId = identity.connectionId;
    this.kiloReady = true;
  }

  private async onHeartbeat(
    payload: SandboxHeartbeatPayload,
    identity: SandboxControlConnectionIdentity
  ): Promise<void> {
    if (!this.isCurrentConnection(identity)) return;
    if (!payload.kilo.ready) {
      await this.quarantineConnection(identity, 'kilo_unhealthy');
      return;
    }
    if (!this.readyWrapperRuntime()) return;

    const now = Date.now();
    await this.ctx.storage.transaction(async () => {
      const table = await loadRouteTable(this.ctx.storage);
      if (!this.isCurrentConnection(identity)) return;
      const reported = new Map(payload.sessions.map(session => [session.kiloSessionId, session]));
      for (const route of table.values()) {
        const report = reported.get(route.kiloSessionId) ?? {
          state: 'idle' as const,
          idleForMs: 0,
        };
        const previousState = route.lastState;
        const applied = applyReportedSessionState(table, route.kiloSessionId, report, now);
        if (applied.changed) {
          await this.appendLog(
            sessionStateTransition(now, route.kiloSessionId, previousState, report.state)
          );
        }
      }
      await saveRouteTable(this.ctx.storage, table);
      let deadlines = armDeadline(
        await loadDeadlines(this.ctx.storage),
        'heartbeatExpiry',
        now + DEADLINE_MS.heartbeatExpiry
      );
      if (payload.state !== 'idle' || (payload.pendingMessages ?? 0) > 0 || hasActiveWork(table)) {
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
    });
    await this.renewProviderLease(identity);
  }

  private async renewProviderLease(identity: SandboxControlConnectionIdentity): Promise<void> {
    const physical = await loadPhysicalRecord(this.ctx.storage);
    if (
      !this.isCurrentConnection(identity) ||
      !this.readyWrapperRuntime() ||
      physical.state !== 'running' ||
      physical.stopTombstone !== null ||
      physical.providerRef === null
    ) {
      return;
    }
    try {
      await withTimeout(
        this.provider.ensureLeaseAtLeast(physical.providerRef, leaseAtLeastMs()),
        DEADLINE_MS.stopAttempt,
        'Sandbox lease renewal timed out'
      );
    } catch {
      logger.withFields({ sandboxId: this.sandboxId }).warn('Provider lease renewal failed');
    }
  }

  private async onSessionEvent(
    identity: SessionEventIdentity | undefined,
    payload: SessionEventPayload,
    connection: SandboxControlConnectionIdentity
  ): Promise<void> {
    if (!this.isCurrentConnection(connection)) return;
    if (!identity) {
      logger
        .withFields({ sandboxId: this.sandboxId, eventType: payload.type })
        .warn('session.event missing identity');
      return;
    }
    await this.forwardRoutedSessionFrame(identity, payload.type, connection, route =>
      this.forwardSessionEvent(route, identity, payload, connection)
    );
  }

  private async onSessionPreparing(
    identity: SessionEventIdentity | undefined,
    payload: SessionPreparingPayload,
    connection: SandboxControlConnectionIdentity
  ): Promise<void> {
    if (!this.isCurrentConnection(connection)) return;
    if (!identity) {
      logger
        .withFields({ sandboxId: this.sandboxId, eventType: 'session.preparing' })
        .warn('session.event missing identity');
      return;
    }
    await this.forwardRoutedSessionFrame(identity, 'session.preparing', connection, route =>
      this.forwardSessionPreparing(route, identity, payload, connection)
    );
  }

  private async forwardRoutedSessionFrame(
    identity: SessionEventIdentity,
    eventType: string,
    connection: SandboxControlConnectionIdentity,
    forward: (route: SessionRoute) => Promise<void>
  ): Promise<void> {
    const table = await loadRouteTable(this.ctx.storage);
    if (!this.isCurrentConnection(connection)) return;
    const route = resolveSessionEventRoute(table, identity);
    if (!route) {
      logger
        .withFields({
          sandboxId: this.sandboxId,
          eventType,
          directory: identity.directory,
          kiloSessionId: identity.kiloSessionId,
          rootKiloSessionId: identity.rootKiloSessionId,
        })
        .warn('session.event unroutable');
      return;
    }

    const previous = this.sessionForwardChains.get(route.sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => (this.isCurrentConnection(connection) ? forward(route) : undefined));
    this.sessionForwardChains.set(route.sessionId, next);
    this.ctx.waitUntil(next);
  }

  private async forwardSessionEvent(
    route: SessionRoute,
    identity: SessionEventIdentity,
    payload: SessionEventPayload,
    connection: SandboxControlConnectionIdentity
  ): Promise<void> {
    if (!this.isCurrentConnection(connection)) return;
    const delivered = await withTimeout(
      withDORetry(
        () => getSandboxSessionStub(this.env, route.ownerId, route.sessionId),
        stub =>
          this.isCurrentConnection(connection)
            ? stub.receiveSandboxControlEvent({
                identity,
                payload,
                wrapperInstanceId: connection.wrapperInstanceId,
              })
            : Promise.resolve({ applied: true }),
        'receiveSandboxControlEvent'
      ),
      DEADLINE_MS.stopAttempt,
      'Sandbox event forwarding timed out'
    ).then(
      () => true,
      () => false
    );
    if (!delivered) await this.quarantineForwardingFailure(route, connection);
  }

  private async forwardSessionPreparing(
    route: SessionRoute,
    identity: SessionEventIdentity,
    payload: SessionPreparingPayload,
    connection: SandboxControlConnectionIdentity
  ): Promise<void> {
    if (!this.isCurrentConnection(connection)) return;
    const delivered = await withTimeout(
      withDORetry(
        () => getSandboxSessionStub(this.env, route.ownerId, route.sessionId),
        stub =>
          this.isCurrentConnection(connection)
            ? stub.receiveSandboxControlPreparing({
                identity,
                payload,
                wrapperInstanceId: connection.wrapperInstanceId,
              })
            : Promise.resolve({ applied: true }),
        'receiveSandboxControlPreparing'
      ),
      DEADLINE_MS.stopAttempt,
      'Sandbox preparation forwarding timed out'
    ).then(
      () => true,
      () => false
    );
    if (!delivered) await this.quarantineForwardingFailure(route, connection);
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
      current.kiloSessionId !== route.kiloSessionId
    )
      return;
    await this.quarantineConnection(connection, 'session_delivery_failed');
  }

  private async onSocketClosed(
    handshakeComplete: boolean,
    identity?: SandboxControlConnectionIdentity
  ): Promise<void> {
    if (!handshakeComplete || !identity || !this.isActiveConnection(identity)) return;
    const replacement = this.socketHandler.getConnectionIdentity();
    if (replacement && !this.sameConnection(replacement, identity)) return;
    await this.quarantineConnection(identity, 'control_disconnected');
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
    let result: ProviderObservation;
    try {
      result = await withTimeout(
        this.provider.observe(physical.providerRef, physical.createIntent),
        DEADLINE_MS.stopAttempt,
        'Sandbox observation timed out'
      );
    } catch {
      result = { status: 'unknown' };
    }
    const current = await loadPhysicalRecord(this.ctx.storage);
    if (!sameAllocation(current, physical) || current.state === 'stopped') return current;
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

  private async readTerminalRuntime(
    input: SandboxTerminalAccessInput
  ): Promise<TerminalRuntimeSnapshot | TerminalRuntimeRejection> {
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

    const [ownerId, routes, physical] = await Promise.all([
      this.readOwner(),
      loadRouteTable(this.ctx.storage),
      loadPhysicalRecord(this.ctx.storage),
    ]);
    if (ownerId !== input.ownerId) return { allowed: false, reason: 'owner_mismatch' };
    const route = routes.get(input.sessionId);
    if (!route || route.ownerId !== input.ownerId) {
      return { allowed: false, reason: 'session_not_attached' };
    }
    if (physical.state !== 'running' || physical.stopTombstone || physical.providerRef === null) {
      return { allowed: false, reason: 'runtime_not_running' };
    }

    const connection = this.readyWrapperRuntime();
    if (!connection) return { allowed: false, reason: 'runtime_not_ready' };
    if (!connection.wrapperInstanceId) {
      return { allowed: false, reason: 'terminal_not_supported' };
    }
    if (connection.wrapperInstanceId !== input.wrapperInstanceId) {
      return { allowed: false, reason: 'wrapper_instance_mismatch' };
    }

    return { allowed: true, connection, physical, provider: this.providerKind, route };
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
    const changed =
      from.state !== to.state || (from.stopTombstone === null && to.stopTombstone !== null);
    const unavailable =
      to.stopTombstone !== null || (to.state !== 'creating' && to.state !== 'running');
    await this.ctx.storage.transaction(() => this.persistPhysicalState(from, to, cause));
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
    if (changed) {
      await this.appendLog(
        physicalTransition(Date.now(), from.state, to.state, cause, to.providerRef)
      );
    }
    const deadlines = await loadDeadlines(this.ctx.storage);
    let next = deadlines;
    if (to.state === 'creating') {
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
    await saveDeadlines(this.ctx.storage, next);
    await this.scheduleAlarm(next);
  }

  private async invalidateTerminalRuntime(
    wrapperInstanceId: string,
    confirmed: boolean
  ): Promise<void> {
    const routes = await loadRouteTable(this.ctx.storage);
    await Promise.all(
      [...routes.values()].map(route => {
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
        ).catch(() => undefined);
      })
    );
  }

  private async notifyAttachedSessions(reason: string, wrapperInstanceId: string): Promise<void> {
    const table = await loadRouteTable(this.ctx.storage);
    await Promise.all(
      [...table.values()].map(route =>
        withTimeout(
          withDORetry(
            () => getSandboxSessionStub(this.env, route.ownerId, route.sessionId),
            stub => stub.failWaitingMessages(reason, wrapperInstanceId),
            'failWaitingMessages'
          ),
          DEADLINE_MS.stopAttempt,
          'Sandbox failure notification timed out'
        ).catch(() => undefined)
      )
    );
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

  private async requireOwner(): Promise<string> {
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
