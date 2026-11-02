/**
 * `continueHostedWorkspace` — the Cloud half of "Continue a local worktree in
 * Cloud".
 *
 * One call creates a hosted workspace whose roots are clone-only copies of the
 * caller's local root sessions. This module owns the orchestration only:
 *
 * - source validation (ownership, root, shared organization, git URL),
 * - the batch request fingerprint on one compact parent ledger row,
 * - the clone-only workspace root, and clone-only siblings.
 *
 * It reuses the existing create owners per step: `createSessionWithLedger` for
 * the workspace root and `runSiblingCreate` (through
 * `createContinuedWorkspaceSibling`) for each sibling, each under a
 * deterministic per-source operation key, so every step keeps its own replay
 * behavior and a partial retry never duplicates a destination.
 *
 * The parent row's `canonical_result` stays compact: the batch fingerprint, the
 * workspace id after step 0, and the per-source destination ids and mode-fallback
 * results. The resolved settings are NOT snapshotted. An unfinished same-key retry
 * re-resolves them and each step replays its own immutable create intent, so a
 * changed resolved setting is a same-key intent conflict rather than config
 * drift. Completed replay reconstructs agent settings from the matched request
 * and the recorded mode-fallback results, without reading destination metadata.
 */
import { TRPCError } from '@trpc/server';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { WorkerDb } from '@kilocode/db/client';
import {
  admitOperation,
  getOperation,
  markReconcilePending,
  recordOperationProgress,
  settleOperation,
} from '@kilocode/db/operation-ledger';
import { cli_sessions_v2, type OperationLedgerRow } from '@kilocode/db/schema';
import {
  cloudAgentWorktreeIdSchema,
  sessionIdSchema as kiloSessionIdSchema,
  type CloudAgentWorktreeId,
} from '@kilocode/session-ingest-contracts';
import { sha256Hex, normalizeGitUrl } from '@kilocode/worker-utils';

import { getPgDb } from '../../db/pg.js';
import { logger } from '../../logger.js';
import type { SessionCreateRequest } from '../../session/session-requests.js';
import { createSessionWithLedger } from '../../session/session-registration.js';
import { assertRepositoryAccessBeforeSessionCreation } from '../../session/validate-repository-access.js';
import type { TRPCContext } from '../../types.js';
import { validateBalanceOnly } from '../../balance-validation.js';
import { protectedProcedure } from '../auth.js';
import { Limits, modelIdSchema, RepositoryInputSchema, type RepositoryInput } from '../schemas.js';
import { verifyWorkspaceIdentity, workspaceIdForSession } from './hosted-workspace-mutations.js';
import { assertOrganizationMembership } from './organization-membership.js';
import { preflightSessionCreation, resolveContinuationMode } from './session-creation-preflight.js';
import { createContinuedWorkspaceSibling } from './session-worktree.js';
import { repositoryInputToSessionRepository } from './session-start.js';

/** Parent ledger identity. */
const CONTINUATION_DOMAIN = 'session';
const CONTINUATION_INTENT = 'continue_hosted_workspace';
const CONTINUATION_STEP_LEASE_SECONDS = 120;

const ContinuationAgentInput = z
  .object({
    mode: z.string().min(1).max(50),
    model: modelIdSchema,
    variant: z.string().max(50).optional(),
  })
  .strict();

const ContinuationSourceInput = z
  .object({
    sourceKiloSessionId: kiloSessionIdSchema,
    agent: ContinuationAgentInput,
  })
  .strict();

export const ContinueHostedWorkspaceRequestSchema = z
  .object({
    operationKey: z.uuid(),
    clientProvenance: z.literal('agent-manager'),
    repository: RepositoryInputSchema,
    activeSourceKiloSessionId: kiloSessionIdSchema,
    sessions: z.array(ContinuationSourceInput).min(1).max(Limits.MAX_CONTINUE_SESSIONS),
  })
  .strict();

export const ContinueHostedWorkspaceInput = ContinueHostedWorkspaceRequestSchema.superRefine(
  (value, ctx) => {
    const ids = value.sessions.map(session => session.sourceKiloSessionId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['sessions'],
        message: 'sourceKiloSessionId values must be unique',
      });
    }
    if (!ids.includes(value.activeSourceKiloSessionId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['activeSourceKiloSessionId'],
        message: 'activeSourceKiloSessionId must be one of the sessions',
      });
    }
    if (value.repository.type === 'git') {
      if (value.repository.token !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['repository', 'token'],
          message: 'repository.token is not accepted',
        });
      }
      const url = URL.parse(value.repository.url);
      if (url && (url.username !== '' || url.password !== '')) {
        ctx.addIssue({
          code: 'custom',
          path: ['repository', 'url'],
          message: 'repository.url must not contain credentials',
        });
      }
    }
  }
);

const ContinuationAgentOutput = z
  .object({
    mode: z.string(),
    model: z.string(),
    variant: z.string().optional(),
  })
  .strict();

const ContinuationSourceOutput = z
  .object({
    sourceKiloSessionId: z.string(),
    kiloSessionId: z.string(),
    cloudAgentSessionId: z.string().startsWith('workspace_'),
    agent: ContinuationAgentOutput,
    modeFallback: z.boolean(),
  })
  .strict();

export const ContinueHostedWorkspaceOutput = z
  .object({
    workspaceId: cloudAgentWorktreeIdSchema,
    sessions: z.array(ContinuationSourceOutput),
    activeKiloSessionId: z.string(),
    replayed: z.literal(true).optional(),
  })
  .strict();

type ContinuationInput = z.infer<typeof ContinueHostedWorkspaceInput>;
type ContinuationOutput = z.infer<typeof ContinueHostedWorkspaceOutput>;

const continuationDigestKey = 'continuationDigest';
const continuationWorkspaceIdKey = 'workspaceId';
const continuationDestinationsKey = 'destinations';

const destinationSchema = z
  .object({
    sourceKiloSessionId: z.string(),
    kiloSessionId: z.string(),
    cloudAgentSessionId: z.string(),
    status: z.string(),
    // The public fallback result: true when the server replaced an unavailable
    // requested mode with `code`. Reconstructing the report from this plus the
    // exact matched request keeps the completed response stable without storing
    // the resolved agent settings or reading destination metadata.
    modeFallback: z.boolean(),
  })
  .strict();

type ContinuationDestination = z.infer<typeof destinationSchema>;

const completedResultSchema = z
  .object({
    workspaceId: cloudAgentWorktreeIdSchema,
    destinations: z.array(destinationSchema),
  })
  .strict();

export function continuationError(code: string, retryable: boolean): TRPCError {
  const httpCode =
    code === 'insufficient_balance'
      ? 'PAYMENT_REQUIRED'
      : code === 'organization_mismatch'
        ? 'FORBIDDEN'
        : code === 'operation_key_reuse_mismatch' ||
            code === 'continuation_incomplete' ||
            code === 'creation_in_progress'
          ? 'CONFLICT'
          : 'BAD_REQUEST';
  return new TRPCError({ code: httpCode, message: code, cause: { code, retryable } });
}

/** Deterministic per-step operation key, stable across retries of one intent. */
export async function deriveContinuationKey(
  operationKey: string,
  index: number,
  sourceKiloSessionId: string
): Promise<string> {
  const hex = await sha256Hex(`${operationKey}\u0000${index}\u0000${sourceKiloSessionId}`);
  const base = hex.slice(0, 32).split('');
  base[12] = '5';
  base[16] = ((parseInt(base[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const joined = base.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20, 32)}`;
}

/** Stable JSON: object keys sorted, `undefined` dropped, `""` kept. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entryValue]) => [key, canonicalize(entryValue)]));
  }
  return value;
}

/** SHA-256 of the full validated request plus the derived organization. */
export async function continuationRequestDigest(
  input: ContinuationInput,
  organizationId: string | null
): Promise<string> {
  return sha256Hex(
    JSON.stringify(
      canonicalize({
        clientProvenance: input.clientProvenance,
        repository: input.repository,
        activeSourceKiloSessionId: input.activeSourceKiloSessionId,
        sessions: input.sessions,
        organizationId,
      })
    )
  );
}

function sourceRowsQuery(userId: string, ids: string[]) {
  return and(eq(cli_sessions_v2.kilo_user_id, userId), inArray(cli_sessions_v2.session_id, ids));
}

/**
 * Read and validate every source row in one query, derive the single shared
 * organization, and keep the source titles. Fails before any admission.
 */
async function loadContinuationSources(
  db: WorkerDb,
  userId: string,
  input: ContinuationInput
): Promise<{
  organizationId: string | null;
  sources: { sourceKiloSessionId: string; title: string }[];
}> {
  const ids = input.sessions.map(session => session.sourceKiloSessionId);
  const rows = await db
    .select({
      sessionId: cli_sessions_v2.session_id,
      parentSessionId: cli_sessions_v2.parent_session_id,
      gitUrl: cli_sessions_v2.git_url,
      organizationId: cli_sessions_v2.organization_id,
      title: cli_sessions_v2.title,
    })
    .from(cli_sessions_v2)
    .where(sourceRowsQuery(userId, ids));
  const byId = new Map(rows.map(row => [row.sessionId, row]));

  const requestedUrl = canonicalGitUrl(input.repository);
  let organizationId: string | null | undefined;
  const sources: { sourceKiloSessionId: string; title: string }[] = [];
  for (const session of input.sessions) {
    const row = byId.get(session.sourceKiloSessionId);
    if (!row) throw continuationError('source_session_unavailable', false);
    if (row.parentSessionId !== null) throw continuationError('source_session_not_root', false);
    if (
      row.gitUrl != null &&
      requestedUrl !== undefined &&
      normalizeGitUrl(row.gitUrl) !== requestedUrl
    ) {
      throw continuationError('repository_mismatch', false);
    }
    if (organizationId === undefined) {
      organizationId = row.organizationId;
    } else if (organizationId !== row.organizationId) {
      throw continuationError('organization_mismatch', false);
    }
    sources.push({
      sourceKiloSessionId: session.sourceKiloSessionId,
      title: row.title ?? `New session - ${new Date().toISOString()}`,
    });
  }
  return { organizationId: organizationId ?? null, sources };
}

/** Canonical URL of the requested repository, for the nullable `git_url` match. */
function canonicalGitUrl(repository: RepositoryInput): string | undefined {
  const sessionRepository = repositoryInputToSessionRepository(repository);
  if (sessionRepository.type === 'github') {
    return normalizeGitUrl(`https://github.com/${sessionRepository.repo}`);
  }
  return normalizeGitUrl(sessionRepository.url);
}

function readCompletedResult(
  row: OperationLedgerRow
): z.infer<typeof completedResultSchema> | null {
  const parsed = completedResultSchema.safeParse({
    workspaceId: row.canonical_result?.[continuationWorkspaceIdKey],
    destinations: row.canonical_result?.[continuationDestinationsKey],
  });
  return parsed.success ? parsed.data : null;
}

function assertParentIdentity(row: OperationLedgerRow, userId: string): void {
  if (
    row.kilo_user_id !== userId ||
    row.domain !== CONTINUATION_DOMAIN ||
    row.intent !== CONTINUATION_INTENT
  ) {
    throw continuationError('operation_key_reuse_mismatch', false);
  }
}

/** The incoming request B must match the batch fingerprint stored at admission. */
function assertDigestMatches(row: OperationLedgerRow, digest: string): void {
  const stored = row.canonical_result?.[continuationDigestKey];
  if (typeof stored !== 'string' || stored !== digest) {
    throw continuationError('operation_key_reuse_mismatch', false);
  }
}

/** One resolved source plan: the per-source delta over the shared profile. */
type ContinuationPlanSource = {
  sourceKiloSessionId: string;
  title: string;
  agent: { mode: string; model: string; variant?: string };
  /** True when an unavailable requested mode fell back to `code`. */
  modeFallback: boolean;
};

type ContinuationPlan = {
  request: SessionCreateRequest;
  sources: ContinuationPlanSource[];
};

/**
 * Resolve the shared session configuration once (profile, environment, mode
 * fallback) and derive the per-source delta. Only the continuation first
 * session resolves with web defaults, and only this path uses the server-owned
 * mode fallback. A retry re-runs this; a changed resolved setting surfaces as a
 * per-step create-intent conflict.
 */
async function resolveContinuationPlan(args: {
  ctx: TRPCContext;
  input: ContinuationInput;
  organizationId: string | null;
  sources: { sourceKiloSessionId: string; title: string }[];
}): Promise<ContinuationPlan> {
  const firstSession = args.input.sessions[0];
  if (!firstSession) throw continuationError('source_session_unavailable', false);
  const baseRequest: SessionCreateRequest = {
    clone: { cloneFromKiloSessionId: firstSession.sourceKiloSessionId },
    // Copy the agent: preflight applies the continuation mode fallback, and the
    // batch digest and per-source fallback are derived from the caller's request.
    agent: { ...firstSession.agent, variant: firstSession.agent.variant || undefined },
    repository: repositoryInputToSessionRepository(args.input.repository),
    ownershipTitle: args.sources[0]?.title,
    options: {
      kilocodeOrganizationId: args.organizationId ?? undefined,
      createdOnPlatform: 'cloud-agent-web',
      clientProvenance: 'agent-manager',
      workspaceContinuation: true,
    },
  };
  const request = await preflightSessionCreation(
    baseRequest,
    args.ctx,
    'continueHostedWorkspace',
    undefined,
    { includeWebDefaults: true, continuationModeResolution: true }
  );
  const resolvedProfile = request.profile?.resolved ?? {};
  const sources = args.input.sessions.map((session, index) => {
    const mode = resolveContinuationMode(session.agent.mode, resolvedProfile);
    return {
      sourceKiloSessionId: session.sourceKiloSessionId,
      title: args.sources[index]?.title ?? `New session - ${new Date().toISOString()}`,
      agent: {
        mode: mode.mode,
        model: session.agent.model,
        ...(session.agent.variant ? { variant: session.agent.variant } : {}),
      },
      modeFallback: mode.modeFallback,
    };
  });
  return { request, sources };
}

/**
 * The clone-only workspace root request, built from the once-resolved plan. It
 * carries the derived step key on `options.operationKey` because
 * `isEligibleFirstWorktreeSession` and the worktree-enabled replay check both
 * read it from the request, not from the create's ledger options.
 */
function buildChildRequest(
  plan: ContinuationPlan,
  input: ContinuationInput,
  index: number,
  operationKey: string
): SessionCreateRequest {
  const source = plan.sources[index];
  if (!source) throw continuationError('continuation_incomplete', true);
  return {
    clone: { cloneFromKiloSessionId: source.sourceKiloSessionId },
    agent: source.agent,
    repository: repositoryInputToSessionRepository(input.repository),
    ...(plan.request.profile ? { profile: plan.request.profile } : {}),
    ...(plan.request.environment ? { environment: plan.request.environment } : {}),
    ...(plan.request.environmentSandboxAllocation
      ? { environmentSandboxAllocation: plan.request.environmentSandboxAllocation }
      : {}),
    ownershipTitle: source.title,
    options: {
      kilocodeOrganizationId: plan.request.options?.kilocodeOrganizationId,
      createdOnPlatform: 'cloud-agent-web',
      clientProvenance: 'agent-manager',
      workspaceContinuation: true,
      operationKey,
    },
  };
}

/**
 * Map the recorded destinations to the public output in the caller's source
 * order. The agent settings come from the exact matched request (guaranteed
 * equal to the persisted selection by the batch digest) plus the recorded
 * `modeFallback`; nothing is re-resolved and no destination metadata is read, so
 * a completed replay returns the original result even after the destination
 * sessions change or are deleted.
 */
function shapeOutput(args: {
  input: ContinuationInput;
  workspaceId: CloudAgentWorktreeId;
  destinations: ContinuationDestination[];
  replayed: boolean;
}): ContinuationOutput {
  const sessions = [];
  for (const destination of args.destinations) {
    const requested = args.input.sessions.find(
      session => session.sourceKiloSessionId === destination.sourceKiloSessionId
    );
    if (!requested) throw continuationError('continuation_incomplete', true);
    sessions.push({
      sourceKiloSessionId: destination.sourceKiloSessionId,
      kiloSessionId: destination.kiloSessionId,
      cloudAgentSessionId: destination.cloudAgentSessionId,
      agent: {
        mode: destination.modeFallback ? 'code' : requested.agent.mode,
        model: requested.agent.model,
        ...(requested.agent.variant ? { variant: requested.agent.variant } : {}),
      },
      modeFallback: destination.modeFallback,
    });
  }
  const active = args.destinations.find(
    destination => destination.sourceKiloSessionId === args.input.activeSourceKiloSessionId
  );
  if (!active) throw continuationError('continuation_incomplete', true);
  return {
    workspaceId: args.workspaceId,
    sessions,
    activeKiloSessionId: active.kiloSessionId,
    ...(args.replayed ? { replayed: true as const } : {}),
  };
}

/**
 * TRPC codes that mean the child request cannot succeed as-is. They must reach
 * the client as terminal API responses instead of a retryable
 * `continuation_incomplete`, so a deterministic rejection is not retried
 * forever. Transient codes (timeouts, 5xx, rate limits) stay retryable.
 */
const TERMINAL_CHILD_TRPC_CODES: ReadonlySet<TRPCError['code']> = new Set([
  'BAD_REQUEST',
  'FORBIDDEN',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'PAYMENT_REQUIRED',
]);

/**
 * Release a non-terminal parent so the next same-key retry can run immediately
 * instead of waiting out the admitted lease. `markReconcilePending` is a no-op
 * for a terminal or already-reconciling row, so terminal statuses are preserved.
 */
async function releaseParentForRetry(db: WorkerDb, parentRowId: string): Promise<void> {
  try {
    await markReconcilePending(db, { rowId: parentRowId });
  } catch {
    // A concurrent owner already advanced the row; the child ledgers still own
    // the safety and idempotency, so the release is best-effort.
  }
}

/**
 * Classify a per-step create failure. A same-key retry whose immutable child
 * intent changed is terminal for the client, which must clear the key; the CLI
 * recognizes only `operation_key_reuse_mismatch` by name, so a child
 * `session_create_intent_conflict` is reported the same way. A child whose own
 * ledger row is terminally `failed` settles the parent terminal. A deterministic
 * non-retryable TRPC code is surfaced terminal with its original message. Every
 * other failure (transport, live in-flight) stays retryable as
 * `continuation_incomplete`. Any non-terminal stop releases the parent lease.
 */
async function classifyChildFailure(args: {
  db: WorkerDb;
  userId: string;
  parentRowId: string;
  childKey: string;
  error: unknown;
}): Promise<TRPCError> {
  const { db, userId, parentRowId, childKey, error } = args;
  const message = error instanceof TRPCError ? error.message : undefined;
  if (message === 'operation_key_reuse_mismatch' || message === 'session_create_intent_conflict') {
    await releaseParentForRetry(db, parentRowId);
    return continuationError('operation_key_reuse_mismatch', false);
  }

  let childStatus: string | undefined;
  try {
    childStatus = (
      await getOperation(db, { userId, domain: CONTINUATION_DOMAIN, operationKey: childKey })
    )?.status;
  } catch {
    childStatus = undefined;
  }
  if (childStatus === 'failed') {
    // Keep the durable-failed behavior: the parent fails terminal.
    try {
      await settleOperation(db, {
        rowId: parentRowId,
        status: 'failed',
        outcomeCode: 'child_failed',
      });
    } catch {
      // The child row already proves the terminal failure; a failed parent settle
      // only means a concurrent run owns the row.
    }
    return continuationError('session_creation_failed', false);
  }

  await releaseParentForRetry(db, parentRowId);
  if (error instanceof TRPCError && TERMINAL_CHILD_TRPC_CODES.has(error.code)) {
    // Preserve the original code and message so the client treats it as
    // terminal and shows the real reason.
    return new TRPCError({
      code: error.code,
      message: error.message,
      cause: { code: error.message, retryable: false },
    });
  }
  return continuationError('continuation_incomplete', true);
}

/**
 * Run the per-step creates under their deterministic keys, record destination
 * progress on the parent row, then settle it. A partial failure leaves the
 * parent non-terminal, so a later same-key retry resumes from the recorded
 * destinations without duplicating a created session.
 */
async function runContinuationEffects(args: {
  db: WorkerDb;
  ctx: TRPCContext;
  input: ContinuationInput;
  plan: ContinuationPlan;
  organizationId: string | null;
  rowId: string;
  startedAt: number;
  replayed: boolean;
}): Promise<ContinuationOutput> {
  const { db, ctx, input, plan, rowId } = args;
  const destinations: ContinuationDestination[] = [];

  // Step 0: the workspace root, a clone-only worktree session.
  const firstSource = plan.sources[0];
  if (!firstSource) throw continuationError('continuation_incomplete', true);
  const firstKey = await deriveContinuationKey(
    input.operationKey,
    0,
    firstSource.sourceKiloSessionId
  );
  let first: { cloudAgentSessionId: string; kiloSessionId: string };
  try {
    first = await createSessionWithLedger(
      buildChildRequest(plan, input, 0, firstKey),
      { env: ctx.env, userId: ctx.userId, authToken: ctx.authToken, botId: ctx.botId },
      {
        billingOrigin: 'agent-manager',
        operationKey: firstKey,
        includeInitialMessage: false,
        // The create owner resolves the saved sandbox allocation itself.
        resolveSavedAllocationBeforeAdmission: true,
        startedAt: args.startedAt,
      }
    );
  } catch (error) {
    throw await classifyChildFailure({
      db,
      userId: ctx.userId,
      parentRowId: rowId,
      childKey: firstKey,
      error,
    });
  }
  const workspaceId = workspaceIdForSession(first.cloudAgentSessionId);
  await verifyWorkspaceIdentity(db, ctx.userId, first.kiloSessionId, workspaceId);
  destinations.push({
    sourceKiloSessionId: firstSource.sourceKiloSessionId,
    kiloSessionId: first.kiloSessionId,
    cloudAgentSessionId: first.cloudAgentSessionId,
    status: 'registered',
    modeFallback: firstSource.modeFallback,
  });
  await recordOperationProgress(db, rowId, {
    [continuationWorkspaceIdKey]: workspaceId,
    [continuationDestinationsKey]: destinations,
  });

  // Steps 1..n: clone-only siblings. Each owns its own ledger row and replays it.
  for (let index = 1; index < plan.sources.length; index += 1) {
    const source = plan.sources[index];
    if (!source) continue;
    const key = await deriveContinuationKey(input.operationKey, index, source.sourceKiloSessionId);
    let sibling: { cloudAgentSessionId: string; kiloSessionId: string };
    try {
      sibling = await createContinuedWorkspaceSibling({
        db,
        ctx,
        workspaceId,
        organizationId: args.organizationId ?? undefined,
        operationKey: key,
        sourceKiloSessionId: source.sourceKiloSessionId,
        title: source.title,
        agent: source.agent,
      });
    } catch (error) {
      throw await classifyChildFailure({
        db,
        userId: ctx.userId,
        parentRowId: rowId,
        childKey: key,
        error,
      });
    }
    destinations.push({
      sourceKiloSessionId: source.sourceKiloSessionId,
      kiloSessionId: sibling.kiloSessionId,
      cloudAgentSessionId: sibling.cloudAgentSessionId,
      status: 'registered',
      modeFallback: source.modeFallback,
    });
    await recordOperationProgress(db, rowId, { [continuationDestinationsKey]: destinations });
  }

  const settled = await settleOperation(db, {
    rowId,
    status: 'completed',
    outcomeCode: 'ok',
    canonicalResult: { [continuationDestinationsKey]: destinations },
  });
  if (!settled.settled && settled.row?.status !== 'completed') {
    throw continuationError('session_creation_failed', false);
  }

  logger
    .withFields({ operationKey: input.operationKey, workspaceId })
    .info('Continuation workspace admitted');
  return shapeOutput({
    input,
    workspaceId,
    destinations,
    replayed: args.replayed,
  });
}

/** Replays a completed parent from its recorded destinations. */
async function replayCompletedParent(args: {
  db: WorkerDb;
  ctx: TRPCContext;
  input: ContinuationInput;
  row: OperationLedgerRow;
}): Promise<ContinuationOutput> {
  const { db, ctx, input, row } = args;
  if (row.organization_id) {
    await assertOrganizationMembership(db, ctx.userId, row.organization_id);
  }
  if (row.status !== 'completed') throw continuationError('session_creation_failed', false);
  // A same-key replay still requires the same request B. No source rows are
  // read, so a deleted source does not block the replay.
  assertDigestMatches(row, await continuationRequestDigest(input, row.organization_id));
  const recorded = readCompletedResult(row);
  if (!recorded) throw continuationError('continuation_incomplete', true);
  await assertRepositoryAccessBeforeSessionCreation({
    env: ctx.env,
    userId: ctx.userId,
    orgId: row.organization_id ?? undefined,
    repository: repositoryInputToSessionRepository(input.repository),
  });
  return shapeOutput({
    input,
    workspaceId: recorded.workspaceId,
    destinations: recorded.destinations,
    replayed: true,
  });
}

const continueHostedWorkspaceHandler = protectedProcedure
  .input(ContinueHostedWorkspaceInput)
  .output(ContinueHostedWorkspaceOutput)
  .mutation(async ({ input, ctx }): Promise<ContinuationOutput> => {
    if (ctx.botId !== undefined || ctx.cloudAgentAuthority !== undefined) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Unsupported caller for continuation' });
    }
    const db = getPgDb(ctx.env);
    const startedAt = Date.now();

    const existing = await getOperation(db, {
      userId: ctx.userId,
      domain: CONTINUATION_DOMAIN,
      operationKey: input.operationKey,
    });
    if (existing) {
      assertParentIdentity(existing, ctx.userId);
      // A completed parent replays its recorded destinations without reading
      // source rows; membership of the stored organization still applies.
      if (existing.status === 'completed') {
        return replayCompletedParent({ db, ctx, input, row: existing });
      }
    }

    const { organizationId, sources } = await loadContinuationSources(db, ctx.userId, input);
    if (organizationId) await assertOrganizationMembership(db, ctx.userId, organizationId);
    const digest = await continuationRequestDigest(input, organizationId);

    if (existing) {
      // A same-key retry must still send the same request B.
      assertDigestMatches(existing, digest);
      if (existing.status !== 'admitted' && existing.status !== 'reconcile_pending') {
        throw continuationError('session_creation_failed', false);
      }
    } else {
      // Balance is deferred from the middleware to here, after source
      // authorization. The payer is the single derived organization, or the
      // personal balance when every source is personal.
      const balance = await validateBalanceOnly(
        ctx.authToken,
        organizationId ?? undefined,
        ctx.env
      );
      if (!balance.success) {
        throw balance.status === 402
          ? continuationError('insufficient_balance', false)
          : continuationError('balance_unavailable', true);
      }
    }

    const plan = await resolveContinuationPlan({ ctx, input, organizationId, sources });
    const admission = await admitOperation(db, {
      userId: ctx.userId,
      orgId: organizationId,
      domain: CONTINUATION_DOMAIN,
      intent: CONTINUATION_INTENT,
      operationKey: input.operationKey,
      taxonomy: 'safe-retry',
      leaseSeconds: CONTINUATION_STEP_LEASE_SECONDS * input.sessions.length,
      initialCanonicalResult: { [continuationDigestKey]: digest },
    });

    if (admission.admission === 'organization_mismatch') {
      throw continuationError('operation_key_reuse_mismatch', false);
    }
    if (admission.admission === 'duplicate_settled') {
      return replayCompletedParent({ db, ctx, input, row: admission.row });
    }
    if (
      admission.admission === 'duplicate_in_flight' ||
      admission.admission === 'duplicate_reconcile_in_progress'
    ) {
      // Another caller owns the live lease. The per-step creates are idempotent,
      // so the client retries and reuses the same key; a loser with a different
      // request B fails immediately instead.
      assertDigestMatches(admission.row, digest);
      throw continuationError('creation_in_progress', true);
    }
    if (
      admission.admission === 'takeover' ||
      admission.admission === 'duplicate_reconcile_pending'
    ) {
      // A concurrent insert may have admitted the row between our read and the
      // admit; the same request B is still required.
      assertDigestMatches(admission.row, digest);
    }

    return runContinuationEffects({
      db,
      ctx,
      input,
      plan,
      organizationId,
      rowId: admission.row.id,
      startedAt,
      replayed: admission.admission !== 'admitted',
    });
  });

export function createHostedWorkspaceContinuationHandlers(): {
  continueHostedWorkspace: typeof continueHostedWorkspaceHandler;
} {
  return { continueHostedWorkspace: continueHostedWorkspaceHandler };
}
