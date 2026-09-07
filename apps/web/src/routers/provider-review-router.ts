/**
 * Provider review router — GitLab merge requests and Bitbucket Cloud pull
 * requests, composed as ONE tRPC surface (`providerReview`) for mobile.
 *
 * GitHub keeps its own `githubPrReview` router; this router never touches it
 * except to reuse the UGC Terms gate. Inputs are provider-discriminated and
 * carry NO host, NO token, NO instanceUrl: every credential, instance, and
 * repository identity is re-derived per call by the s2/s3 authorization layer
 * (gitlab-authorization.ts / bitbucket-authorization.ts), so a client hint
 * can never pick the host. An organizationId on any input runs
 * `ensureOrganizationAccess` before anything else.
 *
 * Write mutations accept an `operationKey` and run through the shared
 * operation ledger exactly like the GitHub write path (admitOperation /
 * settleOperation from @kilocode/db/operation-ledger). The intent
 * fingerprint comes from s1 with provider identity, so a GitLab comment and
 * a same-named GitHub comment can never share a ledger key.
 */
import 'server-only';

import * as z from 'zod';
import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';

import { baseProcedure, createTRPCRouter, type TRPCContext } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import type { OperationLedgerRow } from '@kilocode/db/schema';
import { PR_OPERATION_SETTLED_EVENT } from '@kilocode/app-shared/analytics';
import { prIntentFingerprint, type PrLedgerIntent } from '@kilocode/app-shared/pr-review';
import {
  providerPrRefKey,
  providerPrTerm,
  type ProviderPrPlatform,
  type ProviderPrRef,
  type ProviderPrSummary,
} from '@kilocode/app-shared/provider-review';
import {
  admitOperation,
  markReconcilePending,
  recordOperationAcceptance,
  settleOperation,
  type OutboxEventInput,
} from '@kilocode/db/operation-ledger';
import { ensureOrganizationAccess } from './organizations/utils';
import { assertTermsAccepted } from './github-pr-review-router';
import { GitLabReviewError } from '@/lib/provider-review/gitlab-authorization';
import { BitbucketReviewError } from '@/lib/provider-review/bitbucket-authorization';
import * as gitlabRead from '@/lib/provider-review/gitlab-read';
import {
  GITLAB_MR_REVIEW_CAPABILITIES,
  addComment as gitlabAddComment,
  disableAutoMerge as gitlabDisableAutoMerge,
  enableAutoMerge as gitlabEnableAutoMerge,
  mergePullRequest as gitlabMerge,
  replyToDiscussion as gitlabReplyToComment,
  resolveThread as gitlabResolveThread,
  submitReview as gitlabSubmitReview,
  unresolveThread as gitlabUnresolveThread,
} from '@/lib/provider-review/gitlab-write';
import * as bitbucketRead from '@/lib/provider-review/bitbucket-read';
import {
  BITBUCKET_AUTO_MERGE_UNSUPPORTED_REASON,
  BITBUCKET_PR_REVIEW_CAPABILITIES,
  addComment as bitbucketAddComment,
  mergePullRequest as bitbucketMerge,
  replyToComment as bitbucketReplyToComment,
  resolveThread as bitbucketResolveThread,
  submitReview as bitbucketSubmitReview,
  unresolveThread as bitbucketUnresolveThread,
} from '@/lib/provider-review/bitbucket-write';
import type { GitLabReviewOwner } from '@/lib/provider-review/gitlab-authorization';
import type { BitbucketReviewOwner } from '@/lib/provider-review/bitbucket-authorization';

// ----- input schemas ----------------------------------------------------------

// GitLab project paths are full nested paths (`group/sub/repo`) — never just
// the last segment. The authorization layer matches them against the
// integration's repository cache; the regex only bounds the shape.
const gitlabProjectPathRegex = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;
const bitbucketSlugRegex = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// tRPC's `useInfiniteQuery` integration injects a `direction` discriminator
// ('forward'|'backward') into the procedure input alongside `cursor`. The
// input stays `.strict()` (unknown fields still rejected), so it must accept
// it explicitly or every infinite-query page 400s — same tolerance as
// github-pr-review-router.ts's ListFilesInput/ListInboxInput.
const infiniteQueryDirection = z.enum(['forward', 'backward']).optional();
const pageCursor = z.string().min(1).max(2048).optional();

// Client-generated UUID, stable across retries of one user intent. When
// present, the mutation admits the operation into the shared ledger and
// becomes retry-safe; when absent, the write runs unledgered (older clients).
const operationKeySchema = z.string().min(1).max(128).optional();

const gitlabIdentityShape = {
  platform: z.literal('gitlab'),
  organizationId: z.uuid().optional(),
  projectPath: z.string().regex(gitlabProjectPathRegex).max(1024),
  mrIid: z.number().int().positive(),
  // Display/matching only — the authorization layer refuses a hint whose
  // origin differs from the connected instance; it is never an API base.
  instanceHint: z.string().min(1).max(2048).optional(),
};

const bitbucketIdentityShape = {
  platform: z.literal('bitbucket'),
  // Bitbucket Cloud is organization-context only: the id is required and the
  // org guard always runs.
  organizationId: z.uuid(),
  workspace: z.string().regex(bitbucketSlugRegex).max(100),
  repoSlug: z.string().regex(bitbucketSlugRegex).max(100),
  prId: z.number().int().positive(),
};

/** One provider-discriminated PR/MR ref input, `.strict()` on both arms. */
function providerRefInput<T extends z.ZodRawShape>(extra: T) {
  return z.discriminatedUnion('platform', [
    z.object({ ...gitlabIdentityShape, ...extra }).strict(),
    z.object({ ...bitbucketIdentityShape, ...extra }).strict(),
  ]);
}

/** The ref-only identity (inbox, capabilities): no repository to pin. */
const providerIdentityInput = z.discriminatedUnion('platform', [
  z
    .object({
      platform: z.literal('gitlab'),
      organizationId: z.uuid().optional(),
      instanceHint: z.string().min(1).max(2048).optional(),
    })
    .strict(),
  z.object({ platform: z.literal('bitbucket'), organizationId: z.uuid() }).strict(),
]);

const GetPullRequestInput = providerRefInput({});

const ListFilesInput = providerRefInput({ cursor: pageCursor, direction: infiniteQueryDirection });

const ListDiscussionsInput = providerRefInput({
  cursor: pageCursor,
  direction: infiniteQueryDirection,
});

const ListChecksInput = providerRefInput({});

const ListInboxInput = z.discriminatedUnion('platform', [
  z
    .object({
      platform: z.literal('gitlab'),
      organizationId: z.uuid().optional(),
      instanceHint: z.string().min(1).max(2048).optional(),
      cursor: pageCursor,
      direction: infiniteQueryDirection,
    })
    .strict(),
  z
    .object({
      platform: z.literal('bitbucket'),
      organizationId: z.uuid(),
      cursor: pageCursor,
      direction: infiniteQueryDirection,
    })
    .strict(),
]);

const GetCapabilitiesInput = providerIdentityInput;

const GetMergeStateInput = providerRefInput({});

const GetFileLinesInput = providerRefInput({
  ref: z.string().min(1).max(255),
  path: z.string().min(1).max(1024),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});

const AddCommentInput = providerRefInput({
  body: z.string().min(1).max(65_535),
  operationKey: operationKeySchema,
});

const ReplyToCommentInput = z.discriminatedUnion('platform', [
  // GitLab replies land inside a discussion; the discussion id is the thread.
  z
    .object({
      ...gitlabIdentityShape,
      discussionId: z.string().min(1).max(256),
      body: z.string().min(1).max(65_535),
      operationKey: operationKeySchema,
    })
    .strict(),
  // Bitbucket replies attach to a parent comment.
  z
    .object({
      ...bitbucketIdentityShape,
      commentId: z.string().min(1).max(64),
      body: z.string().min(1).max(65_535),
      operationKey: operationKeySchema,
    })
    .strict(),
]);

const SubmitReviewInput = providerRefInput({
  event: z.enum(['approve', 'request_changes', 'comment']),
  body: z.string().min(1).max(65_535).optional(),
  operationKey: operationKeySchema,
});

const ResolveThreadInput = z.discriminatedUnion('platform', [
  z
    .object({
      ...gitlabIdentityShape,
      discussionId: z.string().min(1).max(256),
      operationKey: operationKeySchema,
    })
    .strict(),
  z
    .object({
      ...bitbucketIdentityShape,
      threadId: z.string().min(1).max(64),
      operationKey: operationKeySchema,
    })
    .strict(),
]);

const MergePullRequestInput = z.discriminatedUnion('platform', [
  z
    .object({
      ...gitlabIdentityShape,
      expectedHeadSha: z.string().min(6).max(64),
      squash: z.boolean().optional(),
      deleteBranch: z.boolean().optional(),
      commitTitle: z.string().min(1).max(255).optional(),
      commitMessage: z.string().min(1).max(65_535).optional(),
      operationKey: operationKeySchema,
    })
    .strict(),
  z
    .object({
      ...bitbucketIdentityShape,
      expectedHeadSha: z.string().min(6).max(64),
      deleteBranch: z.boolean().optional(),
      commitMessage: z.string().min(1).max(65_535).optional(),
      operationKey: operationKeySchema,
    })
    .strict(),
]);

// Arming auto-merge requires the head fence: GitLab's merge endpoint arms
// merge-when-pipeline-succeeds only while a pipeline runs, and the sha ties
// the arming to the exact revision the reviewer saw. Cancelling arms nothing,
// so the disable input keeps the fence optional.
const EnableAutoMergeInput = providerRefInput({
  expectedHeadSha: z.string().min(6).max(64),
  operationKey: operationKeySchema,
});

const DisableAutoMergeInput = providerRefInput({
  expectedHeadSha: z.string().min(6).max(64).optional(),
  operationKey: operationKeySchema,
});

// ----- owner + identity helpers -----------------------------------------------

/**
 * Resolve the review owner. An organizationId runs `ensureOrganizationAccess`
 * (the guard from organizations/utils.ts, unchanged) BEFORE any provider
 * call; the acting user id always comes from `ctx.user`, never from input.
 */
async function gitlabOwner(
  ctx: TRPCContext,
  input: { organizationId?: string }
): Promise<GitLabReviewOwner> {
  if (input.organizationId) {
    await ensureOrganizationAccess(ctx, input.organizationId);
    return { type: 'organization', organizationId: input.organizationId, userId: ctx.user.id };
  }
  return { type: 'user', userId: ctx.user.id };
}

async function bitbucketOwner(
  ctx: TRPCContext,
  input: { organizationId: string }
): Promise<BitbucketReviewOwner> {
  await ensureOrganizationAccess(ctx, input.organizationId);
  return { type: 'organization', organizationId: input.organizationId, userId: ctx.user.id };
}

function providerRef(input: {
  platform: ProviderPrPlatform;
  projectPath?: string;
  mrIid?: number;
  instanceHint?: string;
  workspace?: string;
  repoSlug?: string;
  prId?: number;
}): ProviderPrRef {
  if (input.platform === 'gitlab') {
    return {
      platform: 'gitlab',
      projectPath: String(input.projectPath),
      mrIid: Number(input.mrIid),
      instanceHint: input.instanceHint,
    };
  }
  return {
    platform: 'bitbucket',
    workspace: String(input.workspace),
    repoSlug: String(input.repoSlug),
    prId: Number(input.prId),
  };
}

/**
 * Map one classified provider failure onto the mobile error states.
 * `retryable` becomes BAD_GATEWAY (the ledger's ambiguous marker), a moved
 * head becomes CONFLICT carrying the exact stale-head reason, the rest are
 * deterministic rejections. The provider message is fixed copy that never
 * embeds a token or an instance URL.
 */
function toProviderTrpcError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;
  if (error instanceof GitLabReviewError || error instanceof BitbucketReviewError) {
    switch (error.kind) {
      case 'not_found':
        return new TRPCError({ code: 'NOT_FOUND', message: error.message });
      case 'forbidden':
        return new TRPCError({ code: 'FORBIDDEN', message: error.message });
      case 'stale_head':
        return new TRPCError({ code: 'CONFLICT', message: error.message });
      case 'bad_request':
        return new TRPCError({ code: 'BAD_REQUEST', message: error.message });
      case 'retryable':
        return new TRPCError({ code: 'BAD_GATEWAY', message: error.message });
    }
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'The review request failed. Please try again.',
  });
}

/** Run one provider read/write and surface only classified tRPC errors. */
async function providerCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toProviderTrpcError(error);
  }
}

// ----- PR operation ledger ------------------------------------------------------

// Same shared ledger, domain, lease, and admission state machine as the
// GitHub write path (github-pr-review-router.ts). The GitHub helpers are
// private and coupled to its token-retry wrapper, so this router reuses the
// exported ledger primitives (admitOperation/settleOperation/…) and the s1
// fingerprint instead of extracting that plumbing.
const PROVIDER_LEDGER_DOMAIN = 'pr' as const;
const PROVIDER_LEDGER_LEASE_SECONDS = 120;

const OPERATION_IN_PROGRESS_MESSAGE = 'operation_in_progress';
const OPERATION_KEY_REUSE_MISMATCH_MESSAGE = 'operation_key_reuse_mismatch';
const PROVIDER_REPLAY_FAILED_MESSAGE = 'This action did not complete. Please try again.';
// The provider effect committed but the settle failed: the row is still
// non-terminal, so a success receipt would falsely claim a retry-safe replay.
const PROVIDER_LEDGER_SETTLE_FAILED_MESSAGE =
  'The action completed, but we could not record the result. Please try again.';
// The reconcile-pending write failed, so the ambiguous marker's promise (a
// same-key retry reconciles instead of re-executing) does not hold.
const PROVIDER_LEDGER_PERSISTENCE_FAILED_MESSAGE =
  'We could not record this action. Please try again later.';

/**
 * The provider ledger resource identity: the s1 canonical ref key (platform
 * + normalized instance origin + repository path + number — so a GitLab
 * comment and a same-named GitHub comment can never share a ledger key) plus
 * a hash of the s1 intent fingerprint. Exported so router tests can build the
 * exact stored identity.
 */
export function providerLedgerResourceKey(
  intent: PrLedgerIntent,
  ref: ProviderPrRef,
  fingerprintInput: Record<string, unknown>
): string {
  const fingerprint = createHash('sha256')
    .update(prIntentFingerprint(intent, fingerprintInput))
    .digest('hex')
    .slice(0, 16);
  return `${providerPrRefKey(ref)}::${fingerprint}`;
}

/**
 * The fingerprint input: the provider identity fields s1 folds into the
 * resource (platform, projectPath/workspace, mrIid/prId as `number`, the
 * GitLab instance hint) plus the intent-defining fields.
 */
function gitlabFingerprintInput(
  input: { projectPath: string; mrIid: number; instanceHint?: string },
  fields: Record<string, unknown>
): Record<string, unknown> {
  return {
    platform: 'gitlab',
    projectPath: input.projectPath,
    instanceHint: input.instanceHint,
    number: input.mrIid,
    ...fields,
  };
}

function bitbucketFingerprintInput(
  input: { workspace: string; repoSlug: string; prId: number },
  fields: Record<string, unknown>
): Record<string, unknown> {
  return {
    platform: 'bitbucket',
    workspace: input.workspace,
    repoSlug: input.repoSlug,
    number: input.prId,
    ...fields,
  };
}

function ambiguousProviderError(platform: ProviderPrPlatform): TRPCError {
  return new TRPCError({
    code: 'CONFLICT',
    message: `Couldn't confirm — check the ${providerPrTerm(platform)} before retrying.`,
  });
}

/**
 * Best-effort ledger write, reserved for FAILED-status settles only: the
 * caller is already receiving a typed rejection, so a ledger write that fails
 * here must never mask the provider outcome.
 */
async function bestEffortLedgerWrite(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(
      `Failed to write provider PR operation ledger row: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** `pr_operation_settled` outbox payload (DEC-05): no free text, no resource keys. */
function providerSettledOutboxEvent(params: {
  distinctId: string;
  intent: PrLedgerIntent;
  outcome: 'completed' | 'failed' | 'ambiguous';
  reconcileResult?: 'confirmed_completed' | 'confirmed_absent' | 'unresolved';
  startedAt: number;
}): OutboxEventInput {
  return {
    eventName: PR_OPERATION_SETTLED_EVENT,
    distinctId: params.distinctId,
    properties: {
      source: 'web',
      surface: 'pr',
      phase: 'terminal',
      intent: params.intent,
      outcome: params.outcome,
      ...(params.reconcileResult !== undefined ? { reconcile_result: params.reconcileResult } : {}),
      duration_ms: Math.max(0, Date.now() - params.startedAt),
    },
  };
}

type ReplayedResult<T> = T & { replayed: true };

/** The canonical result replayed under the same key carries `replayed: true`. */
interface ProviderLedgerBase {
  userId: string;
  /** Analytics identity channel, from `ctx.user` — never re-queried. */
  distinctId: string;
  intent: PrLedgerIntent;
  startedAt: number;
  platform: ProviderPrPlatform;
}

/**
 * Settles a provider-confirmed outcome as `completed`. The effect committed,
 * so a settle that fails must never be swallowed: the canonical evidence is
 * preserved on the still non-terminal row and a retryable server error is
 * thrown — never a false "did not complete" for a committed write.
 */
async function settleCompletedProviderRow(
  base: ProviderLedgerBase,
  row: OperationLedgerRow,
  canonicalResult: Record<string, unknown>,
  reconcileResult?: 'confirmed_completed'
): Promise<void> {
  try {
    await settleOperation(db, {
      rowId: row.id,
      status: 'completed',
      outcomeCode: 'ok',
      canonicalResult,
      outboxEvent: providerSettledOutboxEvent({
        distinctId: base.distinctId,
        intent: base.intent,
        outcome: 'completed',
        reconcileResult,
        startedAt: base.startedAt,
      }),
    });
  } catch (error) {
    // The provider layer reports no external reference (no comment id, no
    // review id), so only the canonical evidence is preserved.
    await bestEffortLedgerWrite(() =>
      recordOperationAcceptance(db, { rowId: row.id, providerRef: null, canonicalResult })
    );
    console.error(
      `Failed to settle completed provider PR operation ledger row: ${error instanceof Error ? error.message : String(error)}`
    );
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: PROVIDER_LEDGER_SETTLE_FAILED_MESSAGE,
      cause: error,
    });
  }
}

/** Best-effort `failed` settle; the caller is already surfacing a typed rejection. */
async function settleFailedProviderRow(
  base: ProviderLedgerBase,
  row: OperationLedgerRow,
  outcomeCode: string,
  reconcileResult?: 'confirmed_absent'
): Promise<void> {
  await bestEffortLedgerWrite(() =>
    settleOperation(db, {
      rowId: row.id,
      status: 'failed',
      outcomeCode,
      outboxEvent: providerSettledOutboxEvent({
        distinctId: base.distinctId,
        intent: base.intent,
        outcome: 'failed',
        reconcileResult,
        startedAt: base.startedAt,
      }),
    })
  );
}

/**
 * Marks the row `reconcile_pending` and then throws the ambiguous CONFLICT —
 * never returns. If persistence fails the row stays `admitted` and a same-key
 * retry could re-execute a possibly-committed write, so the distinct
 * non-retryable persistence error is thrown instead of the ambiguous marker.
 */
async function failProviderRowAmbiguous(
  base: ProviderLedgerBase,
  row: OperationLedgerRow
): Promise<never> {
  try {
    const updated = await markReconcilePending(db, {
      rowId: row.id,
      outboxEvent: providerSettledOutboxEvent({
        distinctId: base.distinctId,
        intent: base.intent,
        outcome: 'ambiguous',
        reconcileResult: 'unresolved',
        startedAt: base.startedAt,
      }),
    });
    if (!updated || updated.status !== 'reconcile_pending') {
      throw new Error('markReconcilePending did not leave the row reconcile_pending');
    }
  } catch (error) {
    console.error(
      `Failed to mark provider PR operation ledger row reconcile-pending: ${error instanceof Error ? error.message : String(error)}`
    );
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: PROVIDER_LEDGER_PERSISTENCE_FAILED_MESSAGE,
      cause: error,
    });
  }
  throw ambiguousProviderError(base.platform);
}

/**
 * Coarse ledger outcome code derived from the classified failure. The
 * stale-head kind is folded to `head_moved` from the ORIGINAL error (the
 * fixed CONFLICT copy contains no 'head' word to match on); everything else
 * follows the tRPC code, mirroring `outcomeCodeFromTrpcError` in the GitHub
 * write path.
 */
function outcomeCodeFromFailure(error: unknown, trpcError: TRPCError): string {
  if (error instanceof GitLabReviewError || error instanceof BitbucketReviewError) {
    if (error.kind === 'stale_head') return 'head_moved';
  }
  switch (trpcError.code) {
    case 'NOT_FOUND':
      return 'not_found';
    case 'PRECONDITION_FAILED':
      return 'precondition_failed';
    case 'TOO_MANY_REQUESTS':
      return 'too_many_requests';
    case 'FORBIDDEN':
      return 'forbidden';
    case 'CONFLICT':
      return 'conflict';
    default:
      return 'bad_request';
  }
}

/**
 * Whether a classified failure leaves the effect's presence unknown. A
 * retryable provider failure (BAD_GATEWAY) may have committed; for merge, a
 * NOT_FOUND is a read failure (the merge begins with an authoritative read),
 * never a confirmed rejection — same rule as the GitHub write path.
 */
function isAmbiguousFailure(error: TRPCError, intent: PrLedgerIntent): boolean {
  if (error.code === 'BAD_GATEWAY') return true;
  return intent === 'merge' && error.code === 'NOT_FOUND';
}

/**
 * Runs the provider write under an admitted row and settles it. A
 * deterministic rejection settles `failed` and rethrows the classified error;
 * an ambiguous failure becomes `reconcile_pending` and never settles terminal.
 */
async function executeProviderWrite<T extends Record<string, unknown>>(
  base: ProviderLedgerBase,
  row: OperationLedgerRow,
  write: () => Promise<T>
): Promise<T> {
  let canonical: T;
  try {
    canonical = await write();
  } catch (error) {
    const trpcError = toProviderTrpcError(error);
    if (isAmbiguousFailure(trpcError, base.intent)) {
      return failProviderRowAmbiguous(base, row);
    }
    await settleFailedProviderRow(base, row, outcomeCodeFromFailure(error, trpcError));
    throw trpcError;
  }
  // The write committed: settle completed at the committed-effect boundary.
  await settleCompletedProviderRow(base, row, canonical);
  return canonical;
}

/** Replays a terminal row: only `completed`/`no_op` may replay a canonical result. */
function replaySettledProviderRow<T>(row: OperationLedgerRow): ReplayedResult<T> {
  if (row.status === 'completed' || row.status === 'no_op') {
    return { ...(row.canonical_result ?? {}), replayed: true } as ReplayedResult<T>;
  }
  // A settled `failed` row cannot be recovered under the same key: surface a
  // non-retryable typed rejection so the client starts a fresh intent.
  throw new TRPCError({ code: 'BAD_REQUEST', message: PROVIDER_REPLAY_FAILED_MESSAGE });
}

type ProviderLedgerMutationArgs<T> = ProviderLedgerBase & {
  operationKey: string;
  resourceKey: string;
  /** Runs the provider effect under an already-admitted row. */
  execute: (row: OperationLedgerRow) => Promise<T>;
  /**
   * Reconcilies a same-key retry before any effect. `'re-execute'` is only
   * valid for idempotent writes (the provider layer detects the target state
   * and reports `replayed`); comment-like intents pass a reconciler that
   * stays reconcile-pending instead of risking a duplicate write.
   */
  reconcile: (row: OperationLedgerRow) => Promise<T | ReplayedResult<T>>;
};

/**
 * Ledger orchestration for a provider mutation — the same admission state
 * machine as the GitHub write path:
 * - `admitted`: run the effect and settle completed / failed / reconcile-pending.
 * - `duplicate_settled`: replay the sanitized canonical result marked replayed.
 * - `duplicate_in_flight` / `duplicate_reconcile_in_progress`: CONFLICT
 *   `operation_in_progress` (never re-execute).
 * - `takeover` / `duplicate_reconcile_pending`: reconcile before any effect.
 *
 * Before ANY outcome is honored, the row is compared against the request's
 * intent and resource identity (which embeds the provider-tagged request
 * fingerprint); a mismatch refuses the key reuse with no effect and no replay.
 */
async function runProviderLedgerMutation<T>(
  args: ProviderLedgerMutationArgs<T>
): Promise<T | ReplayedResult<T>> {
  const admission = await admitOperation(db, {
    userId: args.userId,
    domain: PROVIDER_LEDGER_DOMAIN,
    intent: args.intent,
    operationKey: args.operationKey,
    resourceKey: args.resourceKey,
    taxonomy: 'reconcile-first',
    leaseSeconds: PROVIDER_LEDGER_LEASE_SECONDS,
  });

  if (admission.row.intent !== args.intent || admission.row.resource_key !== args.resourceKey) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: OPERATION_KEY_REUSE_MISMATCH_MESSAGE,
    });
  }

  switch (admission.admission) {
    case 'admitted':
      return args.execute(admission.row);
    case 'duplicate_settled':
      return replaySettledProviderRow<T>(admission.row);
    case 'duplicate_in_flight':
    case 'duplicate_reconcile_in_progress':
      throw new TRPCError({ code: 'CONFLICT', message: OPERATION_IN_PROGRESS_MESSAGE });
    case 'takeover':
    case 'duplicate_reconcile_pending':
      return args.reconcile(admission.row);
  }
}

/**
 * The shared mutation runner: without an `operationKey` the write runs
 * unledgered (legacy clients); with one it admits a `pr` row and only then
 * runs the provider effect. `reconcileAmbiguous` is true for the non-idempotent
 * comment/review intents — a same-key retry then never re-executes the write.
 */
async function runProviderMutation<T extends Record<string, unknown>>(args: {
  ctx: TRPCContext;
  ref: ProviderPrRef;
  intent: PrLedgerIntent;
  fingerprintInput: Record<string, unknown>;
  operationKey: string | undefined;
  write: () => Promise<T>;
  reconcileAmbiguous: boolean;
}): Promise<T | ReplayedResult<T>> {
  const guarded = () => providerCall(args.write);
  if (args.operationKey === undefined) {
    return guarded();
  }
  const base: ProviderLedgerBase = {
    userId: args.ctx.user.id,
    distinctId: args.ctx.user.google_user_email ?? args.ctx.user.id,
    intent: args.intent,
    startedAt: Date.now(),
    platform: args.ref.platform,
  };
  const resourceKey = providerLedgerResourceKey(args.intent, args.ref, args.fingerprintInput);
  const execute = (row: OperationLedgerRow) => executeProviderWrite(base, row, args.write);
  return runProviderLedgerMutation<T>({
    ...base,
    operationKey: args.operationKey,
    resourceKey,
    execute,
    reconcile: args.reconcileAmbiguous ? row => failProviderRowAmbiguous(base, row) : execute,
  });
}

/**
 * The merge reconcile: read the authoritative PR/MR state (via the caller's
 * owner-bound reader — the same authorization the write path uses) before any
 * effect.
 * - merged → settle completed and replay;
 * - closed/declined, or the head moved → the fenced merge never committed →
 *   settle failed (`confirmed_absent`) and surface a conflict carrying the
 *   exact reason;
 * - open with the expected head intact → re-execute the merge under the row;
 * - the authoritative read failed → stay reconcile-pending, surface ambiguous.
 */
async function reconcileMergeProviderRow<T extends Record<string, unknown>>(
  base: ProviderLedgerBase,
  row: OperationLedgerRow,
  args: {
    expectedHeadSha: string;
    /** Authoritative PR/MR read through the caller's owner-bound ref. */
    readSummary: () => Promise<ProviderPrSummary>;
    execute: () => Promise<T>;
  }
): Promise<T | ReplayedResult<T>> {
  let state:
    | { kind: 'merged' }
    | { kind: 'closed' }
    | { kind: 'lineage_intact' }
    | { kind: 'stale_head' }
    | { kind: 'unresolved' } = { kind: 'unresolved' };
  try {
    const summary = await args.readSummary();
    if (summary.state === 'merged') state = { kind: 'merged' };
    else if (summary.state === 'closed') state = { kind: 'closed' };
    else
      state =
        summary.headSha === args.expectedHeadSha
          ? { kind: 'lineage_intact' }
          : { kind: 'stale_head' };
  } catch {
    // A failed authoritative read — including a provider NOT_FOUND (PR
    // missing, access revoked, or a transient failure) — leaves the state
    // `unresolved`. Only explicit provider state settles the row absent.
  }

  switch (state.kind) {
    case 'merged': {
      const canonical = { done: true, replayed: true };
      await settleCompletedProviderRow(base, row, canonical, 'confirmed_completed');
      return { ...canonical, replayed: true } as unknown as ReplayedResult<T>;
    }
    case 'closed':
    case 'stale_head':
      await settleFailedProviderRow(
        base,
        row,
        state.kind === 'closed' ? 'already_closed' : 'head_moved',
        'confirmed_absent'
      );
      throw new TRPCError({
        code: 'CONFLICT',
        message:
          state.kind === 'stale_head'
            ? `The ${providerPrTerm(base.platform)} changed since it was loaded. Reload the ${providerPrTerm(base.platform)} and try again.`
            : `The ${providerPrTerm(base.platform)} was closed without merging.`,
      });
    case 'lineage_intact':
      return executeProviderWrite(base, row, args.execute);
    case 'unresolved':
      return failProviderRowAmbiguous(base, row);
  }
}

// ----- router ------------------------------------------------------------------

export const providerReviewRouter = createTRPCRouter({
  getPullRequest: baseProcedure.input(GetPullRequestInput).query(async ({ ctx, input }) => {
    if (input.platform === 'gitlab') {
      const owner = await gitlabOwner(ctx, input);
      return providerCall(() =>
        gitlabRead.getMergeRequest(owner, input.projectPath, input.mrIid, input.instanceHint)
      );
    }
    const owner = await bitbucketOwner(ctx, input);
    return providerCall(() =>
      bitbucketRead.getPullRequest(owner, input.workspace, input.repoSlug, input.prId)
    );
  }),

  listChecks: baseProcedure.input(ListChecksInput).query(async ({ ctx, input }) => {
    if (input.platform === 'gitlab') {
      const owner = await gitlabOwner(ctx, input);
      return providerCall(() =>
        gitlabRead.listChecks(owner, input.projectPath, input.mrIid, input.instanceHint)
      );
    }
    const owner = await bitbucketOwner(ctx, input);
    return providerCall(() =>
      bitbucketRead.listChecks(owner, input.workspace, input.repoSlug, input.prId)
    );
  }),

  listFiles: baseProcedure.input(ListFilesInput).query(async ({ ctx, input }) => {
    if (input.platform === 'gitlab') {
      const owner = await gitlabOwner(ctx, input);
      return providerCall(() =>
        gitlabRead.listChangedFiles(
          owner,
          input.projectPath,
          input.mrIid,
          input.cursor,
          input.instanceHint
        )
      );
    }
    const owner = await bitbucketOwner(ctx, input);
    return providerCall(() =>
      bitbucketRead.listChangedFiles(
        owner,
        input.workspace,
        input.repoSlug,
        input.prId,
        input.cursor
      )
    );
  }),

  getFileLines: baseProcedure.input(GetFileLinesInput).query(async ({ ctx, input }) => {
    if (input.endLine < input.startLine) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'endLine must be >= startLine' });
    }
    if (input.platform === 'gitlab') {
      const owner = await gitlabOwner(ctx, input);
      return providerCall(() =>
        gitlabRead.getFileLines(
          owner,
          input.projectPath,
          input.ref,
          input.path,
          input.startLine,
          input.endLine,
          input.instanceHint
        )
      );
    }
    const owner = await bitbucketOwner(ctx, input);
    return providerCall(() =>
      bitbucketRead.getFileLines(
        owner,
        input.workspace,
        input.repoSlug,
        input.ref,
        input.path,
        input.startLine,
        input.endLine
      )
    );
  }),

  listDiscussions: baseProcedure.input(ListDiscussionsInput).query(async ({ ctx, input }) => {
    if (input.platform === 'gitlab') {
      const owner = await gitlabOwner(ctx, input);
      return providerCall(() =>
        gitlabRead.listDiscussions(
          owner,
          input.projectPath,
          input.mrIid,
          input.cursor,
          input.instanceHint
        )
      );
    }
    const owner = await bitbucketOwner(ctx, input);
    return providerCall(() =>
      bitbucketRead.listDiscussions(
        owner,
        input.workspace,
        input.repoSlug,
        input.prId,
        input.cursor
      )
    );
  }),

  /**
   * The authorized review inbox: open MRs/PRs requesting the caller's
   * review. Every item carries its provider ref, so the list can never
   * navigate into a different provider's repo. Read-only — no ledger.
   */
  listInbox: baseProcedure.input(ListInboxInput).query(async ({ ctx, input }) => {
    if (input.platform === 'gitlab') {
      const owner = await gitlabOwner(ctx, input);
      return providerCall(() => gitlabRead.listInbox(owner, input.cursor, input.instanceHint));
    }
    const owner = await bitbucketOwner(ctx, input);
    return providerCall(() => bitbucketRead.listInbox(owner, input.cursor));
  }),

  /**
   * The provider-correct capability list. GitLab answers with the MR list
   * (no `request_changes` event — the provider has none), Bitbucket with the
   * shared s1 constant (auto-merge and reactions carry their reason strings).
   */
  getCapabilities: baseProcedure.input(GetCapabilitiesInput).query(async ({ ctx, input }) => {
    if (input.platform === 'gitlab') {
      await gitlabOwner(ctx, input);
      return GITLAB_MR_REVIEW_CAPABILITIES;
    }
    await bitbucketOwner(ctx, input);
    return BITBUCKET_PR_REVIEW_CAPABILITIES;
  }),

  getMergeState: baseProcedure.input(GetMergeStateInput).query(async ({ ctx, input }) => {
    if (input.platform === 'gitlab') {
      const owner = await gitlabOwner(ctx, input);
      return providerCall(() =>
        gitlabRead.getMergeState(owner, input.projectPath, input.mrIid, input.instanceHint)
      );
    }
    const owner = await bitbucketOwner(ctx, input);
    return providerCall(() =>
      bitbucketRead.getMergeRestrictions(owner, input.workspace, input.repoSlug, input.prId)
    );
  }),

  /** Post a top-level comment. UGC-gated and ledgered like the GitHub path. */
  addComment: baseProcedure.input(AddCommentInput).mutation(async ({ ctx, input }) => {
    await assertTermsAccepted(ctx.user.id);
    if (input.platform === 'gitlab') {
      const owner = await gitlabOwner(ctx, input);
      return runProviderMutation({
        ctx,
        ref: providerRef(input),
        intent: 'create_review_comment',
        fingerprintInput: gitlabFingerprintInput(input, { body: input.body }),
        operationKey: input.operationKey,
        write: () =>
          gitlabAddComment({
            owner,
            projectPath: input.projectPath,
            mrIid: input.mrIid,
            instanceHint: input.instanceHint,
            body: input.body,
          }),
        reconcileAmbiguous: true,
      });
    }
    const owner = await bitbucketOwner(ctx, input);
    return runProviderMutation({
      ctx,
      ref: providerRef(input),
      intent: 'create_review_comment',
      fingerprintInput: bitbucketFingerprintInput(input, { body: input.body }),
      operationKey: input.operationKey,
      write: () =>
        bitbucketAddComment({
          owner,
          workspace: input.workspace,
          repoSlug: input.repoSlug,
          prId: input.prId,
          body: input.body,
        }),
      reconcileAmbiguous: true,
    });
  }),

  /** Reply inside an existing thread (GitLab discussion / Bitbucket comment). */
  replyToComment: baseProcedure.input(ReplyToCommentInput).mutation(async ({ ctx, input }) => {
    await assertTermsAccepted(ctx.user.id);
    if (input.platform === 'gitlab') {
      const owner = await gitlabOwner(ctx, input);
      return runProviderMutation({
        ctx,
        ref: providerRef(input),
        intent: 'reply_comment',
        fingerprintInput: gitlabFingerprintInput(input, {
          commentId: input.discussionId,
          body: input.body,
        }),
        operationKey: input.operationKey,
        write: () =>
          gitlabReplyToComment({
            owner,
            projectPath: input.projectPath,
            mrIid: input.mrIid,
            instanceHint: input.instanceHint,
            discussionId: input.discussionId,
            body: input.body,
          }),
        reconcileAmbiguous: true,
      });
    }
    const owner = await bitbucketOwner(ctx, input);
    return runProviderMutation({
      ctx,
      ref: providerRef(input),
      intent: 'reply_comment',
      fingerprintInput: bitbucketFingerprintInput(input, {
        commentId: input.commentId,
        body: input.body,
      }),
      operationKey: input.operationKey,
      write: () =>
        bitbucketReplyToComment({
          owner,
          workspace: input.workspace,
          repoSlug: input.repoSlug,
          prId: input.prId,
          commentId: input.commentId,
          body: input.body,
        }),
      reconcileAmbiguous: true,
    });
  }),

  /**
   * Submit a review. GitLab has no request-changes event: the write layer
   * refuses it with the exact reason (BAD_REQUEST), never a silent fallback.
   */
  submitReview: baseProcedure.input(SubmitReviewInput).mutation(async ({ ctx, input }) => {
    await assertTermsAccepted(ctx.user.id);
    if (input.platform === 'gitlab') {
      const owner = await gitlabOwner(ctx, input);
      return runProviderMutation({
        ctx,
        ref: providerRef(input),
        intent: 'submit_review',
        fingerprintInput: gitlabFingerprintInput(input, {
          event: input.event,
          body: input.body,
        }),
        operationKey: input.operationKey,
        write: () =>
          gitlabSubmitReview({
            owner,
            projectPath: input.projectPath,
            mrIid: input.mrIid,
            instanceHint: input.instanceHint,
            event: input.event,
            body: input.body,
          }),
        reconcileAmbiguous: true,
      });
    }
    const owner = await bitbucketOwner(ctx, input);
    return runProviderMutation({
      ctx,
      ref: providerRef(input),
      intent: 'submit_review',
      fingerprintInput: bitbucketFingerprintInput(input, {
        event: input.event,
        body: input.body,
      }),
      operationKey: input.operationKey,
      write: () =>
        bitbucketSubmitReview({
          owner,
          workspace: input.workspace,
          repoSlug: input.repoSlug,
          prId: input.prId,
          event: input.event,
          body: input.body,
        }),
      reconcileAmbiguous: true,
    });
  }),

  resolveThread: baseProcedure.input(ResolveThreadInput).mutation(async ({ ctx, input }) => {
    if (input.platform === 'gitlab') {
      const owner = await gitlabOwner(ctx, input);
      return runProviderMutation({
        ctx,
        ref: providerRef(input),
        intent: 'resolve_thread',
        fingerprintInput: gitlabFingerprintInput(input, { threadId: input.discussionId }),
        operationKey: input.operationKey,
        write: () =>
          gitlabResolveThread({
            owner,
            projectPath: input.projectPath,
            mrIid: input.mrIid,
            instanceHint: input.instanceHint,
            discussionId: input.discussionId,
          }),
        // Resolving is idempotent at the provider layer (already-resolved
        // reports `replayed`), so a same-key retry may re-execute safely.
        reconcileAmbiguous: false,
      });
    }
    const owner = await bitbucketOwner(ctx, input);
    return runProviderMutation({
      ctx,
      ref: providerRef(input),
      intent: 'resolve_thread',
      fingerprintInput: bitbucketFingerprintInput(input, { threadId: input.threadId }),
      operationKey: input.operationKey,
      write: () =>
        bitbucketResolveThread({
          owner,
          workspace: input.workspace,
          repoSlug: input.repoSlug,
          prId: input.prId,
          threadId: input.threadId,
        }),
      reconcileAmbiguous: false,
    });
  }),

  unresolveThread: baseProcedure.input(ResolveThreadInput).mutation(async ({ ctx, input }) => {
    if (input.platform === 'gitlab') {
      const owner = await gitlabOwner(ctx, input);
      return runProviderMutation({
        ctx,
        ref: providerRef(input),
        intent: 'unresolve_thread',
        fingerprintInput: gitlabFingerprintInput(input, { threadId: input.discussionId }),
        operationKey: input.operationKey,
        write: () =>
          gitlabUnresolveThread({
            owner,
            projectPath: input.projectPath,
            mrIid: input.mrIid,
            instanceHint: input.instanceHint,
            discussionId: input.discussionId,
          }),
        reconcileAmbiguous: false,
      });
    }
    const owner = await bitbucketOwner(ctx, input);
    return runProviderMutation({
      ctx,
      ref: providerRef(input),
      intent: 'unresolve_thread',
      fingerprintInput: bitbucketFingerprintInput(input, { threadId: input.threadId }),
      operationKey: input.operationKey,
      write: () =>
        bitbucketUnresolveThread({
          owner,
          workspace: input.workspace,
          repoSlug: input.repoSlug,
          prId: input.prId,
          threadId: input.threadId,
        }),
      reconcileAmbiguous: false,
    });
  }),

  /**
   * Merge a PR/MR. `expectedHeadSha` is the optimistic-concurrency fence: the
   * write layer re-fetches the authoritative head and refuses a moved head
   * with the exact stale-head reason BEFORE any merge call, so a stale
   * revision can never merge another commit.
   */
  mergePullRequest: baseProcedure.input(MergePullRequestInput).mutation(async ({ ctx, input }) => {
    const ref = providerRef(input);
    const base: ProviderLedgerBase = {
      userId: ctx.user.id,
      distinctId: ctx.user.google_user_email ?? ctx.user.id,
      intent: 'merge',
      startedAt: Date.now(),
      platform: input.platform,
    };
    const mergeFields = {
      expectedHeadSha: input.expectedHeadSha,
      deleteBranch: input.deleteBranch,
      commitMessage: input.commitMessage,
      commitTitle: input.platform === 'gitlab' ? input.commitTitle : undefined,
      squash: input.platform === 'gitlab' ? input.squash : undefined,
    };
    const fingerprintInput =
      input.platform === 'gitlab'
        ? gitlabFingerprintInput(input, {
            method: input.squash ? 'squash' : 'merge',
            commitTitle: input.commitTitle,
            commitMessage: input.commitMessage,
            deleteBranch: input.deleteBranch,
            expectedHeadSha: input.expectedHeadSha,
          })
        : bitbucketFingerprintInput(input, {
            method: 'merge',
            commitMessage: input.commitMessage,
            deleteBranch: input.deleteBranch,
            expectedHeadSha: input.expectedHeadSha,
          });

    if (input.platform === 'gitlab') {
      const owner = await gitlabOwner(ctx, input);
      const write = () =>
        gitlabMerge({
          owner,
          projectPath: input.projectPath,
          mrIid: input.mrIid,
          instanceHint: input.instanceHint,
          expectedHeadSha: mergeFields.expectedHeadSha,
          squash: mergeFields.squash,
          shouldRemoveSourceBranch: mergeFields.deleteBranch,
          commitTitle: mergeFields.commitTitle,
          commitMessage: mergeFields.commitMessage,
        });
      if (input.operationKey === undefined) {
        return providerCall(write);
      }
      const execute = (row: OperationLedgerRow) => executeProviderWrite(base, row, write);
      return runProviderLedgerMutation({
        ...base,
        operationKey: input.operationKey,
        resourceKey: providerLedgerResourceKey('merge', ref, fingerprintInput),
        execute,
        reconcile: row =>
          reconcileMergeProviderRow(base, row, {
            expectedHeadSha: input.expectedHeadSha,
            // The authoritative read runs through the SAME owner-bound
            // authorization as the write — a client hint can never steer
            // the reconcile to another instance or project.
            readSummary: () =>
              gitlabRead.getMergeRequest(owner, input.projectPath, input.mrIid, input.instanceHint),
            execute: write,
          }),
      });
    }

    const owner = await bitbucketOwner(ctx, input);
    const write = () =>
      bitbucketMerge({
        owner,
        workspace: input.workspace,
        repoSlug: input.repoSlug,
        prId: input.prId,
        expectedHeadSha: mergeFields.expectedHeadSha,
        closeSourceBranch: mergeFields.deleteBranch,
        commitMessage: mergeFields.commitMessage,
      });
    if (input.operationKey === undefined) {
      return providerCall(write);
    }
    const execute = (row: OperationLedgerRow) => executeProviderWrite(base, row, write);
    return runProviderLedgerMutation({
      ...base,
      operationKey: input.operationKey,
      resourceKey: providerLedgerResourceKey('merge', ref, fingerprintInput),
      execute,
      reconcile: row =>
        reconcileMergeProviderRow(base, row, {
          expectedHeadSha: input.expectedHeadSha,
          // Owner-bound authoritative read — same identity as the write.
          readSummary: () =>
            bitbucketRead.getPullRequest(owner, input.workspace, input.repoSlug, input.prId),
          execute: write,
        }),
    });
  }),

  /**
   * Enable auto-merge. GitLab: merge-when-pipeline-succeeds, fenced on the
   * REQUIRED `expectedHeadSha` the write layer sends as `sha`. Bitbucket Cloud
   * exposes no auto-merge API: the procedure returns the capability reason
   * (no effect, no ledger row) so the UI shows why instead of failing.
   */
  enableAutoMerge: baseProcedure.input(EnableAutoMergeInput).mutation(async ({ ctx, input }) => {
    if (input.platform === 'bitbucket') {
      await bitbucketOwner(ctx, input);
      return {
        supported: false as const,
        reason: BITBUCKET_AUTO_MERGE_UNSUPPORTED_REASON,
        done: false,
        replayed: false,
      };
    }
    const owner = await gitlabOwner(ctx, input);
    return runProviderMutation({
      ctx,
      ref: providerRef(input),
      intent: 'enable_auto_merge',
      fingerprintInput: gitlabFingerprintInput(input, {
        expectedHeadSha: input.expectedHeadSha,
      }),
      operationKey: input.operationKey,
      write: async () => {
        const result = await gitlabEnableAutoMerge({
          owner,
          projectPath: input.projectPath,
          mrIid: input.mrIid,
          instanceHint: input.instanceHint,
          expectedHeadSha: input.expectedHeadSha,
        });
        return { supported: true as const, reason: '', ...result };
      },
      reconcileAmbiguous: false,
    });
  }),

  /** Disable auto-merge. Bitbucket returns the capability reason — see enableAutoMerge. */
  disableAutoMerge: baseProcedure.input(DisableAutoMergeInput).mutation(async ({ ctx, input }) => {
    if (input.platform === 'bitbucket') {
      await bitbucketOwner(ctx, input);
      return {
        supported: false as const,
        reason: BITBUCKET_AUTO_MERGE_UNSUPPORTED_REASON,
        done: false,
        replayed: false,
      };
    }
    const owner = await gitlabOwner(ctx, input);
    return runProviderMutation({
      ctx,
      ref: providerRef(input),
      intent: 'disable_auto_merge',
      fingerprintInput: gitlabFingerprintInput(input, {
        expectedHeadSha: input.expectedHeadSha,
      }),
      operationKey: input.operationKey,
      write: async () => {
        const result = await gitlabDisableAutoMerge({
          owner,
          projectPath: input.projectPath,
          mrIid: input.mrIid,
          instanceHint: input.instanceHint,
          expectedHeadSha: input.expectedHeadSha,
        });
        return { supported: true as const, reason: '', ...result };
      },
      reconcileAmbiguous: false,
    });
  }),
});
