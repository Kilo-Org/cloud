import { DurableObject } from 'cloudflare:workers';
import type {
  GetWorktreeChangesOutput,
  GetWorktreeFileOutput,
  RefreshWorktreeChangesOutput,
  WorktreeFileQuery,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import { TRPCError } from '@trpc/server';
import { withTimeout } from '@kilocode/worker-utils';
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
import type { SessionId } from '../types/ids.js';
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
import { getSandboxControlStub } from '../sandbox-control/stub.js';
import { DEADLINE_MS } from '../sandbox-control/deadlines.js';
import { createMessageId } from '../session/message-id.js';
import { validateControlSessionOptions } from './attach-payload.js';
import {
  createWorktreeChanges,
  worktreeChangesContext,
  type WorktreeChangesContext,
} from './worktree-changes.js';
import {
  WORKTREE_CHANGED_EVENT,
  WORKTREE_CHANGES_READY_EVENT,
} from '../shared/worktree-changes-wire.js';
import { createPreparationProgressRecorder } from '../session/preparation-progress.js';
import {
  finalizeOtherRunningAttemptsForMessage,
  finalizePreparationAttempt,
  getPreparationSnapshots,
} from '../session/preparation-history.js';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  controlErrorCodes,
  sessionAttachResultSchema,
  sessionMessageOutcomeSchema,
  sessionPromptResultSchema,
  sessionSyncResultSchema,
  sessionPermissionResolveResultSchema,
  sessionQuestionResolveResultSchema,
  sessionAbortResultSchema,
  wrapperInstanceIdSchema,
  type SessionSyncResult,
  type SessionEventIdentity,
  type SessionPreparingPayload,
} from '../shared/sandbox-control-protocol.js';
import type { WrapperPty } from '../kilo/wrapper-client.js';
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
  isRetryableDeliveryError,
  observeControlAfterStopping,
  safeErrorFromQueueReason,
  SESSION_DELIVERY_TIMEOUT_MS,
  withDeliveryDeadline,
} from './control-dispatch.js';
import { acceptedAlarmDecision } from './accepted-overdue.js';
import { bootPreparingStep, provisionPreparingStep } from './preparing-steps.js';
import { createSandboxTerminalBridge, type SandboxTerminalRecord } from './terminal-bridge.js';
import {
  createSandboxTerminalLifecycle,
  SANDBOX_SESSION_METADATA_KEY,
  SANDBOX_SESSION_DELETED_WORKTREE_KEY,
} from './terminal-lifecycle.js';
import {
  acceptQueuedMessage,
  applyMessageOutcome,
  assignPreparationAttemptId,
  createSessionMessageRecord,
  failQueuedMessage,
  failWaitingMessages as applyFailWaitingMessages,
  failedMessageSnapshot,
  freezeLegacyQueuedMessages,
  hasAcceptedMessage,
  incrementDeliveryFailure,
  matchesSessionMessageReplay,
  nextQueuedMessageId,
  recordAcceptedMessageActivity,
  resolveSessionMessageIntent,
  streamCloudStatus,
  streamQueuedSnapshots,
  type ControlSessionMessageInput,
  type SessionMessageRecord,
} from './session-message-queue.js';

const METADATA_KEY = SANDBOX_SESSION_METADATA_KEY;
const MESSAGES_KEY = 'session_messages';
const DELETED_WORKTREE_KEY = SANDBOX_SESSION_DELETED_WORKTREE_KEY;
const DELETION_COMPLETED_KEY = 'deletion_completed';

type SandboxControlEventInput = {
  identity: { directory: string; kiloSessionId?: string; rootKiloSessionId?: string };
  payload: { type: string; properties: Record<string, unknown>; timestamp?: string };
};
const QUEUE_RETRY_MS = 5_000;
const PENDING_RUNTIME_CLEANUP_KEY = 'pending_runtime_cleanup';
const PENDING_INTERACTIONS_KEY = 'session_pending_interactions';
const pendingRuntimeCleanupSchema = z.object({
  ownerId: z.string().min(1),
  sessionId: z.string().min(1),
  sandboxId: z.string().min(1),
  wrapperInstanceId: wrapperInstanceIdSchema,
  reason: z.string(),
});

type MessageRecord = SessionMessageRecord;
type DispatchPhase = 'preparing' | 'attach' | 'prompt';

type SandboxSessionRegistrationInput = {
  identity: SessionMetadata['identity'];
  auth: SessionMetadata['auth'];
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
  private readonly terminalLifecycle: ReturnType<typeof createSandboxTerminalLifecycle>;
  private readonly terminalBridge: ReturnType<typeof createSandboxTerminalBridge>;
  private readonly dispatches = new Map<string, Promise<void>>();
  private ingestPublicationChain: Promise<void> = Promise.resolve();
  private deletedWorktreeId: CloudAgentWorktreeId | undefined;
  private readonly activeOperations = new Set<Promise<unknown>>();
  private deletionCompletion: Promise<void> | undefined;
  private readonly worktreeChanges: ReturnType<typeof createWorktreeChanges>;

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
        this.pendingRuntimeCleanup() ? undefined : this.terminalLifecycle.getTerminal(ptyId),
      requestConnect: async (record, payload) =>
        this.terminalLifecycle.requestConnect(record, payload),
      reportActivity: async record => this.terminalLifecycle.reportActivity(record),
      markEnded: async record => this.terminalLifecycle.markEnded(record),
    });
    const db = drizzle(ctx.storage, { logger: false });
    this.eventQueries = createEventQueries(db, ctx.storage.sql);
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
      derivePendingInteractions: () => this.derivePendingInteractions(),
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
  ): Promise<{ applied: boolean }> {
    return this.trackOperation(this.applySandboxControlEvent(input));
  }

  private async applySandboxControlEvent(
    input: SandboxControlEventInput & { wrapperInstanceId?: string }
  ): Promise<{ applied: boolean }> {
    const startedAt = Date.now();
    const metadata = await this.getMetadata();
    const epoch = this.terminalLifecycle.captureEpoch();
    const result = (
      applied: boolean,
      disposition: string,
      fields: ControlDiagnosticFields = {}
    ) => {
      logControlDiagnostic('session_event_result', {
        sessionId: this.sessionId,
        sandboxId: metadata?.workspace?.sandboxId,
        wrapperInstanceId: input.wrapperInstanceId,
        eventType: diagnosticEventType(input.payload.type),
        applied,
        disposition,
        durationMs: Date.now() - startedAt,
        ...fields,
      });
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
        if ('id' in info && info.id !== eventKiloSessionId) return { applied: false };
        if (eventKiloSessionId !== root && ('parentID' in info || 'directory' in info)) {
          const directory = this.directory(metadata);
          const child = childSessionLineage(info, directory);
          if (
            !child ||
            child.sessionId !== eventKiloSessionId ||
            input.identity.directory !== directory
          )
            return { applied: false };
        }
      }
    }
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
        fromState: existing?.state,
        outcome: outcome.data.status,
      };
      if (
        existing?.wrapperInstanceId === input.wrapperInstanceId &&
        existing.state === outcome.data.status
      )
        return result(true, 'duplicate', diagnostic);
      const settled = applyMessageOutcome(
        messages,
        outcome.data,
        input.wrapperInstanceId,
        Date.now()
      );
      if (!settled) {
        return result(
          false,
          !existing
            ? 'message_missing'
            : existing.state !== 'queued' && existing.state !== 'accepted'
              ? 'already_terminal'
              : existing.wrapperInstanceId !== input.wrapperInstanceId
                ? 'runtime_mismatch'
                : 'not_queue_head',
          diagnostic
        );
      }
      if (!this.saveMessages(settled, epoch, 'wrapper_outcome'))
        return result(false, 'epoch_changed', diagnostic);
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
    if (!this.isCurrentEventRuntime(input.wrapperInstanceId))
      return result(false, 'runtime_mismatch');
    if (
      eventKiloSessionId !== undefined &&
      eventKiloSessionId !== root &&
      (root === undefined || input.identity.rootKiloSessionId !== root)
    )
      return result(false, 'root_mismatch');
    if (input.payload.type === WORKTREE_CHANGED_EVENT) {
      if (!root || eventKiloSessionId !== root) return result(false, 'root_mismatch');
      if (!input.wrapperInstanceId) return result(false, 'missing_wrapper_identity');
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
        message => message.state === 'accepted' || message.state === 'queued'
      )
    )
      return result(false, 'no_pending_work');
    this.recordPendingInteraction(input.payload);
    persistSandboxControlSessionEvent({
      sessionId,
      payload: input.payload,
      eventQueries: this.eventQueries,
      broadcast: event => this.broadcastStoredEvent(event),
    });
    const activeMessages = recordAcceptedMessageActivity(this.loadMessages(), Date.now());
    if (activeMessages) this.saveMessages(activeMessages, epoch);
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
          .then(() => {
            if (!this.terminalLifecycle.isCurrent(epoch)) return;
            return publishControlPlaneSessionIngest({
              fetchIngest: request => this.env.SESSION_INGEST.fetch(request),
              token,
              rootKiloSessionId,
              eventKiloSessionId,
              cloudAgentSessionId: metadata.identity.sessionId,
              directory: this.directory(metadata),
              ...(internalSecret ? { internalSecret } : {}),
              items: ingestItems,
            });
          });
        this.ingestPublicationChain = publication;
        this.ctx.waitUntil(publication);
      }
    }
    const applied = this.terminalLifecycle.isCurrent(epoch);
    return result(applied, applied ? 'applied' : 'epoch_changed');
  }

  async receiveSandboxControlPreparing(input: {
    identity: SessionEventIdentity;
    payload: SessionPreparingPayload;
    wrapperInstanceId?: string;
  }): Promise<{ applied: boolean }> {
    const metadata = await this.getMetadata();
    const epoch = this.terminalLifecycle.captureEpoch();
    const result = (applied: boolean, disposition: string) => {
      logControlDiagnostic('session_preparing_result', {
        sessionId: this.sessionId,
        sandboxId: metadata?.workspace?.sandboxId,
        wrapperInstanceId: input.wrapperInstanceId,
        applied,
        disposition,
      });
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
    const message = this.loadMessages().find(
      item => item.messageId === input.payload.triggerMessageId
    );
    if (
      !this.terminalLifecycle.isCurrent(epoch) ||
      !message ||
      message.preparationAttemptId !== input.payload.attemptId ||
      (input.wrapperInstanceId !== undefined &&
        message.wrapperInstanceId !== input.wrapperInstanceId)
    ) {
      return result(
        false,
        !this.terminalLifecycle.isCurrent(epoch)
          ? 'epoch_changed'
          : !message
            ? 'message_missing'
            : message.preparationAttemptId !== input.payload.attemptId
              ? 'attempt_mismatch'
              : 'runtime_mismatch'
      );
    }
    if (message.state !== 'queued') return result(true, 'already_settled');
    const sessionId = this.requireSessionId();
    applyControlPlanePreparingEvent({
      sessionId,
      data: input.payload,
      eventQueries: this.eventQueries,
      broadcast: event => this.broadcastStoredEvent(event),
    });
    return result(true, 'processed');
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
    return this.deletedWorktreeId || this.terminalLifecycle.isDeleted()
      ? null
      : this.terminalLifecycle.getStoredMetadata();
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
    const status =
      record.state === 'queued'
        ? 'queued'
        : record.state === 'accepted'
          ? 'running'
          : record.state === 'cancelled'
            ? 'interrupted'
            : record.state;
    return {
      type: 'found',
      result: {
        messageId: record.messageId,
        status,
        createdAt: record.acceptedAt ?? 0,
        cloudAgentSessionId: this.requireSessionId(),
      },
    };
  }

  async markAsInterrupted(): Promise<void> {
    return;
  }

  async interruptExecution(): Promise<{ success: boolean; message?: string }> {
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return { success: false, message: 'Session not found' };
    const before = this.loadMessages();
    if (!this.terminalLifecycle.isCurrent(epoch)) {
      return { success: false, message: 'Session not found' };
    }
    const active = before.filter(
      message => message.state === 'queued' || message.state === 'accepted'
    );
    if (!active.length) return { success: false, message: 'No session work to interrupt' };
    const accepted = active.find(message => message.state === 'accepted');
    const preparing = accepted ? undefined : active[0];
    const metadata = this.terminalLifecycle.getStoredMetadata();
    if (preparing?.wrapperInstanceId && preparing.deliveryRetryScope !== 'message' && metadata) {
      this.retainRuntimeCleanup(metadata, preparing.wrapperInstanceId, 'preparation_interrupted');
    }
    this.saveMessages(
      before.map(message =>
        message.state === 'queued' ? { ...message, state: 'cancelled' } : message
      ),
      epoch
    );
    await this.armQueueRetry();
    if (this.pendingRuntimeCleanup()) {
      await this.transferRuntimeCleanup();
      return { success: true };
    }
    const sandboxId = metadata?.workspace?.sandboxId;
    const kiloSessionId = metadata?.auth.kiloSessionId;
    if (!accepted) return { success: true };
    this.worktreeChanges.markInterrupted(this.worktreeContext(metadata));
    try {
      if (!metadata || !sandboxId || !kiloSessionId)
        throw new Error('Accepted runtime is unavailable');
      const response = await withTimeout(
        sandboxControlRpc(this.env, sandboxId).request({
          operation: 'session.abort',
          session: {
            sessionId: metadata.identity.sessionId,
            kiloSessionId,
            directory: this.directory(metadata),
          },
          payload: { messageId: accepted.messageId },
        }),
        SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
        'Session abort timed out'
      );
      if (!this.isCurrentAcceptedMessage(accepted, epoch)) return { success: true };
      if (!response.ok) throw new Error('Session abort failed');
      sessionAbortResultSchema.parse(response.result);
      this.saveMessages(
        this.loadMessages().map(message =>
          message.messageId === accepted.messageId ? { ...message, state: 'cancelled' } : message
        ),
        epoch
      );
      await this.armQueueRetry();
      return { success: true };
    } catch {
      if (!this.isCurrentAcceptedMessage(accepted, epoch)) return { success: true };
      logControlDiagnostic(
        'session_interrupt_failed',
        {
          sessionId: this.sessionId,
          messageId: accepted.messageId,
          expectedWrapperInstanceId: accepted.wrapperInstanceId,
          sandboxId,
          kiloSessionId,
          worktreeId: metadata?.workspace?.worktreeId,
          epoch,
          operation: 'session.abort',
          cause: 'runtime_unhealthy',
        },
        'warn'
      );
      await this.failDelivery(accepted.messageId, 'runtime_unhealthy', accepted.wrapperInstanceId);
      return { success: false, message: 'The session runtime could not be interrupted' };
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
    if (this.pendingRuntimeCleanup())
      return { success: false, error: 'Runtime cleanup is pending' };
    return this.trackOperation(this.terminalLifecycle.createTerminal(input));
  }

  async resizeTerminal(input?: {
    ptyId?: string;
    cols?: number;
    rows?: number;
  }): Promise<OperationResult<{ pty: WrapperPty }>> {
    return this.trackOperation(this.terminalLifecycle.resizeTerminal(input));
  }

  async closeTerminal(input?: { ptyId?: string }): Promise<OperationResult<{ success: boolean }>> {
    return this.trackOperation(this.terminalLifecycle.closeTerminal(input));
  }

  async invalidateTerminalRuntime(input: {
    sandboxId: string;
    wrapperInstanceId: string;
    confirmed: boolean;
  }): Promise<void> {
    this.terminalLifecycle.invalidateRuntime(input);
  }

  async isSandboxCleanupScheduled(): Promise<boolean> {
    return this.pendingRuntimeCleanup() !== undefined;
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
    )
      return null;
    this.worktreeChanges.suppress();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put(DELETED_WORKTREE_KEY, worktreeId);
      this.terminalLifecycle.beginDeletion(metadata);
      const messages = this.ctx.storage.kv.get<MessageRecord[]>(MESSAGES_KEY) ?? [];
      const cancelled = messages.map(message =>
        message.state === 'queued' || message.state === 'accepted'
          ? { ...message, state: 'cancelled' as const }
          : message
      );
      this.ctx.storage.kv.put(MESSAGES_KEY, cancelled);
    });
    this.deletedWorktreeId = worktreeId;
    for (const socket of this.ctx.getWebSockets()) socket.close(1001, 'Worktree deleted');
    try {
      this.ctx.storage.transactionSync(() => this.worktreeChanges.purge());
    } finally {
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
    if (await this.ctx.storage.get(DELETION_COMPLETED_KEY)) return;
    for (const socket of this.ctx.getWebSockets()) socket.close(1001, 'Worktree deleted');
    await this.ctx.storage.deleteAlarm();
    const db = drizzle(this.ctx.storage, { logger: false });
    this.ctx.storage.transactionSync(() => {
      db.delete(events).where(eq(events.session_id, this.requireSessionId())).run();
      db.delete(commandQueue).where(eq(commandQueue.session_id, this.requireSessionId())).run();
      db.delete(executionLeases).where(isNotNull(executionLeases.execution_id)).run();
      this.terminalLifecycle.purgeDeletedState();
      this.ctx.storage.kv.put(DELETED_WORKTREE_KEY, worktreeId);
      this.ctx.storage.kv.put(DELETION_COMPLETED_KEY, true);
    });
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.activeOperations.add(operation);
    return operation.finally(() => this.activeOperations.delete(operation));
  }

  async deleteSession(): Promise<void> {
    if (this.deletedWorktreeId) throw new Error('worktree_deleting');
    this.worktreeChanges.suppress();
    await this.interruptExecution();
    if (this.deletedWorktreeId) throw new Error('worktree_deleting');
    const metadata = this.terminalLifecycle.getStoredMetadata();
    const records = this.terminalLifecycle.beginDeletion(metadata);
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
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.transactionSync(() => {
      if (this.deletedWorktreeId) throw new Error('worktree_deleting');
      const pendingCleanup = this.pendingRuntimeCleanup();
      this.eventQueries.deleteOlderThan(Number.MAX_SAFE_INTEGER);
      this.terminalLifecycle.purgeDeletedState();
      if (pendingCleanup) this.ctx.storage.kv.put(PENDING_RUNTIME_CLEANUP_KEY, pendingCleanup);
    });
    if (this.pendingRuntimeCleanup()) await this.armQueueRetry();
  }

  async registerSession(input: SandboxSessionRegistrationInput): Promise<OperationResult> {
    if (this.deletedWorktreeId) return { success: false, error: 'worktree_deleting' };
    if (this.terminalLifecycle.isBlocked()) return { success: false, error: 'Session not found' };
    const initialMessage = input.message
      ? this.initialMessageFromRegistration(input.message)
      : undefined;
    const existing = this.terminalLifecycle.getStoredMetadata();
    if (existing) {
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
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: input.identity,
      auth: input.auth,
      agent: input.agent,
      ...(repository ? { repository } : {}),
      ...(initialMessage ? { initialMessage } : {}),
      workspace: input.workspace ?? {},
      ...(input.callback ? { callback: input.callback } : {}),
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.finalization ? { finalization: input.finalization } : {}),
      lifecycle: { version: 1, timestamp: Date.now() },
    });
    if (this.deletedWorktreeId) return { success: false, error: 'worktree_deleting' };
    if (this.terminalLifecycle.isBlocked()) return { success: false, error: 'Session not found' };
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
    const accepted = messages.find(message => message.state === 'accepted');
    if (accepted) return { messageId: accepted.messageId, status: 'running', health: 'healthy' };
    const queued = messages.find(message => message.state === 'queued');
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
    _request: LegacyRegisteredInitialAdmissionRequest
  ): Promise<SessionMessageAdmissionResult | undefined> {
    return undefined;
  }

  async admitPreparedInitialMessage(
    _request: LegacyRegisteredInitialAdmissionRequest
  ): Promise<SessionMessageAdmissionResult> {
    return { success: false, code: 'BAD_REQUEST', error: 'Prepared admission is legacy-only' };
  }

  async alarm(): Promise<void> {
    if (this.pendingRuntimeCleanup()) await this.transferRuntimeCleanup();
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null || this.deletedWorktreeId) return;
    const now = Date.now();
    const messages = this.loadMessages();
    if (!this.terminalLifecycle.isCurrent(epoch)) return;
    const accepted = messages.find(message => message.state === 'accepted');
    if (accepted) {
      const decision = acceptedAlarmDecision(
        accepted.acceptedAt ?? 0,
        now,
        accepted.lastActivityAt
      );
      await this.armQueueRetry(
        decision.action === 'rearm' ? decision.at : now + DEADLINE_MS.acceptedAlarmCap
      );
      if (decision.action === 'check') {
        const startedAt = Date.now();
        const diagnostic: ControlDiagnosticFields = {
          sessionId: this.sessionId,
          messageId: accepted.messageId,
          expectedWrapperInstanceId: accepted.wrapperInstanceId,
          epoch,
          acceptedAt: accepted.acceptedAt,
          lastActivityAt: accepted.lastActivityAt,
          stage: 'sync',
        };
        const report = (result: 'healthy' | 'superseded' | 'runtime_unhealthy') =>
          logControlDiagnostic(
            'accepted_reconciliation',
            { ...diagnostic, phase: 'finished', result, durationMs: Date.now() - startedAt },
            result === 'runtime_unhealthy' ? 'warn' : 'info'
          );
        logControlDiagnostic('accepted_reconciliation', { ...diagnostic, phase: 'started' });
        try {
          const snapshot = await this.syncAcceptedMessage(accepted, epoch, 'accepted_alarm');
          if (!snapshot || !this.isCurrentAcceptedMessage(accepted, epoch)) {
            diagnostic.reason = snapshot ? 'accepted_message_changed' : 'sync_superseded';
            report('superseded');
            return;
          }
          diagnostic.stage = 'activity_check';
          diagnostic.syncStatus = diagnosticSyncStatus(snapshot.status.type);
          diagnostic.questionCount = snapshot.questions.length;
          diagnostic.permissionCount = snapshot.permissions.length;
          const healthy =
            snapshot.status.type === 'busy' ||
            snapshot.status.type === 'retry' ||
            snapshot.questions.length > 0 ||
            snapshot.permissions.length > 0;
          diagnostic.healthy = healthy;
          if (!healthy) {
            diagnostic.reason = 'inactive_snapshot';
            throw new Error('Accepted execution is no longer active');
          }
          diagnostic.stage = 'record_activity';
          const active = recordAcceptedMessageActivity(this.loadMessages(), Date.now());
          diagnostic.activityRecorded = active ? this.saveMessages(active, epoch) : false;
          report('healthy');
        } catch {
          if (this.isCurrentAcceptedMessage(accepted, epoch)) {
            diagnostic.reason ??=
              diagnostic.stage === 'record_activity' ? 'activity_record_failed' : 'sync_failed';
            report('runtime_unhealthy');
            await this.failDelivery(
              accepted.messageId,
              'runtime_unhealthy',
              accepted.wrapperInstanceId
            );
          } else {
            diagnostic.reason = 'accepted_message_changed';
            report('superseded');
          }
        }
      }
      return;
    }
    const headId = nextQueuedMessageId(messages);
    if (headId) await this.dispatchQueued(headId, { allowCreate: false });
  }

  private async queueAndDispatch(
    input: ControlSessionMessageInput,
    origin: 'initial' | 'followup'
  ): Promise<SessionMessageAdmissionResult> {
    const epoch = this.terminalLifecycle.captureEpoch();
    const metadata = this.terminalLifecycle.getStoredMetadata();
    if (epoch === null || !metadata || this.deletedWorktreeId) {
      return { success: false, code: 'NOT_FOUND', error: 'Session not found' };
    }
    const admissionInput = metadata.workspace?.worktreeId
      ? {
          ...input,
          finalization: {
            ...metadata.finalization,
            ...input.finalization,
            autoCommit: input.finalization?.autoCommit ?? metadata.finalization?.autoCommit ?? true,
          },
        }
      : input;
    const messageId = input.turn.messageId;
    const messages = this.ctx.storage.kv.get<MessageRecord[]>(MESSAGES_KEY) ?? [];
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
        await assertKiloModelAvailable({
          env: this.env,
          submittedModel: intent.agent.model,
          originalToken: metadata.auth.kilocodeToken,
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
      const latestMetadata = this.terminalLifecycle.getStoredMetadata();
      if (!this.terminalLifecycle.isCurrent(epoch) || !latestMetadata) {
        return { success: false, code: 'NOT_FOUND', error: 'Session not found' };
      }
      const latestMessages = this.ctx.storage.kv.get<MessageRecord[]>(MESSAGES_KEY) ?? [];
      const duplicate = latestMessages.find(message => message.messageId === messageId);
      if (duplicate) {
        const [frozen] = freezeLegacyQueuedMessages(
          [duplicate],
          latestMetadata.agent,
          latestMetadata.workspace?.worktreeId ? latestMetadata.finalization : undefined
        );
        if (
          !matchesSessionMessageReplay(frozen, intent ?? input) ||
          (intent &&
            frozen.intent &&
            (intent.agent.variant !== frozen.intent.agent.variant ||
              intent.finalization?.autoCommit !== frozen.intent.finalization?.autoCommit ||
              intent.finalization?.condenseOnComplete !==
                frozen.intent.finalization?.condenseOnComplete))
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
          compatibilityDelivery: duplicate.state === 'accepted' ? 'sent' : 'queued',
        };
      }
      if (validationFailure) return validationFailure;
      if (!intent) return { success: false, code: 'NOT_FOUND', error: 'Message not found' };
      const nextMessages = freezeLegacyQueuedMessages(
        latestMessages,
        latestMetadata.agent,
        latestMetadata.workspace?.worktreeId ? latestMetadata.finalization : undefined
      );
      nextMessages.push(createSessionMessageRecord(intent));
      const nextMetadata =
        intent.agent.model === undefined
          ? null
          : nextMetadataAfterAdmittedAgentModel(latestMetadata, {
              model: intent.agent.model,
              variant: intent.agent.variant,
            });
      this.ctx.storage.kv.put(MESSAGES_KEY, nextMessages);
      if (nextMetadata) {
        this.ctx.storage.kv.put(METADATA_KEY, serializeSessionMetadata(nextMetadata));
      }
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
      const messages = this.ctx.storage.kv.get<MessageRecord[]>(MESSAGES_KEY) ?? [];
      if (!this.terminalLifecycle.isCurrent(epoch) || nextQueuedMessageId(messages) !== messageId) {
        return undefined;
      }
      const frozen = freezeLegacyQueuedMessages(
        messages,
        metadata.agent,
        metadata.workspace?.worktreeId ? metadata.finalization : undefined
      ).map(message =>
        message.messageId === messageId && message.deliveryDeadlineAt === undefined
          ? { ...message, deliveryDeadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS }
          : message
      );
      const prepared = assignPreparationAttemptId(frozen, messageId, () => crypto.randomUUID());
      if (prepared) this.ctx.storage.kv.put(MESSAGES_KEY, prepared.messages);
      return prepared;
    });
    if (!assigned) return;
    const queued = assigned.messages.find(message => message.messageId === messageId);
    const deadlineAt = queued?.deliveryDeadlineAt;
    if (!queued || deadlineAt === undefined) return;
    const provider = getSandboxProvider(metadata);
    const acquisition =
      provider === 'cloudflare' ? { id: assigned.attemptId, deadlineAt } : undefined;
    const allowCreate = acquisition === undefined && options?.allowCreate === true;
    let wrapperInstanceId = queued.wrapperInstanceId;
    const isCurrent = () => this.queuedMessage(messageId, epoch, wrapperInstanceId) !== undefined;
    const wait = <T>(operation: () => Promise<T>, timeoutMs?: number) =>
      withDeliveryDeadline(operation, deadlineAt, timeoutMs);
    const recordRuntime = (identity: string | undefined) => {
      const runtime = wrapperInstanceIdSchema.safeParse(identity);
      if (!runtime.success) return;
      wrapperInstanceId = runtime.data;
      this.saveMessages(
        this.loadMessages().map(message =>
          message.messageId === messageId
            ? {
                ...message,
                wrapperInstanceId,
                unresolvedDispatch:
                  message.wrapperInstanceId === wrapperInstanceId
                    ? message.unresolvedDispatch
                    : undefined,
              }
            : message
        ),
        epoch
      );
    };
    const dispatch = async <T>(
      kind: 'attach' | 'prompt',
      operation: () => Promise<T>
    ): Promise<T> => {
      const unresolved = this.queuedMessage(
        messageId,
        epoch,
        wrapperInstanceId
      )?.unresolvedDispatch;
      const unresolvedPrompt =
        unresolved && this.terminalLifecycle.getAttachedWrapperInstanceId() === wrapperInstanceId;
      const recordUnresolved = (unresolvedDispatch: true | undefined) => {
        if (!isCurrent()) return;
        this.saveMessages(
          this.loadMessages().map(message =>
            message.messageId === messageId
              ? { ...message, unresolvedDispatch, deliveryRetryScope: undefined }
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
    await this.armQueueRetry(Math.min(deadlineAt, Date.now() + QUEUE_RETRY_MS));
    if (!isCurrent()) return;
    if (Date.now() >= deadlineAt) {
      await this.failDelivery(
        messageId,
        'preparation_timeout',
        wrapperInstanceId,
        queued.deliveryRetryScope
      );
      return;
    }
    if (this.pendingRuntimeCleanup()) return;
    const intent = queued.intent;
    const model = dispatchedKilocodeModelId(intent?.agent.model);
    const control = sandboxControlRpc(this.env, sandboxId);
    const recorder = createPreparationProgressRecorder({
      attemptId: assigned.attemptId,
      triggerMessageId: messageId,
      sessionId,
      eventQueries: this.eventQueries,
      broadcast: event => this.broadcastStoredEvent(event),
    });
    for (const event of finalizeOtherRunningAttemptsForMessage(
      this.eventQueries,
      messageId,
      assigned.attemptId,
      Date.now()
    )) {
      this.broadcastStoredEvent(event);
    }
    if (
      !intent ||
      ((intent.turn.type === 'prompt' || intent.agent.model !== undefined) && !model)
    ) {
      const failedMessages = failQueuedMessage(this.loadMessages(), messageId);
      const failed = failedMessages?.find(message => message.messageId === messageId);
      if (!failedMessages || !failed) return;
      failed.failedReason = 'invalid_model';
      if (!this.saveMessages(failedMessages, epoch)) return;
      if (!this.terminalLifecycle.isCurrent(epoch)) return;
      recorder.finalize({ status: 'failed', safeError: 'Session is missing a valid model' });
      if (nextQueuedMessageId(failedMessages)) await this.armQueueRetry();
      return;
    }
    let phase: DispatchPhase = 'preparing';
    let credentialsPrepared = false;
    const preparationGeneration = this.worktreeChanges.beginPreparation();
    try {
      validateControlSessionOptions(metadata);
      const session = { sessionId, kiloSessionId, directory: this.directory(metadata) };
      const attachments =
        intent.turn.type === 'prompt'
          ? await wait(() =>
              buildSignedPromptAttachments({
                env: this.env,
                userId: metadata.identity.userId,
                sessionId,
                attachments: intent.turn.type === 'prompt' ? intent.turn.attachments : undefined,
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
      if (!this.terminalLifecycle.getAttachedWrapperInstanceId()) {
        recorder.onProgress('workspace_setup', 'Preparing environment…');
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
          await this.failDelivery(messageId, 'preparation_timeout', wrapperInstanceId);
          return;
        }
        const provision = provisionPreparingStep(observed.physical, allowCreate);
        if (provision) recorder.onProgress(provision.step, provision.message);
        status = await ensureReady();
        if (!isCurrent()) {
          if (!this.terminalLifecycle.isCurrent(epoch))
            await this.compensateSessionAttachment(metadata);
          return;
        }
        recordRuntime(status.wrapperInstanceId);
      }
      const boot = bootPreparingStep(status.physical, status.connection);
      if (boot) recorder.onProgress(boot.step, boot.message);
      const disposition = controlDispatchDisposition(status);
      if (disposition.action === 'fail') {
        await this.failDelivery(messageId, disposition.reason, wrapperInstanceId);
        return;
      }
      if (disposition.action === 'wait') {
        await this.armQueueRetry(Math.min(deadlineAt, Date.now() + QUEUE_RETRY_MS));
        return;
      }
      if (!wrapperInstanceId) throw new Error('Wrapper identity is missing');
      const needsPreparation =
        this.terminalLifecycle.getAttachedWrapperInstanceId() !== wrapperInstanceId;
      if (needsPreparation || status.attachment?.kilo?.containmentEnabled === false) {
        if (needsPreparation) recorder.onProgress('workspace_setup', 'Setting up workspace…');
        if (!status.attachment?.kilo)
          throw new Error('Contained session attachment is unavailable');
        const attachPayload = {
          ...status.attachment,
          ...(needsPreparation
            ? { preparation: { attemptId: recorder.attemptId, triggerMessageId: messageId } }
            : {}),
        };
        phase = 'attach';
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
        await dispatch('attach', () =>
          wait(
            async () =>
              sessionAttachResultSchema.parse(
                controlRequestResult(
                  await control.request({
                    operation: 'session.attach',
                    session,
                    expectedWrapperInstanceId: wrapperInstanceId,
                    payload: attachPayload,
                    timeoutMs: SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
                  })
                )
              ),
            SANDBOX_CONTROL_ATTACH_TIMEOUT_MS
          )
        );
        if (!isCurrent()) {
          if (!this.terminalLifecycle.isCurrent(epoch))
            await this.compensateSessionAttachment(metadata);
          return;
        }
      }
      const attachedRuntime = await wait(() => control.getStatus());
      if (!isCurrent()) return;
      if (
        attachedRuntime.physical !== 'running' ||
        attachedRuntime.connection !== 'ready' ||
        attachedRuntime.wrapperInstanceId !== wrapperInstanceId
      )
        throw new Error('Wrapper changed during session attachment');
      this.terminalLifecycle.recordAttachment({ metadata, sandboxId, wrapperInstanceId, epoch });
      recorder.finalize({ status: 'completed' });
      this.worktreeChanges.attached(preparationGeneration, this.worktreeContext(metadata));
      phase = 'prompt';
      await dispatch('prompt', async () => {
        const prompt = await wait(async () =>
          controlRequestResult(
            await control.request({
              operation: 'session.prompt',
              session,
              expectedWrapperInstanceId: wrapperInstanceId,
              payload: {
                messageId,
                turn:
                  intent.turn.type === 'command'
                    ? {
                        type: 'command',
                        command: intent.turn.command,
                        arguments: intent.turn.arguments,
                      }
                    : { type: 'prompt', prompt: intent.turn.prompt },
                agent: {
                  mode: intent.agent.mode,
                  ...(model !== undefined ? { model } : {}),
                  ...(intent.agent.variant !== undefined ? { variant: intent.agent.variant } : {}),
                },
                ...(intent.finalization ? { finalization: intent.finalization } : {}),
                ...(attachments.length ? { attachments } : {}),
              },
            })
          )
        );
        const result = sessionPromptResultSchema.parse(prompt);
        if (result.messageId !== messageId)
          throw new Error('Prompt response message identity mismatch');
      });
      if (!isCurrent()) {
        if (!this.terminalLifecycle.isCurrent(epoch))
          await this.compensateSessionAttachment(metadata);
        return;
      }
      const accepted = acceptQueuedMessage(this.loadMessages(), messageId, Date.now());
      if (!accepted || !this.saveMessages(accepted, epoch)) return;
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
      await this.recordDeliveryFailure({
        messageId,
        epoch,
        phase,
        wrapperInstanceId,
        deadlineAt,
        error,
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
    return wrapperInstanceId === undefined || message?.wrapperInstanceId === wrapperInstanceId
      ? message
      : undefined;
  }

  private async recordDeliveryFailure(input: {
    messageId: string;
    epoch: number;
    phase: DispatchPhase;
    wrapperInstanceId?: string;
    deadlineAt: number;
    error: unknown;
  }): Promise<void> {
    const { messageId, epoch, phase, wrapperInstanceId, deadlineAt, error } = input;
    const message = this.queuedMessage(messageId, epoch, wrapperInstanceId);
    if (!message) return;
    const rejection = error instanceof ControlRequestError && error.code !== 'runtime_unhealthy';
    const scope = rejection && !message.unresolvedDispatch ? 'message' : 'runtime';
    if (Date.now() >= deadlineAt) {
      await this.failDelivery(messageId, 'preparation_timeout', wrapperInstanceId, scope);
      return;
    }
    const busy = rejection && error.code === 'session_busy';
    const updated =
      phase === 'preparing' || busy
        ? undefined
        : incrementDeliveryFailure(this.loadMessages(), messageId, phase);
    const messages = (updated?.messages ?? this.loadMessages()).map(
      (message): MessageRecord =>
        message.messageId === messageId ? { ...message, deliveryRetryScope: scope } : message
    );
    if (!this.saveMessages(messages, epoch)) return;
    if (isRetryableDeliveryError(error) && !updated?.exhausted) {
      await this.armQueueRetry(Math.min(deadlineAt, Date.now() + QUEUE_RETRY_MS));
      return;
    }
    await this.failDelivery(
      messageId,
      phase === 'prompt'
        ? 'prompt_exhausted'
        : phase === 'attach'
          ? 'attach_exhausted'
          : 'environment_failed',
      wrapperInstanceId,
      scope
    );
  }

  private retainRuntimeCleanup(
    metadata: SessionMetadata,
    wrapperInstanceId: string,
    reason: string
  ): void {
    const sandboxId = metadata.workspace?.sandboxId;
    if (!sandboxId) return;
    const pending = this.pendingRuntimeCleanup();
    if (pending && pending.wrapperInstanceId !== wrapperInstanceId) return;
    this.ctx.storage.kv.put(PENDING_RUNTIME_CLEANUP_KEY, {
      ownerId: metadata.identity.userId,
      sessionId: metadata.identity.sessionId,
      sandboxId,
      wrapperInstanceId,
      reason,
    });
    this.terminalLifecycle.invalidateRuntime({ sandboxId, wrapperInstanceId, confirmed: false });
  }

  private pendingRuntimeCleanup() {
    const raw = this.ctx.storage.kv.get<unknown>(PENDING_RUNTIME_CLEANUP_KEY);
    return raw === undefined ? undefined : pendingRuntimeCleanupSchema.parse(raw);
  }

  private async transferRuntimeCleanup(): Promise<boolean> {
    const pending = this.pendingRuntimeCleanup();
    if (!pending) return true;
    await this.armQueueRetry(Date.now() + SANDBOX_CONTROL_REQUEST_TIMEOUT_MS);
    try {
      const response = await withTimeout(
        withDORetry(
          () => sandboxControlRpc(this.env, pending.sandboxId),
          control =>
            control.quarantineRuntime({
              ownerId: pending.ownerId,
              sessionId: pending.sessionId,
              wrapperInstanceId: pending.wrapperInstanceId,
              reason: pending.reason,
            }),
          'quarantineRuntime'
        ),
        SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
        'Runtime quarantine timed out'
      );
      if (typeof response?.quarantined !== 'boolean')
        throw new Error('Invalid quarantine response');
      if (this.pendingRuntimeCleanup()?.wrapperInstanceId === pending.wrapperInstanceId) {
        this.ctx.storage.kv.delete(PENDING_RUNTIME_CLEANUP_KEY);
      }
      return this.pendingRuntimeCleanup() === undefined;
    } catch {
      logger.withFields({ sessionId: this.sessionId }).warn('Runtime quarantine transfer failed');
      await this.armQueueRetry(Date.now() + SANDBOX_CONTROL_REQUEST_TIMEOUT_MS);
      return false;
    }
  }

  private async failDelivery(
    messageId: string,
    reason: string,
    wrapperInstanceId?: string,
    scope: 'message' | 'runtime' = 'runtime'
  ): Promise<void> {
    const epoch = this.terminalLifecycle.captureEpoch();
    const metadata = this.terminalLifecycle.getStoredMetadata();
    const message = this.loadMessages().find(item => item.messageId === messageId);
    if (
      epoch === null ||
      !metadata ||
      !message ||
      (message.state !== 'queued' && message.state !== 'accepted') ||
      message.wrapperInstanceId !== wrapperInstanceId
    )
      return;
    if (scope === 'message') {
      const messages = failQueuedMessage(this.loadMessages(), messageId, reason);
      if (!messages || !this.saveMessages(messages, epoch)) return;
      if (nextQueuedMessageId(messages)) await this.armQueueRetry();
      return;
    }
    if (wrapperInstanceId) this.retainRuntimeCleanup(metadata, wrapperInstanceId, reason);
    await this.failWaitingMessages(reason, wrapperInstanceId);
    if (this.pendingRuntimeCleanup()) await this.transferRuntimeCleanup();
  }

  async failWaitingMessages(reason: string, wrapperInstanceId?: string): Promise<void> {
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return;
    const before = this.loadMessages();
    if (!this.terminalLifecycle.isCurrent(epoch)) return;
    const { messages, failedIds } = applyFailWaitingMessages(before, reason, wrapperInstanceId);
    if (failedIds.length === 0 || !this.saveMessages(messages, epoch)) return;
    if (this.pendingRuntimeCleanup() || nextQueuedMessageId(this.loadMessages()))
      await this.armQueueRetry();
  }

  private broadcastStoredEvent(event: StoredEvent): void {
    if (this.terminalLifecycle.captureEpoch() === null) return;
    const sessionId = this.requireSessionId();
    createStreamHandler(this.ctx, this.eventQueries, sessionId).broadcastEvent(event);
  }

  private async armQueueRetry(when = Date.now() + QUEUE_RETRY_MS): Promise<void> {
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null && !this.pendingRuntimeCleanup()) return;
    const existing = await this.ctx.storage.getAlarm();
    if (
      (epoch === null || !this.terminalLifecycle.isCurrent(epoch)) &&
      !this.pendingRuntimeCleanup()
    )
      return;
    if (existing === null || existing > when) await this.ctx.storage.setAlarm(when);
  }

  private readPendingInteractions(): PendingInteractions | undefined {
    const parsed = pendingInteractionsSchema.safeParse(
      this.ctx.storage.kv.get<unknown>(PENDING_INTERACTIONS_KEY)
    );
    return parsed.success ? parsed.data : undefined;
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
    return current?.state === 'accepted' && current.wrapperInstanceId === message.wrapperInstanceId;
  }

  private async syncAcceptedMessage(
    message: MessageRecord,
    epoch: number,
    trigger: 'accepted_alarm' | 'pending_interactions'
  ): Promise<SessionSyncResult | undefined> {
    const startedAt = Date.now();
    const diagnostic: ControlDiagnosticFields = {
      sessionId: this.sessionId,
      messageId: message.messageId,
      expectedWrapperInstanceId: message.wrapperInstanceId,
      epoch,
      trigger,
      stage: 'runtime_context',
      timeoutMs: SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
      timedOut: false,
    };
    let outcome: 'synced' | 'superseded' | 'failed' = 'failed';
    logControlDiagnostic('session_sync', { ...diagnostic, phase: 'started' });
    try {
      const metadata = this.terminalLifecycle.getStoredMetadata();
      const sandboxId = metadata?.workspace?.sandboxId;
      const kiloSessionId = metadata?.auth.kiloSessionId;
      diagnostic.sandboxId = sandboxId;
      diagnostic.kiloSessionId = kiloSessionId;
      diagnostic.worktreeId = metadata?.workspace?.worktreeId;
      if (
        !metadata ||
        !sandboxId ||
        !kiloSessionId ||
        !message.wrapperInstanceId ||
        this.pendingRuntimeCleanup()
      ) {
        diagnostic.reason = !metadata
          ? 'missing_metadata'
          : !sandboxId
            ? 'missing_sandbox'
            : !kiloSessionId
              ? 'missing_kilo_session'
              : !message.wrapperInstanceId
                ? 'missing_wrapper_identity'
                : 'cleanup_pending';
        throw new Error('Accepted runtime is unavailable');
      }
      const control = sandboxControlRpc(this.env, sandboxId);
      diagnostic.stage = 'runtime_status';
      const status = await withTimeout(
        control.getStatus(),
        SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
        'Runtime status timed out',
        () => {
          diagnostic.timedOut = true;
        }
      );
      if (!this.isCurrentAcceptedMessage(message, epoch)) {
        outcome = 'superseded';
        diagnostic.reason = 'accepted_message_changed';
        return undefined;
      }
      diagnostic.stage = 'runtime_identity';
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
      diagnostic.wrapperMatches = observedWrapperId === message.wrapperInstanceId;
      if (
        status.connection !== 'ready' ||
        status.physical !== 'running' ||
        status.wrapperInstanceId !== message.wrapperInstanceId
      ) {
        diagnostic.reason =
          status.connection !== 'ready'
            ? 'connection_not_ready'
            : status.physical !== 'running'
              ? 'physical_not_running'
              : 'wrapper_mismatch';
        throw new Error('Accepted runtime is not ready');
      }
      diagnostic.stage = 'read_interactions';
      const revision = this.readPendingInteractions()?.revision;
      diagnostic.interactionRevision = revision;
      diagnostic.stage = 'sync_request';
      const response = await withTimeout(
        control.request({
          operation: 'session.sync',
          expectedWrapperInstanceId: message.wrapperInstanceId,
          session: {
            sessionId: metadata.identity.sessionId,
            kiloSessionId,
            directory: this.directory(metadata),
          },
          payload: {},
        }),
        SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
        'Session sync timed out',
        () => {
          diagnostic.timedOut = true;
        }
      );
      if (!this.isCurrentAcceptedMessage(message, epoch)) {
        outcome = 'superseded';
        diagnostic.reason = 'accepted_message_changed';
        return undefined;
      }
      diagnostic.requestId = response?.requestId;
      diagnostic.responseOk = typeof response?.ok === 'boolean' ? response.ok : undefined;
      if (!response.ok) {
        diagnostic.reason = 'sync_rejected';
        const errorCode = response.error?.code;
        diagnostic.errorCode = controlErrorCodes.some(code => code === errorCode)
          ? errorCode
          : 'other';
        diagnostic.retryable =
          typeof response.error?.retryable === 'boolean' ? response.error.retryable : undefined;
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
      const result = metadata.workspace?.worktreeId
        ? {
            ...parsed,
            questions: parsed.questions.filter(belongsToRoot),
            permissions: parsed.permissions.filter(belongsToRoot),
          }
        : parsed;
      diagnostic.questionCount = result.questions.length;
      diagnostic.permissionCount = result.permissions.length;
      diagnostic.stage = 'interaction_revision';
      const applyInteractions = this.readPendingInteractions()?.revision === revision;
      diagnostic.interactionSnapshotApplied = false;
      if (applyInteractions) {
        diagnostic.stage = 'persist_interactions';
        this.ctx.storage.kv.put(PENDING_INTERACTIONS_KEY, {
          revision: (revision ?? 0) + 1,
          questions: result.questions,
          permissions: result.permissions,
        });
        diagnostic.interactionSnapshotApplied = true;
      }
      diagnostic.stage = 'persist_status';
      persistSandboxControlSessionEvent({
        sessionId: metadata.identity.sessionId,
        payload: {
          type: 'session.status',
          properties: { sessionID: kiloSessionId, status: result.status },
        },
        eventQueries: this.eventQueries,
        broadcast: event => this.broadcastStoredEvent(event),
      });
      outcome = 'synced';
      return result;
    } catch (error) {
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

  private async derivePendingInteractions(): Promise<
    { questions: unknown[]; permissions: unknown[] } | undefined
  > {
    const epoch = this.terminalLifecycle.captureEpoch();
    if (epoch === null) return undefined;
    const accepted = this.loadMessages().find(message => message.state === 'accepted');
    if (accepted) {
      try {
        await this.syncAcceptedMessage(accepted, epoch, 'pending_interactions');
      } catch {
        logger
          .withFields({ sessionId: this.sessionId })
          .warn('Pending interaction sync unavailable');
      }
    }
    if (!this.terminalLifecycle.isCurrent(epoch)) return undefined;
    const snapshot = this.readPendingInteractions();
    return snapshot
      ? { questions: snapshot.questions, permissions: snapshot.permissions }
      : undefined;
  }

  private async deriveQueuedMessages() {
    return streamQueuedSnapshots(this.loadMessages(), Date.now());
  }

  private async deriveCloudStatus() {
    return streamCloudStatus(this.loadMessages());
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
    if (!this.terminalLifecycle.isCurrent(epoch) || this.pendingRuntimeCleanup()) {
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
    if (!this.terminalLifecycle.isCurrent(epoch) || this.pendingRuntimeCleanup()) {
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
      this.pendingRuntimeCleanup() ||
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
    if (this.pendingRuntimeCleanup()?.wrapperInstanceId === wrapperInstanceId) return false;
    const messages = this.loadMessages();
    const current =
      messages.find(message => message.state === 'accepted') ??
      messages.find(message => message.state === 'queued');
    const expected =
      current?.wrapperInstanceId ??
      messages.findLast(message => message.wrapperInstanceId)?.wrapperInstanceId;
    return expected === undefined || expected === wrapperInstanceId;
  }

  private loadMessages(): MessageRecord[] {
    if (this.deletedWorktreeId || this.terminalLifecycle.isBlocked()) return [];
    return this.ctx.storage.kv.get<MessageRecord[]>(MESSAGES_KEY) ?? [];
  }

  private saveMessages(
    messages: MessageRecord[],
    epoch?: number,
    source: 'coordinator' | 'wrapper_outcome' = 'coordinator'
  ): boolean {
    const currentEpoch = epoch ?? this.terminalLifecycle.captureEpoch();
    if (
      this.deletedWorktreeId ||
      currentEpoch === null ||
      !this.terminalLifecycle.isCurrent(currentEpoch)
    )
      return false;
    const events: StoredEvent[] = [];
    const committed: ControlDiagnosticFields[] = [];
    this.ctx.storage.transactionSync(() => {
      const before = this.loadMessages();
      const previousById = new Map(before.map(message => [message.messageId, message]));
      const queuedHeadId = nextQueuedMessageId(before);
      const now = Date.now();
      const next = messages.map(message => {
        const previous = previousById.get(message.messageId);
        if (previous && previous.state !== 'queued' && previous.state !== 'accepted')
          return previous;
        if (message.state === 'queued') return message;
        if (message.state === 'accepted') {
          if (previous?.state !== 'accepted') {
            const event = this.persistMessageLifecycleEvent(message);
            if (event) events.push(event);
            committed.push({
              messageId: message.messageId,
              wrapperInstanceId: message.wrapperInstanceId,
              fromState: previous?.state,
              toState: message.state,
              lifecycleEventInserted: event !== undefined,
            });
          }
          return message;
        }
        const terminal = { ...message, terminalAt: message.terminalAt ?? now };
        if (previous?.state === 'accepted' || queuedHeadId === message.messageId) {
          const interactions = this.readPendingInteractions();
          this.ctx.storage.kv.put(PENDING_INTERACTIONS_KEY, {
            revision: (interactions?.revision ?? 0) + 1,
            questions: [],
            permissions: [],
          });
        }
        const event = this.persistMessageLifecycleEvent(terminal);
        if (event) events.push(event);
        committed.push({
          messageId: terminal.messageId,
          wrapperInstanceId: terminal.wrapperInstanceId,
          fromState: previous?.state,
          toState: terminal.state,
          terminalAt: terminal.terminalAt,
          lifecycleEventInserted: event !== undefined,
          cause: terminal.failedReason ? diagnosticCause(terminal.failedReason) : undefined,
        });
        if (terminal.preparationAttemptId) {
          events.push(
            ...finalizePreparationAttempt(
              this.eventQueries,
              terminal.preparationAttemptId,
              terminal.state === 'completed'
                ? { status: 'completed', timestamp: terminal.terminalAt }
                : {
                    status: 'failed',
                    safeError:
                      terminal.state === 'cancelled'
                        ? 'The message was interrupted'
                        : safeErrorFromQueueReason(terminal.failedReason ?? 'environment_failed'),
                    timestamp: terminal.terminalAt,
                  }
            )
          );
        }
        return terminal;
      });
      this.ctx.storage.kv.put(MESSAGES_KEY, next);
    });
    for (const fields of committed) {
      logControlDiagnostic('session_message_committed', {
        sessionId: this.sessionId,
        source,
        ...fields,
      });
    }
    for (const event of events) this.broadcastStoredEvent(event);
    return true;
  }

  private persistMessageLifecycleEvent(message: MessageRecord): StoredEvent | undefined {
    const accepted = message.state === 'accepted';
    const completed = message.state === 'completed';
    const streamEventType = accepted
      ? 'cloud.message.sent'
      : completed
        ? 'cloud.message.completed'
        : 'cloud.message.failed';
    const sessionId = this.requireSessionId();
    const timestamp = (accepted ? message.acceptedAt : message.terminalAt) ?? Date.now();
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
