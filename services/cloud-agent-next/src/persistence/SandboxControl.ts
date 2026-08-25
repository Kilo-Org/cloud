import { DurableObject } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import type { Env } from '../types.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import { logger } from '../logger.js';
import {
  createSandboxControlSocketHandler,
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
import { isSandboxContainerRunning } from '../container-usage-context.js';
import type { AgentSandboxProvider } from '../types.js';

const CREDENTIAL_HASH_KEY = 'wrapper_credential_hash';
const OWNER_ID_KEY = 'owner_id';
const WRAPPER_READY_AT_KEY = 'wrapper_ready_at';
const DIAGNOSTIC_BUNDLE_KEY = 'diagnostic_bundle';
const PROVIDER_KIND_KEY = 'provider_kind';

export type AttachSessionInput = AttachRouteInput;

export type SandboxControlStatus = {
  reported: ReportedSandboxStatus;
  physical: PhysicalRecord['state'];
  connection: ConnectionState;
  work: WorkState;
};

export class SandboxControl extends DurableObject<Env> {
  readonly sandboxId: string;
  private socketHandler: SandboxControlSocketHandler;
  private kiloReady = false;
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
      onHandshakeComplete: providerInstanceId => this.onHandshakeComplete(providerInstanceId),
      onReady: () => this.onWrapperReady(),
      onHeartbeat: payload => this.onHeartbeat(payload),
      onSessionEvent: (identity, payload) => this.onSessionEvent(identity, payload),
      onSessionPreparing: (identity, payload) => this.onSessionPreparing(identity, payload),
      onSocketClosed: handshakeComplete => this.onSocketClosed(handshakeComplete),
    });
    void ctx.blockConcurrencyWhile(async () => {
      this.kiloReady = (await ctx.storage.get<number>(WRAPPER_READY_AT_KEY)) !== undefined;
      const kind = await ctx.storage.get<AgentSandboxProvider>(PROVIDER_KIND_KEY);
      this.provider = this.createProviderAdapter(kind ?? 'cloudflare');
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
    this.socketHandler.closeAll('Credential rotated');
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
    return { existed: result.existed };
  }

  async listRoutes(): Promise<SessionRoute[]> {
    const table = await loadRouteTable(this.ctx.storage);
    return [...table.values()];
  }

  async getStatus(): Promise<SandboxControlStatus> {
    const physical = await loadPhysicalRecord(this.ctx.storage);
    const connection = this.connectionState();
    const work = await this.workState();
    return {
      reported: projectReportedStatus({ physical: physical.state, connection, work }),
      physical: physical.state,
      connection,
      work,
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
        const sandbox = getSandbox(this.env.Sandbox, id);
        return {
          renewActivityTimeout: () => sandbox.renewActivityTimeout(),
          destroy: () => sandbox.destroy(),
          isContainerRunning: async () => (await isSandboxContainerRunning(sandbox)) === true,
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
      this.socketHandler.closeHandshakenSockets(4002, 'heartbeat expired');
      this.kiloReady = false;
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

  private async onHandshakeComplete(providerInstanceId: string): Promise<void> {
    await this.cancelDeadlineAndAlarm('socketHandshake');
    const now = Date.now();
    const current = await loadPhysicalRecord(this.ctx.storage);
    if (current.state === 'creating') {
      const next = confirmRunning(current, providerInstanceId, now);
      await this.persistPhysical(current, next, 'hello');
    }
    await this.appendLog(connectionTransition(now, 'disconnected', 'connected', 'hello'));
    await this.armDeadlineAndAlarm('wrapperReadiness', now + DEADLINE_MS.wrapperReadiness);
    await this.cancelDeadlineAndAlarm('startup');
  }

  private async onWrapperReady(): Promise<void> {
    this.kiloReady = true;
    const now = Date.now();
    await this.ctx.storage.put(WRAPPER_READY_AT_KEY, now);
    await this.cancelDeadlineAndAlarm('wrapperReadiness');
    await this.appendLog(connectionTransition(now, 'connected', 'ready', 'sandbox.ready'));
    await this.armDeadlineAndAlarm('heartbeatExpiry', now + DEADLINE_MS.heartbeatExpiry);
    await this.armDeadlineIfAbsent('idleStop', now + DEADLINE_MS.idleStop);
  }

  private async onHeartbeat(payload: SandboxHeartbeatPayload): Promise<void> {
    this.kiloReady = payload.kilo.ready;
    const now = Date.now();
    const table = await loadRouteTable(this.ctx.storage);
    for (const session of payload.sessions) {
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
    await saveRouteTable(this.ctx.storage, table);
    await this.armDeadlineAndAlarm('heartbeatExpiry', now + DEADLINE_MS.heartbeatExpiry);
    if (hasActiveWork(table)) {
      await this.cancelDeadlineAndAlarm('idleStop');
    } else {
      await this.armDeadlineIfAbsent('idleStop', now + DEADLINE_MS.idleStop);
    }
    await this.renewProviderLease();
  }

  private async renewProviderLease(): Promise<void> {
    const physical = await loadPhysicalRecord(this.ctx.storage);
    if (physical.state !== 'running' || physical.providerRef === null) return;
    try {
      await this.provider.ensureLeaseAtLeast(physical.providerRef, leaseAtLeastMs());
    } catch {
      logger.withFields({ sandboxId: this.sandboxId }).warn('Provider lease renewal failed');
    }
  }

  private async onSessionEvent(
    identity: SessionEventIdentity | undefined,
    payload: SessionEventPayload
  ): Promise<void> {
    if (!identity) {
      logger
        .withFields({ sandboxId: this.sandboxId, eventType: payload.type })
        .warn('session.event missing identity');
      return;
    }
    await this.forwardRoutedSessionFrame(identity, payload.type, route =>
      this.forwardSessionEvent(route, identity, payload)
    );
  }

  private async onSessionPreparing(
    identity: SessionEventIdentity | undefined,
    payload: SessionPreparingPayload
  ): Promise<void> {
    if (!identity) {
      logger
        .withFields({ sandboxId: this.sandboxId, eventType: 'session.preparing' })
        .warn('session.event missing identity');
      return;
    }
    await this.forwardRoutedSessionFrame(identity, 'session.preparing', route =>
      this.forwardSessionPreparing(route, identity, payload)
    );
  }

  private async forwardRoutedSessionFrame(
    identity: SessionEventIdentity,
    eventType: string,
    forward: (route: SessionRoute) => Promise<void>
  ): Promise<void> {
    const table = await loadRouteTable(this.ctx.storage);
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
    const next = previous.catch(() => undefined).then(() => forward(route));
    this.sessionForwardChains.set(route.sessionId, next);
    this.ctx.waitUntil(next);
  }

  private async forwardSessionEvent(
    route: SessionRoute,
    identity: SessionEventIdentity,
    payload: SessionEventPayload
  ): Promise<void> {
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
    const table = await loadRouteTable(this.ctx.storage);
    markNeedsSync(table, route.sessionId);
    await saveRouteTable(this.ctx.storage, table);
  }

  private async forwardSessionPreparing(
    route: SessionRoute,
    identity: SessionEventIdentity,
    payload: SessionPreparingPayload
  ): Promise<void> {
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
    const table = await loadRouteTable(this.ctx.storage);
    markNeedsSync(table, route.sessionId);
    await saveRouteTable(this.ctx.storage, table);
  }

  private async onSocketClosed(handshakeComplete: boolean): Promise<void> {
    if (!handshakeComplete) return;
    this.kiloReady = false;
    await this.ctx.storage.delete(WRAPPER_READY_AT_KEY);
    await this.appendLog(connectionTransition(Date.now(), 'ready', 'disconnected', 'socket close'));
    await this.cancelDeadlineAndAlarm('heartbeatExpiry');
    await this.reconcileLostConnection();
  }

  private async reconcileLostConnection(): Promise<void> {
    const physical = await loadPhysicalRecord(this.ctx.storage);
    if (physical.state !== 'running') return;
    const next = await this.observeCurrentProvider(physical);
    if (next.state === 'running') {
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

  private async observeCurrentProvider(physical: PhysicalRecord): Promise<PhysicalRecord> {
    let result: ObserveResult;
    try {
      result = await this.provider.observe(physical.providerRef);
    } catch {
      result = 'unknown';
    }
    return this.observeProvider(result);
  }

  private connectionState(): ConnectionState {
    if (!this.socketHandler.hasHandshakenSocket()) return 'disconnected';
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
    const deadlines = armDeadline(current, id, at);
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
