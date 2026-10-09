import { DurableObject } from 'cloudflare:workers';
import { DEFAULT_DO_RETRY_CONFIG } from '@kilocode/worker-utils';
import { normalizeGitUrl } from '@kilocode/worker-utils';
import {
  renewRuntimeAuthorization,
  unsealRuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import { RuntimeAuthorizationSchema } from '@kilocode/worker-utils/runtime-authorization-contract';
import {
  cloudAgentWorktreeIdSchema,
  cloudAgentWorktreeLocationSchema,
  type CloudAgentChildSessionLineage,
  type CloudAgentWorktreeLocation,
} from '@kilocode/session-ingest-contracts';
import { asc } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';
import { resolveSecret } from '../../auth.js';
import type { CallbackTarget } from '../../callbacks/index.js';
import type { DurableAdmissionAck } from '../../execution/types.js';
import { logger } from '../../logger.js';
import type { WrapperPty } from '../../kilo/wrapper-client.js';
import type { OperationResult } from '../../persistence/types.js';
import {
  CurrentSessionMetadataSchema,
  parseSessionMetadata,
  serializeSessionMetadata,
  hasRetiredDevcontainerRuntime,
  DEVCONTAINER_RETIRED_MESSAGE,
  type SessionMetadata,
} from '../../persistence/session-metadata.js';
import {
  issuePersistedRuntimeProxyGrant,
  resolvePersistedRuntimeProxyCredential,
} from '../../runtime-credential-proxy-rpc.js';
import {
  getRuntimeAuthorizationRecoveryState as readRuntimeAuthorizationRecoveryState,
  RUNTIME_AUTHORIZATION_KEY,
  renewStoredRuntimeAuthorization,
} from '../../session/runtime-authorization-persistence.js';
import { sessionRuntimeLocator } from '../../sandbox-control/worktree-ownership.js';
import { logRuntimeAuthorizationDiagnostic } from '../../session/runtime-authorization-diagnostics.js';
import { applyControlPlanePreparingEvent } from '../../sandbox-session/control-plane-preparing.js';
import {
  applyPendingInteractionEvent,
  pendingInteractionsSchema,
  persistSandboxControlSessionEvent,
  type PendingInteractions,
} from '../../sandbox-session/sandbox-control-event.js';
import { handleCommandsAvailable } from '../../session/ingest-handlers/commands-available.js';
import { createMessageId } from '../../session/message-id.js';
import type {
  SafeMessageResultResponse,
  MessageResultRPCResponse,
} from '../../session/message-result.js';
import type { LatestAssistantMessage } from '../../session/types.js';
import { createEventQueries, type EventQueries } from '../../session/queries/index.js';
import { createPreparationProgressRecorder } from '../../session/preparation-progress.js';
import { sessionIdFromDoName } from '../../session-plane.js';
import {
  finalizePreparationAttempt,
  getPreparationSnapshots,
  readPreparationAttempt,
  readPreparationSteps,
  type PreparationOutcome,
} from '../../session/preparation-history.js';
import type { CommandsAvailableData, SessionStatus } from '../../shared/protocol.js';
import {
  CONTROL_PLANE_SETUP_EVENTS,
  CONTROL_PLANE_WRAPPER_FINALIZING_EVENT,
  controlPlaneAnswerPayloadSchema,
  controlPlaneCredentialSourceSchema,
  controlPlaneEventsNotificationSchema,
  controlPlaneOutcomeSchema,
  controlPlanePromptPayloadSchema,
  controlPlaneRegistrationRouteSpecSchema,
  controlPlaneRouteUpdateSchema,
  controlPlaneRouteViewSchema,
  controlPlaneSetupEventSchema,
  type ControlPlaneAnswerPayload,
  type ControlPlaneAnswerReply,
  type ControlPlaneControlResult,
  type ControlPlaneDeliverPayload,
  type ControlPlaneDeliverResult,
  type ControlPlaneDispatchResult,
  type ControlPlaneEventsNotification,
  type ControlPlaneOutcome,
  type ControlPlanePreparationStep,
  type ControlPlanePromptPayload,
  type ControlPlaneRouteUpdate,
  type ControlPlaneRouteView,
  type ControlPlaneSessionRefPayload,
  type ControlPlaneSetupEvent,
  type ControlPlaneStatusResult,
  type ControlPlaneTerminalInput,
  type ControlPlaneWorktreeCaptureInput,
} from '../../shared/control-plane-protocol.js';
import { resolveControlPlaneTimers } from '../../shared/control-plane-timers.js';
import type { SandboxStatusSnapshot } from '../../shared/sandbox-status.js';
import type { EventId, SessionId } from '../../types/ids.js';
import type { Env } from '../../types.js';
import { withDORetry } from '../../utils/do-retry.js';
import type { StoredEvent } from '../../websocket/types.js';
import { createStreamHandler, type QueuedMessageSnapshot } from '../../websocket/stream.js';
import { sandboxControlPeerNamespace } from '../peer-bindings.js';
import migrations from './drizzle/migrations';
import {
  acceptMessages,
  dueBackstopMessages,
  isTerminalMessage,
  nextBackstopAt,
  oldestOpenMessage,
  openMessages,
  queueMessage,
  renderTurnContent,
  settleAcceptedUpTo,
  settleMessages,
  type MessageReduction,
  type SessionMessage,
  type SessionMessageState,
} from './messages.js';
import { answerMessageIntent } from './answers.js';
import { messageFailureText } from './failure-messages.js';
import {
  createControlPlaneWorktreeChanges,
  type ControlPlaneWorktreeChanges,
} from './worktree-changes.js';
import { createControlPlaneTerminals, type ControlPlaneTerminals } from './terminals.js';
import { readWorktreeChildSessions } from './worktree-child-sessions.js';
import {
  buildControlPlaneMessageReport,
  reportAnchorForQueue,
  type ControlPlaneReportFacts,
} from './reports.js';
import { createMessageCallbacks, type MessageCallbacks } from './callbacks.js';
import {
  createReportOutbox,
  readReportAnchor,
  writeReportAnchor,
  type ReportOutbox,
} from '../../sandbox-session/report-outbox.js';
import type { CloudAgentQueueReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import type {
  GetWorktreeChangesOutput,
  GetWorktreeFileOutput,
  RefreshWorktreeChangesOutput,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import { controlPlaneMessages } from './sqlite-schema.js';
import {
  buildControlPlaneSessionRegistration,
  controlPlaneSessionCreateInputSchema,
  controlPlaneSessionRegisterInputSchema,
  type ControlPlaneSessionCreateInput,
  type ControlPlaneSessionRegisterInput,
} from './registration.js';
import {
  controlPlaneSandboxSelectionSchema,
  type ControlPlanePrepareInputWithSelection,
} from './sandbox-selection.js';
import type { ControlRuntimeCredentialProxyFence } from '../sandbox/sandbox-do.js';
import { diagnosticCause, logControlDiagnostic } from '../../sandbox-control/diagnostics.js';

/** Where a committed message transition came from (legacy diagnostic field). */
type ControlPlaneMessageSource = 'coordinator' | 'wrapper_outcome' | 'operation_result';

const GENERATION_KEY = 'control_plane_generation';
const GENERATION = 2;
const REGISTRATION_KEY = 'control_plane_session';
const SESSION_METADATA_KEY = 'session_metadata';
const ROUTE_KEY = 'control_plane_route';
const TRANSPORT_RECOVERY_KEY = 'control_plane_transport_recovery_at';
const PENDING_INTERACTIONS_KEY = 'session_pending_interactions';
const AVAILABLE_COMMANDS_KEY = 'available_commands';
const ROOT_STATUS_KEY = 'session_root_status';

/**
 * Kilo's last root `session.status` type; `settled` once an accepted message settled after it,
 * so a stored `busy` no longer describes Cloud work.
 */
const rootStatusSchema = z.object({ type: z.string(), settled: z.boolean() });
type RootStatus = z.infer<typeof rootStatusSchema>;
const rootStatusEventSchema = z.object({
  sessionID: z.string(),
  status: z.object({ type: z.string() }),
});

/** Wrapper setup-command lifecycle events the Session DO renders itself. */
const SETUP_EVENT_TYPES: ReadonlySet<string> = new Set([
  CONTROL_PLANE_SETUP_EVENTS.started,
  CONTROL_PLANE_SETUP_EVENTS.output,
  CONTROL_PLANE_SETUP_EVENTS.finished,
]);

/** Public `PreparingStep` for a control-plane route preparation step (spec §10). */
const PREPARING_STEP_PUBLIC: Record<ControlPlanePreparationStep, string> = {
  sandbox_create: 'sandbox_provision',
  sandbox_start: 'sandbox_boot',
  clone: 'cloning',
  restore: 'workspace_restore',
  checkout: 'branch',
  setup: 'setup_commands',
  snapshot: 'workspace_backup',
  kilo_runtime: 'kilo_server',
  kilo_session: 'kilo_session',
};

const PREPARING_STEP_MESSAGE: Record<ControlPlanePreparationStep, string> = {
  sandbox_create: 'Creating sandbox',
  sandbox_start: 'Starting sandbox',
  clone: 'Cloning repository',
  restore: 'Using prepared repository',
  checkout: 'Checking out branch',
  setup: 'Running setup commands',
  snapshot: 'Saving repository for faster starts',
  kilo_runtime: 'Starting Kilo runtime',
  kilo_session: 'Preparing Kilo session',
};

/**
 * The one owner of the route-step → public-step mapping (spec §10): both the
 * live `cloud.status` emit and the connect-replay `cloud.status` derive it
 * here, so the two paths cannot diverge.
 */
function publicPreparationStep(step: ControlPlanePreparationStep | undefined): string | undefined {
  return step === undefined ? undefined : PREPARING_STEP_PUBLIC[step];
}

/**
 * The route state to persist for a view. A preparing view's live detail is not
 * route state, and a preparing view that names no step (a repeated `prepare`)
 * keeps the step its attempt already reached.
 */
function persistedRouteView(
  view: ControlPlaneRouteView,
  previous: ControlPlaneRouteView
): ControlPlaneRouteView {
  if (view.state !== 'preparing') return view;
  const step =
    view.step ??
    (previous.state === 'preparing' && previous.attemptId === view.attemptId
      ? previous.step
      : undefined);
  return {
    state: 'preparing',
    attemptId: view.attemptId,
    ...(step === undefined ? {} : { step }),
  };
}

/** DO-only session creation input; the Worker builds it from session metadata. */
export const controlPlaneSessionRegistrationSchema = z
  .object({
    sandboxId: z.string().min(1).max(256),
    spec: controlPlaneRegistrationRouteSpecSchema,
    credentials: controlPlaneCredentialSourceSchema,
    /** Worker-selected provider pin (H1/H2); the DO applies it, never re-decides it. */
    sandboxSelection: controlPlaneSandboxSelectionSchema.optional(),
  })
  .strict();
export type ControlPlaneSessionRegistration = z.infer<typeof controlPlaneSessionRegistrationSchema>;

export type ControlPlaneSendResult =
  | { type: 'ok' }
  | { type: 'session-not-found' }
  | { type: 'queue-full' };

/**
 * Create/register failure in the legacy `AdmissionFailure` shape (M2): the
 * boundary is always `registration`, and only validation failures use
 * `BAD_REQUEST`. Non-validation errors throw so the Worker retries.
 */
export type ControlPlaneSessionCreateFailure = {
  success: false;
  code: 'NOT_FOUND' | 'BAD_REQUEST' | 'INTERNAL';
  error: string;
  failureBoundary: 'registration';
};

/** Result of the Worker-facing create RPC (M2), compatible with C1's consumer. */
export type ControlPlaneSessionCreateResult =
  | DurableAdmissionAck
  | ControlPlaneSessionCreateFailure;

/** Sibling registration result: no message is admitted, so there is no ack shape. */
export type ControlPlaneSessionRegisterResult =
  | { success: true }
  | ControlPlaneSessionCreateFailure;

export type ControlPlaneSessionSnapshot =
  | { type: 'session-not-found' }
  | {
      type: 'found';
      sessionId: string;
      route: ControlPlaneRouteView;
      messages: Array<{
        messageId: string;
        state: SessionMessageState;
        createdAt: number;
        acceptedAt: number | null;
        settledAt: number | null;
        reason: string | null;
      }>;
      /** Durability watermark: latest stored event id, or null when none. */
      latestEventId: number | null;
    };

/**
 * Session DO -> Sandbox DO (spec §10). Resolved from the production
 * `SANDBOX_CONTROL` binding; tests may inject a fake through `sandboxPeerFor`.
 */
export type ControlPlaneSandboxPeer = {
  status(payload: ControlPlaneSessionRefPayload): Promise<ControlPlaneStatusResult>;
  prepare(input: ControlPlanePrepareInputWithSelection): Promise<ControlPlaneRouteView>;
  deliver(payload: ControlPlaneDeliverPayload): Promise<ControlPlaneDeliverResult>;
  abort(payload: ControlPlaneSessionRefPayload): Promise<ControlPlaneDispatchResult>;
  answer(payload: ControlPlaneAnswerPayload): Promise<ControlPlaneDispatchResult>;
  release(payload: ControlPlaneSessionRefPayload): Promise<void>;
  /** H4: the Sandbox DO returns the connected allocation fence for a bound handle. */
  getRuntimeCredentialProxyFence(input: {
    ownerId: string;
    sessionId: string;
    kiloSessionId: string;
    directory: string;
  }): Promise<ControlRuntimeCredentialProxyFence | null>;
  /** B10: forwards one worktree-change request to the wrapper. */
  worktreeCapture(input: ControlPlaneWorktreeCaptureInput): Promise<ControlPlaneControlResult>;
  /** B10: forwards one terminal request to the wrapper. */
  terminal(input: ControlPlaneTerminalInput): Promise<ControlPlaneControlResult>;
  /** B10: the wrapper identity bound to the connected allocation. */
  getWrapperId(): Promise<string | null>;
  /** B10: the public sandbox status snapshot projected from the allocation. */
  getStatusSnapshot(): Promise<SandboxStatusSnapshot>;
  fetch(request: Request): Promise<Response>;
};

type SessionMessageRow = typeof controlPlaneMessages.$inferSelect;

type TransportPass = { deadlineAt: number; scheduleRecovery: boolean };

function rowToMessage(row: SessionMessageRow): SessionMessage {
  return {
    messageId: row.message_id,
    intent: controlPlanePromptPayloadSchema.parse(JSON.parse(row.intent)),
    state: row.state,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    settledAt: row.settled_at,
    reason: row.reason,
  };
}

function messageToRow(message: SessionMessage): SessionMessageRow {
  return {
    message_id: message.messageId,
    intent: JSON.stringify(message.intent),
    state: message.state,
    created_at: message.createdAt,
    accepted_at: message.acceptedAt,
    settled_at: message.settledAt,
    reason: message.reason,
  };
}

function createFailure(
  code: ControlPlaneSessionCreateFailure['code'],
  error: string
): ControlPlaneSessionCreateFailure {
  return { success: false, code, error, failureBoundary: 'registration' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Invalid session metadata';
}

/** The stored metadata carries the admitted initial message id for M3 replay. */
function withInitialMessageId(metadata: SessionMetadata, messageId: string): SessionMetadata {
  return { ...metadata, initialMessage: { ...(metadata.initialMessage ?? {}), id: messageId } };
}

/** Repository fingerprint mirroring the legacy register guard (M3). */
function repositoryFingerprint(repository: SessionMetadata['repository']): string {
  if (repository === undefined) return 'none';
  switch (repository.type) {
    case 'github':
      return `github:${repository.repo}:${repository.githubIntegrationId ?? ''}:${
        repository.githubAccessPurpose ?? 'workflow'
      }`;
    case 'bitbucket':
      return `bitbucket:${repository.workspaceUuid}:${repository.repositoryUuid}:${
        repository.bitbucketIntegrationId ?? ''
      }`;
    case 'gitlab':
    case 'git':
      return `${repository.type}:${normalizeGitUrl(repository.url)}`;
  }
}

function sameRepository(
  a: SessionMetadata['repository'],
  b: SessionMetadata['repository']
): boolean {
  return repositoryFingerprint(a) === repositoryFingerprint(b);
}

type PendingInteractionCollection = 'questions' | 'permissions';

/** The pending-set entry an answer resolves: its collection and its id. */
function pendingInteractionTarget(reply: ControlPlaneAnswerReply): {
  collection: PendingInteractionCollection;
  id: string;
} {
  return reply.action === 'permission'
    ? { collection: 'permissions', id: reply.permissionId }
    : { collection: 'questions', id: reply.questionId };
}

/** The event that removes an answer's interaction from the pending set. */
function pendingInteractionResolvedEvent(reply: ControlPlaneAnswerReply): {
  type: string;
  properties: Record<string, unknown>;
} {
  switch (reply.action) {
    case 'answer':
      return { type: 'question.replied', properties: { requestID: reply.questionId } };
    case 'reject':
      return { type: 'question.rejected', properties: { requestID: reply.questionId } };
    case 'permission':
      return { type: 'permission.replied', properties: { requestID: reply.permissionId } };
  }
}

/** Static `unknown` presentation when no Sandbox DO can answer (spec Sandbox Status). */
function unavailableStatusSnapshot(): SandboxStatusSnapshot {
  return {
    status: 'unknown',
    provider: 'Unknown',
    observedAt: Date.now(),
    detailCode: 'status_unavailable',
    inactivityTimeoutMs: null,
    estimatedSleepAt: null,
  };
}

export class SandboxSessionV2 extends DurableObject<Env> {
  readonly sessionId: SessionId;
  private readonly db: DrizzleSqliteDODatabase;
  private readonly eventQueries: EventQueries;
  private readonly initialized: Promise<void>;
  private readonly operations: { tail: Promise<unknown> } = { tail: Promise.resolve() };
  private registration: ControlPlaneSessionRegistration | null = null;
  private metadata: SessionMetadata | null = null;
  private runtimeAuthorization: RuntimeAuthorization | undefined;
  private messages: SessionMessage[] = [];
  private route: ControlPlaneRouteView = { state: 'unknown' };
  private transportRecoveryAt: number | null = null;
  private pendingInteractions: PendingInteractions | undefined;
  private availableCommands: CommandsAvailableData = { commands: [] };
  private rootStatus: RootStatus | undefined;
  /** Report obligations for terminal messages (plan B5); repair is best effort. */
  private readonly reportOutbox: ReportOutbox;
  /** Terminal callback outbox (plan B5); one job per drained batch. */
  private readonly messageCallbacks: MessageCallbacks;
  /** Worktree-changes projection from the shared event log (plan B10). */
  private readonly worktreeChanges: ControlPlaneWorktreeChanges;
  /** Terminal records and the browser/wrapper bridge (plan B10). */
  private readonly terminals: ControlPlaneTerminals;
  /** Generation of the in-flight preparation, for the worktree-change hooks. */
  private worktreePreparationGeneration: number | undefined;
  /**
   * Step-continuity recorders per route attempt. They own only the live step
   * projection and the materialized attempt snapshots. The row's open/close
   * transitions are driven by the route view (see `applyView`), so a lost map
   * on eviction cannot leave a preparation row running: the previous persisted
   * route still names the attempt to finalize.
   */
  private readonly preparationRecorders = new Map<
    string,
    ReturnType<typeof createPreparationProgressRecorder>
  >();

  /**
   * Sandbox-peer factory. The default resolves the production `SANDBOX_CONTROL`
   * binding; tests inject a fake to drive the Session DO without a sandbox.
   */
  sandboxPeerFor: (sandboxId: string) => ControlPlaneSandboxPeer | null = sandboxId =>
    this.resolveSandboxPeer(sandboxId);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sessionId = sessionIdFromDoName(ctx.id.name ?? ctx.id.toString()) as SessionId;
    this.db = drizzle(ctx.storage, { logger: false });
    this.eventQueries = createEventQueries(this.db, ctx.storage.sql);
    this.reportOutbox = createReportOutbox({
      storage: ctx.storage,
      getQueue: () => this.env.CLOUD_AGENT_REPORT_QUEUE as Queue<CloudAgentQueueReport> | undefined,
    });
    this.messageCallbacks = createMessageCallbacks({
      storage: ctx.storage,
      getMetadata: () => this.metadata,
      getCallbackQueue: () => this.env.CALLBACK_QUEUE,
      getAssistantMessageForUserMessage: (sessionId, kiloSessionId, parentMessageId) =>
        this.eventQueries.getAssistantMessageForUserMessage(
          sessionId,
          kiloSessionId,
          parentMessageId
        ),
    });
    this.worktreeChanges = createControlPlaneWorktreeChanges({
      storage: ctx.storage,
      sessionId: this.sessionId,
      eventQueries: this.eventQueries,
      broadcast: event => this.broadcast(event),
      getMetadata: () => this.metadata,
      getDirectory: () => this.registration?.spec.directory,
      capture: (sandboxId, input) => this.captureWorktreeChanges(sandboxId, input),
      waitUntil: promise => this.ctx.waitUntil(promise),
    });
    this.terminals = createControlPlaneTerminals({
      state: ctx,
      sessionId: this.sessionId,
      getMetadata: () => this.metadata,
      getDirectory: () => this.registration?.spec.directory,
      getWrapperId: () => this.currentWrapperId(),
      isRouteReady: () => this.route.state === 'ready',
      request: (sandboxId, input) => this.terminalRequest(sandboxId, input),
    });
    this.initialized = ctx.blockConcurrencyWhile(() => this.initializeStorage());
  }

  private async terminalRequest(
    sandboxId: string,
    input: ControlPlaneTerminalInput
  ): Promise<ControlPlaneControlResult> {
    const peer = this.sandboxPeerFor(sandboxId);
    if (peer === null) {
      return {
        ok: false,
        error: { code: 'not_ready', message: 'Sandbox is not available', retryable: true },
      };
    }
    return peer.terminal(input);
  }

  private async currentWrapperId(): Promise<string | undefined> {
    const sandboxId = this.metadata?.workspace?.sandboxId;
    if (sandboxId === undefined) return undefined;
    const peer = this.sandboxPeerFor(sandboxId);
    if (peer === null) return undefined;
    return (await peer.getWrapperId()) ?? undefined;
  }

  private async captureWorktreeChanges(
    sandboxId: string,
    input: ControlPlaneWorktreeCaptureInput
  ): Promise<ControlPlaneControlResult> {
    const peer = this.sandboxPeerFor(sandboxId);
    if (peer === null) {
      // An absent Sandbox DO is "no information" (offline), not a failed
      // capture: `not_ready` keeps the previous snapshot and retries.
      return {
        ok: false,
        error: { code: 'not_ready', message: 'Sandbox is not available', retryable: true },
      };
    }
    return peer.worktreeCapture(input);
  }

  // --- init and storage cutover ----------------------------------------------

  private async initializeStorage(): Promise<void> {
    const generation = await this.ctx.storage.get<unknown>(GENERATION_KEY);
    if (generation !== GENERATION) {
      // Old-plane or first-access instance: wipe before anything reads it, then
      // write the generation so this is one-time (Contracts, "Storage cutover").
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put(GENERATION_KEY, GENERATION);
      await migrate(this.db, migrations);
      return;
    }
    await migrate(this.db, migrations);
    const raw = await this.ctx.storage.get<unknown>(REGISTRATION_KEY);
    const parsed = controlPlaneSessionRegistrationSchema.safeParse(raw);
    this.registration = parsed.success ? parsed.data : null;
    const rawMetadata = await this.ctx.storage.get<unknown>(SESSION_METADATA_KEY);
    if (rawMetadata === undefined) {
      this.metadata = null;
    } else {
      try {
        this.metadata = parseSessionMetadata(rawMetadata);
      } catch {
        this.metadata = null;
      }
    }
    const storedAuthorization = RuntimeAuthorizationSchema.safeParse(
      await this.ctx.storage.get<unknown>(RUNTIME_AUTHORIZATION_KEY)
    );
    this.runtimeAuthorization = storedAuthorization.success ? storedAuthorization.data : undefined;
    const pending = pendingInteractionsSchema.safeParse(
      await this.ctx.storage.get<unknown>(PENDING_INTERACTIONS_KEY)
    );
    this.pendingInteractions = pending.success ? pending.data : undefined;
    const commands = await this.ctx.storage.get<CommandsAvailableData>(AVAILABLE_COMMANDS_KEY);
    this.availableCommands = commands?.commands ? commands : { commands: [] };
    const rootStatus = rootStatusSchema.safeParse(await this.ctx.storage.get(ROOT_STATUS_KEY));
    this.rootStatus = rootStatus.success ? rootStatus.data : undefined;
    this.messages = await this.loadMessages();
    this.route = await this.loadRoute();
    const recoveryAt = z
      .number()
      .int()
      .nonnegative()
      .safeParse(await this.ctx.storage.get<unknown>(TRANSPORT_RECOVERY_KEY));
    this.transportRecoveryAt = recoveryAt.success ? recoveryAt.data : null;
  }

  // --- registration -----------------------------------------------------------

  async registerSession(input: ControlPlaneSessionRegistration): Promise<{ ok: true }> {
    await this.initialized;
    const registration = controlPlaneSessionRegistrationSchema.parse(input);
    await this.enqueue(async () => {
      await this.ctx.storage.put(REGISTRATION_KEY, registration);
      this.registration = registration;
    });
    return { ok: true };
  }

  /**
   * Worker-facing create RPC (spec §5, plan B4). Stores grouped metadata and the
   * registration derived from it (the Worker selected the sandbox), then admits
   * the initial turn through the normal send path. A repeat with the same
   * identity/repository/sandbox/message replays the send (M3); any other change
   * is rejected. Worktree siblings use `registerSessionFromMetadata`.
   */
  async createSessionWithInitialAdmission(
    input: ControlPlaneSessionCreateInput
  ): Promise<ControlPlaneSessionCreateResult> {
    await this.initialized;
    const parsed = controlPlaneSessionCreateInputSchema.safeParse(input);
    if (!parsed.success) return createFailure('BAD_REQUEST', 'Invalid session create input');
    const { metadata, message, sandboxSelection, runtimeAuthorizationSeal } = parsed.data;

    if (this.metadata !== null && this.registration !== null) {
      if (!this.matchesExistingRegistration(metadata, message.messageId)) {
        return createFailure(
          'BAD_REQUEST',
          'Registration does not match the existing session intent'
        );
      }
      const sent = await this.send(message);
      // A replay carries the stored initial message id, so the queued bound
      // cannot refuse it; if it somehow did, fail as a transport error the
      // caller retries rather than inventing a create failure code.
      if (sent.type === 'queue-full') throw new Error('Pending message queue is full');
      return sent.type === 'session-not-found'
        ? createFailure('NOT_FOUND', 'Session not found')
        : this.admissionAck(message.messageId);
    }

    const storedMetadata = withInitialMessageId(metadata, message.messageId);
    // Low: validate before storing so `initialMessage.id` cannot bypass its
    // pattern after eviction and `getMetadata()` can never return null silently.
    const validated = CurrentSessionMetadataSchema.safeParse(storedMetadata);
    if (!validated.success) return createFailure('BAD_REQUEST', 'Invalid session metadata');
    let registration: ControlPlaneSessionRegistration;
    try {
      registration = buildControlPlaneSessionRegistration(
        validated.data,
        sandboxSelection,
        this.env.AGENT_ENV_VARS_PRIVATE_KEY,
        {
          containmentEnabled: this.env.CREDENTIAL_CONTAINMENT_ENABLED !== 'false',
          workerUrl: this.env.WORKER_URL,
        }
      );
    } catch (error) {
      return createFailure('BAD_REQUEST', errorMessage(error));
    }
    const sealed = await this.unsealAuthorization(runtimeAuthorizationSeal, validated.data);
    if (sealed.type === 'failure') return sealed.failure;

    await this.enqueue(async () => {
      await this.ctx.storage.put(REGISTRATION_KEY, registration);
      this.registration = registration;
      await this.ctx.storage.put(SESSION_METADATA_KEY, serializeSessionMetadata(validated.data));
      this.metadata = validated.data;
      if (sealed.authorization !== undefined) {
        await this.ctx.storage.put(RUNTIME_AUTHORIZATION_KEY, sealed.authorization);
        this.runtimeAuthorization = sealed.authorization;
      }
    });

    const sent = await this.send(message);
    // A fresh session has an empty queue, so the bound cannot refuse its first
    // message; a refusal is a transport error the caller retries, not a create
    // failure code.
    if (sent.type === 'queue-full') throw new Error('Pending message queue is full');
    if (sent.type === 'session-not-found') {
      return createFailure('INTERNAL', 'Session registration failed');
    }
    return this.admissionAck(message.messageId);
  }

  /**
   * Sibling register RPC (H3): the DO builds the registration from grouped
   * metadata so no caller has to. No message is admitted.
   */
  async registerSessionFromMetadata(
    input: ControlPlaneSessionRegisterInput
  ): Promise<ControlPlaneSessionRegisterResult> {
    await this.initialized;
    const parsed = controlPlaneSessionRegisterInputSchema.safeParse(input);
    if (!parsed.success) return createFailure('BAD_REQUEST', 'Invalid session register input');
    const { metadata, sandboxSelection, runtimeAuthorizationSeal } = parsed.data;
    // N3: a repeated register (for example a `withDORetry` replay carrying the
    // seal) must not touch the seal again. Match the stored intent and replay
    // success before unsealing; a different intent is rejected.
    if (this.metadata !== null && this.registration !== null) {
      if (!this.matchesExistingRegistration(metadata, undefined)) {
        return createFailure(
          'BAD_REQUEST',
          'Registration does not match the existing session intent'
        );
      }
      return { success: true };
    }
    let registration: ControlPlaneSessionRegistration;
    try {
      registration = buildControlPlaneSessionRegistration(
        metadata,
        sandboxSelection,
        this.env.AGENT_ENV_VARS_PRIVATE_KEY,
        {
          containmentEnabled: this.env.CREDENTIAL_CONTAINMENT_ENABLED !== 'false',
          workerUrl: this.env.WORKER_URL,
        }
      );
    } catch (error) {
      return createFailure('BAD_REQUEST', errorMessage(error));
    }
    const sealed = await this.unsealAuthorization(runtimeAuthorizationSeal, metadata);
    if (sealed.type === 'failure') return sealed.failure;
    await this.enqueue(async () => {
      await this.ctx.storage.put(REGISTRATION_KEY, registration);
      this.registration = registration;
      await this.ctx.storage.put(SESSION_METADATA_KEY, serializeSessionMetadata(metadata));
      this.metadata = metadata;
      if (sealed.authorization !== undefined) {
        await this.ctx.storage.put(RUNTIME_AUTHORIZATION_KEY, sealed.authorization);
        this.runtimeAuthorization = sealed.authorization;
      }
    });
    return { success: true };
  }

  /** Grouped metadata for the worktree and management handlers (H3). */
  async getMetadata(): Promise<SessionMetadata | null> {
    await this.initialized;
    return this.metadata;
  }

  /**
   * H4/R1: mints and persists the runtime credential proxy handle for a connected
   * route. The Sandbox DO reads its own allocation fence and passes it in, so this
   * never calls back into the Sandbox DO queue. `null` means no active runtime
   * authorization (or no backing token); the caller fails the route closed.
   */
  async issueRuntimeCredentialProxyGrant(
    fence: ControlRuntimeCredentialProxyFence
  ): Promise<string | null> {
    await this.initialized;
    // Read the backing token first so metadata/authorization are read after it and
    // reflect the latest state at issuance time (parity with the legacy
    // `SandboxSession.ts` token-then-fence read order).
    const token = await this.getRuntimeToken();
    const metadata = await this.getMetadata();
    const authorization = RuntimeAuthorizationSchema.safeParse(
      await this.ctx.storage.get<unknown>(RUNTIME_AUTHORIZATION_KEY)
    );
    const containment = this.registration?.sandboxSelection?.containment;
    const contained =
      containment === undefined
        ? this.env.CREDENTIAL_CONTAINMENT_ENABLED !== 'false'
        : containment.kilocode || containment.github;
    return issuePersistedRuntimeProxyGrant({
      env: this.env,
      storage: this.ctx.storage,
      metadata,
      authorization: authorization.success ? authorization.data : null,
      fence,
      token,
      mode: contained ? 'contained' : 'direct',
    });
  }

  /**
   * H4: resolves a runtime credential proxy handle for the runtime credential
   * proxy endpoint. The handle is minted and bound by the Sandbox DO when it
   * sends `session.prepare` on a connected socket (R1).
   */
  async resolveRuntimeCredentialProxyGrant(handle: string): Promise<{
    token: string;
    organizationId?: string;
    runtimeAuthorization: { userId: string; authorizationId: string; resourceId: string };
  } | null> {
    await this.initialized;
    return resolvePersistedRuntimeProxyCredential({
      env: this.env,
      storage: this.ctx.storage,
      handle,
      metadata: () => this.getMetadata(),
      authorization: async () => {
        const parsed = RuntimeAuthorizationSchema.safeParse(
          await this.ctx.storage.get<unknown>(RUNTIME_AUTHORIZATION_KEY)
        );
        return parsed.success ? parsed.data : null;
      },
      fence: async () => {
        const metadata = await this.getMetadata();
        const kiloSessionId = metadata?.auth.kiloSessionId;
        const sandboxId = metadata?.workspace?.sandboxId;
        const directory = this.registration?.spec.directory ?? metadata?.workspace?.workspacePath;
        if (!metadata || !kiloSessionId || !sandboxId || !directory) return null;
        const peer = this.sandboxPeerFor(sandboxId);
        return peer === null
          ? null
          : peer.getRuntimeCredentialProxyFence({
              ownerId: metadata.identity.userId,
              sessionId: metadata.identity.sessionId,
              kiloSessionId,
              directory,
            });
      },
      token: () => this.getRuntimeToken(),
    });
  }

  /** C1c model preflight: renew and return the backing runtime token. */
  async getRuntimeToken(): Promise<string | null> {
    const metadata = await this.getMetadata();
    const secret = await resolveSecret(this.env.NEXTAUTH_SECRET);
    if (!secret) throw new Error('NEXTAUTH_SECRET is not configured on the worker');
    return renewStoredRuntimeAuthorization({
      metadata,
      getAuthorization: () => this.ctx.storage.get<unknown>(RUNTIME_AUTHORIZATION_KEY),
      putAuthorization: authorization =>
        this.ctx.storage.put(RUNTIME_AUTHORIZATION_KEY, authorization),
      getMetadata: () => this.getMetadata(),
      putMetadata: async updated => {
        await this.ctx.storage.put(SESSION_METADATA_KEY, serializeSessionMetadata(updated));
        this.metadata = updated;
      },
      renew: authorization =>
        renewRuntimeAuthorization({
          authorization,
          secret,
          connectionString: this.env.HYPERDRIVE.connectionString,
          onBindingRejected: reason =>
            logRuntimeAuthorizationDiagnostic(
              metadata?.identity.sessionId,
              'binding_check',
              reason
            ),
        }),
    });
  }

  private admissionAck(messageId: string): DurableAdmissionAck {
    const message = this.messages.find(candidate => candidate.messageId === messageId);
    return {
      success: true,
      outcome: 'queued',
      messageId,
      compatibilityDelivery: message?.state === 'accepted' ? 'sent' : 'queued',
    };
  }

  private matchesExistingRegistration(
    metadata: SessionMetadata,
    messageId: string | undefined
  ): boolean {
    const existing = this.metadata;
    if (existing === null || this.registration === null) return false;
    return (
      existing.identity.userId === metadata.identity.userId &&
      (existing.identity.orgId ?? null) === (metadata.identity.orgId ?? null) &&
      sameRepository(existing.repository, metadata.repository) &&
      this.registration.sandboxId === metadata.workspace?.sandboxId &&
      (existing.initialMessage?.id ?? null) === (messageId ?? null)
    );
  }

  private async unsealAuthorization(
    seal: string | undefined,
    metadata: SessionMetadata
  ): Promise<
    | { type: 'ok'; authorization: RuntimeAuthorization | undefined }
    | { type: 'failure'; failure: ControlPlaneSessionCreateFailure }
  > {
    if (seal === undefined) return { type: 'ok', authorization: undefined };
    if (this.runtimeAuthorization !== undefined) {
      return {
        type: 'failure',
        failure: createFailure('BAD_REQUEST', 'Runtime authorization already installed'),
      };
    }
    const secret = await resolveSecret(this.env.NEXTAUTH_SECRET);
    if (!secret) {
      return { type: 'failure', failure: createFailure('INTERNAL', 'Authentication unavailable') };
    }
    let authorization: RuntimeAuthorization;
    try {
      authorization = await unsealRuntimeAuthorization(seal, secret, {
        resourceKind: 'cloud-agent-next',
        resourceId: metadata.identity.sessionId,
        userId: metadata.identity.userId,
        organizationId: metadata.identity.orgId,
      });
    } catch {
      return {
        type: 'failure',
        failure: createFailure('BAD_REQUEST', 'Invalid runtime authorization'),
      };
    }
    if (authorization.state !== 'active') {
      return {
        type: 'failure',
        failure: createFailure('BAD_REQUEST', 'Runtime authorization revoked'),
      };
    }
    return { type: 'ok', authorization };
  }

  // --- message flow -----------------------------------------------------------

  async send(intent: ControlPlanePromptPayload): Promise<ControlPlaneSendResult> {
    await this.initialized;
    if (this.registration === null) return { type: 'session-not-found' };
    const parsed = controlPlanePromptPayloadSchema.parse(intent);
    return this.enqueue(async () => {
      // A delete queued ahead of this task made the session not-found; do not
      // persist a queued row against wiped storage.
      if (this.registration === null) return { type: 'session-not-found' };
      const admitted = await this.admitMessage(parsed);
      return admitted === 'queue-full' ? { type: 'queue-full' } : { type: 'ok' };
    });
  }

  /**
   * The one admission path: confirm an old preparing owner before fresh work,
   * append it `queued`, then deliver or prepare. `send` and the settled-answer
   * fallback share it so an answer continues exactly like a sent message. It
   * reports `queueMessage`'s refusal of a new message over the queued bound; the
   * reducer owns the count and `admitMessage` does not re-derive it.
   */
  private async admitMessage(parsed: ControlPlanePromptPayload): Promise<'ok' | 'queue-full'> {
    const now = Date.now();
    let reduction = queueMessage(this.messages, parsed, now);
    if (reduction.rejected === 'queue-full') return 'queue-full';
    const pass = this.transportPass();
    if (
      reduction.changed.length > 0 &&
      this.route.state === 'preparing' &&
      this.messages.some(message => message.state === 'queued')
    ) {
      const view = await this.readSandboxView(pass);
      if (view?.state === 'failed' && view.attemptId === this.currentAttemptId()) {
        await this.applyView(view, pass);
        reduction = queueMessage(this.messages, parsed, now);
      }
    }
    if (reduction.changed.length > 0) {
      this.messages = reduction.messages;
      await this.persistMessages(reduction.changed);
      for (const message of reduction.changed) this.emitQueued(message);
      this.ensureReportAnchor(reduction.changed[0]);
    }
    await this.armAlarm();
    if (!this.messages.some(message => message.state === 'queued')) return 'ok';
    if (this.route.state === 'ready') await this.deliverQueued(pass);
    else {
      const view = await this.prepareSandbox(pass);
      if (view !== null) await this.applyView(view, pass);
    }
    await this.armAlarm();
    return 'ok';
  }

  async stop(): Promise<{ interrupted: boolean }> {
    await this.initialized;
    if (this.registration === null) return { interrupted: false };
    return this.enqueue(async () => {
      const open = openMessages(this.messages).map(m => m.messageId);
      // A user cancel: mark the interruption so the next idle schedules a
      // capture that shows the cancelled worktree state.
      this.worktreeChanges.markInterrupted();
      await this.settleMessages(open, 'cancelled', 'interrupted');
      const peer = this.sandboxPeer();
      if (peer !== null) {
        try {
          await withDORetry(
            () => this.sandboxPeer() ?? peer,
            current => current.abort({ sessionId: this.sessionId }),
            'session.abort',
            this.sandboxRpcConfig(this.transportPass())
          );
        } catch {
          // Abort is best effort (spec §5).
        }
      }
      return { interrupted: open.length > 0 };
    });
  }

  async cancelQueuedMessage(messageId: string): Promise<{ dropped: boolean }> {
    await this.initialized;
    if (this.registration === null) return { dropped: false };
    return this.enqueue(async () => {
      const message = this.messages.find(item => item.messageId === messageId);
      if (message === undefined || message.state !== 'queued') return { dropped: false };
      await this.settleMessages([messageId], 'cancelled', 'interrupted');
      return { dropped: true };
    });
  }

  async answer(payload: ControlPlaneAnswerPayload): Promise<ControlPlaneDispatchResult> {
    await this.initialized;
    if (this.registration === null) return 'not_connected';
    const parsed = controlPlaneAnswerPayloadSchema.parse(payload);
    return this.enqueue(async () => {
      // A live turn takes the answer directly (spec §5). The route is named by
      // this DO, never by the caller, so a wrong id cannot reach a sibling.
      if (this.messages.some(message => message.state === 'accepted')) {
        const peer = this.sandboxPeer();
        if (peer === null) return 'not_connected';
        try {
          return await peer.answer({ sessionId: this.sessionId, reply: parsed.reply });
        } catch {
          return 'not_connected';
        }
      }
      // The asking turn already settled: the answer becomes a new message that
      // continues the chat (spec §5), admitted through the send path. Only a
      // question/permission this session still waits on may do so, so a retry,
      // an unknown id or an already-answered one cannot admit another turn.
      const target = pendingInteractionTarget(parsed.reply);
      if (!this.hasPendingInteraction(target.collection, target.id)) return 'not_connected';
      const intent = answerMessageIntent(
        this.messages,
        parsed.reply,
        createMessageId(),
        this.metadata?.agent?.model
      );
      if (intent === null) return 'not_connected';
      const admitted = await this.admitMessage(intent);
      if (admitted === 'queue-full') return 'not_connected';
      await this.resolvePendingInteraction(parsed.reply);
      return 'sent';
    });
  }

  /** The pending questions and permissions this session waits on (C1 adapter). */
  async getPendingInteractions(): Promise<{ questions: unknown[]; permissions: unknown[] }> {
    await this.initialized;
    return this.readPendingInteractions() ?? { questions: [], permissions: [] };
  }

  private hasPendingInteraction(collection: PendingInteractionCollection, id: string): boolean {
    const items = this.pendingInteractions?.[collection];
    if (items === undefined) return false;
    return items.some(
      item => typeof item === 'object' && item !== null && (item as { id?: unknown }).id === id
    );
  }

  private async resolvePendingInteraction(reply: ControlPlaneAnswerReply): Promise<void> {
    const next = applyPendingInteractionEvent(
      this.pendingInteractions,
      pendingInteractionResolvedEvent(reply)
    );
    if (next !== undefined && next !== this.pendingInteractions) {
      this.pendingInteractions = next;
      await this.ctx.storage.put(PENDING_INTERACTIONS_KEY, next);
    }
  }

  // --- notifications (spec §10) ----------------------------------------------

  async onRoute(update: ControlPlaneRouteUpdate): Promise<void> {
    await this.initialized;
    if (this.registration === null) return;
    const parsed = controlPlaneRouteUpdateSchema.parse(update);
    await this.enqueue(async () => {
      // A delete queued ahead of this notification wiped the session.
      if (this.registration === null) return;
      if (
        this.messages.some(message => message.state === 'queued') &&
        (this.route.state === 'failed' ||
          this.transportRecoveryAt !== null ||
          (this.route.state === 'preparing' &&
            parsed.state !== 'unknown' &&
            (parsed.attemptId !== this.route.attemptId || parsed.state !== 'preparing')))
      ) {
        const pass = this.transportPass();
        pass.scheduleRecovery = this.transportRecoveryAt !== null;
        await this.recoverQueued(pass, parsed);
        await this.armAlarm();
        return;
      }
      const pass = this.transportPass();
      if (parsed.state === 'unknown') {
        await this.applyView(parsed, pass);
        return;
      }
      // A notification names its route attempt. Ignore one for an older or
      // different attempt so a late `failed`/`ready` cannot act on a newer one.
      const current = this.currentAttemptId();
      if (current !== null && parsed.attemptId !== current) return;
      if (parsed.state === 'lost') {
        await this.settleMessages(
          this.messages.filter(m => m.state === 'accepted').map(m => m.messageId),
          'failed',
          parsed.reason
        );
        await this.applyView({ state: 'unknown' });
        await this.armAlarm();
        if (this.messages.some(message => message.state === 'queued')) {
          const view = await this.prepareSandbox(pass);
          if (view !== null) await this.applyView(view, pass);
        }
        await this.armAlarm();
        return;
      }
      await this.applyView(parsed, pass);
      await this.armAlarm();
    });
  }

  async onEvents(notification: ControlPlaneEventsNotification): Promise<void> {
    await this.initialized;
    if (this.registration === null) return;
    const parsed = controlPlaneEventsNotificationSchema.parse(notification);
    await this.enqueue(async () => {
      // A delete queued ahead of this notification wiped the session.
      if (this.registration === null) return;
      for (const event of parsed.events) {
        if (event.type === 'commands.available') {
          await handleCommandsAvailable(event.properties, {
            setAvailableCommands: async commands => {
              this.availableCommands = commands;
              await this.ctx.storage.put(AVAILABLE_COMMANDS_KEY, commands);
            },
            logger: {
              info: message => logger.withFields({ sessionId: this.sessionId }).info(message),
              warn: message => logger.withFields({ sessionId: this.sessionId }).warn(message),
            },
          });
          continue;
        }
        if (event.type === CONTROL_PLANE_WRAPPER_FINALIZING_EVENT) {
          // Spec §10 "Finalization running".
          this.emitCloudStatus({ type: 'finalizing' });
        }
        if (SETUP_EVENT_TYPES.has(event.type)) {
          const setupEvent = controlPlaneSetupEventSchema.safeParse(event);
          if (setupEvent.success) this.recordSetupEvent(setupEvent.data);
          continue;
        }
        const next = applyPendingInteractionEvent(this.pendingInteractions, event);
        if (next !== undefined && next !== this.pendingInteractions) {
          this.pendingInteractions = next;
          await this.ctx.storage.put(PENDING_INTERACTIONS_KEY, next);
        }
        await this.recordRootStatus(event);
        persistSandboxControlSessionEvent({
          sessionId: this.sessionId,
          payload: event,
          eventQueries: this.eventQueries,
          broadcast: stored => this.broadcast(stored),
        });
        this.worktreeChanges.onEvent(event.type, event.properties);
      }
    });
  }

  async onOutcome(outcome: ControlPlaneOutcome): Promise<void> {
    await this.initialized;
    if (this.registration === null) return;
    const parsed = controlPlaneOutcomeSchema.parse(outcome);
    await this.enqueue(async () => {
      // A delete queued ahead of this outcome wiped the session.
      if (this.registration === null) return;
      const reduction = settleAcceptedUpTo(
        this.messages,
        parsed.lastMessageId,
        parsed.status,
        parsed.reason,
        Date.now()
      );
      await this.applySettlement(
        reduction,
        {
          ...(parsed.assistantReason === undefined
            ? {}
            : { assistantReason: parsed.assistantReason }),
          ...(parsed.providerOwnership === undefined
            ? {}
            : { providerOwnership: parsed.providerOwnership }),
        },
        'wrapper_outcome'
      );
      // The turn ended: the route is ready for the next one (spec §10).
      if (reduction.changed.length > 0) this.emitCloudStatus({ type: 'ready' });
      // An outcome is a terminal event: capture on it. Interruption is set only
      // by an explicit user cancel (`stop`).
      this.worktreeChanges.onOutcome({ ...parsed });
    });
  }

  // --- worktree changes (B10) -------------------------------------------------

  async getWorktreeChanges(): Promise<GetWorktreeChangesOutput> {
    await this.initialized;
    return this.worktreeChanges.get();
  }

  getWorktreeFile(input: unknown): GetWorktreeFileOutput {
    return this.worktreeChanges.getFile(input);
  }

  async refreshWorktreeChanges(): Promise<RefreshWorktreeChangesOutput> {
    await this.initialized;
    return this.worktreeChanges.refresh();
  }

  // --- backstop alarm ---------------------------------------------------------

  async alarm(): Promise<void> {
    await this.initialized;
    if (this.registration === null) return;
    await this.enqueue(async () => {
      // The alarm can wake an evicted instance; storage is authoritative.
      this.messages = await this.loadMessages();
      // Retry any report/callback obligation a previous attempt could not send.
      await this.repairOutboxes();
      const now = Date.now();
      const due = dueBackstopMessages(this.messages, now, this.sessionTimers());
      if (due.length > 0) {
        const byReason = new Map<string, string[]>();
        for (const entry of due) {
          const ids = byReason.get(entry.reason) ?? [];
          ids.push(entry.message.messageId);
          byReason.set(entry.reason, ids);
        }
        for (const [reason, ids] of byReason) {
          await this.settleMessages(ids, 'failed', reason);
        }
      }
      if (this.transportRecoveryAt !== null && this.transportRecoveryAt <= now) {
        await this.clearTransportRecovery();
        await this.recoverQueued(this.transportPass(false));
      }
      await this.armAlarm();
    });
  }

  /**
   * The one place that sets the alarm. It wakes for the earliest backstop
   * deadline, transport recovery, the next report or callback obligation.
   * Outbox due times retry failed reporting even once no message is open.
   */
  private async armAlarm(): Promise<void> {
    if (!this.messages.some(message => message.state === 'queued')) {
      await this.clearTransportRecovery();
    }
    const candidates = [
      this.transportRecoveryAt,
      nextBackstopAt(this.messages, this.sessionTimers()),
      this.reportOutbox.nextDueAt() ?? null,
      this.messageCallbacks.nextCallbackDueAt() ?? null,
    ].filter((value): value is number => value !== null);
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  // --- reads ------------------------------------------------------------------

  async getSession(): Promise<ControlPlaneSessionSnapshot> {
    await this.initialized;
    if (this.registration === null) return { type: 'session-not-found' };
    return {
      type: 'found',
      sessionId: this.sessionId,
      route: this.route,
      messages: this.messages.map(message => ({
        messageId: message.messageId,
        state: message.state,
        createdAt: message.createdAt,
        acceptedAt: message.acceptedAt,
        settledAt: message.settledAt,
        reason: message.reason,
      })),
      latestEventId: this.eventQueries.getLatestEventId(),
    };
  }

  /**
   * Worker-facing sandbox-status RPC (spec §10, B10 badge). Returns the public
   * snapshot from the Sandbox DO; without a registered sandbox it reports the
   * static `unknown`/`status_unavailable` presentation.
   */
  async getSandboxStatus(): Promise<SandboxStatusSnapshot> {
    await this.initialized;
    const sandboxId = this.registration?.sandboxId;
    const peer = sandboxId === undefined ? null : this.sandboxPeerFor(sandboxId);
    if (peer === null) return unavailableStatusSnapshot();
    try {
      return await peer.getStatusSnapshot();
    } catch {
      return unavailableStatusSnapshot();
    }
  }

  async getMessageResult(messageId: string): Promise<MessageResultRPCResponse> {
    await this.initialized;
    if (this.registration === null) return { type: 'session-not-found' };
    const message = this.messages.find(item => item.messageId === messageId);
    if (message === undefined) return { type: 'message-not-found' };
    const result: SafeMessageResultResponse = {
      messageId: message.messageId,
      status:
        message.state === 'queued'
          ? 'queued'
          : message.state === 'accepted'
            ? 'running'
            : message.state === 'cancelled'
              ? 'interrupted'
              : message.state,
      createdAt: message.createdAt,
      ...(message.acceptedAt === null ? {} : { acceptedAt: message.acceptedAt }),
      ...(message.settledAt === null ? {} : { terminalAt: message.settledAt }),
      cloudAgentSessionId: this.sessionId,
    };
    return { type: 'found', result };
  }

  /**
   * Latest assistant message for the session's Kilo session (legacy
   * `getLatestAssistantMessage`). Reads the shared event log; the Kilo session
   * id is the route spec's identity.
   */
  async getLatestAssistantMessage(): Promise<LatestAssistantMessage | null> {
    await this.initialized;
    const kiloSessionId = this.registration?.spec.kiloSessionId;
    if (kiloSessionId === undefined) return null;
    return this.eventQueries.getLatestAssistantMessage(this.sessionId, kiloSessionId);
  }

  /**
   * Stored runtime-authorization status (legacy `getRuntimeAuthorizationStatus`
   * plus the recovery-state read). One authoritative 4-state read over the
   * persisted authorization: `legacy`/`active` need no recovery, `expired`
   * carries the id the Worker needs to mint a replacement, `revoked` is denied.
   */
  async getRuntimeAuthorizationStatus(): Promise<{
    state: 'legacy' | 'active' | 'expired' | 'revoked';
    id?: string;
  }> {
    await this.initialized;
    return readRuntimeAuthorizationRecoveryState({
      metadata: this.metadata,
      getAuthorization: () => this.ctx.storage.get<unknown>(RUNTIME_AUTHORIZATION_KEY),
    });
  }

  /**
   * C1c expiry recovery (legacy `recoverExpiredRuntimeAuthorization`). Replaces
   * an expired stored authorization with a freshly minted one. The Sandbox DO
   * owns physical wrapper retirement, so this releases the current route before
   * committing; only an idle session with no open work is recovered.
   */
  async recoverExpiredRuntimeAuthorization(input: {
    ownerId: string;
    expectedOldId: string;
    runtimeAuthorizationSeal: string;
    runtimeToken: string;
  }): Promise<{ status: 'recovered' | 'not-needed' | 'denied' | 'busy' | 'retry' }> {
    await this.initialized;
    return this.enqueue(async () => {
      const metadata = this.metadata;
      if (metadata === null || metadata.identity.userId !== input.ownerId) {
        return { status: 'denied' as const };
      }
      const secret = await resolveSecret(this.env.NEXTAUTH_SECRET);
      if (!secret) return { status: 'denied' as const };
      let fresh: RuntimeAuthorization;
      try {
        fresh = await unsealRuntimeAuthorization(input.runtimeAuthorizationSeal, secret, {
          resourceKind: 'cloud-agent-next',
          resourceId: metadata.identity.sessionId,
          userId: metadata.identity.userId,
          organizationId: metadata.identity.orgId,
        });
      } catch {
        return { status: 'denied' as const };
      }
      if (fresh.state !== 'active') return { status: 'denied' as const };

      const state = await this.getRuntimeAuthorizationStatus();
      if (state.state === 'legacy' || state.state === 'active') {
        return { status: 'not-needed' as const };
      }
      if (state.state !== 'expired' || state.id !== input.expectedOldId) {
        return { status: 'denied' as const };
      }
      if (openMessages(this.messages).length > 0) return { status: 'busy' as const };

      const peer = this.sandboxPeer();
      if (peer !== null) {
        try {
          // Revoking the route retires the wrapper still holding the expired
          // credential; the next send prepares a fresh route.
          await peer.release({ sessionId: this.sessionId });
        } catch {
          return { status: 'retry' as const };
        }
      }

      const current = RuntimeAuthorizationSchema.safeParse(
        await this.ctx.storage.get<unknown>(RUNTIME_AUTHORIZATION_KEY)
      );
      const latest = this.metadata;
      if (
        !current.success ||
        current.data.id !== input.expectedOldId ||
        current.data.state !== 'active' ||
        Date.parse(current.data.delegationExpiresAt) > Date.now() ||
        latest === null ||
        latest.identity.sessionId !== metadata.identity.sessionId
      ) {
        return { status: 'retry' as const };
      }
      await this.ctx.storage.put(RUNTIME_AUTHORIZATION_KEY, fresh);
      const updated: SessionMetadata = {
        ...latest,
        auth: { ...latest.auth, kilocodeToken: input.runtimeToken },
      };
      await this.ctx.storage.put(SESSION_METADATA_KEY, serializeSessionMetadata(updated));
      this.metadata = updated;
      return { status: 'recovered' as const };
    });
  }

  /**
   * C1c security: closes this session's stream sockets when its owner leaves an
   * organization (legacy `closeOrgStreams`). Reads the org from the same
   * persisted metadata both planes use and only closes on a match.
   */
  async closeOrgStreams(organizationId: string): Promise<number> {
    await this.initialized;
    const orgId = this.metadata?.identity.orgId;
    if (!orgId || orgId !== organizationId) return 0;
    let closed = 0;
    for (const socket of this.ctx.getWebSockets('stream')) {
      socket.close(1000, 'session access revoked');
      closed++;
    }
    return closed;
  }

  // --- delete and worktree deletion ------------------------------------------

  /**
   * C1c: updates a prepared session's callback target (legacy `tryUpdate`,
   * retained for `services/code-review-infra`). Stores the same grouped
   * metadata both planes persist.
   */
  async tryUpdate(updates: { callbackTarget?: CallbackTarget | null }): Promise<OperationResult> {
    await this.initialized;
    return this.enqueue(async () => {
      const metadata = this.metadata;
      if (metadata === null) {
        return { success: false, error: 'Session metadata is not available' };
      }
      const updated: SessionMetadata = { ...metadata };
      if (updates.callbackTarget === null) {
        delete updated.callback;
      } else if (updates.callbackTarget !== undefined) {
        updated.callback = { target: updates.callbackTarget };
      }
      let serialized: SessionMetadata;
      try {
        serialized = serializeSessionMetadata(updated);
      } catch (error) {
        return {
          success: false,
          error: `Invalid metadata after update: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      await this.ctx.storage.put(SESSION_METADATA_KEY, serialized);
      this.metadata = serialized;
      return { success: true };
    });
  }

  /**
   * Delete the session (legacy `deleteSession`): remove its sandbox route (spec
   * §6 `release (session deleted)`), then tear the session down. Idempotent: a
   * second call finds no registration and does nothing. `release` is retried and
   * a persistent failure aborts before the wipe, so deletion stays retryable.
   */
  async deleteSession(): Promise<void> {
    await this.initialized;
    if (this.registration === null) return;
    await this.enqueue(async () => {
      const peer = this.sandboxPeer();
      if (peer !== null) {
        await withDORetry(
          () => peer,
          current => current.release({ sessionId: this.sessionId }),
          'release'
        );
      }
      await this.tearDownSession();
    });
  }

  /**
   * Worktree deletion, phase 1 (legacy `beginWorktreeDeletion`): validate the
   * request against stored metadata, close this session's sockets, and return
   * the runtime location plus the child Kilo sessions the Worker collects into
   * the deletion manifest. Sandbox resource cleanup is owned by the Sandbox DO
   * (`deleteWorktreeResources`); this session-side method holds no per-worktree
   * deletion state of its own.
   */
  async beginWorktreeDeletion(input: {
    worktreeId: string;
    kiloSessionId: string;
    ownerId: string;
    organizationId?: string;
  }): Promise<{
    location: CloudAgentWorktreeLocation | null;
    children: CloudAgentChildSessionLineage[];
    directory: string | null;
  }> {
    await this.initialized;
    const worktreeId = cloudAgentWorktreeIdSchema.parse(input.worktreeId);
    const metadata = this.metadata;
    if (metadata === null) return { location: null, children: [], directory: null };
    if (
      metadata.workspace?.worktreeId !== worktreeId ||
      metadata.auth.kiloSessionId !== input.kiloSessionId ||
      metadata.identity.userId !== input.ownerId ||
      metadata.identity.orgId !== input.organizationId
    ) {
      throw new Error('Worktree identity conflict');
    }
    for (const socket of this.ctx.getWebSockets()) socket.close(1001, 'Worktree deleted');
    const location = this.worktreeLocation(metadata);
    const registration = this.registration;
    const children =
      registration === null
        ? []
        : readWorktreeChildSessions({
            db: this.db,
            sessionId: this.sessionId,
            ownKiloSessionId: registration.spec.kiloSessionId,
            directory: registration.spec.directory,
          });
    return {
      location: location === null ? null : cloudAgentWorktreeLocationSchema.parse(location),
      children,
      directory: registration?.spec.directory ?? null,
    };
  }

  /**
   * Worktree deletion, phase 2 (legacy `finishWorktreeDeletion`): purge this
   * session's data once the Sandbox DO confirmed the worktree cleanup. Idempotent
   * and holds no per-worktree state: the Sandbox DO already removed the routes.
   */
  async finishWorktreeDeletion(worktreeId: string): Promise<void> {
    await this.initialized;
    cloudAgentWorktreeIdSchema.parse(worktreeId);
    if (this.registration === null) return;
    await this.enqueue(async () => {
      await this.tearDownSession();
    });
  }

  /**
   * The delete tail shared by `deleteSession` and `finishWorktreeDeletion`:
   * close client sockets, stop worktree capture, settle any open message as
   * cancelled/interrupted (legacy `snapshotDeletedMessages`, so a delete cannot
   * drop an open turn without its terminal report/callback), force-flush every
   * pending report/callback obligation regardless of backoff, then wipe. Always
   * runs under the serial queue.
   */
  private async tearDownSession(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) socket.close(1001, 'Session deleted');
    // A late capture after this must not write the deleted worktree's diff.
    this.worktreeChanges.suppress();
    const openIds = openMessages(this.messages).map(message => message.messageId);
    if (openIds.length > 0) {
      await this.settleMessages(openIds, 'cancelled', 'interrupted');
    }
    await this.repairOutboxes(Number.MAX_SAFE_INTEGER);
    this.logDiscardedObligations();
    await this.resetSessionStorage();
  }

  /** Names the obligations a delete could not deliver; never logs secrets. */
  private logDiscardedObligations(): void {
    const reports = this.reportOutbox.pendingCount();
    const callbacks = this.messageCallbacks.pendingCallbackCount();
    if (reports === 0 && callbacks === 0) return;
    logger
      .withFields({ sessionId: this.sessionId, reports, callbacks })
      .warn('Discarding undelivered report/callback obligations on session deletion');
  }

  /** The sandbox location projection both runtime-location and deletion use. */
  private worktreeLocation(metadata: SessionMetadata): CloudAgentWorktreeLocation | null {
    const locator = sessionRuntimeLocator(metadata);
    return locator === null ? null : locator.location;
  }

  /**
   * Wipe this DO back to its fresh V2 state: no registration, no messages, no
   * events, no outbox, and the V2 migrations re-applied. The generation key is
   * restored so a later instance runs the normal V2 init rather than the
   * old-plane wipe.
   */
  private async resetSessionStorage(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put(GENERATION_KEY, GENERATION);
    await migrate(this.db, migrations);
    this.registration = null;
    this.metadata = null;
    this.runtimeAuthorization = undefined;
    this.messages = [];
    this.route = { state: 'unknown' };
    this.transportRecoveryAt = null;
    this.pendingInteractions = undefined;
    this.availableCommands = { commands: [] };
    this.rootStatus = undefined;
    this.worktreePreparationGeneration = undefined;
    this.preparationRecorders.clear();
  }

  // --- terminals (B10) --------------------------------------------------------

  /** Worker-facing terminal RPC (spec §10); routing/handler wiring is C1. */
  async terminalCreate(input: {
    operationId: string;
    cols?: number;
    rows?: number;
  }): Promise<OperationResult<{ pty: WrapperPty }>> {
    await this.initialized;
    return this.terminals.create(input);
  }

  async terminalResize(input: {
    ptyId: string;
    cols: number;
    rows: number;
  }): Promise<OperationResult<{ pty: WrapperPty }>> {
    await this.initialized;
    return this.terminals.resize(input);
  }

  async terminalClose(input: { ptyId: string }): Promise<OperationResult<{ success: boolean }>> {
    await this.initialized;
    return this.terminals.close(input);
  }

  // --- stream -----------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const pathname = new URL(request.url).pathname;
    if (pathname === '/terminal/browser') {
      return this.terminals.handleBrowserUpgrade(request);
    }
    if (pathname === '/terminal/wrapper') {
      return this.terminals.handleWrapperUpgrade(request);
    }
    if (pathname !== '/stream') return new Response('Not found', { status: 404 });
    if (this.registration === null) return new Response('Session not found', { status: 404 });
    if (new URL(request.url).searchParams.get('sandboxStatus') === 'true') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
        return new Response('Expected WebSocket upgrade', { status: 426 });
      const sandboxId = this.registration.sandboxId;
      if (this.metadata === null) return new Response('Sandbox unavailable', { status: 503 });
      const url = new URL('https://sandbox.internal/status-stream');
      url.searchParams.set('sessionId', this.sessionId);
      url.searchParams.set('ownerId', this.metadata.identity.userId);
      try {
        return await withDORetry(
          () => {
            const peer = this.sandboxPeerFor(sandboxId);
            if (peer === null) throw new Error('Sandbox unavailable');
            return peer;
          },
          peer => peer.fetch(new Request(url, { headers: { Upgrade: 'websocket' } })),
          'sandboxStatusStream'
        );
      } catch {
        return new Response('Sandbox unavailable', { status: 503 });
      }
    }
    return this.streamHandler().handleStreamRequest(request);
  }

  /**
   * The stream is one-way; the hibernatable socket attachment holds the client
   * filters, so close/error only need to exist for the runtime's lifecycle.
   * Terminal sockets share these handlers; the bridge ignores attachments it
   * does not own.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.initialized;
    await this.terminals.handleMessage(ws, message);
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    await this.initialized;
    await this.terminals.handleClose(ws, code, reason, wasClean);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await this.initialized;
    await this.terminals.handleError(ws, error);
  }

  private streamHandler() {
    return createStreamHandler(this.ctx, this.eventQueries, this.sessionId, {
      deriveCloudStatus: async () => this.deriveCloudStatus(),
      deriveQueuedMessages: async () => this.deriveQueuedMessages(),
      deriveSessionStatus: async () => this.deriveSessionStatus(),
      readPendingInteractions: () => this.readPendingInteractions(),
      getAvailableCommands: async () => this.availableCommands,
      getPreparationSnapshots: async () => getPreparationSnapshots(this.eventQueries),
    });
  }

  // --- route view -------------------------------------------------------------

  private async applyView(view: ControlPlaneRouteView, pass = this.transportPass()): Promise<void> {
    // The route view is the source of the preparation row: the previous
    // persisted view names the attempt that is open, so a transition closes it
    // even if this process lost its in-memory recorder map to eviction.
    const previous = this.route;
    const previousAttemptId = previous.state === 'unknown' ? undefined : previous.attemptId;
    const nextAttemptId = view.state === 'unknown' ? undefined : view.attemptId;
    if (
      previous.state !== view.state ||
      previousAttemptId !== nextAttemptId ||
      (view.state === 'failed' && (previous.state !== 'failed' || previous.reason !== view.reason))
    ) {
      logControlDiagnostic('session_route_view', {
        sessionId: this.sessionId,
        from: previous.state,
        to: view.state,
        fromAttemptId: previousAttemptId,
        toAttemptId: nextAttemptId,
        reason: view.state === 'failed' ? view.reason : undefined,
        subtype: view.state === 'failed' ? view.subtype : undefined,
        queuedMessages: this.messages.filter(message => message.state === 'queued').length,
        acceptedMessages: this.messages.filter(message => message.state === 'accepted').length,
      });
    }
    const route = persistedRouteView(view, previous);
    await this.persistRoute(route);
    if (route.state === 'preparing' || route.state === 'reconnecting') {
      await this.clearTransportRecovery();
    }
    switch (route.state) {
      case 'unknown':
        this.finalizePreparingRoute(previous, {
          status: 'failed',
          safeError: 'Preparation did not complete',
        });
        this.finishWorktreePreparation();
        return;
      case 'reconnecting':
        // The route is ready with no socket: prep is done, close the row.
        this.finalizePreparingRoute(previous, { status: 'completed' });
        this.finishWorktreePreparation();
        return;
      case 'preparing': {
        // A new route attempt supersedes the previous one's open row.
        if (previous.state === 'preparing' && previous.attemptId !== route.attemptId) {
          this.finalizeAttempt(previous.attemptId, {
            status: 'failed',
            safeError: 'Preparation did not complete',
          });
        }
        // Suppress captures while the route prepares; a capture runs after
        // attach (`ready`), like the legacy preparation hooks.
        this.worktreePreparationGeneration = this.worktreeChanges.beginPreparation();
        const publicStep = publicPreparationStep(route.step) ?? 'workspace_setup';
        this.emitCloudStatus({ type: 'preparing', step: publicStep });
        const head = oldestOpenMessage(this.messages, 'queued');
        // A stepless repeat of an open attempt (a repeated `prepare`) carries
        // its step forward and must not overwrite the step's live detail.
        const stepless = view.state === 'preparing' && view.step === undefined;
        if (
          head !== undefined &&
          (!stepless || readPreparationAttempt(this.eventQueries, route.attemptId) === null)
        ) {
          this.preparationRecorder(route.attemptId, head.messageId).onProgress(
            publicStep,
            (view.state === 'preparing' ? view.detail : undefined) ??
              (route.step === undefined
                ? 'Preparing environment'
                : PREPARING_STEP_MESSAGE[route.step])
          );
        }
        return;
      }
      case 'ready': {
        // The attempt's preparation is done before its messages are delivered.
        if (this.worktreePreparationGeneration !== undefined) {
          this.worktreeChanges.attached(this.worktreePreparationGeneration);
          this.worktreePreparationGeneration = undefined;
        }
        this.finalizePreparingRoute(previous, { status: 'completed' });
        this.emitCloudStatus({ type: 'ready' });
        await this.deliverQueued(pass);
        return;
      }
      case 'failed':
        this.finishWorktreePreparation();
        logger
          .withFields({
            sessionId: this.sessionId,
            attemptId: route.attemptId,
            reason: route.reason,
            ...(route.subtype === undefined ? {} : { subtype: route.subtype }),
          })
          .warn('Control-plane workspace preparation failed');
        this.finalizePreparingRoute(previous, { status: 'failed', safeError: route.reason });
        this.emitCloudStatus({ type: 'error', message: route.reason });
        await this.settleMessages(
          openMessages(this.messages).map(message => message.messageId),
          'failed',
          route.reason,
          route.subtype === undefined ? undefined : { workspaceSubtype: route.subtype }
        );
        return;
    }
  }

  /** Close the previous route's open preparation row when the route leaves it. */
  private finalizePreparingRoute(
    previous: ControlPlaneRouteView,
    outcome: PreparationOutcome
  ): void {
    if (previous.state !== 'preparing') return;
    this.finalizeAttempt(previous.attemptId, outcome);
  }

  /** Clears a `preparing` state that did not reach `ready` (spec §10 hooks). */
  private finishWorktreePreparation(): void {
    if (this.worktreePreparationGeneration === undefined) return;
    this.worktreeChanges.finishPreparation(this.worktreePreparationGeneration);
    this.worktreePreparationGeneration = undefined;
  }

  private async deliverQueued(pass = this.transportPass()): Promise<void> {
    if (await this.failRetiredQueuedMessages()) return;
    const queued = this.messages.filter(message => message.state === 'queued');
    if (queued.length === 0) return;
    const peer = this.sandboxPeer();
    if (peer === null) {
      await this.scheduleTransportRecovery(pass);
      return;
    }
    let result: ControlPlaneDeliverResult;
    try {
      result = await withDORetry(
        () => this.sandboxPeer() ?? peer,
        stub =>
          stub.deliver({
            sessionId: this.sessionId,
            messages: queued.map(message => message.intent),
          }),
        'session.deliver',
        this.sandboxRpcConfig(pass)
      );
    } catch {
      await this.scheduleTransportRecovery(pass);
      return;
    }
    if (result === 'sent') {
      const now = Date.now();
      const reduction = acceptMessages(
        this.messages,
        queued.map(message => message.messageId),
        now
      );
      this.messages = reduction.messages;
      await this.persistMessages(reduction.changed);
      for (const message of reduction.changed) {
        this.emitSent(message);
        logControlDiagnostic('session_message_committed', {
          sessionId: this.sessionId,
          source: 'coordinator',
          messageId: message.messageId,
          fromState: 'queued',
          toState: 'accepted',
          lifecycleEventInserted: false,
        });
      }
      await this.armAlarm();
      return;
    }
    // `not_ready`: keep them queued and act on the view `prepare` returns
    // (spec §5). A `ready` view only updates the stored route and returns: it
    // must not re-enter delivery in this task, or a write that keeps losing to
    // a ready route would recurse with no exit. The next `send` or `onRoute`
    // retries, with one transport recovery opportunity if still ready.
    const view = await this.prepareSandbox(pass);
    if (view === null) return;
    if (view.state === 'ready') {
      await this.persistRoute(view);
      await this.scheduleTransportRecovery(pass);
      return;
    }
    await this.applyView(view, pass);
  }

  private async failRetiredQueuedMessages(): Promise<boolean> {
    if (this.metadata === null || !hasRetiredDevcontainerRuntime(this.metadata)) return false;
    await this.settleMessages(
      this.messages.filter(message => message.state === 'queued').map(message => message.messageId),
      'failed',
      DEVCONTAINER_RETIRED_MESSAGE
    );
    this.finishWorktreePreparation();
    return true;
  }

  private async prepareSandbox(pass = this.transportPass()): Promise<ControlPlaneRouteView | null> {
    if (await this.failRetiredQueuedMessages()) return null;
    const peer = this.sandboxPeer();
    const registration = this.registration;
    if (registration === null) return null;
    if (peer === null) {
      await this.scheduleTransportRecovery(pass);
      return null;
    }
    try {
      return await withDORetry(
        () => this.sandboxPeer() ?? peer,
        stub =>
          stub.prepare({
            spec: registration.spec,
            credentials: registration.credentials,
            ...(registration.sandboxSelection
              ? { sandboxSelection: registration.sandboxSelection }
              : {}),
          }),
        'session.prepare',
        this.sandboxRpcConfig(pass)
      );
    } catch {
      // `unknown` must come only from the Sandbox, never from a transport error.
      await this.scheduleTransportRecovery(pass);
      return null;
    }
  }

  private async recoverQueued(
    pass: TransportPass,
    ownerHint?: ControlPlaneRouteUpdate
  ): Promise<void> {
    if (!this.messages.some(message => message.state === 'queued')) return;
    let view = await this.readSandboxView(pass);
    if (view === null) return;
    if (
      ownerHint?.state === 'lost' &&
      ownerHint.attemptId === this.currentAttemptId() &&
      (view.state === 'unknown' || view.attemptId !== ownerHint.attemptId)
    ) {
      await this.settleMessages(
        this.messages
          .filter(message => message.state === 'accepted')
          .map(message => message.messageId),
        'failed',
        ownerHint.reason
      );
    }
    if (ownerHint && view.state !== 'unknown' && view.attemptId !== this.currentAttemptId()) {
      pass.scheduleRecovery = true;
    }
    if (
      view.state === 'unknown' ||
      (view.state === 'failed' &&
        this.route.state === 'failed' &&
        view.attemptId === this.route.attemptId)
    ) {
      const prepared = await this.prepareSandbox(pass);
      if (prepared === null) return;
      if (
        prepared.state === 'failed' &&
        this.route.state === 'failed' &&
        prepared.attemptId === this.route.attemptId
      ) {
        await this.scheduleTransportRecovery(pass);
        return;
      }
      view = prepared;
    }
    if (
      ownerHint?.state === 'preparing' &&
      view.state === 'preparing' &&
      ownerHint.attemptId === view.attemptId
    ) {
      view = ownerHint;
    } else if (
      ownerHint?.state === 'failed' &&
      view.state === 'failed' &&
      ownerHint.attemptId === view.attemptId &&
      ownerHint.reason === view.reason
    ) {
      view = ownerHint;
    }
    await this.applyView(view, pass);
  }

  private async readSandboxView(pass: TransportPass): Promise<ControlPlaneRouteView | null> {
    const peer = this.sandboxPeer();
    if (peer === null) {
      await this.scheduleTransportRecovery(pass);
      return null;
    }
    try {
      const status = await withDORetry(
        () => this.sandboxPeer() ?? peer,
        current => current.status({ sessionId: this.sessionId }),
        'session.status',
        this.sandboxRpcConfig(pass)
      );
      return controlPlaneRouteViewSchema.parse(status.view);
    } catch {
      await this.scheduleTransportRecovery(pass);
      return null;
    }
  }

  private transportPass(scheduleRecovery = true): TransportPass {
    return { deadlineAt: Date.now() + this.sessionTimers().sandboxRpcDeadlineMs, scheduleRecovery };
  }

  private async scheduleTransportRecovery(pass: TransportPass): Promise<void> {
    if (
      !pass.scheduleRecovery ||
      this.transportRecoveryAt !== null ||
      !this.messages.some(message => message.state === 'queued')
    )
      return;
    const dueAt = Date.now() + this.sessionTimers().transportRecoveryMs;
    await this.ctx.storage.put(TRANSPORT_RECOVERY_KEY, dueAt);
    this.transportRecoveryAt = dueAt;
    await this.armAlarm();
  }

  private async clearTransportRecovery(): Promise<void> {
    if (this.transportRecoveryAt === null) return;
    await this.ctx.storage.delete(TRANSPORT_RECOVERY_KEY);
    this.transportRecoveryAt = null;
  }

  private sandboxRpcConfig(pass: TransportPass) {
    return {
      ...DEFAULT_DO_RETRY_CONFIG,
      scope: { deadlineAt: pass.deadlineAt },
    };
  }

  private sandboxPeer(): ControlPlaneSandboxPeer | null {
    const sandboxId = this.registration?.sandboxId;
    return sandboxId === undefined ? null : this.sandboxPeerFor(sandboxId);
  }

  private resolveSandboxPeer(sandboxId: string): ControlPlaneSandboxPeer | null {
    const namespace = sandboxControlPeerNamespace<ControlPlaneSandboxPeer>(this.env);
    return namespace === undefined ? null : namespace.getByName(sandboxId);
  }

  // --- preparation progress ---------------------------------------------------

  /**
   * The preparation attempt id is the route attempt id (spec §10); the trigger
   * is the oldest queued message. The recorder owns step continuity and the
   * materialized attempt snapshots that a stream reconnect replays.
   */
  private preparationRecorder(
    attemptId: string,
    triggerMessageId: string
  ): ReturnType<typeof createPreparationProgressRecorder> {
    let recorder = this.preparationRecorders.get(attemptId);
    if (recorder === undefined) {
      recorder = createPreparationProgressRecorder({
        attemptId,
        triggerMessageId,
        sessionId: this.sessionId,
        eventQueries: this.eventQueries,
        broadcast: event => this.broadcast(event),
      });
      this.preparationRecorders.set(attemptId, recorder);
    }
    return recorder;
  }

  /**
   * Render a wrapper setup-command lifecycle event into the active preparation
   * attempt. Each command is its own `setup_command` step under the
   * `setup_commands` phase (mirroring the legacy bootstrap), so the preparation
   * UI shows the numbered command, its output, and its terminal state.
   */
  private recordSetupEvent(event: ControlPlaneSetupEvent): void {
    if (this.route.state !== 'preparing') return;
    const attemptId = this.route.attemptId;
    const attempt = readPreparationAttempt(this.eventQueries, attemptId);
    if (attempt?.status !== 'running') return;
    const command = event.properties.command;
    const stepId = `setup_command:${command - 1}`;
    const existingStep = readPreparationSteps(this.eventQueries, attemptId).find(
      step => step.id === stepId
    );
    if (existingStep !== undefined && existingStep.status !== 'running') return;
    const base = {
      version: 2 as const,
      attemptId,
      triggerMessageId: attempt.triggerMessageId,
      revision: attempt.revision + 1,
      timestamp: Date.now(),
      step: 'setup_commands' as const,
    };
    const apply = (data: Record<string, unknown>): boolean =>
      applyControlPlanePreparingEvent({
        sessionId: this.sessionId,
        data,
        eventQueries: this.eventQueries,
        broadcast: stored => this.broadcast(stored),
      });

    if (existingStep === undefined) {
      const label = `Setup command ${command}`;
      if (
        !apply({
          ...base,
          message: label,
          action: 'step_started',
          stepId,
          kind: 'setup_command',
          label,
          commandIndex: command - 1,
          ...(event.type === CONTROL_PLANE_SETUP_EVENTS.started
            ? { commandCount: event.properties.commandCount }
            : {}),
        })
      )
        return;
      base.revision += 1;
    }

    if (event.type === CONTROL_PLANE_SETUP_EVENTS.output) {
      apply({
        ...base,
        message: `Setup command ${command} output`,
        action: 'step_output',
        stepId,
        output: event.properties.output,
      });
    }

    if (event.type === CONTROL_PLANE_SETUP_EVENTS.finished) {
      const { exitCode, safeError } = event.properties;
      const failed = safeError !== undefined || exitCode !== 0;
      const failedMessage = safeError ?? `Setup command ${command} failed`;
      apply({
        ...base,
        message: failed ? failedMessage : 'Setup command finished',
        action: failed ? 'step_failed' : 'step_completed',
        stepId,
        ...(failed ? { safeError: failedMessage } : {}),
        exitCode,
      });
    }
  }

  /** Close one route attempt's open row by persisted identity, never by a scan. */
  private finalizeAttempt(attemptId: string, outcome: PreparationOutcome): void {
    this.preparationRecorders.delete(attemptId);
    for (const event of finalizePreparationAttempt(this.eventQueries, attemptId, {
      ...outcome,
      timestamp: Date.now(),
    })) {
      this.broadcast(event);
    }
  }

  /** The route attempt a notification must name (the route-view fence). */
  private currentAttemptId(): string | null {
    return this.route.state === 'unknown' ? null : this.route.attemptId;
  }

  // --- settlement and message events -----------------------------------------

  private async settleMessages(
    messageIds: readonly string[],
    status: Extract<SessionMessageState, 'completed' | 'failed' | 'cancelled'>,
    reason: string | undefined,
    facts?: ControlPlaneReportFacts,
    source: ControlPlaneMessageSource = 'coordinator'
  ): Promise<void> {
    await this.applySettlement(
      settleMessages(this.messages, messageIds, status, reason, Date.now()),
      facts,
      source
    );
  }

  /**
   * One owner for the side effects of a terminal transition: durable rows,
   * terminal stream events, the `session_message_committed` diagnostic the
   * failure monitors read, the report obligation per message, and the drained
   * batch callback. Report and callback writes are best effort; a failure there
   * is logged and never fails the turn (plan B5).
   */
  private async applySettlement(
    reduction: MessageReduction,
    facts?: ControlPlaneReportFacts,
    source: ControlPlaneMessageSource = 'coordinator'
  ): Promise<void> {
    if (reduction.changed.length === 0) {
      await this.armAlarm();
      return;
    }
    const previousStates = new Map(
      this.messages.map(message => [message.messageId, message.state])
    );
    this.messages = reduction.messages;
    await this.persistMessages(reduction.changed);
    if (reduction.changed.some(message => previousStates.get(message.messageId) === 'accepted'))
      await this.settleRootStatus();
    for (const message of reduction.changed) {
      const lifecycleEventInserted = this.emitTerminal(message);
      this.recordReport(message, facts);
      logControlDiagnostic('session_message_committed', {
        sessionId: this.sessionId,
        source,
        messageId: message.messageId,
        fromState: previousStates.get(message.messageId),
        toState: message.state,
        terminalAt: message.settledAt,
        lifecycleEventInserted,
        cause: message.reason === null ? undefined : diagnosticCause(message.reason),
      });
    }
    // Persist the callback, attempt delivery now, then arm only what remains:
    // a failed send keeps its due time and is retried by the alarm.
    this.persistBatchCallback(reduction.changed, facts);
    await this.repairOutboxes();
    await this.armAlarm();
  }

  /**
   * Records the first-message report anchor once, from the kept report outbox
   * (spec §10 report contract). The anchor fields are all-or-none.
   */
  private ensureReportAnchor(first: SessionMessage | undefined): void {
    if (first === undefined || readReportAnchor(this.ctx.storage) !== undefined) return;
    const kiloSessionId = this.registration?.spec.kiloSessionId;
    if (kiloSessionId === undefined) return;
    writeReportAnchor(this.ctx.storage, {
      kiloSessionId,
      initialMessageId: first.messageId,
      createdAt: first.createdAt,
    });
  }

  private recordReport(message: SessionMessage, facts?: ControlPlaneReportFacts): void {
    try {
      const anchor = readReportAnchor(this.ctx.storage);
      const report = buildControlPlaneMessageReport({
        cloudAgentSessionId: this.sessionId,
        message,
        ...(anchor === undefined ? {} : { anchor: reportAnchorForQueue(anchor) }),
        ...(facts === undefined ? {} : { facts }),
      });
      if (report !== undefined) this.reportOutbox.record(report);
    } catch {
      logger
        .withFields({ sessionId: this.sessionId, messageId: message.messageId })
        .warn('Cloud Agent report write failed; the turn is unaffected');
    }
  }

  private persistBatchCallback(
    changed: readonly SessionMessage[],
    facts?: ControlPlaneReportFacts
  ): void {
    try {
      const newlyTerminal = new Set(
        changed
          .filter(message => isTerminalMessage(message.state))
          .map(message => message.messageId)
      );
      this.messageCallbacks.persistDrainedBatchCallback(
        this.messages,
        newlyTerminal,
        undefined,
        facts
      );
    } catch {
      logger.withFields({ sessionId: this.sessionId }).warn('Cloud Agent callback write failed');
    }
  }

  private async repairOutboxes(now: number = Date.now()): Promise<void> {
    try {
      await this.reportOutbox.repair(now);
    } catch {
      // Best effort: a later settlement or alarm retries.
    }
    try {
      await this.messageCallbacks.repair(now);
    } catch {
      // Best effort: a later settlement or alarm retries.
    }
  }

  private emitQueued(message: SessionMessage): void {
    this.emitSynthetic(
      'cloud.message.queued',
      {
        messageId: message.messageId,
        content: renderTurnContent(message.intent),
        delivery: 'queued',
      },
      message.createdAt
    );
  }

  private emitSent(message: SessionMessage): void {
    this.emitSynthetic(
      'cloud.message.sent',
      { messageId: message.messageId, delivery: 'sent' },
      message.acceptedAt ?? message.createdAt
    );
  }

  /** Inserts the terminal event idempotently; returns whether a row was added. */
  private emitTerminal(message: SessionMessage): boolean {
    if (!isTerminalMessage(message.state)) return false;
    const accepted = message.acceptedAt !== null;
    const streamEventType =
      message.state === 'completed' ? 'cloud.message.completed' : 'cloud.message.failed';
    const payload =
      message.state === 'completed'
        ? { messageId: message.messageId, status: 'completed', delivery: 'sent', accepted: true }
        : message.state === 'cancelled'
          ? {
              messageId: message.messageId,
              status: 'interrupted',
              delivery: accepted ? 'sent' : 'queued',
              accepted,
              reason: 'interrupted',
              error: 'The message was interrupted',
            }
          : {
              messageId: message.messageId,
              status: 'failed',
              delivery: accepted ? 'sent' : 'queued',
              accepted,
              ...(message.reason === null
                ? {}
                : { reason: message.reason, error: messageFailureText(message.reason) }),
            };
    const timestamp = message.settledAt ?? Date.now();
    const id = this.eventQueries.insertUnique({
      executionId: '',
      sessionId: this.sessionId,
      streamEventType,
      payload: JSON.stringify(payload),
      timestamp,
      entityId: `terminal-message/${message.messageId}`,
    });
    if (id === null) return false;
    this.broadcast({
      id,
      execution_id: '',
      session_id: this.sessionId,
      stream_event_type: streamEventType,
      payload: JSON.stringify(payload),
      timestamp,
    });
    return true;
  }

  private emitCloudStatus(status: {
    type: 'preparing' | 'ready' | 'finalizing' | 'error';
    step?: string;
    message?: string;
  }): void {
    this.emitSynthetic('cloud.status', { cloudStatus: status });
  }

  private emitSynthetic(
    streamEventType: StoredEvent['stream_event_type'],
    data: unknown,
    timestamp: number = Date.now()
  ): void {
    this.broadcast({
      id: 0 as EventId,
      execution_id: '',
      session_id: this.sessionId,
      stream_event_type: streamEventType,
      payload: JSON.stringify(data),
      timestamp,
    });
  }

  private broadcast(event: StoredEvent): void {
    this.streamHandler().broadcastEvent(event);
  }

  // --- connected-event projections -------------------------------------------

  private deriveCloudStatus(): {
    type: 'preparing' | 'ready' | 'finalizing' | 'error';
    step?: string;
    message?: string;
  } | null {
    switch (this.route.state) {
      case 'unknown':
        return null;
      case 'preparing': {
        const step = publicPreparationStep(this.route.step);
        return { type: 'preparing', ...(step === undefined ? {} : { step }) };
      }
      case 'ready':
      case 'reconnecting':
        return { type: 'ready' };
      case 'failed':
        return { type: 'error', message: this.route.reason };
    }
  }

  private async recordRootStatus(event: { type: string; properties: unknown }): Promise<void> {
    if (event.type !== 'session.status') return;
    const parsed = rootStatusEventSchema.safeParse(event.properties);
    if (!parsed.success || parsed.data.sessionID !== this.registration?.spec.kiloSessionId) return;
    this.rootStatus = { type: parsed.data.status.type, settled: false };
    await this.ctx.storage.put(ROOT_STATUS_KEY, this.rootStatus);
  }

  private async settleRootStatus(): Promise<void> {
    if (this.rootStatus === undefined || this.rootStatus.settled) return;
    this.rootStatus = { ...this.rootStatus, settled: true };
    await this.ctx.storage.put(ROOT_STATUS_KEY, this.rootStatus);
  }

  /**
   * Kilo's stored root status can stay `busy` after a hang or kill ends the turn. A busy or
   * retry status that an accepted message's settlement followed, with no message accepted
   * since, is stale, so a reconnect starts idle. Otherwise Kilo's replayed status stays the
   * source, including native work that runs without a Cloud message.
   */
  private deriveSessionStatus(): SessionStatus | undefined {
    const root = this.rootStatus;
    if (root === undefined || !root.settled) return undefined;
    if (root.type !== 'busy' && root.type !== 'retry') return undefined;
    if (this.messages.some(message => message.state === 'accepted')) return undefined;
    return { type: 'idle' };
  }

  private deriveQueuedMessages(): QueuedMessageSnapshot[] {
    return this.messages
      .filter(
        message =>
          message.state === 'queued' || message.state === 'accepted' || message.state === 'failed'
      )
      .map(message => {
        const timestamp = message.acceptedAt ?? message.createdAt;
        const snapshot: QueuedMessageSnapshot = {
          messageId: message.messageId,
          content: renderTurnContent(message.intent),
          timestamp,
          ...(message.state === 'accepted' ? { delivery: 'sent' as const } : {}),
        };
        if (message.state === 'failed') {
          snapshot.terminalFailure = {
            messageId: message.messageId,
            status: 'failed',
            delivery: message.acceptedAt === null ? 'queued' : 'sent',
            accepted: message.acceptedAt !== null,
            ...(message.reason === null
              ? { error: 'The message failed' }
              : { reason: message.reason, error: messageFailureText(message.reason) }),
            timestamp: message.settledAt ?? timestamp,
          };
        }
        return snapshot;
      });
  }

  private readPendingInteractions(): { questions: unknown[]; permissions: unknown[] } | undefined {
    return this.pendingInteractions === undefined
      ? undefined
      : {
          questions: this.pendingInteractions.questions,
          permissions: this.pendingInteractions.permissions,
        };
  }

  // --- storage ----------------------------------------------------------------

  private async loadMessages(): Promise<SessionMessage[]> {
    const rows = await this.db
      .select()
      .from(controlPlaneMessages)
      .orderBy(asc(controlPlaneMessages.created_at), asc(controlPlaneMessages.message_id));
    return rows.map(rowToMessage);
  }

  /** The route view is the one persisted route state (attempt id included). */
  private async persistRoute(view: ControlPlaneRouteView): Promise<void> {
    const previousAttempt = this.currentAttemptId();
    if (
      previousAttempt !== null &&
      view.state !== 'unknown' &&
      view.attemptId !== previousAttempt
    ) {
      await this.settleMessages(
        this.messages
          .filter(message => message.state === 'accepted')
          .map(message => message.messageId),
        'failed',
        'agent_restarted'
      );
    }
    await this.ctx.storage.put(ROUTE_KEY, view);
    this.route = view;
  }

  private async loadRoute(): Promise<ControlPlaneRouteView> {
    const parsed = controlPlaneRouteViewSchema.safeParse(await this.ctx.storage.get(ROUTE_KEY));
    return parsed.success ? parsed.data : { state: 'unknown' };
  }

  private async persistMessages(messages: readonly SessionMessage[]): Promise<void> {
    for (const message of messages) {
      const row = messageToRow(message);
      await this.db
        .insert(controlPlaneMessages)
        .values(row)
        .onConflictDoUpdate({ target: controlPlaneMessages.message_id, set: row });
    }
  }

  private sessionTimers() {
    return resolveControlPlaneTimers(this.env as unknown as Record<string, string | undefined>)
      .session;
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
