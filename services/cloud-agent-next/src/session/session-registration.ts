/**
 * Session creation helpers for the grouped `start` path and retained legacy
 * `prepareSession` path.
 *
 * Both paths allocate canonical IDs and create the session report row before
 * creating the external `cli_sessions_v2` ownership row required
 * by stream-ticket authorization. `start` then asks its Durable Object to
 * register metadata and durably admit the already accepted initial turn through
 * one grouped operation. Legacy
 * `prepareSession` retains registration-only behavior and can queue later.
 *
 * Managed git-token resolution (GitHub App installation, managed GitLab) is
 * NOT performed here; it happens lazily in the flusher's workspace preparation
 * path. Provider credentials are intentionally not stored in registration
 * metadata; generic git repositories may still carry an explicit token.
 */
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import type { WorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import {
  admitOperation,
  markReconcilePending,
  recordOperationProgress,
  settleOperation,
  type OutboxEventInput,
} from '@kilocode/db/operation-ledger';
import type { OperationLedgerRow } from '@kilocode/db/schema';

import type { Env, SandboxId } from '../types.js';
import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import type { CredentialContainment, SessionMetadata } from '../persistence/session-metadata.js';
import { logger } from '../logger.js';
import { withDORetry } from '../utils/do-retry.js';
import { getPgDb } from '../db/pg.js';
import { generateSessionId, SessionService } from '../session-service.js';
import {
  createCloudAgentSessionReport,
  recordCloudAgentSandboxIdentity,
  recordCloudAgentSessionFailure,
} from '../telemetry/session-reports.js';
import { generateSandboxRoutingTarget, isOrgInList, type SandboxSelection } from '../sandbox-id.js';
import { resolveSharedSandboxAssignment } from '../shared-sandbox-route.js';
import { generateKiloSessionId } from '../utils/kilo-session-id.js';
import { createMessageId } from './message-id.js';
import type { MessageResultRPCResponse } from './message-result.js';
import type {
  AcceptedExecutionTurn,
  ExecutionTurnSubmission,
  SessionMessageAdmissionResult,
} from '../execution/types.js';
import { throwAdmissionError } from './queue-message.js';
import type { SessionCreateRequest } from './session-requests.js';

export type SessionRegistrationInput = SessionCreateRequest;

type SharedSandboxRouteMetadata = NonNullable<
  NonNullable<SessionMetadata['workspace']>['sandboxRoute']
>;

export type SessionRegistrationContext = {
  env: Env;
  userId: string;
  authToken: string;
  botId?: string;
};

export type SessionRegistrationResult = {
  cloudAgentSessionId: string;
  kiloSessionId: string;
  sandboxId: SandboxId;
  sandboxRoute?: SharedSandboxRouteMetadata;
  sandboxProvider: SandboxSelection['provider'];
  /**
   * Canonical initial turn reserved for a later legacy initiation request.
   */
  initialTurn: AcceptedExecutionTurn;
};

export type StartedSessionResult = Omit<SessionRegistrationResult, 'initialTurn'> & {
  admission: Extract<SessionMessageAdmissionResult, { success: true }>;
};

function acceptInitialTurn(initialTurn: ExecutionTurnSubmission): AcceptedExecutionTurn {
  const messageId = initialTurn.id ?? createMessageId();
  return initialTurn.type === 'prompt'
    ? {
        type: 'prompt',
        messageId,
        prompt: initialTurn.prompt,
        attachments: initialTurn.attachments,
      }
    : {
        type: 'command',
        messageId,
        command: initialTurn.command,
        arguments: initialTurn.arguments,
      };
}

export function executionTurnSubmissionFromAcceptedTurn(
  turn: AcceptedExecutionTurn
): ExecutionTurnSubmission {
  return turn.type === 'prompt'
    ? {
        type: 'prompt',
        id: turn.messageId,
        prompt: turn.prompt,
        attachments: turn.attachments,
      }
    : {
        type: 'command',
        id: turn.messageId,
        command: turn.command,
        arguments: turn.arguments,
      };
}

export type SessionEstablishmentFailure =
  | { stage: 'sandbox_identity'; code: 'sandbox_id_derivation_failed' }
  | { stage: 'registration'; code: 'do_registration_rejected' }
  | {
      stage: 'initial_admission';
      code: 'initial_admission_rejected' | 'initial_queue_full' | 'invalid_initial_intent';
    }
  | { stage: 'transport'; code: 'do_rpc_outcome_unknown' };

type NewSessionAllocation = SessionRegistrationResult & {
  credentialContainment: CredentialContainment;
  sessionService: SessionService;
  rollbackCliSession: () => Promise<void>;
};

// ----- operation-ledger boundary (P1-A-08b) -----------------------------------

/**
 * Allocation failure stages reported to the operation ledger, matching the
 * `session_create_settled` `failure_stage` enum for pre-DO work.
 */
type SessionLedgerAllocationFailureStage = 'report' | 'sandbox' | 'ownership_row';

/** Session ledger `failure_stage` values (allocation + DO rejection). */
export type SessionLedgerFailureStage =
  | SessionLedgerAllocationFailureStage
  | 'registration'
  | 'initial_admission';

/**
 * Optional ledger hooks threaded through creation so the create effect records
 * progress and settles the operation exactly once. All hooks are best-effort:
 * a ledger write failure must never mask the primary creation outcome.
 */
export type SessionCreationLedgerHooks = {
  db: WorkerDb;
  rowId: string;
  /** Allocation failed after ID generation (report write, sandbox, ownership row). */
  onAllocationFailure: (stage: SessionLedgerAllocationFailureStage) => Promise<void>;
  /** The DO RPC threw; the commit outcome is unknown. */
  onTransportFailure: () => Promise<void>;
  /** The DO explicitly rejected registration or the initial admission. */
  onExplicitRejection: (
    failure: Extract<
      SessionEstablishmentFailure,
      { stage: 'registration' } | { stage: 'initial_admission' }
    >
  ) => Promise<void>;
  /** The DO confirmed registration and initial message admission. */
  onSuccess: (result: StartedSessionResult) => Promise<void>;
};

/** Result returned to the prepare handler for ledger-guarded creates. */
export type LedgerSessionCreateResult = {
  cloudAgentSessionId: string;
  kiloSessionId: string;
  replayed?: boolean;
};

export type SessionLedgerCreateOptions = {
  billingOrigin?: string;
  operationKey: string;
  /** Epoch ms when the user intent started, used for the outbox duration. */
  startedAt: number;
};

/** Lease for the `admitted` create claim (retry window). */
const SESSION_CREATE_LEDGER_LEASE_SECONDS = 120;

/** Carries the allocation failure stage so the ledger can settle it. */
class SessionAllocationStageError extends Error {
  readonly stage: SessionLedgerAllocationFailureStage;

  constructor(stage: SessionLedgerAllocationFailureStage, cause: unknown) {
    super('Session allocation failed', { cause });
    this.name = 'SessionAllocationStageError';
    this.stage = stage;
  }
}

/** Re-throws the original error on the legacy path and the tagged error on the ledger path. */
function rethrowAllocationFailure(
  ledger: SessionCreationLedgerHooks | undefined,
  stage: SessionLedgerAllocationFailureStage,
  error: unknown
): never {
  if (ledger) {
    throw new SessionAllocationStageError(stage, error);
  }
  throw error;
}

/** tRPC CONFLICT with the stable `creation_in_progress` message (plan P1-A-08b). */
function creationInProgressError(): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message: 'creation_in_progress' });
}

/**
 * Best-effort ledger write: a failure is logged and never masks the primary
 * creation outcome. The row then stays `admitted`/`reconcile_pending` and the
 * same-key retry ladder recovers it.
 */
async function bestEffortLedgerWrite(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    logger
      .withFields({ error: error instanceof Error ? error.message : String(error) })
      .warn('Failed to write session create operation ledger row');
  }
}

/** Resolves the analytics identity channel (user email); falls back to the user id. */
async function resolveSessionCreateDistinctId(db: WorkerDb, userId: string): Promise<string> {
  try {
    const [user] = await db
      .select({ email: kilocode_users.google_user_email })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId))
      .limit(1);
    return user?.email ?? userId;
  } catch (error) {
    logger
      .withFields({ error: error instanceof Error ? error.message : String(error) })
      .warn('Failed to resolve user email for session create outbox event');
    return userId;
  }
}

type SessionCreateSettledOutcome = 'completed' | 'failed';

function sessionCreateSettledOutboxEvent(params: {
  distinctId: string;
  outcome: SessionCreateSettledOutcome;
  admission: 'new' | 'takeover';
  failureStage?: SessionLedgerFailureStage;
  startedAt: number;
  inOrganization: boolean;
}): OutboxEventInput {
  return {
    eventName: 'session_create_settled',
    distinctId: params.distinctId,
    properties: {
      source: 'server',
      surface: 'session',
      phase: 'terminal',
      creation_target: 'cloud',
      outcome: params.outcome,
      admission: params.admission,
      ...(params.failureStage ? { failure_stage: params.failureStage } : {}),
      duration_ms: Math.max(0, Date.now() - params.startedAt),
      in_organization: params.inOrganization,
    },
  };
}

function initialAdmissionFailure(
  result: Extract<SessionMessageAdmissionResult, { success: false }>
): Extract<SessionEstablishmentFailure, { stage: 'initial_admission' }> {
  if (result.code === 'PENDING_QUEUE_FULL') {
    return { stage: 'initial_admission', code: 'initial_queue_full' };
  }
  if (result.code === 'BAD_REQUEST') {
    return { stage: 'initial_admission', code: 'invalid_initial_intent' };
  }
  return { stage: 'initial_admission', code: 'initial_admission_rejected' };
}

async function recordPostSetupFailure(record: () => Promise<void>): Promise<void> {
  try {
    await record();
  } catch {
    logger.warn('Failed to record Cloud Agent setup failure after Durable Object outcome');
  }
}

async function allocateNewSession(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext,
  options?: { billingOrigin?: string },
  ledger?: SessionCreationLedgerHooks
): Promise<NewSessionAllocation> {
  const sessionService = new SessionService();
  const initialTurn = acceptInitialTurn(input.initialTurn);
  const cloudAgentSessionId = generateSessionId();
  const kiloSessionId = generateKiloSessionId();
  const createdOnPlatform = input.options?.createdOnPlatform ?? 'cloud-agent';

  try {
    if (ledger) {
      // Record progress immediately after ID generation (plan P1-A-08b step 3):
      // the ladder treats missing IDs as "nothing external happened". A failure
      // here still fails the create at the report allocation stage and settles
      // the admitted row so the client gets a terminal result.
      await recordOperationProgress(ledger.db, ledger.rowId, {
        cloudAgentSessionId,
        kiloSessionId,
        initialMessageId: initialTurn.messageId,
      });
    }

    await createCloudAgentSessionReport(
      { cloudAgentSessionId, kiloSessionId, initialMessageId: initialTurn.messageId },
      ctx.env
    );
  } catch (error) {
    rethrowAllocationFailure(ledger, 'report', error);
  }

  const orgId = input.options?.kilocodeOrganizationId;
  const devcontainerRequested = input.runtime?.devcontainer === true;
  const credentialContainment: CredentialContainment = {
    github:
      !devcontainerRequested &&
      input.repository.type === 'github' &&
      isOrgInList(ctx.env.GITHUB_TOKEN_CONTAINMENT_ORG_IDS, orgId),
    gitlab:
      !devcontainerRequested &&
      input.repository.type === 'gitlab' &&
      isOrgInList(ctx.env.GITLAB_TOKEN_CONTAINMENT_ORG_IDS, orgId),
    bitbucket:
      !devcontainerRequested &&
      input.repository.type === 'bitbucket' &&
      isOrgInList(ctx.env.BITBUCKET_TOKEN_CONTAINMENT_ORG_IDS, orgId),
    kilocode:
      !devcontainerRequested && isOrgInList(ctx.env.KILOCODE_TOKEN_CONTAINMENT_ORG_IDS, orgId),
  };
  let sandboxId: SandboxId;
  let sandboxRoute: SharedSandboxRouteMetadata | undefined;
  let sandboxProvider: SandboxSelection['provider'] = 'cloudflare';
  try {
    const target = await generateSandboxRoutingTarget(
      ctx.env.PER_SESSION_SANDBOX_ORG_IDS,
      orgId,
      ctx.userId,
      cloudAgentSessionId,
      ctx.botId,
      {
        devcontainer: input.runtime?.devcontainer,
        createdOnPlatform: options?.billingOrigin === 'code-review' ? 'code-review' : undefined,
      }
    );
    if (target.kind === 'shared') {
      const assignment = await resolveSharedSandboxAssignment(
        ctx.env.SHARED_SANDBOX_OVERRIDES,
        target.routeKey
      );
      sandboxId = assignment.sandboxId;
      sandboxRoute = {
        kind: 'shared',
        routeKey: target.routeKey,
        ...(assignment.suffix ? { suffix: assignment.suffix } : {}),
      };
    } else {
      sandboxId = target.sandboxId;
      sandboxProvider = 'cloudflare';
    }
  } catch (error) {
    await recordPostSetupFailure(() =>
      recordCloudAgentSessionFailure(
        {
          cloudAgentSessionId,
          failure: { stage: 'sandbox_identity', code: 'sandbox_id_derivation_failed' },
        },
        ctx.env
      )
    );
    rethrowAllocationFailure(ledger, 'sandbox', error);
  }

  try {
    await recordCloudAgentSandboxIdentity({ cloudAgentSessionId, sandboxId }, ctx.env);
  } catch (error) {
    rethrowAllocationFailure(ledger, 'sandbox', error);
  }

  logger.setTags({
    cloudAgentSessionId,
    kiloSessionId,
    userId: ctx.userId,
    orgId: input.options?.kilocodeOrganizationId ?? '(personal)',
    sandboxId,
  });
  logger.info('Creating new session ownership row');

  const defaultTitle = `New session - ${new Date().toISOString()}`;
  try {
    await sessionService.createCliSessionViaSessionIngest(
      kiloSessionId,
      cloudAgentSessionId,
      ctx.userId,
      ctx.env,
      input.options?.kilocodeOrganizationId,
      createdOnPlatform,
      defaultTitle
    );
  } catch (error) {
    await recordPostSetupFailure(() =>
      recordCloudAgentSessionFailure(
        {
          cloudAgentSessionId,
          failure: { stage: 'transport', code: 'do_rpc_outcome_unknown' },
        },
        ctx.env
      )
    );
    rethrowAllocationFailure(ledger, 'ownership_row', error);
  }

  return {
    cloudAgentSessionId,
    kiloSessionId,
    sandboxId,
    sandboxRoute,
    sandboxProvider,
    initialTurn,
    credentialContainment,
    sessionService,
    rollbackCliSession: async () => {
      try {
        await sessionService.deleteCliSessionViaSessionIngest(kiloSessionId, ctx.userId, ctx.env, {
          onlyIfEmpty: true,
        });
      } catch (rollbackError: unknown) {
        logger
          .withFields({
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          })
          .error('Failed to rollback cli_sessions_v2 record');
      }
    },
  };
}

function buildSessionRegistrationCommand(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext,
  allocation: NewSessionAllocation,
  options?: { billingOrigin?: string }
) {
  return {
    identity: {
      sessionId: allocation.cloudAgentSessionId,
      userId: ctx.userId,
      orgId: input.options?.kilocodeOrganizationId,
      botId: ctx.botId,
      createdOnPlatform: input.options?.createdOnPlatform,
      billingOrigin: options?.billingOrigin,
    },
    auth: {
      kiloSessionId: allocation.kiloSessionId,
      kilocodeToken: ctx.authToken,
    },
    message: {
      initialMessageId: allocation.initialTurn.messageId,
      turn: executionTurnSubmissionFromAcceptedTurn(allocation.initialTurn),
    },
    agent: {
      ...input.agent,
      appendSystemPrompt: input.profile?.overrides?.appendSystemPrompt,
    },
    repository: input.repository,
    profile: input.profile?.resolved,
    finalization: input.finalization,
    callback: input.options?.callbackTarget ? { target: input.options.callbackTarget } : undefined,
    workspace: {
      sandboxId: allocation.sandboxId,
      sandboxProvider: allocation.sandboxProvider,
      shallow: input.options?.shallow,
      ...(allocation.sandboxRoute ? { sandboxRoute: allocation.sandboxRoute } : {}),
      credentialContainment: allocation.credentialContainment,
      ...(input.runtime?.devcontainer ? { devcontainerRequested: true } : {}),
    },
  };
}

/**
 * Register a new cloud-agent session for a retained legacy preparation flow.
 * No initial turn is admitted until a subsequent initiation request queues it.
 * This non-idempotent RPC is issued once: explicit rejection triggers best-effort
 * empty ownership-row compensation, while thrown/unknown outcomes retain the
 * ownership row because the metadata write may have committed.
 */
export async function registerNewSession(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext,
  options?: { billingOrigin?: string }
): Promise<SessionRegistrationResult> {
  const allocation = await allocateNewSession(input, ctx, options);
  const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(
    `${ctx.userId}:${allocation.cloudAgentSessionId}`
  );
  const stub = ctx.env.CLOUD_AGENT_SESSION.get(doId);
  let registerResult: Awaited<ReturnType<typeof stub.registerSession>>;
  try {
    registerResult = await stub.registerSession(
      buildSessionRegistrationCommand(input, ctx, allocation, options)
    );
  } catch (error) {
    await recordPostSetupFailure(() =>
      recordCloudAgentSessionFailure(
        {
          cloudAgentSessionId: allocation.cloudAgentSessionId,
          failure: { stage: 'transport', code: 'do_rpc_outcome_unknown' },
        },
        ctx.env
      )
    );
    throw error;
  }

  if (!registerResult.success) {
    const failure = { stage: 'registration', code: 'do_registration_rejected' } as const;
    await recordPostSetupFailure(() =>
      recordCloudAgentSessionFailure(
        { cloudAgentSessionId: allocation.cloudAgentSessionId, failure },
        ctx.env
      )
    );
    await allocation.rollbackCliSession();
    logger.withFields({ error: registerResult.error }).error('Failed to register session in DO');
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: registerResult.error ?? 'Failed to register session',
    });
  }

  logger.info('Session registered for lazy preparation');
  return allocation;
}

/**
 * Create a new session and ask its Durable Object to register metadata and
 * durably admit the canonical initial turn. The ownership row is an external
 * prerequisite; an explicit Durable Object rejection triggers best-effort
 * `onlyIfEmpty` deletion of that row. RPC retries use the same DO key and
 * canonical message identity; an unrecovered transport error leaves the row in
 * place because the Durable Object commit outcome is unknown and may require
 * later operational cleanup.
 */
export async function startNewSession(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext,
  options?: { billingOrigin?: string },
  ledger?: SessionCreationLedgerHooks
): Promise<StartedSessionResult> {
  let allocation: NewSessionAllocation;
  try {
    allocation = await allocateNewSession(input, ctx, options, ledger);
  } catch (error) {
    if (ledger && error instanceof SessionAllocationStageError) {
      await ledger.onAllocationFailure(error.stage);
      throw error.cause;
    }
    throw error;
  }
  const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(
    `${ctx.userId}:${allocation.cloudAgentSessionId}`
  );
  let admission: SessionMessageAdmissionResult;
  try {
    admission = await withDORetry<
      DurableObjectStub<CloudAgentSession>,
      SessionMessageAdmissionResult
    >(
      () => ctx.env.CLOUD_AGENT_SESSION.get(doId),
      stub =>
        stub.createSessionWithInitialAdmission({
          ...buildSessionRegistrationCommand(input, ctx, allocation, options),
          message: { initialTurn: allocation.initialTurn },
        }),
      'createSessionWithInitialAdmission'
    );
  } catch (error) {
    await recordPostSetupFailure(() =>
      recordCloudAgentSessionFailure(
        {
          cloudAgentSessionId: allocation.cloudAgentSessionId,
          failure: { stage: 'transport', code: 'do_rpc_outcome_unknown' },
        },
        ctx.env
      )
    );
    if (ledger) {
      await ledger.onTransportFailure();
    }
    throw error;
  }

  if (!admission.success) {
    const failure =
      admission.failureBoundary === 'registration'
        ? ({ stage: 'registration', code: 'do_registration_rejected' } as const)
        : initialAdmissionFailure(admission);
    await recordPostSetupFailure(() =>
      recordCloudAgentSessionFailure(
        { cloudAgentSessionId: allocation.cloudAgentSessionId, failure },
        ctx.env
      )
    );
    await allocation.rollbackCliSession();
    logger
      .withFields({ error: admission.error, resultCode: admission.code })
      .error('Failed to register session and admit initial turn in DO');
    if (ledger) {
      await ledger.onExplicitRejection(failure);
    }
    throwAdmissionError(admission);
  }

  logger.info('Session registered with initial message admitted');
  const result: StartedSessionResult = {
    cloudAgentSessionId: allocation.cloudAgentSessionId,
    kiloSessionId: allocation.kiloSessionId,
    sandboxId: allocation.sandboxId,
    sandboxProvider: allocation.sandboxProvider,
    admission,
  };
  if (ledger) {
    await ledger.onSuccess(result);
  }
  return result;
}

// ----- ledger-guarded session creation (plan P1-A-08b step 3) -----------------

/**
 * Creates a session under the operation ledger. Admit only when the caller
 * (the prepare handler) has already gated on `operationKey` present AND
 * effective `autoInitiate` true.
 *
 * Admission outcomes:
 * - `admitted`: run the create effect and settle completed/failed, or mark
 *   reconcile-pending on an unknown transport outcome.
 * - `duplicate_settled`: replay the canonical result with `replayed: true`.
 * - `duplicate_in_flight`: `CONFLICT` `creation_in_progress`.
 * - `duplicate_reconcile_in_progress`: another retry holds the reconciliation
 *   lease; `CONFLICT` `creation_in_progress`.
 * - `takeover` / `duplicate_reconcile_pending`: reconcile before any effect.
 */
export async function createSessionWithLedger(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext,
  options: SessionLedgerCreateOptions
): Promise<LedgerSessionCreateResult> {
  const db = getPgDb(ctx.env);
  const admission = await admitOperation(db, {
    userId: ctx.userId,
    orgId: input.options?.kilocodeOrganizationId,
    domain: 'session',
    intent: 'create_cloud',
    operationKey: options.operationKey,
    taxonomy: 'safe-retry',
    leaseSeconds: SESSION_CREATE_LEDGER_LEASE_SECONDS,
  });

  switch (admission.admission) {
    case 'admitted':
      return executeLedgerCreate(input, ctx, options, db, admission.row, 'new');
    case 'duplicate_settled':
      return replaySettledCreate(admission.row);
    case 'duplicate_in_flight':
    case 'duplicate_reconcile_in_progress':
      throw creationInProgressError();
    case 'takeover':
    case 'duplicate_reconcile_pending':
      return reconcileLedgerCreate(input, ctx, options, db, admission.row);
  }
}

function replaySettledCreate(row: OperationLedgerRow): LedgerSessionCreateResult {
  // Only a `completed` settle may replay a successful create. Failed, no_op,
  // interrupted, and superseded terminal rows must surface the typed
  // non-retryable failure even when progress recorded canonical IDs before the
  // failure: progress IDs prove allocation, never success.
  if (row.status !== 'completed') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'session_creation_failed' });
  }
  const canonical = row.canonical_result ?? {};
  const cloudAgentSessionId =
    typeof canonical.cloudAgentSessionId === 'string' ? canonical.cloudAgentSessionId : undefined;
  const kiloSessionId =
    typeof canonical.kiloSessionId === 'string' ? canonical.kiloSessionId : undefined;
  if (!cloudAgentSessionId || !kiloSessionId) {
    // A completed settle without canonical IDs has no session to replay. Treat
    // the retry as a fresh intent by surfacing a non-retryable typed rejection
    // so the client clears the key.
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'session_creation_failed' });
  }
  return { cloudAgentSessionId, kiloSessionId, replayed: true };
}

/**
 * Runs the create effect under an already-admitted row and settles it:
 * completed after registration + initial admission, failed on explicit
 * rejection or pre-DO allocation failure, reconcile-pending on an unknown
 * transport outcome. On `takeover`/reconcile rows the settle uses the
 * `takeover` admission kind.
 */
async function executeLedgerCreate(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext,
  options: SessionLedgerCreateOptions,
  db: WorkerDb,
  row: OperationLedgerRow,
  admissionKind: 'new' | 'takeover'
): Promise<LedgerSessionCreateResult> {
  const distinctId = await resolveSessionCreateDistinctId(db, ctx.userId);
  const inOrganization = input.options?.kilocodeOrganizationId != null;

  const hooks: SessionCreationLedgerHooks = {
    db,
    rowId: row.id,
    onAllocationFailure: stage =>
      bestEffortLedgerWrite(() =>
        settleOperation(db, {
          rowId: row.id,
          status: 'failed',
          outcomeCode: stage,
          outboxEvent: sessionCreateSettledOutboxEvent({
            distinctId,
            outcome: 'failed',
            admission: admissionKind,
            failureStage: stage,
            startedAt: options.startedAt,
            inOrganization,
          }),
        })
      ),
    onTransportFailure: () =>
      bestEffortLedgerWrite(() => markReconcilePending(db, { rowId: row.id })),
    onExplicitRejection: failure =>
      bestEffortLedgerWrite(() =>
        settleOperation(db, {
          rowId: row.id,
          status: 'failed',
          outcomeCode: failure.code,
          outboxEvent: sessionCreateSettledOutboxEvent({
            distinctId,
            outcome: 'failed',
            admission: admissionKind,
            failureStage: failure.stage === 'registration' ? 'registration' : 'initial_admission',
            startedAt: options.startedAt,
            inOrganization,
          }),
        })
      ),
    onSuccess: result =>
      bestEffortLedgerWrite(() =>
        settleOperation(db, {
          rowId: row.id,
          status: 'completed',
          outcomeCode: 'ok',
          canonicalResult: {
            cloudAgentSessionId: result.cloudAgentSessionId,
            kiloSessionId: result.kiloSessionId,
          },
          outboxEvent: sessionCreateSettledOutboxEvent({
            distinctId,
            outcome: 'completed',
            admission: admissionKind,
            startedAt: options.startedAt,
            inOrganization,
          }),
        })
      ),
  };

  const result = await startNewSession(input, ctx, { billingOrigin: options.billingOrigin }, hooks);
  return {
    cloudAgentSessionId: result.cloudAgentSessionId,
    kiloSessionId: result.kiloSessionId,
  };
}

/** Looks up the `cli_sessions_v2` ownership row written before the DO call. */
async function findCliSessionOwnershipRow(
  db: WorkerDb,
  userId: string,
  kiloSessionId: string
): Promise<{ sessionId: string } | null> {
  const [row] = await db
    .select({ sessionId: cli_sessions_v2.session_id })
    .from(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.kilo_user_id, userId), eq(cli_sessions_v2.session_id, kiloSessionId))
    )
    .limit(1);
  return row ?? null;
}

/**
 * Reads DO metadata with the standard retry wrapper. A transport failure keeps
 * the row reconcile-pending (`CONFLICT creation_in_progress`) because the DO
 * state is unknown; it must never settle the row.
 */
async function readSessionMetadata(
  ctx: SessionRegistrationContext,
  doId: DurableObjectId
): Promise<SessionMetadata | null> {
  try {
    return await withDORetry(
      () => ctx.env.CLOUD_AGENT_SESSION.get(doId),
      s => s.getMetadata(),
      'getMetadata'
    );
  } catch {
    throw creationInProgressError();
  }
}

/**
 * Takeover / reconcile-pending reconciliation ladder (plan P1-A-08b step 3):
 *   a. No progress IDs → nothing external happened → fresh create under the row.
 *   b. IDs recorded, ownership row absent → the DO never registered → fresh
 *      create under the row.
 *   c. Ownership row present, DO metadata absent → the DO never committed
 *      registration → `onlyIfEmpty` delete of the stale ownership row, then a
 *      fresh create; if the delete refused (row not empty), the session is
 *      live only when the DO authoritatively re-proves registration, and the
 *      ladder falls through to (d) on that re-read.
 *   d. Metadata present → completion requires the recorded `initialMessageId`
 *      to be admitted. Admitted → settle completed (+ outbox) and replay.
 *      Not admitted / not determinable → `CONFLICT` `creation_in_progress`.
 */
async function reconcileLedgerCreate(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext,
  options: SessionLedgerCreateOptions,
  db: WorkerDb,
  row: OperationLedgerRow
): Promise<LedgerSessionCreateResult> {
  const canonical = row.canonical_result ?? {};
  const cloudAgentSessionId =
    typeof canonical.cloudAgentSessionId === 'string' ? canonical.cloudAgentSessionId : undefined;
  const kiloSessionId =
    typeof canonical.kiloSessionId === 'string' ? canonical.kiloSessionId : undefined;

  // (a) No progress IDs recorded → nothing external happened.
  if (!cloudAgentSessionId || !kiloSessionId) {
    return executeLedgerCreate(input, ctx, options, db, row, 'takeover');
  }

  // (b) Ownership row lookup by kiloSessionId.
  const ownership = await findCliSessionOwnershipRow(db, ctx.userId, kiloSessionId);
  if (!ownership) {
    return executeLedgerCreate(input, ctx, options, db, row, 'takeover');
  }

  const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(`${ctx.userId}:${cloudAgentSessionId}`);

  // (c) Ownership present → read the DO state.
  const metadata = await readSessionMetadata(ctx, doId);

  if (!metadata) {
    const sessionService = new SessionService();
    try {
      await sessionService.deleteCliSessionViaSessionIngest(kiloSessionId, ctx.userId, ctx.env, {
        onlyIfEmpty: true,
      });
    } catch {
      throw creationInProgressError();
    }
    const afterDelete = await findCliSessionOwnershipRow(db, ctx.userId, kiloSessionId);
    if (afterDelete) {
      // The delete refused: the row has real content. Completion still requires
      // authoritative DO registration: `getMessageResult` reports
      // `session-not-found` whenever metadata is absent, so admission can only
      // prove a live session after the DO re-proves registration. A second
      // absent read means the session is not live → stay reconcile-pending.
      const registered = await readSessionMetadata(ctx, doId);
      if (!registered) {
        throw creationInProgressError();
      }
      return confirmInitialMessageAdmitted(
        input,
        ctx,
        options,
        db,
        row,
        cloudAgentSessionId,
        kiloSessionId,
        canonical.initialMessageId
      );
    }
    // Stale ownership row removed → re-execute with fresh IDs under the row.
    return executeLedgerCreate(input, ctx, options, db, row, 'takeover');
  }

  // (d) Metadata present → completion requires the recorded initialMessageId.
  return confirmInitialMessageAdmitted(
    input,
    ctx,
    options,
    db,
    row,
    cloudAgentSessionId,
    kiloSessionId,
    canonical.initialMessageId
  );
}

async function confirmInitialMessageAdmitted(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext,
  options: SessionLedgerCreateOptions,
  db: WorkerDb,
  row: OperationLedgerRow,
  cloudAgentSessionId: string,
  kiloSessionId: string,
  initialMessageId: unknown
): Promise<LedgerSessionCreateResult> {
  if (typeof initialMessageId !== 'string' || initialMessageId.length === 0) {
    throw creationInProgressError();
  }

  const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(`${ctx.userId}:${cloudAgentSessionId}`);
  let messageResult: MessageResultRPCResponse;
  try {
    messageResult = await withDORetry<
      DurableObjectStub<CloudAgentSession>,
      MessageResultRPCResponse
    >(
      () => ctx.env.CLOUD_AGENT_SESSION.get(doId),
      stub => stub.getMessageResult(initialMessageId),
      'getMessageResult'
    );
  } catch {
    throw creationInProgressError();
  }

  if (messageResult.type !== 'found') {
    // Not admitted or not determinable.
    throw creationInProgressError();
  }

  const distinctId = await resolveSessionCreateDistinctId(db, ctx.userId);
  await bestEffortLedgerWrite(() =>
    settleOperation(db, {
      rowId: row.id,
      status: 'completed',
      outcomeCode: 'ok',
      canonicalResult: { cloudAgentSessionId, kiloSessionId },
      outboxEvent: sessionCreateSettledOutboxEvent({
        distinctId,
        outcome: 'completed',
        admission: 'takeover',
        startedAt: options.startedAt,
        inOrganization: input.options?.kilocodeOrganizationId != null,
      }),
    })
  );
  return { cloudAgentSessionId, kiloSessionId, replayed: true };
}
