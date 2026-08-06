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
  type SettleOperationInput,
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
import type { SessionCreateRequest, SessionRepositoryRequest } from './session-requests.js';

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

/** Typed client code for a terminal ledger settle failure after a confirmed success. */
const SESSION_CREATE_SETTLE_FAILED_CODE = 'SESSION_CREATE_SETTLE_FAILED';

/** Stable message for the typed retryable internal settle-failure error. */
const SESSION_CREATE_SETTLE_FAILED_MESSAGE = 'session_creation_settle_failed';

/**
 * Typed retryable internal error for a terminal `completed` settle failure
 * after the create effect succeeded (DO registration + initial admission, or
 * an authoritative reconcile). The ledger row stays non-terminal with the
 * canonical IDs recorded by progress, so the same-key retry ladder must
 * reconcile it — the caller must never report success or replay while the row
 * is not terminal. Thrown as a TRPCError so the router's error formatter
 * projects the typed retryable client error.
 */
function ledgerSettleFailureError(cause: unknown): TRPCError {
  logger
    .withFields({ error: cause instanceof Error ? cause.message : String(cause) })
    .error('Failed to settle session create operation ledger row after a confirmed success');
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: SESSION_CREATE_SETTLE_FAILED_MESSAGE,
    cause: {
      error: SESSION_CREATE_SETTLE_FAILED_CODE,
      message: SESSION_CREATE_SETTLE_FAILED_MESSAGE,
      retryable: true,
    },
  });
}

/**
 * Terminal `completed` settle for a confirmed-success create. Unlike the
 * best-effort failure hooks, a settle failure here must not be swallowed:
 * the row would stay non-terminal while the caller reports success. It
 * surfaces the typed retryable internal error instead; the canonical IDs
 * already recorded by progress keep the same-key retry on the reconcile
 * ladder.
 */
async function settleConfirmedSuccess(db: WorkerDb, input: SettleOperationInput): Promise<void> {
  try {
    await settleOperation(db, input);
  } catch (error) {
    throw ledgerSettleFailureError(error);
  }
}

/**
 * Terminal `failed` settle for a reconcile-confirmed terminal initial-message
 * failure. As with `settleConfirmedSuccess`, a settle failure must not be
 * swallowed: the row would stay non-terminal while the caller reports the
 * non-retryable `session_creation_failed`, and the client would clear the key
 * without a durable terminal outcome. It surfaces the typed retryable internal
 * error instead; the same-key retry reconciles the same failed message and
 * re-attempts the terminal settle.
 */
async function settleConfirmedFailure(db: WorkerDb, input: SettleOperationInput): Promise<void> {
  try {
    await settleOperation(db, input);
  } catch (error) {
    throw ledgerSettleFailureError(error);
  }
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
      // the admitted row so the client gets a terminal result. The immutable
      // create-intent fingerprint is recorded with the same write so a same-key
      // retry can reject a changed intent before any replay or reconciliation.
      await recordOperationProgress(ledger.db, ledger.rowId, {
        cloudAgentSessionId,
        kiloSessionId,
        initialMessageId: initialTurn.messageId,
        [SESSION_CREATE_INTENT_FINGERPRINT_KEY]: await sessionCreateIntentFingerprint(input),
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

// ----- immutable create-intent fingerprint (same-key dedupe guard) -------------

/**
 * Ledger `canonical_result` key holding the SHA-256 fingerprint of the
 * immutable create intent, recorded with the first admitted create's progress.
 * A same-key retry compares its own intent against this fingerprint before
 * replaying or reconciling the row, so a changed request can never inherit the
 * prior operation's session. Stored data is bounded (64 hex chars) and
 * non-reversible; no raw prompt, system prompt, profile value, repository,
 * model, organization, token, or resource content is persisted.
 */
export const SESSION_CREATE_INTENT_FINGERPRINT_KEY = 'createIntentFingerprint';

/** SHA-256 hex digest of the given value. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Deterministic JSON serialization: object keys are sorted and undefined
 * values are dropped (JSON semantics), so field order or an explicit
 * `undefined` never changes a fingerprint.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .sort()
      .filter(key => record[key] !== undefined);
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Repository identity with all credential material removed. The explicit git
 * token is excluded so a refreshed credential on the same repository is the
 * same create intent.
 */
function repositoryCreateIntent(repository: SessionRepositoryRequest): Record<string, unknown> {
  switch (repository.type) {
    case 'github':
      return { type: 'github', repo: repository.repo, branch: repository.branch };
    case 'gitlab':
      return { type: 'gitlab', url: repository.url, branch: repository.branch };
    case 'bitbucket':
      return {
        type: 'bitbucket',
        url: repository.url,
        workspaceUuid: repository.workspaceUuid,
        repositoryUuid: repository.repositoryUuid,
        bitbucketIntegrationId: repository.bitbucketIntegrationId,
        branch: repository.branch,
      };
    case 'git':
      return { type: 'git', url: repository.url, branch: repository.branch };
  }
}

/**
 * Behavior-changing profile configuration with all credential material
 * removed. The resolved `envVars` and `encryptedSecrets` are excluded so a
 * rotated secret on the same profile is the same create intent; MCP server
 * `environment`/`headers` blocks carry the same credential-only class and are
 * excluded too. Setup commands, MCP server selection (command/url/enabled/
 * timeout), runtime skills, runtime agents, and kilo commands are immutable
 * create inputs sent to the Durable Object and stay in the intent.
 */
function profileCreateIntent(
  profile: SessionCreateRequest['profile']
): Record<string, unknown> | undefined {
  const resolved = profile?.resolved;
  if (!resolved) {
    return profile?.id ? { id: profile.id } : undefined;
  }
  const mcpServers = resolved.mcpServers
    ? Object.fromEntries(
        Object.entries(resolved.mcpServers).map(([name, server]) => {
          // Credential-only MCP `environment` (local) and `headers` (remote)
          // blocks are excluded; the remaining keys describe create behavior.
          const behavior: Record<string, unknown> =
            server.type === 'local'
              ? {
                  type: server.type,
                  command: server.command,
                  ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
                  ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
                }
              : {
                  type: server.type,
                  url: server.url,
                  ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
                  ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
                };
          return [name, behavior];
        })
      )
    : undefined;
  return {
    ...(profile?.id ? { id: profile.id } : {}),
    setupCommands: resolved.setupCommands,
    ...(mcpServers ? { mcpServers } : {}),
    runtimeSkills: resolved.runtimeSkills,
    runtimeAgents: resolved.runtimeAgents,
    kiloCommands: resolved.kiloCommands,
  };
}

/**
 * Stable fingerprint of the immutable create intent, compared before replay,
 * reconciliation, or effect execution on a same-key retry. Covers every
 * behavior-changing create input the Durable Object receives: the prompt or
 * command, the agent selection and appended system prompt, the repository
 * identity, the finalization policy, the resolved profile configuration, the
 * organization, and the remaining fixed create inputs (devcontainer, profile
 * id, shallow clone, origin platform). Excluded by design: server-allocated
 * identity, the initial message id, credential-only material (git token,
 * profile envVars/encrypted secrets, MCP server environment/headers), and
 * mutable continuation fields such as `callbackTarget`.
 */
export async function sessionCreateIntentFingerprint(
  input: SessionRegistrationInput
): Promise<string> {
  const initialTurn =
    input.initialTurn.type === 'prompt'
      ? {
          type: 'prompt' as const,
          prompt: input.initialTurn.prompt,
          attachments: input.initialTurn.attachments,
        }
      : {
          type: 'command' as const,
          command: input.initialTurn.command,
          arguments: input.initialTurn.arguments,
          attachments: input.initialTurn.attachments,
        };
  return sha256Hex(
    canonicalJson({
      initialTurn,
      agent: {
        mode: input.agent.mode,
        model: input.agent.model,
        variant: input.agent.variant || undefined,
        // The DO stores the effective appended system prompt under `agent`;
        // it is immutable create input, so a changed system prompt must never
        // replay or reconcile a prior session.
        appendSystemPrompt: input.profile?.overrides?.appendSystemPrompt || undefined,
      },
      repository: repositoryCreateIntent(input.repository),
      finalization: input.finalization,
      runtime: input.runtime?.devcontainer ? { devcontainer: true } : undefined,
      options: input.options
        ? {
            kilocodeOrganizationId: input.options.kilocodeOrganizationId || undefined,
            createdOnPlatform: input.options.createdOnPlatform || undefined,
            shallow: input.options.shallow === true ? true : undefined,
          }
        : undefined,
      profile: profileCreateIntent(input.profile),
    })
  );
}

/**
 * Rejects a same-key retry whose create intent changed after the row recorded
 * its intent fingerprint. Rows admitted before the fingerprint contract carry
 * no comparison data and keep the legacy replay/reconcile behavior.
 */
async function assertCreateIntentUnchanged(
  input: SessionRegistrationInput,
  row: OperationLedgerRow
): Promise<void> {
  const stored = row.canonical_result?.[SESSION_CREATE_INTENT_FINGERPRINT_KEY];
  if (typeof stored !== 'string' || stored.length === 0) {
    return;
  }
  if ((await sessionCreateIntentFingerprint(input)) !== stored) {
    // Typed non-retryable session creation failure: the client clears the key
    // and starts a new intent instead of inheriting the prior operation.
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'session_creation_failed' });
  }
}

/**
 * Creates a session under the operation ledger. Admit only when the caller
 * (the prepare handler) has already gated on `operationKey` present AND
 * effective `autoInitiate` true.
 *
 * Admission outcomes:
 * - `admitted`: run the create effect and settle completed/failed, or mark
 *   reconcile-pending on an unknown transport outcome.
 * - `duplicate_settled`: replay the canonical result with `replayed: true`,
 *   but only when the retry's immutable create intent still matches.
 * - `duplicate_in_flight`: `CONFLICT` `creation_in_progress`.
 * - `duplicate_reconcile_in_progress`: another retry holds the reconciliation
 *   lease; `CONFLICT` `creation_in_progress`.
 * - `takeover` / `duplicate_reconcile_pending`: reconcile before any effect,
 *   but only when the retry's immutable create intent still matches.
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
      return replaySettledCreate(admission.row, input);
    case 'duplicate_in_flight':
    case 'duplicate_reconcile_in_progress':
      throw creationInProgressError();
    case 'takeover':
    case 'duplicate_reconcile_pending':
      return reconcileLedgerCreate(input, ctx, options, db, admission.row);
  }
}

async function replaySettledCreate(
  row: OperationLedgerRow,
  input: SessionRegistrationInput
): Promise<LedgerSessionCreateResult> {
  // Only a `completed` settle may replay a successful create. Failed, no_op,
  // interrupted, and superseded terminal rows must surface the typed
  // non-retryable failure even when progress recorded canonical IDs before the
  // failure: progress IDs prove allocation, never success.
  if (row.status !== 'completed') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'session_creation_failed' });
  }
  // A changed same-key create intent must never replay the prior session; the
  // typed non-retryable failure lets the client clear the key and start fresh.
  await assertCreateIntentUnchanged(input, row);
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
      settleConfirmedSuccess(db, {
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
      }),
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
 *   c. Ownership row present, DO metadata absent → perform an authoritative
 *      SECOND metadata read BEFORE touching the ownership row (a single null
 *      read is not proof of no registration). If the second read returns
 *      metadata, the DO committed registration → reconcile initial admission
 *      and settle/replay WITHOUT deleting the ownership row. When BOTH reads
 *      are absent, stay conservative: two absent reads do NOT fence a later
 *      DO registration (the original create RPC may still be in flight), so
 *      the ownership row is preserved and the retry surfaces
 *      `creation_in_progress`; deleting the row and allocating fresh IDs
 *      could double-admit the initial turn.
 *   d. Metadata present → completion requires the recorded `initialMessageId`
 *      to be admitted. Admitted with a status that proves admission without
 *      terminal failure (`queued`, `running`, `completed`) → settle completed
 *      (+ outbox) and replay. A found message with status `failed` or
 *      `interrupted` is a terminal failure → settle the row failed and surface
 *      `session_creation_failed`. Not admitted / not determinable →
 *      `CONFLICT` `creation_in_progress`.
 */
async function reconcileLedgerCreate(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext,
  options: SessionLedgerCreateOptions,
  db: WorkerDb,
  row: OperationLedgerRow
): Promise<LedgerSessionCreateResult> {
  // A changed same-key create intent is rejected before ANY reconcile step: no
  // fresh create, no ownership-row lookup, and no DO metadata read.
  await assertCreateIntentUnchanged(input, row);

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
    // A single null metadata read is NOT proof of no registration (a transient
    // read or a pending deletion intent can hide committed metadata). Perform
    // an authoritative second metadata read BEFORE deleting the stale
    // ownership row: if the DO committed concurrently, deleting the row would
    // orphan a live registered session and a fresh create would double-admit
    // the initial turn. When the second read returns metadata, reconcile
    // initial admission and settle/replay; never delete the ownership row.
    const secondRead = await readSessionMetadata(ctx, doId);
    if (secondRead) {
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

    // Both reads absent. Two absent reads do NOT fence a later DO
    // registration: the original create RPC may still be in flight and commit
    // registration plus the initial admission after these reads. Deleting the
    // ownership row and allocating fresh IDs would then double-admit the
    // initial turn. Stay conservative: preserve the ownership row, keep the
    // ledger row non-terminal, and surface `creation_in_progress` so a later
    // same-key retry reconciles again. Never fresh-create from absence alone.
    throw creationInProgressError();
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

  // A found message with status `failed` or `interrupted` proves the initial
  // turn was admitted but ended in a terminal failure. Settling the create as
  // completed would replay a successful session against a dead session, and a
  // later fresh create would double-admit the turn. Settle the row as a
  // terminal failure with the session-create failure outcome and surface the
  // typed non-retryable `session_creation_failed` so the client starts a new
  // intent. Only `queued`, `running`, or `completed` proves admission without
  // terminal failure and may replay. A failed settle must never produce that
  // non-retryable outcome: the row would stay non-terminal while the client
  // clears the key, so the settle surfaces the typed retryable internal error
  // and the same-key retry reconciles again.
  if (messageResult.result.status === 'failed' || messageResult.result.status === 'interrupted') {
    const distinctId = await resolveSessionCreateDistinctId(db, ctx.userId);
    await settleConfirmedFailure(db, {
      rowId: row.id,
      status: 'failed',
      outcomeCode: 'initial_admission_rejected',
      outboxEvent: sessionCreateSettledOutboxEvent({
        distinctId,
        outcome: 'failed',
        admission: 'takeover',
        failureStage: 'initial_admission',
        startedAt: options.startedAt,
        inOrganization: input.options?.kilocodeOrganizationId != null,
      }),
    });
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'session_creation_failed' });
  }

  const distinctId = await resolveSessionCreateDistinctId(db, ctx.userId);
  await settleConfirmedSuccess(db, {
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
  });
  return { cloudAgentSessionId, kiloSessionId, replayed: true };
}
