import { DurableObject } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { z } from 'zod';
import { DEFAULT_DO_RETRY_CONFIG, withTimeout } from '@kilocode/worker-utils';
import {
  clearBillingContext,
  ContainerUsageAdmissionError,
  createContainerUsageClient,
  DEFAULT_BILLING_HEARTBEAT_SECONDS,
  getBillingContext,
  installBillingHeartbeat,
  type BillingHeartbeatController,
} from '@kilocode/container-usage';
import type { VercelSandboxResources } from '@kilocode/worker-utils/sandbox-allocation';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import {
  forceDestroyControlPlaneSandbox,
  assertSandboxBillingAllocation,
  parseSandboxBillingInput,
  vercelBillingIdentity,
  type SandboxBillingInput,
  type VercelBillingIdentity,
} from '../../container-usage-context.js';
import { resolveSecret } from '../../auth.js';
import { MeteredBillingLifecycle, type BillingIdentity } from '../../metered-billing-lifecycle.js';
import { isCloudAgentContainerBillingEnabled } from '../../container-billing-rollout.js';
import { BillingScheduleTable } from '../../sandbox-control/billing-schedule.js';
import {
  VercelBilling,
  VERCEL_BILLING_SETTLEMENT_CALLBACK,
  deleteVercelBillingBinding,
  loadVercelBillingBinding,
  saveVercelBillingBinding,
} from '../../sandbox-control/vercel-billing.js';
import {
  generateSandboxCredential,
  hashSandboxCredential,
  mintSandboxLaunchCredential,
  parseSandboxLaunchBearer,
  sandboxCredentialMatchesHash,
  verifySandboxLaunchCredential,
} from '../../sandbox-control/credential.js';
import { rejectSandboxWrapperUpgrade } from '../../sandbox-control/socket-admission.js';
import { createCloudflareContainersProviderAdapter } from '../../sandbox-control/cloudflare-containers-provider.js';
import {
  createCloudflareProviderAdapter,
  decodeCloudflareProviderRef,
} from '../../sandbox-control/cloudflare-provider.js';
import { parseControlPlaneCredential } from '../../sandbox-control/managed-credential.js';
import {
  sandboxProviderConfigurationSchema,
  ProviderCreationError,
  type ProviderAdapter,
  type ProviderAllocationIntent,
  type ProviderCreateIntent,
  type SandboxProviderConfiguration,
} from '../../sandbox-control/provider.js';
import {
  createVercelProviderAdapter,
  decodeVercelProviderRef,
  vercelProviderLocatorSchema,
  type VercelProviderLocator,
} from '../../sandbox-control/vercel-provider.js';
import { buildControlWrapperLaunchEnv } from '../../sandbox-control/wrapper-launch-env.js';
import {
  buildControlNetworkPolicy,
  kiloTokenHasRuntimeAuthorization,
  prepareCredentialGrant,
  resolveSessionCredential,
  sessionCredentialsPayloadFromGrant,
  type SessionCredentialGrant,
} from '../../sandbox-control/session-credentials.js';
import { providerUsesOutboundCredentialProxy } from '../../agent-sandbox/capabilities.js';
import { resolveVercelSandboxRuntimeConfig } from '../../agent-sandbox/vercel/vercel-runtime-config.js';
import type { VercelSandboxNetworkPolicy } from '../../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import {
  getManagedOutboundContainerId,
  getOutboundContainerId,
  getSandboxNamespace,
} from '../../sandbox-id.js';
import { sessionDoName } from '../../session-plane.js';
import { logger } from '../../logger.js';
import {
  diagnosticCause,
  logControlDiagnostic,
  type ControlDiagnosticFields,
} from '../../sandbox-control/diagnostics.js';
import {
  getWorktreeCredentialContainment,
  type CredentialContainmentRequirements,
} from '../../sandbox-control/credential-containment.js';
import {
  runtimeProxyHandleGrantId,
  sameRuntimeProxyControlBinding,
  verifyRuntimeCredentialProxyHandle,
} from '../../runtime-credential-proxy.js';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  worktreeDeleteResultSchema,
  worktreePrepareDeletionResultSchema,
  type SessionAttachPayload,
} from '../../shared/sandbox-control-protocol.js';
import { MCPServerConfigSchema } from '../../persistence/schemas.js';
import {
  McpAttachValidationError,
  McpConfigurationError,
  mcpConfigurationFailureReason,
  mcpValidationMessage,
  materializeMcpServers,
  parseSessionAttachMcpServers,
  type CliMcpServer,
} from '../../mcp-config.js';
import {
  CONTROL_PLANE_ALLOCATION_ID_ENV,
  CONTROL_PLANE_PROTOCOL_VERSION,
  CONTROL_PLANE_REQUEST_TIMEOUT_MS,
  controlPlaneAnswerPayloadSchema,
  controlPlaneDeliverPayloadSchema,
  controlPlanePrepareInputSchema,
  controlPlaneSessionCredentialsPayloadSchema,
  controlPlaneSessionRefPayloadSchema,
  controlPlaneTerminalInputSchema,
  controlPlaneWorktreeCaptureInputSchema,
  controlPlaneWorktreeDeletionPayloadSchema,
  controlPlaneWrapperFrameSchema,
  type ControlPlaneAnswerPayload,
  type ControlPlaneControlResult,
  type ControlPlaneCredentialSource,
  type ControlPlaneDeliverPayload,
  type ControlPlaneDeliverResult,
  type ControlPlaneDispatchResult,
  type ControlPlaneEventsNotification,
  type ControlPlaneFailureReason,
  type ControlPlaneOutcome,
  type ControlPlaneRouteSpec,
  type ControlPlaneRouteUpdate,
  type ControlPlaneRouteView,
  type ControlPlaneSessionCredentialsPayload,
  type ControlPlaneSessionRefPayload,
  type ControlPlaneStatusResult,
  type ControlPlaneTerminalInput,
  type ControlPlaneWorktreeCaptureInput,
  type ControlPlaneWrapperFrame,
} from '../../shared/control-plane-protocol.js';
import { resolveControlPlaneTimers } from '../../shared/control-plane-timers.js';
import {
  controlPlaneSandboxSelectionSchema,
  type ControlPlanePrepareInputWithSelection,
  type ControlPlaneSandboxSelection,
} from '../session/sandbox-selection.js';
import { withDORetry } from '../../utils/do-retry.js';
import { agentSandboxProviderSchema, type AgentSandboxProvider, type Env } from '../../types.js';
import { sandboxSessionPeerNamespace } from '../peer-bindings.js';
import migrations from './drizzle/migrations';
import {
  connectionMatches,
  initialAllocationState,
  nextAllocationAlarmAt,
  reduceAllocation,
  type AllocationEffect,
  type AllocationEvent,
  type AllocationState,
  type AllocationView,
  type SandboxTimers,
} from './allocation.js';
import {
  deleteRoute,
  dropReadyRoutes,
  earliestRouteDeadlineAt,
  ensureRoute,
  failRoute,
  failCurrentAttempt,
  failExpiredRoutes,
  isCurrentPreparingAttempt,
  listRoutes,
  notifyPreparingRoutes,
  notifyReadyRoutes,
  onRouteFailed,
  onRouteProgress,
  onRouteReady,
  onWrapperConnected,
  readRoute,
  routeRetryAllowed,
  routeView,
  writeRoute,
  type RouteContext,
  type RouteGrantIssue,
  type RoutePreparationProgress,
  type RouteRecord,
} from './routes.js';
import { allocation as allocationTable, routes as routesTable } from './sqlite-schema.js';
import {
  listScopeGrants,
  readScopeGrant,
  retireScopeGrants,
  scopeGrantId,
  writeScopeGrant,
} from './scope-grants.js';
import {
  beginWorktreeDeletion,
  controlPlaneWorktreeDeletionInputSchema,
  finishWorktreeDeletion,
  loadWorktreeDeletionJournal,
  persistWorktreeDeletionManifest,
  WorktreeDeletionIncompleteError,
  worktreeOwnedRoutes,
  type ControlPlaneWorktreeDeletionInput,
  type WorktreeDeletionPlan,
} from './worktree-deletion.js';
import { projectAllocationStatusSnapshot } from './status-snapshot.js';
import { createSandboxNotificationDispatcher, type SandboxNotification } from './notifications.js';
import type { SandboxStatusSnapshot } from '../../shared/sandbox-status.js';
import { getWorktreeWorkspacePath } from '../../workspace.js';

const GENERATION_KEY = 'control_plane_generation';
const GENERATION = 2;
const CREDENTIAL_HASH_KEY = 'wrapper_credential_hash';
const OWNER_KEY = 'control_plane_owner';
const ALLOCATION_ROW_ID = 'current';
const VERCEL_BILLING_FORCE_STOP_CALLBACK = 'billingForceStop';
const VERCEL_BILLING_DELIVERY_RETRY_MS = 5_000;

type StoredProviderPin = {
  provider: AgentSandboxProvider;
  allocationName: string | null;
  configuration: SandboxProviderConfiguration | null;
  locator: VercelProviderLocator | null;
  billing: SandboxBillingInput | null;
  containment: CredentialContainmentRequirements | null;
};

export type EnsureAllocationInput = {
  provider?: AgentSandboxProvider;
  allocationName?: string;
  configuration?: SandboxProviderConfiguration;
  locator?: VercelProviderLocator;
  billing?: SandboxBillingInput;
  containment?: CredentialContainmentRequirements;
};

const wrapperSocketAttachmentSchema = z.object({
  credential: z.string().nullable(),
  helloDeadlineAt: z.number().finite().nonnegative().optional(),
  allocationId: z.string().optional(),
  connectionId: z.string().optional(),
  wrapperId: z.string().optional(),
  heartbeatAck: z.literal(true).optional(),
});
type WrapperSocketAttachment = z.infer<typeof wrapperSocketAttachmentSchema>;

/**
 * The Sandbox DO -> Session DO notification surface (spec §10). The V2 Session
 * DO is B4, so the production factory resolves a stub only when the test-only
 * binding exists; tests inject a fake peer instead.
 */
export type ControlPlaneSessionPeer = {
  onRoute(update: ControlPlaneRouteUpdate): Promise<void>;
  onEvents(notification: ControlPlaneEventsNotification): Promise<void>;
  onOutcome(outcome: ControlPlaneOutcome): Promise<void>;
  /**
   * R1: the Session DO owns the grant and mints the runtime credential proxy
   * handle. The Sandbox DO passes its own allocation fence so the Session DO
   * never calls back into this DO's queue.
   */
  issueRuntimeCredentialProxyGrant(
    fence: ControlRuntimeCredentialProxyFence
  ): Promise<string | null>;
};

/** Spec §10: the runtime credential proxy fence returned to the Worker. */
export type ControlRuntimeCredentialProxyFence = {
  plane: 'control';
  allocationId: string;
  providerInstanceId: string;
  connectionId: string;
  wrapperInstanceId: string;
};

type LegacyCutover = {
  provider: AgentSandboxProvider;
  providerRef: string | null;
  allocationName: string | null;
  configuration: SandboxProviderConfiguration | null;
  vercelLocator: VercelProviderLocator | null;
  billing: SandboxBillingInput | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Frames from the old (protocol version 1) wrapper use `request`/`event`
 * envelopes. V2 has no backward compatibility, so the socket is closed.
 */
function isLegacyWrapperFrame(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.type === 'request' || value.type === 'response' || value.type === 'event';
}

type AllocationRow = typeof allocationTable.$inferSelect;

function stateToRow(state: AllocationState): typeof allocationTable.$inferInsert {
  return {
    id: ALLOCATION_ROW_ID,
    state: state.kind,
    allocation_id: state.allocationId,
    connection_id: state.connectionId,
    provider_ref: state.providerRef,
    wrapper_id: state.wrapperId,
    last_frame_at: state.lastFrameAt,
    last_activity_at: state.lastActivityAt,
    create_deadline_at: state.createDeadlineAt,
    first_connect_deadline_at: state.firstConnectDeadlineAt,
    stop_attempt: state.stopAttempt,
    stop_pending: state.stopPending,
    stop_at: state.stopAt,
    unconfirmed_provider_ref: state.unconfirmedProviderRef,
  };
}

function rowToState(row: AllocationRow): AllocationState {
  return {
    kind: row.state,
    allocationId: row.allocation_id,
    connectionId: row.connection_id,
    providerRef: row.provider_ref,
    wrapperId: row.wrapper_id,
    lastFrameAt: row.last_frame_at,
    lastActivityAt: row.last_activity_at,
    createDeadlineAt: row.create_deadline_at,
    firstConnectDeadlineAt: row.first_connect_deadline_at,
    stopAttempt: row.stop_attempt,
    stopPending: row.stop_pending,
    stopAt: row.stop_at,
    unconfirmedProviderRef: row.unconfirmed_provider_ref,
  };
}

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

/**
 * The preparation step the allocation owns until the wrapper connects. Once a
 * wrapper is bound it reports its own steps, so there is none here.
 */
function sandboxPreparationProgress(state: AllocationState): RoutePreparationProgress | undefined {
  switch (state.kind) {
    case 'stopped':
    case 'creating':
      return { step: 'sandbox_create' };
    case 'stopping':
      return { step: 'sandbox_create', detail: 'Waiting for the previous sandbox to stop' };
    case 'starting':
      return { step: 'sandbox_start' };
    case 'connected':
    case 'disconnected':
      return undefined;
  }
}

/** Upper bound on concurrently outstanding wrapper control requests. */
const MAX_PENDING_CONTROL_REQUESTS = 64;

/**
 * Result of the queued half of a control request: either an early failure, or
 * the wrapper-reply promise the caller awaits outside the queue.
 */
type ControlRequestHandoff =
  | { promise: Promise<ControlPlaneControlResult> }
  | { error: ControlPlaneControlResult };

function controlRequestFailure(
  code: string,
  message: string,
  retryable: boolean
): ControlPlaneControlResult {
  return { ok: false, error: { code, message, retryable } };
}

/** Maps one terminal request to its wrapper frame, preserving the operation. */
function terminalRequestFrame(
  requestId: string,
  input: ControlPlaneTerminalInput
): Extract<
  ControlPlaneWrapperFrame,
  { type: 'terminal.create' | 'terminal.resize' | 'terminal.close' | 'terminal.connect' }
> {
  switch (input.operation) {
    case 'create':
      return {
        type: 'terminal.create',
        requestId,
        session: input.session,
        payload: input.payload,
      };
    case 'resize':
      return {
        type: 'terminal.resize',
        requestId,
        session: input.session,
        payload: input.payload,
      };
    case 'close':
      return {
        type: 'terminal.close',
        requestId,
        session: input.session,
        payload: input.payload,
      };
    case 'connect':
      return {
        type: 'terminal.connect',
        requestId,
        session: input.session,
        payload: input.payload,
      };
  }
}

export class SandboxControlV2 extends DurableObject<Env> {
  readonly sandboxId: string;
  private readonly db: ReturnType<typeof drizzle>;
  private readonly initialized: Promise<void>;
  private readonly operations: { tail: Promise<unknown> } = { tail: Promise.resolve() };
  private provider: ProviderAdapter;
  private providerPin: StoredProviderPin | null = null;
  private createInFlight = false;
  private readonly billingSchedule: BillingScheduleTable;
  private vercelBilling:
    | {
        identity: BillingIdentity | undefined;
        lifecycle: MeteredBillingLifecycle;
        heartbeat: BillingHeartbeatController;
        billing: VercelBilling;
      }
    | undefined;
  private vercelBillingBuild: Promise<void> | undefined;
  private readonly vercelDeliveriesInFlight = new Set<string>();
  /**
   * Outstanding worktree-change requests forwarded to the wrapper, keyed by
   * request id (spec §10). The wrapper answers with one result frame; the reply
   * is resolved on the socket message path, not the serial queue, so a queued
   * request can await it without blocking the queue. The socket is kept so a
   * close can fail every request it owned at once.
   */
  private readonly pendingControlRequests = new Map<
    string,
    {
      socket: WebSocket;
      resolve: (result: ControlPlaneControlResult) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Bound on one wrapper reply; overridable in tests to exercise the timeout. */
  controlRequestTimeoutMs = CONTROL_PLANE_REQUEST_TIMEOUT_MS;
  /**
   * Notification factory for the V2 Session DO. The default resolves the
   * `ownerId:sessionId` name through the shared binding accessor; tests inject a
   * fake.
   */
  sessionPeerFor: (ownerId: string, sessionId: string) => ControlPlaneSessionPeer | null = (
    ownerId,
    sessionId
  ) => this.resolveSessionPeer(ownerId, sessionId);

  private readonly notifications = createSandboxNotificationDispatcher({
    budgetMs: () => this.sandboxTimers().sessionNotifyDeadlineMs,
    send: (sessionId, notification, deadlineAt, signal) =>
      this.notifySession(sessionId, notification, deadlineAt, signal),
    waitUntil: work => this.ctx.waitUntil(work),
    diagnostic: loss =>
      logger.withFields({ sandboxId: this.sandboxId, ...loss }).warn('Sandbox notification loss'),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sandboxId = ctx.id.name ?? ctx.id.toString();
    this.db = drizzle(ctx.storage, { logger: false });
    this.billingSchedule = new BillingScheduleTable({
      storage: ctx.storage,
      recompose: async () => this.armAlarm(await this.readAllocation()),
    });
    this.provider = this.createProviderAdapter(this.defaultPin('cloudflare'));
    this.initialized = ctx.blockConcurrencyWhile(() => this.initializeStorage());
  }

  // --- lifecycle entry points -------------------------------------------------

  /**
   * Establishes the provider pin and starts the allocation. `prepare` starts an
   * allocation from the stored pin without going through here, so callers that
   * need a non-default provider must call this while stopped.
   */
  async ensureAllocation(input: EnsureAllocationInput = {}): Promise<void> {
    await this.initialized;
    await this.enqueue(async () => {
      const state = await this.readAllocation();
      if (state.kind === 'stopped') {
        const pin = this.pinFromInput(input);
        await this.writeProviderPin(pin);
        this.providerPin = pin;
        this.provider = this.createProviderAdapter(pin);
      }
      await this.applyEvent({
        type: 'ensure',
        at: Date.now(),
        allocationId: crypto.randomUUID(),
      });
    });
  }

  /** B3/D3 reports the provider no longer has the sandbox (spec §6 "any → stopped"). */
  async reportProviderGone(): Promise<void> {
    await this.initialized;
    await this.enqueue(() => this.applyEvent({ type: 'provider-gone', at: Date.now() }));
  }

  /** Passive read for tests and B3's `status`/B10's badge. */
  async getAllocationState(): Promise<AllocationView> {
    await this.initialized;
    return { ...(await this.readAllocation()), provider: this.currentProvider() };
  }

  /**
   * Worker-facing status RPC (spec §10, B10 badge). Projects the V2 allocation
   * state into the public snapshot; it never probes the provider or the wrapper.
   * No owner means no evidence, so the snapshot is `unknown`.
   */
  async getStatusSnapshot(): Promise<SandboxStatusSnapshot> {
    await this.initialized;
    return this.enqueue(async () => {
      const owner = await this.requireOwner();
      const allocation = owner === null ? null : await this.getAllocationState();
      return projectAllocationStatusSnapshot({
        allocation,
        observedAt: Date.now(),
        inactivityTimeoutMs: this.sandboxTimers().idleMs,
      });
    });
  }

  /**
   * The provider kind and allocation name the adapter is built from. Read from
   * the persisted pin, so after eviction it proves the rebuild used storage.
   */
  async getProviderRuntime(): Promise<{ provider: AgentSandboxProvider; allocationName: string }> {
    await this.initialized;
    return {
      provider: this.currentProvider(),
      allocationName: this.providerPin?.allocationName ?? this.sandboxId,
    };
  }

  // --- routes (B3) ------------------------------------------------------------

  /**
   * Session DO -> Sandbox DO (spec §10). Returns the route view at once and
   * never waits for a provider call. An absent or `failed` route starts a new
   * preparation attempt; any other repeated call keeps its attempt deadline.
   * The DO-only `credentials` snapshot mints the route grant; it never reaches
   * the wrapper.
   */
  async prepare(input: ControlPlanePrepareInputWithSelection): Promise<ControlPlaneRouteView> {
    await this.initialized;
    // The shared prepare schema stays authoritative: it carries the superRefine
    // that rejects `spec.git.token`/`spec.kilo` (B3 review 2, N3). The DO-only
    // selection is split off and validated separately first, because the shared
    // schema is strict and must not learn about the extra field.
    const sandboxSelection =
      input.sandboxSelection === undefined
        ? undefined
        : controlPlaneSandboxSelectionSchema.parse(input.sandboxSelection);
    const parsed = controlPlanePrepareInputSchema.parse({
      spec: input.spec,
      credentials: input.credentials,
    });
    return this.enqueue(() => this.runPrepare(parsed.spec, parsed.credentials, sandboxSelection));
  }

  async deliver(payload: ControlPlaneDeliverPayload): Promise<ControlPlaneDeliverResult> {
    await this.initialized;
    const parsed = controlPlaneDeliverPayloadSchema.parse(payload);
    return this.enqueue(() => this.runDeliver(parsed));
  }

  async abort(payload: ControlPlaneSessionRefPayload): Promise<ControlPlaneDispatchResult> {
    await this.initialized;
    const parsed = controlPlaneSessionRefPayloadSchema.parse(payload);
    return this.enqueue(() =>
      this.dispatchToWrapper({ type: 'session.abort', sessionId: parsed.sessionId })
    );
  }

  async answer(payload: ControlPlaneAnswerPayload): Promise<ControlPlaneDispatchResult> {
    await this.initialized;
    const parsed = controlPlaneAnswerPayloadSchema.parse(payload);
    return this.enqueue(() =>
      this.dispatchToWrapper({
        type: 'session.answer',
        sessionId: parsed.sessionId,
        reply: parsed.reply,
      })
    );
  }

  async release(payload: ControlPlaneSessionRefPayload): Promise<void> {
    await this.initialized;
    const parsed = controlPlaneSessionRefPayloadSchema.parse(payload);
    await this.enqueue(async () => {
      this.notifications.retire(parsed.sessionId);
      await deleteRoute(this.db, parsed.sessionId);
      // Rebuild the policy inside the queue; if it cannot apply, stop the
      // sandbox as a platform failure so the alias is not left injected.
      await this.applyVercelNetworkPolicyOrStop('sandbox_lost');
      const state = await this.readAllocation();
      await this.armAlarm(state);
      const socket = this.boundWrapperSocket(state);
      if (socket !== null) {
        this.trySendFrame(socket, { type: 'session.release', sessionId: parsed.sessionId });
      }
    });
  }

  async status(payload: ControlPlaneSessionRefPayload): Promise<ControlPlaneStatusResult> {
    await this.initialized;
    const parsed = controlPlaneSessionRefPayloadSchema.parse(payload);
    return this.enqueue(async () => {
      const state = await this.readAllocation();
      const route = await readRoute(this.db, parsed.sessionId);
      return {
        sessionId: parsed.sessionId,
        view: routeView(route, state.kind === 'connected', sandboxPreparationProgress(state)),
      };
    });
  }

  /**
   * The wrapper identity bound to the connected allocation (B10 terminals).
   * Null while no wrapper is connected, so the Session DO never stamps a record
   * with a stale identity.
   */
  async getWrapperId(): Promise<string | null> {
    await this.initialized;
    return this.enqueue(async () => {
      const state = await this.readAllocation();
      return state.kind === 'connected' ? state.wrapperId : null;
    });
  }

  // --- worktree deletion (B10) ------------------------------------------------

  /**
   * Worker -> Sandbox DO (spec §6 "Billing, credentials and deletion"). Port of
   * the legacy DO cleanup: when the provider stop or the shared runtime is
   * confirmed, the worktree's routes are removed; otherwise it throws
   * `WorktreeDeletionIncompleteError`, which the Worker reports as an
   * incomplete, retryable result. Exclusivity is V2-native: the sandbox is
   * destroyed only when the deleted worktree owns the last route.
   *
   * The bounded provider call runs between two serial-queue phases, so a slow
   * provider cannot stall a sibling's hello/events/status (like worktreeCapture).
   */
  async deleteWorktreeResources(
    input: ControlPlaneWorktreeDeletionInput
  ): Promise<{ deleted: true; sessionIds: string[] }> {
    await this.initialized;
    const parsed = controlPlaneWorktreeDeletionInputSchema.parse(input);
    if (parsed.location.sandboxId !== this.sandboxId) {
      throw new Error('Worktree deletion location does not match this sandbox');
    }

    // Phase 1 (serial queue): owner admission, route/state reads, journal
    // decision. No provider call here.
    const handoff = await this.enqueue(async () => {
      await this.initializeOwner(parsed.kiloUserId);
      const routes = await listRoutes(this.db);
      const target = worktreeOwnedRoutes(routes, parsed);
      const state = await this.readAllocation();
      return {
        // The checkout directory comes from the request, not the routes, so a
        // connected shared sandbox with no route for this worktree still cleans
        // up (legacy `getWorktreeWorkspacePath` parity).
        directory: getWorktreeWorkspacePath(
          parsed.organizationId ?? null,
          parsed.kiloUserId,
          parsed.worktreeId
        ),
        plan: await beginWorktreeDeletion({
          request: parsed,
          exclusive: routes.length === target.length,
          storage: this.ctx.storage,
          allocation: state,
          hasConnection: this.boundWrapperSocket(state) !== null,
        }),
        targetSessionIds: target.map(route => route.sessionId),
      };
    });

    if (handoff.plan.action === 'replay') {
      return { deleted: true, sessionIds: handoff.plan.journal.sessionIds };
    }

    if (handoff.plan.action === 'shared') {
      // Phase 2 (off-queue): clean up the shared checkout through the wrapper
      // (R2). The bounded request awaits run outside the serial queue, exactly
      // like worktree captures.
      const cleanup = await this.runSharedWorktreeCleanup(
        parsed.worktreeId,
        handoff.directory,
        handoff.plan
      );
      // Phase 3 (serial queue): apply the confirmed result.
      return this.enqueue(async () => {
        if (!cleanup.ok) {
          throw new WorktreeDeletionIncompleteError('Shared worktree cleanup is not confirmed');
        }
        await this.revokeWorktreeRoutes(handoff.targetSessionIds);
        const journal = await finishWorktreeDeletion(
          this.ctx.storage,
          parsed.worktreeId,
          handoff.plan,
          cleanup.sessionIds
        );
        return { deleted: true, sessionIds: journal.sessionIds };
      });
    }

    // Phase 2 (off-queue): the bounded provider stop or observation.
    const confirmed = await this.confirmWorktreeRemoval(handoff.plan);

    // Phase 3 (serial queue): apply the confirmed result.
    return this.enqueue(async () => {
      if (!confirmed) {
        throw new WorktreeDeletionIncompleteError(
          handoff.plan.action === 'stop'
            ? 'Worktree provider stop is unconfirmed'
            : 'Shared worktree runtime must reconnect before cleanup'
        );
      }
      // Revoke the worktree's routes/grants even for a confirmed stop, so a
      // failed route cannot keep the sandbox looking shared forever.
      await this.revokeWorktreeRoutes(handoff.targetSessionIds);
      if (handoff.plan.action === 'stop') {
        // Fence by allocation identity: a sibling prepare may have created a new
        // allocation while the provider stop ran off-queue.
        const current = await this.readAllocation();
        if (current.allocationId === handoff.plan.allocationId) {
          await this.applyEvent({ type: 'provider-gone', at: Date.now() });
        }
      }
      const journal = await finishWorktreeDeletion(
        this.ctx.storage,
        parsed.worktreeId,
        handoff.plan
      );
      return { deleted: true, sessionIds: journal.sessionIds };
    });
  }

  /**
   * R2 shared checkout cleanup: ask the wrapper to prepare the deletion manifest
   * and then delete it. Mirrors the legacy `shared_wrapper` path: discovery first
   * so the wrapper's `deleteWorktree` manifest does not grow, then delete, then
   * require the wrapper to confirm every discovered session. A failed or
   * unconfirmed step reports incomplete, so the caller retries.
   */
  private async runSharedWorktreeCleanup(
    worktreeId: string,
    directory: string,
    plan: WorktreeDeletionPlan
  ): Promise<{ ok: true; sessionIds: string[] } | { ok: false }> {
    try {
      const discovery = await this.forwardWorktreeDeletion(
        worktreeId,
        directory,
        plan.journal.sessionIds,
        'prepareDeletion'
      );
      if (discovery === null) return { ok: false };
      const prepared = worktreePrepareDeletionResultSchema.safeParse(discovery);
      if (!prepared.success) return { ok: false };
      const manifest = [...new Set([...plan.journal.sessionIds, ...prepared.data.sessionIds])];
      // Persist the discovered manifest before the delete so a delete that
      // removes a child and then fails does not lose that child on retry
      // (legacy `sandbox-control/worktree-deletion.ts` parity).
      await this.enqueue(() =>
        persistWorktreeDeletionManifest(this.ctx.storage, worktreeId, plan.journal, manifest)
      );
      const deleted = await this.forwardWorktreeDeletion(worktreeId, directory, manifest, 'delete');
      if (deleted === null) return { ok: false };
      const confirmed = worktreeDeleteResultSchema.safeParse(deleted);
      if (!confirmed.success) return { ok: false };
      if (manifest.some(sessionId => !confirmed.data.sessionIds.includes(sessionId))) {
        return { ok: false };
      }
      return { ok: true, sessionIds: [...new Set([...manifest, ...confirmed.data.sessionIds])] };
    } catch {
      // Any unexpected failure is still an unconfirmed cleanup (spec §6).
      return { ok: false };
    }
  }

  /**
   * One wrapper worktree-deletion request. Returns null on any failure
   * (`not_ready`, a closed socket, a timeout or a rejected frame) so the caller
   * reports incomplete instead of trusting an unconfirmed cleanup. Uses the
   * legacy attach bound: `deleteWorktree` waits on in-flight directory
   * operations, Kilo calls, retirement and `fs.rm -rf`.
   */
  private async forwardWorktreeDeletion(
    worktreeId: string,
    directory: string,
    sessionIds: readonly string[],
    operation: 'prepareDeletion' | 'delete'
  ): Promise<unknown> {
    const payload = controlPlaneWorktreeDeletionPayloadSchema.parse({
      worktreeId,
      directory,
      sessionIds: [...sessionIds],
    });
    const requestId = crypto.randomUUID();
    const frame: ControlPlaneWrapperFrame =
      operation === 'prepareDeletion'
        ? { type: 'worktree.prepareDeletion', requestId, payload }
        : { type: 'worktree.delete', requestId, payload };
    const handoff = await this.enqueue(() =>
      this.beginWrapperControlRequest(frame, SANDBOX_CONTROL_ATTACH_TIMEOUT_MS)
    );
    const result = 'error' in handoff ? handoff.error : await handoff.promise;
    return result.ok ? result.result : null;
  }

  /** Deletion phase 2: the bounded provider call, outside the serial queue. */
  private async confirmWorktreeRemoval(plan: WorktreeDeletionPlan): Promise<boolean> {
    if (plan.action === 'complete') return true;
    if (plan.action === 'stop') {
      return this.stopProviderConfirmed(plan.providerRef, plan.allocationId);
    }
    return (await this.observeWorktreeRuntime(plan.providerRef)).status === 'terminal';
  }

  // --- worktree changes (B10) -------------------------------------------------

  /**
   * Session DO -> Sandbox DO (spec §10). Forwards one worktree-change request
   * to the wrapper and returns its result. The Sandbox DO owns no snapshot
   * state; the Session DO validates ownership and persists the capture.
   */
  async worktreeCapture(
    input: ControlPlaneWorktreeCaptureInput
  ): Promise<ControlPlaneControlResult> {
    await this.initialized;
    const parsed = controlPlaneWorktreeCaptureInputSchema.parse(input);
    // Only the bound socket, the pending entry and the write happen under the
    // serial queue. The wrapper's reply is awaited OUTSIDE it, so a capture
    // cannot stall `session.events`/`outcome`/`deliver`/the alarm for 30 s
    // (spec §10: RPCs return at once).
    const handoff = await this.enqueue(async () => this.beginWorktreeCapture(parsed));
    return 'error' in handoff ? handoff.error : handoff.promise;
  }

  private async beginWorktreeCapture(
    input: ControlPlaneWorktreeCaptureInput
  ): Promise<ControlRequestHandoff> {
    const requestId = crypto.randomUUID();
    const frame: ControlPlaneWrapperFrame =
      input.operation === 'snapshot'
        ? { type: 'worktree.snapshot', requestId, session: input.session, payload: input.payload }
        : { type: 'worktree.summary', requestId, session: input.session, payload: input.payload };
    return this.beginWrapperControlRequest(frame);
  }

  // --- terminals (B10) --------------------------------------------------------

  /**
   * Session DO -> Sandbox DO (spec §10). Forwards exactly one terminal
   * create/resize/close/connect request to the wrapper and returns its result.
   * Like worktree captures, only the bind/pending/write happen under the serial
   * queue; the reply is awaited outside it.
   */
  async terminal(input: ControlPlaneTerminalInput): Promise<ControlPlaneControlResult> {
    await this.initialized;
    const parsed = controlPlaneTerminalInputSchema.parse(input);
    const handoff = await this.enqueue(() => this.beginTerminalRequest(parsed));
    return 'error' in handoff ? handoff.error : handoff.promise;
  }

  private async beginTerminalRequest(
    input: ControlPlaneTerminalInput
  ): Promise<ControlRequestHandoff> {
    return this.beginWrapperControlRequest(terminalRequestFrame(crypto.randomUUID(), input));
  }

  /**
   * Binds one request frame to the connected socket under the serial queue and
   * registers it in the pending map. The wrapper's reply is resolved on the raw
   * socket path, so callers await the returned promise OUTSIDE the queue (spec
   * §10: RPCs return at once). Shared by worktree captures, terminals and the R2
   * worktree-deletion frames. `timeoutMs` overrides the default request bound
   * for operations with a longer legacy bound (worktree deletion).
   */
  private async beginWrapperControlRequest(
    frame: Extract<ControlPlaneWrapperFrame, { requestId: string }>,
    timeoutMs: number = this.controlRequestTimeoutMs
  ): Promise<ControlRequestHandoff> {
    const state = await this.readAllocation();
    const socket = this.boundWrapperSocket(state);
    if (socket === null) {
      return { error: controlRequestFailure('not_ready', 'Wrapper is not connected', true) };
    }
    if (this.pendingControlRequests.size >= MAX_PENDING_CONTROL_REQUESTS) {
      return {
        error: controlRequestFailure('busy', 'Too many outstanding control requests', true),
      };
    }
    const promise = this.registerPendingControlRequest(frame.requestId, socket, timeoutMs);
    if (!this.trySendFrame(socket, frame)) {
      this.settlePendingControlRequest(
        frame.requestId,
        controlRequestFailure('not_ready', 'Wrapper socket write failed', true)
      );
      return { error: controlRequestFailure('not_ready', 'Wrapper socket write failed', true) };
    }
    return { promise };
  }

  private registerPendingControlRequest(
    requestId: string,
    socket: WebSocket,
    timeoutMs: number = this.controlRequestTimeoutMs
  ): Promise<ControlPlaneControlResult> {
    return new Promise<ControlPlaneControlResult>(resolve => {
      const timer = setTimeout(() => {
        this.pendingControlRequests.delete(requestId);
        resolve(controlRequestFailure('not_ready', 'Wrapper request timed out', true));
      }, timeoutMs);
      this.pendingControlRequests.set(requestId, { socket, resolve, timer });
    });
  }

  private settlePendingControlRequest(requestId: string, result: ControlPlaneControlResult): void {
    const pending = this.pendingControlRequests.get(requestId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pendingControlRequests.delete(requestId);
    pending.resolve(result);
  }

  /**
   * Resolves every request bound to a closed socket at once, so a dropped
   * wrapper does not leave callers waiting the full request timeout.
   */
  private settlePendingForSocket(socket: WebSocket, result: ControlPlaneControlResult): void {
    for (const [requestId, pending] of this.pendingControlRequests) {
      if (pending.socket === socket) this.settlePendingControlRequest(requestId, result);
    }
  }

  /**
   * Resolves a pending control request from a wrapper result frame. Runs on the
   * raw socket message path (before the serial queue) so a queued request that
   * awaits its own result cannot deadlock the queue.
   */
  private resolvePendingControlResult(ws: WebSocket, message: string | ArrayBuffer): void {
    let parsed: unknown;
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (
      !isRecord(parsed) ||
      (parsed.type !== 'worktree.result' && parsed.type !== 'terminal.result')
    ) {
      return;
    }
    const result = controlPlaneWrapperFrameSchema.safeParse(parsed);
    if (
      !result.success ||
      (result.data.type !== 'worktree.result' && result.data.type !== 'terminal.result')
    ) {
      return;
    }
    const frame = result.data;
    if (this.pendingControlRequests.get(frame.requestId)?.socket !== ws) return;
    this.settlePendingControlRequest(
      frame.requestId,
      frame.ok ? { ok: true, result: frame.result } : { ok: false, error: frame.error }
    );
  }

  // --- credentials (B3) -------------------------------------------------------

  /**
   * Contained outbound credential lookup (spec §6/§10), same request shape as
   * `src/sandbox-outbound.ts` calls today. Matches the grant by alias, re-checks
   * expiry/containment, resolves and persists the refreshed grant.
   */
  async resolveCredential(input: {
    credential: string;
    outboundContainerId: string;
    url: string;
    method: string;
  }): Promise<{ credential: string; organizationId?: string } | null> {
    await this.initialized;
    return this.enqueue(async () => {
      try {
        const state = await this.readAllocation();
        if (!this.sandboxCanResolveCredentials(state)) return null;
        const ownerId = await this.requireOwner();
        if (ownerId === null) return null;
        const alias = parseControlPlaneCredential(input.credential);
        if (alias === null || alias.sandboxId !== this.sandboxId) return null;
        const expectedOutbound = this.outboundContainerIdFor(state);
        if (expectedOutbound === null || input.outboundContainerId !== expectedOutbound) {
          return null;
        }
        for (const grant of listScopeGrants(this.db)) {
          if (grant.userId !== ownerId) continue;
          if (!(await this.grantMatchesAlias(grant, input.credential))) continue;
          const resolved = await resolveSessionCredential({ env: this.env, grant, ...input });
          if (!resolved) return null;
          const current = await this.readAllocation();
          if (
            !this.sandboxCanResolveCredentials(current) ||
            Date.now() >= resolved.grant.expiresAt
          ) {
            return null;
          }
          writeScopeGrant(this.db, resolved.grant);
          return {
            credential: resolved.credential,
            ...(alias.purpose === 'kilo' ? { organizationId: resolved.organizationId ?? '' } : {}),
          };
        }
        return null;
      } catch {
        return null;
      }
    });
  }

  /**
   * Runtime credential proxy fence (spec §10), keyed on the routed session. The
   * proxy authorizes a handle against this fence before binding it.
   */
  async getRuntimeCredentialProxyFence(input: {
    ownerId: string;
    sessionId: string;
    kiloSessionId: string;
    directory: string;
  }): Promise<ControlRuntimeCredentialProxyFence | null> {
    await this.initialized;
    if (
      typeof input.ownerId !== 'string' ||
      typeof input.sessionId !== 'string' ||
      typeof input.kiloSessionId !== 'string' ||
      typeof input.directory !== 'string'
    ) {
      return null;
    }
    return this.enqueue(async () => {
      const state = await this.readAllocation();
      const fence = this.runtimeProxyFenceFor(state);
      if (fence === null) return null;
      const owner = await this.requireOwner();
      if (owner === null || owner !== input.ownerId) return null;
      const route = await readRoute(this.db, input.sessionId);
      if (route?.state === 'failed') return null;
      const grant = route?.grant ?? null;
      const provisioned =
        grant !== null &&
        grant.userId === input.ownerId &&
        grant.directory === input.directory &&
        grant.expiresAt > Date.now() &&
        grant.members.some(
          member =>
            member.sessionId === input.sessionId && member.kiloSessionId === input.kiloSessionId
        );
      if (!provisioned || route === null) return null;
      if (
        route.spec.kiloSessionId !== input.kiloSessionId ||
        route.spec.directory !== input.directory
      ) {
        return null;
      }
      return fence;
    });
  }

  /** Binds a verified runtime credential proxy handle to the route's grant. */
  async bindRuntimeCredentialProxyHandle(input: {
    ownerId: string;
    sessionId: string;
    kiloSessionId: string;
    directory: string;
    handle: string;
  }): Promise<{ bound: true }> {
    await this.initialized;
    if (
      typeof input.handle !== 'string' ||
      input.handle.length === 0 ||
      input.handle.length > 4096
    ) {
      throw new Error('Invalid runtime credential proxy handle');
    }
    return this.enqueue(async () => {
      const owner = await this.requireOwner();
      if (owner === null || owner !== input.ownerId) {
        throw new Error('Sandbox owner mismatch');
      }
      const route = await readRoute(this.db, input.sessionId);
      const grant = route?.grant ?? null;
      if (
        route === null ||
        route.state === 'failed' ||
        grant === null ||
        grant.userId !== input.ownerId ||
        grant.directory !== input.directory ||
        grant.expiresAt <= Date.now() ||
        !grant.members.some(
          member =>
            member.sessionId === input.sessionId && member.kiloSessionId === input.kiloSessionId
        ) ||
        grant.kilo.runtimeProxy === undefined
      ) {
        throw new Error('Session has no matching runtime proxy credential grant');
      }
      const claims = await verifyRuntimeCredentialProxyHandle(this.env, input.handle);
      if (
        !claims ||
        !('sessionId' in claims) ||
        claims.userId !== input.ownerId ||
        claims.sessionId !== input.sessionId ||
        claims.kiloSessionId !== input.kiloSessionId
      ) {
        throw new Error('Invalid runtime credential proxy member handle');
      }
      const updated: SessionCredentialGrant = {
        ...grant,
        kilo: {
          ...grant.kilo,
          runtimeProxy: {
            ...grant.kilo.runtimeProxy,
            members: [
              ...grant.kilo.runtimeProxy.members.filter(
                member => member.sessionId !== input.sessionId
              ),
              {
                sessionId: input.sessionId,
                kiloSessionId: input.kiloSessionId,
                handle: input.handle,
              },
            ],
          },
        },
      };
      if (!(await this.applyCandidateGrantPolicy(updated))) {
        throw new Error('Sandbox credential policy is unavailable');
      }
      writeScopeGrant(this.db, updated);
      return { bound: true };
    });
  }

  /**
   * Vercel network policy entry point (spec §10 runtime credential proxy). The
   * caller-supplied `networkPolicy` is accepted for RPC compatibility but not
   * applied: the policy is rebuilt from the stored grants so this cannot become
   * a second source of truth, and the caller must own the sandbox (B3 review 5).
   */
  async updateNetworkPolicy(input: {
    ownerId: string;
    networkPolicy: VercelSandboxNetworkPolicy;
    requiredContainment: CredentialContainmentRequirements;
  }): Promise<void> {
    await this.initialized;
    await this.enqueue(async () => {
      const owner = await this.requireOwner();
      if (owner === null || owner !== input.ownerId) {
        throw new Error('Sandbox owner mismatch');
      }
      if (this.currentProvider() !== 'vercel') {
        throw new Error('Sandbox network policy requires a Vercel provider');
      }
      const state = await this.readAllocation();
      if (
        (state.kind !== 'connected' && state.kind !== 'disconnected') ||
        state.providerRef === null
      ) {
        throw new Error('Sandbox network policy requires a running instance');
      }
      if (
        (!input.requiredContainment.kilocode && !input.requiredContainment.github) ||
        !this.matchesContainment(input.requiredContainment)
      ) {
        throw new Error('Sandbox credential containment mismatch');
      }
      if (!(await this.refreshVercelNetworkPolicy())) {
        throw new Error('Sandbox credential policy is unavailable');
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialized;
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const token = parseSandboxLaunchBearer(request.headers.get('Authorization'));
    if (token === null)
      return new Response('Invalid or missing Authorization header', { status: 401 });
    const secret = await resolveSecret(this.env.NEXTAUTH_SECRET);
    if (!secret) return new Response('Authentication unavailable', { status: 503 });
    const launch = verifySandboxLaunchCredential(token, secret);
    return this.enqueue(async () => {
      if (
        launch === null ||
        launch.sandboxId !== this.sandboxId ||
        !(await this.validateAllocationCredential(launch.allocationId, launch.credential))
      ) {
        return rejectSandboxWrapperUpgrade();
      }
      this.expireUnboundSockets(Date.now());
      const candidates = this.ctx.getWebSockets().filter(ws => {
        const attachment = this.readAttachment(ws);
        return (
          ws.readyState === WebSocket.OPEN &&
          attachment?.helloDeadlineAt !== undefined &&
          attachment.allocationId === launch.allocationId
        );
      });
      if (candidates.length >= 2) {
        const pair = new WebSocketPair();
        pair[1].accept();
        pair[1].close(1013, 'Handshake capacity');
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({
        credential: launch.credential,
        allocationId: launch.allocationId,
        helloDeadlineAt: Date.now() + this.sandboxTimers().wrapperHelloMs,
      } satisfies WrapperSocketAttachment);
      await this.armAlarm(await this.readAllocation());
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.initialized;
    // Resolve an outstanding control request before the serial queue so the
    // queued request that awaits it cannot block its own reply.
    this.resolvePendingControlResult(ws, message);
    await this.enqueue(() => this.handleFrame(ws, message));
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.initialized;
    // Fail every request bound to this socket at once; do not wait the timeout.
    this.settlePendingForSocket(
      ws,
      controlRequestFailure('not_ready', 'Wrapper disconnected', true)
    );
    await this.enqueue(async () => {
      const attachment = this.readAttachment(ws);
      if (attachment?.allocationId === undefined || attachment.connectionId === undefined) {
        ws.serializeAttachment({ credential: null });
        await this.armAlarm(await this.readAllocation());
        return;
      }
      await this.applyEvent({
        type: 'socket-closed',
        at: Date.now(),
        allocationId: attachment.allocationId,
        connectionId: attachment.connectionId,
        origin: 'peer',
      });
    });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    await this.initialized;
    await this.enqueue(async () => {
      this.expireUnboundSockets(Date.now());
      const state = await this.readAllocation();
      await failExpiredRoutes(this.routeContext(state));
      if (state.kind === 'creating' && this.createInFlight) {
        // N2: the in-flight attempt owns the create deadline. Keep a backstop;
        // it will dispatch its own result and re-arm.
        for (const entry of await this.billingSchedule.dueEntries()) {
          if (typeof entry.payload === 'string') {
            await this.deferVercelBilling(entry.payload, entry.callback);
          }
        }
        await this.ctx.storage.setAlarm(
          Math.min(
            Date.now() + this.sandboxTimers().providerCreateMs,
            (await earliestRouteDeadlineAt(this.db)) ?? Infinity,
            this.earliestHelloDeadlineAt() ?? Infinity,
            this.billingSchedule.snapshotEarliestDue() ?? Infinity
          )
        );
        return;
      }
      await this.applyEvent({
        type: 'tick',
        at: Date.now(),
        nextAllocationId: crypto.randomUUID(),
        retryAllowed: await this.retryAllowed(),
      });
      try {
        await withTimeout(
          this.runBillingAlarm(),
          this.sandboxTimers().providerStopAttemptMs,
          'Sandbox billing alarm timed out'
        );
      } catch {
        for (const entry of await this.billingSchedule.dueEntries()) {
          if (typeof entry.payload === 'string') {
            await this.deferVercelBilling(entry.payload, entry.callback);
          }
        }
        logger.withFields({ sandboxId: this.sandboxId }).warn('Vercel billing alarm deferred');
      }
      await this.armAlarm(await this.readAllocation());
    });
  }

  // --- init and storage cutover ----------------------------------------------

  private async initializeStorage(): Promise<void> {
    const generation = await this.ctx.storage.get<unknown>(GENERATION_KEY);
    if (generation === undefined) {
      const cutover = await this.readLegacyCutover();
      const retainedBilling = new Map<string, unknown>();
      for (const prefix of ['container-usage:', 'vercel-billing:']) {
        for (const [key, value] of await this.ctx.storage.list({ prefix })) {
          retainedBilling.set(key, value);
        }
      }
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put(GENERATION_KEY, GENERATION);
      await migrate(this.db, migrations);
      for (const [key, value] of retainedBilling) await this.ctx.storage.put(key, value);
      await this.billingSchedule.load();
      const pin = this.cutoverPin(cutover);
      this.providerPin = pin;
      this.provider = this.createProviderAdapter(pin);
      const state: AllocationState = {
        ...initialAllocationState(),
        ...(cutover.providerRef === null
          ? {}
          : {
              kind: 'stopping' as const,
              providerRef: cutover.providerRef,
              // The backstop is the first ladder attempt: init must not run the
              // stop inline, so the alarm resumes it (H2).
              stopAt: Date.now() + this.sandboxTimers().providerStopAttemptMs,
            }),
      };
      await this.writeAllocation(state);
      await this.writeProviderPin(pin);
      await this.armAlarm(state);
      return;
    }
    await migrate(this.db, migrations);
    await this.billingSchedule.load();
    const row = await this.readAllocationRow();
    if (row === null) return;
    const pin = (await this.readProviderPin()) ?? this.defaultPin('cloudflare');
    this.providerPin = pin;
    this.provider = this.createProviderAdapter(pin);
    let state = rowToState(row);
    const routes = this.db.select().from(routesTable).all();
    if (
      routes.some(
        route =>
          route.grant?.trimStart().startsWith('{') ||
          (route.state === 'ready' &&
            route.credential_source !== null &&
            (route.grant === null || readScopeGrant(this.db, route.grant) === null))
      )
    ) {
      // Per-route snapshots do not identify which sibling's aliases the runtime installed.
      const now = Date.now();
      const stopped = reduceAllocation(
        state,
        { type: 'stop-requested', at: now, reason: 'agent_restarted' },
        this.sandboxTimers()
      ).state;
      state =
        state.kind !== 'stopping' && stopped.kind === 'stopping'
          ? { ...stopped, stopPending: true, stopAt: now }
          : stopped;
      this.db.transaction(tx => {
        retireScopeGrants(tx);
        for (const route of routes) {
          tx.update(routesTable)
            .set({
              grant: null,
              ...(route.state === 'failed' ? {} : { state: 'failed', reason: 'agent_restarted' }),
              updated_at: now,
            })
            .where(eq(routesTable.session_id, route.session_id))
            .run();
        }
        tx.update(allocationTable)
          .set(stateToRow(state))
          .where(eq(allocationTable.id, ALLOCATION_ROW_ID))
          .run();
      });
      for (const route of routes) {
        if (route.state === 'failed') continue;
        this.notifications.enqueue(route.session_id, {
          kind: 'route',
          payload: {
            state: route.state === 'ready' ? 'lost' : 'failed',
            attemptId: route.attempt_id,
            reason: 'agent_restarted',
          },
        });
      }
    }
    await this.armAlarm(state);
  }

  private currentProvider(): AgentSandboxProvider {
    return this.providerPin?.provider ?? 'cloudflare';
  }

  private cutoverPin(cutover: LegacyCutover): StoredProviderPin {
    return {
      provider: cutover.provider,
      allocationName: cutover.allocationName ?? this.sandboxId,
      configuration: cutover.configuration ?? { provider: cutover.provider },
      locator: cutover.vercelLocator,
      billing: cutover.billing,
      containment: null,
    };
  }

  private defaultPin(provider: AgentSandboxProvider): StoredProviderPin {
    return {
      provider,
      allocationName: this.sandboxId,
      configuration: { provider },
      locator: null,
      billing: null,
      containment: null,
    };
  }

  private pinFromInput(input: EnsureAllocationInput): StoredProviderPin {
    const provider = input.provider ?? 'cloudflare';
    return {
      provider,
      allocationName: input.allocationName ?? this.sandboxId,
      configuration: input.configuration ?? { provider },
      locator: input.locator ?? null,
      billing: input.billing ?? null,
      containment: input.containment ?? null,
    };
  }

  private async readLegacyCutover(): Promise<LegacyCutover> {
    const [kindRaw, configRaw, locatorRaw, allocationRaw, billingRaw] = await Promise.all([
      this.ctx.storage.get<unknown>('provider_kind'),
      this.ctx.storage.get<unknown>('provider_configuration'),
      this.ctx.storage.get<unknown>('provider_locator'),
      this.ctx.storage.get<unknown>('sandbox_allocation_state'),
      this.ctx.storage.get<unknown>('billing_input'),
    ]);
    let provider: AgentSandboxProvider = 'cloudflare';
    let configuration: SandboxProviderConfiguration | null = null;
    const parsedConfiguration = sandboxProviderConfigurationSchema.safeParse(configRaw);
    if (parsedConfiguration.success) {
      provider = parsedConfiguration.data.provider;
      configuration = parsedConfiguration.data;
    } else if (typeof kindRaw === 'string') {
      const kind = agentSandboxProviderSchema.safeParse(kindRaw);
      if (kind.success) provider = kind.data;
    }
    const locator = vercelProviderLocatorSchema.safeParse(locatorRaw);
    let providerRef: string | null = null;
    let allocationName: string | null = null;
    if (isRecord(allocationRaw)) {
      const state = allocationRaw.state;
      const target = isRecord(state) ? state.target : undefined;
      if (isRecord(target)) {
        if (typeof target.providerRef === 'string') providerRef = target.providerRef;
        if (typeof target.allocationName === 'string') allocationName = target.allocationName;
      }
    }
    return {
      provider,
      providerRef,
      allocationName,
      configuration,
      vercelLocator: locator.success ? locator.data : null,
      billing: (() => {
        if (billingRaw === undefined) return null;
        try {
          return parseSandboxBillingInput(billingRaw);
        } catch {
          return null;
        }
      })(),
    };
  }

  // --- allocation events and effects -----------------------------------------

  private async applyEvent(event: AllocationEvent): Promise<void> {
    const previous = await this.readAllocation();
    const { state, effects, stopReason } = reduceAllocation(previous, event, this.sandboxTimers());
    await this.writeAllocation(state);
    if (
      previous.kind !== state.kind ||
      previous.stopAttempt !== state.stopAttempt ||
      (previous.unconfirmedProviderRef === null) !== (state.unconfirmedProviderRef === null)
    ) {
      logControlDiagnostic('allocation_transition', {
        allocationName: this.providerPin?.allocationName ?? this.sandboxId,
        event: event.type,
        origin: event.type === 'socket-closed' ? event.origin : undefined,
        from: previous.kind,
        to: state.kind,
        fromAllocationId: previous.allocationId,
        toAllocationId: state.allocationId,
        stopAttempt: state.stopAttempt,
        stopReason: stopReason ?? 'none',
        unconfirmedProviderRef: state.unconfirmedProviderRef !== null,
      });
    }
    await this.armAlarm(state);
    await this.afterVercelBillingTransition(event);
    await this.applyRouteEffects(previous, state, event, stopReason);
    for (const effect of effects) {
      await this.runEffect(effect, state);
    }
  }

  /**
   * One bound for a credential grant issuance (init and re-issue). A hung token
   * service must not hold this DO's serial queue for the preparation window; a
   * timeout is an issuance failure (`workspace_setup_failed`), not a hang. Reuses
   * the 30 s provider-stop bound, which already bounds provider policy work.
   */
  private grantIssueTimeoutMs(): number {
    return this.sandboxTimers().providerStopAttemptMs;
  }

  /** Route transitions need storage, the bound socket and the bounded notify. */
  private routeContext(state: AllocationState): RouteContext {
    return {
      db: this.db,
      now: () => Date.now(),
      routePreparationMs: this.sandboxTimers().routePreparationMs,
      sendPrepare: route => this.sendSessionPrepare(state, route),
      notify: (sessionId, update) => {
        this.notifications.enqueue(sessionId, { kind: 'route', payload: update });
        return Promise.resolve();
      },
      issueGrant: (spec, source) =>
        withTimeout(
          this.issueRouteGrant(spec, source),
          this.grantIssueTimeoutMs(),
          'Credential grant issuance timed out'
        ),
      applyPolicy: candidate =>
        candidate === undefined
          ? this.refreshVercelNetworkPolicy()
          : this.applyCandidateGrantPolicy(candidate),
      publishGrant: route => this.publishRouteGrant(route),
    };
  }

  // --- route execution and notifications (B3) ---------------------------------

  private async runPrepare(
    spec: ControlPlaneRouteSpec,
    source: ControlPlaneCredentialSource,
    sandboxSelection?: ControlPlaneSandboxSelection
  ): Promise<ControlPlaneRouteView> {
    // Sandbox owner admission (B3 review 5): the first prepare names the owner;
    // a later prepare for a different owner is rejected, not silently accepted.
    await this.initializeOwner(source.userId);
    let state = await this.readAllocation();
    // A worktree mid-deletion must never be re-prepared: a send in the Worker's
    // begin->finish window would otherwise start a fresh allocation and recreate
    // the checkout that deleteWorktreeResources just removed (spec §6, Shared
    // Worktrees rule 13). Return the failed view without persisting a route row:
    // a stale failed row would make a later exclusive deletion look shared. Any
    // row from an earlier prepare is removed so no route survives the worktree.
    const deletionJournal = await loadWorktreeDeletionJournal(
      this.ctx.storage,
      source.scopeId ?? spec.sessionId
    );
    if (deletionJournal !== undefined && !deletionJournal.completed) {
      this.notifications.retire(spec.sessionId);
      await deleteRoute(this.db, spec.sessionId);
      return {
        state: 'failed',
        attemptId: crypto.randomUUID(),
        reason: 'workspace_setup_failed',
      };
    }
    // H1: apply the Worker-selected provider pin before the first attempt. The
    // pin is only mutable while stopped; once an allocation exists its provider
    // is fixed and a repeated prepare must not re-decide it.
    if (sandboxSelection !== undefined && state.kind === 'stopped') {
      const pin = this.pinFromInput(sandboxSelection);
      await this.writeProviderPin(pin);
      this.providerPin = pin;
      this.provider = this.createProviderAdapter(pin);
    }
    if (
      state.kind !== 'stopped' &&
      state.kind !== 'creating' &&
      this.currentProvider() === 'vercel' &&
      (this.providerPin?.billing?.enforcementRequested ||
        isCloudAgentContainerBillingEnabled(this.env, {
          userId: source.userId,
          ...(this.providerPin?.billing?.subject.type === 'org'
            ? { orgId: this.providerPin.billing.subject.id }
            : {}),
        }))
    ) {
      const context = await getBillingContext(this.ctx.storage);
      const runtime = await this.ensureVercelBillingRuntime();
      const lostBillingGeneration = context === undefined || context.pendingStop !== undefined;
      const billingReason: ControlPlaneFailureReason =
        runtime !== undefined && (await runtime.lifecycle.isBillingBlocked())
          ? 'billing_blocked'
          : lostBillingGeneration
            ? 'sandbox_lost'
            : 'billing_unavailable';
      let cannotContinue =
        context === undefined ||
        runtime === undefined ||
        context.pendingStop !== undefined ||
        billingReason === 'billing_blocked';
      if (!cannotContinue && runtime !== undefined && context !== undefined) {
        try {
          await withTimeout(
            runtime.lifecycle.ensureStartAcknowledged(context),
            this.sandboxTimers().providerStopAttemptMs,
            'Sandbox billing admission timed out'
          );
        } catch {
          cannotContinue = true;
        }
      }
      if (cannotContinue) {
        if (state.kind !== 'stopping') {
          await this.applyEvent({
            type: 'stop-requested',
            at: Date.now(),
            reason: billingReason,
          });
          state = await this.readAllocation();
        }
        if (billingReason === 'billing_blocked') {
          const attemptId = crypto.randomUUID();
          const route = await failRoute(
            this.routeContext(state),
            { ...spec, attemptId },
            attemptId,
            billingReason,
            'billing_admission'
          );
          return { state: 'failed', attemptId: route.attemptId, reason: billingReason };
        }
      }
    }
    const { route, started } = await ensureRoute(this.routeContext(state), spec, source);
    if (route.state !== 'failed') {
      if (started) await this.armAlarm(state);
      if (state.kind === 'stopped') {
        await this.applyEvent({
          type: 'ensure',
          at: Date.now(),
          allocationId: crypto.randomUUID(),
        });
        state = await this.readAllocation();
      }
    }
    return routeView(route, state.kind === 'connected', sandboxPreparationProgress(state));
  }

  /** Stores the sandbox owner on first use and rejects a different one. */
  private async initializeOwner(userId: string): Promise<void> {
    const normalized = userId.trim();
    if (normalized.length === 0) throw new Error('Sandbox owner is required');
    const stored = await this.ctx.storage.get<string>(OWNER_KEY);
    if (typeof stored === 'string' && stored.length > 0) {
      if (stored !== normalized) throw new Error('Sandbox owner mismatch');
      return;
    }
    await this.ctx.storage.put(OWNER_KEY, normalized);
  }

  private async requireOwner(): Promise<string | null> {
    const stored = await this.ctx.storage.get<string>(OWNER_KEY);
    return typeof stored === 'string' && stored.length > 0 ? stored : null;
  }

  private async issueRouteGrant(
    spec: ControlPlaneRouteSpec,
    source: ControlPlaneCredentialSource
  ): Promise<RouteGrantIssue> {
    const provider = this.currentProvider();
    const outboundContainerId =
      this.outboundContainerIdFor(await this.readAllocation()) ?? undefined;
    const base: SessionAttachPayload = {
      directory: spec.directory,
      ...(spec.branch ? { branch: spec.branch } : {}),
      ...(spec.branchMode ? { branchMode: spec.branchMode } : {}),
      ...(spec.env ? { env: spec.env } : {}),
      ...(spec.setupCommands ? { setupCommands: spec.setupCommands } : {}),
      ...(spec.runtimeIsolation ? { runtimeIsolation: spec.runtimeIsolation } : {}),
      ...(spec.git ? { git: spec.git } : {}),
    };
    const scopeId = source.scopeId ?? spec.sessionId;
    const modern = kiloTokenHasRuntimeAuthorization(source.kiloToken);
    const scopes = listScopeGrants(this.db);
    const existing = scopes.find(
      grant => grant.scopeId === scopeId && (grant.kilo.runtimeProxy !== undefined) === modern
    );
    const { grant, payload } = await prepareCredentialGrant({
      env: this.env,
      source,
      sessionId: spec.sessionId,
      sandboxId: this.sandboxId,
      provider,
      containmentEnabled: this.credentialContainmentEnabled(),
      directory: spec.directory,
      scopeId,
      payload: base,
      leaseMs: this.sandboxTimers().credentialGrantMs,
      ...(existing === undefined ? {} : { existing }),
      refreshBacking: existing !== undefined && this.grantNeedsReissue(existing),
      ...(outboundContainerId === undefined ? {} : { outboundContainerId }),
    });
    for (const otherGrant of scopes) {
      if (scopeGrantId(otherGrant) === scopeGrantId(grant)) continue;
      if (
        otherGrant.scopeId === grant.scopeId &&
        otherGrant.repository?.type === 'git' &&
        grant.repository?.type === 'git' &&
        otherGrant.userId === grant.userId &&
        otherGrant.orgId === grant.orgId &&
        otherGrant.directory === grant.directory &&
        otherGrant.provider === grant.provider &&
        otherGrant.outboundContainerId === grant.outboundContainerId &&
        otherGrant.containmentEnabled === grant.containmentEnabled &&
        JSON.stringify(otherGrant.repository) === JSON.stringify(grant.repository) &&
        JSON.stringify(otherGrant.kilo.targets) === JSON.stringify(grant.kilo.targets) &&
        !otherGrant.members.some(
          member =>
            member.sessionId === spec.sessionId || member.kiloSessionId === source.kiloSessionId
        )
      )
        continue;
      if (
        otherGrant.scopeId === scopeId ||
        otherGrant.directory === grant.directory ||
        otherGrant.members.some(
          member =>
            member.sessionId === spec.sessionId || member.kiloSessionId === source.kiloSessionId
        )
      ) {
        throw new Error('Worktree credential scope mismatch');
      }
    }
    return { grant, spec: this.projectRouteSpec(spec, payload) };
  }

  private publishRouteGrant(route: RouteRecord): void {
    this.db.transaction(tx => {
      if (route.grant !== null) writeScopeGrant(tx, route.grant);
      writeRoute(tx, route);
    });
  }

  private applyCandidateGrantPolicy(candidate: SessionCredentialGrant): Promise<boolean> {
    const now = Date.now();
    return this.refreshVercelNetworkPolicy([
      ...listScopeGrants(this.db).filter(
        grant => scopeGrantId(grant) !== scopeGrantId(candidate) && grant.expiresAt > now
      ),
      candidate,
    ]);
  }

  private projectRouteSpec(
    spec: ControlPlaneRouteSpec,
    payload: {
      directory?: string | undefined;
      env?: Record<string, string> | undefined;
      setupCommands?: string[] | undefined;
      git?: SessionAttachPayload['git'];
      kilo: NonNullable<SessionAttachPayload['kilo']>;
    }
  ): ControlPlaneRouteSpec {
    // Explicit projection: token-bearing fields come only from the issued grant,
    // never from the input spec (B3 review 4). MCP plaintext is never projected
    // here; the Sandbox DO adds it only to a `session.prepare` frame.
    return {
      sessionId: spec.sessionId,
      kiloSessionId: spec.kiloSessionId,
      attemptId: spec.attemptId,
      directory: payload.directory ?? spec.directory,
      ...(spec.branch === undefined ? {} : { branch: spec.branch }),
      ...(spec.branchMode === undefined ? {} : { branchMode: spec.branchMode }),
      env: payload.env ?? {},
      ...(payload.setupCommands === undefined ? {} : { setupCommands: payload.setupCommands }),
      ...(spec.runtimeIsolation === undefined ? {} : { runtimeIsolation: spec.runtimeIsolation }),
      ...(payload.git === undefined ? {} : { git: payload.git }),
      kilo: payload.kilo,
    };
  }

  private async runDeliver(
    payload: ControlPlaneDeliverPayload
  ): Promise<ControlPlaneDeliverResult> {
    const state = await this.readAllocation();
    const route = await readRoute(this.db, payload.sessionId);
    if (state.kind !== 'connected' || route === null || route.state !== 'ready') {
      return 'not_ready';
    }
    const socket = this.boundWrapperSocket(state);
    if (socket === null) return 'not_ready';
    if (route.grant !== null && this.grantNeedsReissue(route.grant)) {
      // Credentials half of B3: re-issue below one hour remaining with freshly
      // selected material and send `session.credentials` before the prompts. A
      // failure to re-issue must not send the frame: while the previous grant is
      // still due, deliver the prompts on it and retry the re-issue on the next
      // send. Once that grant has expired there is no usable grant left for any
      // re-issue outcome, so the route fails now with the real reason.
      const outcome = await this.reissueRouteGrant(route, state);
      if (outcome !== 'issued' && Date.now() >= route.grant.expiresAt) {
        // No usable grant: fail the route as the prepare path does, so the
        // Session DO starts a fresh attempt or releases the queued messages with
        // the real reason, instead of leaving them for the queued backstop.
        // If the route stayed `ready`, `prepare` would return the same ready
        // view and deliver would keep returning `not_ready`.
        await onRouteFailed(
          this.routeContext(state),
          payload.sessionId,
          'workspace_setup_failed',
          undefined,
          true
        );
        return 'not_ready';
      }
    }
    for (const message of payload.messages) {
      const sent = this.trySendFrame(socket, {
        type: 'session.prompt',
        sessionId: payload.sessionId,
        payload: message,
      });
      if (!sent) return 'not_ready';
    }
    await this.touchActivity(Date.now());
    return 'sent';
  }

  private grantNeedsReissue(grant: SessionCredentialGrant): boolean {
    return grant.expiresAt - Date.now() < this.sandboxTimers().credentialGrantReissueBelowMs;
  }

  /**
   * Re-issues a warm route's grant. The new grant is written only after the
   * provider policy that covers its aliases is applied, so a policy failure
   * leaves the previous grant in place. Any non-`issued` outcome means the
   * caller must not send `session.credentials`; `runDeliver` keeps the route
   * while the previous grant is still due and fails it once that grant has
   * expired, so the Session DO starts a fresh attempt instead of waiting for
   * the backstop.
   */
  private async reissueRouteGrant(
    route: RouteRecord,
    state: AllocationState
  ): Promise<'issued' | 'policy_failed' | 'skipped' | 'failed'> {
    const source = route.credentialSource;
    if (source === null) return 'skipped';
    const socket = this.boundWrapperSocket(state);
    if (socket === null) return 'skipped';
    let issued: RouteGrantIssue;
    try {
      // Bound the token-service round trip so a warm-route `deliver` cannot
      // hang forever; the grant-issue bound is the provider-stop bound.
      issued = await withTimeout(
        this.issueRouteGrant(route.spec, source),
        this.grantIssueTimeoutMs(),
        'Credential grant re-issue timed out'
      );
    } catch {
      return 'failed';
    }
    if (!(await this.applyCandidateGrantPolicy(issued.grant))) return 'policy_failed';
    const next: RouteRecord = { ...route, grant: issued.grant, spec: issued.spec };
    this.publishRouteGrant(next);
    const payload: ControlPlaneSessionCredentialsPayload = {
      ...sessionCredentialsPayloadFromGrant(issued.grant, route.sessionId),
    };
    this.trySendFrame(socket, { type: 'session.credentials', ...payload });
    return 'issued';
  }

  // --- contained credential helpers (B3) --------------------------------------

  /** The managed outbound container id for the current provider/allocation. */
  private outboundContainerIdFor(state: AllocationState): string | null {
    // The container is the containment boundary. When containment is off there
    // is no proxy container to name, and the environment may not even bind the
    // containment namespaces (the e2e Worker strips them).
    if (!this.credentialContainmentEnabled()) return null;
    const provider = this.currentProvider();
    if (!providerUsesOutboundCredentialProxy(provider)) return null;
    if (provider === 'cloudflare-containers') {
      return (
        getManagedOutboundContainerId(provider, this.env, {
          logicalSandboxId: this.sandboxId,
          physicalSandboxId: this.sandboxId,
        }) ?? null
      );
    }
    // The physical id is knowable before `create`: the provider builds its ref
    // from `intent.allocationName ?? sandboxId`. Use the current pin even when
    // stopped, because the ensure for this same queued operation will create the
    // sandbox with that pin's allocation name (B3 review 1, N1).
    const physicalSandboxId =
      decodeCloudflareProviderRef(state.providerRef)?.sandboxId ??
      this.providerPin?.allocationName ??
      this.sandboxId;
    return (
      getManagedOutboundContainerId(provider, this.env, {
        logicalSandboxId: this.sandboxId,
        physicalSandboxId,
      }) ?? null
    );
  }

  private sandboxCanResolveCredentials(state: AllocationState): boolean {
    return (
      state.kind !== 'stopped' &&
      state.kind !== 'stopping' &&
      state.providerRef !== null &&
      providerUsesOutboundCredentialProxy(this.currentProvider())
    );
  }

  private async grantMatchesAlias(
    grant: SessionCredentialGrant,
    credential: string
  ): Promise<boolean> {
    const alias = parseControlPlaneCredential(credential);
    if (alias === null) return false;
    const expected = alias.purpose === 'kilo' ? grant.kilo.alias : grant.scm?.alias;
    if (expected === undefined) return false;
    // Constant-time comparison of a secret-bearing alias (B3 review 5).
    return sandboxCredentialMatchesHash(credential, await hashSandboxCredential(expected));
  }

  /**
   * The one containment decision for this sandbox. The Worker-selected
   * per-requirement containment (H2) owns it; the environment default applies
   * only when no selection was stored. Never derived from the session plane, so
   * a local `CREDENTIAL_CONTAINMENT_ENABLED=false` control session stays on
   * direct credentials.
   */
  private credentialContainmentEnabled(): boolean {
    const containment = this.resolvedContainment();
    return containment.kilocode || containment.github;
  }

  /**
   * The one resolved containment requirement for this sandbox: the
   * Worker-selected per-requirement value, else the environment default. Every
   * consumer (grants and the provider create intent) reads this, so the physical
   * container class and the grant can never disagree.
   */
  private resolvedContainment(): CredentialContainmentRequirements {
    return (
      this.providerPin?.containment ??
      getWorktreeCredentialContainment(this.env.CREDENTIAL_CONTAINMENT_ENABLED !== 'false')
    );
  }

  private matchesContainment(required: CredentialContainmentRequirements): boolean {
    const stored = this.resolvedContainment();
    return (
      stored.kilocode === required.kilocode &&
      stored.github === required.github &&
      stored.worktreeScoped === (required.worktreeScoped ?? true)
    );
  }

  private async activeGrants(now: number): Promise<SessionCredentialGrant[]> {
    return listScopeGrants(this.db).filter(grant => grant.expiresAt > now);
  }

  /**
   * Rebuilds the Vercel network policy from the stored grants (or a caller's
   * candidate set). Runs inside the operation queue and does not stop the
   * sandbox: it returns `false` on failure so callers can decide (retry vs.
   * fail closed). Transient failures keep the route alive so a later send can
   * retry (N2).
   */
  private async refreshVercelNetworkPolicy(
    grantsOverride?: readonly SessionCredentialGrant[]
  ): Promise<boolean> {
    if (this.currentProvider() !== 'vercel') return true;
    try {
      const state = await this.readAllocation();
      const providerRef = state.providerRef;
      const provider = this.provider;
      if (state.kind === 'stopping' || state.kind === 'stopped') return true;
      if (providerRef === null || !provider.updateNetworkPolicy) return true;
      const policy = buildControlNetworkPolicy(
        grantsOverride ?? (await this.activeGrants(Date.now()))
      );
      await withTimeout(
        provider.updateNetworkPolicy(providerRef, policy),
        this.sandboxTimers().providerStopAttemptMs,
        'Sandbox network policy update timed out'
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fail-closed revocation path: if the released session's alias cannot be
   * removed from the provider policy, stop the sandbox as a platform failure.
   */
  private async applyVercelNetworkPolicyOrStop(reason: ControlPlaneFailureReason): Promise<void> {
    if (await this.refreshVercelNetworkPolicy()) return;
    const state = await this.readAllocation();
    if (state.kind === 'stopped' || state.kind === 'stopping') return;
    await this.applyEvent({ type: 'stop-requested', at: Date.now(), reason });
  }

  private async dispatchToWrapper(
    frame: ControlPlaneWrapperFrame
  ): Promise<ControlPlaneDispatchResult> {
    const state = await this.readAllocation();
    const socket = this.boundWrapperSocket(state);
    if (socket === null) return 'not_connected';
    return this.trySendFrame(socket, frame) ? 'sent' : 'not_connected';
  }

  /**
   * Delivery is sandbox activity (spec §6 "Activity"): move the idle clock and
   * re-arm the alarm. The allocation reducer still owns every transition; this
   * only refreshes the activity data it reads.
   */
  private async touchActivity(at: number): Promise<void> {
    const state = await this.readAllocation();
    if (state.kind !== 'connected') return;
    const next: AllocationState = { ...state, lastActivityAt: at };
    await this.writeAllocation(next);
    await this.armAlarm(next);
  }

  private async applyRouteEffects(
    previous: AllocationState,
    next: AllocationState,
    event: AllocationEvent,
    stopReason: ControlPlaneFailureReason | undefined
  ): Promise<void> {
    if (previous.allocationId !== null && previous.allocationId !== next.allocationId) {
      retireScopeGrants(this.db);
    }
    // Until the wrapper connects, the allocation is the preparation progress:
    // show creating, retrying and starting rather than one silent step.
    if (
      (next.kind === 'creating' || next.kind === 'starting' || next.kind === 'stopping') &&
      (previous.kind !== next.kind || previous.allocationId !== next.allocationId)
    ) {
      const progress = sandboxPreparationProgress(next);
      if (progress !== undefined) {
        await notifyPreparingRoutes(
          this.routeContext(next),
          previous.kind === 'creating' && next.kind === 'creating'
            ? { ...progress, detail: 'Retrying sandbox creation' }
            : progress
        );
      }
    }
    if (event.type === 'hello-accepted' && next.kind === 'connected') {
      for (const route of await listRoutes(this.db)) {
        if (route.state !== 'preparing' || route.grant !== null) continue;
        if (route.credentialSource === null) continue;
        try {
          const issued = await withTimeout(
            this.issueRouteGrant(route.spec, route.credentialSource),
            this.grantIssueTimeoutMs(),
            'Credential binding timed out'
          );
          if (!(await this.applyCandidateGrantPolicy(issued.grant)))
            throw new Error('Credential policy unavailable');
          this.publishRouteGrant({ ...route, ...issued });
        } catch {
          await failCurrentAttempt(
            this.routeContext(next),
            route.sessionId,
            route.attemptId,
            'workspace_setup_failed',
            'runtime_proxy_bind_failed'
          );
        }
      }
      const restarted = previous.wrapperId !== null && previous.wrapperId !== next.wrapperId;
      await onWrapperConnected(this.routeContext(next), restarted);
      return;
    }
    if (previous.kind === 'connected' && next.kind === 'disconnected') {
      await notifyReadyRoutes(this.routeContext(next));
      return;
    }
    if (previous.kind !== 'stopping' && next.kind === 'stopping') {
      // The reducer owns the cause; ready routes must not re-derive it.
      if (stopReason !== undefined) {
        await dropReadyRoutes(this.routeContext(next), stopReason);
        // The sandbox is already stopping; refresh best-effort.
        await this.refreshVercelNetworkPolicy();
      }
      return;
    }
    if (previous.kind !== 'stopped' && next.kind === 'stopped') {
      await this.onAllocationStopped(previous, next);
    }
  }

  private async onAllocationStopped(
    previous: AllocationState,
    next: AllocationState
  ): Promise<void> {
    const ctx = this.routeContext(next);
    retireScopeGrants(this.db);
    // `create-failed` with no retry, a confirmed stop and `provider-gone` can
    // all reach `stopped` without arming an alarm, so sweep expired routes now.
    await failExpiredRoutes(ctx);
    if (previous.kind !== 'stopping') {
      // A direct `provider-gone` keeps ready routes; they lose the sandbox.
      await dropReadyRoutes(ctx, 'sandbox_lost');
    }
    // A preparing route with attempt time left keeps its deadline across the
    // reallocation (spec §6).
    const retry = await routeRetryAllowed(ctx);
    const routes = await listRoutes(this.db);
    logControlDiagnostic('allocation_stopped', {
      allocationName: this.providerPin?.allocationName ?? this.sandboxId,
      from: previous.kind,
      unconfirmedProviderRef: next.unconfirmedProviderRef !== null,
      reallocate: retry,
      preparingRoutes: routes.filter(route => route.state === 'preparing').length,
      readyRoutes: routes.filter(route => route.state === 'ready').length,
      otherRoutes: routes.filter(route => route.state !== 'preparing' && route.state !== 'ready')
        .length,
    });
    if (retry) {
      await this.applyEvent({ type: 'ensure', at: ctx.now(), allocationId: crypto.randomUUID() });
    } else {
      await this.armAlarm(next);
    }
  }

  private forwardEvents(
    frame: Extract<ControlPlaneWrapperFrame, { type: 'session.events' }>,
    current: boolean
  ): void {
    if (!current) return;
    this.notifications.enqueue(frame.sessionId, {
      kind: 'events',
      payload: { events: frame.events },
    });
  }

  private forwardOutcome(
    frame: Extract<ControlPlaneWrapperFrame, { type: 'session.outcome' }>,
    current: boolean
  ): void {
    if (!current) return;
    const outcome: ControlPlaneOutcome = {
      sessionId: frame.sessionId,
      status: frame.status,
      ...(frame.reason === undefined ? {} : { reason: frame.reason }),
      ...(frame.assistantReason === undefined ? {} : { assistantReason: frame.assistantReason }),
      ...(frame.providerOwnership === undefined
        ? {}
        : { providerOwnership: frame.providerOwnership }),
      lastMessageId: frame.lastMessageId,
    };
    this.notifications.enqueue(outcome.sessionId, { kind: 'outcome', payload: outcome });
  }

  /**
   * Decrypts the DO-private credential-source `mcpServers` snapshot immediately
   * before an authenticated `session.prepare` frame. The plaintext never touches
   * a persisted route row. A missing key, invalid envelope or over-limit payload
   * throws so the fenced attempt fails fast (`workspace_setup_failed`) instead of
   * sending a frame the wrapper would drop while the route waits out its
   * preparation timeout.
   */
  private materializeRouteMcp(route: RouteRecord): ControlPlaneRouteSpec['mcp'] {
    const encrypted = route.credentialSource?.mcpServers;
    if (encrypted === undefined || Object.keys(encrypted).length === 0) return undefined;
    const servers = z.record(z.string().min(1).max(100), MCPServerConfigSchema).parse(encrypted);
    let materialized: Record<string, CliMcpServer>;
    try {
      materialized = materializeMcpServers(servers, this.env.AGENT_ENV_VARS_PRIVATE_KEY);
    } catch (error) {
      if (error instanceof McpConfigurationError) {
        throw new McpAttachValidationError(
          mcpValidationMessage(mcpConfigurationFailureReason(error))
        );
      }
      throw error;
    }
    const validated = parseSessionAttachMcpServers(materialized);
    if (!validated.success) throw new McpAttachValidationError(validated.reason);
    return validated.data;
  }

  private sendSessionPrepare(state: AllocationState, route: RouteRecord): void {
    const socket = this.boundWrapperSocket(state);
    if (socket === null) return;
    // A route without a grant never reaches `preparing` (issuance failure marks
    // it `failed`), so never send a spec that could carry raw issuer material.
    if (route.grant === null) return;
    let mcp: ControlPlaneRouteSpec['mcp'];
    try {
      mcp = this.materializeRouteMcp(route);
    } catch (error) {
      // Preserve the sanitized, bounded MCP reason for diagnosis; the route
      // contract has no MCP-specific reason, so the attempt fails immediately as
      // `workspace_setup_failed` rather than waiting out its deadline.
      logger
        .withFields({
          sandboxId: this.sandboxId,
          reason: error instanceof McpAttachValidationError ? error.reason : 'unknown',
        })
        .warn('MCP materialization failed before session.prepare');
      this.ctx.waitUntil(
        this.failPrepareAttempt(route.sessionId, route.attemptId).catch(() => {
          logger
            .withFields({
              sandboxId: this.sandboxId,
              sessionId: route.sessionId,
              attemptId: route.attemptId,
            })
            .warn('Could not persist MCP preparation failure');
        })
      );
      return;
    }
    if (route.grant.kilo.runtimeProxy !== undefined) {
      // R1: minting the runtime credential proxy handle is a Session DO call that
      // must stay off this DO's serial queue; the frame is sent once the handle
      // is minted and bound. A mint failure fails the attempt closed.
      this.ctx.waitUntil(
        this.sendSessionPrepareWithRuntimeProxy(route.sessionId, route.attemptId, mcp)
      );
      return;
    }
    // The frame carries the wrapper-safe spec plus the issued credential
    // material only; the credential source stays DO-private.
    this.trySendFrame(socket, {
      type: 'session.prepare',
      spec: mcp === undefined ? route.spec : { ...route.spec, mcp },
      credentials: this.prepareCredentials(route.grant, route.sessionId),
    });
  }

  private prepareCredentials(
    grant: SessionCredentialGrant,
    sessionId: string
  ): ControlPlaneSessionCredentialsPayload {
    return controlPlaneSessionCredentialsPayloadSchema.parse(
      sessionCredentialsPayloadFromGrant(grant, sessionId)
    );
  }

  /**
   * R1 runtime credential proxy: mint the handle through the Session DO (bounded
   * by the grant bound, fence passed in), bind it for Vercel, then send
   * `session.prepare`. Runs off the serial queue; a mint or bind failure fails
   * the fenced attempt as `workspace_setup_failed`.
   */
  private async sendSessionPrepareWithRuntimeProxy(
    sessionId: string,
    attemptId: string,
    mcp: ControlPlaneRouteSpec['mcp']
  ): Promise<void> {
    try {
      let route = await readRoute(this.db, sessionId);
      if (!isCurrentPreparingAttempt(route, attemptId)) return;
      if (route.grant === null || route.grant.kilo.runtimeProxy === undefined) return;
      const member = route.grant.kilo.runtimeProxy.members.find(
        candidate => candidate.sessionId === sessionId
      );
      // One owner per sandbox (B3 review 5), stored on first prepare/registration;
      // the Session DO name is `ownerId:sessionId`.
      const ownerId = await this.requireOwner();
      const peer = ownerId === null ? null : this.sessionPeerFor(ownerId, sessionId);
      const fence = this.runtimeProxyFenceFor(await this.readAllocation());
      // The fence the handle in the frame belongs to; null when we send an
      // already-bound member without a fresh mint.
      let mintedFence: ControlRuntimeCredentialProxyFence | null = null;

      if (fence === null || ownerId === null || peer === null) {
        // No allocation to mint against (or no Session peer): an existing member
        // is the only handle we have; without one the preparation cannot proceed.
        if (member === undefined) {
          await this.failPrepareAttempt(sessionId, attemptId);
          return;
        }
      } else {
        // Fence-keyed and idempotent: the same allocation/wrapper returns the same
        // persisted grant, a restart or reallocation returns a new one.
        const handle = await this.mintRuntimeProxyGrant(peer, fence);
        if (handle === null) {
          await this.failPrepareAttempt(sessionId, attemptId);
          return;
        }
        // A wrapper restart or reallocation during the mint means another task
        // owns the current fence; drop out without failing the attempt it is
        // preparing.
        const afterMint = this.runtimeProxyFenceFor(await this.readAllocation());
        if (afterMint === null || !sameRuntimeProxyControlBinding(fence, afterMint)) return;
        // A member minted under the current fence is already bound; a member from
        // a superseded fence (wrapper restart or reallocation while the route is
        // still preparing) must be replaced, or the wrapper receives a stale
        // handle the proxy cannot resolve.
        if (
          member === undefined ||
          runtimeProxyHandleGrantId(member.handle) !== runtimeProxyHandleGrantId(handle)
        ) {
          try {
            await this.bindRuntimeCredentialProxyHandle({
              ownerId,
              sessionId,
              kiloSessionId: route.spec.kiloSessionId,
              directory: route.spec.directory,
              handle,
            });
          } catch {
            await this.failPrepareAttempt(sessionId, attemptId);
            return;
          }
          // A restart during the bind supersedes this task too: do not send.
          const afterBind = this.runtimeProxyFenceFor(await this.readAllocation());
          if (afterBind === null || !sameRuntimeProxyControlBinding(fence, afterBind)) return;
          route = await readRoute(this.db, sessionId);
          if (!isCurrentPreparingAttempt(route, attemptId)) return;
          if (route.grant === null || route.grant.kilo.runtimeProxy === undefined) return;
        }
        mintedFence = fence;
      }

      // Select the socket and re-check the fence from the same allocation read, so
      // a restart between the (bind and) send cannot deliver a stale handle.
      const state = await this.readAllocation();
      const socket = this.boundWrapperSocket(state);
      if (socket === null) return;
      if (mintedFence !== null) {
        const sendFence = this.runtimeProxyFenceFor(state);
        if (sendFence === null || !sameRuntimeProxyControlBinding(mintedFence, sendFence)) return;
      }
      // The frame carries the wrapper-safe spec plus the issued credential
      // material only; the credential source stays DO-private.
      this.trySendFrame(socket, {
        type: 'session.prepare',
        spec: mcp === undefined ? route.spec : { ...route.spec, mcp },
        credentials: this.prepareCredentials(route.grant, sessionId),
      });
    } catch {
      // A throw here (read/parse/bind) must still fail the fenced attempt; the
      // failure path is itself guarded so it cannot escape this off-queue task.
      try {
        await this.failPrepareAttempt(sessionId, attemptId);
      } catch {
        // Best effort only.
      }
    }
  }

  /** Mint one runtime proxy handle for `fence`, bounded by the grant timeout. */
  private async mintRuntimeProxyGrant(
    peer: ControlPlaneSessionPeer,
    fence: ControlRuntimeCredentialProxyFence
  ): Promise<string | null> {
    try {
      return await withTimeout(
        peer.issueRuntimeCredentialProxyGrant(fence),
        this.grantIssueTimeoutMs(),
        'Runtime credential proxy grant issuance timed out'
      );
    } catch {
      return null;
    }
  }

  /** The current allocation's runtime credential proxy fence, or null. */
  private runtimeProxyFenceFor(state: AllocationState): ControlRuntimeCredentialProxyFence | null {
    const { allocationId, connectionId, providerRef, wrapperId } = state;
    if (
      (state.kind !== 'connected' && state.kind !== 'disconnected') ||
      allocationId === null ||
      connectionId === null ||
      providerRef === null ||
      wrapperId === null
    ) {
      return null;
    }
    return {
      plane: 'control',
      allocationId,
      providerInstanceId: providerRef,
      connectionId,
      wrapperInstanceId: wrapperId,
    };
  }

  /** Fail one preparation attempt, fenced by attempt id (late mint failure). */
  private async failPrepareAttempt(sessionId: string, attemptId: string): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.readAllocation();
      await failCurrentAttempt(
        this.routeContext(state),
        sessionId,
        attemptId,
        'workspace_setup_failed',
        'prepare_dispatch_failed'
      );
    });
  }

  private async notifySession(
    sessionId: string,
    notification: SandboxNotification,
    deadlineAt: number,
    signal: AbortSignal
  ): Promise<void> {
    // One owner per sandbox (B3 review 5), stored on first prepare/registration.
    // The Session DO name is `ownerId:sessionId`, so resolve that stored owner
    // here rather than the bare session id.
    const ownerId = await this.requireOwner();
    if (Date.now() >= deadlineAt || signal.aborted) throw new Error('Notification expired');
    if (ownerId === null) throw new Error('Notification owner unavailable');
    const peer = this.sessionPeerFor(ownerId, sessionId);
    if (peer === null) throw new Error('Notification peer unavailable');
    await withDORetry(
      () => this.sessionPeerFor(ownerId, sessionId) ?? peer,
      target => {
        switch (notification.kind) {
          case 'events':
            return target.onEvents(notification.payload);
          case 'route':
            return target.onRoute(notification.payload);
          case 'outcome':
            return target.onOutcome(notification.payload);
        }
      },
      `notification.${notification.kind}`,
      {
        ...DEFAULT_DO_RETRY_CONFIG,
        scope: { deadlineAt, signal },
      }
    );
  }

  private resolveSessionPeer(ownerId: string, sessionId: string): ControlPlaneSessionPeer | null {
    const namespace = sandboxSessionPeerNamespace<ControlPlaneSessionPeer>(this.env);
    return namespace === undefined ? null : namespace.getByName(sessionDoName(ownerId, sessionId));
  }

  private boundWrapperSocket(state: AllocationState): WebSocket | null {
    if (state.kind !== 'connected' || state.allocationId === null || state.connectionId === null) {
      return null;
    }
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.readAttachment(ws);
      if (
        attachment?.allocationId === state.allocationId &&
        attachment.connectionId === state.connectionId
      ) {
        return ws;
      }
    }
    return null;
  }

  private trySendFrame(ws: WebSocket, frame: ControlPlaneWrapperFrame): boolean {
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private async runEffect(effect: AllocationEffect, state: AllocationState): Promise<void> {
    switch (effect.type) {
      case 'create':
        if (this.createInFlight) return;
        // H3: the provider call runs off the serialized queue; its result
        // re-enters through applyEvent fenced on allocationId.
        this.ctx.waitUntil(this.runCreate(effect.allocationId));
        return;
      case 'stop':
        this.ctx.waitUntil(this.runStop(effect.stopAttempt));
        return;
      case 'lease':
        this.ctx.waitUntil(this.runLease());
        return;
      case 'close-socket':
        await this.runCloseSocket(state);
        return;
    }
  }

  private async runCreate(allocationId: string): Promise<void> {
    this.createInFlight = true;
    try {
      const state = await this.readAllocation();
      if (state.kind !== 'creating' || state.allocationId !== allocationId) return;
      let createdRef: string | null = null;
      try {
        const credential = generateSandboxCredential();
        await this.ctx.storage.put(CREDENTIAL_HASH_KEY, await hashSandboxCredential(credential));
        const launchEnv = await this.wrapperLaunchEnv(credential, allocationId);
        const pin = this.providerPin ?? this.defaultPin('cloudflare');
        const createDeadline =
          state.createDeadlineAt ?? Date.now() + this.sandboxTimers().providerCreateMs;
        if (pin.provider === 'vercel') {
          let admission: 'admitted' | 'blocked' | 'unavailable' | 'retry' = 'retry';
          let admissionRejected = false;
          let priorGeneration: string | undefined;
          let admissionStarted = false;
          try {
            priorGeneration = (await getBillingContext(this.ctx.storage))?.generation;
            admissionStarted = true;
            admission = await withTimeout(
              this.admitVercelCreate(pin).catch((error: unknown) => {
                admissionRejected = true;
                throw error;
              }),
              Math.min(remainingMs(createDeadline), this.sandboxTimers().providerStopAttemptMs),
              'Vercel billing admission timed out'
            );
          } catch {
            let safeShadow = false;
            if (priorGeneration === undefined) {
              try {
                safeShadow = await this.admitShadowAfterVercelBillingException(pin);
              } catch {
                safeShadow = false;
              }
            }
            admission = safeShadow
              ? 'admitted'
              : admissionStarted && !admissionRejected
                ? 'retry'
                : 'unavailable';
            logger
              .withFields({ sandboxId: this.sandboxId })
              .warn('Vercel billing admission failed');
          }
          if (admission !== 'admitted') {
            await this.failCreationRoutes(
              allocationId,
              admission === 'retry',
              admission === 'blocked' ? 'billing_blocked' : 'billing_unavailable'
            );
            return;
          }
        }
        const intent: ProviderCreateIntent = {
          intentId: allocationId,
          createdAt: Date.now(),
          allocationName: pin.allocationName ?? this.sandboxId,
          containment: this.resolvedContainment(),
          ...(pin.billing === null ? {} : { billing: pin.billing }),
          ...(pin.provider === 'vercel'
            ? { networkPolicy: buildControlNetworkPolicy(await this.activeGrants(Date.now())) }
            : {}),
        };
        // N2: create and launch share one bound (the create deadline).
        const created = await withTimeout(
          this.provider.create(intent),
          remainingMs(createDeadline),
          'Sandbox create timed out'
        );
        if ('unresolved' in created) {
          await this.dispatchCreateFailed(allocationId);
          return;
        }
        // N4: persist the ref before launch so an accepted `hello` never sees null.
        createdRef = created.providerRef;
        if (pin.provider === 'cloudflare' || pin.provider === 'cloudflare-containers') {
          try {
            const containerInstanceId =
              pin.provider === 'cloudflare-containers'
                ? this.env.SANDBOX_CONTAINERS.idFromName(this.sandboxId).toString()
                : getOutboundContainerId(this.env, intent.allocationName ?? this.sandboxId, {
                    managedScmContainment: this.credentialContainmentEnabled(),
                  });
            logControlDiagnostic('container_launch_identity', {
              sandboxId: this.sandboxId,
              allocationId,
              allocationName: intent.allocationName,
              provider: pin.provider,
              containerInstanceId,
            });
          } catch {
            // Observability cannot turn a successful provider create into a failed allocation.
          }
        }
        await this.dispatchResult({
          type: 'provider-ref',
          at: Date.now(),
          allocationId,
          providerRef: createdRef,
        });
        const current = await this.readAllocation();
        if (current.kind !== 'creating' || current.allocationId !== allocationId) {
          const confirmed = await this.stopRef(createdRef, allocationId);
          if (pin.provider === 'vercel')
            await this.settleStoppedCreatedVercelRef(createdRef, confirmed);
          return;
        }
        const launchDeadline = current.createDeadlineAt ?? createDeadline;
        await withTimeout(
          this.provider.launch(createdRef, launchEnv),
          remainingMs(launchDeadline),
          'Sandbox launch timed out'
        );
        await this.dispatchResult({
          type: 'created',
          at: Date.now(),
          allocationId,
          providerRef: createdRef,
        });
      } catch (error) {
        logControlDiagnostic(
          'create_failed',
          {
            allocationName: this.providerPin?.allocationName ?? this.sandboxId,
            stage: createdRef === null ? 'create' : 'launch',
            permanentReason:
              error instanceof ProviderCreationError ? (error.permanentReason ?? 'none') : 'none',
            errorName: error instanceof Error ? diagnosticCause(error.name) : 'unknown',
            cause: error instanceof Error ? diagnosticCause(error.message) : 'unknown',
          },
          'warn'
        );
        if (error instanceof ProviderCreationError && error.permanentReason !== null) {
          await this.failCreationRoutes(allocationId, false, error.permanentReason);
          return;
        }
        // N5: only clean up a container the reducer still owns. If a `hello`
        // was accepted during a slow launch, the sandbox has an owner and must
        // not be destroyed here.
        if (createdRef !== null) {
          const latest = await this.readAllocation();
          if (latest.kind === 'creating' && latest.allocationId === allocationId) {
            const confirmed = await this.stopRef(createdRef, allocationId);
            if (this.currentProvider() === 'vercel')
              await this.settleStoppedCreatedVercelRef(createdRef, confirmed);
          }
        }
        await this.dispatchCreateFailed(allocationId);
      }
    } finally {
      this.createInFlight = false;
    }
  }

  private async dispatchCreateFailed(allocationId: string): Promise<void> {
    await this.dispatchResult({
      type: 'create-failed',
      at: Date.now(),
      allocationId,
      nextAllocationId: crypto.randomUUID(),
      retryAllowed: await this.retryAllowed(),
    });
  }

  private async stopRef(ref: string, allocationId: string | null): Promise<boolean> {
    const result = await withTimeout(
      this.provider.stop(ref, null),
      this.sandboxTimers().providerStopAttemptMs,
      'Sandbox cleanup stop timed out'
    ).catch(() => 'retryable' as const);
    logControlDiagnostic('stop_origin', {
      origin: 'cleanup',
      allocationName: this.providerPin?.allocationName ?? this.sandboxId,
      allocationId,
      result,
    });
    return result === 'terminal';
  }

  private async settleStoppedCreatedVercelRef(ref: string, confirmed: boolean): Promise<void> {
    const context = await getBillingContext(this.ctx.storage);
    if (context === undefined) return;
    const binding = await loadVercelBillingBinding(this.ctx.storage, context.generation);
    if (binding?.providerRef !== ref) return;
    if (!confirmed && binding.terminalAtMs === undefined) {
      const allocation = await this.readAllocation();
      await this.billingSchedule.schedule(
        VERCEL_BILLING_SETTLEMENT_CALLBACK,
        Date.now() +
          (allocation.kind === 'stopped'
            ? DEFAULT_BILLING_HEARTBEAT_SECONDS * 1_000
            : VERCEL_BILLING_DELIVERY_RETRY_MS),
        context.generation
      );
      return;
    }
    const terminalAtMs =
      binding.terminalAtMs ?? Math.max(binding.createdAtMs, context.usageMeasuredAtMs);
    if (binding.terminalAtMs === undefined) {
      await saveVercelBillingBinding(this.ctx.storage, { ...binding, terminalAtMs });
    }
    await (
      await this.ensureVercelBillingRuntime()
    )?.heartbeat.persistStop({ reason: 'runtime_signal' }, terminalAtMs);
    await this.prepareVercelSettlement(context.generation);
  }

  private async runStop(stopAttempt: number): Promise<void> {
    const state = await this.readAllocation();
    if (state.kind !== 'stopping' || state.stopAttempt !== stopAttempt || state.stopPending) return;
    const pin = this.providerPin ?? this.defaultPin('cloudflare');
    const intent: ProviderAllocationIntent = {
      intentId: state.allocationId ?? '',
      createdAt: Date.now(),
      allocationName: pin.allocationName ?? this.sandboxId,
    };
    let confirmed = false;
    try {
      const result = await withTimeout(
        this.provider.stop(state.providerRef, intent),
        this.sandboxTimers().providerStopAttemptMs,
        'Sandbox stop timed out'
      );
      confirmed = result === 'terminal';
    } catch {
      confirmed = false;
    }
    logControlDiagnostic('stop_origin', {
      origin: 'ladder',
      allocationName: pin.allocationName ?? this.sandboxId,
      allocationId: state.allocationId,
      stopAttempt,
      confirmed,
    });
    await this.dispatchResult({
      type: 'stop-result',
      at: Date.now(),
      allocationId: state.allocationId,
      stopAttempt,
      confirmed,
    });
  }

  /**
   * B10 deletion stop: a bounded provider stop that reports whether the
   * provider confirmed a terminal stop. Runs outside the serial queue.
   */
  private async stopProviderConfirmed(
    providerRef: string | null,
    allocationId: string | null
  ): Promise<boolean> {
    const pin = this.providerPin ?? this.defaultPin('cloudflare');
    const intent: ProviderAllocationIntent = {
      intentId: allocationId ?? '',
      createdAt: Date.now(),
      allocationName: pin.allocationName ?? this.sandboxId,
    };
    try {
      return (
        (await withTimeout(
          this.provider.stop(providerRef, intent),
          this.sandboxTimers().providerStopAttemptMs,
          'Worktree deletion stop timed out'
        )) === 'terminal'
      );
    } catch {
      return false;
    }
  }

  private async revokeWorktreeRoutes(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      this.notifications.retire(sessionId);
      await deleteRoute(this.db, sessionId);
    }
  }

  private async observeWorktreeRuntime(
    providerRef: string | null
  ): Promise<{ status: 'active' | 'terminal' | 'unknown' }> {
    try {
      return await withTimeout(
        this.provider.observe(providerRef),
        this.sandboxTimers().providerStopAttemptMs,
        'Worktree runtime observation timed out'
      );
    } catch {
      return { status: 'unknown' };
    }
  }

  private async runLease(): Promise<void> {
    const state = await this.readAllocation();
    if (state.kind !== 'connected' || state.providerRef === null) return;
    await withTimeout(
      this.provider.ensureLeaseAtLeast(state.providerRef, this.sandboxTimers().providerLeaseMs),
      this.sandboxTimers().providerStopAttemptMs,
      'Sandbox lease renewal timed out'
    ).catch(() => undefined);
  }

  private async runCloseSocket(state: AllocationState): Promise<void> {
    if (state.allocationId === null || state.connectionId === null) return;
    await this.applyEvent({
      type: 'socket-closed',
      at: Date.now(),
      allocationId: state.allocationId,
      connectionId: state.connectionId,
      origin: 'heartbeat_timeout',
    });
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.readAttachment(ws);
      if (
        attachment?.allocationId === state.allocationId &&
        attachment.connectionId === state.connectionId
      ) {
        // A server-side close drops the wrapper without a `webSocketClose`, so
        // settle its outstanding control requests here instead of waiting out
        // the full request timeout.
        this.settlePendingForSocket(
          ws,
          controlRequestFailure('not_ready', 'Wrapper disconnected', true)
        );
        ws.serializeAttachment({ credential: attachment.credential ?? null });
        try {
          ws.close(1000, 'heartbeat timeout');
        } catch {
          // Socket already closed.
        }
      }
    }
  }

  private async dispatchResult(event: AllocationEvent): Promise<void> {
    await this.enqueue(() => this.applyEvent(event));
  }

  // --- wrapper socket ---------------------------------------------------------

  private readAttachment(ws: WebSocket): WrapperSocketAttachment | null {
    const parsed = wrapperSocketAttachmentSchema.safeParse(ws.deserializeAttachment());
    return parsed.success ? parsed.data : null;
  }

  private earliestHelloDeadlineAt(): number | null {
    let earliest: number | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const deadline = this.readAttachment(ws)?.helloDeadlineAt;
      if (ws.readyState === WebSocket.OPEN && deadline !== undefined) {
        earliest = Math.min(earliest ?? Infinity, deadline);
      }
    }
    return earliest;
  }

  private expireUnboundSockets(now: number): void {
    for (const ws of this.ctx.getWebSockets()) {
      const deadline = this.readAttachment(ws)?.helloDeadlineAt;
      if (deadline !== undefined && deadline <= now) {
        ws.serializeAttachment({ credential: null });
        ws.close(1008, 'Hello timeout');
      }
    }
  }

  private async handleFrame(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return;
    const deadline = this.readAttachment(ws)?.helloDeadlineAt;
    if (deadline !== undefined && deadline <= Date.now()) {
      this.expireUnboundSockets(Date.now());
      await this.armAlarm(await this.readAllocation());
      return;
    }
    let parsedMessage: unknown;
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      parsedMessage = JSON.parse(text);
    } catch {
      return;
    }
    if (isLegacyWrapperFrame(parsedMessage)) {
      ws.close(1008, 'Unsupported protocol');
      return;
    }
    if (
      isRecord(parsedMessage) &&
      parsedMessage.type === 'hello' &&
      parsedMessage.protocolVersion !== CONTROL_PLANE_PROTOCOL_VERSION
    ) {
      this.sendFrame(ws, { type: 'shutdown', reason: 'unsupported_protocol_version' });
      ws.close(1008, 'Unsupported protocol');
      return;
    }
    const result = controlPlaneWrapperFrameSchema.safeParse(parsedMessage);
    if (!result.success) return;
    const frame = result.data;
    const attachment = this.readAttachment(ws);

    if (frame.type === 'hello') {
      if (attachment?.connectionId !== undefined) return;
      const credential = typeof attachment?.credential === 'string' ? attachment.credential : null;
      const accepted = await this.validateAllocationCredential(frame.allocationId, credential);
      if (!accepted) {
        this.sendFrame(ws, { type: 'shutdown', reason: 'hello_rejected' });
        ws.close(1008, 'shutdown');
        return;
      }
      const connectionId = crypto.randomUUID();
      this.releaseBoundSockets(ws, frame.allocationId);
      ws.serializeAttachment({
        credential,
        allocationId: frame.allocationId,
        connectionId,
        wrapperId: frame.wrapperId,
        ...(frame.heartbeatAck ? { heartbeatAck: true } : {}),
      });
      // Welcome first, then route effects: a re-prepared route resends
      // `session.prepare`, which must not arrive before the welcome.
      this.sendFrame(ws, {
        type: 'welcome',
        protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        ...(frame.heartbeatAck ? { heartbeatAck: true } : {}),
      });
      await this.applyEvent({
        type: 'hello-accepted',
        at: Date.now(),
        allocationId: frame.allocationId,
        connectionId,
        wrapperId: frame.wrapperId,
      });
      return;
    }

    // Frames from an unbound or superseded socket are ignored: a heartbeat
    // before `hello`, or a late frame from a replaced connection, cannot move
    // the allocation.
    if (
      attachment?.allocationId === undefined ||
      attachment.connectionId === undefined ||
      attachment.wrapperId === undefined
    ) {
      return;
    }

    if (frame.type === 'heartbeat') {
      if (
        !connectionMatches(
          await this.readAllocation(),
          attachment.allocationId,
          attachment.connectionId
        )
      )
        return;
      await this.applyEvent({
        type: 'heartbeat',
        at: Date.now(),
        allocationId: attachment.allocationId,
        connectionId: attachment.connectionId,
        active: frame.active,
      });
      if (
        attachment.heartbeatAck &&
        connectionMatches(
          await this.readAllocation(),
          attachment.allocationId,
          attachment.connectionId
        ) &&
        ws.readyState === WebSocket.OPEN &&
        this.readAttachment(ws)?.connectionId === attachment.connectionId
      ) {
        this.sendFrame(ws, { type: 'heartbeat_ack' });
      }
      return;
    }

    // Every other frame means only that the socket is alive; the heartbeat
    // persists that liveness. Session frames also drive routes and are forwarded
    // to the session.
    // A superseded socket can stay open (the DO does not close it on
    // `stopping`), so only the current connection may move a route or forward.
    const currentState = await this.readAllocation();
    const current = connectionMatches(
      currentState,
      attachment.allocationId,
      attachment.connectionId
    );
    const ctx = this.routeContext(currentState);
    switch (frame.type) {
      case 'session.progress':
        await onRouteProgress(
          ctx,
          frame.sessionId,
          {
            step: frame.step,
            ...(frame.detail === undefined ? {} : { detail: frame.detail }),
          },
          current
        );
        return;
      case 'session.ready':
        await onRouteReady(ctx, frame.sessionId, current);
        return;
      case 'session.failed':
        logger
          .withFields({
            sessionId: frame.sessionId,
            step: frame.step ?? 'unknown',
            reason: frame.reason,
            ...(frame.subtype === undefined ? {} : { subtype: frame.subtype }),
          })
          .warn('Control-plane prepare failed');
        await onRouteFailed(ctx, frame.sessionId, frame.reason, frame.subtype, current);
        return;
      case 'session.events':
        this.forwardEvents(frame, current);
        return;
      case 'session.outcome':
        this.forwardOutcome(frame, current);
        return;
      case 'events_dropped':
        if (current) this.notifications.wrapperDropped(frame.dropped);
        return;
      default:
        return;
    }
  }

  private releaseBoundSockets(ws: WebSocket, allocationId: string): void {
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const attachment = this.readAttachment(other);
      if (attachment?.allocationId !== allocationId || attachment.connectionId === undefined)
        continue;
      // A replaced wrapper is about to be closed by `other.close`; settle its
      // outstanding control requests now (the close handler may not run).
      this.settlePendingForSocket(
        other,
        controlRequestFailure('not_ready', 'Wrapper disconnected', true)
      );
      // The attachment stays: the connectionId fence, not the cleared binding,
      // is what stops a replaced socket's late close from disconnecting.
      try {
        other.close(1000, 'replaced');
      } catch {
        // Socket already closed.
      }
    }
  }

  private async validateAllocationCredential(
    allocationId: string,
    credential: string | null
  ): Promise<boolean> {
    const state = await this.readAllocation();
    const admission = {
      allocationName: this.providerPin?.allocationName ?? this.sandboxId,
      allocationKind: state.kind,
      expectedAllocationId: state.allocationId,
      receivedAllocationId: allocationId,
      credentialPresent: credential !== null,
    };
    const reject = (reason: string, extra: ControlDiagnosticFields = {}): boolean => {
      logControlDiagnostic('hello_admission', { ...admission, accepted: false, reason, ...extra });
      return false;
    };
    if (state.kind === 'stopped' || state.kind === 'stopping') {
      return reject(`allocation_${state.kind}`);
    }
    if (state.allocationId === null || allocationId !== state.allocationId) {
      return reject('allocation_mismatch');
    }
    if (credential === null) return reject('missing_credential');
    const storedHash = await this.ctx.storage.get<string>(CREDENTIAL_HASH_KEY);
    if (typeof storedHash !== 'string' || storedHash.length === 0) {
      return reject('missing_credential_hash', { credentialHashPresent: false });
    }
    if (!(await sandboxCredentialMatchesHash(credential, storedHash))) {
      return reject('credential_mismatch', { credentialHashPresent: true });
    }
    logControlDiagnostic('hello_admission', { ...admission, accepted: true, reason: 'accepted' });
    return true;
  }

  private sendFrame(ws: WebSocket, frame: ControlPlaneWrapperFrame): void {
    this.trySendFrame(ws, frame);
  }

  private async wrapperLaunchEnv(
    credential: string,
    allocationId: string
  ): Promise<Record<string, string>> {
    const signingSecret = await withTimeout(
      resolveSecret(this.env.NEXTAUTH_SECRET),
      1_000,
      'Wrapper launch signing secret lookup timed out'
    ).catch(() => null);
    if (!signingSecret) throw new Error('Wrapper launch signing unavailable');
    const launchCredential = mintSandboxLaunchCredential(
      { sandboxId: this.sandboxId, allocationId, credential },
      signingSecret
    );
    const workloadCgroup = (this.env as { CONTROL_WORKLOAD_CGROUP?: unknown })
      .CONTROL_WORKLOAD_CGROUP;
    return {
      ...buildControlWrapperLaunchEnv({
        workerUrl: this.env.WORKER_URL,
        sandboxId: this.sandboxId,
        credential: launchCredential,
        diagnostics: { allocationId, signingSecret },
        ...(typeof workloadCgroup === 'string' ? { workloadCgroup } : {}),
      }),
      [CONTROL_PLANE_ALLOCATION_ID_ENV]: allocationId,
    };
  }

  private async admitVercelCreate(
    pin: StoredProviderPin
  ): Promise<'admitted' | 'blocked' | 'unavailable' | 'retry'> {
    const existing = await getBillingContext(this.ctx.storage);
    if (existing !== undefined) {
      await this.billingSchedule.ensure(
        VERCEL_BILLING_SETTLEMENT_CALLBACK,
        Date.now() + DEFAULT_BILLING_HEARTBEAT_SECONDS * 1_000,
        existing.generation
      );
      await this.prepareVercelSettlement(existing.generation);
      return 'retry';
    }
    const billing = pin.billing;
    const owner = await this.requireOwner();
    if (billing === null) {
      return owner !== null && !isCloudAgentContainerBillingEnabled(this.env, { userId: owner })
        ? 'admitted'
        : 'unavailable';
    }
    if (billing.sandboxId !== this.sandboxId) return 'unavailable';
    if (
      owner === null ||
      (billing.subject.type === 'user' && billing.subject.id !== owner) ||
      (billing.actor.type === 'user' && billing.actor.id !== owner)
    )
      return 'unavailable';
    const enforced =
      billing.enforcementRequested === true ||
      isCloudAgentContainerBillingEnabled(this.env, {
        userId: owner,
        ...(billing.subject.type === 'org' ? { orgId: billing.subject.id } : {}),
      });
    const runtime = await this.ensureVercelBillingRuntime();
    if (runtime?.identity === undefined) return 'unavailable';
    try {
      assertSandboxBillingAllocation(runtime.identity.sandboxClassName, billing);
    } catch {
      return 'unavailable';
    }
    const outcome = await runtime.lifecycle.openIntervalBeforeCreate(runtime.identity, {
      ...billing,
      enforcementRequested: enforced,
    });
    await this.billingSchedule.ensure(
      VERCEL_BILLING_SETTLEMENT_CALLBACK,
      Date.now() + DEFAULT_BILLING_HEARTBEAT_SECONDS * 1_000,
      outcome.generation
    );
    if (outcome.kind === 'acked') return 'admitted';
    if (outcome.kind === 'definite_rejection') {
      await clearBillingContext(this.ctx.storage);
      await deleteVercelBillingBinding(this.ctx.storage, outcome.generation);
      await this.billingSchedule.remove(VERCEL_BILLING_SETTLEMENT_CALLBACK, outcome.generation);
      return enforced &&
        outcome.error instanceof ContainerUsageAdmissionError &&
        outcome.error.code === 'insufficient_credits'
        ? 'blocked'
        : enforced
          ? 'unavailable'
          : 'admitted';
    }
    if (!enforced) return 'admitted';
    await this.prepareVercelSettlement(outcome.generation);
    return 'retry';
  }

  private async admitShadowAfterVercelBillingException(pin: StoredProviderPin): Promise<boolean> {
    const billing = pin.billing;
    const owner = await this.requireOwner();
    const resources =
      pin.configuration?.provider === 'vercel' ? pin.configuration.resources : undefined;
    if (
      billing === null ||
      owner === null ||
      resources === undefined ||
      billing.enforcementRequested ||
      billing.sandboxId !== this.sandboxId ||
      (billing.subject.type === 'user' && billing.subject.id !== owner) ||
      (billing.actor.type === 'user' && billing.actor.id !== owner) ||
      isCloudAgentContainerBillingEnabled(this.env, {
        userId: owner,
        ...(billing.subject.type === 'org' ? { orgId: billing.subject.id } : {}),
      })
    )
      return false;
    let identity: VercelBillingIdentity;
    try {
      identity = vercelBillingIdentity(resources);
      assertSandboxBillingAllocation(identity.className, billing);
    } catch {
      return false;
    }
    const context = await getBillingContext(this.ctx.storage);
    if (
      context === undefined ||
      context.pendingStop !== undefined ||
      context.measurementStarted ||
      context.instanceId !== this.sandboxId ||
      context.service !== identity.service ||
      context.sku !== identity.sku ||
      context.subject.type !== billing.subject.type ||
      context.subject.id !== billing.subject.id ||
      context.actor.type !== billing.actor.type ||
      context.actor.id !== billing.actor.id ||
      (await loadVercelBillingBinding(this.ctx.storage, context.generation)) !== undefined
    )
      return false;
    await this.billingSchedule.ensure(
      VERCEL_BILLING_SETTLEMENT_CALLBACK,
      Date.now() + DEFAULT_BILLING_HEARTBEAT_SECONDS * 1_000,
      context.generation
    );
    return true;
  }

  private async failCreationRoutes(
    allocationId: string,
    retryable: boolean,
    reason: ControlPlaneFailureReason
  ): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.readAllocation();
      if (state.kind !== 'creating' || state.allocationId !== allocationId) return;
      if (!retryable) {
        for (const route of await listRoutes(this.db)) {
          if (route.state === 'preparing') {
            await failCurrentAttempt(
              this.routeContext(state),
              route.sessionId,
              route.attemptId,
              reason,
              'create_failed'
            );
          }
        }
        if (state.providerRef !== null) {
          await this.applyEvent({ type: 'stop-requested', at: Date.now(), reason });
          return;
        }
      }
      await this.applyEvent({
        type: 'create-failed',
        at: Date.now(),
        allocationId,
        nextAllocationId: crypto.randomUUID(),
        retryAllowed: retryable && (await this.retryAllowed()),
      });
    });
  }

  private async recordVercelBillingLifetime(evidence: {
    providerRef: string;
    createdAtMs?: number;
    terminalAtMs?: number;
  }): Promise<void> {
    const context = await getBillingContext(this.ctx.storage);
    if (context === undefined) return;
    const existing = await loadVercelBillingBinding(this.ctx.storage, context.generation);
    if (existing !== undefined && existing.providerRef !== evidence.providerRef) return;
    const allocation = await this.readAllocation();
    if (allocation.providerRef !== null) {
      if (allocation.providerRef !== evidence.providerRef) return;
    } else {
      if (
        allocation.kind === 'stopped' ||
        existing !== undefined ||
        evidence.createdAtMs === undefined
      )
        return;
      const decoded = decodeVercelProviderRef(evidence.providerRef);
      if (decoded?.sandboxName !== (this.providerPin?.allocationName ?? this.sandboxId)) return;
    }
    const createdAtMs = evidence.createdAtMs ?? existing?.createdAtMs;
    if (createdAtMs === undefined) return;
    const terminalAtMs = evidence.terminalAtMs ?? existing?.terminalAtMs;
    if (existing?.createdAtMs === createdAtMs && existing.terminalAtMs === terminalAtMs) return;
    await saveVercelBillingBinding(this.ctx.storage, {
      generation: context.generation,
      providerRef: evidence.providerRef,
      createdAtMs,
      ...(terminalAtMs === undefined ? {} : { terminalAtMs }),
    });
    if (terminalAtMs !== undefined) await this.prepareVercelSettlement(context.generation);
  }

  private async afterVercelBillingTransition(event: AllocationEvent): Promise<void> {
    const context = await getBillingContext(this.ctx.storage);
    if (context === undefined) return;
    const binding = await loadVercelBillingBinding(this.ctx.storage, context.generation);
    const state = await this.readAllocation();
    if (
      state.kind === 'stopped' &&
      binding !== undefined &&
      binding.terminalAtMs === undefined &&
      !context.pendingStop &&
      event.type !== 'provider-gone' &&
      !(event.type === 'stop-result' && event.confirmed)
    ) {
      await this.billingSchedule.schedule(
        VERCEL_BILLING_SETTLEMENT_CALLBACK,
        Date.now() + VERCEL_BILLING_DELIVERY_RETRY_MS,
        context.generation
      );
      return;
    }
    if (state.kind === 'stopped' && !context.pendingStop) {
      await (
        await this.ensureVercelBillingRuntime()
      )?.heartbeat.persistStop(
        { reason: 'runtime_signal' },
        binding?.terminalAtMs ?? context.usageMeasuredAtMs
      );
    }
    if (context.pendingStop || binding?.terminalAtMs !== undefined || state.kind === 'stopped') {
      await this.prepareVercelSettlement(context.generation);
    } else if (
      binding !== undefined &&
      !context.measurementStarted &&
      (state.kind === 'starting' || state.kind === 'connected' || state.kind === 'disconnected')
    ) {
      await (
        await this.ensureVercelBillingRuntime()
      )?.lifecycle.pinMeasurementCursor(context.generation, binding.createdAtMs);
    }
  }

  private async prepareVercelSettlement(generation: string): Promise<void> {
    const runtime = await this.ensureVercelBillingRuntime();
    if (runtime === undefined) return;
    await runtime.billing.prepareSettlement({ generation });
  }

  private async runBillingAlarm(): Promise<void> {
    for (const entry of await this.billingSchedule.dueEntries()) {
      const generation = typeof entry.payload === 'string' ? entry.payload : null;
      if (generation === null) {
        await this.billingSchedule.completeDue(entry);
        continue;
      }
      const context = await getBillingContext(this.ctx.storage);
      if (context?.generation !== generation) {
        await this.billingSchedule.completeDue(entry);
        await deleteVercelBillingBinding(this.ctx.storage, generation);
        continue;
      }
      const runtime = await this.ensureVercelBillingRuntime();
      if (runtime === undefined) {
        await this.deferVercelBilling(generation, entry.callback);
        continue;
      }
      if (entry.callback === VERCEL_BILLING_FORCE_STOP_CALLBACK) {
        if (runtime.identity === undefined) {
          await this.deferVercelBilling(generation, entry.callback);
          continue;
        }
        try {
          await runtime.lifecycle.billingForceStop(runtime.identity, generation);
          if ((await this.readAllocation()).kind === 'stopped') {
            await this.billingSchedule.completeDue(entry);
          } else {
            await this.deferVercelBilling(generation, entry.callback);
          }
        } catch {
          await this.deferVercelBilling(generation, entry.callback);
        }
        continue;
      }
      if (entry.callback !== VERCEL_BILLING_SETTLEMENT_CALLBACK) {
        await this.billingSchedule.completeDue(entry);
        continue;
      }
      const binding = await loadVercelBillingBinding(this.ctx.storage, generation);
      const state = await this.readAllocation();
      if (
        (state.kind === 'stopped' || (state.kind === 'creating' && !this.createInFlight)) &&
        binding !== undefined &&
        binding.terminalAtMs === undefined &&
        !context.pendingStop
      ) {
        const observation = await withTimeout(
          this.provider.observe(binding.providerRef),
          this.sandboxTimers().providerStopAttemptMs,
          'Sandbox billing cleanup observation timed out'
        ).catch(() => ({ status: 'unknown' as const }));
        const confirmed =
          observation.status === 'terminal' ||
          (await this.stopRef(binding.providerRef, state.allocationId));
        await this.settleStoppedCreatedVercelRef(binding.providerRef, confirmed);
        if (
          !confirmed &&
          Date.now() >= context.startEpochMs + this.sandboxTimers().providerCreateMs
        ) {
          for (const route of await listRoutes(this.db)) {
            if (route.state === 'preparing') {
              await failCurrentAttempt(
                this.routeContext(state),
                route.sessionId,
                route.attemptId,
                'sandbox_lost',
                'cleanup_unconfirmed'
              );
            }
          }
          if (state.kind === 'creating' && state.allocationId !== null) {
            await this.applyEvent({
              type: 'create-failed',
              at: Date.now(),
              allocationId: state.allocationId,
              nextAllocationId: crypto.randomUUID(),
              retryAllowed: false,
            });
          }
        }
        continue;
      }
      if (
        context.pendingStop ||
        binding?.terminalAtMs !== undefined ||
        state.kind === 'stopped' ||
        (state.kind === 'creating' &&
          !this.createInFlight &&
          binding === undefined &&
          !context.measurementStarted)
      ) {
        if (this.vercelDeliveriesInFlight.has(generation)) {
          await this.deferVercelBilling(generation, entry.callback);
          continue;
        }
        this.vercelDeliveriesInFlight.add(generation);
        await this.deferVercelBilling(generation, entry.callback);
        this.ctx.waitUntil(
          runtime.billing
            .deliverSettlement(generation)
            .catch(() => this.deferVercelBilling(generation, entry.callback))
            .finally(() => this.vercelDeliveriesInFlight.delete(generation))
        );
      } else if (!context.measurementStarted) {
        await this.billingSchedule.schedule(
          entry.callback,
          Date.now() + DEFAULT_BILLING_HEARTBEAT_SECONDS * 1_000,
          generation
        );
      } else {
        try {
          await runtime.heartbeat.billingHeartbeatTick(generation);
        } catch {
          await this.deferVercelBilling(generation, entry.callback);
        }
      }
    }
  }

  private async deferVercelBilling(generation: string, callback: string): Promise<void> {
    await this.billingSchedule.deferRetry(
      callback,
      generation,
      Date.now() + VERCEL_BILLING_DELIVERY_RETRY_MS
    );
  }

  private async ensureVercelBillingRuntime(): Promise<typeof this.vercelBilling> {
    if (
      this.vercelBilling !== undefined &&
      (await getBillingContext(this.ctx.storage)) === undefined
    ) {
      const resources =
        this.providerPin?.configuration?.provider === 'vercel'
          ? this.providerPin.configuration.resources
          : undefined;
      const className =
        resources === undefined ? undefined : vercelBillingIdentity(resources).className;
      if (this.vercelBilling.identity?.sandboxClassName !== className)
        this.vercelBilling = undefined;
    }
    if (this.vercelBilling !== undefined) return this.vercelBilling;
    if (this.vercelBillingBuild !== undefined) {
      await this.vercelBillingBuild;
      return this.vercelBilling;
    }
    const build = this.buildVercelBillingRuntime();
    this.vercelBillingBuild = build;
    try {
      await build;
    } finally {
      if (this.vercelBillingBuild === build) this.vercelBillingBuild = undefined;
    }
    return this.vercelBilling;
  }

  private async buildVercelBillingRuntime(): Promise<void> {
    const resources =
      this.providerPin?.configuration?.provider === 'vercel'
        ? this.providerPin.configuration.resources
        : undefined;
    const vercelIdentity = resources === undefined ? undefined : vercelBillingIdentity(resources);
    const service = vercelIdentity?.service ?? (await getBillingContext(this.ctx.storage))?.service;
    if (service === undefined) return;
    const identity: BillingIdentity | undefined =
      vercelIdentity === undefined ? undefined : { sandboxClassName: vercelIdentity.className };
    const usageClient = createContainerUsageClient(this.env.CONTAINER_USAGE_METER, { service });
    const schedule = (delaySeconds: number, callback: string, payload?: unknown) =>
      this.billingSchedule.schedule(callback, Date.now() + delaySeconds * 1_000, payload);
    const deleteSchedules = (callback: string) => {
      if (callback !== VERCEL_BILLING_SETTLEMENT_CALLBACK)
        void this.billingSchedule.remove(callback).catch(() => undefined);
    };
    const getState = () => this.vercelBillingContainerState();
    const stopContainer = async () => {
      const generation = (await getBillingContext(this.ctx.storage))?.generation;
      this.ctx.waitUntil(
        this.dispatchResult({
          type: 'stop-requested',
          at: Date.now(),
          reason: 'billing_blocked',
        }).catch(async () => {
          if (generation !== undefined) {
            await this.billingSchedule.schedule(
              VERCEL_BILLING_FORCE_STOP_CALLBACK,
              Date.now() + VERCEL_BILLING_DELIVERY_RETRY_MS,
              generation
            );
          }
        })
      );
    };
    const lifecycle = new MeteredBillingLifecycle({
      storage: this.ctx.storage,
      usageClient,
      schedule,
      deleteSchedules,
      getState,
      isContainerRunning: () => false,
      stopContainer,
      destroyContainer: stopContainer,
      durableObjectId: this.sandboxId,
      waitUntil: promise => this.ctx.waitUntil(promise),
    });
    const heartbeat = installBillingHeartbeat(
      { schedule, deleteSchedules, getState } as unknown as Parameters<
        typeof installBillingHeartbeat
      >[0],
      {
        client: usageClient,
        storage: this.ctx.storage,
        stopOnStoppedState: false,
        deferBudgetStopFinalSettlement: true,
        beforeHeartbeatDelivery: context => lifecycle.ensureStartAcknowledged(context),
        beforeStopDelivery: context => lifecycle.ensureStartAcknowledged(context),
        onGenerationClosed: context => this.vercelBilling?.billing.onGenerationClosed(context),
        enforceBudgetStop: async (budget, expected) => {
          if (identity === undefined) throw new Error('Vercel billing identity is unavailable');
          await lifecycle.enforceBudgetStop(identity, budget, expected);
        },
        onBudgetWarning: async budget => {
          if (identity !== undefined) await lifecycle.onBudgetWarning(identity, budget);
        },
      }
    );
    lifecycle.attachHeartbeat(heartbeat);
    this.vercelBilling = {
      identity,
      lifecycle,
      heartbeat,
      billing: new VercelBilling({
        storage: this.ctx.storage,
        lifecycle,
        heartbeat,
        schedule: this.billingSchedule,
      }),
    };
  }

  private async vercelBillingContainerState(): Promise<{ status: string; lastChange?: number }> {
    const context = await getBillingContext(this.ctx.storage);
    if (context === undefined) return { status: 'running' };
    const binding = await loadVercelBillingBinding(this.ctx.storage, context.generation);
    if (binding?.terminalAtMs !== undefined)
      return { status: 'stopped', lastChange: binding.terminalAtMs };
    if (binding === undefined || this.currentProvider() !== 'vercel') return { status: 'running' };
    try {
      const observed = await this.provider.observe(binding.providerRef);
      if (observed.status !== 'terminal') return { status: 'running' };
      const refreshed = await loadVercelBillingBinding(this.ctx.storage, context.generation);
      return {
        status: 'stopped',
        lastChange: refreshed?.terminalAtMs ?? context.usageMeasuredAtMs ?? binding.createdAtMs,
      };
    } catch {
      return { status: 'running' };
    }
  }

  // --- provider selection -----------------------------------------------------

  private createProviderAdapter(pin: StoredProviderPin): ProviderAdapter {
    const allocationName = pin.allocationName ?? this.sandboxId;
    if (pin.provider === 'vercel') {
      const resources =
        pin.configuration?.provider === 'vercel' ? pin.configuration.resources : undefined;
      const config = this.vercelConfig(pin.locator, resources);
      return createVercelProviderAdapter({
        sandboxName: allocationName,
        config,
        billingLifetimeSink: evidence => this.recordVercelBillingLifetime(evidence),
      });
    }
    if (pin.provider === 'cloudflare-containers') {
      const instance =
        pin.configuration?.provider === 'cloudflare-containers'
          ? pin.configuration.instance
          : undefined;
      return createCloudflareContainersProviderAdapter({
        logicalSandboxId: this.sandboxId,
        allocationName,
        ...(instance === undefined ? {} : { instance }),
        getContainer: id => this.env.SANDBOX_CONTAINERS.getByName(id),
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

  private vercelConfig(
    locator: VercelProviderLocator | null,
    resources: VercelSandboxResources | undefined
  ) {
    if (locator === null) {
      return resolveVercelSandboxRuntimeConfig(this.env, { resources });
    }
    const resolved = resolveVercelSandboxRuntimeConfig(this.env, {
      projectId: locator.projectId,
      snapshotId: locator.snapshotId,
      runtimeBuildId: locator.runtimeBuildId,
      runtime: locator.runtime,
      ...(resources === undefined ? {} : { resources }),
    });
    return resolved === undefined ? undefined : { ...resolved, teamId: locator.teamId };
  }

  // --- storage ----------------------------------------------------------------

  private async retryAllowed(): Promise<boolean> {
    return routeRetryAllowed(this.routeContext(await this.readAllocation()));
  }

  private async readAllocation(): Promise<AllocationState> {
    const row = await this.readAllocationRow();
    return row === null ? initialAllocationState() : rowToState(row);
  }

  private async readAllocationRow(): Promise<AllocationRow | null> {
    const rows = await this.db
      .select()
      .from(allocationTable)
      .where(eq(allocationTable.id, ALLOCATION_ROW_ID));
    return rows[0] ?? null;
  }

  private async writeAllocation(state: AllocationState): Promise<void> {
    const row = stateToRow(state);
    await this.db
      .insert(allocationTable)
      .values(row)
      .onConflictDoUpdate({ target: allocationTable.id, set: row });
  }

  private async readProviderPin(): Promise<StoredProviderPin | null> {
    const rows = await this.db
      .select({ pin: allocationTable.provider_pin })
      .from(allocationTable)
      .where(eq(allocationTable.id, ALLOCATION_ROW_ID));
    const raw = rows[0]?.pin;
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw) as StoredProviderPin;
    } catch {
      return null;
    }
  }

  private async writeProviderPin(pin: StoredProviderPin): Promise<void> {
    await this.db
      .update(allocationTable)
      .set({ provider_pin: JSON.stringify(pin) })
      .where(eq(allocationTable.id, ALLOCATION_ROW_ID));
  }

  private async armAlarm(state: AllocationState): Promise<void> {
    // The one alarm is the earliest of the allocation timers and the route
    // preparation deadlines, so a hung wrapper's route cannot outlive its
    // 12-minute attempt.
    const allocationAt = nextAllocationAlarmAt(state, this.sandboxTimers());
    const routeAt = await earliestRouteDeadlineAt(this.db);
    if (this.billingSchedule.snapshotEarliestDue() === undefined) await this.billingSchedule.load();
    const billingAt = this.billingSchedule.snapshotEarliestDue() ?? null;
    const candidates = [allocationAt, routeAt, billingAt, this.earliestHelloDeadlineAt()].filter(
      (at): at is number => at !== null
    );
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  private sandboxTimers(): SandboxTimers {
    return resolveControlPlaneTimers(this.env as unknown as Record<string, string | undefined>)
      .sandbox;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.operations.tail.then(task, task);
    this.operations.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
