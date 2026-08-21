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
import { normalizeGitUrl } from '@kilocode/worker-utils';

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
import { sha256Hex } from '../utils/sha256.js';
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

type SessionEstablishmentFailure =
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
type SessionLedgerFailureStage =
  | SessionLedgerAllocationFailureStage
  | 'registration'
  | 'initial_admission';

/**
 * Optional ledger hooks threaded through creation so the create effect records
 * progress and settles the operation exactly once. Failure hooks are
 * best-effort: a ledger write failure must never mask the primary creation
 * outcome. `onSuccess` is not, because a lost settle would report success on a
 * non-terminal row.
 */
type SessionCreationLedgerHooks = {
  db: WorkerDb;
  rowId: string;
  /** Settle the row `failed` at the given stage. */
  onFailure: (stage: SessionLedgerFailureStage, outcomeCode: string) => Promise<void>;
  /** The DO RPC threw; the commit outcome is unknown. */
  onTransportFailure: () => Promise<void>;
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

/**
 * Row age after which a reconcile that still sees no Durable Object state at all
 * treats the original `createSessionWithInitialAdmission` RPC as definitively
 * lost and settles the row `failed`. Below it, the same reconcile keeps
 * conflicting with `creation_in_progress`.
 *
 * 900 seconds is 7.5x the 120-second create lease and far longer than any
 * Durable Object RPC (or its `withDORetry` budget) can survive, so a merely slow
 * or in-flight create is never abandoned. One call site, one value: do not make
 * it configurable.
 */
export const SESSION_CREATE_ABANDON_AFTER_SECONDS = 900;

/** Outcome code stored on a row abandoned because the create RPC was lost. */
export const SESSION_CREATE_ABANDONED_OUTCOME_CODE = 'create_rpc_abandoned';

/**
 * Ledger `canonical_result` key marking the recorded destination IDs as dead
 * after an explicit clone rejection. A same-key retry must never resume them;
 * the next intent allocates fresh IDs.
 */
export const SESSION_CREATE_TOMBSTONED_IDS_KEY = 'tombstonedDestinationIds';

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

/** Stable message for the typed retryable internal settle-failure error. */
const SESSION_CREATE_SETTLE_FAILED_MESSAGE = 'session_creation_settle_failed';

/**
 * Terminal settle for an outcome the caller is about to report (a confirmed
 * success, or a reconcile-confirmed terminal failure). A settle failure must
 * not be swallowed: the row would stay non-terminal while the client treats the
 * key as finished. It surfaces a typed retryable internal error instead, and
 * the canonical IDs recorded by progress keep the same-key retry on the
 * reconcile ladder.
 */
async function settleTerminalOutcome(db: WorkerDb, input: SettleOperationInput): Promise<void> {
  try {
    await settleOperation(db, input);
  } catch (error) {
    logger
      .withFields({ error: error instanceof Error ? error.message : String(error) })
      .error('Failed to settle session create operation ledger row after a confirmed outcome');
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: SESSION_CREATE_SETTLE_FAILED_MESSAGE,
      cause: {
        error: 'SESSION_CREATE_SETTLE_FAILED',
        message: SESSION_CREATE_SETTLE_FAILED_MESSAGE,
        retryable: true,
      },
    });
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

/**
 * Marks the recorded destination IDs as dead after an explicit clone
 * rejection, before the terminal settle. Best-effort: a tombstone write failure
 * must never mask the primary rejection outcome.
 */
async function recordCloneTombstone(
  ledger: SessionCreationLedgerHooks,
  ids: { cloudAgentSessionId: string; kiloSessionId: string }
): Promise<void> {
  await bestEffortLedgerWrite(() =>
    recordOperationProgress(ledger.db, ledger.rowId, {
      [SESSION_CREATE_TOMBSTONED_IDS_KEY]: ids,
    })
  );
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

/**
 * Canonical repository URL for the session-ingest ownership row. GitHub builds
 * the URL from the `owner/repo` slug; every other provider already carries a
 * URL. The value is normalized before it leaves this module.
 */
function deriveCanonicalRepositoryUrl(repository: SessionRepositoryRequest): string | undefined {
  if (repository.type === 'github') {
    return normalizeGitUrl(`https://github.com/${repository.repo}`);
  }
  return normalizeGitUrl(repository.url);
}

/**
 * Credential containment for a create, derived from the repository type, the
 * devcontainer flag, and the organization containment lists. Shared by the
 * fresh allocation and the clone rebuild so both compute it identically.
 */
function computeCredentialContainment(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext
): CredentialContainment {
  const orgId = input.options?.kilocodeOrganizationId;
  const devcontainerRequested = input.runtime?.devcontainer === true;
  return {
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
  const credentialContainment = computeCredentialContainment(input, ctx);
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

  if (ledger) {
    // Record the non-secret sandbox allocation before the ownership row is
    // created so a same-key retry can reconcile the same allocation instead of
    // deriving a second one. A failure here still fails the create at the
    // sandbox stage and settles the admitted row.
    try {
      await recordOperationProgress(ledger.db, ledger.rowId, {
        sandboxId,
        sandboxProvider,
        ...(sandboxRoute ? { sandboxRoute } : {}),
      });
    } catch (error) {
      rethrowAllocationFailure(ledger, 'sandbox', error);
    }
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
  const canonicalRepositoryUrl = deriveCanonicalRepositoryUrl(input.repository);
  const cloneFromKiloSessionId = input.clone?.cloneFromKiloSessionId;
  let ingestResult: Awaited<ReturnType<SessionService['createCliSessionViaSessionIngest']>>;
  try {
    ingestResult = await sessionService.createCliSessionViaSessionIngest(
      kiloSessionId,
      cloudAgentSessionId,
      ctx.userId,
      ctx.env,
      input.options?.kilocodeOrganizationId,
      createdOnPlatform,
      defaultTitle,
      canonicalRepositoryUrl,
      cloneFromKiloSessionId
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
    if (cloneFromKiloSessionId) {
      // A clone create must never settle the row failed on a thrown ingest
      // outcome: the clone may have committed. Keep the row reconcile-pending
      // and rethrow the raw error.
      if (ledger) {
        await ledger.onTransportFailure();
      }
      throw error;
    }
    rethrowAllocationFailure(ledger, 'ownership_row', error);
  }

  if (cloneFromKiloSessionId) {
    if (ingestResult === undefined) {
      // Old worker with no clone acknowledgement: the clone outcome is unknown.
      if (ledger) {
        await ledger.onTransportFailure();
      }
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'session_clone_unavailable' });
    }
    if (ingestResult.status === 'rejected') {
      if (ledger) {
        await recordCloneTombstone(ledger, { cloudAgentSessionId, kiloSessionId });
        await ledger.onFailure('ownership_row', 'session_clone_failed');
      }
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'session_clone_failed' });
    }
    if (ingestResult.status === 'in_progress') {
      if (ledger) {
        await ledger.onTransportFailure();
      }
      throw creationInProgressError();
    }
    // `ready` continues normally.
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
        await sessionService.deleteCliSessionViaSessionIngest(
          kiloSessionId,
          ctx.userId,
          ctx.env,
          cloneFromKiloSessionId
            ? { cloneSourceSessionId: cloneFromKiloSessionId }
            : { onlyIfEmpty: true }
        );
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

/**
 * Rebuilds a clone allocation from the ledger progress recorded by the
 * original create, so a same-key retry can resume the stored destination IDs
 * instead of allocating fresh ones. The initial turn keeps the stored
 * `initialMessageId` (the retry's own message id is never used) with the turn
 * content from `input.initialTurn`, which the intent fingerprint already
 * proved unchanged.
 */
function rebuildCloneAllocation(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext,
  row: OperationLedgerRow
): NewSessionAllocation {
  const canonical = row.canonical_result ?? {};
  const cloudAgentSessionId = canonical.cloudAgentSessionId;
  const kiloSessionId = canonical.kiloSessionId;
  const initialMessageId = canonical.initialMessageId;
  const sandboxId = canonical.sandboxId;
  const sandboxProvider = canonical.sandboxProvider;
  const sandboxRoute = canonical.sandboxRoute;

  if (
    typeof cloudAgentSessionId !== 'string' ||
    cloudAgentSessionId.length === 0 ||
    typeof kiloSessionId !== 'string' ||
    kiloSessionId.length === 0 ||
    typeof initialMessageId !== 'string' ||
    initialMessageId.length === 0 ||
    typeof sandboxId !== 'string' ||
    sandboxId.length === 0 ||
    typeof sandboxProvider !== 'string' ||
    sandboxProvider !== 'cloudflare'
  ) {
    throw creationInProgressError();
  }

  let route: SharedSandboxRouteMetadata | undefined;
  if (sandboxRoute !== undefined) {
    if (
      typeof sandboxRoute !== 'object' ||
      sandboxRoute === null ||
      (sandboxRoute as Record<string, unknown>).kind !== 'shared' ||
      typeof (sandboxRoute as Record<string, unknown>).routeKey !== 'string'
    ) {
      throw creationInProgressError();
    }
    route = sandboxRoute as SharedSandboxRouteMetadata;
  }

  const accepted = acceptInitialTurn(input.initialTurn);
  const initialTurn: AcceptedExecutionTurn = { ...accepted, messageId: initialMessageId };
  const sessionService = new SessionService();
  const cloneFromKiloSessionId = input.clone?.cloneFromKiloSessionId;

  return {
    cloudAgentSessionId,
    kiloSessionId,
    sandboxId: sandboxId as SandboxId,
    sandboxRoute: route,
    sandboxProvider: sandboxProvider as SandboxSelection['provider'],
    initialTurn,
    credentialContainment: computeCredentialContainment(input, ctx),
    sessionService,
    rollbackCliSession: async () => {
      try {
        await sessionService.deleteCliSessionViaSessionIngest(
          kiloSessionId,
          ctx.userId,
          ctx.env,
          cloneFromKiloSessionId
            ? { cloneSourceSessionId: cloneFromKiloSessionId }
            : { onlyIfEmpty: true }
        );
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
    clone: input.clone,
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
 * Register the allocated session in its Durable Object and durably admit the
 * canonical initial turn through one grouped operation. The ownership row is an
 * external prerequisite; an explicit Durable Object rejection triggers
 * best-effort deletion of that row. RPC retries use the same DO key and
 * canonical message identity; an unrecovered transport error leaves the row in
 * place because the Durable Object commit outcome is unknown and may require
 * later operational cleanup.
 */
async function registerAndAdmitInitialTurn(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext,
  options: { billingOrigin?: string } | undefined,
  allocation: NewSessionAllocation,
  ledger: SessionCreationLedgerHooks | undefined
): Promise<StartedSessionResult> {
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
      if (input.clone?.cloneFromKiloSessionId) {
        await recordCloneTombstone(ledger, {
          cloudAgentSessionId: allocation.cloudAgentSessionId,
          kiloSessionId: allocation.kiloSessionId,
        });
      }
      await ledger.onFailure(failure.stage, failure.code);
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

/**
 * Create a new session and ask its Durable Object to register metadata and
 * durably admit the canonical initial turn.
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
      await ledger.onFailure(error.stage, error.stage);
      throw error.cause;
    }
    throw error;
  }
  return registerAndAdmitInitialTurn(input, ctx, options, allocation, ledger);
}

// ----- ledger-guarded session creation ----------------------------------------

/**
 * Ledger `canonical_result` key holding the SHA-256 fingerprint of the immutable
 * create intent, recorded with the first admitted create's progress. A same-key
 * retry compares its own intent against it before replaying or reconciling, so a
 * changed request can never inherit the prior operation's session.
 */
export const SESSION_CREATE_INTENT_FINGERPRINT_KEY = 'createIntentFingerprint';

/**
 * Deterministic JSON serialization: object keys are sorted and undefined
 * values are dropped (JSON semantics), so field order or an explicit
 * `undefined` never changes a fingerprint.
 *
 * Deliberately not shared with the stricter `canonicalJson` in
 * `workspace-backup-cache.ts`: that one rejects (returns null) where this one
 * serializes — a top-level `undefined`, an `undefined` array element, a
 * non-finite number, or an exotic object. Swapping it in here rotates every
 * live create-intent fingerprint, so the two stay separate.
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
 * Behavior-changing profile configuration with all credential material removed:
 * `envVars`, `encryptedSecrets`, and MCP `environment`/`headers` are excluded, so
 * a rotated secret on the same profile is the same create intent.
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
 * reconciliation, or effect execution on a same-key retry. It covers every
 * behavior-changing create input the Durable Object receives. Excluded by design:
 * server-allocated identity, the initial message id, credential-only material,
 * and mutable continuation fields such as `callbackTarget`.
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
      clone: input.clone
        ? { cloneFromKiloSessionId: input.clone.cloneFromKiloSessionId }
        : undefined,
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
 * Creates a session under the operation ledger. Call only when the caller (the
 * prepare handler) has already gated on `operationKey` present AND effective
 * `autoInitiate` true. Replay and reconciliation happen only when the retry's
 * immutable create intent still matches the admitted one.
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
  const ids = canonicalSessionIds(row);
  if (!ids) {
    // A completed settle without canonical IDs has no session to replay. Treat
    // the retry as a fresh intent by surfacing a non-retryable typed rejection
    // so the client clears the key.
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'session_creation_failed' });
  }
  return { ...ids, replayed: true };
}

/** Canonical session IDs recorded by the create's progress write, when present. */
function canonicalSessionIds(
  row: OperationLedgerRow
): { cloudAgentSessionId: string; kiloSessionId: string } | undefined {
  const canonical = row.canonical_result ?? {};
  return typeof canonical.cloudAgentSessionId === 'string' &&
    typeof canonical.kiloSessionId === 'string'
    ? {
        cloudAgentSessionId: canonical.cloudAgentSessionId,
        kiloSessionId: canonical.kiloSessionId,
      }
    : undefined;
}

/**
 * Builds the ledger hooks threaded through creation so the create effect
 * records progress and settles the operation exactly once. Shared by the fresh
 * create and the clone resume so both settle with the same outbox shape.
 */
async function buildLedgerHooks(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext,
  options: SessionLedgerCreateOptions,
  db: WorkerDb,
  row: OperationLedgerRow,
  admissionKind: 'new' | 'takeover'
): Promise<SessionCreationLedgerHooks> {
  const distinctId = await resolveSessionCreateDistinctId(db, ctx.userId);
  const inOrganization = input.options?.kilocodeOrganizationId != null;

  return {
    db,
    rowId: row.id,
    onFailure: (stage, outcomeCode) =>
      bestEffortLedgerWrite(() =>
        settleOperation(db, {
          rowId: row.id,
          status: 'failed',
          outcomeCode,
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
    onSuccess: result =>
      settleTerminalOutcome(db, {
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
  const hooks = await buildLedgerHooks(input, ctx, options, db, row, admissionKind);
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

/** Tombstoned destination IDs recorded by progress, when present and well-formed. */
function tombstonedDestinationIds(
  row: OperationLedgerRow
): { cloudAgentSessionId: string; kiloSessionId: string } | undefined {
  const marker = row.canonical_result?.[SESSION_CREATE_TOMBSTONED_IDS_KEY];
  if (typeof marker !== 'object' || marker === null) {
    return undefined;
  }
  const { cloudAgentSessionId, kiloSessionId } = marker as Record<string, unknown>;
  return typeof cloudAgentSessionId === 'string' && typeof kiloSessionId === 'string'
    ? { cloudAgentSessionId, kiloSessionId }
    : undefined;
}

/** True when the row tombstones exactly the recorded destination IDs. */
function hasTombstoneForIds(
  row: OperationLedgerRow,
  ids: { cloudAgentSessionId: string; kiloSessionId: string }
): boolean {
  const tombstone = tombstonedDestinationIds(row);
  return (
    tombstone !== undefined &&
    tombstone.cloudAgentSessionId === ids.cloudAgentSessionId &&
    tombstone.kiloSessionId === ids.kiloSessionId
  );
}

/**
 * Resumes a clone create whose ownership row is absent: re-issues the ingest
 * call with the stored destination IDs and clone source, then rebuilds the
 * allocation and re-runs registration plus initial admission. The outcome
 * mapping matches `allocateNewSession` exactly.
 */
async function resumeCloneCreate(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext,
  options: SessionLedgerCreateOptions,
  db: WorkerDb,
  row: OperationLedgerRow,
  ids: { cloudAgentSessionId: string; kiloSessionId: string }
): Promise<LedgerSessionCreateResult> {
  const cloneFromKiloSessionId = input.clone?.cloneFromKiloSessionId;
  if (!cloneFromKiloSessionId) {
    throw creationInProgressError();
  }

  const hooks = await buildLedgerHooks(input, ctx, options, db, row, 'takeover');
  const sessionService = new SessionService();
  const createdOnPlatform = input.options?.createdOnPlatform ?? 'cloud-agent';
  const defaultTitle = `New session - ${new Date().toISOString()}`;

  let ingestResult: Awaited<ReturnType<SessionService['createCliSessionViaSessionIngest']>>;
  try {
    ingestResult = await sessionService.createCliSessionViaSessionIngest(
      ids.kiloSessionId,
      ids.cloudAgentSessionId,
      ctx.userId,
      ctx.env,
      input.options?.kilocodeOrganizationId,
      createdOnPlatform,
      defaultTitle,
      cloneFromKiloSessionId
    );
  } catch (error) {
    await recordPostSetupFailure(() =>
      recordCloudAgentSessionFailure(
        {
          cloudAgentSessionId: ids.cloudAgentSessionId,
          failure: { stage: 'transport', code: 'do_rpc_outcome_unknown' },
        },
        ctx.env
      )
    );
    await hooks.onTransportFailure();
    throw error;
  }

  if (ingestResult === undefined) {
    await hooks.onTransportFailure();
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'session_clone_unavailable' });
  }
  if (ingestResult.status === 'rejected') {
    await recordCloneTombstone(hooks, ids);
    await hooks.onFailure('ownership_row', 'session_clone_failed');
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'session_clone_failed' });
  }
  if (ingestResult.status === 'in_progress') {
    await hooks.onTransportFailure();
    throw creationInProgressError();
  }
  // `ready` continues.

  const allocation = rebuildCloneAllocation(input, ctx, row);
  const result = await registerAndAdmitInitialTurn(
    input,
    ctx,
    { billingOrigin: options.billingOrigin },
    allocation,
    hooks
  );
  return {
    cloudAgentSessionId: result.cloudAgentSessionId,
    kiloSessionId: result.kiloSessionId,
    replayed: true,
  };
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
 * True when the row is older than `SESSION_CREATE_ABANDON_AFTER_SECONDS`. An
 * unparsable `admitted_at` is never abandoned.
 */
function isCreateAbandonable(row: OperationLedgerRow): boolean {
  const admittedAt = new Date(row.admitted_at).getTime();
  if (!Number.isFinite(admittedAt)) {
    return false;
  }
  return Date.now() - admittedAt > SESSION_CREATE_ABANDON_AFTER_SECONDS * 1000;
}

/**
 * Takeover / reconcile-pending reconciliation ladder. It never deletes the
 * ownership row and never fresh-creates from absent DO state, because the
 * original create RPC may still commit and double-admit the initial turn:
 *   a. No progress IDs → nothing external happened → fresh create under the row.
 *   b. IDs recorded, ownership row absent → a tombstoned clone falls through to
 *      a fresh allocation; an un-tombstoned clone resumes its stored IDs;
 *      an old non-clone create keeps the existing fresh allocation.
 *   c. Ownership row present, both metadata reads absent → `creation_in_progress`
 *      while the row is younger than `SESSION_CREATE_ABANDON_AFTER_SECONDS`;
 *      older than that the create RPC is definitively lost, so the row settles
 *      `failed` and the client receives the typed terminal failure.
 *   d. Metadata present → the recorded `initialMessageId` decides the outcome.
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

  const ids = canonicalSessionIds(row);

  // (a) No progress IDs recorded → nothing external happened.
  if (!ids) {
    return executeLedgerCreate(input, ctx, options, db, row, 'takeover');
  }

  // (b) Ownership row lookup by kiloSessionId.
  const ownership = await findCliSessionOwnershipRow(db, ctx.userId, ids.kiloSessionId);
  if (!ownership) {
    // A tombstoned destination must never be resumed: the clone was explicitly
    // rejected and its IDs are dead, so fall through to a fresh allocation.
    if (hasTombstoneForIds(row, ids)) {
      return executeLedgerCreate(input, ctx, options, db, row, 'takeover');
    }
    // A clone create with no ownership row resumes the stored destination IDs
    // instead of allocating fresh ones.
    if (input.clone?.cloneFromKiloSessionId) {
      return resumeCloneCreate(input, ctx, options, db, row, ids);
    }
    // Old non-clone create: the ownership row is absent, so the DO never
    // registered. Keep the existing fresh allocation. Remove this path only
    // once every non-clone create is tombstoned on rejection (out of scope).
    return executeLedgerCreate(input, ctx, options, db, row, 'takeover');
  }

  const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(`${ctx.userId}:${ids.cloudAgentSessionId}`);
  const confirm = () =>
    confirmInitialMessageAdmitted({
      ctx,
      db,
      row,
      doId,
      ids,
      initialMessageId: row.canonical_result?.initialMessageId,
      startedAt: options.startedAt,
      inOrganization: input.options?.kilocodeOrganizationId != null,
    });

  // (c) Ownership present → read the DO state.
  if (!(await readSessionMetadata(ctx, doId))) {
    // A single null metadata read is NOT proof of no registration (a transient
    // read or a pending deletion intent can hide committed metadata), so read
    // once more before treating the ownership row as stale.
    if (await readSessionMetadata(ctx, doId)) {
      return confirm();
    }

    // Both reads absent. They still do not fence a later DO registration: the
    // original create RPC may commit registration plus the initial admission
    // after these reads, so deleting the ownership row and allocating fresh IDs
    // could double-admit the initial turn. Preserve the row, keep the ledger row
    // non-terminal, and let a later same-key retry reconcile again.
    //
    // Past the abandonment age the RPC cannot still be in flight, so a row that
    // never produced DO state is definitively lost. Settle it `failed` and give
    // the client a terminal outcome; the ownership row is still NOT deleted and
    // no fresh create is allocated, so nothing can double-admit the initial turn.
    // The next attempt uses a new operation key, new IDs, and a new DO.
    if (isCreateAbandonable(row)) {
      const distinctId = await resolveSessionCreateDistinctId(db, ctx.userId);
      await settleTerminalOutcome(db, {
        rowId: row.id,
        status: 'failed',
        outcomeCode: SESSION_CREATE_ABANDONED_OUTCOME_CODE,
        outboxEvent: sessionCreateSettledOutboxEvent({
          distinctId,
          outcome: 'failed',
          admission: 'takeover',
          failureStage: 'registration',
          startedAt: options.startedAt,
          inOrganization: input.options?.kilocodeOrganizationId != null,
        }),
      });
      logger
        .withFields({ rowId: row.id, cloudAgentSessionId: ids.cloudAgentSessionId })
        .error('Abandoned session create: the Durable Object create RPC was never delivered');
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'session_creation_failed' });
    }

    throw creationInProgressError();
  }

  // (d) Metadata present → completion requires the recorded initialMessageId.
  return confirm();
}

async function confirmInitialMessageAdmitted(args: {
  ctx: SessionRegistrationContext;
  db: WorkerDb;
  row: OperationLedgerRow;
  doId: DurableObjectId;
  ids: { cloudAgentSessionId: string; kiloSessionId: string };
  initialMessageId: unknown;
  startedAt: number;
  inOrganization: boolean;
}): Promise<LedgerSessionCreateResult> {
  const { ctx, db, row, doId, ids, initialMessageId } = args;
  if (typeof initialMessageId !== 'string' || initialMessageId.length === 0) {
    throw creationInProgressError();
  }

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

  // Only `queued`, `running`, or `completed` proves admission without a terminal
  // failure and may replay. `failed`/`interrupted` proves the initial turn was
  // admitted and then died: replaying success would hand back a dead session and
  // a later fresh create would double-admit the turn, so settle the row failed
  // and surface the typed non-retryable failure.
  const failed =
    messageResult.result.status === 'failed' || messageResult.result.status === 'interrupted';
  const distinctId = await resolveSessionCreateDistinctId(db, ctx.userId);
  await settleTerminalOutcome(db, {
    rowId: row.id,
    status: failed ? 'failed' : 'completed',
    outcomeCode: failed ? 'initial_admission_rejected' : 'ok',
    ...(failed ? {} : { canonicalResult: ids }),
    outboxEvent: sessionCreateSettledOutboxEvent({
      distinctId,
      outcome: failed ? 'failed' : 'completed',
      admission: 'takeover',
      ...(failed ? { failureStage: 'initial_admission' as const } : {}),
      startedAt: args.startedAt,
      inOrganization: args.inOrganization,
    }),
  });
  if (failed) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'session_creation_failed' });
  }
  return { ...ids, replayed: true };
}
