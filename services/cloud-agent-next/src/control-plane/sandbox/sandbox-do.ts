import {
  WORKTREE_RUNTIME_HEADER,
  WORKTREE_RUNTIME_VERSION,
} from '../../shared/control-plane-runtime-contract.js';
import {
  acceptRuntimeContract,
  canShareLegacyRepositoryCredentials,
  readRuntimeContract,
  resetRuntimeContract,
  runtimeSpecForContract,
} from './runtime-contract.js';
import { DurableObject } from 'cloudflare:workers';
import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import { z } from 'zod';
import { DEFAULT_DO_RETRY_CONFIG, withTimeout } from '@kilocode/worker-utils';
import { getBillingContext } from '@kilocode/container-usage';
import { egressPolicySchema, type EgressMode } from '@kilocode/worker-utils/egress-allowlist';
import type { VercelSandboxResources } from '@kilocode/worker-utils/sandbox-allocation';
import { CloudAgentRunContainerSchema } from '@kilocode/worker-utils/cloud-agent-queue-report';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import {
  forceDestroyControlPlaneSandbox,
  parseSandboxBillingInput,
  type SandboxBillingInput,
} from '../../container-usage-context.js';
import { resolveSecret } from '../../auth.js';
import { isCloudAgentContainerBillingEnabled } from '../../container-billing-rollout.js';
import {
  assertContainerCapacity,
  getContainerCapacityFailureReason,
} from '../../container-concurrency.js';
import { BillingScheduleTable } from '../../sandbox-control/billing-schedule.js';
import { createVercelBillingRuntime, type VercelBillingRuntime } from './vercel-billing-runtime.js';
import {
  generateSandboxCredential,
  hashSandboxCredential,
  mintSandboxLaunchCredential,
  parseSandboxLaunchBearer,
  sandboxCredentialMatchesHash,
  verifySandboxLaunchCredential,
} from '../../sandbox-control/credential.js';
import { rejectSandboxWrapperUpgrade } from '../../sandbox-control/socket-admission.js';
import { DEADLINE_MS } from '../../sandbox-control/deadlines.js';
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
  type ProviderStartSource,
  type SandboxProviderConfiguration,
} from '../../sandbox-control/provider.js';
import {
  createVercelProviderAdapter,
  vercelProviderLocatorSchema,
  type VercelProviderLocator,
} from '../../sandbox-control/vercel-provider.js';
import { buildControlWrapperLaunchEnv } from '../../sandbox-control/wrapper-launch-env.js';
import { preinstalledStartup } from '../../sandbox-control/preinstalled-startup.js';
import {
  kiloTokenHasRuntimeAuthorization,
  prepareCredentialGrant,
  resolveSessionCredential,
  sessionCredentialsPayloadFromGrant,
  type SessionCredentialGrant,
} from '../../sandbox-control/session-credentials.js';
import { providerUsesOutboundCredentialProxy } from '../../agent-sandbox/capabilities.js';
import { resolveVercelSandboxRuntimeConfig } from '../../agent-sandbox/vercel/vercel-runtime-config.js';
import { getManagedOutboundContainerId } from '../../sandbox-id.js';
import {
  resolveSandboxNamespace,
  sandboxKindMatchesKey,
  type SandboxKind,
} from '../../sandbox-placement.js';
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
  verifyRuntimeCredentialProxyHandleExpiresAt,
} from '../../runtime-credential-proxy.js';
import {
  ACCEPTED_HANDLES_MAX,
  acceptedHandleIssuerLocator,
  addAcceptedHandleSync,
  constantTimeEqual,
  digestRuntimeProxyHandle,
  hasAcceptedScopeHandle,
  listAcceptedHandleStringsByScopeId,
  listAcceptedHandlesForScope,
  listAcceptedHandlesForScopeIncludingExpired,
  lookupAcceptedHandle,
  retireAcceptedHandlesSync,
  type ScopeBackingToken,
  type ScopeHandleResolution,
} from './accepted-handles.js';
import { markLastSentHandle, readLastSentHandleDigest } from './scope-handle-delivery.js';
import {
  memberHandleForSession,
  selectHandoffCandidate,
  setAllMemberHandles,
  sharedCanonicalHandleSurvivesRelease,
  type HandoffMemberState,
} from './scope-handle-rotation.js';
import { isActiveScopeMember } from './scope-view.js';
import {
  admissionFailureStage,
  canonicalMintKey,
  CanonicalHandleMinter,
  clearRuntimeProxyMembers,
  decideCanonicalHandle,
  isAdoptableWorktreeScope,
  isWorkspaceProxyScope,
  MAX_SCOPE_MEMBERS,
  MixedCredentialClassError,
  ScopeHandleConflictError,
  ScopeMemberLimitError,
  scopeMemberCount,
  withMemberHandle,
  type CanonicalHandleMint,
} from './scope-handle-adoption.js';
import {
  decideRenewedScopeCandidate,
  expectedScopeForCandidate,
  scopeBackingMatchesGrant,
  selectScopeHandleCandidates,
} from './scope-handle-resolution.js';
import { buildScopeGrantView, type ScopeGrantView } from './scope-view.js';
import { readScopeGrantView } from './scope-view-store.js';
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
  controlPlaneRouteSpecSchema,
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
import {
  CONTROL_PLANE_TIMERS,
  resolveControlPlaneTimers,
  sandboxIdlePolicyForOrigins,
} from '../../shared/control-plane-timers.js';
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
  failReadyRoutesForScope,
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
import { computeRepoKey, repoSnapshotEligibility } from './repo-key.js';
import { buildFrameEnv } from './frame-env.js';
import {
  beginRepositoryLaunch,
  captureRequested,
  confirmRepositoryLaunch,
  readRepositoryLaunch,
  recordRepositoryLaunch,
  repositoryLaunchOptions,
  type RepositoryPreparationFailure,
} from './repository-launch.js';
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
import { resolvePreviewTarget, type PreviewTargetResult } from './preview-target.js';
import type { SandboxStatusSnapshot } from '../../shared/sandbox-status.js';
import { getWorktreeWorkspacePath } from '../../workspace.js';
import { buildNativeEgressAllowlist } from '../../sandbox-control/egress-policy.js';
import { nativeEgressAllowlistSchema } from '../../sandbox-containers/egress-policy.js';

const GENERATION_KEY = 'control_plane_generation';
const GENERATION = 2;
const CREDENTIAL_HASH_KEY = 'wrapper_credential_hash';
const OWNER_KEY = 'control_plane_owner';
/** Backstop over the container DO's own capture timeout; the wrapper waits slightly longer. */
const REPOSITORY_CAPTURE_CALL_MS = 5 * 60_000 + 5_000;
const ALLOCATION_ROW_ID = 'current';

export type StoredProviderPin = {
  provider: AgentSandboxProvider;
  allocationName: string | null;
  configuration: SandboxProviderConfiguration | null;
  locator: VercelProviderLocator | null;
  billing: SandboxBillingInput | null;
  containment: CredentialContainmentRequirements | null;
  /** Stored kind of a placed key. Legacy prefixed keys have none. */
  sandboxKind?: SandboxKind;
  egressAllowlist?: string[];
};

export type EnsureAllocationInput = {
  provider?: AgentSandboxProvider;
  allocationName?: string;
  configuration?: SandboxProviderConfiguration;
  locator?: VercelProviderLocator;
  billing?: SandboxBillingInput;
  containment?: CredentialContainmentRequirements;
  sandboxKind?: SandboxKind;
  egressMode?: EgressMode;
  egressAllowlist?: string[];
};

const wrapperSocketAttachmentSchema = z.object({
  credential: z.string().nullable(),
  helloDeadlineAt: z.number().finite().nonnegative().optional(),
  allocationId: z.string().optional(),
  connectionId: z.string().optional(),
  wrapperId: z.string().optional(),
  heartbeatAck: z.literal(true).optional(),
  redactsNamedSecrets: z.literal(true).optional(),
  runtimeCapability: z.literal('worktree').optional(),
});
type WrapperSocketAttachment = z.infer<typeof wrapperSocketAttachmentSchema>;

/** Separates an old wrapper from a decrypt/parse failure; both fail the attempt. */
type PrepareFrameMaterializationStage =
  | 'wrapper_redaction_unsupported'
  | 'frame_materialization_failed';

class PrepareFrameMaterializationError extends Error {
  constructor(
    readonly stage: PrepareFrameMaterializationStage,
    readonly sourceErrorName?: string
  ) {
    super('session.prepare frame materialization failed');
    this.name = 'PrepareFrameMaterializationError';
  }
}

function errorClassName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function materializationStage(error: unknown): PrepareFrameMaterializationStage {
  return error instanceof PrepareFrameMaterializationError
    ? error.stage
    : 'frame_materialization_failed';
}

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
  /**
   * Renews this member's own backing token without matching the caller's handle
   * against its stored grant; the Sandbox DO has already authorized the scope.
   * The member self-validates the expected scope and returns null on mismatch.
   */
  issueRuntimeProxyBackingToken(input: {
    sandboxId: string;
    directory: string;
    kiloSessionId: string;
  }): Promise<ScopeBackingToken | null>;
  /**
   * The member's live delegation expiry in milliseconds, or null when this
   * Session DO cannot serve the scope. Used to pick a proactive handoff issuer
   * whose delegation outlives the canonical handle; only reads durable state, it
   * does not renew or mint.
   */
  getRuntimeProxyDelegationExpiresAt(input: {
    sandboxId: string;
    directory: string;
    kiloSessionId: string;
  }): Promise<number | null>;
};

/** Spec §10: the runtime credential proxy fence returned to the Worker. */
export type ControlRuntimeCredentialProxyFence = {
  plane: 'control';
  allocationId: string;
  providerInstanceId: string;
  connectionId: string;
  wrapperInstanceId: string;
};

/** The fence plus, for an adopted handle, the current scope view or the reason it is unavailable. */
export type ControlRuntimeCredentialProxyFenceScope = ControlRuntimeCredentialProxyFence & {
  scopeView?: ScopeGrantView;
  scopeViewUnavailable?: string;
};

/** The adopted-handle state a scope is already serving, if any. */
type CanonicalHandleState = CanonicalHandleMint & {
  /** The requesting member can be served this handle, by holding or by binding it. */
  usable: boolean;
};

/** The serialized outcome of claiming a canonical handle for a preparing route. */
type ScopeHandleClaim =
  | { kind: 'handle'; handle: string }
  | { kind: 'stale' }
  | { kind: 'remint' }
  | { kind: 'per-session' }
  | { kind: 'fail' };

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
  private readonly repositoryCaptures = new Map<
    string,
    { allocationId: string | null; ok?: boolean }
  >();
  private readonly billingSchedule: BillingScheduleTable;
  /** Vercel metered-billing runtime; reads live pin/storage, never frozen config. */
  private readonly billingRuntime: VercelBillingRuntime;
  /**
   * Single-flight canonical handle mints, keyed by scope and current fence. Two
   * concurrent preparers of the same scope wait on one Session DO mint so only
   * the winner issues a handle; the loser adopts the winner's string.
   */
  private readonly canonicalHandleMints = new CanonicalHandleMinter<
    ControlPlaneSessionPeer,
    ControlRuntimeCredentialProxyFence
  >(
    (peer, fence) => this.mintRuntimeProxyGrant(peer, fence),
    handle => this.runtimeProxyHandleClaims(handle)
  );
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
    budgetMs: () => CONTROL_PLANE_TIMERS.sandbox.sessionNotifyDeadlineMs,
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
    this.billingRuntime = createVercelBillingRuntime({
      storage: ctx.storage,
      env: () => this.env,
      sandboxId: this.sandboxId,
      schedule: this.billingSchedule,
      currentProvider: () => this.currentProvider(),
      currentPin: () => this.providerPin,
      readAllocation: () => this.readAllocation(),
      requireOwner: () => this.requireOwner(),
      isCreateInFlight: () => this.createInFlight,
      provider: () => this.provider,
      timers: () => this.sandboxTimers(),
      stopRef: (ref, allocationId) => this.stopRef(ref, allocationId),
      failUnconfirmedCleanup: state => this.failUnconfirmedVercelCleanup(state),
      requestStop: () =>
        this.dispatchResult({ type: 'stop-requested', at: Date.now(), reason: 'billing_blocked' }),
      waitUntil: promise => this.ctx.waitUntil(promise),
    });
    this.provider = this.createProviderAdapter(this.defaultPin('cloudflare'));
    this.initialized = ctx.blockConcurrencyWhile(() => this.initializeStorage());
  }

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
    return {
      ...(await this.readAllocation()),
      provider: this.currentProvider(),
      configuration: this.providerPin?.configuration ?? null,
    };
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
        inactivityTimeoutMs: this.sandboxIdleTimeoutMs(allocation),
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
      this.repositoryCaptures.delete(parsed.sessionId);
      const released = await readRoute(this.db, parsed.sessionId);
      // A shared canonical handle survives on the other members, so removing
      // this route's path rules is not worth a policy rebuild: a transient
      // provider failure there would stop the sandbox and kill the survivor. The
      // facade already denies the released root. Last-member release, a real
      // alias retirement and wrapper replacement still rebuild fail-closed.
      const sharedHandleSurvives = sharedCanonicalHandleSurvivesRelease(
        released?.grant ?? null,
        parsed.sessionId
      );
      await deleteRoute(this.db, this.ctx.storage.kv, parsed.sessionId);
      if (!sharedHandleSurvives) {
        // Rebuild the policy inside the queue; if it cannot apply, stop the
        // sandbox as a platform failure so the alias is not left injected.
        await this.applyVercelNetworkPolicyOrStop('sandbox_lost');
      }
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
        view: await this.withContainer(
          routeView(route, state.kind === 'connected', sandboxPreparationProgress(state)),
          state
        ),
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
   * Off-queue read the Session DO uses to resolve one preview's provider
   * coordinates. It never enqueues, so a preview never waits behind the control
   * operation queue. The allocation and route are two separate reads, not one
   * snapshot. A target that changes before the upstream fetch is fenced
   * downstream: SandboxContainers checks `allocationRef` and state, and the
   * remaining race is an accepted residual (control-plane.md, Preview).
   */
  async previewTarget(sessionId: string): Promise<PreviewTargetResult> {
    await this.initialized;
    const allocation = await this.readAllocation();
    const route = await readRoute(this.db, sessionId);
    return resolvePreviewTarget({
      routeState: route?.state ?? null,
      allocationKind: allocation.kind,
      providerRef: allocation.providerRef,
      provider: this.currentProvider(),
      pinnedAllocationName: this.providerPin?.allocationName ?? this.sandboxId,
      sandboxKind: this.providerPin?.sandboxKind,
      logicalSandboxId: this.sandboxId,
    });
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
    handle?: string;
  }): Promise<ControlRuntimeCredentialProxyFenceScope | null> {
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
      if (typeof input.handle !== 'string' || input.handle.length === 0) return fence;
      const match = await lookupAcceptedHandle(this.ctx.storage, input.handle, fence);
      if (match === undefined) return fence;
      // `provisioned` already checked the route grant's directory and the caller's
      // membership; tying it to the accepted entry makes the canonical view grant
      // the caller's own grant, so a handle accepted under another scope cannot
      // attach that scope's view.
      if (scopeGrantId(grant) !== match.scopeGrantId) {
        return {
          ...fence,
          scopeViewUnavailable: 'Accepted scope handle does not belong to the caller grant',
        };
      }
      const scopeGrant = readScopeGrant(this.db, match.scopeGrantId);
      if (scopeGrant === null) {
        return {
          ...fence,
          scopeViewUnavailable: 'Accepted scope handle has no canonical grant',
        };
      }
      return { ...fence, scopeView: readScopeGrantView(this.db, scopeGrant) };
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
   * Serves a runtime credential proxy handle on behalf of a surviving member of
   * the canonical scope. The exact handle string is supplied and its signature
   * is re-verified here. `unavailable` means a candidate failed on transport and
   * none served (the facade returns a retryable 503); `denied` is a known denial
   * on every candidate (including a handle not in the accepted set).
   */
  async resolveScopeHandle(input: { handle: string }): Promise<ScopeHandleResolution> {
    await this.initialized;
    if (
      typeof input?.handle !== 'string' ||
      input.handle.length === 0 ||
      input.handle.length > 4096
    ) {
      return { type: 'denied' };
    }
    const claims = await verifyRuntimeCredentialProxyHandle(this.env, input.handle);
    if (!claims) return { type: 'denied' };
    const owner = await this.requireOwner();
    if (owner === null || owner !== claims.userId) return { type: 'denied' };
    const fence = this.runtimeProxyFenceFor(await this.readAllocation());
    if (fence === null) return { type: 'denied' };
    const match = await lookupAcceptedHandle(this.ctx.storage, input.handle, fence);
    if (match === undefined) return { type: 'denied' };

    const grant = readScopeGrant(this.db, match.scopeGrantId);
    if (grant === null || grant.userId !== claims.userId) {
      return this.denyScopeHandle(match.scopeGrantId);
    }
    const candidates = selectScopeHandleCandidates({
      grant,
      routes: await listRoutes(this.db),
      issuerSessionId: claims.sessionId,
    });
    if (candidates.length === 0) return this.denyScopeHandle(match.scopeGrantId);

    let sawUnavailable = false;
    for (const candidate of candidates) {
      const peer = this.sessionPeerFor(owner, candidate.member.sessionId);
      if (peer === null) {
        sawUnavailable = true;
        continue;
      }
      let backing: ScopeBackingToken | null;
      try {
        backing = await withTimeout(
          peer.issueRuntimeProxyBackingToken({
            sandboxId: this.sandboxId,
            ...expectedScopeForCandidate(candidate.member, grant),
          }),
          this.scopeBackingTokenMs(),
          'Scope backing token timed out'
        );
      } catch {
        sawUnavailable = true;
        continue;
      }
      if (backing === null) continue;

      // The renewal awaited external I/O. A superseded physical binding or a
      // vanished grant makes the handle stale, not the member's fault: deny
      // without failing routes. A member that left the grant, or whose route
      // directory/root drifts while renewing, is a member-level denial and the
      // next candidate is tried.
      const latestFence = this.runtimeProxyFenceFor(await this.readAllocation());
      const latestGrant = readScopeGrant(this.db, match.scopeGrantId);
      const latestRoutes = await listRoutes(this.db);
      const latestRoute = latestRoutes.find(
        route => route.sessionId === candidate.member.sessionId
      );
      const decision = decideRenewedScopeCandidate({
        bindingMatches: latestFence !== null && sameRuntimeProxyControlBinding(fence, latestFence),
        grant: latestGrant,
        member: candidate.member,
        route: latestRoute,
      });
      if (decision === 'deny') return { type: 'denied' };
      if (decision === 'skip') continue;
      if (latestGrant === null) return { type: 'denied' };
      if (!scopeBackingMatchesGrant(backing, candidate.member, latestGrant)) continue;
      return {
        type: 'served',
        scopeView: buildScopeGrantView(latestGrant, latestRoutes),
        ...backing,
      };
    }
    if (sawUnavailable) return { type: 'unavailable' };
    return this.denyScopeHandle(match.scopeGrantId);
  }

  /** Locator for a deleted issuer that still has accepted handles, or null. */
  async getAcceptedHandleIssuerLocator(issuerSessionId: string): Promise<{
    scopeId: string;
    allocationId: string;
    wrapperInstanceId: string;
    expiresAt: number;
  } | null> {
    await this.initialized;
    if (typeof issuerSessionId !== 'string' || issuerSessionId.length === 0) return null;
    return acceptedHandleIssuerLocator(this.ctx.storage, issuerSessionId);
  }

  /**
   * Fails every ready route in the scope in the background, then denies the
   * handle immediately so the facade response is not held behind the queue.
   */
  private denyScopeHandle(scopeGrantId: string): ScopeHandleResolution {
    this.ctx.waitUntil(
      this.enqueue(async () => {
        const state = await this.readAllocation();
        await failReadyRoutesForScope(
          this.routeContext(state),
          scopeGrantId,
          'scope_handle_denied'
        );
      })
    );
    return { type: 'denied' };
  }

  /**
   * Vercel network policy entry point (spec §10 runtime credential proxy). The
   * caller-supplied `networkPolicy` is accepted for RPC compatibility but its
   * value is ignored: the policy is rebuilt from the stored grants so this
   * cannot become a second source of truth, and the caller must own the sandbox
   * (B3 review 5).
   */
  async updateNetworkPolicy(input: {
    ownerId: string;
    networkPolicy?: unknown;
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
    const url = new URL(request.url);
    // Only the authorized Session DO forwards this internal path, using stored ownership.
    if (url.pathname === '/status-stream') {
      return this.enqueue(async () => {
        const owner = await this.requireOwner();
        const sessionId = url.searchParams.get('sessionId');
        if (owner === null || owner !== url.searchParams.get('ownerId') || !sessionId)
          return new Response('Sandbox owner mismatch', { status: 403 });
        const allocation = await this.readAllocation();
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1], ['sandbox-status']);
        pair[1].serializeAttachment({ kind: 'sandbox-status', sessionId });
        this.sendStatusSnapshot(pair[1], sessionId, allocation);
        return new Response(null, { status: 101, webSocket: pair[0] });
      });
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
        ...(request.headers.get(WORKTREE_RUNTIME_HEADER) === WORKTREE_RUNTIME_VERSION
          ? { runtimeCapability: 'worktree' as const }
          : {}),
        helloDeadlineAt: Date.now() + this.sandboxTimers().wrapperHelloMs,
      } satisfies WrapperSocketAttachment);
      await this.armAlarm(await this.readAllocation());
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.initialized;
    if (this.isStatusSocket(ws)) return;
    // Resolve an outstanding control request before the serial queue so the
    // queued request that awaits it cannot block its own reply.
    this.resolvePendingControlResult(ws, message);
    await this.enqueue(() => this.handleFrame(ws, message));
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.initialized;
    if (this.isStatusSocket(ws)) {
      ws.close();
      return;
    }
    // Fail every request bound to this socket at once; do not wait the timeout.
    this.settlePendingForSocket(
      ws,
      controlRequestFailure('not_ready', 'Wrapper disconnected', true)
    );
    await this.enqueue(async () => {
      const attachment = this.readAttachment(ws);
      if (
        attachment?.allocationId !== undefined &&
        [...this.repositoryCaptures.values()].some(
          capture => capture.allocationId === attachment.allocationId && capture.ok === undefined
        )
      )
        return;
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
      await this.recoverRepositoryPreparationFailures();
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
        retireScopeGrants(tx, this.ctx.storage.kv);
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

  private pinFromInput(
    input: EnsureAllocationInput,
    repositoryUrl?: string,
    kiloToken?: string
  ): StoredProviderPin {
    const policy = egressPolicySchema.safeParse(input);
    if (!policy.success) throw new ProviderCreationError('invalid_configuration');
    if (!sandboxKindMatchesKey(this.sandboxId, input.sandboxKind)) {
      throw new Error('Sandbox selection kind does not match the sandbox key');
    }
    const provider = input.provider ?? 'cloudflare';
    if (
      policy.data.egressMode === 'allowlist' &&
      (provider !== 'cloudflare-containers' ||
        (input.sandboxKind === undefined
          ? !this.sandboxId.startsWith('ses-')
          : input.sandboxKind !== 'isolated'))
    ) {
      throw new ProviderCreationError('invalid_configuration');
    }
    return {
      provider,
      allocationName: input.allocationName ?? this.sandboxId,
      configuration: input.configuration ?? { provider },
      locator: input.locator ?? null,
      billing: input.billing ?? null,
      containment: input.containment ?? null,
      ...(input.sandboxKind ? { sandboxKind: input.sandboxKind } : {}),
      ...(policy.data.egressMode !== 'allowlist'
        ? {}
        : {
            egressAllowlist: buildNativeEgressAllowlist({
              allowlist: policy.data.egressAllowlist ?? [],
              env: this.env,
              repositoryUrl,
              kiloToken,
            }),
          }),
    };
  }

  /** The Cloudflare Sandbox namespace for a physical sandbox: the pinned kind, else the legacy prefix. */
  private sandboxNamespace(
    pin: StoredProviderPin | null,
    physicalSandboxId: string,
    contained: boolean
  ): DurableObjectNamespace<Sandbox> {
    return resolveSandboxNamespace(this.env, {
      sandboxId: physicalSandboxId,
      sandboxKind: pin?.sandboxKind,
      contained,
    });
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

  private async applyEvent(event: AllocationEvent): Promise<void> {
    const previous = await this.readAllocation();
    const timers = { ...this.sandboxTimers() };
    if (
      this.currentProvider() === 'cloudflare-containers' &&
      (event.type === 'ensure' || event.type === 'tick')
    ) {
      const launch = repositoryLaunchOptions(
        await listRoutes(this.db),
        await readRepositoryLaunch(this.ctx.storage)
      );
      if (launch.options.repoKey !== undefined && !launch.skipped) {
        timers.providerCreateMs = DEADLINE_MS.repositoryStartup;
      }
    }
    const { state, effects, stopReason } = reduceAllocation(previous, event, timers);
    await this.writeAllocation(state, previous);
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
    for (const [sessionId, capture] of this.repositoryCaptures) {
      if (capture.allocationId !== state.allocationId || state.kind === 'stopping') {
        this.repositoryCaptures.delete(sessionId);
      } else if (
        capture.ok !== undefined &&
        (await readRoute(this.db, sessionId))?.state !== 'preparing'
      ) {
        this.repositoryCaptures.delete(sessionId);
      }
    }
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

  /** Bounds one member's scope backing renewal; the Session DO bounds the total. */
  private scopeBackingTokenMs(): number {
    return this.sandboxTimers().scopeBackingTokenMs;
  }

  /** Route transitions need storage, the bound socket and the bounded notify. */
  private routeContext(state: AllocationState): RouteContext {
    return {
      db: this.db,
      acceptedHandles: this.ctx.storage.kv,
      now: () => Date.now(),
      routePreparationMs: this.sandboxTimers().routePreparationMs,
      sendPrepare: route => this.sendSessionPrepare(state, route),
      notify: async (sessionId, update) => {
        this.notifications.enqueue(sessionId, {
          kind: 'route',
          payload: await this.withContainer(update, state),
        });
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
      await deleteRoute(this.db, this.ctx.storage.kv, spec.sessionId);
      return {
        state: 'failed',
        attemptId: crypto.randomUUID(),
        reason: 'workspace_setup_failed',
      };
    }
    let selectedPin: StoredProviderPin | undefined;
    try {
      if (
        sandboxSelection !== undefined &&
        (state.kind === 'stopped' ||
          sandboxSelection.egressMode === 'allowlist' ||
          this.providerPin?.egressAllowlist !== undefined)
      ) {
        const repository = source.repository;
        selectedPin = this.pinFromInput(
          sandboxSelection,
          repository && repository.type !== 'github' ? repository.url : undefined,
          source.kiloToken
        );
      }
      if (
        state.kind !== 'stopped' &&
        (selectedPin?.egressAllowlist !== undefined ||
          this.providerPin?.egressAllowlist !== undefined) &&
        JSON.stringify(selectedPin?.egressAllowlist) !==
          JSON.stringify(this.providerPin?.egressAllowlist)
      ) {
        throw new ProviderCreationError('invalid_configuration');
      }
    } catch (error) {
      if (!(error instanceof ProviderCreationError)) throw error;
      const attemptId = crypto.randomUUID();
      const route = await failRoute(
        this.routeContext(state),
        { ...spec, attemptId },
        attemptId,
        'invalid_configuration'
      );
      return routeView(route, state.kind === 'connected');
    }
    // H1: apply the Worker-selected provider pin before the first attempt. The
    // pin is only mutable while stopped; once an allocation exists its provider
    // is fixed and a repeated prepare must not re-decide it.
    if (selectedPin !== undefined && state.kind === 'stopped') {
      const pin = selectedPin;
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
    const repoKey = await this.repoKeyFor(spec, source);
    const { route, started } = await ensureRoute(this.routeContext(state), spec, source, repoKey);
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
    return this.withContainer(
      routeView(route, state.kind === 'connected', sandboxPreparationProgress(state)),
      state
    );
  }

  private async withContainer<T extends ControlPlaneRouteUpdate>(
    view: T,
    state: AllocationState
  ): Promise<T> {
    if (view.state === 'unknown' || state.providerRef === null || state.allocationId === null) {
      return view;
    }
    try {
      const runtime = this.provider.describeRuntime?.(state.providerRef);
      if (runtime === undefined) return view;
      const launch = await readRepositoryLaunch(this.ctx.storage);
      const startSource =
        runtime.startSource ??
        (launch?.allocationId === state.allocationId && launch.startSource !== undefined
          ? launch.startSource === 'repository'
            ? 'snapshot'
            : 'image'
          : undefined);
      const container = CloudAgentRunContainerSchema.safeParse({
        ...runtime,
        allocationId: state.allocationId,
        ...(startSource === undefined ? {} : { startSource }),
      });
      return container.success ? { ...view, container: container.data } : view;
    } catch {
      logger
        .withFields({ sandboxId: this.sandboxId })
        .warn('Sandbox runtime metadata could not be projected; the route is unaffected');
      return view;
    }
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

  /**
   * The repository snapshot key for a route, or null when none applies. It is hashed
   * from the input spec: the grant rewrites `spec.env` with per-attempt credential
   * aliases, so the stored spec would give every session its own key. The setup
   * commands are folded into the key, so a snapshot is reused only by a route with
   * the same setup; a different setup neither restores nor captures under it.
   *
   * Emits one `snapshot_key` diagnostic per route so a missing snapshot can be
   * traced to the gate that rejected it (or to a missing key secret).
   */
  private async repoKeyFor(
    spec: ControlPlaneRouteSpec,
    source: ControlPlaneCredentialSource
  ): Promise<string | null> {
    if (this.provider.captureRepository === undefined) {
      this.logSnapshotKey(spec.sessionId, false, 'provider_no_capture');
      return null;
    }
    const route = { repoUrl: spec.git?.url, directory: spec.directory };
    const gate = {
      enrolledIds: this.env.CONTAINER_REPO_SNAPSHOT_IDS,
      userId: source.userId,
      orgId: source.orgId,
    };
    const eligibility = repoSnapshotEligibility(gate, route);
    if (!eligibility.eligible) {
      this.logSnapshotKey(spec.sessionId, false, eligibility.reason);
      return null;
    }
    const secret = await withTimeout(
      resolveSecret(this.env.NEXTAUTH_SECRET),
      1_000,
      'Repository snapshot key secret lookup timed out'
    ).catch(() => null);
    const key = await computeRepoKey({
      secret,
      userId: source.userId,
      ...route,
      setupCommands: spec.setupCommands,
    });
    if (key === null) {
      this.logSnapshotKey(spec.sessionId, false, 'secret_missing');
      return null;
    }
    this.logSnapshotKey(spec.sessionId, true, 'eligible', key);
    return key;
  }

  private logSnapshotKey(
    sessionId: string,
    eligible: boolean,
    reason: string,
    repoKey?: string
  ): void {
    logControlDiagnostic('snapshot_key', {
      sandboxId: this.sandboxId,
      sessionId,
      eligible,
      reason,
      repoKey: repoKey?.slice(0, 16),
    });
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
    const allocation = await this.readAllocation();
    const runtimeContract = readRuntimeContract(this.ctx.storage.kv, allocation.allocationId);
    const outboundContainerId = this.outboundContainerIdFor(allocation) ?? undefined;
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
    if (
      runtimeContract !== 'legacy' &&
      !scopes.some(
        grant =>
          grant.scopeId === scopeId &&
          grant.members.some(member => member.sessionId === spec.sessionId)
      ) &&
      scopeMemberCount(scopes, scopeId) >= MAX_SCOPE_MEMBERS
    ) {
      throw new ScopeMemberLimitError();
    }
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
    // A worktree scope may adopt one canonical handle only when it already has
    // an accepted entry under the current fence. Rows on this fence are written
    // in the same transaction as an accepted entry, so once ANY entry exists
    // (including an expired adoption marker) the incumbents are trusted even if
    // pruning has since dropped the exact string one row still holds. A scope
    // with stored rows but no accepted entry at all is the pre-deploy shape
    // (per-session handles this Sandbox never accepted): admitting a joiner
    // would let two different handles share one directory process after the
    // flip, so it is refused. The requesting member is excluded, so an
    // incumbent's own re-issue is never refused.
    if (runtimeContract !== 'legacy' && isWorkspaceProxyScope(grant)) {
      const incumbents = (grant.kilo.runtimeProxy?.members ?? []).filter(
        member =>
          member.sessionId !== spec.sessionId && member.kiloSessionId !== source.kiloSessionId
      );
      if (incumbents.length > 0) {
        const fence = this.runtimeProxyFenceFor(await this.readAllocation());
        if (fence !== null) {
          const accepted = await listAcceptedHandlesForScopeIncludingExpired(
            this.ctx.storage,
            scopeGrantId(grant),
            fence
          );
          if (accepted.length === 0) throw new ScopeHandleConflictError();
        }
      }
    }
    for (const otherGrant of scopes) {
      if (scopeGrantId(otherGrant) === scopeGrantId(grant)) continue;
      if (
        runtimeContract === 'legacy' &&
        canShareLegacyRepositoryCredentials(otherGrant, grant, {
          sessionId: spec.sessionId,
          kiloSessionId: source.kiloSessionId,
        })
      )
        continue;
      // Shared runtimes hold one credential class per directory.
      if (
        runtimeContract !== 'legacy' &&
        otherGrant.directory === grant.directory &&
        (otherGrant.kilo.runtimeProxy !== undefined) !== (grant.kilo.runtimeProxy !== undefined)
      ) {
        throw new MixedCredentialClassError();
      }
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
      githubReviewTarget?: ControlPlaneRouteSpec['githubReviewTarget'];
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
      ...(spec.worktreeRecovery === undefined ? {} : { worktreeRecovery: spec.worktreeRecovery }),
      ...(spec.runtimeSkills === undefined ? {} : { runtimeSkills: spec.runtimeSkills }),
      ...(spec.runtimeAgents === undefined ? {} : { runtimeAgents: spec.runtimeAgents }),
      ...(spec.kiloCommands === undefined ? {} : { kiloCommands: spec.kiloCommands }),
      ...(spec.permission === undefined ? {} : { permission: spec.permission }),
      ...(spec.runtimeIsolation === undefined ? {} : { runtimeIsolation: spec.runtimeIsolation }),
      ...(payload.githubReviewTarget === undefined
        ? {}
        : { githubReviewTarget: payload.githubReviewTarget }),
      env: payload.env ?? {},
      ...(payload.setupCommands === undefined ? {} : { setupCommands: payload.setupCommands }),
      ...(payload.git === undefined ? {} : { git: payload.git }),
      kilo: payload.kilo,
    };
  }

  private async runDeliver(
    payload: ControlPlaneDeliverPayload
  ): Promise<ControlPlaneDeliverResult> {
    const state = await this.readAllocation();
    let route = await readRoute(this.db, payload.sessionId);
    if (state.kind !== 'connected' || route === null || route.state !== 'ready') {
      return 'not_ready';
    }
    if (payload.allocationId !== undefined && payload.allocationId !== state.allocationId) {
      return 'not_ready';
    }
    const socket = this.boundWrapperSocket(state);
    if (socket === null) return 'not_ready';

    // Proactive maintenance runs whenever the shared canonical handle is within
    // the threshold, independent of the grant re-issue clock: it converges every
    // member row onto the canonical and hands off through a survivor before the
    // canonical ends. Only a worktree proxy scope has a canonical to maintain.
    // It runs before the re-issue so a rotated canonical is what the fresh grant
    // preserves.
    let adopted = false;
    if (route.grant !== null && isWorkspaceProxyScope(route.grant)) {
      const maintained = await this.maintainAdoptedScopeHandle(route.grant, state);
      route = { ...route, grant: maintained.grant };
      adopted = maintained.adopted;
    }

    if (route.grant !== null && this.grantNeedsReissue(route.grant)) {
      // Credentials half of B3: re-issue below one hour remaining with freshly
      // selected material and send `session.credentials` before the prompts. A
      // failure to re-issue must not send the frame: while the previous grant is
      // still due, deliver the prompts on it and retry the re-issue on the next
      // send. Once that grant has expired there is no usable grant left for any
      // re-issue outcome, so the route fails now with the real reason.
      const outcome = await this.reissueRouteGrant(route, state);
      if (outcome !== 'issued' && Date.now() >= route.grant.expiresAt) {
        await onRouteFailed(
          this.routeContext(state),
          payload.sessionId,
          'workspace_setup_failed',
          undefined,
          true
        );
        return 'not_ready';
      }
      route = (await readRoute(this.db, payload.sessionId)) ?? route;
    }

    // One verified-expiry check immediately before the prompts, for adopted
    // handles only. A per-session scope keeps its historical behavior: the
    // expired handle reaches Kilo and the upstream 401 surfaces it.
    if (
      adopted &&
      route.grant !== null &&
      (await this.routeRuntimeProxyExpired(route.grant, payload.sessionId))
    ) {
      await onRouteFailed(
        this.routeContext(state),
        payload.sessionId,
        'workspace_setup_failed',
        undefined,
        true
      );
      return 'not_ready';
    }

    // A ready route may have missed a fanout while its socket was down; resend
    // the current canonical before the prompt so it never runs on a superseded
    // handle.
    if (adopted) await this.ensureRouteCredentialsCurrent(payload.sessionId, state);

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
    // Git/alias material is independent of the runtime-proxy handle, so a
    // re-issue still sends the frame even when the handle string did not change.
    // The canonical handoff runs separately in `runDeliver` maintenance.
    const payload: ControlPlaneSessionCredentialsPayload = {
      ...sessionCredentialsPayloadFromGrant(issued.grant, route.sessionId),
    };
    if (this.trySendFrame(socket, { type: 'session.credentials', ...payload })) {
      await this.markRouteCredentialsSent(route.sessionId, issued.grant);
    }
    return 'issued';
  }

  /**
   * Keeps a worktree scope's shared canonical handle healthy and every member
   * row converged on it. Convergence does not mint: when rows disagree it
   * rewrites them all to the current canonical and fans out, so a claim that
   * replaced the canonical on one row cannot strand another member. A canonical
   * within the threshold is handed off to an active member whose live delegation
   * outlives it; a canonical that has already ended is recovered through any
   * member whose delegation is still live. A failed mint, a full accepted set,
   * or no live member leaves the grant unchanged, and the caller fails only on
   * verified expiry. Never evicts an unexpired handle.
   *
   * The delegation reads, the mint and the policy update run on the serial
   * queue. Their count is bounded by the scope member cap, each read is bounded
   * by the grant-issue timeout, and no read or mint starts until the canonical is
   * within the threshold or has ended.
   */
  private async maintainAdoptedScopeHandle(
    grant: SessionCredentialGrant,
    state: AllocationState
  ): Promise<{ grant: SessionCredentialGrant; adopted: boolean }> {
    const proxy = grant.kilo.runtimeProxy;
    if (proxy === undefined || proxy.members.length === 0) return { grant, adopted: false };
    const fence = this.runtimeProxyFenceFor(state);
    if (fence === null || !(await this.isAdoptedScopeAtFence(grant, fence))) {
      return { grant, adopted: false };
    }
    const now = Date.now();
    const scopeKey = scopeGrantId(grant);
    const canonical = await this.selectCanonicalForScope(grant, fence, null);
    const entries = await listAcceptedHandlesForScope(this.ctx.storage, scopeKey, fence, now);

    if (canonical !== null && proxy.members.some(member => member.handle !== canonical.handle)) {
      // Only converge onto a canonical a current member can still serve; a
      // canonical whose issuer left the scope is left to the members that hold
      // it, as admission already decided for the requestor that could not.
      const converged = canonical.usable ? setAllMemberHandles(grant, canonical.handle) : grant;
      if (converged !== grant && (await this.applyCandidateGrantPolicy(converged))) {
        this.ctx.storage.transactionSync(() => writeScopeGrant(this.db, converged));
        await this.fanoutCanonicalCredentials(converged, state);
        this.logScopeHandleMaintenance(grant.scopeId, 'converged');
        return { grant: converged, adopted: true };
      }
    }

    const nearExpiry =
      canonical !== null &&
      canonical.exp - now < this.sandboxTimers().credentialGrantReissueBelowMs;
    if (canonical !== null && !nearExpiry) return { grant, adopted: true };

    const ownerId = await this.requireOwner();
    if (ownerId === null) return { grant, adopted: true };
    const canonicalIssuerSessionId = canonical?.issuerSessionId ?? null;
    const routes = await listRoutes(this.db);
    const members: HandoffMemberState[] = await Promise.all(
      proxy.members.map(async member => {
        const route = routes.find(candidate => candidate.sessionId === member.sessionId);
        const active = isActiveScopeMember(member, route, grant);
        let delegationExpiresAt: number | null = null;
        if (active) {
          const peer = this.sessionPeerFor(ownerId, member.sessionId);
          if (peer !== null) {
            try {
              delegationExpiresAt = await withTimeout(
                peer.getRuntimeProxyDelegationExpiresAt({
                  sandboxId: this.sandboxId,
                  directory: grant.directory,
                  kiloSessionId: member.kiloSessionId,
                }),
                this.scopeBackingTokenMs(),
                'Delegation expiry read timed out'
              );
            } catch {
              delegationExpiresAt = null;
            }
          }
        }
        return { ...member, delegationExpiresAt, active };
      })
    );
    const candidate = selectHandoffCandidate({
      canonicalExp: canonical === null ? now : canonical.exp,
      members,
    });
    if (candidate === null) {
      this.logScopeHandleMaintenance(
        grant.scopeId,
        canonical === null ? 'no_live_member' : 'no_extending_member'
      );
      return { grant, adopted: true };
    }
    // A same-issuer mint returns the same handle/exp, so never claim an
    // extension that did not happen. Recovery has no issuer to compare against.
    if (canonicalIssuerSessionId !== null && candidate.sessionId === canonicalIssuerSessionId) {
      this.logScopeHandleMaintenance(grant.scopeId, 'not_needed');
      return { grant, adopted: true };
    }
    const peer = this.sessionPeerFor(ownerId, candidate.sessionId);
    if (peer === null) {
      this.logScopeHandleMaintenance(grant.scopeId, 'mint_failed');
      return { grant, adopted: true };
    }
    const minted = await this.canonicalHandleMints.direct(peer, fence);
    if (minted === null || minted.exp <= now || minted.issuerSessionId !== candidate.sessionId) {
      this.logScopeHandleMaintenance(grant.scopeId, 'mint_failed');
      return { grant, adopted: true };
    }
    if (canonical !== null && minted.exp <= canonical.exp) {
      this.logScopeHandleMaintenance(grant.scopeId, 'mint_failed');
      return { grant, adopted: true };
    }
    const mintedClaims = await verifyRuntimeCredentialProxyHandle(this.env, minted.handle);
    if (mintedClaims === null || mintedClaims.userId !== ownerId) {
      this.logScopeHandleMaintenance(grant.scopeId, 'mint_failed');
      return { grant, adopted: true };
    }

    const updated = setAllMemberHandles(grant, minted.handle);
    const candidateDigest = await digestRuntimeProxyHandle(minted.handle);
    const alreadyAccepted = entries.some(entry =>
      constantTimeEqual(entry.handleDigest, candidateDigest)
    );
    // A same-fence mint through a member that already holds the handle returns
    // the same string, so the rows do not change; the handle must still be
    // accepted or the scope keeps looking adopted without a servable entry.
    if (updated === grant && alreadyAccepted) return { grant, adopted: true };
    if (!alreadyAccepted && entries.length >= ACCEPTED_HANDLES_MAX) {
      this.logScopeHandleMaintenance(grant.scopeId, 'set_full');
      return { grant, adopted: true };
    }
    if (updated !== grant && !(await this.applyCandidateGrantPolicy(updated))) {
      this.logScopeHandleMaintenance(grant.scopeId, 'mint_failed');
      return { grant, adopted: true };
    }
    const entry = {
      handleDigest: candidateDigest,
      handle: minted.handle,
      issuerSessionId: minted.issuerSessionId,
      scopeId: grant.scopeId,
      exp: minted.exp,
      fence,
    };
    let committed = true;
    this.ctx.storage.transactionSync(() => {
      const added = addAcceptedHandleSync(this.ctx.storage.kv, scopeKey, entry, now);
      if (added !== 'added' && added !== 'present') {
        committed = false;
        return;
      }
      if (updated !== grant) writeScopeGrant(this.db, updated);
    });
    if (!committed) {
      this.logScopeHandleMaintenance(grant.scopeId, 'set_full');
      return { grant, adopted: true };
    }
    await this.fanoutCanonicalCredentials(updated, state);
    this.logScopeHandleMaintenance(
      updated.scopeId,
      canonical === null ? 'expired_recovered' : 'rotated'
    );
    return { grant: updated, adopted: true };
  }

  private logScopeHandleMaintenance(
    scopeId: string,
    outcome:
      | 'converged'
      | 'not_needed'
      | 'no_extending_member'
      | 'no_live_member'
      | 'set_full'
      | 'mint_failed'
      | 'rotated'
      | 'expired_recovered'
  ): void {
    logger.withFields({ scopeId, outcome }).info('Control-plane scope handle maintenance');
  }

  /**
   * Sends the current canonical credentials to every ready or preparing member
   * of the scope whose last-sent handle differs. A preparing member is sent but
   * not marked delivered: it may be running an older wrapper that drops the
   * frame, and `session.ready` reconciles that. Frames whose handle is not the
   * current canonical are never sent.
   */
  private async fanoutCanonicalCredentials(
    grant: SessionCredentialGrant,
    state: AllocationState
  ): Promise<void> {
    if (grant.kilo.runtimeProxy === undefined) return;
    const socket = this.boundWrapperSocket(state);
    if (socket === null) return;
    const scopeKey = scopeGrantId(grant);
    for (const route of await listRoutes(this.db)) {
      if (route.state !== 'ready' && route.state !== 'preparing') continue;
      if (route.grant === null || scopeGrantId(route.grant) !== scopeKey) continue;
      const handle = memberHandleForSession(grant, route.sessionId);
      if (handle === null) continue;
      const digest = await digestRuntimeProxyHandle(handle);
      const lastSent = await readLastSentHandleDigest(this.ctx.storage, route.sessionId);
      if (lastSent !== null && constantTimeEqual(lastSent, digest)) continue;
      const sent = this.trySendFrame(socket, {
        type: 'session.credentials',
        ...sessionCredentialsPayloadFromGrant(grant, route.sessionId),
      });
      if (sent && route.state === 'ready') {
        await markLastSentHandle(this.ctx.storage, route.sessionId, digest);
      }
    }
  }

  /** Records the handle a `session.prepare`/`session.credentials` frame carried. */
  private async markRouteCredentialsSent(
    sessionId: string,
    grant: SessionCredentialGrant
  ): Promise<void> {
    const handle = memberHandleForSession(grant, sessionId);
    if (handle === null) return;
    await markLastSentHandle(this.ctx.storage, sessionId, await digestRuntimeProxyHandle(handle));
  }

  /**
   * Reconciliation for an adopted route: send the current canonical when the
   * route's last-sent marker no longer matches its row. It covers a preparing
   * route that missed a fanout (an older wrapper drops credentials frames before
   * it is prepared) and a ready route whose socket was down when a fanout was
   * attempted. A no-op when the strings already agree, so a normal prepare sends
   * nothing extra.
   */
  private async ensureRouteCredentialsCurrent(
    sessionId: string,
    state: AllocationState
  ): Promise<void> {
    const route = await readRoute(this.db, sessionId);
    const grant = route?.grant ?? null;
    if (route === null || grant === null) return;
    const fence = this.runtimeProxyFenceFor(state);
    if (!(await this.isAdoptedScopeAtFence(grant, fence))) return;
    const handle = memberHandleForSession(grant, sessionId);
    if (handle === null) return;
    const digest = await digestRuntimeProxyHandle(handle);
    const lastSent = await readLastSentHandleDigest(this.ctx.storage, sessionId);
    if (lastSent !== null && constantTimeEqual(lastSent, digest)) return;
    const socket = this.boundWrapperSocket(state);
    if (socket === null) return;
    if (
      this.trySendFrame(socket, {
        type: 'session.credentials',
        ...sessionCredentialsPayloadFromGrant(grant, sessionId),
      })
    ) {
      await markLastSentHandle(this.ctx.storage, sessionId, digest);
    }
  }

  /** Whether this route's runtime-proxy handle has verifiably expired. */
  private async routeRuntimeProxyExpired(
    grant: SessionCredentialGrant,
    sessionId: string
  ): Promise<boolean> {
    const handle = memberHandleForSession(grant, sessionId);
    if (handle === null) return false;
    const expiresAt = await verifyRuntimeCredentialProxyHandleExpiresAt(this.env, handle);
    return expiresAt !== null && expiresAt <= Date.now();
  }

  /**
   * The one owner of "is this scope adopted?": a worktree proxy scope with at
   * least one accepted entry under `fence`, including an expired-but-still-stored
   * entry (the adoption marker). Existing allocations retain per-session handles,
   * even when a newer wrapper reconnects or their last scope member leaves.
   */
  private async isAdoptedScopeAtFence(
    grant: SessionCredentialGrant,
    fence: ControlRuntimeCredentialProxyFence | null
  ): Promise<boolean> {
    if (
      fence === null ||
      readRuntimeContract(this.ctx.storage.kv, fence.allocationId) !== 'worktree'
    )
      return false;
    const marker = await hasAcceptedScopeHandle(this.ctx.storage, scopeGrantId(grant), fence);
    return isAdoptableWorktreeScope({ grant, acceptedMarker: marker });
  }

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
    return this.sandboxNamespace(this.providerPin, physicalSandboxId, true)
      .idFromName(physicalSandboxId)
      .toString();
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
   * candidate set) through the provider's contained-credential hook. Runs inside
   * the operation queue and does not stop the sandbox: it returns `false` on
   * failure so callers can decide (retry vs. fail closed). Transient failures
   * keep the route alive so a later send can retry (N2). A live Vercel sandbox
   * whose adapter lacks the hook cannot apply the policy, so it fails closed
   * exactly like a throwing hook.
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
      if (providerRef === null) return true;
      if (!provider.applyContainedCredentials) return false;
      const grants = grantsOverride ?? (await this.activeGrants(Date.now()));
      await withTimeout(
        provider.applyContainedCredentials(providerRef, grants),
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
    await this.writeAllocation(next, state);
    await this.armAlarm(next);
  }

  private async applyRouteEffects(
    previous: AllocationState,
    next: AllocationState,
    event: AllocationEvent,
    stopReason: ControlPlaneFailureReason | undefined
  ): Promise<void> {
    if (previous.allocationId !== null && previous.allocationId !== next.allocationId) {
      this.db.transaction(tx => retireScopeGrants(tx, this.ctx.storage.kv));
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
      const restarted = previous.wrapperId !== null && previous.wrapperId !== next.wrapperId;
      if (restarted) {
        // A new wrapper instance supersedes the previous fence's accepted
        // handles and every member's stored handle string. Retire both before
        // the bind/adoption scan so a handle minted for the new fence during the
        // scan is not deleted by this.
        this.ctx.storage.transactionSync(() => {
          retireAcceptedHandlesSync(this.ctx.storage.kv);
          for (const grant of listScopeGrants(this.db)) {
            const cleared = clearRuntimeProxyMembers(grant);
            if (cleared !== grant) writeScopeGrant(this.db, cleared);
          }
        });
      }
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
        } catch (error) {
          await failCurrentAttempt(
            this.routeContext(next),
            route.sessionId,
            route.attemptId,
            'workspace_setup_failed',
            admissionFailureStage(error, 'runtime_proxy_bind_failed')
          );
        }
      }
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
    this.db.transaction(tx => retireScopeGrants(tx, this.ctx.storage.kv));
    // `create-failed` with no retry, a confirmed stop and `provider-gone` can
    // all reach `stopped` without arming an alarm, so sweep expired routes now.
    await failExpiredRoutes(ctx);
    if (previous.kind !== 'stopping') {
      // A direct `provider-gone` keeps ready routes; they lose the sandbox.
      await dropReadyRoutes(ctx, 'sandbox_lost');
    }
    // A preparing route with attempt time left keeps its deadline across the
    // reallocation (spec §6).
    const launch = await readRepositoryLaunch(this.ctx.storage);
    if (
      next.unconfirmedProviderRef !== null &&
      launch?.allocationId === previous.allocationId &&
      launch.preparationFailures !== undefined
    ) {
      for (const route of await listRoutes(this.db)) {
        if (route.state !== 'preparing') continue;
        await onRouteFailed(
          ctx,
          route.sessionId,
          'workspace_setup_failed',
          launch.preparationFailures.find(
            failure =>
              failure.sessionId === route.sessionId && failure.attemptId === route.attemptId
          )?.subtype,
          true
        );
      }
    }
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
    if (route.grant.kilo.runtimeProxy !== undefined) {
      // R1: minting the runtime credential proxy handle is a Session DO call that
      // must stay off this DO's serial queue; the frame is sent once the handle
      // is minted and bound. A mint failure fails the attempt closed.
      this.ctx.waitUntil(this.sendSessionPrepareWithRuntimeProxy(route.sessionId, route.attemptId));
      return;
    }
    let spec: ControlPlaneRouteSpec;
    try {
      spec = this.materializePrepareFrame(route, socket);
    } catch (error) {
      this.logPrepareFrameMaterializationFailure(route, error);
      this.ctx.waitUntil(
        this.failPrepareAttempt(
          route.sessionId,
          route.attemptId,
          materializationStage(error)
        ).catch(() => {
          logger
            .withFields({
              sandboxId: this.sandboxId,
              sessionId: route.sessionId,
              attemptId: route.attemptId,
            })
            .warn('Could not persist frame materialization failure');
        })
      );
      return;
    }
    // The frame carries the wrapper-safe spec plus the issued credential
    // material only; the credential source stays DO-private.
    this.trySendFrame(socket, {
      type: 'session.prepare',
      spec,
      credentials: this.prepareCredentials(route.grant, route.sessionId),
    });
  }

  /** Whether the bound wrapper advertised that it redacts named secret keys. */
  private wrapperRedactsNamedSecrets(socket: WebSocket): boolean {
    return this.readAttachment(socket)?.redactsNamedSecrets === true;
  }

  /**
   * A failure throws rather than sending a frame the wrapper would drop while the
   * route waits out its preparation deadline.
   */
  private materializePrepareFrame(route: RouteRecord, socket: WebSocket): ControlPlaneRouteSpec {
    const encryptedSecrets = route.credentialSource?.encryptedSecrets;
    try {
      const frameEnv = buildFrameEnv({
        specEnv: route.spec.env,
        encryptedSecrets,
        privateKey: this.env.AGENT_ENV_VARS_PRIVATE_KEY,
      });
      // Fail closed only when a secret value would actually reach the frame and
      // the wrapper cannot redact it by name; a snapshot whose keys are all
      // restored or dropped sends nothing and needs no redaction.
      if (frameEnv.secretEnvKeys.length > 0 && !this.wrapperRedactsNamedSecrets(socket)) {
        throw new PrepareFrameMaterializationError('wrapper_redaction_unsupported');
      }
      const mcp = this.materializeRouteMcp(route);
      if (frameEnv.secretEnvKeys.length > 0) {
        logger
          .withFields({
            sandboxId: this.sandboxId,
            sessionId: route.sessionId,
            secretCount: frameEnv.secretEnvKeys.length,
          })
          .info('Materialized session.prepare secrets');
      }
      const spec = runtimeSpecForContract(
        route.spec,
        readRuntimeContract(this.ctx.storage.kv, this.readAttachment(socket)?.allocationId ?? null)
      );
      return controlPlaneRouteSpecSchema.parse({
        ...spec,
        createdOnPlatform: route.credentialSource?.createdOnPlatform,
        ...(frameEnv.env === undefined ? {} : { env: frameEnv.env }),
        ...(mcp === undefined ? {} : { mcp }),
        ...(frameEnv.secretEnvKeys.length === 0 ? {} : { secretEnvKeys: frameEnv.secretEnvKeys }),
        ...(captureRequested(route, this.provider) ? { capture: true as const } : {}),
      });
    } catch (error) {
      if (error instanceof PrepareFrameMaterializationError) throw error;
      // Preserve the sanitized, bounded MCP reason for diagnosis.
      if (error instanceof McpAttachValidationError) {
        logger
          .withFields({
            sandboxId: this.sandboxId,
            sessionId: route.sessionId,
            reason: error.reason,
          })
          .warn('MCP materialization failed before session.prepare');
      }
      throw new PrepareFrameMaterializationError(
        'frame_materialization_failed',
        errorClassName(error)
      );
    }
  }

  /** One sanitized failure line: stage, error class and secret count only. */
  private logPrepareFrameMaterializationFailure(route: RouteRecord, error: unknown): void {
    const encrypted = route.credentialSource?.encryptedSecrets;
    logger
      .withFields({
        sandboxId: this.sandboxId,
        sessionId: route.sessionId,
        attemptId: route.attemptId,
        stage: materializationStage(error),
        secretCount: encrypted === undefined ? 0 : Object.keys(encrypted).length,
        errorClass:
          error instanceof PrepareFrameMaterializationError
            ? (error.sourceErrorName ?? error.name)
            : errorClassName(error),
      })
      .warn('session.prepare frame materialization failed');
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
   * Runtime credential proxy: mint the handle through the Session DO (bounded by
   * the grant bound, fence passed in), bind it for Vercel, then send
   * `session.prepare`. Runs off the serial queue; a mint or bind failure fails
   * the fenced attempt as `workspace_setup_failed`. An adopted worktree scope
   * routes through the canonical-handle path instead.
   */
  private async sendSessionPrepareWithRuntimeProxy(
    sessionId: string,
    attemptId: string
  ): Promise<void> {
    try {
      const route = await readRoute(this.db, sessionId);
      if (!isCurrentPreparingAttempt(route, attemptId)) return;
      if (route.grant === null || route.grant.kilo.runtimeProxy === undefined) return;
      // One owner per sandbox (B3 review 5), stored on first prepare/registration;
      // the Session DO name is `ownerId:sessionId`.
      const ownerId = await this.requireOwner();
      const peer = ownerId === null ? null : this.sessionPeerFor(ownerId, sessionId);
      const fence = this.runtimeProxyFenceFor(await this.readAllocation());

      if (fence !== null && (await this.isAdoptedScopeAtFence(route.grant, fence))) {
        const outcome = await this.sendSessionPrepareWithAdoptedScope({
          route,
          sessionId,
          attemptId,
          ownerId,
          peer,
          fence,
        });
        if (outcome === 'done') return;
      }

      await this.sendSessionPrepareWithPerSessionHandle({
        route,
        sessionId,
        attemptId,
        ownerId,
        peer,
        fence,
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

  /**
   * The per-session path: mint through the requesting member, bind when the
   * stored handle is stale, then send. Used for legacy grants, non-worktree
   * scopes, migration scopes, and an adopted scope the claim re-check rejects.
   */
  private async sendSessionPrepareWithPerSessionHandle(input: {
    route: RouteRecord;
    sessionId: string;
    attemptId: string;
    ownerId: string | null;
    peer: ControlPlaneSessionPeer | null;
    fence: ControlRuntimeCredentialProxyFence | null;
  }): Promise<void> {
    const { sessionId, attemptId, ownerId, peer, fence } = input;
    let route = input.route;
    const member = route.grant?.kilo.runtimeProxy?.members.find(
      candidate => candidate.sessionId === sessionId
    );
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
        const refreshed = await readRoute(this.db, sessionId);
        if (!isCurrentPreparingAttempt(refreshed, attemptId)) return;
        if (refreshed.grant === null || refreshed.grant.kilo.runtimeProxy === undefined) return;
        route = refreshed;
      }
      mintedFence = fence;
    }

    await this.sendPreparedRouteFrame(sessionId, attemptId, mintedFence);
  }

  /**
   * Canonical adoption: one accepted handle per worktree scope. The first
   * prepare mints through its requesting member (single-flight so concurrent
   * preparers share one mint); a joiner copies the canonical string; a candidate
   * only replaces a canonical when it can be served and expires later. The mint
   * stays off the serial queue; claim/adopt runs on it. Returns `per-session`
   * when the scope must fall back to the legacy path.
   */
  private async sendSessionPrepareWithAdoptedScope(input: {
    route: RouteRecord;
    sessionId: string;
    attemptId: string;
    ownerId: string | null;
    peer: ControlPlaneSessionPeer | null;
    fence: ControlRuntimeCredentialProxyFence | null;
  }): Promise<'done' | 'per-session'> {
    const { route, sessionId, attemptId, ownerId, peer, fence } = input;
    const grant = route.grant;
    if (grant === null || grant.kilo.runtimeProxy === undefined) return 'done';
    if (fence === null || ownerId === null || peer === null) return 'per-session';
    const now = Date.now();
    const threshold = this.sandboxTimers().credentialGrantReissueBelowMs;
    const canonical = await this.selectCanonicalForScope(grant, fence, sessionId);
    const needsMint = canonical === null || !canonical.usable || canonical.exp - now < threshold;
    const mintKey = canonicalMintKey(scopeGrantId(grant), fence);
    let candidate = needsMint ? await this.canonicalHandleMints.shared(mintKey, peer, fence) : null;
    if (needsMint && candidate === null) {
      candidate = await this.canonicalHandleMints.direct(peer, fence);
    }
    let claim = await this.claimAdoptedScopeHandle({
      sessionId,
      attemptId,
      ownerId,
      kiloSessionId: route.spec.kiloSessionId,
      candidate,
      mintFence: fence,
    });
    if (claim.kind === 'per-session') return 'per-session';
    if (claim.kind === 'remint') {
      const own = await this.canonicalHandleMints.direct(peer, fence);
      claim = await this.claimAdoptedScopeHandle({
        sessionId,
        attemptId,
        ownerId,
        kiloSessionId: route.spec.kiloSessionId,
        candidate: own,
        mintFence: fence,
      });
      if (claim.kind === 'per-session') return 'per-session';
      // A remint that still cannot mint leaves no handle to serve.
      if (claim.kind === 'remint') claim = { kind: 'fail' };
    }
    if (claim.kind === 'stale') return 'done';
    if (claim.kind === 'fail') {
      await this.failPrepareAttempt(sessionId, attemptId);
      return 'done';
    }
    await this.sendPreparedRouteFrame(sessionId, attemptId, fence);
    return 'done';
  }

  /**
   * Sends `session.prepare` for a preparing route, re-reading the route and the
   * allocation from one read so a restart between adoption and send cannot
   * deliver a stale handle.
   */
  private async sendPreparedRouteFrame(
    sessionId: string,
    attemptId: string,
    expectedFence: ControlRuntimeCredentialProxyFence | null
  ): Promise<void> {
    const state = await this.readAllocation();
    const socket = this.boundWrapperSocket(state);
    if (socket === null) return;
    const latest = await readRoute(this.db, sessionId);
    if (!isCurrentPreparingAttempt(latest, attemptId)) return;
    if (latest.grant === null || latest.grant.kilo.runtimeProxy === undefined) return;
    if (expectedFence !== null) {
      const sendFence = this.runtimeProxyFenceFor(state);
      if (sendFence === null || !sameRuntimeProxyControlBinding(expectedFence, sendFence)) return;
    }
    let spec: ControlPlaneRouteSpec;
    try {
      spec = this.materializePrepareFrame(latest, socket);
    } catch (error) {
      this.logPrepareFrameMaterializationFailure(latest, error);
      await this.failPrepareAttempt(sessionId, attemptId, materializationStage(error));
      return;
    }
    const sent = this.trySendFrame(socket, {
      type: 'session.prepare',
      spec,
      credentials: this.prepareCredentials(latest.grant, sessionId),
    });
    if (sent) await this.markRouteCredentialsSent(sessionId, latest.grant);
  }

  /**
   * Claims and commits the handle for one preparing route on the serial queue.
   * Every authorization and policy check runs before the accepted entry and the
   * requesting member's row commit together in one `transactionSync`, so a
   * failed check leaves no orphan. Returns `per-session` when the scope must
   * fall back, `remint` when a shared mint cannot bind for this requestor.
   */
  private claimAdoptedScopeHandle(input: {
    sessionId: string;
    attemptId: string;
    ownerId: string;
    kiloSessionId: string;
    candidate: CanonicalHandleMint | null;
    mintFence: ControlRuntimeCredentialProxyFence;
  }): Promise<ScopeHandleClaim> {
    return this.enqueue(async () => {
      const route = await readRoute(this.db, input.sessionId);
      if (!isCurrentPreparingAttempt(route, input.attemptId)) return { kind: 'stale' };
      const grant = route.grant;
      if (grant === null || grant.kilo.runtimeProxy === undefined) return { kind: 'stale' };
      const allocation = await this.readAllocation();
      const fence = this.runtimeProxyFenceFor(allocation);
      if (fence === null) return { kind: 'stale' };
      const scopeKey = scopeGrantId(grant);
      const now = Date.now();
      if (grant.expiresAt <= now) return { kind: 'fail' };

      const entries = await listAcceptedHandlesForScope(this.ctx.storage, scopeKey, fence, now);
      const acceptedDigests = new Set(entries.map(entry => entry.handleDigest));
      const marker = await hasAcceptedScopeHandle(this.ctx.storage, scopeKey, fence);
      if (
        readRuntimeContract(this.ctx.storage.kv, fence.allocationId) !== 'worktree' ||
        !isAdoptableWorktreeScope({ grant, acceptedMarker: marker })
      ) {
        return { kind: 'per-session' };
      }

      let candidate = input.candidate;
      const staleFence =
        candidate !== null && !sameRuntimeProxyControlBinding(input.mintFence, fence);
      if (staleFence) candidate = null;
      const canonical = await this.selectCanonicalForScope(grant, fence, input.sessionId);
      const choice = decideCanonicalHandle({
        canonical: canonical === null ? null : { handle: canonical.handle, exp: canonical.exp },
        canonicalUsable: canonical?.usable ?? false,
        candidate,
        now,
        thresholdMs: this.sandboxTimers().credentialGrantReissueBelowMs,
      });

      let finalHandle: string | null = null;
      let adoptCandidate = false;
      let candidateDigest: string | null = null;
      if (choice.action === 'keep-canonical') {
        finalHandle = choice.handle;
      } else if (choice.action === 'adopt-candidate' && candidate !== null) {
        candidateDigest = await digestRuntimeProxyHandle(candidate.handle);
        const present = acceptedDigests.has(candidateDigest);
        if (!present && entries.length >= ACCEPTED_HANDLES_MAX) {
          // The set is full: keep serving a valid canonical if there is one.
          if (canonical !== null && canonical.usable && canonical.exp > now) {
            finalHandle = canonical.handle;
          }
        } else {
          finalHandle = candidate.handle;
          adoptCandidate = true;
        }
      }
      if (finalHandle === null) {
        if (staleFence) return { kind: 'stale' };
        // The canonical became unusable between the off-queue mint decision and
        // this queued claim (a release of its issuer won the queue). Remint
        // through the requestor rather than failing on a transient condition.
        if (candidate === null) return { kind: 'remint' };
        return { kind: 'fail' };
      }

      // Adopting a candidate that outlives the canonical replaces the scope's
      // canonical string; an already-adopted scope whose canonical has ended
      // (marker present, no live canonical) has no canonical to keep either. In
      // both cases every member row converges on the new handle. A first mint in
      // a scope that was never adopted, or a candidate minted only because this
      // requestor cannot be served by a still-valid canonical, writes only the
      // requestor's row.
      const replacingCanonical =
        adoptCandidate &&
        (canonical !== null ? candidate !== null && candidate.exp > canonical.exp : marker);
      const seeded = withMemberHandle(grant, finalHandle, {
        sessionId: input.sessionId,
        kiloSessionId: input.kiloSessionId,
      });
      const updated =
        adoptCandidate && replacingCanonical ? setAllMemberHandles(seeded, finalHandle) : seeded;
      if (updated === grant) return { kind: 'handle', handle: finalHandle };

      const claims = await verifyRuntimeCredentialProxyHandle(this.env, finalHandle);
      if (!claims || claims.userId !== input.ownerId) return { kind: 'fail' };
      const issuerIsMember = grant.members.some(member => member.sessionId === claims.sessionId);
      if (claims.sessionId !== input.sessionId && !issuerIsMember) {
        return adoptCandidate ? { kind: 'remint' } : { kind: 'fail' };
      }
      if (!adoptCandidate) {
        const match = await lookupAcceptedHandle(this.ctx.storage, finalHandle, fence, now);
        if (match === undefined || match.scopeGrantId !== scopeKey) return { kind: 'fail' };
      }
      if (!(await this.applyCandidateGrantPolicy(updated))) return { kind: 'fail' };

      const entry =
        adoptCandidate && candidate !== null && candidateDigest !== null
          ? {
              handleDigest: candidateDigest,
              handle: finalHandle,
              issuerSessionId: candidate.issuerSessionId,
              scopeId: grant.scopeId,
              exp: candidate.exp,
              fence,
            }
          : null;
      let committed = true;
      this.ctx.storage.transactionSync(() => {
        if (entry !== null) {
          const added = addAcceptedHandleSync(this.ctx.storage.kv, scopeKey, entry, now);
          if (added !== 'added' && added !== 'present') {
            committed = false;
            return;
          }
        }
        writeScopeGrant(this.db, updated);
      });
      if (!committed) return { kind: 'fail' };
      // The candidate replaced an existing canonical for every member: push it
      // to the members already serving the previous string.
      if (adoptCandidate && replacingCanonical) {
        await this.fanoutCanonicalCredentials(updated, allocation);
      }
      return { kind: 'handle', handle: finalHandle };
    });
  }

  /**
   * The adopted handle a scope is already serving for the current fence, matched
   * by the digest of a current member's stored string. This is the single
   * canonical selector for both prepare and maintenance. Prefer the max-exp entry
   * a current member can actually serve (its issuer is still a member, or the
   * requestor already holds it); only when none is usable fall back to the
   * max-exp entry. A departed issuer's long-lived handle therefore does not force
   * every joiner to mint another requestor-only handle.
   */
  private async selectCanonicalForScope(
    grant: SessionCredentialGrant,
    fence: ControlRuntimeCredentialProxyFence,
    requestorSessionId: string | null
  ): Promise<CanonicalHandleState | null> {
    const members = grant.kilo.runtimeProxy?.members ?? [];
    if (members.length === 0) return null;
    const entries = await listAcceptedHandlesForScope(this.ctx.storage, scopeGrantId(grant), fence);
    if (entries.length === 0) return null;
    const handlesByDigest = new Map<string, string>();
    for (const member of members) {
      handlesByDigest.set(await digestRuntimeProxyHandle(member.handle), member.handle);
    }
    let bestUsable: CanonicalHandleState | null = null;
    let bestAny: CanonicalHandleState | null = null;
    for (const entry of entries) {
      const handle = handlesByDigest.get(entry.handleDigest);
      if (handle === undefined) continue;
      const claims = await verifyRuntimeCredentialProxyHandle(this.env, handle);
      if (claims === null) continue;
      const requestorHolds =
        requestorSessionId !== null &&
        members.some(member => member.sessionId === requestorSessionId && member.handle === handle);
      const issuerIsMember = grant.members.some(member => member.sessionId === claims.sessionId);
      const state: CanonicalHandleState = {
        handle,
        exp: entry.exp,
        issuerSessionId: claims.sessionId,
        usable: requestorHolds || issuerIsMember,
      };
      if (bestAny === null || state.exp > bestAny.exp) bestAny = state;
      if (state.usable && (bestUsable === null || state.exp > bestUsable.exp)) bestUsable = state;
    }
    return bestUsable ?? bestAny;
  }

  private async runtimeProxyHandleClaims(
    handle: string
  ): Promise<{ exp: number; sessionId: string } | null> {
    const claims = await verifyRuntimeCredentialProxyHandle(this.env, handle);
    return claims === null ? null : { exp: claims.exp, sessionId: claims.sessionId };
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
  private async failPrepareAttempt(
    sessionId: string,
    attemptId: string,
    stage = 'prepare_dispatch_failed'
  ): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.readAllocation();
      await failCurrentAttempt(
        this.routeContext(state),
        sessionId,
        attemptId,
        'workspace_setup_failed',
        stage
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
        const pin = this.providerPin ?? this.defaultPin('cloudflare');
        const startupCommand = preinstalledStartup();
        const launchEnv = await this.wrapperLaunchEnv(credential, allocationId, pin.provider);
        if (pin.billing) {
          await assertContainerCapacity(this.env, {
            subject: pin.billing.subject,
            actor: pin.billing.actor,
            instanceId: pin.billing.sandboxId,
            checkpoint: 'control-plane-create',
            billingOrigin: pin.billing.metadata?.origin,
          });
        }
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
                : this.sandboxNamespace(
                    pin,
                    intent.allocationName ?? this.sandboxId,
                    this.credentialContainmentEnabled()
                  )
                    .idFromName(intent.allocationName ?? this.sandboxId)
                    .toString();
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
        const launch = repositoryLaunchOptions(
          await listRoutes(this.db),
          await readRepositoryLaunch(this.ctx.storage)
        );
        logControlDiagnostic('snapshot_launch', {
          sandboxId: this.sandboxId,
          allocationId,
          reason: launch.reason,
          preparingRoutes: launch.preparingRouteCount,
          distinctKeys: launch.distinctKeyCount,
          skip: launch.skipped,
          repoKey: launch.options.repoKey?.slice(0, 16),
        });
        if (launch.skipped) {
          await notifyPreparingRoutes(this.routeContext(current), {
            step: 'snapshot_fallback',
            detail: 'Previous snapshot startup failed. Retrying without a snapshot.',
          });
        }
        // Persist a placeholder before the launch so a `hello` accepted while it
        // runs confirms this allocation, and that confirmation outlives the
        // allocation stopping before the launch resolves.
        await beginRepositoryLaunch(this.ctx.storage, allocationId, launch.skipped);
        if (Date.now() >= launchDeadline) throw new Error('Sandbox launch timed out');
        const launchOptions = {
          ...launch.options,
          ...(pin.provider === 'cloudflare-containers' ? { deadlineAt: launchDeadline } : {}),
        };
        let launched = await withTimeout(
          this.provider.launch(
            createdRef,
            { command: startupCommand, env: launchEnv },
            launchOptions
          ),
          remainingMs(launchDeadline),
          'Sandbox launch timed out'
        );
        if (launched.snapshotFailed) {
          const imageCredential = generateSandboxCredential();
          const imageLaunchEnv = await this.wrapperLaunchEnv(
            imageCredential,
            allocationId,
            pin.provider
          );
          const imageCredentialHash = await hashSandboxCredential(imageCredential);
          const ownsCleanup = await this.enqueue(async () => {
            const latest = await this.readAllocation();
            if (latest.kind !== 'creating' || latest.allocationId !== allocationId) return false;
            if (Date.now() >= launchDeadline) throw new Error('Sandbox launch timed out');
            await this.ctx.storage.put(CREDENTIAL_HASH_KEY, imageCredentialHash);
            return true;
          });
          if (!ownsCleanup) {
            await this.recordLaunch(allocationId, launched.startSource);
            return;
          }
          if (Date.now() >= launchDeadline) throw new Error('Sandbox launch timed out');
          const confirmed = await withTimeout(
            this.stopRef(createdRef, allocationId),
            remainingMs(launchDeadline),
            'Sandbox cleanup stop timed out'
          );
          if (!confirmed) throw new Error('Sandbox snapshot cleanup failed');
          const afterCleanup = await this.readAllocation();
          if (afterCleanup.kind !== 'creating' || afterCleanup.allocationId !== allocationId)
            return;
          if (Date.now() >= launchDeadline) throw new Error('Sandbox launch timed out');
          logControlDiagnostic('snapshot_fallback', {
            sandboxId: this.sandboxId,
            allocationId,
            reason: 'repository_start_failed',
          });
          await notifyPreparingRoutes(this.routeContext(afterCleanup), {
            step: 'snapshot_fallback',
            detail: 'Snapshot startup failed. Retrying without a snapshot.',
          });
          await notifyPreparingRoutes(this.routeContext(afterCleanup), {
            step: 'sandbox_start',
            detail: 'Starting sandbox without a snapshot',
          });
          launched = await withTimeout(
            this.provider.launch(
              createdRef,
              { command: startupCommand, env: imageLaunchEnv },
              {
                ...launch.options,
                skipRepository: true,
                deadlineAt: launchDeadline,
              }
            ),
            remainingMs(launchDeadline),
            'Sandbox launch timed out'
          );
          if (launched.snapshotFailed) throw new Error('Sandbox image launch failed');
        }
        await this.recordLaunch(allocationId, launched.startSource);
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
        const capacityFailure = getContainerCapacityFailureReason(error);
        if (capacityFailure) {
          await this.failCreationRoutes(allocationId, false, capacityFailure);
          return;
        }
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
      await this.enqueue(() => this.recoverRepositoryPreparationFailures());
    }
  }

  /**
   * Remember how this allocation's container started. A wrapper that connected
   * while a slow launch was still returning has already confirmed the start
   * through the placeholder `beginRepositoryLaunch` wrote, so keep that
   * confirmation even if the allocation has since stopped.
   *
   * Emits one `snapshot_start` diagnostic per allocation so `image` vs
   * `repository` is durable evidence of whether a snapshot was actually used.
   */
  private async recordLaunch(
    allocationId: string,
    startSource: ProviderStartSource
  ): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.readAllocation();
      const connected =
        state.allocationId === allocationId &&
        (state.kind === 'connected' || state.kind === 'disconnected');
      const existing = await readRepositoryLaunch(this.ctx.storage);
      if (existing?.allocationId !== allocationId) return;
      const confirmed = connected || existing.confirmed;
      await recordRepositoryLaunch(this.ctx.storage, {
        allocationId,
        startSource,
        confirmed,
        ...(existing.preparationFailures === undefined
          ? {}
          : { preparationFailures: existing.preparationFailures }),
      });
      logControlDiagnostic('snapshot_start', {
        sandboxId: this.sandboxId,
        allocationId,
        source: startSource,
        confirmed,
      });
    });
  }

  private async recoverRepositoryPreparationFailures(): Promise<void> {
    if (this.createInFlight) return;
    const state = await this.readAllocation();
    if (state.kind !== 'connected' && state.kind !== 'disconnected') return;
    const launch = await readRepositoryLaunch(this.ctx.storage);
    if (launch?.allocationId !== state.allocationId) return;
    for (const failure of launch.preparationFailures ?? []) {
      const route = await readRoute(this.db, failure.sessionId);
      if (!isCurrentPreparingAttempt(route, failure.attemptId)) continue;
      if (await this.retryRepositoryPreparation(state, failure)) return;
      await onRouteFailed(
        this.routeContext(state),
        failure.sessionId,
        'workspace_setup_failed',
        failure.subtype,
        true
      );
    }
  }

  private async retryRepositoryPreparation(
    state: AllocationState,
    failure: RepositoryPreparationFailure
  ): Promise<boolean> {
    const launch = await readRepositoryLaunch(this.ctx.storage);
    if (launch === undefined || launch.allocationId !== state.allocationId) return false;
    if (launch.startSource === 'image' || launch.skipRepository === true) return false;
    const routes = await listRoutes(this.db);
    const route = routes.find(candidate => candidate.sessionId === failure.sessionId);
    if (
      route === undefined ||
      !isCurrentPreparingAttempt(route, failure.attemptId) ||
      route.repoKey === null ||
      route.attemptDeadlineAt <= Date.now() ||
      routes.some(candidate => candidate.state === 'ready')
    )
      return false;
    const preparationFailures = launch.preparationFailures ?? [];
    if (
      !preparationFailures.some(
        candidate =>
          candidate.sessionId === failure.sessionId && candidate.attemptId === failure.attemptId
      )
    ) {
      await recordRepositoryLaunch(this.ctx.storage, {
        ...launch,
        preparationFailures: [...preparationFailures, failure],
      });
    }
    if (this.createInFlight) return true;
    logControlDiagnostic('snapshot_fallback', {
      sandboxId: this.sandboxId,
      allocationId: state.allocationId,
      sessionId: failure.sessionId,
      reason: 'repository_preparation_failed',
      subtype: failure.subtype,
    });
    await this.applyEvent({
      type: 'stop-requested',
      at: Date.now(),
      reason: 'workspace_setup_failed',
    });
    return true;
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
    await this.billingRuntime.settleStoppedCreatedRef(ref, confirmed);
  }

  /**
   * Fail-closed cleanup for an unconfirmed Vercel stop: fails the preparing
   * routes and the creating allocation. Runs inside the alarm's serial queue,
   * so it must not enqueue.
   */
  private async failUnconfirmedVercelCleanup(state: AllocationState): Promise<void> {
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
      await deleteRoute(this.db, this.ctx.storage.kv, sessionId);
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
    ).catch(error => {
      logControlDiagnostic(
        'lease_renewal_failed',
        {
          allocationName: this.providerPin?.allocationName ?? this.sandboxId,
          allocationId: state.allocationId,
          errorName: error instanceof Error ? diagnosticCause(error.name) : 'unknown',
          cause: error instanceof Error ? diagnosticCause(error.message) : 'unknown',
        },
        'warn'
      );
    });
  }

  private async runCloseSocket(state: AllocationState): Promise<void> {
    if (state.allocationId === null || state.connectionId === null) return;
    if (
      [...this.repositoryCaptures.values()].some(
        capture => capture.allocationId === state.allocationId && capture.ok === undefined
      )
    )
      return;
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
      if (
        !acceptRuntimeContract(
          this.ctx.storage.kv,
          frame.allocationId,
          attachment?.runtimeCapability
        )
      ) {
        this.sendFrame(ws, { type: 'shutdown', reason: 'hello_rejected' });
        ws.close(1008, 'Runtime contract mismatch');
        return;
      }
      const connectionId = crypto.randomUUID();
      this.releaseBoundSockets(ws, frame.allocationId);
      ws.serializeAttachment({
        credential,
        allocationId: frame.allocationId,
        connectionId,
        wrapperId: frame.wrapperId,
        ...(attachment?.runtimeCapability
          ? { runtimeCapability: attachment.runtimeCapability }
          : {}),
        ...(frame.heartbeatAck ? { heartbeatAck: true } : {}),
        ...(frame.redactsNamedSecrets ? { redactsNamedSecrets: true } : {}),
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
      await confirmRepositoryLaunch(this.ctx.storage, frame.allocationId);
      for (const [sessionId, capture] of this.repositoryCaptures) {
        if (capture.allocationId === frame.allocationId && capture.ok !== undefined) {
          this.trySendFrame(ws, { type: 'workspace.captured', sessionId, ok: capture.ok });
        }
      }
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
      const state = await this.readAllocation();
      if (!connectionMatches(state, attachment.allocationId, attachment.connectionId)) return;
      const at = Date.now();
      await this.applyEvent({
        type: 'heartbeat',
        at,
        allocationId: attachment.allocationId,
        connectionId: attachment.connectionId,
        active: frame.active,
      });
      if (
        !frame.active &&
        state.lastActivityAt !== null &&
        at >= state.lastActivityAt + this.sandboxIdleTimeoutMs(state)
      ) {
        await this.applyEvent({ type: 'stop-requested', at, reason: 'sandbox_stopped' });
      }
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
        if (current) this.repositoryCaptures.delete(frame.sessionId);
        if (frame.workspace !== undefined) {
          logger
            .withFields({ sessionId: frame.sessionId, workspace: frame.workspace })
            .info('Control-plane workspace ready');
        }
        // Reconcile credentials for an adopted route that missed a fanout before
        // it is published ready. This handler already runs on the serial queue,
        // so a rotation cannot land between the resend and the transition.
        if (current) {
          await this.ensureRouteCredentialsCurrent(frame.sessionId, currentState);
        }
        await onRouteReady(ctx, frame.sessionId, current);
        return;
      case 'workspace.capture':
        this.startRepositoryCapture(frame, currentState, current);
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
        if (current && frame.reason === 'workspace_setup_failed') {
          const route = await readRoute(this.db, frame.sessionId);
          if (
            route?.state === 'preparing' &&
            (await this.retryRepositoryPreparation(currentState, {
              sessionId: frame.sessionId,
              attemptId: route.attemptId,
              ...(frame.subtype === undefined ? {} : { subtype: frame.subtype }),
            }))
          )
            return;
        }
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

  /**
   * Runs a wrapper's capture request off the serial queue: the snapshot of unknown
   * duration must not hold up routes, frames or a stop. The wrapper always gets an
   * answer, `ok: false` when nothing was saved, so it never waits out its backstop
   * for a capture the DO already knows will not happen.
   */
  private startRepositoryCapture(
    frame: Extract<ControlPlaneWrapperFrame, { type: 'workspace.capture' }>,
    state: AllocationState,
    current: boolean
  ): void {
    if (!current || this.repositoryCaptures.has(frame.sessionId)) return;
    this.repositoryCaptures.set(frame.sessionId, { allocationId: state.allocationId });
    this.ctx.waitUntil(
      this.runRepositoryCapture(frame, state).finally(async () => {
        await this.enqueue(async () => this.armAlarm(await this.readAllocation()));
      })
    );
  }

  private async runRepositoryCapture(
    frame: Extract<ControlPlaneWrapperFrame, { type: 'workspace.capture' }>,
    state: AllocationState
  ): Promise<void> {
    let ok = false;
    let reason = 'threw';
    let repoKeyPrefix: string | undefined;
    try {
      const route = await readRoute(this.db, frame.sessionId);
      repoKeyPrefix = route?.repoKey?.slice(0, 16) ?? undefined;
      const provider = this.provider;
      const timers = CONTROL_PLANE_TIMERS.wrapper;
      const captureBudgetMs =
        Math.max(REPOSITORY_CAPTURE_CALL_MS, timers.captureMs) +
        timers.kiloRuntimeStartMs +
        timers.kiloSessionMs;
      if (route === null) reason = 'no_route';
      else if (route.state !== 'preparing') reason = 'route_not_preparing';
      else if (route.repoKey === null) reason = 'no_repo_key';
      else if (provider.captureRepository === undefined) reason = 'provider_no_capture';
      else if (state.providerRef === null) reason = 'no_provider_ref';
      else if (route.attemptDeadlineAt - Date.now() <= captureBudgetMs)
        reason = 'insufficient_preparation_budget';
      else {
        reason = 'capture_declined';
        ok = await withTimeout(
          provider.captureRepository(state.providerRef, route.repoKey, frame.commit),
          REPOSITORY_CAPTURE_CALL_MS,
          'Repository capture timed out'
        );
        if (ok) reason = 'captured';
      }
    } catch {
      ok = false;
      reason = 'threw';
    }
    logControlDiagnostic('snapshot_capture', {
      sandboxId: this.sandboxId,
      sessionId: frame.sessionId,
      allocationId: state.allocationId,
      ok,
      reason,
      repoKey: repoKeyPrefix,
      commit: frame.commit,
    });
    const latest = await this.readAllocation();
    if (latest.allocationId !== state.allocationId) return;
    const capture = this.repositoryCaptures.get(frame.sessionId);
    if (capture?.allocationId !== state.allocationId) return;
    capture.ok = ok;
    const socket = this.boundWrapperSocket(latest);
    if (socket === null) return;
    this.trySendFrame(socket, { type: 'workspace.captured', sessionId: frame.sessionId, ok });
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
    allocationId: string,
    provider: AgentSandboxProvider
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
        provider,
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
    return this.billingRuntime.admitCreate(pin);
  }

  private async admitShadowAfterVercelBillingException(pin: StoredProviderPin): Promise<boolean> {
    return this.billingRuntime.admitShadow(pin);
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
    await this.billingRuntime.recordLifetime(evidence);
  }

  private async afterVercelBillingTransition(event: AllocationEvent): Promise<void> {
    await this.billingRuntime.afterTransition(event);
  }

  private async runBillingAlarm(): Promise<void> {
    await this.billingRuntime.runAlarm();
  }

  private async deferVercelBilling(generation: string, callback: string): Promise<void> {
    await this.billingRuntime.defer(generation, callback);
  }

  private ensureVercelBillingRuntime() {
    return this.billingRuntime.ensureRuntime();
  }

  private createProviderAdapter(pin: StoredProviderPin): ProviderAdapter {
    const allocationName = pin.allocationName ?? this.sandboxId;
    switch (pin.provider) {
      case 'vercel': {
        const resources =
          pin.configuration?.provider === 'vercel' ? pin.configuration.resources : undefined;
        const config = this.vercelConfig(pin.locator, resources);
        return createVercelProviderAdapter({
          sandboxName: allocationName,
          config,
          billingLifetimeSink: evidence => this.recordVercelBillingLifetime(evidence),
          // Authoritative live grants: read at create and on every credential
          // refresh, never frozen into the adapter at construction.
          readContainedGrants: () => this.activeGrants(Date.now()),
          readAcceptedRuntimeProxyHandles: () =>
            listAcceptedHandleStringsByScopeId(this.ctx.storage, Date.now()),
        });
      }
      case 'cloudflare-containers': {
        const instance =
          pin.configuration?.provider === 'cloudflare-containers'
            ? pin.configuration.instance
            : undefined;
        return createCloudflareContainersProviderAdapter({
          logicalSandboxId: this.sandboxId,
          allocationName,
          ...(instance === undefined ? {} : { instance }),
          ...(pin.egressAllowlist === undefined ? {} : { egressAllowlist: pin.egressAllowlist }),
          getContainer: id => this.env.SANDBOX_CONTAINERS.getByName(id),
        });
      }
      case 'cloudflare':
        return createCloudflareProviderAdapter({
          sandboxId: allocationName,
          getSandbox: (id, options) =>
            getSandbox(this.sandboxNamespace(pin, id, options.containment), id),
          destroy: (id, options) =>
            forceDestroyControlPlaneSandbox(
              this.sandboxNamespace(pin, id, options.containment).getByName(id)
            ),
        });
      default: {
        void (pin.provider satisfies never);
        throw new ProviderCreationError('invalid_configuration');
      }
    }
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

  private async writeAllocation(state: AllocationState, previous?: AllocationState): Promise<void> {
    const row = stateToRow(state);
    this.db.transaction(tx => {
      tx.insert(allocationTable)
        .values(row)
        .onConflictDoUpdate({ target: allocationTable.id, set: row })
        .run();
      if (previous !== undefined && previous.allocationId !== state.allocationId) {
        resetRuntimeContract(this.ctx.storage.kv, state.allocationId);
      }
    });
    if (
      previous?.kind === state.kind &&
      previous.lastActivityAt === state.lastActivityAt &&
      previous.unconfirmedProviderRef === state.unconfirmedProviderRef
    )
      return;
    for (const socket of this.ctx.getWebSockets('sandbox-status')) {
      const attachment: unknown = socket.deserializeAttachment();
      if (
        typeof attachment === 'object' &&
        attachment !== null &&
        'sessionId' in attachment &&
        typeof attachment.sessionId === 'string'
      )
        this.sendStatusSnapshot(socket, attachment.sessionId, state);
    }
  }

  private sendStatusSnapshot(socket: WebSocket, sessionId: string, state: AllocationState): void {
    const snapshot = projectAllocationStatusSnapshot({
      allocation: {
        ...state,
        provider: this.currentProvider(),
        configuration: this.providerPin?.configuration ?? null,
      },
      observedAt: Date.now(),
      inactivityTimeoutMs: this.sandboxIdleTimeoutMs(state),
    });
    try {
      socket.send(
        JSON.stringify({
          eventId: 0,
          executionId: '',
          sessionId,
          streamEventType: 'cloud.sandbox.status',
          timestamp: new Date(snapshot.observedAt).toISOString(),
          data: snapshot,
        })
      );
    } catch {
      socket.close(1011, 'Status delivery failed');
    }
  }

  private isStatusSocket(socket: WebSocket): boolean {
    const attachment: unknown = socket.deserializeAttachment();
    return (
      typeof attachment === 'object' &&
      attachment !== null &&
      'kind' in attachment &&
      attachment.kind === 'sandbox-status'
    );
  }

  private async readProviderPin(): Promise<StoredProviderPin | null> {
    const rows = await this.db
      .select({ pin: allocationTable.provider_pin })
      .from(allocationTable)
      .where(eq(allocationTable.id, ALLOCATION_ROW_ID));
    const raw = rows[0]?.pin;
    if (typeof raw !== 'string') return null;
    let pin: StoredProviderPin;
    try {
      pin = JSON.parse(raw) as StoredProviderPin;
    } catch {
      return null;
    }
    if (pin.egressAllowlist !== undefined) {
      pin.egressAllowlist = nativeEgressAllowlistSchema.parse(pin.egressAllowlist);
      if (
        pin.provider !== 'cloudflare-containers' ||
        (pin.sandboxKind === undefined
          ? !this.sandboxId.startsWith('ses-')
          : pin.sandboxKind !== 'isolated')
      ) {
        throw new ProviderCreationError('invalid_configuration');
      }
    }
    return pin;
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
    const allocationAt = nextAllocationAlarmAt(
      state.kind === 'connected' &&
        [...this.repositoryCaptures.values()].some(
          capture => capture.allocationId === state.allocationId && capture.ok === undefined
        )
        ? { ...state, lastFrameAt: Date.now() }
        : state,
      this.sandboxTimers()
    );
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

  /**
   * Derived from the routes table on every lookup, so no route write can leave
   * it stale. SQLite extracts only the origin; an unreadable credential source
   * keeps the longer interactive window.
   */
  private sandboxIdleTimeoutMs(state: AllocationState | null): number {
    const timers = this.sandboxTimers();
    if (state?.kind !== 'connected') return timers.idleMs;
    const source = routesTable.credential_source;
    const routes = this.db
      .select({
        state: routesTable.state,
        readable: sql<number>`coalesce(json_valid(${source}), 1)`,
        origin: sql<unknown>`case when json_valid(${source}) then json_extract(${source}, '$.createdOnPlatform') end`,
      })
      .from(routesTable)
      .all();
    return routes.some(route => route.state === 'preparing' || route.readable === 0) ||
      sandboxIdlePolicyForOrigins(routes.map(route => route.origin)) === 'interactive'
      ? timers.idleMs
      : timers.unattendedIdleMs;
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
