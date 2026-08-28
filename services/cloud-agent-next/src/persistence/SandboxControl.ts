import { DurableObject } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import type { Env } from '../types.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import { logger } from '../logger.js';
import {
  createSandboxControlSocketHandler,
  type SandboxControlConnectionIdentity,
  type SandboxControlOutboundRequest,
  type SandboxControlSocketHandler,
} from '../sandbox-control/socket.js';
import {
  generateSandboxCredential,
  hashSandboxCredential,
  parseBearerCredential,
  sandboxCredentialMatchesHash,
} from '../sandbox-control/credential.js';
import {
  SANDBOX_CONTROL_AUTO_PING,
  SANDBOX_CONTROL_AUTO_PONG,
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
  type ObserveResult,
  type PhysicalRecord,
} from '../sandbox-control/physical-lifecycle.js';
import {
  applyReportedSessionState,
  attachRoute,
  detachRoute,
  hasActiveWork,
  markNeedsSync,
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
import type { ProviderAdapter, StopResult } from '../sandbox-control/provider.js';
import { releaseIfAuthoritativelyDead as applyAuthoritativeRelease } from '../sandbox-control/authoritative-release.js';
import { nextEnsureReadyStep } from '../sandbox-control/ensure-ready.js';
import {
  planReconciliation,
  shouldRearmReconciliation,
} from '../sandbox-control/reconciliation.js';
import { createCloudflareProviderAdapter } from '../sandbox-control/cloudflare-provider.js';
import { createVercelProviderAdapter } from '../sandbox-control/vercel-provider.js';
import { parseVercelSandboxRuntimeConfig } from '../agent-sandbox/vercel/vercel-runtime-config.js';
import { buildControlWrapperLaunchEnv } from '../sandbox-control/wrapper-launch-env.js';
import {
  getSandboxBillingRuntimeStatus,
  isSandboxContainerRunning,
} from '../container-usage-context.js';
import { isCloudAgentContainerBillingEnabled } from '../container-billing-rollout.js';
import { getSandboxNamespace } from '../sandbox-id.js';
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
      const [readyAt, runtime, kind] = await Promise.all([
        ctx.storage.get<number>(WRAPPER_READY_AT_KEY),
        ctx.storage.get<PersistedWrapperRuntime>(ACTIVE_WRAPPER_RUNTIME_KEY),
        ctx.storage.get<AgentSandboxProvider>(PROVIDER_KIND_KEY),
      ]);
      this.providerKind = kind ?? 'cloudflare';
      this.provider = this.createProviderAdapter(this.providerKind);
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
    let deadlines = await loadDeadlines(this.ctx.storage);
    for (const id of dueDeadlines(deadlines, now)) {
      await this.appendLog(deadlineTransition(now, id, 'fired'));
      await this.handleDeadline(id, now);
      const latest = await loadDeadlines(this.ctx.storage);
      const armedAt = latest[id];
      if (armedAt !== undefined && armedAt <= now) {
        deadlines = cancelDeadline(latest, id);
        await saveDeadlines(this.ctx.storage, deadlines);
      } else {
        deadlines = latest;
      }
    }
    await this.scheduleAlarm(deadlines);
  }

  async setWrapperCredentialHash(hash: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error('Invalid wrapper credential hash');
    }
    await this.ctx.storage.put(CREDENTIAL_HASH_KEY, hash);
    const previous = this.activeConnection ?? this.socketHandler.getConnectionIdentity();
    this.activeConnection = null;
    this.readyConnectionId = null;
    this.kiloReady = false;
    this.socketHandler.closeAll('Credential rotated');
    await this.ctx.storage.delete([ACTIVE_WRAPPER_RUNTIME_KEY, WRAPPER_READY_AT_KEY]);
    await this.cancelDeadlineAndAlarm('heartbeatExpiry');
    if (previous?.wrapperInstanceId) {
      await this.invalidateTerminalRuntime(previous.wrapperInstanceId, true);
    }
    await this.appendLog(credentialTransition(Date.now(), 'rotated'));
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
    return this.socketHandler.sendRequest(input);
  }

  async ensureReady(input: {
    ownerId: string;
    provider?: AgentSandboxProvider;
    kiloToken?: string;
    allowCreate?: boolean;
  }): Promise<SandboxControlStatus> {
    await this.initializeOwner(input.ownerId);
    const pinned = await this.pinProvider(input.provider);
    if (!pinned) {
      await this.markFailed();
      return this.getStatus();
    }
    const allowCreate = input.allowCreate === true;
    let physical = await loadPhysicalRecord(this.ctx.storage, this.provider.resumable);
    if (nextEnsureReadyStep(physical.state, allowCreate) === 'release-failed') {
      physical = await this.releaseIfAuthoritativelyDead(physical);
    }
    if (nextEnsureReadyStep(physical.state, allowCreate) === 'observe-unknown') {
      physical = await this.observeCurrentProvider(physical);
      if (physical.state === 'unknown') {
        return this.getStatus();
      }
    }
    if (nextEnsureReadyStep(physical.state, allowCreate) === 'create') {
      const intentId = crypto.randomUUID();
      await this.claimCreate(intentId, this.provider.resumable);
      const credential = generateSandboxCredential();
      await this.ctx.storage.put(CREDENTIAL_HASH_KEY, await hashSandboxCredential(credential));
      await this.appendLog(credentialTransition(Date.now(), 'issued'));
      try {
        const created = await this.provider.create({
          intentId,
          env: this.wrapperLaunchEnv(credential, input.kiloToken),
        });
        if ('providerRef' in created) {
          await this.confirmInstance(created.providerRef);
        }
      } catch (error) {
        logger
          .withFields({
            sandboxId: this.sandboxId,
            error: error instanceof Error ? error.message : 'create failed',
          })
          .warn('Provider create failed');
        await this.markFailed();
      }
    }
    return this.getStatus();
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
      const namespace = getSandboxNamespace(this.env, this.sandboxId);
      const sandbox = getSandbox(namespace, this.sandboxId);
      billing = validateTerminalBillingRuntime({
        access: input,
        sandboxId: this.sandboxId,
        providerInstanceId: runtime.physical.providerRef ?? '',
        sandboxDurableObjectId: namespace.idFromName(this.sandboxId).toString(),
        runtime: await getSandboxBillingRuntimeStatus(sandbox),
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
    const physical = await loadPhysicalRecord(this.ctx.storage);
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

  async claimCreate(intentId: string, resumable = false): Promise<PhysicalRecord> {
    const now = Date.now();
    const current = await loadPhysicalRecord(this.ctx.storage, resumable);
    const next = claimCreate(current, intentId, now);
    await this.persistPhysical(current, next, 'demand');
    await this.armDeadlineAndAlarm('startup', now + DEADLINE_MS.startup);
    return next;
  }

  async confirmInstance(providerRef: string): Promise<PhysicalRecord> {
    const current = await loadPhysicalRecord(this.ctx.storage);
    const next = confirmRunning(current, providerRef, Date.now());
    await this.persistPhysical(current, next, 'instance confirmed');
    return next;
  }

  async observeProvider(result: ObserveResult): Promise<PhysicalRecord> {
    const current = await loadPhysicalRecord(this.ctx.storage);
    const next = observe(current, result);
    await this.persistPhysical(current, next, `observe:${result}`);
    if (current.state === 'unknown' && next.state === 'running') {
      const deadline = this.connectionState() === 'ready' ? 'heartbeatExpiry' : 'wrapperReadiness';
      await this.armDeadlineIfAbsent(deadline, Date.now() + DEADLINE_MS[deadline]);
    }
    if (next.state === 'stopped') {
      await this.cancelDeadlineAndAlarm('startup');
      await this.cancelDeadlineAndAlarm('stopAttempt');
    }
    if (shouldRearmReconciliation(next.state)) {
      await this.armDeadlineAndAlarm('reconciliation', Date.now() + DEADLINE_MS.reconciliation);
    }
    return next;
  }

  async beginStop(reason: string): Promise<PhysicalRecord> {
    const now = Date.now();
    const current = await loadPhysicalRecord(this.ctx.storage);
    const next = beginStop(current, reason, now);
    await this.persistPhysical(current, next, reason);
    await this.armDeadlineAndAlarm('stopAttempt', now + DEADLINE_MS.stopAttempt);
    return next;
  }

  async recordStopAttempt(): Promise<PhysicalRecord> {
    const current = await loadPhysicalRecord(this.ctx.storage);
    const next = recordStopAttempt(current);
    await savePhysicalRecord(this.ctx.storage, next);
    const attempts = next.stopTombstone?.attempts ?? 0;
    if (attempts >= DEADLINE_MS.stopAttemptLadder.length) {
      return this.exhaustStop();
    }
    const delay = DEADLINE_MS.stopAttemptLadder[attempts] ?? DEADLINE_MS.stopAttempt;
    await this.armDeadlineAndAlarm('stopAttempt', Date.now() + delay);
    return next;
  }

  async confirmStopped(): Promise<PhysicalRecord> {
    const current = await loadPhysicalRecord(this.ctx.storage);
    const next = confirmStopped(current);
    await this.persistPhysical(current, next, 'terminal');
    await this.cancelDeadlineAndAlarm('startup');
    await this.cancelDeadlineAndAlarm('stopAttempt');
    await this.cancelDeadlineAndAlarm('reconciliation');
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
    await this.armDeadlineAndAlarm('reconciliation', Date.now() + DEADLINE_MS.reconciliation);
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
    ]);
  }

  private createProviderAdapter(kind: AgentSandboxProvider): ProviderAdapter {
    if (kind === 'vercel') {
      const config = parseVercelSandboxRuntimeConfig(this.env);
      if (config) {
        return createVercelProviderAdapter({ sandboxName: this.sandboxId, config });
      }
    }
    return createCloudflareProviderAdapter({
      sandboxId: this.sandboxId,
      getSandbox: id => {
        const sandbox = getSandbox(getSandboxNamespace(this.env, id), id);
        return {
          renewActivityTimeout: () => sandbox.renewActivityTimeout(),
          destroy: () => sandbox.destroy(),
          isContainerRunning: async () => {
            const running = await isSandboxContainerRunning(sandbox);
            if (running === undefined) throw new Error('Sandbox running state is unavailable');
            return running;
          },
          startProcess: (command, options) => sandbox.startProcess(command, options),
        };
      },
    });
  }

  private async pinProvider(requested?: AgentSandboxProvider): Promise<boolean> {
    const stored = await this.ctx.storage.get<AgentSandboxProvider>(PROVIDER_KIND_KEY);
    const kind = stored ?? requested ?? 'cloudflare';
    if (stored !== undefined && requested !== undefined && stored !== requested) {
      throw new Error('Sandbox provider mismatch');
    }
    if (kind === 'vercel' && parseVercelSandboxRuntimeConfig(this.env) === undefined) {
      logger
        .withFields({ sandboxId: this.sandboxId })
        .warn('Vercel provider requested without runtime config');
      return false;
    }
    if (stored === undefined) {
      await this.ctx.storage.put(PROVIDER_KIND_KEY, kind);
    }
    this.providerKind = kind;
    this.provider = this.createProviderAdapter(kind);
    return true;
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
    await this.armDeadlineAndAlarm('reconciliation', Date.now() + DEADLINE_MS.reconciliation);
    return next;
  }

  private async handleDeadline(id: DeadlineId, now: number): Promise<void> {
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
      this.socketHandler.closeHandshakenSockets(4002, 'heartbeat expired');
      this.kiloReady = false;
      this.readyConnectionId = null;
      if (connection) {
        await this.ctx.storage.put(ACTIVE_WRAPPER_RUNTIME_KEY, connection);
      }
      await this.ctx.storage.delete(WRAPPER_READY_AT_KEY);
      await this.appendLog(connectionTransition(now, 'ready', 'disconnected', 'heartbeatExpiry'));
      await this.armDeadlineIfAbsent('idleStop', now + DEADLINE_MS.idleStop);
      return;
    }
    if (id === 'idleStop') {
      const routes = await loadRouteTable(this.ctx.storage);
      if (hasActiveWork(routes)) {
        await this.armDeadlineAndAlarm('idleStop', now + DEADLINE_MS.idleStop);
        return;
      }
      const physical = await loadPhysicalRecord(this.ctx.storage);
      if (physical.state === 'running') {
        await this.beginStop('idle');
        try {
          const result = await this.provider.stop(physical.providerRef);
          if (result === 'terminal') await this.confirmStopped();
        } catch {
          logger
            .withFields({ sandboxId: this.sandboxId })
            .warn('Idle stop provider call failed; stop-attempt will count the wait');
        }
      }
      return;
    }
    if (id === 'stopAttempt') {
      await this.recordStopAttempt();
      return;
    }
    if (id === 'reconciliation') {
      const physical = await loadPhysicalRecord(this.ctx.storage);
      if (planReconciliation(physical.state) === 'none') return;
      await this.observeCurrentProvider(physical);
    }
  }

  private async onHandshakeComplete(identity: SandboxControlConnectionIdentity): Promise<void> {
    const socketConnection = this.socketHandler.getConnectionIdentity();
    if (!socketConnection || !this.sameConnection(socketConnection, identity)) return;

    const previous = this.activeConnection;
    this.activeConnection = identity;
    this.readyConnectionId = null;
    this.kiloReady = false;
    await Promise.all([
      this.ctx.storage.put(ACTIVE_WRAPPER_RUNTIME_KEY, identity),
      this.ctx.storage.delete(WRAPPER_READY_AT_KEY),
    ]);
    if (!this.isCurrentConnection(identity)) return;
    this.socketHandler.closeProvisionalSockets();
    await this.cancelDeadlineAndAlarm('heartbeatExpiry');
    if (!this.isCurrentConnection(identity)) return;

    if (previous?.wrapperInstanceId && previous.wrapperInstanceId !== identity.wrapperInstanceId) {
      await this.invalidateTerminalRuntime(previous.wrapperInstanceId, true);
      if (!this.isCurrentConnection(identity)) return;
    }

    await this.cancelDeadlineAndAlarm('socketHandshake');
    if (!this.isCurrentConnection(identity)) return;
    const now = Date.now();
    const current = await loadPhysicalRecord(this.ctx.storage);
    if (!this.isCurrentConnection(identity)) return;
    if (current.state === 'creating') {
      const providerRef =
        current.providerRef ??
        (this.providerKind === 'cloudflare' ? identity.providerInstanceId : undefined);
      if (providerRef !== undefined) {
        const next = confirmRunning(current, providerRef, now);
        await this.persistPhysical(current, next, 'hello');
        if (!this.isCurrentConnection(identity)) return;
      }
    }
    await this.appendLog(connectionTransition(now, 'disconnected', 'connected', 'hello'));
    await this.armDeadlineAndAlarm('wrapperReadiness', now + DEADLINE_MS.wrapperReadiness);
    await this.cancelDeadlineAndAlarm('startup');
  }

  private async onWrapperReady(identity: SandboxControlConnectionIdentity): Promise<void> {
    if (!this.isCurrentConnection(identity)) return;
    const now = Date.now();
    await this.ctx.storage.put({
      [ACTIVE_WRAPPER_RUNTIME_KEY]: {
        ...identity,
        readyConnectionId: identity.connectionId,
      } satisfies PersistedWrapperRuntime,
      [WRAPPER_READY_AT_KEY]: now,
    });
    if (!this.isCurrentConnection(identity)) return;
    this.readyConnectionId = identity.connectionId;
    this.kiloReady = true;
    await this.cancelDeadlineAndAlarm('wrapperReadiness');
    await this.appendLog(connectionTransition(now, 'connected', 'ready', 'sandbox.ready'));
    await this.armDeadlineAndAlarm('heartbeatExpiry', now + DEADLINE_MS.heartbeatExpiry);
    await this.armDeadlineIfAbsent('idleStop', now + DEADLINE_MS.idleStop);
  }

  private async onHeartbeat(
    payload: SandboxHeartbeatPayload,
    identity: SandboxControlConnectionIdentity
  ): Promise<void> {
    if (!this.isCurrentConnection(identity)) return;
    this.kiloReady = payload.kilo.ready;
    if (!payload.kilo.ready) {
      this.readyConnectionId = null;
      await Promise.all([
        this.ctx.storage.put(ACTIVE_WRAPPER_RUNTIME_KEY, identity),
        this.ctx.storage.delete(WRAPPER_READY_AT_KEY),
      ]);
      if (!this.isCurrentConnection(identity)) return;
    }

    const now = Date.now();
    const table = await loadRouteTable(this.ctx.storage);
    if (!this.isCurrentConnection(identity)) return;
    for (const session of payload.sessions) {
      if (!this.isCurrentConnection(identity)) return;
      const previous = [...table.values()].find(
        entry => entry.kiloSessionId === session.kiloSessionId
      );
      const previousState = previous?.lastState ?? null;
      const applied = applyReportedSessionState(
        table,
        session.kiloSessionId,
        {
          state: session.state,
          idleForMs: session.idleForMs,
          ...(session.waitingOn ? { waitingOn: session.waitingOn } : {}),
        },
        now
      );
      if (applied.changed) {
        await this.appendLog(
          sessionStateTransition(now, session.kiloSessionId, previousState, session.state)
        );
      }
      const contradictionBudgetMs =
        session.waitingOn === 'tool'
          ? 60_000
          : session.waitingOn === 'finalizing'
            ? Infinity
            : 180_000;
      if (
        previous &&
        (session.state === 'active' || session.state === 'finalizing') &&
        session.idleForMs >= contradictionBudgetMs
      ) {
        markNeedsSync(table, previous.sessionId);
        await this.appendLog({ at: now, kind: 'deadline', cause: 'observe-only' });
      }
    }
    if (!this.isCurrentConnection(identity)) return;
    await saveRouteTable(this.ctx.storage, table);
    await this.armDeadlineAndAlarm('heartbeatExpiry', now + DEADLINE_MS.heartbeatExpiry);
    if (hasActiveWork(table)) {
      await this.cancelDeadlineAndAlarm('idleStop');
    } else {
      await this.armDeadlineIfAbsent('idleStop', now + DEADLINE_MS.idleStop);
    }
    await this.renewProviderLease(identity);
  }

  private async renewProviderLease(identity: SandboxControlConnectionIdentity): Promise<void> {
    const physical = await loadPhysicalRecord(this.ctx.storage);
    if (
      !this.isCurrentConnection(identity) ||
      physical.state !== 'running' ||
      physical.providerRef === null
    ) {
      return;
    }
    try {
      await this.provider.ensureLeaseAtLeast(physical.providerRef, leaseAtLeastMs());
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
    try {
      const applied = await withDORetry(
        () => getSandboxSessionStub(this.env, route.ownerId, route.sessionId),
        stub => stub.receiveSandboxControlEvent({ identity, payload }),
        'receiveSandboxControlEvent'
      );
      if (applied.applied) return;
    } catch {
      // Session DO retry exhausted; flag the route for session.sync.
    }
    if (!this.isCurrentConnection(connection)) return;
    const table = await loadRouteTable(this.ctx.storage);
    if (!this.isCurrentConnection(connection)) return;
    markNeedsSync(table, route.sessionId);
    await saveRouteTable(this.ctx.storage, table);
  }

  private async forwardSessionPreparing(
    route: SessionRoute,
    identity: SessionEventIdentity,
    payload: SessionPreparingPayload,
    connection: SandboxControlConnectionIdentity
  ): Promise<void> {
    if (!this.isCurrentConnection(connection)) return;
    try {
      const applied = await withDORetry(
        () => getSandboxSessionStub(this.env, route.ownerId, route.sessionId),
        stub => stub.receiveSandboxControlPreparing({ identity, payload }),
        'receiveSandboxControlPreparing'
      );
      if (applied.applied) return;
    } catch {
      // Session DO retry exhausted; flag the route for session.sync.
    }
    if (!this.isCurrentConnection(connection)) return;
    const table = await loadRouteTable(this.ctx.storage);
    if (!this.isCurrentConnection(connection)) return;
    markNeedsSync(table, route.sessionId);
    await saveRouteTable(this.ctx.storage, table);
  }

  private async onSocketClosed(
    handshakeComplete: boolean,
    identity?: SandboxControlConnectionIdentity
  ): Promise<void> {
    if (!handshakeComplete || !identity || !this.isActiveConnection(identity)) return;
    const replacement = this.socketHandler.getConnectionIdentity();
    if (replacement && !this.sameConnection(replacement, identity)) return;

    this.kiloReady = false;
    this.readyConnectionId = null;
    await Promise.all([
      this.ctx.storage.put(ACTIVE_WRAPPER_RUNTIME_KEY, identity),
      this.ctx.storage.delete(WRAPPER_READY_AT_KEY),
    ]);
    if (!this.isActiveConnection(identity)) return;
    await this.appendLog(connectionTransition(Date.now(), 'ready', 'disconnected', 'socket close'));
    await this.cancelDeadlineAndAlarm('heartbeatExpiry');
    if (!this.isActiveConnection(identity)) return;
    await this.reconcileLostConnection(identity);
  }

  private async reconcileLostConnection(identity: SandboxControlConnectionIdentity): Promise<void> {
    if (!this.isActiveConnection(identity)) return;
    const physical = await loadPhysicalRecord(this.ctx.storage);
    if (!this.isActiveConnection(identity) || physical.state !== 'running') return;
    const next = await this.observeCurrentProvider(physical, identity);
    if (next.state === 'running' && this.isActiveConnection(identity)) {
      await this.armDeadlineAndAlarm('wrapperReadiness', Date.now() + DEADLINE_MS.wrapperReadiness);
    }
  }

  private async releaseIfAuthoritativelyDead(physical: PhysicalRecord): Promise<PhysicalRecord> {
    let stopResult: StopResult | undefined;
    if (physical.providerRef) {
      try {
        stopResult = await this.provider.stop(physical.providerRef);
      } catch (error) {
        logger
          .withFields({
            sandboxId: this.sandboxId,
            error: error instanceof Error ? error.message : 'stop failed',
          })
          .warn('Failed sandbox stop during reclaim');
      }
    }
    let observeResult: ObserveResult | undefined;
    if (stopResult !== 'terminal') {
      try {
        observeResult = await this.provider.observe(physical.providerRef);
      } catch {
        observeResult = 'unknown';
      }
    }
    const next = applyAuthoritativeRelease(physical, {
      ...(stopResult ? { stop: stopResult } : {}),
      ...(observeResult ? { observe: observeResult } : {}),
    });
    if (next.state === 'stopped') {
      return this.confirmStopped();
    }
    return physical;
  }

  private async observeCurrentProvider(
    physical: PhysicalRecord,
    identity?: SandboxControlConnectionIdentity
  ): Promise<PhysicalRecord> {
    let result: ObserveResult;
    try {
      result = await this.provider.observe(physical.providerRef);
    } catch {
      result = 'unknown';
    }
    const current = await loadPhysicalRecord(this.ctx.storage);
    if (
      current.state !== physical.state ||
      current.providerRef !== physical.providerRef ||
      (identity && !this.isActiveConnection(identity))
    ) {
      return current;
    }
    return this.observeProvider(result);
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
    if (physical.state !== 'running' || physical.providerRef === null) {
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
    return this.kiloReady ? 'ready' : 'connected';
  }

  private async workState(): Promise<WorkState> {
    const table = await loadRouteTable(this.ctx.storage);
    let finalizing = false;
    let stalled = false;
    for (const route of table.values()) {
      if (route.stalled) stalled = true;
      if (route.lastState === 'finalizing' && !route.stalled) finalizing = true;
    }
    if (stalled && !hasActiveWork(table)) return 'stalled';
    if (finalizing) return 'finalizing';
    if (hasActiveWork(table)) return 'active';
    return 'idle';
  }

  private async persistPhysical(
    from: PhysicalRecord,
    to: PhysicalRecord,
    cause: string
  ): Promise<void> {
    await savePhysicalRecord(this.ctx.storage, to);
    if (from.state !== to.state) {
      const connection = this.activeConnection;
      if (connection && (to.state === 'failed' || to.state === 'stopped')) {
        this.activeConnection = null;
        this.readyConnectionId = null;
        this.kiloReady = false;
        this.socketHandler.closeHandshakenSockets(4002, 'Sandbox runtime unavailable');
        await this.ctx.storage.delete([ACTIVE_WRAPPER_RUNTIME_KEY, WRAPPER_READY_AT_KEY]);
        await this.cancelDeadlineAndAlarm('heartbeatExpiry');
        if (connection.wrapperInstanceId) {
          await this.invalidateTerminalRuntime(connection.wrapperInstanceId, true);
        }
      } else if (to.state === 'unknown' && connection?.wrapperInstanceId) {
        await this.invalidateTerminalRuntime(connection.wrapperInstanceId, false, connection);
      }
      await this.appendLog(
        physicalTransition(Date.now(), from.state, to.state, cause, to.providerRef)
      );
      if (to.state === 'failed' || to.state === 'unknown') {
        await this.notifyAttachedSessions(
          to.state === 'unknown' ? 'provider_unknown' : 'environment_failed'
        );
      }
    }
  }

  private async invalidateTerminalRuntime(
    wrapperInstanceId: string,
    confirmed: boolean,
    connection?: SandboxControlConnectionIdentity
  ): Promise<void> {
    const routes = await loadRouteTable(this.ctx.storage);
    if (!confirmed && connection && !this.isActiveConnection(connection)) return;
    await Promise.all(
      [...routes.values()].map(route => {
        if (!confirmed && connection && !this.isActiveConnection(connection)) {
          return Promise.resolve();
        }
        return withDORetry(
          () => getSandboxSessionStub(this.env, route.ownerId, route.sessionId),
          stub =>
            stub.invalidateTerminalRuntime({
              sandboxId: this.sandboxId,
              wrapperInstanceId,
              confirmed,
            }),
          'invalidateTerminalRuntime'
        ).catch(() => undefined);
      })
    );
  }

  private async notifyAttachedSessions(reason: string): Promise<void> {
    const table = await loadRouteTable(this.ctx.storage);
    for (const route of table.values()) {
      this.ctx.waitUntil(
        withDORetry(
          () => getSandboxSessionStub(this.env, route.ownerId, route.sessionId),
          stub => stub.failWaitingMessages(reason),
          'failWaitingMessages'
        ).catch(() => undefined)
      );
    }
  }

  private async armDeadlineIfAbsent(id: DeadlineId, at: number): Promise<void> {
    const current = await loadDeadlines(this.ctx.storage);
    if (current[id] !== undefined) return;
    await this.armDeadlineAndAlarm(id, at);
  }

  private async armDeadlineAndAlarm(id: DeadlineId, at: number): Promise<void> {
    const current = await loadDeadlines(this.ctx.storage);
    const wasArmed = current[id] !== undefined;
    const scheduledAt = id === 'idleStop' ? Math.max(current[id] ?? 0, at) : at;
    const deadlines = armDeadline(current, id, scheduledAt);
    await saveDeadlines(this.ctx.storage, deadlines);
    if (!wasArmed) {
      await this.appendLog(deadlineTransition(Date.now(), id, 'armed'));
    }
    await this.scheduleAlarm(deadlines);
  }

  private async cancelDeadlineAndAlarm(id: DeadlineId): Promise<void> {
    const current = await loadDeadlines(this.ctx.storage);
    if (current[id] === undefined) return;
    const deadlines = cancelDeadline(current, id);
    await saveDeadlines(this.ctx.storage, deadlines);
    await this.appendLog(deadlineTransition(Date.now(), id, 'cancelled'));
    await this.scheduleAlarm(deadlines);
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
