import {
  logRuntimeAuthorizationDiagnostic,
  runtimeAuthorizationRecoveryDenied,
} from '../session/runtime-authorization-diagnostics.js';
import jwt from 'jsonwebtoken';
import { DurableObject } from 'cloudflare:workers';
import { normalizeGitUrl } from '@kilocode/worker-utils';
import type {
  GetWorktreeChangesOutput,
  GetWorktreeFileOutput,
  RefreshWorktreeChangesOutput,
  WorktreeFileQuery,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import { generateBranchSlug } from '@kilocode/worker-utils/deployment-slug';
import { TRPCError } from '@trpc/server';
import { withTimeout } from '@kilocode/worker-utils';
import {
  renewRuntimeAuthorization,
  RuntimeAuthorizationExpiredError,
  RuntimeAuthorizationRevokedError,
  unsealRuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import { RuntimeAuthorizationSchema } from '@kilocode/worker-utils/runtime-authorization-contract';
import {
  getSandboxAllocationInstance,
  getSandboxAllocationResources,
} from '@kilocode/worker-utils/sandbox-allocation';
import { resolveSecret } from '../auth.js';
import {
  issuePersistedRuntimeProxyGrant,
  resolvePersistedRuntimeProxyCredential,
} from '../runtime-credential-proxy-rpc.js';
import {
  runtimeCredentialProxyFacadeBaseUrl,
  runtimeProxyGrantSchema,
  RUNTIME_PROXY_GRANT_KEY,
  sameRuntimeProxyControlBinding,
  verifyRuntimeCredentialProxyHandle,
} from '../runtime-credential-proxy.js';
import { z } from 'zod';
import { diagnosticSyncStatus } from '../shared/control-diagnostics.js';
import {
  cloudAgentWorktreeIdSchema,
  cloudAgentWorktreeLocationSchema,
  type CloudAgentWorktreeId,
  type CloudAgentWorktreeLocation,
  type CloudAgentChildSessionLineage,
} from '@kilocode/session-ingest-contracts';
import {
  sessionRuntimeLocator,
  type SessionRuntimeLocator,
} from '../sandbox-control/worktree-ownership.js';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { buildSandboxBillingInput } from '../container-usage-context.js';
import { isCloudAgentContainerBillingEnabled } from '../container-billing-rollout.js';
import {
  diagnosticCause,
  diagnosticEventType,
  logControlDiagnostic,
  withControlDORetry as withDORetry,
  type ControlDiagnosticFields,
} from '../sandbox-control/diagnostics.js';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../../drizzle/migrations';
import { events, commandQueue, executionLeases } from '../db/sqlite-schema.js';
import type { Env } from '../types.js';
import type { EventId, SessionId } from '../types/ids.js';
import type { CloudStatusData } from '../shared/protocol.js';
import { dispatchedKilocodeModelId } from '../persistence/model-utils.js';
import { nextMetadataAfterAdmittedAgentModel } from '../persistence/persist-admitted-agent-model.js';
import { assertKiloModelAvailable } from '../model-validation.js';
import {
  getSandboxProvider,
  parseSessionMetadata,
  serializeSessionMetadata,
  type SessionMetadata,
} from '../persistence/session-metadata.js';
import type { OperationResult } from '../persistence/types.js';
import type { CallbackTarget } from '../callbacks/index.js';
import {
  renderExecutionTurnContent,
  type AcceptedExecutionTurn,
  type ExecutionTurnSubmission,
  type LegacyRegisteredInitialAdmissionRequest,
  type SessionMessageAdmissionResult,
  type SubmittedSessionMessageRequest,
} from '../execution/types.js';
import type { MessageResultRPCResponse } from '../session/message-result.js';
import type { LatestAssistantMessage } from '../session/types.js';
import { createEventQueries, type EventQueries } from '../session/queries/index.js';
import { createStreamHandler } from '../websocket/stream.js';
import type { StoredEvent } from '../websocket/types.js';
import {
  applyPendingInteractionEvent,
  pendingInteractionsSchema,
  persistSandboxControlSessionEvent,
  type PendingInteractions,
} from './sandbox-control-event.js';
import { buildSignedPromptAttachments } from '../execution/attachment-prompt-parts.js';
import { getSessionWorkspacePath, getWorktreeWorkspacePath } from '../workspace.js';
import {
  childSessionLineage,
  controlEventToIngestItems,
  ingestKiloSessionId,
  publishControlPlaneSessionIngest,
} from './control-plane-ingest.js';
import { applyControlPlanePreparingEvent } from './control-plane-preparing.js';
import { logger } from '../logger.js';
import { sandboxControlRpc } from './control-rpc.js';
import { decideStopped, settleStopped } from './stopped-seam.js';
import type { NotifyEffectResult } from '../sandbox-control/control-effects.js';
import type { StopProof } from '../sandbox-state/model/allocation.js';
import { getSandboxControlStub } from '../sandbox-control/stub.js';
import { DEADLINE_MS } from '../sandbox-control/deadlines.js';
import { POLICY } from '../sandbox-state/schedule.js';
import { createMessageId } from '../session/message-id.js';
import {
  getRuntimeAuthorizationStatus,
  getRuntimeAuthorizationRecoveryState,
  hasModernRuntimeAuthorization,
  renewStoredRuntimeAuthorization,
  RUNTIME_AUTHORIZATION_RECOVERY_KEY,
  RUNTIME_AUTHORIZATION_KEY,
  runtimeAuthorizationRecoveryLockSchema,
} from '../session/runtime-authorization-persistence.js';
import { validateControlSessionOptions } from './attach-payload.js';
import { pendingInputProjection } from './session-input-projection.js';
import {
  createInteractionRefresh,
  type InteractionRefresh,
  type InteractionRefreshScope,
} from './session-interaction-refresh.js';
import {
  createWorktreeChanges,
  worktreeChangesContext,
  type WorktreeChangesContext,
} from './worktree-changes.js';
import {
  WORKTREE_CHANGED_EVENT,
  WORKTREE_CHANGES_READY_EVENT,
} from '../shared/worktree-changes-wire.js';
import {
  createPreparationProgressRecorder,
  type PreparationProgressRecorder,
} from '../session/preparation-progress.js';
import {
  finalizeOtherRunningAttemptsForMessage,
  finalizePreparationAttempt,
  getPreparationSnapshots,
  readPreparationAttempt,
} from '../session/preparation-history.js';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  SANDBOX_CONTROL_OPERATION_LIMIT,
  SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS,
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  controlErrorCodes,
  sessionAttachResultSchema,
  sessionMessageOutcomeSchema,
  sessionOperationAuthorizationSchema,
  sessionOperationDeliverySchema,
  sessionOperationExpiresAt,
  sessionOperationResultHash,
  sessionAbortResultSchema,
  sessionPromptResultSchema,
  sessionRuntimeRetireResultSchema,
  sessionSyncResultSchema,
  sessionPermissionResolveResultSchema,
  sessionQuestionResolveResultSchema,
  sameSessionOperation,
  isSandboxAcquisitionLostError,
  isSandboxAcquisitionSupersededError,
  wrapperInstanceIdSchema,
  type SessionAttachPayload,
  type SessionOperationAck,
  type SessionOperationAuthorization,
  type SessionRequestIdentity,
  type SessionSyncResult,
  type SandboxEventBatchItemOutcome,
  type SandboxEventBatchResult,
  type SandboxEventPublicationPayload,
  type SessionEventIdentity,
  type SessionPreparingPayload,
} from '../shared/sandbox-control-protocol.js';
import type { WrapperPty } from '../kilo/wrapper-client.js';
import {
  restoreIncompleteLogFields,
  type WrapperRestoreTelemetry,
} from '../shared/wrapper-bootstrap.js';
import {
  SandboxStatusSnapshotSchema,
  getSandboxProviderLabel,
  type SandboxStatusSnapshot,
} from '../shared/sandbox-status.js';
import {
  ControlRequestError,
  controlDispatchDisposition,
  controlRequestResult,
  deliveryErrorLogFields,
  isRecoverableRuntimeInvalidation,
  isRetryableDeliveryError,
  isUnconfirmedReachabilityFailure,
  observeControlAfterStopping,
  safeErrorFromQueueReason,
  SESSION_DELIVERY_TIMEOUT_MS,
  withDeliveryDeadline,
} from './control-dispatch.js';
import {
  AcceptedRuntimeLostError,
  acceptedAlarmDecision,
  acceptedInactivityDue,
} from './accepted-overdue.js';
import { acceptedSnapshotKind, isRealTurnActivity } from './turn-activity.js';
import { bootPreparingStep, provisionPreparingStep } from './preparing-steps.js';
import type { PhysicalState } from '../shared/sandbox-status.js';
import { createSandboxTerminalBridge, type SandboxTerminalRecord } from './terminal-bridge.js';
import {
  createSandboxTerminalLifecycle,
  SANDBOX_SESSION_METADATA_KEY,
  SANDBOX_SESSION_DELETED_WORKTREE_KEY,
} from './terminal-lifecycle.js';
import {
  acceptQueuedMessage,
  acceptedAtOf,
  activeWrapperInstanceId,
  applyMessageOutcome,
  assistantReasonOf,
  assignPreparationAttemptId,
  cancelPendingMessage,
  createSessionMessageRecord,
  deliveryPreparationAttemptId,
  deliveryWrapperInstanceId,
  failAcceptedMessage,
  failedDetailOf,
  failedReasonOf,
  failQueuedMessage,
  failWaitingMessages as applyFailWaitingMessages,
  failedMessageSnapshot,
  freezeLegacyQueuedMessages,
  getSessionMessageTurn,
  hasAcceptedMessage,
  hasUnreleasedOperationProof,
  incrementDeliveryFailure,
  markSessionOperationRejection,
  matchesSessionMessageReplay,
  nextQueuedMessageId,
  noOutputRecoveryAllowed,
  providerOwnershipOf,
  queuedAtOf,
  recordAcceptedMessageActivity,
  redispatchAcceptedMessage,
  releaseCompletedRetryableAttach,
  releaseUnadmittedWaitingMessages,
  replacePreparationAttemptId,
  rotateLostPreparationAttempt,
  resolveSessionMessageIntent,
  retireAttachProof,
  RUNTIME_REPLACEMENT_WAIT_LIMIT,
  streamCloudStatus,
  streamQueuedSnapshots,
  terminalAtOf,
  terminalSourceOf,
  terminalizeWaitingMessage,
  type ControlSessionMessageInput,
  type SessionAggregate,
  type SessionMessage,
} from './session-message-queue.js';
import { bindingForAttachment } from './session-binding.js';
import { decideSession, terminalMessageState } from '../sandbox-state/session/reduce.js';
import type { Binding } from '../sandbox-state/model/session.js';
import { createMessageCallbacks, type MessageCallbacks } from './message-callbacks.js';
import {
  applyStoredAssistantSettlement,
  projectStoredAssistantSettlement,
  type AcceptedStoredSettlement,
} from './accepted-stored-settlement.js';
import {
  createReportOutbox,
  readReportAnchor,
  writeReportAnchor,
  type ReportAnchor,
  type ReportOutbox,
} from './report-outbox.js';
import {
  CloudAgentQueueReportSchema,
  DIAGNOSTIC_RETENTION_MS,
  type CloudAgentQueueReport,
  type CloudAgentRunStateReport,
} from '@kilocode/worker-utils/cloud-agent-queue-report';
import { buildRunStateReport, FAILED_RUN_DIAGNOSTIC_MESSAGES } from '../telemetry/queue-reports.js';
import { classifyControlPlaneRunFailure } from '../telemetry/control-plane-failure.js';
import { PENDING_SESSION_MESSAGE_LIMIT } from '../session/pending-messages.js';
import {
  commitSessionOperationResult,
  dispatchSessionOperation,
  operationDispatchError,
} from './session-operation.js';
import {
  controlEventReceiptDisposition,
  recordControlEventReceipt,
  bindControlEventReceiptIdentity,
  type ControlEventReceiptDisposition,
} from './control-event-receipts.js';
import {
  readActiveSessionMessages,
  readRawSessionMessages,
} from '../sandbox-state/persist/load.js';
import { writeSessionMessages } from '../sandbox-state/persist/access.js';

const METADATA_KEY = SANDBOX_SESSION_METADATA_KEY;
const DELETED_WORKTREE_KEY = SANDBOX_SESSION_DELETED_WORKTREE_KEY;
const DELETION_COMPLETED_KEY = 'deletion_completed';

type SandboxControlEventInput = {
  identity: SessionEventIdentity;
  payload: { type: string; properties: Record<string, unknown>; timestamp?: string };
  receiptId?: string;
  receiptHash?: string;
  sequence?: number;
};
const QUEUE_RETRY_MS = 5_000;
const PENDING_INTERACTIONS_KEY = 'session_pending_interactions';
const NATIVE_RUNTIME_FENCE_KEY = 'native_runtime_fence';
const nativeRuntimeFenceSchema = z.object({
  sandboxId: z.string().min(1),
  wrapperInstanceId: wrapperInstanceIdSchema,
  nativeRuntimeId: z.string().uuid(),
  attachmentEpoch: z.number().int().positive(),
  authorization: sessionOperationAuthorizationSchema,
});

type MessageRecord = SessionMessage;
type DispatchPhase = 'preparing' | 'attach' | 'prompt';

/**
 * The accepted-operation lookup outcome. `missing` is an explicit wrapper report
 * that it has no record of the operation; it is distinct from `uncertain`
 * (transport or unverified lookup), which cannot justify stopping Kilo work.
 */
type AcceptedOperationObservation =
  | 'running'
  | 'completed'
  | 'rejected'
  | 'uncertain'
  | 'missing'
  | undefined;

/**
 * Thrown inside a stop-commit transaction when the envelope write is rejected
 * after the attachment/fence was cleared. Throwing (rather than returning) makes
 * the outer `transactionSync` roll the clear and any hydration back.
 */
class StopCommitRejectedError extends Error {
  constructor() {
    super('stop_commit_rejected');
  }
}

const MAX_TERMINAL_DETAIL_LENGTH = 4_096;

/**
 * Name a partial snapshot restore on a runtime replacement. The attach result
 * carries the wrapper's restore telemetry; without this the skipped diffs would
 * only exist in the wrapper log the worker never reads.
 */
function logRestoreIncomplete(input: {
  sessionId: string | undefined;
  kiloSessionId?: string;
  messageId: string;
  wrapperInstanceId?: string;
  restore: WrapperRestoreTelemetry | undefined;
}): void {
  const restoreFields = restoreIncompleteLogFields(input.restore);
  if (!restoreFields) return;
  logger
    .withFields({
      sessionId: input.sessionId,
      kiloSessionId: input.kiloSessionId,
      messageId: input.messageId,
    })
    .warn('Cloud agent restore incomplete', {
      metric: 'cloud_agent_restore_incomplete',
      count: 1,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.wrapperInstanceId ? { wrapperInstanceId: input.wrapperInstanceId } : {}),
      ...restoreFields,
    });
}

function confirmedControlRejectionDetail(error: unknown): string | undefined {
  if (!(error instanceof ControlRequestError) || !error.rejectionReceived) return undefined;
  const detail = error.message.trim().slice(0, MAX_TERMINAL_DETAIL_LENGTH);
  return detail || undefined;
}

/**
 * Wait reason for a head that is not yet deliverable. Keep it stable per
 * physical phase so the recorder can suppress a duplicate emission across 5 s
 * alarms and clients see the reason change only when the phase does.
 */
function environmentWaitMessage(physical: PhysicalState): string {
  if (physical === 'stopping') {
    return 'Waiting for the sandbox to become healthy (environment is stopping)';
  }
  if (physical === 'stopped' || physical === 'failed') {
    return 'Waiting for the sandbox to become available…';
  }
  return 'Waiting for the sandbox to become healthy…';
}

type ControlEventDisposition =
  | 'apply'
  | 'duplicate'
  | 'receipt_conflict'
  | 'epoch_changed'
  | 'runtime_mismatch'
  | 'native_runtime_pending'
  | 'native_runtime_mismatch';
type ControlEventInput = {
  identity: SessionEventIdentity;
  wrapperInstanceId?: string;
  receiptId?: string;
  receiptHash?: string;
  sequence?: number;
};
type ControlEventEvaluationRequest =
  | {
      contract: 'publication_admission';
      input: ControlEventInput;
      epoch: number;
      publication:
        | { kind: 'event' }
        | { kind: 'preparing'; loadTrigger: () => SessionMessage | undefined };
    }
  | { contract: 'currency_recheck'; input: ControlEventInput; epoch: number };

type SandboxSessionRegistrationInput = {
  identity: SessionMetadata['identity'];
  auth: SessionMetadata['auth'];
  runtimeAuthorizationSeal?: string;
  agent: SessionMetadata['agent'];
  repository?: SessionMetadata['repository'];
  workspace?: SessionMetadata['workspace'];
  callback?: SessionMetadata['callback'];
  profile?: SessionMetadata['profile'];
  finalization?: SessionMetadata['finalization'];
  message?: { initialMessageId?: string; turn: ExecutionTurnSubmission };
};

type SandboxSessionInitialAdmissionInput = Omit<SandboxSessionRegistrationInput, 'message'> & {
  message: { initialTurn: AcceptedExecutionTurn };
};

export class SandboxSession extends DurableObject<Env> {
  private readonly sessionId: SessionId | undefined;
  private readonly eventQueries: EventQueries;
  private readonly messageCallbacks: MessageCallbacks;
  private readonly reportOutbox: ReportOutbox;
  private readonly terminalLifecycle: ReturnType<typeof createSandboxTerminalLifecycle>;
  private readonly terminalBridge: ReturnType<typeof createSandboxTerminalBridge>;
  private readonly dispatches = new Map<string, Promise<void>>();
  private ingestPublicationChain: Promise<void> = Promise.resolve();
  private deletedWorktreeId: CloudAgentWorktreeId | undefined;
  private readonly activeOperations = new Set<Promise<unknown>>();
  private deletionCompletion: Promise<void> | undefined;
  private readonly worktreeChanges: ReturnType<typeof createWorktreeChanges>;
  private readonly interactionRefresh: InteractionRefresh;
  private callbackRepairRequired = false;
  private reportRepairRequired = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const doName = ctx.id.name;
    const lastColon = doName?.lastIndexOf(':') ?? -1;
    const sessionIdPart = doName && lastColon > 0 ? doName.slice(lastColon + 1) : undefined;
    this.terminalLifecycle = createSandboxTerminalLifecycle({
      state: ctx,
      getSessionId: () => this.requireSessionId(),
      getControl: sandboxId => sandboxControlRpc(env, sandboxId),
      getDirectory: metadata => this.directory(metadata),
      closeTerminalBridge: (ptyId, code, reason) =>
        this.terminalBridge.closeTerminal(ptyId, code, reason),
      closeAllBridges: (code, reason) => this.terminalBridge.closeAll(code, reason),
      closeRuntimeBridges: (wrapperInstanceId, code, reason) =>
        this.terminalBridge.closeRuntime(wrapperInstanceId, code, reason),
    });
    const storedSessionId =
      sessionIdPart ?? this.terminalLifecycle.getStoredMetadata()?.identity.sessionId;
    this.sessionId = storedSessionId ? (storedSessionId as SessionId) : undefined;
    this.terminalBridge = createSandboxTerminalBridge({
      state: ctx,
      getMetadata: () => this.getMetadata(),
      getTerminal: async (ptyId): Promise<SandboxTerminalRecord | undefined> =>
        this.terminalLifecycle.getTerminal(ptyId),
      requestConnect: async (record, payload) =>
        this.terminalLifecycle.requestConnect(record, payload),
      reportActivity: async record => this.terminalLifecycle.reportActivity(record),
      markEnded: async record => this.terminalLifecycle.markEnded(record),
    });
    const db = drizzle(ctx.storage, { logger: false });
    this.eventQueries = createEventQueries(db, ctx.storage.sql);
    this.messageCallbacks = createMessageCallbacks({
      storage: ctx.storage,
      getMetadata: () => this.terminalLifecycle.getStoredMetadata(),
      getCallbackQueue: () => env.CALLBACK_QUEUE,
      getAssistantMessageForUserMessage: (sessionId, kiloSessionId, parentMessageId) =>
        this.eventQueries.getAssistantMessageForUserMessage(
          sessionId,
          kiloSessionId,
          parentMessageId
        ),
    });
    this.reportOutbox = createReportOutbox({
      storage: ctx.storage,
      getQueue: () => env.CLOUD_AGENT_REPORT_QUEUE,
    });
    this.worktreeChanges = createWorktreeChanges({
      storage: ctx.storage,
      saveSnapshotEvent: snapshot => {
        if (this.deletedWorktreeId || this.terminalLifecycle.isBlocked()) {
          throw new Error('Worktree changes persistence is blocked');
        }
        const sessionId = this.requireSessionId();
        const payload = JSON.stringify({ revision: snapshot.revision });
        const timestamp = Date.now();
        const id = this.eventQueries.insertUnique({
          executionId: '',
          sessionId,
          streamEventType: WORKTREE_CHANGES_READY_EVENT,
          payload,
          timestamp,
          entityId: `worktree-changes/${snapshot.revision}`,
        });
        if (id === null) return;
        return () => {
          try {
            this.broadcastStoredEvent({
              id,
              execution_id: '',
              session_id: sessionId,
              stream_event_type: WORKTREE_CHANGES_READY_EVENT,
              payload,
              timestamp,
            });
          } catch {
            logger
              .withFields({ sessionId, eventId: id, revision: snapshot.revision })
              .error('Failed to broadcast saved worktree changes');
          }
        };
      },
      readContext: async () => this.worktreeContext(await this.getMetadata()),
      requestCapture: (context, payload, operation) =>
        withDORetry(
          () => getSandboxControlStub(this.env, context.sandboxId),
          control =>
            control.request({
              operation,
              session: context.session,
              payload,
            }),
          'captureWorktreeChanges'
        ),
      waitUntil: promise => this.ctx.waitUntil(promise),
    });
    this.interactionRefresh = createInteractionRefresh({
      captureScope: () => this.captureInteractionScope(),
      sync: (scope, trigger) => this.syncAcceptedMessage(scope, trigger),
      onBackgroundError: () => {
        logger
          .withFields({ sessionId: this.sessionId })
          .warn('Pending interaction sync unavailable');
      },
    });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(db, migrations);
      this.deletedWorktreeId = cloudAgentWorktreeIdSchema
        .optional()
        .parse(ctx.storage.kv.get(DELETED_WORKTREE_KEY));
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (this.deletedWorktreeId) return new Response('Session deleted', { status: 410 });
    const pathname = new URL(request.url).pathname;
    if (pathname === '/terminal/browser') {
      return this.terminalBridge.handleBrowserUpgrade(request);
    }
    if (pathname === '/terminal/wrapper') {
      return this.terminalBridge.handleWrapperUpgrade(request);
    }
    if (pathname !== '/stream' || this.terminalLifecycle.isBlocked()) {
      return new Response('Not found', { status: 404 });
    }
    const sessionId = this.requireSessionId();
    const handler = createStreamHandler(this.ctx, this.eventQueries, sessionId, {
      deriveCloudStatus: () => this.deriveCloudStatus(),
      deriveQueuedMessages: () => this.deriveQueuedMessages(),
      readPendingInteractions: () => this.derivePendingInteractions(),
      deriveSessionStatus: async () =>
        hasAcceptedMessage(this.loadMessages())
          ? { type: 'busy' as const }
          : { type: 'idle' as const },
      getPreparationSnapshots: async () => getPreparationSnapshots(this.eventQueries),
      reconcileMaterializedEvents: true,
    });
    return handler.handleStreamRequest(request);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.terminalBridge.handleMessage(ws, message);
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    await this.terminalBridge.handleClose(ws, code, reason, wasClean);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await this.terminalBridge.handleError(ws, error);
  }

  receiveSandboxControlEvent(
    input: SandboxControlEventInput & { wrapperInstanceId?: string }
  ): Promise<{ applied: boolean; retryable?: boolean }> {
    return this.trackOperation(this.applySandboxControlEvent(input));
  }

  private async applySandboxControlEvent(
    input: SandboxControlEventInput & { wrapperInstanceId?: string }
  ): Promise<{ applied: boolean; retryable?: boolean }> {
    const startedAt = Date.now();
    const diagnosticSnapshot = this.controlEventDiagnosticSnapshot(input);
    const metadata = await this.getMetadata();
    const epoch = this.terminalLifecycle.captureEpoch();
    const result = (
      applied: boolean,
      disposition: string,
      fields: ControlDiagnosticFields = {}
    ) => {
      logControlDiagnostic(
        'session_event_result',
        {
          sessionId: this.sessionId,
          sandboxId: metadata?.workspace?.sandboxId,
          wrapperInstanceId: input.wrapperInstanceId,
          receiptId: input.receiptId,
          eventType: diagnosticEventType(input.payload.type),
          applied,
          disposition,
          durationMs: Date.now() - startedAt,
          ...diagnosticSnapshot,
          ...fields,
        },
        'info',
        {
          ...(applied || input.receiptId === undefined
            ? {}
            : { coalesceIdentity: `session.event:${this.sessionId}:${input.receiptId}` }),
        }
      );
      return { applied };
    };
    if (!metadata || epoch === null) return result(false, 'session_unavailable');
    const root = metadata.auth.kiloSessionId;
    if (input.identity.directory !== this.directory(metadata))
      return result(false, 'directory_mismatch');
    const payloadKiloSessionId = ingestKiloSessionId(input.payload.type, input.payload.properties);
    const identityKiloSessionId = input.identity.kiloSessionId;
    const eventKiloSessionId = identityKiloSessionId ?? payloadKiloSessionId;
    if (
      (input.identity.rootKiloSessionId !== undefined &&
        root !== undefined &&
        input.identity.rootKiloSessionId !== root) ||
      (identityKiloSessionId !== undefined &&
        payloadKiloSessionId !== undefined &&
        identityKiloSessionId !== payloadKiloSessionId) ||
      (metadata.workspace?.worktreeId !== undefined &&
        root !== undefined &&
        input.identity.rootKiloSessionId !== root &&
        identityKiloSessionId !== root &&
        payloadKiloSessionId !== root)
    ) {
      return result(false, 'root_mismatch');
    }
    if (input.payload.type === 'session.created' || input.payload.type === 'session.updated') {
      const info = input.payload.properties.info;
      if (typeof info === 'object' && info !== null) {
        if ('id' in info && info.id !== eventKiloSessionId)
          return result(false, 'session_id_mismatch');
        if (eventKiloSessionId !== root && ('parentID' in info || 'directory' in info)) {
          const directory = this.directory(metadata);
          const child = childSessionLineage(info, directory);
          if (
            !child ||
            child.sessionId !== eventKiloSessionId ||
            input.identity.directory !== directory
          )
            return result(false, 'child_lineage_mismatch');
        }
      }
    }
    if (
      eventKiloSessionId !== undefined &&
      eventKiloSessionId !== root &&
      (root === undefined || input.identity.rootKiloSessionId !== root)
    )
      return result(false, 'root_mismatch');
    const hasReceiptIdentity =
      input.receiptId !== undefined ||
      input.receiptHash !== undefined ||
      input.sequence !== undefined;
    const admission = this.evaluateControlEvent({
      contract: 'publication_admission',
      input,
      epoch,
      publication: { kind: 'event' },
    });
    if (admission === 'native_runtime_pending')
      return { ...result(false, admission), retryable: true };
    if (admission !== 'apply') return result(admission === 'duplicate', admission);
    const sessionId = this.requireSessionId();
    if (input.payload.type === 'session.message.outcome') {
      const outcome = sessionMessageOutcomeSchema.safeParse(input.payload.properties);
      if (!outcome.success) return result(false, 'invalid_outcome');
      if (!input.wrapperInstanceId) return result(false, 'missing_wrapper_identity');
      if (eventKiloSessionId !== undefined && root !== undefined && eventKiloSessionId !== root) {
        return result(false, 'root_mismatch');
      }
      const messages = this.loadMessages();
      const existing = messages.find(message => message.messageId === outcome.data.messageId);
      const diagnostic = {
        messageId: existing?.messageId,
        fromState: existing?.state.kind,
        outcome: outcome.data.status,
      };
      const proof = existing?.proofs?.prompt ?? existing?.proofs?.attach;
      if (proof?.dispatched)
        return result(
          false,
          proof.resultHash === undefined ? 'operation_result_pending' : 'operation_result_required',
          diagnostic
        );
      if (
        existing !== undefined &&
        deliveryWrapperInstanceId(existing) === input.wrapperInstanceId &&
        existing.state.kind === outcome.data.status
      ) {
        // HEAD's duplicate-outcome acknowledgement requires the stored wrapper
        // identity to match. Ordinary terminalization retains it; allocation loss
        // clears it, so a replayed outcome for a stopped turn is not acknowledged.
        const receipt = hasReceiptIdentity
          ? this.commitControlEventReceipt(input, epoch)
          : this.terminalLifecycle.isCurrent(epoch)
            ? ('apply' as const)
            : ('epoch_changed' as const);
        return result(
          receipt === 'apply' || receipt === 'duplicate',
          receipt === 'apply' || receipt === 'duplicate' ? 'duplicate' : receipt,
          diagnostic
        );
      }
      if (hasReceiptIdentity) {
        const currency = this.evaluateControlEvent({ contract: 'currency_recheck', input, epoch });
        if (currency !== 'apply') return result(false, currency, diagnostic);
      }
      const settled = applyMessageOutcome(
        this.sessionAggregate(messages),
        outcome.data,
        input.wrapperInstanceId,
        Date.now()
      );
      if (!settled) {
        return result(
          false,
          !existing
            ? 'message_missing'
            : existing.state.kind !== 'queued' && existing.state.kind !== 'accepted'
              ? 'already_terminal'
              : activeWrapperInstanceId(existing) !== input.wrapperInstanceId
                ? 'runtime_mismatch'
                : 'not_queue_head',
          diagnostic
        );
      }
      const receipt = hasReceiptIdentity
        ? this.saveMessages(
            settled.messages,
            epoch,
            'wrapper_outcome',
            undefined,
            () => this.recordControlEventReceipt(input),
            () => {
              const currency = this.evaluateControlEvent({
                contract: 'currency_recheck',
                input,
                epoch,
              });
              if (currency !== 'apply') return currency;
              const current = this.controlEventReceipt(input);
              return current === 'apply'
                ? ('apply' as const)
                : current === 'duplicate'
                  ? ('duplicate' as const)
                  : ('receipt_conflict' as const);
            }
          )
        : this.saveMessages(settled.messages, epoch, 'wrapper_outcome')
          ? ('apply' as const)
          : ('epoch_changed' as const);
      if (receipt !== 'apply')
        return result(
          receipt === 'duplicate',
          receipt === 'duplicate' ? 'duplicate' : receipt,
          diagnostic
        );
      if (this.isCurrentEventRuntime(input.wrapperInstanceId)) {
        this.worktreeChanges.onEvent(
          this.worktreeContext(metadata),
          root,
          input.payload.type,
          outcome.data
        );
      }
      await this.armQueueRetry();
      const nextId = nextQueuedMessageId(this.loadMessages());
      if (nextId && this.terminalLifecycle.isCurrent(epoch)) {
        this.ctx.waitUntil(this.dispatchQueued(nextId));
      }
      return result(true, 'outcome_applied', diagnostic);
    }
    const currency = this.evaluateControlEvent({ contract: 'currency_recheck', input, epoch });
    if (currency !== 'apply') return result(false, currency);
    if (input.payload.type === WORKTREE_CHANGED_EVENT) {
      if (!root || eventKiloSessionId !== root) return result(false, 'root_mismatch');
      if (!input.wrapperInstanceId) return result(false, 'missing_wrapper_identity');
      const receipt = hasReceiptIdentity
        ? this.commitControlEventReceipt(input, epoch)
        : this.terminalLifecycle.isCurrent(epoch)
          ? ('apply' as const)
          : ('epoch_changed' as const);
      if (receipt === 'duplicate') return result(true, 'duplicate');
      if (receipt !== 'apply') return result(false, receipt);
      this.worktreeChanges.onEvent(
        this.worktreeContext(metadata),
        eventKiloSessionId,
        input.payload.type,
        input.payload.properties
      );
      return result(true, 'applied');
    }
    if (
      (input.payload.type === 'question.asked' || input.payload.type === 'permission.asked') &&
      !this.loadMessages().some(
        message => message.state.kind === 'accepted' || message.state.kind === 'queued'
      )
    ) {
      if (!hasReceiptIdentity) return result(false, 'no_pending_work');
      const receipt = this.commitControlEventReceipt(input, epoch);
      return result(
        receipt === 'apply' || receipt === 'duplicate',
        receipt === 'apply' || receipt === 'duplicate' ? 'no_pending_work' : receipt
      );
    }
    const notifications: StoredEvent[] = [];
    const receipt = this.ctx.storage.transactionSync((): ControlEventDisposition => {
      const current = this.evaluateControlEvent(
        hasReceiptIdentity
          ? { contract: 'publication_admission', input, epoch, publication: { kind: 'event' } }
          : { contract: 'currency_recheck', input, epoch }
      );
      if (current !== 'apply') return current;
      this.recordPendingInteraction(input.payload);
      persistSandboxControlSessionEvent({
        sessionId,
        payload: input.payload,
        eventQueries: this.eventQueries,
        broadcast: event => notifications.push(event),
      });
      if (isRealTurnActivity(input.payload.type, input.payload.properties)) {
        const activeMessages = recordAcceptedMessageActivity(this.loadMessages(), Date.now());
        if (activeMessages && this.terminalLifecycle.isCurrent(epoch))
          writeSessionMessages(
            this.ctx.storage.kv,
            this.sessionBinding(activeMessages),
            activeMessages
          );
      }
      this.recordControlEventReceipt(input);
      return 'apply' as const;
    });
    if (receipt === 'duplicate') return result(true, 'duplicate');
    if (receipt !== 'apply') return result(false, receipt);
    for (const notification of notifications) this.broadcastStoredEvent(notification);
    this.worktreeChanges.onEvent(
      this.worktreeContext(metadata),
      eventKiloSessionId,
      input.payload.type,
      input.payload.properties
    );
    const ingestItems = controlEventToIngestItems(input.payload.type, input.payload.properties);
    const rootKiloSessionId = metadata.auth.kiloSessionId;
    const token = metadata.auth.kilocodeToken;
    if (ingestItems.length > 0 && rootKiloSessionId && token && this.env.SESSION_INGEST) {
      const isChild = eventKiloSessionId !== undefined && eventKiloSessionId !== rootKiloSessionId;
      let internalSecret: string | undefined;
      if (isChild) {
        try {
          internalSecret = await this.env.INTERNAL_API_SECRET_PROD.get();
        } catch {
          internalSecret = undefined;
        }
        if (!this.terminalLifecycle.isCurrent(epoch)) return result(false, 'epoch_changed');
        if (!internalSecret) {
          logger
            .withFields({
              sessionId: this.sessionId,
              rootKiloSessionId,
              eventKiloSessionId,
            })
            .warn('Control-plane child session ingest skipped; internal secret unavailable');
        }
      }
      if (this.deletedWorktreeId || !this.terminalLifecycle.isCurrent(epoch)) {
        return { applied: false };
      }
      if (!isChild || internalSecret) {
        const publication = this.ingestPublicationChain
          .catch(() => undefined)
          .then(async () => {
            if (!this.terminalLifecycle.isCurrent(epoch)) return;
            const storedAuthorization = this.ctx.storage.kv.get<unknown>(RUNTIME_AUTHORIZATION_KEY);
            const decoded = jwt.decode(token);
            // Classification only: the bridge cryptographically verifies every
            // modern claim before granting any attestation.
            const modern =
              storedAuthorization !== undefined ||
              (typeof decoded === 'object' &&
                decoded !== null &&
                'runtimeAuthorization' in decoded);
            const currentToken = modern ? await this.getRuntimeToken() : token;
            const secret = modern ? await resolveSecret(this.env.NEXTAUTH_SECRET) : undefined;
            const currentMetadata = await this.getMetadata();
            if (
              !currentToken ||
              (modern && !secret) ||
              !currentMetadata ||
              currentMetadata.auth.kiloSessionId !== rootKiloSessionId
            )
              return;
            const authorization = this.ctx.storage.kv.get<unknown>(RUNTIME_AUTHORIZATION_KEY);
            return publishControlPlaneSessionIngest({
              fetchIngest: request => this.env.SESSION_INGEST.fetch(request),
              token: currentToken,
              runtimeContext:
                modern && secret
                  ? {
                      secret,
                      userId: currentMetadata.identity.userId,
                      organizationId: currentMetadata.identity.orgId,
                      authorization,
                      isCurrent: () =>
                        this.terminalLifecycle.isCurrent(epoch) &&
                        !this.deletedWorktreeId &&
                        !this.ctx.storage.kv.get(RUNTIME_AUTHORIZATION_RECOVERY_KEY) &&
                        JSON.stringify(this.ctx.storage.kv.get(RUNTIME_AUTHORIZATION_KEY)) ===
                          JSON.stringify(authorization),
                    }
                  : undefined,
              rootKiloSessionId,
              eventKiloSessionId,
              cloudAgentSessionId: metadata.identity.sessionId,
              directory: this.directory(metadata),
              ...(internalSecret ? { internalSecret } : {}),
              items: ingestItems,
            });
          });
        const settledPublication = publication.catch(() => {
          logger
            .withFields({ sessionId: this.sessionId })
            .warn('Control-plane session ingest authorization unavailable');
        });
        this.ingestPublicationChain = settledPublication;
        this.ctx.waitUntil(settledPublication);
      }
    }
    const applied = this.terminalLifecycle.isCurrent(epoch);
    return result(applied, applied ? 'applied' : 'epoch_changed');
  }

  receiveSandboxControlEventBatch(input: {
    items: SandboxEventPublicationPayload[];
    wrapperInstanceId?: string;
  }): Promise<SandboxEventBatchResult> {
    return this.trackOperation(this.applySandboxControlEventBatch(input));
  }

  private async applySandboxControlEventBatch(input: {
    items: SandboxEventPublicationPayload[];
    wrapperInstanceId?: string;
  }): Promise<SandboxEventBatchResult> {
    const outcomes: SandboxEventBatchItemOutcome[] = [];
    const startedAt = Date.now();
    for (const [index, item] of input.items.entries()) {
      try {
        let applied = false;
        let retryable: boolean | undefined;
        if (item.event === 'session.event') {
          const result = await this.applySandboxControlEvent({
            identity: item.session,
            payload: item.payload,
            receiptId: item.receiptId,
            sequence: item.sequence,
            wrapperInstanceId: input.wrapperInstanceId,
          });
          applied = result.applied;
          retryable = result.retryable;
        } else {
          applied = (
            await this.receiveSandboxControlPreparing({
              identity: item.session,
              payload: item.payload,
              wrapperInstanceId: input.wrapperInstanceId,
              receiptId: item.receiptId,
              sequence: item.sequence,
            })
          ).applied;
        }
        outcomes.push(
          applied
            ? { receiptId: item.receiptId, status: 'applied' }
            : {
                receiptId: item.receiptId,
                status: 'rejected',
                ...(retryable === true ? { retryable: true } : {}),
              }
        );
      } catch {
        outcomes.push({ receiptId: item.receiptId, status: 'unknown' });
        try {
          logControlDiagnostic(
            'session_event_batch_item_failed',
            {
              sessionId: this.sessionId,
              wrapperInstanceId: input.wrapperInstanceId,
              receiptId: item.receiptId,
              sequence: item.sequence,
              eventFamily: item.event,
              eventType:
                item.event === 'session.event'
                  ? diagnosticEventType(item.payload.type)
                  : 'session.preparing',
              eventIndex: index,
              batchSize: input.items.length,
              disposition: 'application_exception',
            },
            'warn'
          );
        } catch {
          // Containment only: a diagnostic must never replace or alter the batch result.
        }
      }
    }
    logControlDiagnostic('session_event_batch_applied', {
      sessionId: this.sessionId,
      wrapperInstanceId: input.wrapperInstanceId,
      batchSize: input.items.length,
      applyMs: Date.now() - startedAt,
      appliedCount: outcomes.filter(outcome => outcome.status === 'applied').length,
      rejectedCount: outcomes.filter(outcome => outcome.status === 'rejected').length,
    });
    return { outcomes };
  }

  async receiveSandboxControlPreparing(input: {
    identity: SessionEventIdentity;
    payload: SessionPreparingPayload;
    wrapperInstanceId?: string;
    receiptId?: string;
    receiptHash?: string;
    sequence?: number;
  }): Promise<{ applied: boolean }> {
    const diagnosticSnapshot = this.controlEventDiagnosticSnapshot(input);
    const metadata = await this.getMetadata();
    const epoch = this.terminalLifecycle.captureEpoch();
    const result = (applied: boolean, disposition: string) => {
      logControlDiagnostic(
        'session_preparing_result',
        {
          sessionId: this.sessionId,
          sandboxId: metadata?.workspace?.sandboxId,
          wrapperInstanceId: input.wrapperInstanceId,
          receiptId: input.receiptId,
          attemptId: input.payload.attemptId,
          action: input.payload.action,
          revision: input.payload.revision,
          applied,
          disposition,
          ...diagnosticSnapshot,
        },
        'info',
        {
          ...(applied || input.receiptId === undefined
            ? {}
            : { coalesceIdentity: `session.preparing:${this.sessionId}:${input.receiptId}` }),
        }
      );
      return { applied };
    };
    if (!metadata || epoch === null) return result(false, 'session_unavailable');
    const root = metadata.auth.kiloSessionId;
    if (input.identity.directory !== this.directory(metadata))
      return result(false, 'directory_mismatch');
    if (
      input.identity.rootKiloSessionId !== undefined &&
      root !== undefined &&
      input.identity.rootKiloSessionId !== root
    ) {
      return result(false, 'root_mismatch');
    }
    const hasReceiptIdentity =
      input.receiptId !== undefined ||
      input.receiptHash !== undefined ||
      input.sequence !== undefined;
    const message = this.loadMessages().find(
      item => item.messageId === input.payload.triggerMessageId
    );
    if (!this.terminalLifecycle.isCurrent(epoch)) return result(false, 'epoch_changed');
    if (!message) return result(false, 'message_missing');
    // HEAD's attempt fence runs before the settled branch, against the retained
    // message identity: a delayed event from an older attempt is rejected, while
    // a same-attempt replay of a settled turn is acknowledged by receipt.
    if (deliveryPreparationAttemptId(message) !== input.payload.attemptId)
      return result(false, 'attempt_mismatch');
    if (message.state.kind !== 'queued') {
      if (
        this.evaluateControlEvent({
          contract: 'publication_admission',
          input,
          epoch,
          publication: {
            kind: 'preparing',
            loadTrigger: () => undefined,
          },
        }) === 'duplicate'
      )
        return result(true, 'duplicate');
      const receipt = hasReceiptIdentity
        ? this.commitControlEventReceipt(input, epoch)
        : this.terminalLifecycle.isCurrent(epoch)
          ? ('apply' as const)
          : ('epoch_changed' as const);
      return result(
        receipt === 'apply' || receipt === 'duplicate',
        receipt === 'apply' || receipt === 'duplicate' ? 'already_settled' : receipt
      );
    }
    const sessionId = this.requireSessionId();
    const notifications: StoredEvent[] = [];
    const receipt = this.ctx.storage.transactionSync((): ControlEventDisposition => {
      const admission = this.evaluateControlEvent({
        contract: 'publication_admission',
        input,
        epoch,
        publication: {
          kind: 'preparing',
          loadTrigger: () => {
            const trigger = this.loadMessages().find(
              item => item.messageId === input.payload.triggerMessageId
            );
            const state = trigger?.state;
            return trigger !== undefined &&
              state?.kind === 'queued' &&
              trigger.cancellation === undefined &&
              state.preparationAttemptId === input.payload.attemptId &&
              state.wrapperInstanceId === input.wrapperInstanceId
              ? trigger
              : undefined;
          },
        },
      });
      if (admission !== 'apply' && admission !== 'native_runtime_pending') return admission;
      applyControlPlanePreparingEvent({
        sessionId,
        data: input.payload,
        eventQueries: this.eventQueries,
        broadcast: event => notifications.push(event),
      });
      this.recordControlEventReceipt(input);
      return 'apply' as const;
    });
    if (receipt === 'duplicate') return result(true, 'duplicate');
    if (receipt !== 'apply') return result(false, receipt);
    for (const notification of notifications) this.broadcastStoredEvent(notification);
    return result(true, 'processed');
  }

  receiveSandboxOperationResult(input: {
    session: SessionRequestIdentity;
    wrapperInstanceId: string;
    delivery: unknown;
  }): Promise<SessionOperationAck | undefined> {
    return this.trackOperation(this.applySandboxOperationResult(input));
  }

  private async applySandboxOperationResult(input: {
    session: SessionRequestIdentity;
    wrapperInstanceId: string;
    delivery: unknown;
  }): Promise<SessionOperationAck | undefined> {
    const parsed = sessionOperationDeliverySchema.safeParse(input.delivery);
    if (!parsed.success) return undefined;
    const delivery = parsed.data;
    const authorization = delivery.authorization;
    const deadlineAt = Math.min(
      sessionOperationExpiresAt(authorization),
      delivery.completedAt + SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS
    );
    if (
      delivery.completedAt > Date.now() + SANDBOX_CONTROL_REQUEST_TIMEOUT_MS ||
      authorization.wrapperInstanceId !== input.wrapperInstanceId ||
      authorization.session.sessionId !== input.session.sessionId ||
      authorization.session.kiloSessionId !== input.session.kiloSessionId ||
      authorization.session.directory !== input.session.directory ||
      Date.now() >= sessionOperationExpiresAt(authorization)
    )
      return undefined;
    const metadata = await this.getMetadata();
    const epoch = this.terminalLifecycle.captureEpoch();
    if (
      !metadata ||
      epoch === null ||
      input.session.sessionId !== this.sessionId ||
      input.session.kiloSessionId !== metadata.auth.kiloSessionId ||
      input.session.directory !== this.directory(metadata)
    )
      return undefined;
    const hash = await sessionOperationResultHash(delivery);
    const notifications: StoredEvent[] = [];
    const ack = commitSessionOperationResult({
      storage: this.ctx.storage,
      delivery,
      hash,
      deadlineAt,
      isCurrent: () => {
        const current = this.terminalLifecycle.getStoredMetadata();
        return (
          this.terminalLifecycle.isCurrent(epoch) &&
          current !== null &&
          input.session.sessionId === this.sessionId &&
          input.session.kiloSessionId === current.auth.kiloSessionId &&
          input.session.directory === this.directory(current)
        );
      },
      messages: {
        read: () => this.loadMessages(),
        commit: messages =>
          this.saveMessagesInCurrentTransaction(messages, epoch, 'operation_result', notifications),
        aggregate: () => this.sessionAggregate(this.loadMessages()),
      },
      eventQueries: this.eventQueries,
      notifications,
    });
    this.scheduleCallbackRepairIfRequired();
    if (!ack) return undefined;
    if (authorization.operation === 'session.attach') {
      const attached = delivery.result.ok
        ? sessionAttachResultSchema.safeParse(delivery.result.result)
        : undefined;
      logControlDiagnostic('session_attach_completion', {
        sessionId: this.sessionId,
        messageId: authorization.messageId,
        attemptId: authorization.operationId,
        operationId: authorization.operationId,
        wrapperInstanceId: input.wrapperInstanceId,
        resultState: ack.disposition,
        ok: delivery.result.ok,
        nativeRuntimeId: attached?.success ? attached.data.nativeRuntimeId : undefined,
        errorCode: delivery.result.ok ? undefined : delivery.result.error.code,
        retryable: delivery.result.ok ? undefined : delivery.result.error.retryable,
      });
    }
    if (
      authorization.operation === 'session.attach' &&
      delivery.result.ok &&
      (ack.disposition === 'applied' || ack.disposition === 'identical') &&
      metadata.workspace?.sandboxId
    ) {
      const attached = sessionAttachResultSchema.safeParse(delivery.result.result);
      if (attached.success && attached.data.nativeRuntimeId !== undefined)
        await this.recordNativeRuntime({
          sandboxId: metadata.workspace.sandboxId,
          wrapperInstanceId: input.wrapperInstanceId,
          nativeRuntimeId: attached.data.nativeRuntimeId,
          authorization,
        });
    }
    for (const notification of notifications) this.broadcastStoredEvent(notification);
    if (ack.disposition === 'applied' && delivery.outcome) {
      if (this.isCurrentEventRuntime(input.wrapperInstanceId))
        this.worktreeChanges.onEvent(
          this.worktreeContext(metadata),
          metadata.auth.kiloSessionId,
          'session.message.outcome',
          delivery.outcome
        );
      await this.armQueueRetry();
      const nextId = nextQueuedMessageId(this.loadMessages());
      if (nextId && this.terminalLifecycle.isCurrent(epoch))
        this.ctx.waitUntil(this.dispatchQueued(nextId));
    }
    return ack;
  }

  async closeOrgStreams(organizationId: string): Promise<number> {
    const metadata = this.terminalLifecycle.getStoredMetadata();
    if (!metadata?.identity.orgId || metadata.identity.orgId !== organizationId) return 0;
    this.worktreeChanges.suppress();
    const records = this.terminalLifecycle.beginRevocation(metadata);
    const sockets = this.ctx.getWebSockets('stream');
    for (const ws of sockets) ws.close(1000, 'session access revoked');
    await this.terminalLifecycle.cleanupSession(metadata, records);
    return sockets.length;
  }

  async getRuntimeLocation(): Promise<SessionRuntimeLocator | null> {
    const raw = await this.ctx.storage.get<unknown>(METADATA_KEY);
    return raw === undefined ? null : sessionRuntimeLocator(parseSessionMetadata(raw));
  }

  async getMetadata(): Promise<SessionMetadata | null> {
    return this.deletedWorktreeId || this.terminalLifecycle.isBlocked()
      ? null
      : this.terminalLifecycle.getStoredMetadata();
  }

  async getRuntimeToken(): Promise<string | null> {
    const metadata = await this.getMetadata();
    const secret = await resolveSecret(this.env.NEXTAUTH_SECRET);
    if (!secret) throw new Error('NEXTAUTH_SECRET is not configured on the worker');
    return renewStoredRuntimeAuthorization({
      metadata,
      getAuthorization: async () => this.ctx.storage.kv.get<unknown>(RUNTIME_AUTHORIZATION_KEY),
      putAuthorization: async authorization => {
        this.ctx.storage.kv.put(RUNTIME_AUTHORIZATION_KEY, authorization);
      },
      getMetadata: () => this.getMetadata(),
      putMetadata: async updated => {
        this.ctx.storage.kv.put(METADATA_KEY, updated);
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

  async getRuntimeAuthorizationStatus(): Promise<'legacy' | 'active' | 'revoked'> {
    return getRuntimeAuthorizationStatus({
      metadata: await this.getMetadata(),
      getAuthorization: async () => this.ctx.storage.kv.get<unknown>(RUNTIME_AUTHORIZATION_KEY),
    });
  }

  async getRuntimeAuthorizationRecoveryState(): Promise<{
    state: 'legacy' | 'revoked' | 'active' | 'expired';
    id?: string;
    recoveryId?: string;
  }> {
    const state = await getRuntimeAuthorizationRecoveryState({
      metadata: await this.getMetadata(),
      getAuthorization: async () => this.ctx.storage.kv.get<unknown>(RUNTIME_AUTHORIZATION_KEY),
    });
    const lock = runtimeAuthorizationRecoveryLockSchema.safeParse(
      this.ctx.storage.kv.get<unknown>(RUNTIME_AUTHORIZATION_RECOVERY_KEY)
    );
    return state.state === 'expired' && lock.success && lock.data.expectedOldId === state.id
      ? { ...state, recoveryId: lock.data.recoveryId }
      : state;
  }

  async isRuntimeAuthorizationRecoveryInProgress(): Promise<boolean> {
    return this.ctx.storage.kv.get(RUNTIME_AUTHORIZATION_RECOVERY_KEY) !== undefined;
  }

  async recoverExpiredRuntimeAuthorization(input: {
    ownerId: string;
    expectedOldId: string;
    recoveryId: string;
    runtimeAuthorizationSeal: string;
    runtimeToken: string;
  }): Promise<{ status: 'recovered' | 'not-needed' | 'denied' | 'busy' | 'retry' }> {
    const metadata = await this.getMetadata();
    const denied = (reason: Parameters<typeof runtimeAuthorizationRecoveryDenied>[1]) =>
      runtimeAuthorizationRecoveryDenied(metadata?.identity.sessionId ?? this.sessionId, reason);
    if (!metadata) return denied('metadata_unavailable');
    if (metadata.identity.userId !== input.ownerId) return denied('owner_mismatch');
    const secret = await resolveSecret(this.env.NEXTAUTH_SECRET);
    if (!secret) return denied('missing_secret');
    let fresh: RuntimeAuthorization;
    try {
      fresh = await unsealRuntimeAuthorization(input.runtimeAuthorizationSeal, secret, {
        resourceKind: 'cloud-agent-next',
        resourceId: metadata.identity.sessionId,
        userId: metadata.identity.userId,
        organizationId: metadata.identity.orgId,
      });
    } catch {
      return denied('invalid_seal');
    }
    if (fresh.state !== 'active') return denied('fresh_authorization_inactive');
    if (!metadata.auth.kiloSessionId) return denied('kilo_session_missing');
    const current = await this.getRuntimeAuthorizationRecoveryState();
    if (current.state === 'legacy' || current.state === 'active') return { status: 'not-needed' };
    if (current.state !== 'expired' || current.id !== input.expectedOldId)
      return denied('authorization_state_changed');
    if (
      this.loadMessages().some(
        message => message.state.kind === 'accepted' || message.state.kind === 'queued'
      )
    ) {
      return { status: 'busy' };
    }
    const held = runtimeAuthorizationRecoveryLockSchema.safeParse(
      this.ctx.storage.kv.get<unknown>(RUNTIME_AUTHORIZATION_RECOVERY_KEY)
    );
    if (
      held.success &&
      (held.data.recoveryId !== input.recoveryId || held.data.expectedOldId !== input.expectedOldId)
    ) {
      return { status: 'retry' };
    }
    this.ctx.storage.kv.put(RUNTIME_AUTHORIZATION_RECOVERY_KEY, {
      expectedOldId: input.expectedOldId,
      recoveryId: input.recoveryId,
    });
    try {
      const sandboxId = metadata.workspace?.sandboxId;
      if (sandboxId) {
        const control = sandboxControlRpc(this.env, sandboxId);
        const status = await control.getStatus();
        if (status.physical === 'running') {
          if (
            status.connection !== 'ready' ||
            !status.wrapperInstanceId ||
            status.runtimeRecovery !== true
          ) {
            return { status: 'busy' };
          }
          const attached = this.terminalLifecycle.getAttachedWrapperInstanceId();
          if (attached && attached !== status.wrapperInstanceId) return { status: 'retry' };
          const retired = sessionRuntimeRetireResultSchema.parse(
            controlRequestResult(
              await control.request({
                operation: 'session.runtime.retire',
                session: {
                  sessionId: metadata.identity.sessionId,
                  kiloSessionId: metadata.auth.kiloSessionId ?? '',
                  directory: this.directory(metadata),
                },
                expectedWrapperInstanceId: status.wrapperInstanceId,
                payload: { recoveryId: input.recoveryId },
              })
            )
          );
          if (retired.recoveryId !== input.recoveryId || !retired.retired)
            return { status: 'retry' };
          if (
            attached &&
            !this.terminalLifecycle.clearAttachedWrapperAfterRecovery(status.wrapperInstanceId)
          ) {
            return { status: 'busy' };
          }
        } else if (status.physical !== 'stopped') {
          return { status: 'retry' };
        }
      }
      const latest = await this.getRuntimeAuthorizationRecoveryState();
      if (latest.state !== 'expired' || latest.id !== input.expectedOldId)
        return { status: 'retry' };
      this.ctx.storage.transactionSync(() => {
        const stored = RuntimeAuthorizationSchema.safeParse(
          this.ctx.storage.kv.get<unknown>(RUNTIME_AUTHORIZATION_KEY)
        );
        if (
          !stored.success ||
          stored.data.id !== input.expectedOldId ||
          stored.data.state !== 'active' ||
          Date.parse(stored.data.delegationExpiresAt) > Date.now()
        ) {
          throw new Error('runtime_authorization_recovery_cas_failed');
        }
        const currentMetadata = this.terminalLifecycle.getStoredMetadata();
        if (
          !currentMetadata ||
          currentMetadata.identity.sessionId !== metadata.identity.sessionId ||
          currentMetadata.identity.userId !== metadata.identity.userId ||
          currentMetadata.identity.orgId !== metadata.identity.orgId
        ) {
          throw new Error('runtime_authorization_recovery_cas_failed');
        }
        this.ctx.storage.kv.put(RUNTIME_AUTHORIZATION_KEY, fresh);
        this.ctx.storage.kv.put(
          METADATA_KEY,
          serializeSessionMetadata({
            ...currentMetadata,
            auth: { ...currentMetadata.auth, kilocodeToken: input.runtimeToken },
          })
        );
        this.ctx.storage.kv.delete(RUNTIME_PROXY_GRANT_KEY);
        this.ctx.storage.kv.delete(RUNTIME_AUTHORIZATION_RECOVERY_KEY);
      });
      return { status: 'recovered' };
    } catch {
      return { status: 'retry' };
    }
  }

  async issueRuntimeCredentialProxyGrant(_fence: {
    wrapperRunId: string;
    wrapperGeneration: number;
    wrapperConnectionId: string;
  }): Promise<string | null> {
    const metadata = await this.getMetadata();
    const kiloSessionId = metadata?.auth.kiloSessionId;
    const sandboxId = metadata?.workspace?.sandboxId;
    if (!metadata || !kiloSessionId || !sandboxId) return null;
    const control = sandboxControlRpc(this.env, sandboxId);
    const readFence = () =>
      control.getRuntimeCredentialProxyFence({
        ownerId: metadata.identity.userId,
        sessionId: metadata.identity.sessionId,
        kiloSessionId,
        directory: this.directory(metadata),
      });
    const fence = await readFence();
    if (!fence) return null;
    const token = await this.getRuntimeToken();
    const [latestMetadata, storedAuthorization, latestFence] = await Promise.all([
      this.getMetadata(),
      this.ctx.storage.kv.get<unknown>(RUNTIME_AUTHORIZATION_KEY),
      readFence(),
    ]);
    const authorization = RuntimeAuthorizationSchema.safeParse(storedAuthorization);
    if (!latestFence || !sameRuntimeProxyControlBinding(fence, latestFence)) {
      return null;
    }
    return issuePersistedRuntimeProxyGrant({
      env: this.env,
      storage: this.ctx.storage,
      metadata: latestMetadata,
      authorization: authorization.success ? authorization.data : null,
      fence: latestFence,
      token,
      mode: 'contained',
    });
  }

  async resolveRuntimeCredentialProxyGrant(_handle: string): Promise<{
    token: string;
    organizationId?: string;
    runtimeAuthorization: { userId: string; authorizationId: string; resourceId: string };
  } | null> {
    return resolvePersistedRuntimeProxyCredential({
      env: this.env,
      storage: this.ctx.storage,
      handle: _handle,
      metadata: () => this.getMetadata(),
      authorization: async () => {
        const parsed = RuntimeAuthorizationSchema.safeParse(
          await this.ctx.storage.kv.get<unknown>(RUNTIME_AUTHORIZATION_KEY)
        );
        return parsed.success ? parsed.data : null;
      },
      fence: async () => {
        const metadata = await this.getMetadata();
        const kiloSessionId = metadata?.auth.kiloSessionId;
        const sandboxId = metadata?.workspace?.sandboxId;
        if (!metadata || !kiloSessionId || !sandboxId) return null;
        return sandboxControlRpc(this.env, sandboxId).getRuntimeCredentialProxyFence({
          ownerId: metadata.identity.userId,
          sessionId: metadata.identity.sessionId,
          kiloSessionId,
          directory: this.directory(metadata),
        });
      },
      token: () => this.getRuntimeToken(),
    });
  }

  async reauthorizeRuntimeAuthorization(input: {
    ownerId: string;
    expectedOldId: string;
    runtimeAuthorizationSeal: string;
  }): Promise<boolean> {
    const metadata = await this.getMetadata();
    if (!metadata || metadata.identity.userId !== input.ownerId) return false;
    const secret = await resolveSecret(this.env.NEXTAUTH_SECRET);
    if (!secret) return false;
    let authorization: RuntimeAuthorization;
    try {
      authorization = await unsealRuntimeAuthorization(input.runtimeAuthorizationSeal, secret, {
        resourceKind: 'cloud-agent-next',
        resourceId: metadata.identity.sessionId,
        userId: metadata.identity.userId,
        organizationId: metadata.identity.orgId,
      });
    } catch {
      return false;
    }
    if (authorization.state !== 'active') return false;
    const current = RuntimeAuthorizationSchema.safeParse(
      this.ctx.storage.kv.get<unknown>(RUNTIME_AUTHORIZATION_KEY)
    );
    if (!current.success || current.data.id !== input.expectedOldId) return false;
    this.ctx.storage.kv.put(RUNTIME_AUTHORIZATION_KEY, authorization);
    return true;
  }

  async getCredentialMetadata(): Promise<SessionMetadata | null> {
    if (this.deletedWorktreeId) return null;
    return this.terminalLifecycle.isBlocked() ? null : this.terminalLifecycle.getStoredMetadata();
  }

  async getSandboxStatus(): Promise<SandboxStatusSnapshot> {
    const metadata =
      this.deletedWorktreeId || this.terminalLifecycle.isDeleted()
        ? null
        : this.terminalLifecycle.getStoredMetadata();
    const provider = metadata ? getSandboxProvider(metadata) : undefined;
    const unknown: SandboxStatusSnapshot = {
      status: 'unknown',
      provider: getSandboxProviderLabel(provider),
      observedAt: Date.now(),
      detailCode: 'insufficient_evidence',
      inactivityTimeoutMs: DEADLINE_MS.idleStop,
      estimatedSleepAt: null,
    };
    const sandboxId = metadata?.workspace?.sandboxId;
    if (!metadata || !sandboxId || !provider || metadata.identity.sessionId !== this.sessionId) {
      return unknown;
    }
    try {
      return await withDORetry(
        () => getSandboxControlStub(this.env, sandboxId),
        async control => {
          try {
            return SandboxStatusSnapshotSchema.parse(
              await control.getSandboxStatus({ ownerId: metadata.identity.userId, provider })
            );
          } catch (error) {
            throw Object.assign(new Error('Sandbox status unavailable'), {
              retryable: error instanceof Error && 'retryable' in error && error.retryable === true,
            });
          }
        },
        'getSandboxStatus'
      );
    } catch {
      return { ...unknown, observedAt: Date.now(), detailCode: 'status_unavailable' };
    }
  }

  async getPendingInteractions(): Promise<{ questions: unknown[]; permissions: unknown[] }> {
    return this.derivePendingInteractions() ?? { questions: [], permissions: [] };
  }

  async getWorktreeChanges(): Promise<GetWorktreeChangesOutput> {
    if (this.deletedWorktreeId || this.terminalLifecycle.isBlocked()) return { snapshot: null };
    return this.worktreeChanges.get();
  }

  async refreshWorktreeChanges(): Promise<RefreshWorktreeChangesOutput> {
    if (this.deletedWorktreeId || this.terminalLifecycle.isBlocked()) {
      return { status: 'offline', snapshot: null };
    }
    return this.worktreeChanges.refresh();
  }

  async getWorktreeFile(input: WorktreeFileQuery): Promise<GetWorktreeFileOutput> {
    if (this.deletedWorktreeId || this.terminalLifecycle.isBlocked())
      return { status: 'not_captured' };
    return this.worktreeChanges.getFile(input);
  }

  async validateKiloGlobalFeedProducer(_params: {
    kiloSessionId: string;
    wrapperRunId: string;
    wrapperGeneration: number;
    wrapperConnectionId: string;
  }): Promise<{ success: false; status: number; message: string }> {
    return { success: false, status: 404, message: 'Not found' };
  }

  async getLatestAssistantMessage(): Promise<LatestAssistantMessage | null> {
    const metadata = await this.getMetadata();
    const sessionId = this.sessionId;
    if (!metadata?.auth.kiloSessionId || !sessionId) return null;
    return this.eventQueries.getLatestAssistantMessage(sessionId, metadata.auth.kiloSessionId);
  }

  async getLatestEventId(): Promise<number | null> {
    return this.eventQueries.getLatestEventId();
  }

  async getMessageResult(messageId: string): Promise<MessageResultRPCResponse> {
    if (!(await this.getMetadata())) return { type: 'session-not-found' };
    const record = this.loadMessages().find(message => message.messageId === messageId);
    if (!record) return { type: 'message-not-found' };
    const kind = record.state.kind;
    const status =
      kind === 'queued'
        ? 'queued'
        : kind === 'accepted'
          ? 'running'
          : kind === 'cancelled'
            ? 'interrupted'
            : kind;
    return {
      type: 'found',
      result: {
        messageId: record.messageId,
        status,
        createdAt: acceptedAtOf(record) ?? 0,
        cloudAgentSessionId: this.requireSessionId(),
      },
    };
  }

  async markAsInterrupted(): Promise<void> {
    return;
  }

  /**
   * Read-only control-plane session state for the remaining recovery/authority
   * consumers (dead modules until C3d). The `stops` array is gone with the
   * removed session-stop contract, and the shape is local so
   * `shared/control-plane-session.ts` loses its last live consumer.
   */
  async getControlState(options?: { includeIdle: true }): Promise<{
    version: 1;
    scope: { sandboxId: string; wrapperInstanceId?: string };
    targets: Array<{
      messageId: string;
      wrapperInstanceId?: string;
      executionDeadlineAt?: number;
    }>;
    operations?: Array<{
      messageId: string;
      authorization: z.infer<typeof sessionOperationAuthorizationSchema>;
      executionDeadlineAt?: number;
    }>;
  } | null> {
    return this.controlSessionState(options?.includeIdle === true);
  }

  private controlSessionState(includeIdle: boolean): {
    version: 1;
    scope: { sandboxId: string; wrapperInstanceId?: string };
    targets: Array<{
      messageId: string;
      wrapperInstanceId?: string;
      executionDeadlineAt?: number;
    }>;
    operations?: Array<{
      messageId: string;
      authorization: z.infer<typeof sessionOperationAuthorizationSchema>;
      executionDeadlineAt?: number;
    }>;
  } | null {
    const metadata = this.terminalLifecycle.getStoredMetadata();
    const sandboxId = metadata?.workspace?.sandboxId;
    if (!metadata || !sandboxId || this.terminalLifecycle.captureEpoch() === null) return null;
    const messages = this.loadMessages();
    const targets = messages
      .filter(message => {
        const kind = message.state.kind;
        return (
          (kind === 'queued' || kind === 'accepted') &&
          message.cancellation === undefined &&
          (!includeIdle || kind === 'accepted' || activeWrapperInstanceId(message) !== undefined)
        );
      })
      .map(message => {
        const wrapperInstanceId = activeWrapperInstanceId(message);
        const executionDeadlineAt = message.proofs?.prompt?.executionDeadlineAt;
        return {
          messageId: message.messageId,
          ...(wrapperInstanceId ? { wrapperInstanceId } : {}),
          ...(executionDeadlineAt ? { executionDeadlineAt } : {}),
        };
      });
    const operations = messages.flatMap(message => {
      const authorization = sessionOperationAuthorizationSchema.safeParse(
        message.proofs?.prompt?.authorization
      );
      const executionDeadlineAt = message.proofs?.prompt?.executionDeadlineAt;
      if (!authorization.success || !message.proofs?.prompt?.dispatched) return [];
      return [
        {
          messageId: message.messageId,
          authorization: authorization.data,
          ...(executionDeadlineAt ? { executionDeadlineAt } : {}),
        },
      ];
    });
    if (!includeIdle && targets.length === 0) return null;
    const attachedWrapperInstanceId = this.terminalLifecycle.getAttachedWrapperInstanceId();
    return {
      version: 1,
      scope: {
        sandboxId,
        ...(attachedWrapperInstanceId ? { wrapperInstanceId: attachedWrapperInstanceId } : {}),
      },
      targets,
      ...(operations.length > 0 ? { operations } : {}),
    };
  }

  async reconcileControlRecovery(
    input: unknown
  ): Promise<{ state: 'reconciled' | 'unresolved' | 'stale' }> {
    const requested = z
      .array(sessionOperationAuthorizationSchema)
      .max(SANDBOX_CONTROL_OPERATION_LIMIT)
      .parse(input);
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return { state: 'stale' };
    for (const authorization of requested) {
      const message = this.loadMessages().find(item => item.messageId === authorization.messageId);
      const stored = sessionOperationAuthorizationSchema.safeParse(
        message?.proofs?.prompt?.authorization
      );
      if (
        !message ||
        !stored.success ||
        !message.proofs?.prompt?.dispatched ||
        !sameSessionOperation(stored.data, authorization) ||
        !this.terminalLifecycle.isCurrent(epoch)
      )
        return { state: 'stale' };
      const observed = await this.observeAcceptedOperation(message, epoch);
      if (!this.terminalLifecycle.isCurrent(epoch)) return { state: 'stale' };
      if (observed !== 'running' && observed !== 'completed') return { state: 'unresolved' };
    }
    return { state: 'reconciled' };
  }

  async cancelQueuedMessage(messageId: string): Promise<{ dropped: boolean }> {
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null || this.deletedWorktreeId) return { dropped: false };
    const result = cancelPendingMessage(this.sessionAggregate(this.loadMessages()), messageId);
    if (!result.dropped) return { dropped: false };
    if (result.messages && !this.saveMessages(result.messages, epoch)) return { dropped: false };
    if (nextQueuedMessageId(this.loadMessages())) await this.armQueueRetry();
    return { dropped: true };
  }

  async interruptExecution(): Promise<{
    success: boolean;
    message?: string;
    unconfirmed?: boolean;
  }> {
    return this.interruptLegacyExecution();
  }

  private async interruptLegacyExecution(): Promise<{
    success: boolean;
    message?: string;
    unconfirmed?: boolean;
  }> {
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return { success: false, message: 'Session not found' };
    const before = this.loadMessages();
    if (!this.terminalLifecycle.isCurrent(epoch)) {
      return { success: false, message: 'Session not found' };
    }
    const active = before.filter(
      message => message.state.kind === 'queued' || message.state.kind === 'accepted'
    );
    if (!active.length) return { success: false, message: 'No session work to interrupt' };
    const accepted = active.find(message => message.state.kind === 'accepted');
    const metadata = this.terminalLifecycle.getStoredMetadata();
    const now = Date.now();
    this.saveMessages(
      before.map(message =>
        message.state.kind === 'queued'
          ? {
              ...message,
              state: terminalMessageState(message.state, 'cancelled', now, 'coordinator', {}),
            }
          : message
      ),
      epoch
    );
    if (!accepted) return { success: true };

    // The accepted turn is stopped by the wrapper, not by this coordinator. Mint
    // the durable cancellation id and deadline before any early return or the RPC
    // so a crash mid-abort still settles the row, and reuse them on retry.
    const current = this.loadMessages().find(message => message.messageId === accepted.messageId);
    const stored = current?.cancellation;
    const operationId = stored?.operationId ?? crypto.randomUUID();
    const deadlineAt = stored?.deadlineAt ?? now + POLICY.cancellationDeadlineMs;
    if (!stored) {
      const recorded = decideSession(
        this.sessionAggregate(this.loadMessages()),
        { type: 'RECORD_CANCELLATION', messageId: accepted.messageId, operationId, deadlineAt },
        now
      );
      if (!recorded || !this.saveMessages(recorded.state.messages, epoch)) {
        return { success: false, message: 'Session not found' };
      }
    }
    await this.armQueueRetry(deadlineAt);

    // An abort is only safe when it names the accepted message's own wrapper. A
    // missing id cannot be fenced, so a replacement wrapper could answer for it.
    const expectedWrapperInstanceId = activeWrapperInstanceId(accepted);
    if (!expectedWrapperInstanceId) {
      return { success: false, message: 'No wrapper found for session', unconfirmed: true };
    }
    const sandboxId = metadata?.workspace?.sandboxId;
    const kiloSessionId = metadata?.auth.kiloSessionId;
    const sessionId = this.sessionId;
    if (!metadata || !sandboxId || !kiloSessionId || !sessionId) {
      return { success: false, message: 'No wrapper found for session', unconfirmed: true };
    }

    let status: 'aborted' | 'already_idle' | 'unconfirmed' | undefined;
    let failureMessage = 'Session abort was not confirmed';
    try {
      const response = await sandboxControlRpc(this.env, sandboxId).request({
        operation: 'session.abort',
        session: {
          sessionId,
          kiloSessionId,
          directory: this.directory(metadata),
        },
        payload: { messageId: accepted.messageId, operationId, cleanupDeadlineAt: deadlineAt },
        expectedWrapperInstanceId,
      });
      if (response.ok) {
        const parsed = sessionAbortResultSchema.safeParse(response.result);
        if (parsed.success) status = parsed.data.status;
        else failureMessage = 'Session abort result was unreadable';
      } else {
        failureMessage = response.error?.message ?? failureMessage;
      }
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : failureMessage;
    }

    if (status === 'aborted' || status === 'already_idle') {
      if (!this.isCurrentAcceptedMessage(accepted, epoch)) {
        return { success: false, message: 'Session work changed', unconfirmed: true };
      }
      const at = Date.now();
      const decided = decideSession(
        this.sessionAggregate(this.loadMessages()),
        {
          type: 'OUTCOME',
          messageId: accepted.messageId,
          status: 'cancelled',
          at,
          source: 'coordinator',
        },
        at
      );
      if (decided && this.saveMessages(decided.state.messages, epoch)) {
        this.worktreeChanges.markInterrupted(this.worktreeContext(metadata));
        await this.armQueueRetry();
        return { success: true };
      }
      return { success: false, message: 'Session work changed', unconfirmed: true };
    }

    // Unconfirmed, unsent, or unreadable: the accepted row keeps its marker and
    // stays accepted so the alarm settles it at the cancellation deadline.
    await this.armQueueRetry();
    return { success: false, message: failureMessage, unconfirmed: true };
  }

  /**
   * Allocation→session `STOPPED` seam. Inert until the C3b control flip wires
   * the `NotifySession` command to this stub method.
   *
   * Fences on the persisted allocation incarnation: only a proof for the bound
   * incarnation fails in-flight (`accepted`) work, preserves `queued` work and
   * clears the binding. A stale or duplicate proof is a no-op. A pre-C3b
   * attachment without an incarnation is resolved against the control's canonical
   * state first, and the resolution is revalidated inside the committing
   * transaction so a concurrent rebind is never overwritten and the event is never
   * dropped. The legacy proof-independent `settleStopped` path for an
   * incarnation-less attachment still terminalises every queued/accepted row via
   * `terminalizeOnStop`, so only this fenced proof path preserves `queued` work.
   */
  async notifyStopped(input: {
    stopProof: StopProof | undefined;
    reason: string;
  }): Promise<NotifyEffectResult> {
    const epoch = this.terminalLifecycle.captureEpoch();
    const metadata = this.terminalLifecycle.getStoredMetadata();
    const sandboxId = metadata?.workspace?.sandboxId;
    if (epoch === null || !metadata || !sandboxId) return { outcome: 'delivered' };
    const initial = this.terminalLifecycle.getAttachedBinding();
    if (!initial) return { outcome: 'delivered' };

    const resolution =
      initial.allocationIncarnation === undefined
        ? await this.resolveLegacyStopAttachment(sandboxId, initial.wrapperInstanceId)
        : ({ kind: 'none' } as const);
    if (resolution.kind === 'unresolved') {
      return { outcome: 'failed', reason: 'stop_attachment_unresolved' };
    }
    if (input.stopProof === undefined && resolution.kind !== 'settle') {
      return { outcome: 'failed', reason: 'stop_proof_missing' };
    }

    let outcome: 'settled' | 'noop' | 'rejected';
    try {
      outcome = this.ctx.storage.transactionSync((): 'settled' | 'noop' | 'rejected' => {
        const current = this.terminalLifecycle.getAttachedBinding();
        if (!current) return 'noop';
        // The resolver read above is asynchronous: revalidate its outcome against
        // the attachment actually bound when this transaction commits. A
        // concurrent delete or rebind discards the stale resolver result (never the
        // incoming STOPPED); only the same incarnation-less record may settle.
        const sameAttachment =
          current.wrapperInstanceId === initial.wrapperInstanceId &&
          current.allocationIncarnation === initial.allocationIncarnation;
        if (!sameAttachment && current.allocationIncarnation === undefined) return 'noop';
        if (sameAttachment && current.allocationIncarnation === undefined) {
          if (resolution.kind === 'settle') {
            const settled = settleStopped({
              messages: readRawSessionMessages(this.ctx.storage.kv),
              reason: input.reason,
              now: Date.now(),
            });
            if (settled.outcome !== 'settled') return 'rejected';
            // Admission is confirmed before any mutation, so a rejected commit
            // leaves the original attachment and envelope untouched.
            if (!this.terminalLifecycle.isCurrent(epoch) || this.deletedWorktreeId) {
              return 'rejected';
            }
            this.terminalLifecycle.clearAttachmentForStop({
              wrapperInstanceId: current.wrapperInstanceId,
            });
            this.clearNativeRuntimeFenceForStop(sandboxId, current.wrapperInstanceId);
            if (
              !this.saveMessagesInCurrentTransaction([...settled.messages], epoch, 'coordinator')
            ) {
              throw new StopCommitRejectedError();
            }
            return 'settled';
          }
          if (resolution.kind !== 'hydrate') return 'noop';
        }
        const incarnation =
          current.allocationIncarnation ??
          (sameAttachment && resolution.kind === 'hydrate' ? resolution.incarnation : undefined);
        if (incarnation === undefined || input.stopProof === undefined) return 'rejected';
        const decision = decideStopped({
          messages: readRawSessionMessages(this.ctx.storage.kv),
          attachment: {
            allocationIncarnation: incarnation,
            wrapperInstanceId: current.wrapperInstanceId,
          },
          event: { type: 'STOPPED', proof: input.stopProof, reason: input.reason },
          now: Date.now(),
        });
        // A rejected/stale `decideStopped` is a no-op, never a settlement: arming
        // a preserved-queue retry on a proof the transaction refused to apply
        // would wake a retry the commit did not authorise.
        if (decision.outcome !== 'terminalized') return 'noop';
        // Hydration writes immediately, so write admission is confirmed before
        // it: there is no "unhydrate", and the rejected path must stay
        // mutation-free.
        if (!this.terminalLifecycle.isCurrent(epoch) || this.deletedWorktreeId) {
          return 'rejected';
        }
        if (current.allocationIncarnation === undefined) {
          this.terminalLifecycle.hydrateAttachmentIncarnation(incarnation);
        }
        this.terminalLifecycle.clearAttachmentForStop({
          wrapperInstanceId: current.wrapperInstanceId,
          allocationIncarnation: incarnation,
        });
        this.clearNativeRuntimeFenceForStop(sandboxId, current.wrapperInstanceId);
        // Encode the envelope from the final messages against the now-cleared
        // attachment, so the persisted binding is `unbound`.
        if (!this.saveMessagesInCurrentTransaction([...decision.messages], epoch, 'coordinator')) {
          throw new StopCommitRejectedError();
        }
        return 'settled';
      });
    } catch (error) {
      if (!(error instanceof StopCommitRejectedError)) throw error;
      outcome = 'rejected';
    }
    // The transaction committed with immediate repair scheduling disabled, so
    // flush any deferred callback/report repair now (as the operation-result
    // commit path does) instead of waiting for unrelated later activity.
    this.scheduleCallbackRepairIfRequired();
    if (outcome === 'settled') this.armPreservedQueue();
    const applied = outcome !== 'rejected';
    return applied
      ? { outcome: 'delivered' }
      : { outcome: 'failed', reason: 'stop_commit_rejected' };
  }

  /**
   * Classify a pre-C3b attachment against the control's authoritative canonical
   * state. A read failure or a live incarnation with no exposed wrapper stays
   * unresolved and is retried; the notification never invents a match.
   */
  private async resolveLegacyStopAttachment(
    sandboxId: string,
    wrapperInstanceId: string
  ): Promise<
    | { kind: 'none' }
    | { kind: 'settle' }
    | { kind: 'hydrate'; incarnation: string }
    | { kind: 'unresolved' }
  > {
    let status: Awaited<ReturnType<ReturnType<typeof sandboxControlRpc>['getStatus']>>;
    try {
      status = await sandboxControlRpc(this.env, sandboxId).getStatus();
    } catch {
      return { kind: 'unresolved' };
    }
    if (status.allocationIncarnation === undefined) return { kind: 'settle' };
    if (status.wrapperInstanceId === undefined) return { kind: 'unresolved' };
    return status.wrapperInstanceId === wrapperInstanceId
      ? { kind: 'hydrate', incarnation: status.allocationIncarnation }
      : { kind: 'settle' };
  }

  private clearNativeRuntimeFenceForStop(sandboxId: string, wrapperInstanceId: string): void {
    const fence = nativeRuntimeFenceSchema.safeParse(
      this.ctx.storage.kv.get<unknown>(NATIVE_RUNTIME_FENCE_KEY)
    );
    if (
      fence.success &&
      fence.data.sandboxId === sandboxId &&
      fence.data.wrapperInstanceId === wrapperInstanceId
    ) {
      this.ctx.storage.kv.delete(NATIVE_RUNTIME_FENCE_KEY);
    }
  }

  async answerPermission(input: {
    permissionId: string;
    response: 'once' | 'always' | 'reject';
  }): Promise<{ success: boolean }> {
    const result = await this.requestSessionOperation('session.permission.resolve', {
      permissionId: input.permissionId,
      response: input.response,
    });
    this.recordPendingInteraction({
      type: 'permission.replied',
      properties: { requestID: input.permissionId },
    });
    return result;
  }

  async answerQuestion(input: {
    questionId: string;
    answers: string[][];
  }): Promise<{ success: boolean }> {
    const result = await this.requestSessionOperation('session.question.resolve', {
      action: 'answer',
      questionId: input.questionId,
      answers: input.answers,
    });
    this.recordPendingInteraction({
      type: 'question.replied',
      properties: { requestID: input.questionId },
    });
    return result;
  }

  async rejectQuestion(input: { questionId: string }): Promise<{ success: boolean }> {
    const result = await this.requestSessionOperation('session.question.resolve', {
      action: 'reject',
      questionId: input.questionId,
    });
    this.recordPendingInteraction({
      type: 'question.rejected',
      properties: { requestID: input.questionId },
    });
    return result;
  }

  async createTerminal(input?: {
    cols?: number;
    rows?: number;
    operationId?: string;
  }): Promise<OperationResult<{ pty: WrapperPty }>> {
    if (this.ctx.storage.kv.get<string>(RUNTIME_AUTHORIZATION_RECOVERY_KEY)) {
      return { success: false, error: 'Runtime authorization recovery is in progress' };
    }
    return this.trackOperation(this.terminalLifecycle.createTerminal(input));
  }

  async resizeTerminal(input?: {
    ptyId?: string;
    cols?: number;
    rows?: number;
  }): Promise<OperationResult<{ pty: WrapperPty }>> {
    if (this.ctx.storage.kv.get<string>(RUNTIME_AUTHORIZATION_RECOVERY_KEY)) {
      return { success: false, error: 'Runtime authorization recovery is in progress' };
    }
    return this.trackOperation(this.terminalLifecycle.resizeTerminal(input));
  }

  async closeTerminal(input?: { ptyId?: string }): Promise<OperationResult<{ success: boolean }>> {
    return this.trackOperation(this.terminalLifecycle.closeTerminal(input));
  }

  async invalidateTerminalRuntime(input: {
    sandboxId: string;
    wrapperInstanceId: string;
    confirmed: boolean;
    nativeRuntimeId?: string;
  }): Promise<void> {
    const current = nativeRuntimeFenceSchema.safeParse(
      this.ctx.storage.kv.get<unknown>(NATIVE_RUNTIME_FENCE_KEY)
    );
    if (
      input.nativeRuntimeId !== undefined &&
      (!current.success ||
        current.data.sandboxId !== input.sandboxId ||
        current.data.wrapperInstanceId !== input.wrapperInstanceId ||
        current.data.nativeRuntimeId !== input.nativeRuntimeId)
    )
      return;
    this.terminalLifecycle.invalidateRuntime(input);
    logControlDiagnostic('native_fence_transition', {
      sessionId: this.sessionId,
      sandboxId: input.sandboxId,
      transition: 'retire',
      oldWrapperInstanceId: current.success ? current.data.wrapperInstanceId : null,
      oldNativeRuntimeId: current.success ? current.data.nativeRuntimeId : null,
      newWrapperInstanceId: null,
      newNativeRuntimeId: null,
      confirmed: input.confirmed,
      storedFenceRetained: true,
      authority:
        input.nativeRuntimeId === undefined
          ? 'sandbox_control_invalidation'
          : 'native_retirement_confirmation',
    });
  }

  async recordNativeRuntime(input: {
    sandboxId: string;
    wrapperInstanceId: string;
    nativeRuntimeId: string;
    authorization?: SessionOperationAuthorization;
  }): Promise<void> {
    const authorization = sessionOperationAuthorizationSchema.safeParse(input.authorization);
    const epoch = this.terminalLifecycle.captureEpoch();
    const metadata = this.terminalLifecycle.getStoredMetadata();
    if (
      !authorization.success ||
      authorization.data.operation !== 'session.attach' ||
      authorization.data.wrapperInstanceId !== input.wrapperInstanceId ||
      authorization.data.session.sessionId !== this.sessionId ||
      !metadata ||
      metadata.workspace?.sandboxId !== input.sandboxId ||
      authorization.data.session.kiloSessionId !== metadata.auth.kiloSessionId ||
      authorization.data.session.directory !== this.directory(metadata) ||
      epoch === null
    )
      return;
    const message = this.loadMessages().find(
      current => current.messageId === authorization.data.messageId
    );
    const proof = message?.proofs?.attach;
    if (
      !proof?.dispatched ||
      !proof.completedAt ||
      proof.attachmentEpoch === undefined ||
      !sameSessionOperation(proof.authorization, authorization.data) ||
      !this.terminalLifecycle.isCurrent(epoch)
    )
      return;
    if (proof.result !== undefined) {
      if (!proof.result.ok) return;
      const attached = sessionAttachResultSchema.safeParse(proof.result.result);
      if (!attached.success || attached.data.nativeRuntimeId !== input.nativeRuntimeId) return;
    }
    const newestAttachmentEpoch = Math.max(
      0,
      ...this.loadMessages().map(current => current.proofs?.attach?.attachmentEpoch ?? 0)
    );
    const current = nativeRuntimeFenceSchema.safeParse(
      this.ctx.storage.kv.get<unknown>(NATIVE_RUNTIME_FENCE_KEY)
    );
    if (
      proof.attachmentEpoch !== newestAttachmentEpoch ||
      (current.success &&
        (current.data.attachmentEpoch > proof.attachmentEpoch ||
          (current.data.attachmentEpoch === proof.attachmentEpoch &&
            current.data.nativeRuntimeId !== input.nativeRuntimeId)))
    )
      return;
    this.ctx.storage.kv.put(
      NATIVE_RUNTIME_FENCE_KEY,
      nativeRuntimeFenceSchema.parse({
        ...input,
        attachmentEpoch: proof.attachmentEpoch,
        authorization: authorization.data,
      })
    );
    this.clearRuntimeReplacementWaits(epoch);
    logControlDiagnostic('native_fence_transition', {
      sessionId: this.sessionId,
      sandboxId: input.sandboxId,
      transition: current.success ? 'rebind' : 'bind',
      oldWrapperInstanceId: current.success ? current.data.wrapperInstanceId : null,
      oldNativeRuntimeId: current.success ? current.data.nativeRuntimeId : null,
      newWrapperInstanceId: input.wrapperInstanceId,
      newNativeRuntimeId: input.nativeRuntimeId,
      attachmentEpoch: proof.attachmentEpoch,
      operationId: authorization.data.operationId,
      authority: 'authorized_attach_result',
    });
  }

  async isSandboxCleanupScheduled(): Promise<boolean> {
    return false;
  }

  async beginWorktreeDeletion(input: {
    worktreeId: CloudAgentWorktreeId;
    kiloSessionId: string;
    ownerId: string;
    organizationId?: string;
  }): Promise<CloudAgentWorktreeLocation | null> {
    const worktreeId = cloudAgentWorktreeIdSchema.parse(input.worktreeId);
    if (this.deletedWorktreeId && this.deletedWorktreeId !== worktreeId) {
      throw new Error('Worktree identity conflict');
    }
    const raw = await this.ctx.storage.get<unknown>(METADATA_KEY);
    const metadata = raw === undefined ? null : parseSessionMetadata(raw);
    if (
      metadata &&
      (metadata.workspace?.worktreeId !== worktreeId ||
        metadata.auth.kiloSessionId !== input.kiloSessionId ||
        metadata.identity.userId !== input.ownerId ||
        metadata.identity.orgId !== input.organizationId ||
        metadata.workspace.workspacePath !==
          getWorktreeWorkspacePath(input.organizationId, input.ownerId, worktreeId))
    ) {
      throw new Error('Worktree identity conflict');
    }
    if (
      this.deletedWorktreeId === worktreeId &&
      (await this.ctx.storage.get(DELETION_COMPLETED_KEY))
    ) {
      if (this.messageCallbacks.pendingCallbackCount() > 0) this.scheduleCallbackRepair();
      return null;
    }
    this.worktreeChanges.suppress();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put(DELETED_WORKTREE_KEY, worktreeId);
      this.terminalLifecycle.beginDeletion(metadata);
      this.snapshotDeletedMessages(metadata);
    });
    if (this.messageCallbacks.pendingCallbackCount() > 0) this.scheduleCallbackRepair();
    if (this.reportOutbox.pendingCount() > 0) this.scheduleReportRepair();
    this.deletedWorktreeId = worktreeId;
    for (const socket of this.ctx.getWebSockets()) socket.close(1001, 'Worktree deleted');
    try {
      this.ctx.storage.transactionSync(() => this.worktreeChanges.purge());
    } finally {
      if (
        this.messageCallbacks.pendingCallbackCount() === 0 &&
        this.reportOutbox.pendingCount() === 0
      )
        await this.ctx.storage.deleteAlarm();
    }
    if (!metadata) return null;
    return cloudAgentWorktreeLocationSchema.parse({
      sandboxId: metadata.workspace?.sandboxId,
      provider: metadata.workspace?.sandboxProvider,
    });
  }

  async getWorktreeChildSessions(
    worktreeId: CloudAgentWorktreeId
  ): Promise<CloudAgentChildSessionLineage[]> {
    if (this.deletedWorktreeId !== worktreeId) throw new Error('Worktree deletion not started');
    await Promise.allSettled([...this.activeOperations]);
    const raw = await this.ctx.storage.get<unknown>(METADATA_KEY);
    if (raw === undefined) return [];
    const metadata = parseSessionMetadata(raw);
    if (metadata.workspace?.worktreeId !== worktreeId)
      throw new Error('Worktree identity conflict');
    const directory = this.directory(metadata);
    const rows = drizzle(this.ctx.storage)
      .select({
        id: sql<unknown>`json_extract(${events.payload}, '$.properties.info.id')`,
        parentID: sql<unknown>`json_extract(${events.payload}, '$.properties.info.parentID')`,
        directory: sql<unknown>`json_extract(${events.payload}, '$.properties.info.directory')`,
      })
      .from(events)
      .where(
        and(
          eq(events.session_id, this.requireSessionId()),
          eq(events.stream_event_type, 'kilocode'),
          inArray(sql<string>`json_extract(${events.payload}, '$.type')`, [
            'session.created',
            'session.updated',
          ])
        )
      )
      .orderBy(events.id)
      .all();
    const children = new Map<string, CloudAgentChildSessionLineage>();
    for (const row of rows) {
      const child = childSessionLineage(row, directory);
      if (!child || child.sessionId === metadata.auth.kiloSessionId) continue;
      const existing = children.get(child.sessionId);
      if (existing && existing.parentSessionId !== child.parentSessionId)
        throw new Error('worktree_child_lineage_conflict');
      children.set(child.sessionId, child);
    }
    return [...children.values()];
  }

  async finishWorktreeDeletion(worktreeId: CloudAgentWorktreeId): Promise<void> {
    if (this.deletedWorktreeId !== worktreeId) throw new Error('Worktree deletion not started');
    if (!this.deletionCompletion) {
      this.deletionCompletion = this.clearDeletedWorktree(worktreeId).catch(error => {
        this.deletionCompletion = undefined;
        throw error;
      });
    }
    await this.deletionCompletion;
  }

  private async clearDeletedWorktree(worktreeId: CloudAgentWorktreeId): Promise<void> {
    while (this.activeOperations.size > 0) {
      await Promise.allSettled([...this.activeOperations]);
    }
    await this.ingestPublicationChain.catch(() => undefined);
    if (await this.ctx.storage.get(DELETION_COMPLETED_KEY)) {
      if (this.messageCallbacks.pendingCallbackCount() > 0) this.scheduleCallbackRepair();
      return;
    }
    for (const socket of this.ctx.getWebSockets()) socket.close(1001, 'Worktree deleted');
    const callbacksPending = this.messageCallbacks.pendingCallbackCount() > 0;
    const reportsPending = this.reportOutbox.pendingCount() > 0;
    if (!callbacksPending && !reportsPending) await this.ctx.storage.deleteAlarm();
    const db = drizzle(this.ctx.storage, { logger: false });
    this.ctx.storage.transactionSync(() => {
      db.delete(events).where(eq(events.session_id, this.requireSessionId())).run();
      db.delete(commandQueue).where(eq(commandQueue.session_id, this.requireSessionId())).run();
      db.delete(executionLeases).where(isNotNull(executionLeases.execution_id)).run();
      this.terminalLifecycle.purgeDeletedState();
      this.ctx.storage.kv.put(DELETED_WORKTREE_KEY, worktreeId);
      this.ctx.storage.kv.put(DELETION_COMPLETED_KEY, true);
    });
    if (callbacksPending || reportsPending) {
      await this.armQueueRetry(
        Math.min(
          this.messageCallbacks.nextCallbackDueAt() ?? Date.now(),
          this.reportOutbox.nextDueAt() ?? Date.now()
        )
      );
    }
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.activeOperations.add(operation);
    return operation.finally(() => this.activeOperations.delete(operation));
  }

  private ensureReportAnchor(
    metadata: SessionMetadata,
    firstMessageId: string,
    isFirstMessage: boolean
  ): ReportAnchor | undefined {
    const existing = readReportAnchor(this.ctx.storage);
    if (existing) return existing;
    // Never fabricate a first message or creation time for a session that
    // already had messages; the anchor may only be written by the first admission.
    if (!isFirstMessage) return undefined;
    // Public `start` already has a reporting parent created by registration.
    if (metadata.initialMessage?.id !== undefined) return undefined;
    const kiloSessionId = metadata.auth.kiloSessionId;
    if (kiloSessionId === undefined || !/^ses_.{26}$/.test(kiloSessionId)) return undefined;
    const createdAt = Date.now();
    const anchor: ReportAnchor = {
      version: 1,
      kiloSessionId,
      initialMessageId: firstMessageId,
      createdAt,
    };
    writeReportAnchor(this.ctx.storage, {
      kiloSessionId,
      initialMessageId: firstMessageId,
      createdAt,
    });
    return anchor;
  }

  private buildMessageReport(
    message: SessionMessage,
    anchor: ReportAnchor | undefined,
    acceptanceObserved: boolean
  ): CloudAgentQueueReport | undefined {
    const sessionId = this.sessionId;
    if (!sessionId) return undefined;
    const kind = message.state.kind;
    const status: CloudAgentRunStateReport['run']['status'] =
      kind === 'cancelled' ? 'interrupted' : kind;
    // `applyMessageOutcome` fills an inferred `acceptedAt` for a terminal
    // outcome that arrived before the ACK. Only a transition out of the
    // accepted state is observable dispatch acceptance.
    const acceptedAt = acceptedAtOf(message);
    const dispatchAcceptedAt =
      acceptanceObserved && acceptedAt !== undefined ? acceptedAt : undefined;
    const queuedAt = queuedAtOf(message);
    const terminalAt = terminalAtOf(message);
    const terminalSource = terminalSourceOf(message);
    const failedReason = failedReasonOf(message);
    const assistantReason = assistantReasonOf(message);
    const providerOwnership = providerOwnershipOf(message);
    const run: CloudAgentRunStateReport['run'] = {
      messageId: message.messageId,
      status,
      ...(queuedAt === undefined ? {} : { queuedAt: new Date(queuedAt).toISOString() }),
      ...(dispatchAcceptedAt === undefined
        ? {}
        : { dispatchAcceptedAt: new Date(dispatchAcceptedAt).toISOString() }),
      ...(terminalAt === undefined ? {} : { terminalAt: new Date(terminalAt).toISOString() }),
    };
    if (status === 'failed' || status === 'interrupted') {
      const dispatchState = acceptanceObserved ? ('accepted' as const) : ('pre_dispatch' as const);
      // Coordinator failures carry a bounded cause. Wrapper outcomes and
      // operation results copy arbitrary text, so they are not treated as a
      // known coordinator cause.
      const coordinatorOriginated =
        terminalSource === undefined || terminalSource === 'coordinator';
      // A confirmed attach rejection that carries a git subtype is a workspace
      // setup failure: the runtime started and the clone/checkout failed. The
      // live proof is authoritative; only fall back to the retired slot when no
      // live proof remains, so a current subtype-less rejection never inherits
      // an older attempt's git subtype.
      const workspaceSubtype =
        coordinatorOriginated && failedReason === 'attach_exhausted'
          ? (message.proofs?.attach ?? message.proofs?.retiredAttach)?.rejectionSubtype
          : undefined;
      const classification = classifyControlPlaneRunFailure({
        reason: coordinatorOriginated ? failedReason : undefined,
        dispatchState,
        status,
        ...(workspaceSubtype === undefined ? {} : { workspaceSubtype }),
        ...(assistantReason === undefined ? {} : { assistantReason }),
        ...(providerOwnership === undefined ? {} : { providerOwnership }),
        ...(message.state.intent?.agent.model === undefined
          ? {}
          : { admittedModel: message.state.intent.agent.model }),
      });
      run.failureStage = classification.stage;
      run.failureCode = classification.code;
      if (status === 'failed') {
        run.failureResponsibility = classification.responsibility;
        run.failureReason = classification.failureReason;
        if (terminalAt !== undefined) {
          run.diagnostic = {
            errorMessageRedacted:
              FAILED_RUN_DIAGNOSTIC_MESSAGES[classification.code] ??
              'Run failed without a classified cause',
            errorExpiresAt: new Date(terminalAt + DIAGNOSTIC_RETENTION_MS).toISOString(),
          };
        }
      }
    }
    const report = buildRunStateReport({
      cloudAgentSessionId: sessionId,
      ...(anchor === undefined
        ? {}
        : {
            anchor: {
              kiloSessionId: anchor.kiloSessionId,
              initialMessageId: anchor.initialMessageId,
              reportingCreatedAt: new Date(anchor.createdAt).toISOString(),
            },
          }),
      run,
      occurredAt: Date.now(),
    });
    const parsed = CloudAgentQueueReportSchema.safeParse(report);
    if (!parsed.success) {
      logger
        .withFields({ sessionId: this.sessionId, messageId: message.messageId, status })
        .error('Invalid Cloud Agent report snapshot aborts the lifecycle commit');
      return undefined;
    }
    return parsed.data;
  }

  /**
   * Persists the local report obligation for a committed transition. This runs
   * inside the caller's state-write transaction: an unbuildable snapshot or a
   * failed KV write must abort it rather than be swallowed, so message state
   * and obligation commit atomically. Transport/downstream failures remain
   * asynchronous and nonfatal in the outbox repair path.
   */
  private recordMessageReport(message: SessionMessage, acceptanceObserved: boolean): void {
    const report = this.buildMessageReport(
      message,
      readReportAnchor(this.ctx.storage),
      acceptanceObserved
    );
    if (!report) {
      throw new Error(
        `Could not build Cloud Agent report obligation for message ${message.messageId} (${message.state.kind})`
      );
    }
    this.reportOutbox.record(report);
  }

  private snapshotDeletedMessages(metadata: SessionMetadata | null): void {
    const messages = readRawSessionMessages(this.ctx.storage.kv);
    const now = Date.now();
    const newlyTerminalMessageIds = new Set<string>();
    const cancelled = messages.map((message): SessionMessage => {
      if (message.state.kind !== 'queued' && message.state.kind !== 'accepted') return message;
      const acceptanceObserved = message.state.kind === 'accepted';
      const next: SessionMessage = {
        ...message,
        state: terminalMessageState(message.state, 'cancelled', now, 'coordinator', {}),
      };
      newlyTerminalMessageIds.add(next.messageId);
      this.recordMessageReport(next, acceptanceObserved);
      return next;
    });
    writeSessionMessages(this.ctx.storage.kv, this.sessionBinding(cancelled), cancelled);
    this.messageCallbacks.persistDrainedBatchCallback(cancelled, newlyTerminalMessageIds, metadata);
  }

  async deleteSession(): Promise<void> {
    if (this.deletedWorktreeId) throw new Error('worktree_deleting');
    this.worktreeChanges.suppress();
    const metadata = this.terminalLifecycle.getStoredMetadata();
    const records = this.ctx.storage.transactionSync(() => {
      if (this.deletedWorktreeId) throw new Error('worktree_deleting');
      const records = this.terminalLifecycle.beginDeletion(metadata);
      this.snapshotDeletedMessages(metadata);
      return records;
    });
    if (this.messageCallbacks.pendingCallbackCount() > 0) this.scheduleCallbackRepair();
    if (this.reportOutbox.pendingCount() > 0) this.scheduleReportRepair();
    for (const ws of this.ctx.getWebSockets('stream')) {
      ws.close(1000, 'session access revoked');
    }
    const errors: unknown[] = [];
    try {
      this.ctx.storage.transactionSync(() => this.worktreeChanges.purge());
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.terminalLifecycle.cleanupSession(metadata, records);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Session cleanup failed');
    await this.ingestPublicationChain.catch(() => undefined);
    if (this.deletedWorktreeId) throw new Error('worktree_deleting');
    const callbacksPending = this.messageCallbacks.pendingCallbackCount() > 0;
    const reportsPending = this.reportOutbox.pendingCount() > 0;
    if (!callbacksPending && !reportsPending) await this.ctx.storage.deleteAlarm();
    const sandboxId = metadata?.workspace?.sandboxId;
    if (sandboxId && metadata) {
      try {
        await sandboxControlRpc(this.env, sandboxId).forgetSessionReference({
          sessionId: metadata.identity.sessionId,
          kiloUserId: metadata.identity.userId,
          ...(metadata.workspace?.worktreeId ? { worktreeId: metadata.workspace.worktreeId } : {}),
          ...(metadata.identity.orgId ? { organizationId: metadata.identity.orgId } : {}),
        });
      } catch {
        // Tombstone remains; over-blocking is safe.
      }
    }
    this.ctx.storage.transactionSync(() => {
      if (this.deletedWorktreeId) throw new Error('worktree_deleting');
      this.eventQueries.deleteOlderThan(Number.MAX_SAFE_INTEGER);
      this.terminalLifecycle.purgeDeletedState();
    });
    if (callbacksPending || reportsPending)
      await this.armQueueRetry(
        Math.min(
          this.messageCallbacks.nextCallbackDueAt() ?? Date.now(),
          this.reportOutbox.nextDueAt() ?? Date.now()
        )
      );
  }

  async registerSession(input: SandboxSessionRegistrationInput): Promise<OperationResult> {
    if (this.deletedWorktreeId) return { success: false, error: 'worktree_deleting' };
    if (this.terminalLifecycle.isBlocked()) return { success: false, error: 'Session not found' };
    const initialMessage = input.message
      ? this.initialMessageFromRegistration(input.message)
      : undefined;
    const existing = this.terminalLifecycle.getStoredMetadata();
    if (existing) {
      if (
        existing.identity.userId !== input.identity.userId ||
        existing.identity.orgId !== input.identity.orgId ||
        existing.repository?.type !== input.repository?.type ||
        (existing.repository?.type === 'github' &&
          (input.repository?.type !== 'github' ||
            existing.repository.repo !== input.repository.repo ||
            existing.repository.githubIntegrationId !== input.repository.githubIntegrationId ||
            (existing.repository.githubAccessPurpose ?? 'workflow') !==
              (input.repository.githubAccessPurpose ?? 'workflow'))) ||
        (existing.repository &&
          input.repository &&
          existing.repository.type !== 'github' &&
          input.repository.type !== 'github' &&
          normalizeGitUrl(existing.repository.url) !== normalizeGitUrl(input.repository.url)) ||
        (existing.repository?.type === 'bitbucket' &&
          input.repository?.type === 'bitbucket' &&
          (existing.repository.workspaceUuid !== input.repository.workspaceUuid ||
            existing.repository.repositoryUuid !== input.repository.repositoryUuid ||
            existing.repository.bitbucketIntegrationId !== input.repository.bitbucketIntegrationId))
      )
        return {
          success: false,
          error: 'Repository authorization does not match registered session',
        };
      try {
        validateControlSessionOptions(existing);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unsupported session options',
        };
      }
      if (initialMessage && !existing.initialMessage) {
        this.ctx.storage.kv.put(
          METADATA_KEY,
          serializeSessionMetadata({ ...existing, initialMessage })
        );
      }
      return { success: true };
    }
    let runtimeAuthorization: RuntimeAuthorization | undefined;
    if (input.runtimeAuthorizationSeal) {
      const secret = await resolveSecret(this.env.NEXTAUTH_SECRET);
      if (!secret) return { success: false, error: 'Authentication unavailable' };
      let authorization: RuntimeAuthorization;
      try {
        authorization = await unsealRuntimeAuthorization(input.runtimeAuthorizationSeal, secret, {
          resourceKind: 'cloud-agent-next',
          resourceId: input.identity.sessionId,
          userId: input.identity.userId,
          organizationId: input.identity.orgId,
        });
      } catch {
        return { success: false, error: 'Invalid runtime authorization' };
      }
      if (authorization.state !== 'active')
        return { success: false, error: 'Runtime authorization revoked' };
      if (this.ctx.storage.kv.get(RUNTIME_AUTHORIZATION_KEY)) {
        return { success: false, error: 'Runtime authorization already installed' };
      }
      runtimeAuthorization = authorization;
    }
    try {
      validateControlSessionOptions(input);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unsupported session options',
      };
    }
    const repository =
      input.repository &&
      'branch' in input.repository &&
      typeof input.repository.branch === 'string'
        ? {
            ...input.repository,
            upstreamBranch: input.repository.upstreamBranch ?? input.repository.branch,
          }
        : input.repository;
    const branchName =
      input.workspace?.branchName ?? repository?.upstreamBranch ?? `kilo/${generateBranchSlug()}`;
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: input.identity,
      auth: input.auth,
      agent: input.agent,
      ...(repository ? { repository } : {}),
      ...(initialMessage ? { initialMessage } : {}),
      workspace: { ...(input.workspace ?? {}), branchName },
      ...(input.callback ? { callback: input.callback } : {}),
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.finalization ? { finalization: input.finalization } : {}),
      lifecycle: { version: 1, timestamp: Date.now() },
    });
    if (this.deletedWorktreeId) return { success: false, error: 'worktree_deleting' };
    if (this.terminalLifecycle.isBlocked()) return { success: false, error: 'Session not found' };
    if (runtimeAuthorization) {
      this.ctx.storage.kv.put(RUNTIME_AUTHORIZATION_KEY, runtimeAuthorization);
    }
    this.ctx.storage.kv.put(METADATA_KEY, serializeSessionMetadata(metadata));
    this.ctx.storage.kv.put(PENDING_INTERACTIONS_KEY, {
      revision: 0,
      questions: [],
      permissions: [],
    });
    return { success: true };
  }

  async createSessionWithInitialAdmission(
    input: SandboxSessionInitialAdmissionInput
  ): Promise<SessionMessageAdmissionResult> {
    try {
      validateControlSessionOptions(input);
    } catch (error) {
      return {
        success: false,
        code: 'BAD_REQUEST',
        error: error instanceof Error ? error.message : 'Unsupported session options',
      };
    }
    const initialTurn = input.message.initialTurn;
    const existing = await this.getMetadata();
    if (
      existing?.initialMessage &&
      !this.initialMessageMatches(existing.initialMessage, initialTurn)
    ) {
      return {
        success: false,
        code: 'BAD_REQUEST',
        error: 'Initial turn does not match registered session intent',
      };
    }
    const registered = await this.registerSession({
      ...input,
      message: {
        initialMessageId: initialTurn.messageId,
        turn:
          initialTurn.type === 'prompt'
            ? {
                type: 'prompt',
                id: initialTurn.messageId,
                prompt: initialTurn.prompt,
                ...(initialTurn.attachments ? { attachments: initialTurn.attachments } : {}),
              }
            : {
                type: 'command',
                id: initialTurn.messageId,
                command: initialTurn.command,
                arguments: initialTurn.arguments,
              },
      },
    });
    if (!registered.success) {
      return {
        success: false,
        code: registered.error === 'Session not found' ? 'NOT_FOUND' : 'INTERNAL',
        error: registered.error ?? 'register failed',
      };
    }
    return this.queueAndDispatch(
      {
        turn: initialTurn,
        agent: input.agent,
        finalization: input.finalization,
      },
      'initial'
    );
  }

  async tryUpdate(updates: { callbackTarget?: CallbackTarget | null }): Promise<OperationResult> {
    const metadata = await this.getMetadata();
    const epoch = this.terminalLifecycle.captureEpoch();
    if (!metadata || epoch === null) return { success: false, error: 'Session not found' };
    const next = {
      ...metadata,
      callback:
        updates.callbackTarget === undefined
          ? metadata.callback
          : updates.callbackTarget === null
            ? undefined
            : { target: updates.callbackTarget },
    };
    if (!this.terminalLifecycle.isCurrent(epoch)) {
      return { success: false, error: 'Session not found' };
    }
    this.ctx.storage.kv.put(METADATA_KEY, serializeSessionMetadata(next));
    return { success: true };
  }

  async getCurrentMessageWork(): Promise<{
    messageId: string;
    status: 'pending' | 'running';
    health: 'healthy' | 'stale';
  } | null> {
    const messages = this.loadMessages();
    const accepted = messages.find(message => message.state.kind === 'accepted');
    if (accepted) return { messageId: accepted.messageId, status: 'running', health: 'healthy' };
    const queued = messages.find(message => message.state.kind === 'queued');
    if (queued) return { messageId: queued.messageId, status: 'pending', health: 'healthy' };
    return null;
  }

  async hasMessageAdmission(messageId: string): Promise<boolean> {
    return this.loadMessages().some(message => message.messageId === messageId);
  }

  async admitSubmittedMessage(
    request: SubmittedSessionMessageRequest
  ): Promise<SessionMessageAdmissionResult> {
    const messageId = request.turn.id ?? createMessageId();
    if (request.turn.type === 'command' && request.turn.attachments !== undefined) {
      return {
        success: false,
        code: 'BAD_REQUEST',
        error: 'Attachments cannot be attached to slash commands',
      };
    }
    const turn: AcceptedExecutionTurn =
      request.turn.type === 'prompt'
        ? {
            type: 'prompt',
            messageId,
            prompt: request.turn.prompt,
            ...(request.turn.attachments ? { attachments: request.turn.attachments } : {}),
          }
        : {
            type: 'command',
            messageId,
            command: request.turn.command,
            arguments: request.turn.arguments,
          };
    return this.queueAndDispatch(
      { turn, agent: request.agent, finalization: request.finalization },
      'followup'
    );
  }

  async replayPreparedInitialMessage(
    request: LegacyRegisteredInitialAdmissionRequest
  ): Promise<SessionMessageAdmissionResult | undefined> {
    const metadata = await this.getMetadata();
    const messageId = metadata?.initialMessage?.id;
    if (!messageId || !(await this.hasMessageAdmission(messageId))) {
      return undefined;
    }
    return this.admitPreparedInitialMessage(request);
  }

  /**
   * Retained legacy two-step flow (prepareSession + initiateFromKilocodeSessionV2)
   * on the control plane. The registration stores the canonical initial turn in
   * metadata without admitting it; initiation resolves that stored turn and
   * admits it through the same durable queue used by `admitSubmittedMessage`,
   * mirroring `CloudAgentSession.admitPreparedInitialMessage`. Without this,
   * every code review fails with 'Prepared admission is legacy-only' whenever
   * the owner is control-plane enrolled (wrangler dev defaults it to `*`).
   */
  async admitPreparedInitialMessage(
    _request: LegacyRegisteredInitialAdmissionRequest
  ): Promise<SessionMessageAdmissionResult> {
    const metadata = await this.getMetadata();
    if (!metadata) return { success: false, code: 'NOT_FOUND', error: 'Session not found' };
    const initialMessage = metadata.initialMessage;
    if (!initialMessage?.id) {
      return { success: false, code: 'BAD_REQUEST', error: 'No prompt provided' };
    }
    const turn: AcceptedExecutionTurn | undefined =
      initialMessage.turn?.type === 'command'
        ? {
            type: 'command',
            messageId: initialMessage.id,
            command: initialMessage.turn.command,
            arguments: initialMessage.turn.arguments,
          }
        : initialMessage.turn?.type === 'prompt'
          ? {
              type: 'prompt',
              messageId: initialMessage.id,
              prompt: initialMessage.turn.prompt,
              ...(initialMessage.turn.attachments
                ? { attachments: initialMessage.turn.attachments }
                : {}),
            }
          : initialMessage.prompt
            ? {
                type: 'prompt',
                messageId: initialMessage.id,
                prompt: initialMessage.prompt,
                ...(initialMessage.attachments ? { attachments: initialMessage.attachments } : {}),
              }
            : undefined;
    if (!turn) return { success: false, code: 'BAD_REQUEST', error: 'No prompt provided' };
    return this.queueAndDispatch(
      {
        turn,
        agent: metadata.agent,
        finalization: metadata.finalization,
      },
      'initial'
    );
  }

  private async observeAcceptedOperation(
    message: MessageRecord,
    epoch: number,
    kind: 'attach' | 'prompt' = 'prompt'
  ): Promise<AcceptedOperationObservation> {
    const proof = kind === 'attach' ? message.proofs?.attach : message.proofs?.prompt;
    const authorization = sessionOperationAuthorizationSchema.safeParse(proof?.authorization);
    if (!authorization.success || !proof?.dispatched) return undefined;
    const metadata = await this.getMetadata();
    const sandboxId = metadata?.workspace?.sandboxId;
    if (!metadata || !sandboxId) throw new Error('Accepted runtime is unavailable');
    const dispatched = await dispatchSessionOperation(
      { authorization: authorization.data, payload: undefined },
      {
        read: () => this.loadMessages(),
        commit: messages => this.saveMessages(messages, epoch, 'operation_result'),
      },
      {
        request: (input, scope) => sandboxControlRpc(this.env, sandboxId, scope).request(input),
        persistResult: delivery =>
          this.applySandboxOperationResult({
            session: authorization.data.session,
            wrapperInstanceId: authorization.data.wrapperInstanceId,
            delivery,
          }),
        assertAdmission: () => {
          const current = this.loadMessages().find(item => item.messageId === message.messageId);
          const wrapper = current ? deliveryWrapperInstanceId(current) : undefined;
          if (
            this.terminalLifecycle.isCurrent(epoch) &&
            wrapper === authorization.data.wrapperInstanceId
          )
            return;
          throw new Error('Original operation scope is unavailable');
        },
        assertScope: () => {
          const current = this.loadMessages().find(item => item.messageId === message.messageId);
          const wrapper = current ? deliveryWrapperInstanceId(current) : undefined;
          if (
            this.terminalLifecycle.isCurrent(epoch) &&
            wrapper === authorization.data.wrapperInstanceId &&
            current?.proofs?.[kind]?.dispatched === true
          )
            return;
          throw new Error('Original operation scope is unavailable');
        },
        defer: pending => this.ctx.waitUntil(pending),
        isCurrent: () => false,
      }
    );
    switch (dispatched.state) {
      case 'running':
      case 'completed':
      case 'rejected':
        return dispatched.state;
      case 'uncertain':
        return dispatched.reason === 'missing' ? 'missing' : 'uncertain';
      default:
        return undefined;
    }
  }

  /**
   * Reconcile a queued head whose prompt was already dispatched on the ORIGINAL
   * authorization. This is past environment preparation: the preparation
   * deadline no longer applies, the prompt's own execution bound does, and the
   * message must not rotate, re-attach, or emit a preparation wait. A confirmed
   * rejection or an unobserved execution past its bound is terminal.
   */
  private async reconcileQueuedDispatchedPrompt(
    queued: MessageRecord,
    epoch: number
  ): Promise<void> {
    const messageId = queued.messageId;
    const prompt = queued.proofs?.prompt;
    const authorization = prompt?.authorization;
    if (!prompt?.dispatched || !authorization) return;
    const promptDeadlineAt = prompt.executionDeadlineAt ?? authorization.dispatchDeadlineAt;
    let observed: AcceptedOperationObservation;
    try {
      observed = await this.observeAcceptedOperation(queued, epoch, 'prompt');
    } catch (error) {
      logger
        .withFields({ sessionId: this.sessionId, messageId, ...deliveryErrorLogFields(error) })
        .warn('Queued prompt reconciliation failed');
      observed = undefined;
    }
    if (!this.terminalLifecycle.isCurrent(epoch)) return;
    const current = this.loadMessages().find(message => message.messageId === messageId);
    if (!current || current.state.kind !== 'queued') return;
    if (observed === 'running' || observed === 'completed') {
      // ACCEPT requires a bound aggregate. Recover the authoritative incarnation
      // from the control's canonical state instead of redispatching the prompt.
      const sandboxId = this.terminalLifecycle.getStoredMetadata()?.workspace?.sandboxId;
      const recovered = await this.recoverReconcileBinding(
        sandboxId,
        epoch,
        messageId,
        authorization
      );
      if (recovered === 'settled') return;
      if (recovered === 'bound' || recovered === 'hydrated') {
        const accepted = acceptQueuedMessage(
          this.sessionAggregate(this.loadMessages()),
          messageId,
          Date.now()
        );
        if (accepted && this.saveMessages(accepted.messages, epoch)) {
          await this.armQueueRetry(Date.now() + DEADLINE_MS.acceptedAlarmCap);
          return;
        }
      }
      // `unresolved`/`aborted`, or acceptance is still impossible: fall through
      // to the execution bound so the bounded reconciliation and its deadline
      // stay in force and the head cannot stay queued forever.
    }
    if (observed === 'rejected' || Date.now() >= promptDeadlineAt) {
      await this.failDelivery(
        messageId,
        'prompt_exhausted',
        activeWrapperInstanceId(current),
        'message'
      );
      return;
    }
    await this.armQueueRetry(Math.min(promptDeadlineAt, Date.now() + QUEUE_RETRY_MS));
  }

  /**
   * Recover the authoritative allocation incarnation for an incarnation-less
   * (pre-C3b) attachment so an accepted prompt can be bound without redispatch.
   * The resolver is asynchronous, so its outcome is revalidated against the
   * attachment and the message/proof identity before it is applied. Returns
   * `bound` when a real incarnation is already recorded.
   */
  private async recoverReconcileBinding(
    sandboxId: string | undefined,
    epoch: number,
    messageId: string,
    authorization: SessionOperationAuthorization
  ): Promise<'bound' | 'hydrated' | 'settled' | 'unresolved' | 'aborted'> {
    const initial = this.terminalLifecycle.getAttachedBinding();
    if (initial?.allocationIncarnation !== undefined) return 'bound';
    if (!initial || sandboxId === undefined) return 'unresolved';
    let resolution: Awaited<ReturnType<SandboxSession['resolveLegacyStopAttachment']>>;
    try {
      resolution = await this.resolveLegacyStopAttachment(sandboxId, initial.wrapperInstanceId);
    } catch {
      return 'unresolved';
    }
    if (!this.terminalLifecycle.isCurrent(epoch) || this.deletedWorktreeId) return 'aborted';
    const attachment = this.terminalLifecycle.getAttachedBinding();
    const sameAttachment =
      attachment?.wrapperInstanceId === initial.wrapperInstanceId &&
      attachment.allocationIncarnation === undefined;
    const messages = this.loadMessages();
    const current = messages.find(message => message.messageId === messageId);
    const stored = current?.proofs?.prompt;
    const sameProof =
      current?.state.kind === 'queued' &&
      nextQueuedMessageId(messages) === messageId &&
      stored?.dispatched === true &&
      stored.authorization !== undefined &&
      sameSessionOperation(stored.authorization, authorization);
    if (!sameAttachment || !sameProof) return 'aborted';
    if (resolution.kind === 'hydrate') {
      return this.terminalLifecycle.hydrateAttachmentIncarnation(resolution.incarnation)
        ? 'hydrated'
        : 'unresolved';
    }
    if (resolution.kind === 'settle') {
      return this.settleReconciledHead(epoch, sandboxId) ? 'settled' : 'aborted';
    }
    return 'unresolved';
  }

  /**
   * Proof-independent settlement for a head whose allocation the control no
   * longer knows about. Clears the incarnation-less attachment and persists an
   * `unbound` envelope in one transaction; a post-clear write rejection throws
   * so the clear rolls back.
   */
  private settleReconciledHead(epoch: number, sandboxId: string): boolean {
    let applied: boolean;
    try {
      applied = this.ctx.storage.transactionSync((): boolean => {
        if (!this.terminalLifecycle.isCurrent(epoch) || this.deletedWorktreeId) return false;
        const attachment = this.terminalLifecycle.getAttachedBinding();
        const settled = settleStopped({
          messages: readRawSessionMessages(this.ctx.storage.kv),
          reason: 'environment_stopped',
          now: Date.now(),
        });
        if (settled.outcome !== 'settled') return false;
        if (attachment) {
          this.terminalLifecycle.clearAttachmentForStop({
            wrapperInstanceId: attachment.wrapperInstanceId,
          });
          this.clearNativeRuntimeFenceForStop(sandboxId, attachment.wrapperInstanceId);
        }
        if (!this.saveMessagesInCurrentTransaction([...settled.messages], epoch, 'coordinator')) {
          throw new StopCommitRejectedError();
        }
        return true;
      });
    } catch (error) {
      if (error instanceof StopCommitRejectedError) return false;
      throw error;
    }
    // The commit disables immediate repair scheduling, so flush the deferred
    // callback/report repair after the transaction succeeds (as the STOPPED and
    // operation-result commit paths do).
    if (applied) this.scheduleCallbackRepairIfRequired();
    return applied;
  }

  /** True when the current queue head has already dispatched its prompt. */
  private headDispatchedPrompt(): boolean {
    const messages = this.loadMessages();
    const headId = nextQueuedMessageId(messages);
    const head = headId ? messages.find(message => message.messageId === headId) : undefined;
    return head?.proofs?.prompt?.dispatched === true;
  }

  async alarm(): Promise<void> {
    await this.messageCallbacks.repair();
    await this.reportOutbox.repair();
    const callbackDueAt = this.messageCallbacks.nextCallbackDueAt();
    const reportDueAt = this.reportOutbox.nextDueAt();
    if (callbackDueAt !== undefined || reportDueAt !== undefined)
      await this.armQueueRetry(
        Math.min(callbackDueAt ?? Number.MAX_SAFE_INTEGER, reportDueAt ?? Number.MAX_SAFE_INTEGER)
      );
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null || this.deletedWorktreeId) return;
    const now = Date.now();
    let messages = this.loadMessages();
    if (!this.terminalLifecycle.isCurrent(epoch)) return;
    // An accepted row with a cancellation marker is waiting for the wrapper abort
    // result. Settle it at the marker deadline; while the marker is live, arm at
    // the deadline and never start the healthy-accepted watchdog for that row.
    const cancellationDeadlines: number[] = [];
    let settledCancellation = false;
    for (const message of messages) {
      if (message.state.kind !== 'accepted') continue;
      const cancellation = message.cancellation;
      if (cancellation === undefined) continue;
      if (cancellation.deadlineAt > now) {
        cancellationDeadlines.push(cancellation.deadlineAt);
        continue;
      }
      const failed = failAcceptedMessage(
        this.sessionAggregate(this.loadMessages()),
        message.messageId,
        'cancellation_unconfirmed'
      );
      if (failed && this.saveMessages(failed.messages, epoch)) settledCancellation = true;
    }
    if (cancellationDeadlines.length > 0) {
      await this.armQueueRetry(Math.min(...cancellationDeadlines));
    }
    if (settledCancellation) messages = this.loadMessages();
    const accepted = messages.find(
      message => message.state.kind === 'accepted' && message.cancellation === undefined
    );
    const acceptedState = accepted?.state.kind === 'accepted' ? accepted.state : undefined;
    if (accepted && acceptedState) {
      const decision = acceptedAlarmDecision(
        acceptedState.acceptedAt,
        now,
        acceptedState.lastActivityAt
      );
      if (decision.action === 'rearm') {
        await this.armQueueRetry(decision.at);
      } else {
        const scope = this.captureInteractionScope();
        const startedAt = Date.now();
        const diagnostic: ControlDiagnosticFields = {
          sessionId: this.sessionId,
          messageId: accepted.messageId,
          expectedWrapperInstanceId: acceptedState.wrapperInstanceId,
          epoch,
          acceptedAt: acceptedState.acceptedAt,
          lastActivityAt: acceptedState.lastActivityAt,
          stage: 'sync',
        };
        const report = (result: 'healthy' | 'superseded' | 'runtime_unhealthy' | 'inactivity') =>
          logControlDiagnostic(
            'accepted_reconciliation',
            { ...diagnostic, phase: 'finished', result, durationMs: Date.now() - startedAt },
            result === 'runtime_unhealthy' ? 'warn' : 'info'
          );
        logControlDiagnostic('accepted_reconciliation', { ...diagnostic, phase: 'started' });
        try {
          let useSnapshot = true;
          if (accepted.proofs?.prompt?.dispatched) {
            useSnapshot = false;
            diagnostic.stage = 'runtime_status';
            // The proof binds the operation to its dispatched wrapper; the
            // accepted row's wrapper is the same in the normal flow but the
            // proof authorization is authoritative for a proof-backed turn.
            const readiness = await this.acceptedRuntimeReadiness(
              diagnostic,
              accepted.proofs?.prompt?.authorization?.wrapperInstanceId
            );
            if (readiness === 'blip') {
              // A not-ready socket, a non-running physical state or a wrapper
              // mismatch is not proof the turn is dead: keep the row and
              // re-check, including when a question moved the scope.
              if (!this.acceptedTurnIsDrivable(accepted.messageId)) {
                diagnostic.reason = 'accepted_message_changed';
                report('superseded');
              } else {
                diagnostic.healthy = true;
                report('healthy');
                await this.scheduleAcceptedRecheck(epoch, accepted.messageId);
              }
            } else {
              diagnostic.stage = 'operation_receipt';
              const observed = await this.observeAcceptedOperation(accepted, epoch);
              if (!this.isCurrentAcceptedMessage(accepted, epoch)) {
                diagnostic.reason = 'accepted_message_changed';
                report('superseded');
              } else if (observed === 'running' || observed === 'completed') {
                if (await this.failOverdueAcceptedMessage(accepted, epoch, diagnostic)) {
                  report('inactivity');
                  // A re-queued recovery row is not delivered again in this
                  // alarm; a reconcile or terminal failure leaves the tail for
                  // any queued follow-up.
                  const watched = this.loadMessages().find(
                    item => item.messageId === accepted.messageId
                  );
                  if (watched?.state.kind === 'queued') return;
                } else if (!this.acceptedTurnIsDrivable(accepted.messageId)) {
                  diagnostic.reason = 'accepted_message_changed';
                  report('superseded');
                } else {
                  diagnostic.healthy = true;
                  report('healthy');
                  await this.scheduleAcceptedRecheck(epoch, accepted.messageId);
                }
              } else if (observed === 'missing') {
                // Not a blip: the runtime is ready but the wrapper has no record
                // of the operation. Fall through to the snapshot path, which may
                // recover the turn on inactivity.
                useSnapshot = true;
              } else {
                // `rejected`, `uncertain` or an unobserved lookup is never proof
                // the turn is dead.
                if (this.acceptedTurnIsDrivable(accepted.messageId)) {
                  diagnostic.healthy = true;
                  report('healthy');
                  await this.scheduleAcceptedRecheck(epoch, accepted.messageId);
                } else {
                  diagnostic.reason = 'accepted_message_changed';
                  report('superseded');
                }
              }
            }
          }
          if (useSnapshot) {
            const snapshot = await this.interactionRefresh.refresh(scope, 'accepted_alarm');
            if (
              snapshot &&
              scope &&
              this.interactionRefresh.isCurrent(scope, (scope.interactionRevision ?? 0) + 1)
            ) {
              diagnostic.stage = 'activity_check';
              diagnostic.syncStatus = diagnosticSyncStatus(snapshot.status.type);
              diagnostic.questionCount = snapshot.questions.length;
              diagnostic.permissionCount = snapshot.permissions.length;
              const waiting = acceptedSnapshotKind(snapshot) === 'waiting';
              diagnostic.healthy = waiting;
              if (await this.failOverdueAcceptedMessage(accepted, epoch, diagnostic)) {
                report('inactivity');
                const watched = this.loadMessages().find(
                  item => item.messageId === accepted.messageId
                );
                if (watched?.state.kind === 'queued') return;
              } else if (!this.acceptedTurnIsDrivable(accepted.messageId)) {
                diagnostic.reason = 'accepted_message_changed';
                report('superseded');
              } else if (!waiting) {
                diagnostic.reason = 'inactive_snapshot';
                throw new Error('Accepted execution is no longer active');
              } else {
                report('healthy');
                await this.scheduleAcceptedRecheck(epoch, accepted.messageId);
              }
            } else if (!snapshot) {
              // The refresh returned no snapshot. Re-classify before keeping the
              // watchdog: a not-ready socket is a blip, a ready socket may still
              // recover the superseded sync.
              const readiness = await this.acceptedRuntimeReadiness(
                diagnostic,
                acceptedState.wrapperInstanceId
              );
              if (readiness === 'blip') {
                if (this.acceptedTurnIsDrivable(accepted.messageId)) {
                  diagnostic.healthy = true;
                  report('healthy');
                  await this.scheduleAcceptedRecheck(epoch, accepted.messageId);
                } else {
                  diagnostic.reason = 'accepted_message_changed';
                  report('superseded');
                }
              } else {
                diagnostic.reason = 'sync_superseded';
                report('superseded');
                // A pending-input event (question/permission) during the awaited
                // sync changes the interaction scope, so the sync returns
                // undefined. The accepted turn is usually still current, so the
                // watchdog must survive and may recover it.
                await this.rescheduleAcceptedWatchdog(accepted, epoch, diagnostic);
                const watched = this.loadMessages().find(
                  item => item.messageId === accepted.messageId
                );
                if (watched?.state.kind === 'queued') return;
              }
            } else {
              // A validated snapshot whose scope or revision moved on: the
              // original accepted turn may still be current.
              diagnostic.reason = 'accepted_message_changed';
              report('superseded');
              await this.rescheduleAcceptedWatchdog(accepted, epoch, diagnostic);
              const watched = this.loadMessages().find(
                item => item.messageId === accepted.messageId
              );
              if (watched?.state.kind === 'queued') return;
            }
          }
        } catch (error) {
          if (
            !this.isCurrentAcceptedMessage(accepted, epoch) ||
            !this.acceptedTurnIsDrivable(accepted.messageId)
          ) {
            diagnostic.reason = 'accepted_message_changed';
            report('superseded');
          } else if (error instanceof AcceptedRuntimeLostError) {
            // Authoritative loss: best-effort stop, then fail the row.
            diagnostic.reason ??= 'runtime_stopped';
            await this.stopWrapperTurn(accepted, epoch, diagnostic);
            if (
              this.isCurrentAcceptedMessage(accepted, epoch) &&
              this.acceptedTurnIsDrivable(accepted.messageId)
            ) {
              await this.failDelivery(
                accepted.messageId,
                'runtime_unhealthy',
                acceptedState.wrapperInstanceId
              );
              report('runtime_unhealthy');
            } else {
              diagnostic.reason = 'accepted_message_changed';
              report('superseded');
            }
          } else if (diagnostic.reason === 'inactive_snapshot') {
            report('runtime_unhealthy');
            await this.failDelivery(
              accepted.messageId,
              'runtime_unhealthy',
              acceptedState.wrapperInstanceId
            );
          } else {
            // A transport, sync or readiness failure is not proof the turn is
            // dead: keep the row and re-check.
            diagnostic.reason ??= 'sync_failed';
            diagnostic.healthy = true;
            report('healthy');
            await this.scheduleAcceptedRecheck(epoch, accepted.messageId);
          }
        }
      }
    }
    if (!this.terminalLifecycle.isCurrent(epoch)) return;
    const headId = nextQueuedMessageId(this.loadMessages());
    // A queued head is durable demand: the alarm may realize it by creating a
    // replacement once the allocation is confirmed `stopped` (Vercel has no
    // acquisition path). Cloudflare keeps its acquisition-driven create, and
    // `nextEnsureReadyStep` still refuses to create from running/stopping.
    if (headId) await this.dispatchQueued(headId, { allowCreate: true });
  }

  /**
   * Positive terminal evidence for an accepted turn that already answered over
   * the ingest channel, read from the DO's stored kilocode events. The record
   * stays `accepted` because settlement here comes from the prompt operation
   * result, so recovery must settle (not re-run) a turn whose answer already
   * arrived. Mirrors the legacy wrapper-death reconciliation.
   */
  private storedAssistantSettlement(current: MessageRecord): AcceptedStoredSettlement | undefined {
    const metadata = this.terminalLifecycle.getStoredMetadata();
    const kiloSessionId = metadata?.auth.kiloSessionId;
    if (!metadata || !kiloSessionId) return undefined;
    return projectStoredAssistantSettlement(
      this.eventQueries.getAssistantMessageForUserMessage(
        metadata.identity.sessionId,
        kiloSessionId,
        current.messageId
      )
    );
  }

  /**
   * The inactivity path. Re-reads the accepted row and re-evaluates the bound
   * synchronously before persisting, so real progress that landed during the
   * preceding observe/sync keeps the turn alive.
   *
   * The first no-output detection is recoverable: the accepted turn is
   * re-queued under its durable intent, so the alarm re-dispatches it once on a
   * replacement runtime (the wedged runtime is left to the health machine's own
   * recovery ladder). A second identical detection keeps the terminal path
   * (message-only: no quarantine and no native-runtime retirement) and records
   * the attempt count. The follow-up abort is best-effort and fenced with the
   * captured wrapper instance.
   */
  private async failOverdueAcceptedMessage(
    accepted: MessageRecord,
    epoch: number,
    diagnostic: ControlDiagnosticFields
  ): Promise<boolean> {
    const current = this.loadMessages().find(item => item.messageId === accepted.messageId);
    const currentState = current?.state.kind === 'accepted' ? current.state : undefined;
    const activityAt = currentState?.lastActivityAt ?? currentState?.acceptedAt;
    if (
      !current ||
      !currentState ||
      // A Stop admitted while this alarm awaited its observation keeps the
      // record `accepted` and only adds `cancellation`. Recovering it would
      // re-queue the turn the user just stopped.
      current.cancellation !== undefined ||
      activityAt === undefined ||
      !acceptedInactivityDue(activityAt, Date.now())
    )
      return false;
    diagnostic.stage = 'inactivity';
    diagnostic.reason = 'inactivity_due';
    diagnostic.lastActivityAt = activityAt;
    // Reconcile before recovering: settlement here normally comes from the
    // prompt operation result, so a runtime that went silent after streaming
    // its answer still leaves the record `accepted`. Re-dispatching it would run
    // the turn and its side effects a second time.
    const settlement = this.storedAssistantSettlement(current);
    if (settlement) {
      const settled = applyStoredAssistantSettlement(
        this.loadMessages(),
        current.messageId,
        settlement,
        Date.now()
      );
      if (!settled || !this.saveMessages(settled, epoch)) return false;
      diagnostic.recovery = 'reconciled';
      logControlDiagnostic('accepted_no_output_reconciled', {
        ...diagnostic,
        producer: 'accepted_inactivity',
        result: settlement.state,
      });
      return true;
    }
    const recoveryAttempts = currentState.recoveryAttempts ?? 0;
    if (noOutputRecoveryAllowed(recoveryAttempts)) {
      const next = redispatchAcceptedMessage(this.loadMessages(), current.messageId);
      if (!next || !this.saveMessages(next, epoch)) return false;
      diagnostic.recovery = 'redispatched';
      logControlDiagnostic('accepted_no_output_recovery', {
        ...diagnostic,
        producer: 'accepted_inactivity',
        recoveryAttempts: recoveryAttempts + 1,
      });
      const turn = getSessionMessageTurn(current);
      this.broadcastQueuedMessage(current.messageId, turn ? renderExecutionTurnContent(turn) : '');
      await this.armQueueRetry();
      return true;
    }
    diagnostic.attempts = recoveryAttempts + 1;
    const failed = failAcceptedMessage(
      this.sessionAggregate(this.loadMessages()),
      current.messageId,
      'accepted_overdue',
      'Turn did not complete'
    );
    if (!failed || !this.saveMessages(failed.messages, epoch)) return false;
    if (nextQueuedMessageId(failed.messages)) await this.armQueueRetry();
    return true;
  }

  /**
   * Whether the accepted turn is still the watchdog's to drive. A Stop admitted
   * during an awaited observation keeps the record `accepted` and only adds
   * `cancellation`; the stop lifecycle settles the turn from there, so the
   * watchdog must release it instead of re-arming it or failing it as a runtime
   * failure. `failOverdueAcceptedMessage` already refuses to recover such a
   * record, which is why the callers re-check here before treating "not overdue"
   * as healthy.
   */
  private acceptedTurnIsDrivable(messageId: string): boolean {
    const current = this.loadMessages().find(item => item.messageId === messageId);
    return current?.state.kind === 'accepted' && current.cancellation === undefined;
  }

  /**
   * Schedule the next non-failing check from the freshly read clock:
   * `min(now + acceptedAlarmCap, activityAt + kiloInactivity)`. The recheck is
   * always in the future: once inactivity is due, the cap alone is used.
   */
  private async scheduleAcceptedRecheck(epoch: number, messageId: string): Promise<void> {
    const current = this.loadMessages().find(item => item.messageId === messageId);
    const currentState = current?.state.kind === 'accepted' ? current.state : undefined;
    if (!this.terminalLifecycle.isCurrent(epoch) || !currentState) return;
    const now = Date.now();
    const capAt = now + DEADLINE_MS.acceptedAlarmCap;
    const activityAt = currentState.lastActivityAt ?? currentState.acceptedAt;
    if (activityAt === undefined) {
      await this.armQueueRetry(capAt);
      return;
    }
    const inactivityAt = activityAt + DEADLINE_MS.kiloInactivity;
    await this.armQueueRetry(inactivityAt > now ? Math.min(capAt, inactivityAt) : capAt);
  }

  /**
   * Keep the accepted-turn watchdog alive when the interaction scope changes
   * during an awaited health-check sync. The original turn is re-checked before
   * failing; a superseded or terminal original is left alone, and a watchdog is
   * retained for whichever accepted turn is current.
   */
  private async rescheduleAcceptedWatchdog(
    accepted: MessageRecord,
    epoch: number,
    diagnostic: ControlDiagnosticFields
  ): Promise<void> {
    if (!this.terminalLifecycle.isCurrent(epoch)) return;
    if (this.isCurrentAcceptedMessage(accepted, epoch)) {
      if (await this.failOverdueAcceptedMessage(accepted, epoch, diagnostic)) return;
      if (!this.acceptedTurnIsDrivable(accepted.messageId)) return;
      await this.scheduleAcceptedRecheck(epoch, accepted.messageId);
      return;
    }
    const current = this.loadMessages().find(
      message => message.state.kind === 'accepted' && message.cancellation === undefined
    );
    if (current) await this.scheduleAcceptedRecheck(epoch, current.messageId);
  }

  /**
   * Best-effort stop of remaining Kilo work for an accepted turn before it is
   * failed as `runtime_unhealthy` on an authoritative `stopped` observation.
   * The boolean reports whether the wrapper confirmed quiescence or runtime
   * retirement, but callers ignore it and fail the row either way.
   */
  private async stopWrapperTurn(
    accepted: MessageRecord,
    epoch: number,
    diagnostic: ControlDiagnosticFields
  ): Promise<boolean> {
    const metadata = this.terminalLifecycle.getStoredMetadata();
    const sandboxId = metadata?.workspace?.sandboxId;
    const kiloSessionId = metadata?.auth.kiloSessionId;
    const sessionId = this.sessionId;
    const wrapperInstanceId = activeWrapperInstanceId(accepted);
    if (!metadata || !sandboxId || !kiloSessionId || !sessionId || !wrapperInstanceId) return false;
    diagnostic.stage = 'stop';
    try {
      const response = await sandboxControlRpc(this.env, sandboxId).request({
        operation: 'session.abort',
        session: {
          sessionId,
          kiloSessionId,
          directory: this.directory(metadata),
        },
        payload: {
          messageId: accepted.messageId,
          cleanupDeadlineAt: Date.now() + DEADLINE_MS.stopAttempt,
        },
        expectedWrapperInstanceId: wrapperInstanceId,
      });
      if (!response.ok) return false;
      const parsed = sessionAbortResultSchema.safeParse(response.result);
      if (!parsed.success || !this.terminalLifecycle.isCurrent(epoch)) return false;
      return parsed.data.quiescent === true || parsed.data.runtimeRetired === true;
    } catch {
      return false;
    }
  }

  /**
   * The single physical-loss rule: only an observed `stopped` sandbox is
   * authoritative loss. A not-ready connection, a non-running physical state or
   * a transport failure is not and must keep the row.
   */
  private assertPhysicalNotLost(
    status: { physical: PhysicalState },
    diagnostic: ControlDiagnosticFields
  ): void {
    if (status.physical === 'stopped') {
      diagnostic.reason = 'physical_stopped';
      throw new AcceptedRuntimeLostError('Accepted runtime is stopped');
    }
  }

  /**
   * The single readiness decision for an accepted turn. A socket blip is not
   * proof the turn is dead: a not-ready connection, a non-running physical
   * state, a wrapper mismatch or a missing status is a blip. Only an observed
   * `stopped` sandbox is authoritative loss, and it throws. A thrown status read
   * propagates; the caller's catch owns rearming.
   */
  private async acceptedRuntimeReadiness(
    diagnostic: ControlDiagnosticFields,
    expectedWrapperInstanceId: string | undefined
  ): Promise<'ready' | 'blip'> {
    const metadata = this.terminalLifecycle.getStoredMetadata();
    const sandboxId = metadata?.workspace?.sandboxId;
    if (!metadata || !sandboxId) return 'blip';
    diagnostic.stage = 'runtime_status';
    const status = await withTimeout(
      sandboxControlRpc(this.env, sandboxId).getStatus(),
      SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
      'Runtime status timed out',
      () => {
        diagnostic.timedOut = true;
      }
    );
    const connection = status?.connection;
    const physical = status?.physical;
    const observedWrapperId = status?.wrapperInstanceId;
    const observedWrapper = wrapperInstanceIdSchema.safeParse(observedWrapperId);
    diagnostic.connection =
      connection === undefined
        ? 'missing'
        : ['disconnected', 'connected', 'ready'].includes(connection)
          ? connection
          : 'other';
    diagnostic.physical =
      physical === undefined
        ? 'missing'
        : ['stopped', 'creating', 'running', 'stopping', 'failed', 'unknown'].includes(physical)
          ? physical
          : 'other';
    diagnostic.observedWrapperInstanceId =
      observedWrapperId === undefined
        ? undefined
        : observedWrapper.success
          ? observedWrapper.data
          : 'invalid';
    diagnostic.wrapperMatches = observedWrapperId === expectedWrapperInstanceId;
    // Stopped is authoritative loss; classify it before the not-ready blip. A
    // missing status has no physical state to inspect and falls to the blip
    // branch below.
    if (status) this.assertPhysicalNotLost(status, diagnostic);
    if (
      status?.connection === 'ready' &&
      status?.physical === 'running' &&
      status?.wrapperInstanceId === expectedWrapperInstanceId
    )
      return 'ready';
    diagnostic.reason =
      status?.connection !== 'ready'
        ? 'connection_not_ready'
        : status?.physical !== 'running'
          ? 'physical_not_running'
          : 'wrapper_mismatch';
    return 'blip';
  }

  /**
   * Whether a runtime-scoped delivery failure would terminalize any accepted
   * row: the same filter `failDeliveryWaitingMessages` applies with
   * `includeUnassigned: false`. An omitted failure wrapper selects every active
   * row, matching that filter when its wrapper argument is undefined. The reason
   * does not affect membership — `failWaitingMessages` only stamps it on the
   * terminal row — so one nominal reason stands for every caller. The method
   * does not write.
   */
  private runtimeFailureHitsAccepted(wrapperInstanceId: string | undefined): boolean {
    const messages = this.loadMessages();
    if (!messages.some(message => message.state.kind === 'accepted')) return false;
    const { failedIds } = applyFailWaitingMessages(
      messages,
      'runtime_unhealthy',
      wrapperInstanceId,
      false
    );
    return failedIds.some(
      id => messages.find(message => message.messageId === id)?.state.kind === 'accepted'
    );
  }

  private async queueAndDispatch(
    input: ControlSessionMessageInput,
    origin: 'initial' | 'followup'
  ): Promise<SessionMessageAdmissionResult> {
    if (this.ctx.storage.kv.get<string>(RUNTIME_AUTHORIZATION_RECOVERY_KEY)) {
      return {
        success: false,
        code: 'COMPUTE_STOPPING',
        error: 'Runtime authorization recovery is in progress',
      };
    }
    const epoch = this.terminalLifecycle.captureEpoch();
    const metadata = this.terminalLifecycle.getStoredMetadata();
    if (epoch === null || !metadata || this.deletedWorktreeId) {
      return { success: false, code: 'NOT_FOUND', error: 'Session not found' };
    }
    const admissionInput = {
      ...input,
      finalization: {
        ...metadata.finalization,
        ...input.finalization,
        autoCommit: input.finalization?.autoCommit ?? metadata.finalization?.autoCommit ?? true,
      },
    };
    const messageId = input.turn.messageId;
    const messages = readRawSessionMessages(this.ctx.storage.kv);
    const existing = messages.find(message => message.messageId === messageId);
    const intent = existing
      ? undefined
      : resolveSessionMessageIntent(
          admissionInput,
          origin === 'followup' ? metadata.agent : undefined
        );
    if (!existing && !intent) {
      return { success: false, code: 'BAD_REQUEST', error: 'Session is missing a valid model' };
    }
    if (!existing) {
      try {
        validateControlSessionOptions(metadata);
      } catch (error) {
        return {
          success: false,
          code: 'BAD_REQUEST',
          error: error instanceof Error ? error.message : 'Unsupported session options',
        };
      }
    }
    let validationFailure: Extract<SessionMessageAdmissionResult, { success: false }> | undefined;
    if (intent?.turn.type === 'prompt' && origin === 'followup') {
      try {
        let validationToken = metadata.auth.kilocodeToken;
        if (
          this.ctx.storage.kv.get(RUNTIME_AUTHORIZATION_KEY) !== undefined ||
          hasModernRuntimeAuthorization(metadata)
        ) {
          try {
            validationToken = (await this.getRuntimeToken()) ?? undefined;
          } catch (error) {
            throw new TRPCError({
              code:
                error instanceof RuntimeAuthorizationExpiredError ||
                error instanceof RuntimeAuthorizationRevokedError
                  ? 'FORBIDDEN'
                  : 'SERVICE_UNAVAILABLE',
              message: 'Runtime credential unavailable for model validation',
            });
          }
          if (!validationToken)
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Runtime credential unavailable' });
          if (this.ctx.storage.kv.get(RUNTIME_AUTHORIZATION_RECOVERY_KEY)) {
            return {
              success: false,
              code: 'COMPUTE_STOPPING',
              error: 'Runtime authorization recovery is in progress',
            };
          }
        }
        await assertKiloModelAvailable({
          env: this.env,
          submittedModel: intent.agent.model,
          originalToken: validationToken,
          originalOrganizationId: metadata.identity.orgId,
          createdOnPlatform: metadata.identity.createdOnPlatform,
          procedure: 'admitSubmittedMessage',
        });
      } catch (error) {
        if (!(error instanceof TRPCError)) throw error;
        if (error.code === 'BAD_REQUEST' || error.code === 'FORBIDDEN') {
          validationFailure = { success: false, code: error.code, error: error.message };
        } else if (error.code === 'SERVICE_UNAVAILABLE') {
          validationFailure = {
            success: false,
            code: 'MODEL_VALIDATION_UNAVAILABLE',
            error: error.message,
          };
        } else {
          throw error;
        }
      }
    }
    let admitted = false;
    const result = this.ctx.storage.transactionSync((): SessionMessageAdmissionResult => {
      if (this.ctx.storage.kv.get(RUNTIME_AUTHORIZATION_RECOVERY_KEY)) {
        return {
          success: false,
          code: 'COMPUTE_STOPPING',
          error: 'Runtime authorization recovery is in progress',
        };
      }
      const latestMetadata = this.terminalLifecycle.getStoredMetadata();
      if (!this.terminalLifecycle.isCurrent(epoch) || !latestMetadata) {
        return { success: false, code: 'NOT_FOUND', error: 'Session not found' };
      }
      const latestMessages = readRawSessionMessages(this.ctx.storage.kv);
      const duplicate = latestMessages.find(message => message.messageId === messageId);
      if (duplicate) {
        const [frozen] = freezeLegacyQueuedMessages(
          [duplicate],
          latestMetadata.agent,
          latestMetadata.workspace?.worktreeId ? latestMetadata.finalization : undefined
        );
        const frozenIntent = frozen.state.intent;
        if (
          !matchesSessionMessageReplay(frozen, intent ?? input) ||
          (intent &&
            frozenIntent &&
            (intent.agent.variant !== frozenIntent.agent.variant ||
              intent.finalization?.autoCommit !== frozenIntent.finalization?.autoCommit ||
              intent.finalization?.condenseOnComplete !==
                frozenIntent.finalization?.condenseOnComplete))
        ) {
          return {
            success: false,
            code: 'BAD_REQUEST',
            error: 'Message ID conflicts with its existing intent or is already terminal',
          };
        }
        return {
          success: true,
          outcome: 'queued',
          messageId,
          compatibilityDelivery: duplicate.state.kind === 'accepted' ? 'sent' : 'queued',
        };
      }
      if (validationFailure) return validationFailure;
      if (!intent) return { success: false, code: 'NOT_FOUND', error: 'Message not found' };
      const pendingCallbackCount = this.messageCallbacks.pendingCallbackCount();
      const callbackFlow =
        latestMetadata.callback?.target !== undefined || pendingCallbackCount > 0;
      const outstandingMessages = latestMessages.filter(
        message => message.state.kind === 'queued' || message.state.kind === 'accepted'
      ).length;
      const pendingCount = callbackFlow
        ? outstandingMessages + pendingCallbackCount
        : latestMessages.filter(message => message.state.kind === 'queued').length;
      if (pendingCount >= PENDING_SESSION_MESSAGE_LIMIT) {
        return {
          success: false,
          code: 'PENDING_QUEUE_FULL',
          error: `Pending message queue is full (${PENDING_SESSION_MESSAGE_LIMIT})`,
        };
      }
      const nextMessages = freezeLegacyQueuedMessages(
        latestMessages,
        latestMetadata.agent,
        latestMetadata.workspace?.worktreeId ? latestMetadata.finalization : undefined
      );
      const created = createSessionMessageRecord(intent);
      const queuedMessage: SessionMessage = {
        ...created,
        state: { ...created.state, queuedAt: Date.now() },
      };
      nextMessages.push(queuedMessage);
      const nextMetadata =
        intent.agent.model === undefined
          ? null
          : nextMetadataAfterAdmittedAgentModel(latestMetadata, {
              model: intent.agent.model,
              variant: intent.agent.variant,
            });
      writeSessionMessages(this.ctx.storage.kv, this.sessionBinding(nextMessages), nextMessages);
      if (nextMetadata) {
        this.ctx.storage.kv.put(METADATA_KEY, serializeSessionMetadata(nextMetadata));
      }
      // Local obligation persistence is part of this transaction: a throw here
      // rolls back the message/metadata writes and fails admission.
      this.ensureReportAnchor(latestMetadata, messageId, latestMessages.length === 0);
      this.recordMessageReport(queuedMessage, false);
      admitted = true;
      return { success: true, outcome: 'queued', messageId, compatibilityDelivery: 'queued' };
    });
    if (result.success && this.terminalLifecycle.isCurrent(epoch)) {
      await this.armQueueRetry();
      if (!this.terminalLifecycle.isCurrent(epoch)) return result;
      if (admitted) this.broadcastQueuedMessage(messageId, renderExecutionTurnContent(input.turn));
      const headId = nextQueuedMessageId(this.loadMessages());
      if (headId) this.ctx.waitUntil(this.dispatchQueued(headId, { allowCreate: true }));
    }
    return result;
  }

  private dispatchQueued(messageId: string, options?: { allowCreate?: boolean }): Promise<void> {
    return this.trackOperation(this.runDispatchQueued(messageId, options));
  }

  private async runDispatchQueued(
    messageId: string,
    options?: { allowCreate?: boolean }
  ): Promise<void> {
    const current = this.dispatches.get(messageId);
    if (current) return current;
    const pending = this.deliverQueuedMessage(messageId, options);
    this.dispatches.set(messageId, pending);
    try {
      await pending;
    } finally {
      this.dispatches.delete(messageId);
    }
  }

  private async deliverQueuedMessage(
    messageId: string,
    options?: { allowCreate?: boolean }
  ): Promise<void> {
    if (this.ctx.storage.kv.get<string>(RUNTIME_AUTHORIZATION_RECOVERY_KEY)) return;
    if (this.deletedWorktreeId) return;
    const metadata = this.terminalLifecycle.getStoredMetadata();
    const epoch = this.terminalLifecycle.captureEpoch();
    const sandboxId = metadata?.workspace?.sandboxId;
    const kiloSessionId = metadata?.auth.kiloSessionId;
    const sessionId = this.sessionId;
    if (!metadata || epoch === null || !sandboxId || !kiloSessionId || !sessionId) {
      if (!this.terminalLifecycle.isBlocked()) await this.failWaitingMessages('missing_metadata');
      return;
    }
    const assigned = this.ctx.storage.transactionSync(() => {
      const messages = readRawSessionMessages(this.ctx.storage.kv);
      if (!this.terminalLifecycle.isCurrent(epoch) || nextQueuedMessageId(messages) !== messageId) {
        return undefined;
      }
      const frozen = freezeLegacyQueuedMessages(
        messages,
        metadata.agent,
        metadata.workspace?.worktreeId ? metadata.finalization : undefined
      ).map(message => {
        if (message.messageId !== messageId || message.state.kind !== 'queued') return message;
        if (message.state.deadlineAt !== null) return message;
        return {
          ...message,
          state: {
            ...message.state,
            deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS,
          },
        };
      });
      const prepared = assignPreparationAttemptId(frozen, messageId, () => crypto.randomUUID());
      if (prepared)
        writeSessionMessages(
          this.ctx.storage.kv,
          this.sessionBinding(prepared.messages),
          prepared.messages
        );
      return prepared;
    });
    if (!assigned) return;
    const queued = assigned.messages.find(message => message.messageId === messageId);
    const queuedState = queued?.state.kind === 'queued' ? queued.state : undefined;
    const deadlineAt = queuedState?.deadlineAt ?? undefined;
    if (!queued || !queuedState || deadlineAt === undefined) return;
    if (Date.now() >= deadlineAt && !queued.proofs?.prompt?.dispatched) {
      await this.awaitRuntimeReplacementOrFail({
        messageId,
        sandboxId,
        wrapperInstanceId: activeWrapperInstanceId(queued),
        scope: queuedState.deliveryRetryScope,
      });
      return;
    }
    if (queuedState.retryNotBefore !== undefined && queuedState.retryNotBefore > Date.now()) {
      await this.armQueueRetry(Math.min(deadlineAt, queuedState.retryNotBefore));
      return;
    }
    // A dispatched queue head is past environment preparation. Reconcile the
    // ORIGINAL prompt authorization against its own execution bound instead of
    // re-running acquisition/preparation, and never schedule it against the
    // (possibly expired) preparation deadline. It must not rotate.
    if (queued.proofs?.prompt?.dispatched === true) {
      await this.reconcileQueuedDispatchedPrompt(queued, epoch);
      return;
    }
    // One effective operation/acquisition identity for this delivery. A
    // finalized preparation attempt is replaced only at an environment wait and
    // only once no unreleased attach/prompt proof binds the old identity;
    // otherwise the existing operation must be reconciled first.
    let attemptId = assigned.attemptId;
    const provider = getSandboxProvider(metadata);
    let acquisition = provider === 'cloudflare' ? { id: attemptId, deadlineAt } : undefined;
    const allowCreate = acquisition === undefined && options?.allowCreate === true;
    let wrapperInstanceId = activeWrapperInstanceId(queued);
    const isCurrent = () => this.queuedMessage(messageId, epoch, wrapperInstanceId) !== undefined;
    const wait = <T>(operation: () => Promise<T>, timeoutMs?: number) =>
      withDeliveryDeadline(operation, deadlineAt, timeoutMs);
    const recordRuntime = (identity: string | undefined) => {
      const runtime = wrapperInstanceIdSchema.safeParse(identity);
      if (!runtime.success) return;
      const current = this.loadMessages().find(message => message.messageId === messageId);
      const currentState = current?.state.kind === 'queued' ? current.state : undefined;
      if (
        currentState?.wrapperInstanceId !== undefined &&
        currentState.wrapperInstanceId !== runtime.data &&
        (current?.proofs?.attach?.dispatched || current?.proofs?.prompt?.dispatched)
      )
        return;
      const saved = this.saveMessages(
        this.loadMessages().map(message =>
          message.messageId === messageId && message.state.kind === 'queued'
            ? {
                ...message,
                state: {
                  ...message.state,
                  wrapperInstanceId: runtime.data,
                  unresolvedDispatch:
                    message.state.wrapperInstanceId === runtime.data
                      ? message.state.unresolvedDispatch
                      : undefined,
                  // A different wrapper incarnation means the replacement the
                  // head was waiting on has rebound, so the deferral chain that
                  // spent the previous budget is over. The next replacement
                  // starts with a fresh budget instead of inheriting the spent
                  // one. A directory-native replacement keeps the wrapper
                  // incarnation and is reset where the native runtime is
                  // recorded instead (`recordNativeRuntime`).
                  ...(message.state.wrapperInstanceId === runtime.data
                    ? {}
                    : { replacementWaits: undefined }),
                },
              }
            : message
        ),
        epoch,
        'coordinator',
        undefined,
        () => bindControlEventReceiptIdentity(this.ctx.storage.kv, runtime.data),
        () => (isCurrent() ? 'apply' : 'epoch_changed')
      );
      if (saved === 'apply') wrapperInstanceId = runtime.data;
    };
    const dispatch = async <T>(
      kind: 'attach' | 'prompt',
      operation: () => Promise<T>
    ): Promise<T> => {
      const dispatchCurrent = this.queuedMessage(messageId, epoch, wrapperInstanceId);
      const unresolved =
        dispatchCurrent?.state.kind === 'queued'
          ? dispatchCurrent.state.unresolvedDispatch
          : undefined;
      const unresolvedPrompt =
        unresolved && this.terminalLifecycle.getAttachedWrapperInstanceId() === wrapperInstanceId;
      const recordUnresolved = (unresolvedDispatch: true | undefined) => {
        if (!isCurrent()) return;
        this.saveMessages(
          this.loadMessages().map(message =>
            message.messageId === messageId && message.state.kind === 'queued'
              ? {
                  ...message,
                  state: { ...message.state, unresolvedDispatch, deliveryRetryScope: undefined },
                }
              : message
          ),
          epoch
        );
      };
      recordUnresolved(true);
      try {
        const result = await operation();
        if (kind === 'attach' && !unresolvedPrompt) recordUnresolved(undefined);
        return result;
      } catch (error) {
        if (error instanceof ControlRequestError && !unresolved) recordUnresolved(undefined);
        throw error;
      }
    };
    const dispatchAuthorized = async (
      operation: SessionOperationAuthorization['operation'],
      payload: unknown,
      expectedConnection?: {
        providerInstanceId: string;
        connectionId: string;
        wrapperInstanceId: string;
      }
    ) => {
      if (!wrapperInstanceId) throw new Error('Wrapper identity is missing');
      const authorization: SessionOperationAuthorization = {
        operation,
        operationId: operation === 'session.attach' ? attemptId : messageId,
        messageId,
        session: { sessionId, kiloSessionId, directory: this.directory(metadata) },
        wrapperInstanceId,
        dispatchDeadlineAt: deadlineAt,
      };
      let dispatched: Awaited<ReturnType<typeof dispatchSessionOperation>>;
      try {
        dispatched = await dispatchSessionOperation(
          { authorization, payload, expectedConnection },
          {
            read: () => this.loadMessages(),
            commit: messages => this.saveMessages(messages, epoch, 'wrapper_outcome'),
          },
          {
            request: (input, scope) => sandboxControlRpc(this.env, sandboxId, scope).request(input),
            persistResult: delivery =>
              this.applySandboxOperationResult({
                session: authorization.session,
                wrapperInstanceId: authorization.wrapperInstanceId,
                delivery,
              }),
            assertAdmission: () => {
              if (!this.terminalLifecycle.isCurrent(epoch))
                throw new Error('Session operation scope changed');
              const current = this.loadMessages().find(message => message.messageId === messageId);
              if (!current || deliveryWrapperInstanceId(current) !== wrapperInstanceId)
                throw new Error('Session operation scope changed');
            },
            assertScope: () => {
              if (!this.terminalLifecycle.isCurrent(epoch))
                throw new Error('Session operation scope changed');
              const current = this.loadMessages().find(message => message.messageId === messageId);
              if (!current || deliveryWrapperInstanceId(current) !== wrapperInstanceId)
                throw new Error('Session operation scope changed');
              if (
                current.proofs?.[operation === 'session.attach' ? 'attach' : 'prompt']
                  ?.dispatched === true
              )
                return;
              if (
                operation === 'session.attach' &&
                current.proofs?.retiredAttach &&
                sameSessionOperation(current.proofs.retiredAttach.authorization, authorization)
              )
                return;
              throw new Error('Session operation scope changed');
            },
            defer: pending => this.ctx.waitUntil(pending),
            isCurrent,
          }
        );
      } catch (error) {
        if (operation === 'session.attach') {
          logControlDiagnostic('session_attach_completion', {
            sessionId: this.sessionId,
            messageId,
            attemptId: authorization.operationId,
            operationId: authorization.operationId,
            wrapperInstanceId,
            resultState: 'failed',
            ok: false,
            errorCode:
              error instanceof ControlRequestError &&
              controlErrorCodes.includes(error.code as (typeof controlErrorCodes)[number])
                ? error.code
                : 'other',
            retryable: error instanceof ControlRequestError ? error.retryable : false,
          });
        }
        throw error;
      }
      if (dispatched.state !== 'response' && dispatched.state !== 'completed') {
        if (dispatched.state === 'running' && operation === 'session.prompt') return dispatched;
        throw operationDispatchError(dispatched);
      }
      if (operation === 'session.attach') {
        const attached = sessionAttachResultSchema.parse(dispatched.result);
        logRestoreIncomplete({
          sessionId: this.sessionId,
          kiloSessionId,
          messageId,
          wrapperInstanceId,
          restore: attached.restore,
        });
        logControlDiagnostic('session_attach_completion', {
          sessionId: this.sessionId,
          messageId,
          attemptId: authorization.operationId,
          operationId: authorization.operationId,
          wrapperInstanceId,
          resultState: dispatched.state,
          ok: true,
          nativeRuntimeId: attached.nativeRuntimeId,
        });
        if (attached.nativeRuntimeId !== undefined)
          await this.recordNativeRuntime({
            sandboxId,
            wrapperInstanceId,
            nativeRuntimeId: attached.nativeRuntimeId,
            authorization,
          });
      }
      return dispatched;
    };
    await this.armQueueRetry(Math.min(deadlineAt, Date.now() + QUEUE_RETRY_MS));
    if (!isCurrent()) return;
    if (Date.now() >= deadlineAt && !queued.proofs?.prompt?.dispatched) {
      await this.awaitRuntimeReplacementOrFail({
        messageId,
        sandboxId,
        wrapperInstanceId,
        scope: queuedState.deliveryRetryScope,
      });
      return;
    }
    const intent = queuedState.intent;
    const model = dispatchedKilocodeModelId(intent?.agent.model);
    const control = sandboxControlRpc(this.env, sandboxId);
    let recorder = createPreparationProgressRecorder({
      attemptId,
      triggerMessageId: messageId,
      sessionId,
      eventQueries: this.eventQueries,
      broadcast: event => this.broadcastStoredEvent(event),
    });
    for (const event of finalizeOtherRunningAttemptsForMessage(
      this.eventQueries,
      messageId,
      attemptId,
      Date.now()
    )) {
      this.broadcastStoredEvent(event);
    }
    // Report an environment-preparation phase at the real decision point. A
    // finalized attempt cannot carry progress (`onProgress` no-ops), so mint a
    // fresh attempt first — but only when no unreleased operation proof binds
    // the old identity; otherwise the delivery must reconcile that operation
    // instead and the phase is stored as a presentation-only fallback.
    const reportPreparation = (step: string, message: string) => {
      if (!hasUnreleasedOperationProof(queued)) {
        const attempt = readPreparationAttempt(this.eventQueries, attemptId);
        if (attempt?.status === 'completed' || attempt?.status === 'failed') {
          const nextAttemptId = crypto.randomUUID();
          const replaced = replacePreparationAttemptId(
            this.loadMessages(),
            messageId,
            nextAttemptId
          );
          if (this.saveMessages(replaced, epoch)) {
            attemptId = nextAttemptId;
            if (acquisition !== undefined) acquisition = { id: attemptId, deadlineAt };
            recorder = createPreparationProgressRecorder({
              attemptId,
              triggerMessageId: messageId,
              sessionId,
              eventQueries: this.eventQueries,
              broadcast: event => this.broadcastStoredEvent(event),
            });
            for (const event of finalizeOtherRunningAttemptsForMessage(
              this.eventQueries,
              messageId,
              attemptId,
              Date.now()
            )) {
              this.broadcastStoredEvent(event);
            }
          }
        }
      }
      const attempt = readPreparationAttempt(this.eventQueries, attemptId);
      if (attempt?.status === 'completed' || attempt?.status === 'failed') {
        // The retained operation proof keeps this attempt terminal, so the
        // recorder cannot persist progress. Store the phase on the head message
        // and broadcast it; `deriveCloudStatus` reads it on reconnect.
        this.savePreparationWait(messageId, epoch, { step, message });
        return;
      }
      this.savePreparationWait(messageId, epoch, undefined, { preparingV2Follows: true });
      this.emitPreparationWait(recorder, attemptId, step, message);
    };
    if (
      !intent ||
      ((intent.turn.type === 'prompt' || intent.agent.model !== undefined) && !model)
    ) {
      const failed = failQueuedMessage(
        this.sessionAggregate(this.loadMessages()),
        messageId,
        'invalid_model'
      );
      if (!failed) return;
      if (!this.saveMessages(failed.messages, epoch)) return;
      if (!this.terminalLifecycle.isCurrent(epoch)) return;
      recorder.finalize({ status: 'failed', safeError: 'Session is missing a valid model' });
      if (nextQueuedMessageId(failed.messages)) await this.armQueueRetry();
      return;
    }
    let phase: DispatchPhase = 'preparing';
    let attachInPreparation = false;
    let credentialsPrepared = false;
    const preparationGeneration = this.worktreeChanges.beginPreparation();
    try {
      validateControlSessionOptions(metadata);
      const session = { sessionId, kiloSessionId, directory: this.directory(metadata) };
      const turn = getSessionMessageTurn(queued);
      const attachments =
        turn?.type === 'prompt'
          ? await wait(() =>
              buildSignedPromptAttachments({
                env: this.env,
                userId: metadata.identity.userId,
                sessionId,
                attachments: turn.attachments,
                createdOnPlatform: metadata.identity.createdOnPlatform,
              })
            )
          : [];
      if (!isCurrent()) return;
      const ensureReady = () => {
        credentialsPrepared = true;
        return wait(
          () =>
            control.ensureReady({
              ownerId: metadata.identity.userId,
              sessionId,
              provider,
              resources: getSandboxAllocationResources(metadata.workspace?.sandboxAllocation),
              instance: getSandboxAllocationInstance(metadata.workspace?.sandboxAllocation),
              ...(acquisition ? { acquisition } : { allowCreate }),
              ...(metadata.workspace?.worktreeId
                ? { worktreeId: metadata.workspace.worktreeId }
                : {}),
              billing: buildSandboxBillingInput(
                metadata,
                sandboxId,
                isCloudAgentContainerBillingEnabled(this.env, metadata.identity)
              ),
            }),
          DEADLINE_MS.startup
        );
      };
      // Emit the initial preparation line only once per attempt. On later
      // drains the phase-specific reason (boot/wait) is already the latest
      // detail; re-emitting this would reset it and defeat suppression.
      if (
        !this.terminalLifecycle.getAttachedWrapperInstanceId() &&
        this.latestPreparationStep(attemptId) === undefined
      ) {
        this.emitPreparationWait(recorder, attemptId, 'workspace_setup', 'Preparing environment…');
      }
      let status = await ensureReady();
      if (!isCurrent()) {
        if (!this.terminalLifecycle.isCurrent(epoch))
          await this.compensateSessionAttachment(metadata);
        return;
      }
      recordRuntime(status.wrapperInstanceId);
      const stoppingDeadline = Math.min(deadlineAt, Date.now() + DEADLINE_MS.startup);
      while (allowCreate && status.physical === 'stopping') {
        const observed = await observeControlAfterStopping(
          status,
          () => {
            if (!isCurrent()) throw new Error('Session delivery is no longer current');
            return wait(() => control.getStatus());
          },
          { retryMs: QUEUE_RETRY_MS, deadline: stoppingDeadline }
        );
        if (!isCurrent()) return;
        if (!observed) {
          // The observation slice is capped by the startup deadline so one alarm
          // cannot hold the delivery for the whole head budget, but the head's
          // own deadline may still have budget. Preserve the queued head and let
          // the normal retry observe again; fail only once that deadline is gone.
          if (Date.now() < deadlineAt) {
            await this.armQueueRetry(Math.min(deadlineAt, Date.now() + QUEUE_RETRY_MS));
            return;
          }
          await this.awaitRuntimeReplacementOrFail({ messageId, sandboxId, wrapperInstanceId });
          return;
        }
        const provision = provisionPreparingStep(observed.physical, allowCreate);
        if (provision) reportPreparation(provision.step, provision.message);
        status = await ensureReady();
        if (!isCurrent()) {
          if (!this.terminalLifecycle.isCurrent(epoch))
            await this.compensateSessionAttachment(metadata);
          return;
        }
        recordRuntime(status.wrapperInstanceId);
      }
      const boot = bootPreparingStep(status.physical, status.connection);
      if (boot) reportPreparation(boot.step, boot.message);
      const disposition = controlDispatchDisposition(status);
      if (disposition.action === 'fail') {
        // A runtime-scoped fail would terminalize an accepted sibling on this
        // wrapper. Downgrade to a message-scoped fail for the queued head only.
        if (this.runtimeFailureHitsAccepted(wrapperInstanceId)) {
          await this.failDelivery(messageId, disposition.reason, wrapperInstanceId, 'message');
        } else {
          await this.failDelivery(messageId, disposition.reason, wrapperInstanceId);
        }
        return;
      }
      if (disposition.action === 'wait') {
        // Report the current environment wait reason at the real wait decision.
        // `boot` already reported the creating/not-ready reason; stopped, failed
        // and stopping have no hint, so report why the head is waiting here.
        if (!boot) reportPreparation('workspace_setup', environmentWaitMessage(status.physical));
        await this.armQueueRetry(Math.min(deadlineAt, Date.now() + QUEUE_RETRY_MS));
        return;
      }
      if (!wrapperInstanceId) throw new Error('Wrapper identity is missing');
      const operationResults = status.operationResults === true;
      // After the dispatched-prompt early return above, the only prompt proof
      // that can remain here is an authoritative not-admitted rejection, which
      // needs no receipt capability. Only a still-live attach proof does.
      const proofBacked = queued.proofs?.attach?.dispatched === true;
      if (proofBacked && !operationResults)
        throw new ControlRequestError({
          code: 'runtime_unhealthy',
          message: 'Wrapper operation receipt capability is unavailable',
          retryable: false,
        });
      const needsPreparation =
        this.terminalLifecycle.getAttachedWrapperInstanceId() !== wrapperInstanceId;
      // An accepted row already admitted a prompt on this attached runtime, so a
      // containment-off follow-up must reuse that operation: attaching again
      // would hit `session_busy` while the operation is active and never prompt.
      const hasAcceptedSibling = hasAcceptedMessage(this.loadMessages());
      if (
        needsPreparation ||
        (status.attachment?.kilo?.containmentEnabled === false && !hasAcceptedSibling)
      ) {
        if (needsPreparation) reportPreparation('workspace_setup', 'Setting up workspace…');
        if (!status.attachment?.kilo)
          throw new Error('Contained session attachment is unavailable');
        attachInPreparation = needsPreparation;
        const attachPayload = {
          ...status.attachment,
          ...(hasModernRuntimeAuthorization(metadata)
            ? { runtimeIsolation: 'per-session' as const }
            : {}),
          ...(needsPreparation
            ? { preparation: { attemptId: recorder.attemptId, triggerMessageId: messageId } }
            : {}),
        };
        const authorization = RuntimeAuthorizationSchema.safeParse(
          this.ctx.storage.kv.get<unknown>(RUNTIME_AUTHORIZATION_KEY)
        );
        let proxyKilo: SessionAttachPayload['kilo'] | undefined;
        let proxyFence:
          | {
              providerInstanceId: string;
              connectionId: string;
              wrapperInstanceId: string;
            }
          | undefined;
        if (authorization.success && authorization.data.state === 'active') {
          const proxyBaseUrl = this.env.WORKER_URL
            ? runtimeCredentialProxyFacadeBaseUrl(this.env.WORKER_URL)
            : null;
          if (!proxyBaseUrl) throw new Error('Runtime credential proxy is unavailable');
          const handle = await wait(
            () =>
              this.issueRuntimeCredentialProxyGrant({
                wrapperRunId: '',
                wrapperGeneration: 0,
                wrapperConnectionId: '',
              }),
            SANDBOX_CONTROL_ATTACH_TIMEOUT_MS
          );
          if (!handle) throw new Error('Runtime credential proxy grant is unavailable');
          const claims = await verifyRuntimeCredentialProxyHandle(this.env, handle);
          if (!claims) throw new Error('Runtime credential proxy grant is invalid');
          const grant = runtimeProxyGrantSchema.safeParse(
            this.ctx.storage.kv.get<unknown>(RUNTIME_PROXY_GRANT_KEY)
          );
          if (!grant.success || grant.data.plane !== 'control') {
            throw new Error('Runtime credential proxy grant is unavailable');
          }
          proxyFence = {
            providerInstanceId: grant.data.providerInstanceId,
            connectionId: grant.data.connectionId,
            wrapperInstanceId: grant.data.wrapperInstanceId,
          };
          proxyKilo = {
            ...status.attachment.kilo,
            token: handle,
            targets: {
              backendBaseUrl: proxyBaseUrl,
              providerBaseUrl: proxyBaseUrl,
              sessionIngestBaseUrl: proxyBaseUrl,
            },
          };
          if (getSandboxProvider(metadata) === 'vercel') {
            await wait(() =>
              control.bindRuntimeCredentialProxyHandle({
                ownerId: metadata.identity.userId,
                sessionId,
                kiloSessionId,
                directory: session.directory,
                handle,
              })
            );
          }
        }
        phase = 'preparing';
        if (needsPreparation) {
          this.terminalLifecycle.recordAttachment({
            metadata,
            sandboxId,
            wrapperInstanceId,
            allocationIncarnation: status.allocationIncarnation,
            prepared: false,
            epoch,
          });
        }
        await wait(() =>
          control.attachSession({
            ...(metadata.workspace?.worktreeId
              ? { worktreeId: metadata.workspace.worktreeId }
              : {}),
            sessionId,
            kiloSessionId,
            directory: session.directory,
            ownerId: metadata.identity.userId,
          })
        );
        if (!isCurrent()) {
          if (!this.terminalLifecycle.isCurrent(epoch))
            await this.compensateSessionAttachment(metadata);
          return;
        }
        phase = 'attach';
        if (operationResults) {
          if (
            (
              await dispatchAuthorized(
                'session.attach',
                proxyKilo
                  ? {
                      ...attachPayload,
                      env: { ...attachPayload.env, KILOCODE_TOKEN: proxyKilo.token },
                      kilo: proxyKilo,
                    }
                  : attachPayload,
                proxyFence
              )
            ).state === 'running'
          ) {
            await this.armQueueRetry(Math.min(deadlineAt, Date.now() + QUEUE_RETRY_MS));
            return;
          }
        } else {
          const attached = await dispatch('attach', () =>
            wait(
              async () =>
                sessionAttachResultSchema.parse(
                  controlRequestResult(
                    await control.request({
                      operation: 'session.attach',
                      session,
                      expectedWrapperInstanceId: wrapperInstanceId,
                      ...(proxyFence ? { expectedConnection: proxyFence } : {}),
                      payload: proxyKilo
                        ? {
                            ...attachPayload,
                            env: { ...attachPayload.env, KILOCODE_TOKEN: proxyKilo.token },
                            kilo: proxyKilo,
                          }
                        : attachPayload,
                      timeoutMs: SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
                    })
                  )
                ),
              SANDBOX_CONTROL_ATTACH_TIMEOUT_MS
            )
          );
          logRestoreIncomplete({
            sessionId,
            kiloSessionId,
            messageId,
            wrapperInstanceId,
            restore: attached.restore,
          });
        }
        phase = 'preparing';
        if (!isCurrent()) {
          if (!this.terminalLifecycle.isCurrent(epoch))
            await this.compensateSessionAttachment(metadata);
          return;
        }
      }
      const attachedRuntime = await wait(() => control.getStatus());
      if (!isCurrent()) return;
      // An observed stop is authoritative loss even for a delivery: it throws so
      // the catch can fail a same-wrapper accepted sibling. Every other mismatch
      // is the existing retryable transport failure.
      this.assertPhysicalNotLost(attachedRuntime, { stage: 'runtime_status' });
      if (
        attachedRuntime.physical !== 'running' ||
        attachedRuntime.connection !== 'ready' ||
        attachedRuntime.wrapperInstanceId !== wrapperInstanceId
      )
        throw new Error('Wrapper changed during session attachment');
      // The environment is up and the runtime is ready to send: the environment
      // wait is over. Drop the durable fallback — and tell connected clients —
      // so a later retryable not-admitted prompt cannot resurface a stale
      // "waiting for sandbox" reason.
      this.savePreparationWait(messageId, epoch, undefined);
      this.terminalLifecycle.recordAttachment({
        metadata,
        sandboxId,
        wrapperInstanceId,
        allocationIncarnation: status.allocationIncarnation,
        epoch,
      });
      recorder.finalize({ status: 'completed' });
      this.worktreeChanges.attached(preparationGeneration, this.worktreeContext(metadata));
      phase = 'prompt';
      const promptPayload = {
        messageId,
        turn:
          intent.turn.type === 'command'
            ? {
                type: 'command' as const,
                command: intent.turn.command,
                arguments: intent.turn.arguments,
              }
            : { type: 'prompt' as const, prompt: intent.turn.prompt },
        agent: {
          mode: intent.agent.mode,
          ...(model !== undefined ? { model } : {}),
          ...(intent.agent.variant !== undefined ? { variant: intent.agent.variant } : {}),
        },
        ...(intent.finalization ? { finalization: intent.finalization } : {}),
        ...(attachments.length ? { attachments } : {}),
      };
      if (operationResults) {
        const dispatched = await dispatchAuthorized('session.prompt', promptPayload);
        if (dispatched.state === 'completed') return;
        if (dispatched.state === 'running') {
          const accepted = acceptQueuedMessage(
            this.sessionAggregate(this.loadMessages()),
            messageId,
            Date.now()
          );
          if (!accepted || !this.saveMessages(accepted.messages, epoch)) return;
          await this.armQueueRetry(Date.now() + DEADLINE_MS.acceptedAlarmCap);
          return;
        }
      } else {
        await dispatch('prompt', async () => {
          const prompt = await wait(async () =>
            controlRequestResult(
              await control.request({
                operation: 'session.prompt',
                session,
                expectedWrapperInstanceId: wrapperInstanceId,
                payload: promptPayload,
              })
            )
          );
          const result = sessionPromptResultSchema.parse(prompt);
          if (result.messageId !== messageId)
            throw new Error('Prompt response message identity mismatch');
        });
      }
      if (!isCurrent()) {
        if (!this.terminalLifecycle.isCurrent(epoch))
          await this.compensateSessionAttachment(metadata);
        return;
      }
      const accepted = acceptQueuedMessage(
        this.sessionAggregate(this.loadMessages()),
        messageId,
        Date.now()
      );
      if (!accepted) return;
      if (!this.saveMessages(accepted.messages, epoch)) return;
      await this.armQueueRetry(Date.now() + DEADLINE_MS.acceptedAlarmCap);
    } catch (error) {
      if (!isCurrent()) {
        if (
          (credentialsPrepared || phase !== 'preparing') &&
          !this.terminalLifecycle.isCurrent(epoch)
        ) {
          await this.compensateSessionAttachment(metadata);
        }
        return;
      }
      logger
        .withFields({ sessionId, messageId, phase, ...deliveryErrorLogFields(error) })
        .warn('Control-plane dispatch failed');
      if (error instanceof AcceptedRuntimeLostError) {
        // An observed stop during this delivery is authoritative loss for the
        // accepted turn on this wrapper. Same-wrapper equality on the local
        // binding, not the scope predicate: an omitted local id must not select
        // a bound sibling. With no sibling the queued head keeps today's
        // non-retryable classification below.
        const acceptedSibling = this.loadMessages().find(
          message =>
            message.state.kind === 'accepted' &&
            activeWrapperInstanceId(message) === wrapperInstanceId
        );
        if (acceptedSibling) {
          await this.stopWrapperTurn(acceptedSibling, epoch, { stage: 'stop' });
          if (
            this.isCurrentAcceptedMessage(acceptedSibling, epoch) &&
            this.acceptedTurnIsDrivable(acceptedSibling.messageId)
          ) {
            await this.failDelivery(
              acceptedSibling.messageId,
              'runtime_unhealthy',
              wrapperInstanceId
            );
          }
          return;
        }
      }
      await this.recordDeliveryFailure({
        messageId,
        epoch,
        phase,
        wrapperInstanceId,
        deadlineAt,
        error,
        attachInPreparation,
        hadAcquisition: acquisition !== undefined,
      });
    } finally {
      this.worktreeChanges.finishPreparation(preparationGeneration);
    }
  }

  private async compensateSessionAttachment(metadata: SessionMetadata): Promise<void> {
    if (this.deletedWorktreeId) return;
    try {
      await withTimeout(
        this.terminalLifecycle.cleanupSession(metadata, []),
        SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
        'Session detach timed out'
      );
    } catch {
      logger.withFields({ sessionId: this.sessionId }).warn('Control-plane session detach failed');
    }
  }

  private queuedMessage(
    messageId: string,
    epoch: number,
    wrapperInstanceId?: string
  ): MessageRecord | undefined {
    if (!this.terminalLifecycle.isCurrent(epoch)) return undefined;
    const messages = this.loadMessages();
    if (nextQueuedMessageId(messages) !== messageId) return undefined;
    const message = messages.find(item => item.messageId === messageId);
    return wrapperInstanceId === undefined ||
      (message !== undefined && activeWrapperInstanceId(message) === wrapperInstanceId)
      ? message
      : undefined;
  }

  private async recordDeliveryFailure(input: {
    messageId: string;
    epoch: number;
    phase: DispatchPhase;
    attachInPreparation: boolean;
    hadAcquisition: boolean;
    wrapperInstanceId?: string;
    deadlineAt: number;
    error: unknown;
  }): Promise<void> {
    const { messageId, epoch, phase, wrapperInstanceId, deadlineAt, error, attachInPreparation } =
      input;
    const message = this.queuedMessage(messageId, epoch, wrapperInstanceId);
    if (!message) return;
    if (input.hadAcquisition && isSandboxAcquisitionLostError(error)) {
      if (Date.now() >= deadlineAt) {
        await this.awaitRuntimeReplacementOrFail({
          messageId,
          sandboxId: this.terminalLifecycle.getStoredMetadata()?.workspace?.sandboxId,
          wrapperInstanceId,
          scope: message.state.kind === 'queued' ? message.state.deliveryRetryScope : undefined,
        });
        return;
      }
      const retryNotBefore = Math.min(deadlineAt, Date.now() + QUEUE_RETRY_MS);
      const rotated = rotateLostPreparationAttempt(this.loadMessages(), messageId, retryNotBefore);
      if (rotated) {
        if (this.saveMessages(rotated, epoch)) await this.armQueueRetry(retryNotBefore);
        return;
      }
      const boundWrapperInstanceId = activeWrapperInstanceId(message);
      if (isSandboxAcquisitionSupersededError(error) && boundWrapperInstanceId !== undefined) {
        const released = releaseUnadmittedWaitingMessages(
          this.loadMessages(),
          boundWrapperInstanceId
        );
        if (released.releasedIds.includes(messageId)) {
          if (this.saveMessages(released.messages, epoch)) await this.armQueueRetry(retryNotBefore);
          return;
        }
      }
      // Dispatched or unresolved proofs exist: fall through to the existing terminal handling.
    }
    const rejection = error instanceof ControlRequestError && error.rejectionReceived === true;
    const retryableRejection =
      rejection && error instanceof ControlRequestError && error.code !== 'runtime_unhealthy';
    const detail = confirmedControlRejectionDetail(error);
    const attachProof = message.proofs?.attach;
    const attachRejectionAlreadyCounted = attachProof?.rejectionReceived === true;
    const countAttachRejection = phase === 'attach' && rejection && !attachRejectionAlreadyCounted;
    const completedAttachFailure =
      message.proofs?.attach?.dispatched === true && message.proofs.attach.result?.ok === false;
    const retryableCompletedAttach =
      phase !== 'prompt' &&
      retryableRejection &&
      isRetryableDeliveryError(error) &&
      completedAttachFailure;
    const unresolvedDispatch =
      message.state.kind === 'queued' ? message.state.unresolvedDispatch : undefined;
    const messageRetryScope =
      phase === 'attach'
        ? (attachInPreparation && retryableRejection && !unresolvedDispatch) ||
          retryableCompletedAttach
        : retryableRejection && !unresolvedDispatch;
    // A confirmed rejection, including a non-retryable one, and an observed
    // stop keep today's computed scope. Otherwise a runtime-scoped failure that
    // would terminalize an accepted sibling is downgraded to a message-scoped
    // failure, so only the queued head fails here.
    const scope: 'message' | 'runtime' =
      rejection || error instanceof AcceptedRuntimeLostError
        ? messageRetryScope
          ? 'message'
          : 'runtime'
        : this.runtimeFailureHitsAccepted(wrapperInstanceId)
          ? 'message'
          : messageRetryScope
            ? 'message'
            : 'runtime';
    if (Date.now() >= deadlineAt) {
      await this.awaitRuntimeReplacementOrFail({
        messageId,
        sandboxId: this.terminalLifecycle.getStoredMetadata()?.workspace?.sandboxId,
        wrapperInstanceId,
        scope,
        detail,
      });
      return;
    }
    const busy = retryableRejection && error.code === 'session_busy';
    const retryNotBefore = Math.min(deadlineAt, Date.now() + QUEUE_RETRY_MS);
    const current = this.loadMessages();
    // Mark the live proof before a retryable completed attach retires it, so the
    // git subtype survives on the retained proof for the final report. Only the
    // attach phase may mark an attach proof; a prompt rejection must not stamp a
    // successfully completed attach proof, which would suppress the attach
    // failure counter on a later attempt.
    const marked =
      rejection && phase === 'attach' && attachProof
        ? markSessionOperationRejection(
            current,
            attachProof.authorization,
            error instanceof ControlRequestError ? error.subtype : undefined
          )
        : undefined;
    const nextMessages = retryableCompletedAttach
      ? releaseCompletedRetryableAttach(marked ?? current, messageId, retryNotBefore)
      : (marked ?? current);
    const updated =
      busy ||
      isUnconfirmedReachabilityFailure(error) ||
      (phase !== 'prompt' && !countAttachRejection)
        ? undefined
        : incrementDeliveryFailure(nextMessages, messageId, phase);
    const messages = (updated?.messages ?? nextMessages).map(
      (message): MessageRecord =>
        message.messageId === messageId && message.state.kind === 'queued'
          ? { ...message, state: { ...message.state, deliveryRetryScope: scope } }
          : message
    );
    if (!this.saveMessages(messages, epoch)) return;
    if (retryableCompletedAttach && !updated?.exhausted) {
      await this.armQueueRetry(retryNotBefore);
      return;
    }
    if (isRetryableDeliveryError(error) && !updated?.exhausted) {
      await this.armQueueRetry(Math.min(deadlineAt, Date.now() + QUEUE_RETRY_MS));
      return;
    }
    await this.failDelivery(
      messageId,
      phase === 'prompt'
        ? 'prompt_exhausted'
        : phase === 'attach' && rejection
          ? 'attach_exhausted'
          : 'environment_failed',
      wrapperInstanceId,
      scope,
      detail
    );
  }

  /**
   * True while the control plane still reports a runtime replacement in flight
   * for this workspace: the canonical allocation has not bound a runtime yet and
   * a replacement is being created. The probe is best-effort: an absent session
   * id or a transport failure reports "no replacement in flight", so it adds no
   * failure mode of its own and the existing terminal path runs unchanged.
   */
  private async runtimeReplacementInFlight(sandboxId: string): Promise<boolean> {
    if (this.sessionId === undefined) return false;
    try {
      const status = await sandboxControlRpc(this.env, sandboxId).getStatus({
        sessionId: this.sessionId,
      });
      return status.runtimeReplacementInFlight === true;
    } catch {
      return false;
    }
  }

  /**
   * End the deferral chain once the session binds a native runtime, so the next
   * replacement gets a full budget instead of inheriting a spent one. Keyed on
   * the native runtime identity because a directory-native replacement recreates
   * the native runtime in place inside the same wrapper incarnation, which the
   * wrapper-identity reset in `recordRuntime` cannot observe.
   */
  private clearRuntimeReplacementWaits(epoch: number): void {
    const messages = this.loadMessages();
    if (
      !messages.some(
        message => message.state.kind === 'queued' && message.state.replacementWaits !== undefined
      )
    )
      return;
    this.saveMessages(
      messages.map(message =>
        message.state.kind !== 'queued' || message.state.replacementWaits === undefined
          ? message
          : { ...message, state: { ...message.state, replacementWaits: undefined } }
      ),
      epoch
    );
  }

  /**
   * A preparation deadline that lands while the control plane reports a
   * runtime replacement in flight does not terminalize the head. It re-arms the
   * head's existing durable delivery deadline and the existing 5 s queue-retry
   * alarm, so the delivery resumes once the replacement rebinds.
   *
   * The deferral is re-validated after the probe: `runtimeReplacementInFlight`
   * is a cross-DO RPC, so another event may deliver the head while it is
   * outstanding, and `commitSavedMessages` treats an accepted row as mutable.
   * Only a still-queued head is rewritten.
   *
   * The wait is bounded: each deferral spends one unit of
   * `RUNTIME_REPLACEMENT_WAIT_LIMIT` for the current replacement cycle. A
   * replacement that never completes exhausts the budget and the existing
   * terminal path fails the head exactly as before, so a runtime that never
   * returns still reaches `preparation_timeout`. Binding a replacement runtime
   * ends the cycle and resets the budget, so a later, unrelated replacement does
   * not inherit a partially spent one.
   *
   * Every re-arm mints a fresh preparation attempt. A preparation attempt is
   * the acquisition request identity, and `SandboxControl` binds it to its
   * original deadline and rejects a changed deadline for the same id, so the
   * re-armed window must be a new acquisition rather than a mutated one. A live
   * attach proof bound the old attempt identity, so it is retired into the slot
   * a late result is matched against and the replacement attach can carry the
   * new identity.
   */
  private async awaitRuntimeReplacementOrFail(input: {
    messageId: string;
    sandboxId?: string;
    wrapperInstanceId?: string;
    scope?: 'message' | 'runtime';
    detail?: string;
  }): Promise<void> {
    // Resolve the failure scope once before either terminal call. An explicit
    // 'runtime' or 'message' passes through; an unset scope keeps the runtime
    // default unless a runtime-scoped failure would terminalize an accepted
    // sibling, in which case only the queued head may fail.
    //
    // Both calls pass the resolved scope positionally. An unset scope is passed
    // as an explicit `undefined`: that is identical to omitting it, because
    // `failDelivery`'s default then selects 'runtime', but it is required to
    // retain the trailing `detail` argument.
    const scope =
      input.scope ??
      (this.runtimeFailureHitsAccepted(input.wrapperInstanceId) ? 'message' : undefined);
    if (input.sandboxId !== undefined && (await this.runtimeReplacementInFlight(input.sandboxId))) {
      const epoch = this.terminalLifecycle.captureEpoch();
      if (epoch === null) return;
      const current = this.loadMessages().find(message => message.messageId === input.messageId);
      if (!current || current.state.kind !== 'queued') return;
      const waits = current.state.replacementWaits ?? 0;
      if (waits >= RUNTIME_REPLACEMENT_WAIT_LIMIT) {
        await this.failDelivery(
          input.messageId,
          'preparation_timeout',
          input.wrapperInstanceId,
          scope,
          input.detail
        );
        return;
      }
      const now = Date.now();
      const extended = this.loadMessages().map(message => {
        if (message.messageId !== input.messageId || message.state.kind !== 'queued')
          return message;
        const proofs = message.proofs ? { ...message.proofs } : undefined;
        if (proofs?.attach) {
          proofs.retiredAttach = retireAttachProof(proofs.attach, proofs.retiredAttach);
          delete proofs.attach;
        }
        return {
          ...message,
          ...(proofs ? { proofs } : {}),
          state: {
            ...message.state,
            preparationAttemptId: crypto.randomUUID(),
            preparationWait: undefined,
            deadlineAt: now + SESSION_DELIVERY_TIMEOUT_MS,
            replacementWaits: waits + 1,
          },
        };
      });
      if (!this.saveMessages(extended, epoch)) return;
      await this.armQueueRetry(now + QUEUE_RETRY_MS);
      return;
    }
    await this.failDelivery(
      input.messageId,
      'preparation_timeout',
      input.wrapperInstanceId,
      scope,
      input.detail
    );
  }

  private async failDelivery(
    messageId: string,
    reason: string,
    wrapperInstanceId?: string,
    scope: 'message' | 'runtime' = 'runtime',
    detail?: string
  ): Promise<void> {
    const epoch = this.terminalLifecycle.captureEpoch();
    const metadata = this.terminalLifecycle.getStoredMetadata();
    const message = this.loadMessages().find(item => item.messageId === messageId);
    const kind = message?.state.kind;
    if (
      epoch === null ||
      !metadata ||
      !message ||
      (kind !== 'queued' && kind !== 'accepted') ||
      activeWrapperInstanceId(message) !== wrapperInstanceId
    )
      return;
    if (scope === 'message') {
      const failed = failQueuedMessage(
        this.sessionAggregate(this.loadMessages()),
        messageId,
        reason,
        detail
      );
      if (!failed || !this.saveMessages(failed.messages, epoch)) return;
      if (nextQueuedMessageId(failed.messages)) await this.armQueueRetry();
      return;
    }
    await this.failDeliveryWaitingMessages(reason, wrapperInstanceId, detail, messageId);
  }

  async failWaitingMessages(
    reason: string,
    wrapperInstanceId?: string,
    nativeRuntimeId?: string
  ): Promise<void> {
    if (nativeRuntimeId !== undefined) {
      const current = nativeRuntimeFenceSchema.safeParse(
        this.ctx.storage.kv.get<unknown>(NATIVE_RUNTIME_FENCE_KEY)
      );
      if (
        !current.success ||
        current.data.nativeRuntimeId !== nativeRuntimeId ||
        current.data.wrapperInstanceId !== wrapperInstanceId
      )
        return;
    }
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return;
    if (!this.terminalLifecycle.isCurrent(epoch)) return;
    if (!isRecoverableRuntimeInvalidation(reason)) {
      await this.failClosedWaitingMessages(reason, wrapperInstanceId, epoch);
      return;
    }
    await this.settleRecoverableRuntimeInvalidation({
      reason,
      wrapperInstanceId,
      epoch,
      releaseDispatchedAttach: nativeRuntimeId !== undefined,
    });
  }

  /**
   * Fail-closed path for reasons with no legal create step (`missing_metadata`,
   * `provider_unknown`): release any definitively unadmitted work, then fail the
   * waiting queue as before.
   */
  private async failClosedWaitingMessages(
    reason: string,
    wrapperInstanceId: string | undefined,
    epoch: number
  ): Promise<void> {
    if (!this.terminalLifecycle.isCurrent(epoch)) return;
    let before = this.loadMessages();
    let released = false;
    if (wrapperInstanceId) {
      const result = releaseUnadmittedWaitingMessages(before, wrapperInstanceId);
      if (result.releasedIds.length > 0) {
        before = result.messages;
        released = true;
      }
    }
    const { messages, failedIds } = applyFailWaitingMessages(
      before,
      reason,
      wrapperInstanceId,
      false
    );
    if (failedIds.length === 0 && !released) return;
    if (!this.saveMessages(messages, epoch)) return;
    if (nextQueuedMessageId(this.loadMessages())) await this.armQueueRetry();
  }

  /**
   * Recoverable runtime invalidation: preserve queued work that has not been
   * dispatched to the agent. Never-dispatched and completed-attach-pre-prompt
   * rows are released (keeping their deadline and retiring an obsolete attach
   * proof); only accepted rows, dispatched-prompt rows, and the confirmed head
   * are terminalized.
   */
  private async settleRecoverableRuntimeInvalidation(input: {
    reason: string;
    wrapperInstanceId?: string;
    releaseDispatchedAttach?: boolean;
    epoch: number;
  }): Promise<void> {
    const { reason, wrapperInstanceId, releaseDispatchedAttach, epoch } = input;
    if (!this.terminalLifecycle.isCurrent(epoch)) return;
    let before = this.loadMessages();
    let released = false;
    if (wrapperInstanceId) {
      const result = releaseUnadmittedWaitingMessages(
        before,
        wrapperInstanceId,
        releaseDispatchedAttach ? { releaseDispatchedAttach: true } : undefined
      );
      if (result.releasedIds.length > 0) {
        before = result.messages;
        released = true;
      }
    }
    const failedIds: string[] = [];
    const now = Date.now();
    const messages = before.map((message): SessionMessage => {
      const kind = message.state.kind;
      if (kind !== 'queued' && kind !== 'accepted') return message;
      if (
        wrapperInstanceId !== undefined &&
        activeWrapperInstanceId(message) !== wrapperInstanceId
      ) {
        return message;
      }
      const prompt = message.proofs?.prompt;
      const confirmed =
        kind === 'accepted' || (prompt !== undefined && prompt.dispatched !== false);
      if (!confirmed) return message;
      failedIds.push(message.messageId);
      return terminalizeWaitingMessage(message, reason, now);
    });
    if (failedIds.length === 0 && !released) return;
    if (!this.saveMessages(messages, epoch)) return;
    if (nextQueuedMessageId(this.loadMessages())) await this.armQueueRetry();
  }

  private async failDeliveryWaitingMessages(
    reason: string,
    wrapperInstanceId?: string,
    detail?: string,
    detailMessageId?: string
  ): Promise<void> {
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return;
    const before = this.loadMessages();
    if (!this.terminalLifecycle.isCurrent(epoch)) return;
    const { messages, failedIds } = applyFailWaitingMessages(
      before,
      reason,
      wrapperInstanceId,
      false
    );
    const messagesWithDetail =
      detail && detailMessageId
        ? messages.map((message): SessionMessage => {
            if (
              message.messageId !== detailMessageId ||
              message.state.kind !== 'failed' ||
              !failedIds.includes(message.messageId)
            )
              return message;
            return { ...message, state: { ...message.state, detail } };
          })
        : messages;
    if (failedIds.length === 0 || !this.saveMessages(messagesWithDetail, epoch)) return;
    if (nextQueuedMessageId(this.loadMessages())) await this.armQueueRetry();
  }

  private broadcastStoredEvent(event: StoredEvent): void {
    if (this.terminalLifecycle.captureEpoch() === null) return;
    const sessionId = this.requireSessionId();
    createStreamHandler(this.ctx, this.eventQueries, sessionId).broadcastEvent(event);
  }

  private scheduleCallbackRepair(): void {
    this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now()));
    this.ctx.waitUntil(this.messageCallbacks.repair());
  }

  private scheduleReportRepair(): void {
    this.ctx.waitUntil(this.armQueueRetry());
    this.ctx.waitUntil(this.reportOutbox.repair());
  }

  private scheduleCallbackRepairIfRequired(): void {
    if (this.callbackRepairRequired) {
      this.callbackRepairRequired = false;
      this.scheduleCallbackRepair();
    }
    if (this.reportRepairRequired) {
      this.reportRepairRequired = false;
      this.scheduleReportRepair();
    }
  }

  private armPreservedQueue(): void {
    if (nextQueuedMessageId(this.loadMessages()) === undefined) return;
    this.ctx.waitUntil(this.armQueueRetry());
  }

  private async armQueueRetry(when = Date.now() + QUEUE_RETRY_MS): Promise<void> {
    const epoch = this.terminalLifecycle.captureEpoch();
    const callbackDueAt = this.messageCallbacks.nextCallbackDueAt();
    const reportDueAt = this.reportOutbox.nextDueAt();
    const hasPendingCallbacks = callbackDueAt !== undefined;
    const hasPendingReports = reportDueAt !== undefined;
    if (epoch === null && !hasPendingCallbacks && !hasPendingReports) return;
    const existing = await this.ctx.storage.getAlarm();
    if (
      (epoch === null || !this.terminalLifecycle.isCurrent(epoch)) &&
      !hasPendingCallbacks &&
      !hasPendingReports
    )
      return;
    const requested = Math.min(when, callbackDueAt ?? Number.MAX_SAFE_INTEGER);
    if (existing === null || existing > requested) await this.ctx.storage.setAlarm(requested);
  }

  private readPendingInteractions(): PendingInteractions | undefined {
    const parsed = pendingInteractionsSchema.safeParse(
      this.ctx.storage.kv.get<unknown>(PENDING_INTERACTIONS_KEY)
    );
    return parsed.success ? parsed.data : undefined;
  }

  private controlEventReceipt(input: {
    receiptId?: string;
    receiptHash?: string;
    sequence?: number;
    wrapperInstanceId?: string;
  }): ControlEventReceiptDisposition {
    return controlEventReceiptDisposition(this.ctx.storage.kv, input);
  }

  private nativeAttachmentEventDisposition(
    identity: SessionEventIdentity,
    wrapperInstanceId?: string,
    triggeringMessage?: SessionMessage
  ): 'pending' | 'rejected' | undefined {
    if (identity.nativeRuntimeId === undefined) return undefined;
    const messages = triggeringMessage ? undefined : this.loadMessages();
    const message =
      triggeringMessage ?? messages?.find(item => item.messageId === nextQueuedMessageId(messages));
    const proof = message?.proofs?.attach;
    const messageWrapper = message !== undefined ? activeWrapperInstanceId(message) : undefined;
    if (
      !proof?.dispatched ||
      message?.cancellation !== undefined ||
      messageWrapper !== wrapperInstanceId ||
      proof.authorization.wrapperInstanceId !== wrapperInstanceId ||
      proof.authorization.session.sessionId !== this.sessionId ||
      proof.authorization.session.directory !== identity.directory ||
      proof.authorization.session.kiloSessionId !==
        (identity.rootKiloSessionId ?? identity.kiloSessionId)
    )
      return undefined;
    const current = nativeRuntimeFenceSchema.safeParse(
      this.ctx.storage.kv.get<unknown>(NATIVE_RUNTIME_FENCE_KEY)
    );
    if (current.success && sameSessionOperation(current.data.authorization, proof.authorization))
      return undefined;
    if (proof.result) {
      if (!proof.result.ok) return 'rejected';
      const attached = sessionAttachResultSchema.safeParse(proof.result.result);
      if (!attached.success || attached.data.nativeRuntimeId !== identity.nativeRuntimeId)
        return 'rejected';
    }
    return Date.now() < sessionOperationExpiresAt(proof.authorization) ? 'pending' : 'rejected';
  }

  private isCurrentNativeEventRuntime(
    identity: SessionEventIdentity,
    wrapperInstanceId?: string
  ): boolean {
    if (identity.nativeRuntimeId === undefined) return true;
    const current = nativeRuntimeFenceSchema.safeParse(
      this.ctx.storage.kv.get<unknown>(NATIVE_RUNTIME_FENCE_KEY)
    );
    return (
      current.success &&
      current.data.wrapperInstanceId === wrapperInstanceId &&
      current.data.nativeRuntimeId === identity.nativeRuntimeId
    );
  }

  private controlEventDiagnosticSnapshot(input: {
    identity: SessionEventIdentity;
    wrapperInstanceId?: string;
  }): ControlDiagnosticFields {
    const messages = this.loadMessages();
    const currentWrapper =
      messages.find(message => message.state.kind === 'accepted') ??
      messages.find(message => message.state.kind === 'queued');
    const lastWithWrapper = messages.findLast(
      message => deliveryWrapperInstanceId(message) !== undefined
    );
    const expectedWrapperInstanceId =
      (currentWrapper ? activeWrapperInstanceId(currentWrapper) : undefined) ??
      (lastWithWrapper ? deliveryWrapperInstanceId(lastWithWrapper) : undefined);
    const fence = nativeRuntimeFenceSchema.safeParse(
      this.ctx.storage.kv.get<unknown>(NATIVE_RUNTIME_FENCE_KEY)
    );
    return {
      expectedWrapperInstanceId,
      fencePresent: fence.success,
      fenceWrapperInstanceId: fence.success ? fence.data.wrapperInstanceId : undefined,
      nativeRuntimeId: input.identity.nativeRuntimeId,
      fenceNativeRuntimeId: fence.success ? fence.data.nativeRuntimeId : undefined,
    };
  }

  private evaluateControlEvent(request: ControlEventEvaluationRequest): ControlEventDisposition {
    const { input, epoch } = request;
    if (!this.terminalLifecycle.isCurrent(epoch)) return 'epoch_changed';
    if (request.contract === 'currency_recheck') {
      if (!this.isCurrentEventRuntime(input.wrapperInstanceId)) return 'runtime_mismatch';
      return this.isCurrentNativeEventRuntime(input.identity, input.wrapperInstanceId)
        ? 'apply'
        : 'native_runtime_mismatch';
    }
    if (
      request.publication.kind === 'event' &&
      input.receiptId === undefined &&
      input.receiptHash === undefined &&
      input.sequence === undefined
    ) {
      return this.isCurrentNativeEventRuntime(input.identity, input.wrapperInstanceId)
        ? 'apply'
        : 'native_runtime_mismatch';
    }
    if (!this.isCurrentEventRuntime(input.wrapperInstanceId)) return 'runtime_mismatch';
    const receipt = this.controlEventReceipt(input);
    if (receipt === 'duplicate') return 'duplicate';
    if (receipt !== 'apply') return 'receipt_conflict';
    const trigger =
      request.publication.kind === 'preparing' ? request.publication.loadTrigger() : undefined;
    if (request.publication.kind === 'preparing' && !trigger) return 'native_runtime_mismatch';
    const attachment = this.nativeAttachmentEventDisposition(
      input.identity,
      input.wrapperInstanceId,
      trigger
    );
    if (attachment === 'rejected') return 'native_runtime_mismatch';
    if (attachment === 'pending') return 'native_runtime_pending';
    return this.isCurrentNativeEventRuntime(input.identity, input.wrapperInstanceId)
      ? 'apply'
      : 'native_runtime_mismatch';
  }

  private commitControlEventReceipt(
    input: ControlEventInput,
    epoch: number
  ): ControlEventDisposition {
    return this.ctx.storage.transactionSync(() => {
      const currency = this.evaluateControlEvent({ contract: 'currency_recheck', input, epoch });
      if (currency !== 'apply') return currency;
      const receipt = this.controlEventReceipt(input);
      if (receipt === 'duplicate') return 'duplicate';
      if (receipt !== 'apply') return 'receipt_conflict';
      this.recordControlEventReceipt(input);
      return 'apply';
    });
  }

  private recordControlEventReceipt(input: {
    receiptId?: string;
    receiptHash?: string;
    sequence?: number;
    wrapperInstanceId?: string;
  }): void {
    recordControlEventReceipt(this.ctx.storage.kv, input);
  }

  private recordPendingInteraction(payload: {
    type: string;
    properties: Record<string, unknown>;
  }): void {
    if (this.terminalLifecycle.captureEpoch() === null) return;
    const next = applyPendingInteractionEvent(this.readPendingInteractions(), payload);
    if (next) this.ctx.storage.kv.put(PENDING_INTERACTIONS_KEY, next);
  }

  private isCurrentAcceptedMessage(message: MessageRecord, epoch: number): boolean {
    if (!this.terminalLifecycle.isCurrent(epoch)) return false;
    const current = this.loadMessages().find(item => item.messageId === message.messageId);
    const currentState = current?.state.kind === 'accepted' ? current.state : undefined;
    return (
      currentState !== undefined &&
      currentState.wrapperInstanceId === activeWrapperInstanceId(message)
    );
  }

  private captureInteractionScope(): InteractionRefreshScope | undefined {
    const epoch = this.terminalLifecycle.captureEpoch();
    const message = this.loadMessages().find(item => item.state.kind === 'accepted');
    if (epoch === null || !message) return undefined;
    const metadata = this.terminalLifecycle.getStoredMetadata();
    return {
      message,
      epoch,
      interactionRevision: this.readPendingInteractions()?.revision,
      sessionId: metadata?.identity.sessionId,
      sandboxId: metadata?.workspace?.sandboxId,
      kiloSessionId: metadata?.auth.kiloSessionId,
      directory: metadata ? this.directory(metadata) : undefined,
      worktreeId: metadata?.workspace?.worktreeId,
    };
  }

  private async syncAcceptedMessage(
    scope: InteractionRefreshScope,
    trigger: 'accepted_alarm' | 'pending_interactions'
  ): Promise<SessionSyncResult | undefined> {
    const {
      message,
      epoch,
      sessionId,
      sandboxId,
      kiloSessionId,
      directory,
      interactionRevision: revision,
    } = scope;
    const messageWrapperInstanceId = activeWrapperInstanceId(message);
    const startedAt = Date.now();
    const diagnostic: ControlDiagnosticFields = {
      sessionId: this.sessionId,
      messageId: message.messageId,
      expectedWrapperInstanceId: messageWrapperInstanceId,
      epoch,
      trigger,
      stage: 'runtime_context',
      timeoutMs: SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
      timedOut: false,
    };
    let outcome: 'synced' | 'superseded' | 'failed' = 'failed';
    logControlDiagnostic('session_sync', { ...diagnostic, phase: 'started' });
    try {
      diagnostic.sandboxId = sandboxId;
      diagnostic.kiloSessionId = kiloSessionId;
      diagnostic.worktreeId = scope.worktreeId;
      if (!sessionId || !directory || !sandboxId || !kiloSessionId || !messageWrapperInstanceId) {
        diagnostic.reason =
          !sessionId || !directory
            ? 'missing_metadata'
            : !sandboxId
              ? 'missing_sandbox'
              : !kiloSessionId
                ? 'missing_kilo_session'
                : 'missing_wrapper_identity';
        throw new Error('Accepted runtime is unavailable');
      }
      const control = sandboxControlRpc(this.env, sandboxId);
      // The readiness decision is taken before any scope-change return: a blip
      // must throw so a revision move cannot turn it back into a superseded
      // `undefined`. A ready status that then fails the scope check is the one
      // superseded return that has no frame yet.
      const readiness = await this.acceptedRuntimeReadiness(diagnostic, messageWrapperInstanceId);
      if (readiness === 'blip') {
        throw new Error('Accepted runtime is not ready');
      }
      if (!this.interactionRefresh.isCurrent(scope)) {
        outcome = 'superseded';
        diagnostic.reason = 'observation_scope_changed';
        return undefined;
      }
      diagnostic.interactionRevision = revision;
      diagnostic.stage = 'sync_request';
      const response = await withTimeout(
        control.request({
          operation: 'session.sync',
          expectedWrapperInstanceId: messageWrapperInstanceId,
          session: { sessionId, kiloSessionId, directory },
          payload: {},
        }),
        SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
        'Session sync timed out',
        () => {
          diagnostic.timedOut = true;
        }
      );
      // Examine and validate the returned frame before any post-request
      // superseded return: a resolved `{ ok: false }` is a failure, not a blip,
      // and must never become a superseded `undefined`.
      diagnostic.requestId = response?.requestId;
      diagnostic.responseOk = typeof response?.ok === 'boolean' ? response.ok : undefined;
      if (!response?.ok) {
        diagnostic.reason = 'sync_rejected';
        const errorCode = response?.error?.code;
        diagnostic.errorCode = controlErrorCodes.some(code => code === errorCode)
          ? errorCode
          : 'other';
        diagnostic.retryable =
          typeof response?.error?.retryable === 'boolean' ? response.error.retryable : undefined;
        throw new Error('Session sync failed');
      }
      diagnostic.stage = 'validate_sync_result';
      const parsed = sessionSyncResultSchema.parse(response.result);
      diagnostic.syncStatus = diagnosticSyncStatus(parsed.status.type);
      diagnostic.receivedQuestionCount = parsed.questions.length;
      diagnostic.receivedPermissionCount = parsed.permissions.length;
      const belongsToRoot = (request: unknown): boolean => {
        if (
          typeof request !== 'object' ||
          request === null ||
          Array.isArray(request) ||
          !('id' in request) ||
          typeof request.id !== 'string' ||
          request.id.length === 0 ||
          !('sessionID' in request) ||
          typeof request.sessionID !== 'string' ||
          request.sessionID.length === 0
        )
          return false;
        const root = 'rootKiloSessionId' in request ? request.rootKiloSessionId : undefined;
        return root === undefined ? request.sessionID === kiloSessionId : root === kiloSessionId;
      };
      diagnostic.stage = 'scope_interactions';
      const result = scope.worktreeId
        ? {
            ...parsed,
            questions: parsed.questions.filter(belongsToRoot),
            permissions: parsed.permissions.filter(belongsToRoot),
          }
        : parsed;
      diagnostic.questionCount = result.questions.length;
      diagnostic.permissionCount = result.permissions.length;
      diagnostic.stage = 'interaction_revision';
      const previousInteractions = this.readPendingInteractions();
      const currentRevision = previousInteractions?.revision;
      const applySnapshot = currentRevision === revision;
      diagnostic.interactionSnapshotApplied = false;
      if (!applySnapshot) {
        diagnostic.reason = 'interaction_revision_changed';
        outcome = 'superseded';
        return undefined;
      }
      if (!this.interactionRefresh.isCurrent(scope)) {
        diagnostic.reason = 'observation_scope_changed';
        outcome = 'superseded';
        return undefined;
      }
      diagnostic.stage = 'persist_interactions';
      this.ctx.storage.kv.put(PENDING_INTERACTIONS_KEY, {
        revision: (currentRevision ?? 0) + 1,
        questions: result.questions,
        permissions: result.permissions,
      });
      diagnostic.interactionSnapshotApplied = true;
      diagnostic.stage = 'persist_status';
      persistSandboxControlSessionEvent({
        sessionId,
        payload: {
          type: 'session.status',
          properties: { sessionID: kiloSessionId, status: result.status },
        },
        eventQueries: this.eventQueries,
        broadcast: event => this.broadcastStoredEvent(event),
      });
      for (const event of pendingInputProjection(
        sessionId,
        previousInteractions,
        result,
        Date.now()
      )) {
        this.broadcastStoredEvent(event);
      }
      outcome = 'synced';
      return result;
    } catch (error) {
      // A revision move must not hide a throw: the sync failure has to reach the
      // alarm so it rechecks instead of recording a superseded `undefined`.
      diagnostic.reason ??= diagnostic.timedOut
        ? 'timeout'
        : error instanceof z.ZodError
          ? 'invalid_response'
          : 'operation_failed';
      diagnostic.errorClass =
        error instanceof z.ZodError
          ? 'validation_error'
          : error instanceof TypeError
            ? 'type_error'
            : error instanceof Error
              ? 'error'
              : 'non_error';
      if (error instanceof z.ZodError) {
        diagnostic.validationIssueCount = error.issues.length;
        diagnostic.invalidStatus = error.issues.some(issue => issue.path[0] === 'status');
        diagnostic.invalidQuestions = error.issues.some(issue => issue.path[0] === 'questions');
        diagnostic.invalidPermissions = error.issues.some(issue => issue.path[0] === 'permissions');
      }
      throw error;
    } finally {
      logControlDiagnostic(
        'session_sync',
        { ...diagnostic, phase: 'finished', result: outcome, durationMs: Date.now() - startedAt },
        outcome === 'failed' ? 'warn' : 'info'
      );
    }
  }

  private derivePendingInteractions():
    | { questions: unknown[]; permissions: unknown[] }
    | undefined {
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return undefined;
    if (!this.terminalLifecycle.isCurrent(epoch)) return undefined;
    this.interactionRefresh.scheduleRefresh();
    const snapshot = this.readPendingInteractions();
    return snapshot
      ? { questions: snapshot.questions, permissions: snapshot.permissions }
      : undefined;
  }

  private async deriveQueuedMessages() {
    return streamQueuedSnapshots(this.loadMessages(), Date.now());
  }

  private async deriveCloudStatus() {
    const messages = this.loadMessages();
    const status = streamCloudStatus(messages);
    if (status?.type !== 'preparing') return status;
    const headId = nextQueuedMessageId(messages);
    const head = headId ? messages.find(message => message.messageId === headId) : undefined;
    const headState = head?.state.kind === 'queued' ? head.state : undefined;
    const attemptId = headState?.preparationAttemptId;
    if (attemptId) {
      const attempt = readPreparationAttempt(this.eventQueries, attemptId);
      if (attempt?.status === 'running') {
        const step = this.latestPreparationStep(attemptId);
        return {
          type: 'preparing' as const,
          ...(step?.key ? { step: step.key } : {}),
          ...(step?.latestDetail ? { message: step.latestDetail } : {}),
        };
      }
    }
    // A finalized attempt bound to a retained operation proof cannot carry
    // progress; `reportWait` stores the current reason on the head instead so
    // reconnect still sees it.
    const wait = headState?.preparationWait;
    if (wait) return { type: 'preparing' as const, step: wait.step, message: wait.message };
    return status;
  }

  /**
   * Persist the current wait reason for a head whose attempt cannot receive
   * progress, and tell already-connected clients. Only a real change writes or
   * broadcasts, so unchanged 5 s alarms stay silent. Clearing the field ends
   * the environment wait; unless a `preparing` v2 event is about to follow, a
   * `cloud.status` `ready` drops the fallback copy on connected clients.
   * `deriveCloudStatus` stays the reconnect path.
   */
  private savePreparationWait(
    messageId: string,
    epoch: number,
    wait: { step: string; message: string } | undefined,
    options?: { preparingV2Follows?: boolean }
  ): void {
    const messages = this.loadMessages();
    const head = messages.find(message => message.messageId === messageId);
    const headState = head?.state.kind === 'queued' ? head.state : undefined;
    if (!headState) return;
    const current = headState.preparationWait;
    if (wait === undefined) {
      if (current === undefined) return;
      const cleared = this.saveMessages(
        messages.map(message =>
          message.messageId === messageId && message.state.kind === 'queued'
            ? { ...message, state: { ...message.state, preparationWait: undefined } }
            : message
        ),
        epoch
      );
      if (cleared && options?.preparingV2Follows !== true)
        this.broadcastCloudStatus({ type: 'ready' });
      return;
    }
    if (current !== undefined && current.step === wait.step && current.message === wait.message)
      return;
    const saved = this.saveMessages(
      messages.map(message =>
        message.messageId === messageId && message.state.kind === 'queued'
          ? { ...message, state: { ...message.state, preparationWait: wait } }
          : message
      ),
      epoch
    );
    if (saved)
      this.broadcastCloudStatus({ type: 'preparing', step: wait.step, message: wait.message });
  }

  /** Broadcast a volatile `cloud.status` to already-connected stream clients. */
  private broadcastCloudStatus(status: CloudStatusData['cloudStatus']): void {
    this.broadcastStoredEvent({
      id: 0 as EventId,
      execution_id: '',
      session_id: this.requireSessionId(),
      stream_event_type: 'cloud.status',
      payload: JSON.stringify({ cloudStatus: status } satisfies CloudStatusData),
      timestamp: Date.now(),
    });
  }

  /**
   * Emit a preparation wait once per phase/detail. Reconnect reads the reason
   * from the materialized attempt snapshot, so repeating an identical sentence
   * every 5 s adds nothing.
   */
  private emitPreparationWait(
    recorder: PreparationProgressRecorder,
    attemptId: string,
    step: string,
    message: string
  ): void {
    const latest = this.latestPreparationStep(attemptId);
    if (latest?.key === step && latest.latestDetail === message) return;
    recorder.onProgress(step, message);
  }

  /** Latest step snapshot for one preparation attempt, if any. */
  private latestPreparationStep(
    attemptId: string
  ): { key: string; latestDetail?: string; startedAt: number } | undefined {
    let latest: { key: string; latestDetail?: string; startedAt: number } | undefined;
    for (const row of this.eventQueries.findByEntityPrefix(
      `preparation/attempt/${attemptId}/step/`
    )) {
      let data: unknown;
      try {
        data = JSON.parse(row.payload);
      } catch {
        continue;
      }
      if (typeof data !== 'object' || data === null) continue;
      const record = data as {
        action?: unknown;
        stepSnapshot?: {
          key?: unknown;
          status?: unknown;
          startedAt?: unknown;
          latestDetail?: unknown;
        };
      };
      if (record.action !== 'step_snapshot' || !record.stepSnapshot) continue;
      const step = record.stepSnapshot;
      if (typeof step.key !== 'string' || typeof step.startedAt !== 'number') continue;
      if (latest === undefined || step.startedAt >= latest.startedAt) {
        latest = {
          key: step.key,
          startedAt: step.startedAt,
          ...(typeof step.latestDetail === 'string' ? { latestDetail: step.latestDetail } : {}),
        };
      }
    }
    return latest;
  }

  private initialMessageFromRegistration(
    message: NonNullable<SandboxSessionRegistrationInput['message']>
  ): NonNullable<SessionMetadata['initialMessage']> {
    const turn = message.turn;
    if (turn.type === 'command') {
      return {
        id: message.initialMessageId ?? turn.id ?? undefined,
        prompt:
          turn.arguments.length > 0 ? `/${turn.command} ${turn.arguments}` : `/${turn.command}`,
        turn: { type: 'command', command: turn.command, arguments: turn.arguments },
      };
    }
    return {
      id: message.initialMessageId ?? turn.id ?? undefined,
      prompt: turn.prompt,
      ...(turn.attachments ? { attachments: turn.attachments } : {}),
      turn: {
        type: 'prompt',
        prompt: turn.prompt,
        ...(turn.attachments ? { attachments: turn.attachments } : {}),
      },
    };
  }

  private initialMessageMatches(
    initialMessage: NonNullable<SessionMetadata['initialMessage']>,
    turn: AcceptedExecutionTurn
  ): boolean {
    if (initialMessage.id !== turn.messageId || initialMessage.turn?.type !== turn.type) {
      return false;
    }
    if (turn.type === 'command') {
      return (
        initialMessage.turn.type === 'command' &&
        initialMessage.turn.command === turn.command &&
        initialMessage.turn.arguments === turn.arguments
      );
    }
    return (
      initialMessage.turn.type === 'prompt' &&
      initialMessage.turn.prompt === turn.prompt &&
      JSON.stringify(initialMessage.turn.attachments) === JSON.stringify(turn.attachments)
    );
  }

  private async requestSessionOperation(
    operation: 'session.permission.resolve' | 'session.question.resolve',
    payload: unknown
  ): Promise<{ success: boolean }> {
    const metadata = await this.getMetadata();
    const epoch = this.terminalLifecycle.captureEpoch();
    const sandboxId = metadata?.workspace?.sandboxId;
    const kiloSessionId = metadata?.auth.kiloSessionId;
    const sessionId = this.sessionId;
    if (!metadata || epoch === null || !sandboxId || !kiloSessionId || !sessionId) {
      throw new Error('No wrapper found for session');
    }
    if (!this.terminalLifecycle.isCurrent(epoch)) {
      throw new Error('No wrapper found for session');
    }
    const response = await withTimeout(
      sandboxControlRpc(this.env, sandboxId).request({
        operation,
        session: {
          sessionId,
          kiloSessionId,
          directory: this.directory(metadata),
        },
        payload,
      }),
      SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
      'Session interaction timed out'
    );
    if (!this.terminalLifecycle.isCurrent(epoch)) {
      throw new Error('No wrapper found for session');
    }
    if (!response.ok) {
      throw new Error(response.error?.message ?? 'Control request failed');
    }
    if (operation === 'session.permission.resolve')
      sessionPermissionResolveResultSchema.parse(response.result);
    else sessionQuestionResolveResultSchema.parse(response.result);
    return { success: true };
  }

  private worktreeContext(metadata: SessionMetadata | null): WorktreeChangesContext | null {
    if (
      this.deletedWorktreeId ||
      this.terminalLifecycle.isBlocked() ||
      !metadata ||
      metadata.identity.sessionId !== this.sessionId
    ) {
      return null;
    }
    try {
      return worktreeChangesContext(metadata, this.directory(metadata));
    } catch {
      return null;
    }
  }

  private directory(metadata: SessionMetadata): string {
    return (
      metadata.workspace?.workspacePath ??
      getSessionWorkspacePath(
        metadata.identity.orgId,
        metadata.identity.userId,
        metadata.identity.sessionId
      )
    );
  }

  private broadcastQueuedMessage(messageId: string, content: string): void {
    if (this.terminalLifecycle.captureEpoch() === null) return;
    const sessionId = this.requireSessionId();
    createStreamHandler(this.ctx, this.eventQueries, sessionId).broadcastEvent({
      id: 0,
      execution_id: '',
      session_id: sessionId,
      stream_event_type: 'cloud.message.queued',
      payload: JSON.stringify({ messageId, content, delivery: 'queued' }),
      timestamp: Date.now(),
    });
  }

  private isCurrentEventRuntime(wrapperInstanceId?: string): boolean {
    if (wrapperInstanceId === undefined) return true;
    const messages = this.loadMessages();
    const current =
      messages.find(message => message.state.kind === 'accepted') ??
      messages.find(message => message.state.kind === 'queued');
    const lastWithWrapper = messages.findLast(
      message => deliveryWrapperInstanceId(message) !== undefined
    );
    const expected =
      (current ? activeWrapperInstanceId(current) : undefined) ??
      (lastWithWrapper ? deliveryWrapperInstanceId(lastWithWrapper) : undefined);
    return expected === undefined || expected === wrapperInstanceId;
  }

  private loadMessages(): MessageRecord[] {
    return readActiveSessionMessages(
      this.ctx.storage.kv,
      this.deletedWorktreeId !== undefined || this.terminalLifecycle.isBlocked()
    );
  }

  /** The aggregate projection: the attachment record is the only binding owner. */
  private sessionBinding(messages: readonly SessionMessage[]): Binding {
    return bindingForAttachment(this.terminalLifecycle.getAttachedBinding(), messages);
  }

  private sessionAggregate(messages: readonly SessionMessage[]): SessionAggregate {
    return { binding: this.sessionBinding(messages), messages: [...messages] };
  }

  private saveMessages(
    messages: MessageRecord[],
    epoch?: number,
    source?: 'coordinator' | 'wrapper_outcome' | 'operation_result',
    deferredNotifications?: StoredEvent[],
    onPersist?: () => void
  ): boolean;
  private saveMessages(
    messages: MessageRecord[],
    epoch: number,
    source: 'coordinator' | 'wrapper_outcome' | 'operation_result',
    deferredNotifications: StoredEvent[] | undefined,
    onPersist: (() => void) | undefined,
    beforePersist: () => ControlEventDisposition
  ): ControlEventDisposition;
  private saveMessages(
    messages: MessageRecord[],
    epoch?: number,
    source: 'coordinator' | 'wrapper_outcome' | 'operation_result' = 'coordinator',
    deferredNotifications?: StoredEvent[],
    onPersist?: () => void,
    beforePersist?: () => ControlEventDisposition
  ): boolean | ControlEventDisposition {
    return this.commitSavedMessages(
      messages,
      epoch,
      source,
      deferredNotifications,
      onPersist,
      beforePersist,
      write => this.ctx.storage.transactionSync(write)
    );
  }

  private saveMessagesInCurrentTransaction(
    messages: MessageRecord[],
    epoch: number | undefined,
    source: 'coordinator' | 'wrapper_outcome' | 'operation_result',
    deferredNotifications?: StoredEvent[]
  ): boolean {
    return (
      this.commitSavedMessages(
        messages,
        epoch,
        source,
        deferredNotifications,
        undefined,
        undefined,
        write => write(),
        false
      ) === true
    );
  }

  private commitSavedMessages(
    messages: MessageRecord[],
    epoch: number | undefined,
    source: 'coordinator' | 'wrapper_outcome' | 'operation_result',
    deferredNotifications: StoredEvent[] | undefined,
    onPersist: (() => void) | undefined,
    beforePersist: (() => ControlEventDisposition) | undefined,
    enclose: (write: () => void) => void,
    scheduleCallbackRepair = true
  ): boolean | ControlEventDisposition {
    const returnsControlEventDisposition = beforePersist !== undefined;
    const currentEpoch = epoch ?? this.terminalLifecycle.captureEpoch();
    if (
      this.deletedWorktreeId ||
      currentEpoch === null ||
      !this.terminalLifecycle.isCurrent(currentEpoch)
    )
      return returnsControlEventDisposition ? 'epoch_changed' : false;
    const events: StoredEvent[] = [];
    const committed: ControlDiagnosticFields[] = [];
    let callbackPersisted = false;
    let reportPersisted = false;
    let persisted = false;
    let disposition: ControlEventDisposition = 'epoch_changed';
    const newlyTerminalMessageIds = new Set<string>();
    const write = () => {
      if (!this.terminalLifecycle.isCurrent(currentEpoch)) return;
      if (beforePersist) {
        disposition = beforePersist();
        if (disposition !== 'apply') return;
      }
      const before = this.loadMessages();
      const previousById = new Map(before.map(message => [message.messageId, message]));
      const queuedHeadId = nextQueuedMessageId(before);
      // A queued follow-up can be the head while another turn is accepted. The
      // session-wide interactions belong to the running turn, so a follow-up's
      // terminal event must not clear them while an accepted turn remains.
      const acceptedTurnRemains = hasAcceptedMessage(before);
      const next = messages.map((message): SessionMessage => {
        const previous = previousById.get(message.messageId);
        const previousState = previous?.state;
        const state = message.state;
        // HEAD's terminal-over-active guard runs first: a stale producer's queued
        // or accepted copy must never resurrect a row the store already settled.
        if (
          previous !== undefined &&
          previous.state.kind !== 'queued' &&
          previous.state.kind !== 'accepted'
        ) {
          return previous;
        }
        if (state.kind === 'queued') return message;
        if (state.kind === 'accepted') {
          if (previousState?.kind !== 'accepted') {
            const event = this.persistMessageLifecycleEvent(message);
            if (event) events.push(event);
            this.recordMessageReport(message, true);
            reportPersisted = true;
            committed.push({
              messageId: message.messageId,
              wrapperInstanceId: state.wrapperInstanceId,
              fromState: previousState?.kind,
              toState: state.kind,
              lifecycleEventInserted: event !== undefined,
            });
          }
          return message;
        }
        if (
          previousState?.kind === 'accepted' ||
          (!acceptedTurnRemains && queuedHeadId === message.messageId)
        ) {
          const interactions = this.readPendingInteractions();
          this.ctx.storage.kv.put(PENDING_INTERACTIONS_KEY, {
            revision: (interactions?.revision ?? 0) + 1,
            questions: [],
            permissions: [],
          });
        }
        const event = this.persistMessageLifecycleEvent(message);
        if (event) events.push(event);
        newlyTerminalMessageIds.add(message.messageId);
        this.recordMessageReport(message, previousState?.kind === 'accepted');
        reportPersisted = true;
        const reason = failedReasonOf(message);
        committed.push({
          messageId: message.messageId,
          wrapperInstanceId:
            previousState !== undefined
              ? activeWrapperInstanceId(previous as SessionMessage)
              : undefined,
          fromState: previousState?.kind,
          toState: state.kind,
          terminalAt: state.at,
          lifecycleEventInserted: event !== undefined,
          cause: reason !== undefined ? diagnosticCause(reason) : undefined,
        });
        // The terminal union drops `preparationAttemptId`; finalize from the
        // pre-transition message so progress is never left running.
        if (previousState?.kind === 'queued' && previousState.preparationAttemptId) {
          events.push(
            ...finalizePreparationAttempt(
              this.eventQueries,
              previousState.preparationAttemptId,
              state.kind === 'completed'
                ? { status: 'completed', timestamp: state.at }
                : {
                    status: 'failed',
                    safeError:
                      state.kind === 'cancelled'
                        ? 'The message was interrupted'
                        : (failedDetailOf(message) ??
                          safeErrorFromQueueReason(reason ?? 'environment_failed')),
                    timestamp: state.at,
                  }
            )
          );
        }
        return message;
      });
      writeSessionMessages(this.ctx.storage.kv, this.sessionBinding(next), next);
      callbackPersisted = this.messageCallbacks.persistDrainedBatchCallback(
        next,
        newlyTerminalMessageIds
      );
      onPersist?.();
      persisted = true;
    };
    enclose(write);
    if (!persisted) return returnsControlEventDisposition ? disposition : false;
    if (callbackPersisted) {
      if (scheduleCallbackRepair) this.scheduleCallbackRepair();
      else this.callbackRepairRequired = true;
    }
    if (reportPersisted) {
      if (scheduleCallbackRepair) this.scheduleReportRepair();
      else this.reportRepairRequired = true;
    }
    for (const fields of committed) {
      logControlDiagnostic('session_message_committed', {
        sessionId: this.sessionId,
        source,
        ...fields,
      });
    }
    if (deferredNotifications) deferredNotifications.push(...events);
    else for (const event of events) this.broadcastStoredEvent(event);
    return returnsControlEventDisposition ? 'apply' : true;
  }

  private persistMessageLifecycleEvent(message: MessageRecord): StoredEvent | undefined {
    const state = message.state;
    const accepted = state.kind === 'accepted';
    const completed = state.kind === 'completed';
    const streamEventType = accepted
      ? 'cloud.message.sent'
      : completed
        ? 'cloud.message.completed'
        : 'cloud.message.failed';
    const sessionId = this.requireSessionId();
    const timestamp = (accepted ? state.acceptedAt : terminalAtOf(message)) ?? Date.now();
    const payload = JSON.stringify(
      accepted
        ? { messageId: message.messageId, delivery: 'sent' }
        : completed
          ? { messageId: message.messageId, status: 'completed', delivery: 'sent', accepted: true }
          : failedMessageSnapshot(message, timestamp)
    );
    const id = this.eventQueries.insertUnique({
      executionId: '',
      sessionId,
      streamEventType,
      payload,
      timestamp,
      entityId: `${accepted ? 'accepted-message' : 'terminal-message'}/${message.messageId}`,
    });
    if (id === null) return undefined;
    return {
      id,
      execution_id: '',
      session_id: sessionId,
      stream_event_type: streamEventType,
      payload,
      timestamp,
    };
  }

  private requireSessionId(): SessionId {
    if (!this.sessionId) throw new Error('SandboxSession is missing session id');
    return this.sessionId;
  }
}
