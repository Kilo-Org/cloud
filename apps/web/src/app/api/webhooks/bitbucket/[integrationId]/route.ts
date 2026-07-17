import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { agent_configs, platform_integrations } from '@kilocode/db/schema';
import { CodeReviewAgentConfigSchema } from '@kilocode/db/schema-types';
import { BITBUCKET_CODE_REVIEW_WEBHOOK_SIGNING_KEYS } from '@/lib/config.server';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { getUnblockedBotUserForOrg } from '@/lib/bot-users/bot-user-service';
import {
  bitbucketCodeReviewerLifecycleLockKey,
  cancelActiveReviewsForPRInTransaction,
  cancelSupersededReviewsForPRInTransaction,
  createCodeReviewIfAbsentInTransaction,
  findExistingReviewInTransaction,
  type CancelledReviewRow,
  type ReviewScope,
} from '@/lib/code-reviews/db/code-reviews';
import { codeReviewWorkerClient } from '@/lib/code-reviews/client/code-review-worker-client';
import { tryDispatchPendingReviews } from '@/lib/code-reviews/dispatch/dispatch-pending-reviews';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { fetchBitbucketPullRequestFromTokenService } from '@/lib/integrations/platforms/bitbucket/token-service-client';
import {
  parseBitbucketWebhookSigningKeyring,
  verifyBitbucketWebhookSignature,
} from '@/lib/integrations/platforms/bitbucket/webhook-signing';
import {
  completeBitbucketWebhookEventInTransaction,
  getGreatestProcessedBitbucketObservation,
  insertOrLoadBitbucketWebhookEvent,
  loadBitbucketWebhookEventInTransaction,
  recordBitbucketWebhookFailure,
  type BitbucketAuthoritativeObservation,
  type BitbucketWebhookIdentity,
} from '@/lib/integrations/platforms/bitbucket/webhook-events';

const MAX_WEBHOOK_BODY_BYTES = 256_000;
const BITBUCKET_PULL_REQUEST_EVENTS = new Set([
  'pullrequest:created',
  'pullrequest:updated',
  'pullrequest:fulfilled',
  'pullrequest:rejected',
]);
const BITBUCKET_TERMINAL_DELIVERY_EVENTS = new Set([
  'pullrequest:fulfilled',
  'pullrequest:rejected',
]);

const CanonicalUuidSchema = z
  .string()
  .uuid()
  .refine(value => value === value.toLowerCase());
const WorkspaceSlugSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/);
const CachedRepositorySchema = z
  .object({
    id: CanonicalUuidSchema,
    full_name: z.string().min(3).max(511),
  })
  .passthrough();
const BitbucketWebhookPayloadSchema = z
  .object({
    repository: z.object({
      uuid: z.string().min(1).max(128),
      workspace: z.object({
        uuid: z.string().min(1).max(128),
      }),
    }),
    pullrequest: z.object({
      id: z.number().int().positive(),
    }),
  })
  .passthrough();

type RouteContext = {
  params: Promise<{ integrationId: string }>;
};

type SelectedRepository = {
  uuid: string;
  fullName: string;
};

type TransactionResult = {
  cancelledReviews: CancelledReviewRow[];
  reviewId?: string;
  created: boolean;
};

class WebhookBodyTooLargeError extends Error {}

async function readBoundedRawBody(request: NextRequest): Promise<Uint8Array> {
  const contentLength = request.headers.get('content-length');
  if (
    contentLength &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_WEBHOOK_BODY_BYTES)
  ) {
    throw new WebhookBodyTooLargeError();
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_WEBHOOK_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The request remains rejected when stream cancellation fails.
        }
        throw new WebhookBodyTooLargeError();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function normalizeBitbucketUuid(value: string | null): string | null {
  if (!value) return null;
  const withoutBraces = value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : value;
  const parsed = CanonicalUuidSchema.safeParse(withoutBraces.toLowerCase());
  return parsed.success ? parsed.data : null;
}

function selectedRepositoryFromConfig(
  integrationRepositories: unknown,
  configValue: unknown,
  workspaceSlug: string,
  repositoryUuid: string
): SelectedRepository | null {
  const config = CodeReviewAgentConfigSchema.safeParse(configValue);
  if (
    !config.success ||
    config.data.repository_selection_mode !== 'selected' ||
    !config.data.selected_repository_ids?.includes(repositoryUuid)
  ) {
    return null;
  }

  const repositories = z.array(CachedRepositorySchema).safeParse(integrationRepositories);
  if (!repositories.success) return null;
  const repository = repositories.data.find(candidate => candidate.id === repositoryUuid);
  if (!repository) return null;
  const [repositoryWorkspace, repositorySlug, extraSegment] = repository.full_name.split('/');
  if (
    repositoryWorkspace !== workspaceSlug ||
    !repositorySlug ||
    extraSegment !== undefined ||
    !WorkspaceSlugSchema.safeParse(repositorySlug).success
  ) {
    return null;
  }
  return { uuid: repository.id, fullName: repository.full_name };
}

async function selectedRepositoryFromCurrentLifecycleState(
  tx: DrizzleTransaction,
  input: {
    organizationId: string;
    integrationId: string;
    workspaceUuid: string;
    workspaceSlug: string;
    repositoryUuid: string;
    repositoryFullName: string;
  }
): Promise<SelectedRepository | null> {
  const [integration] = await tx
    .select()
    .from(platform_integrations)
    .where(eq(platform_integrations.id, input.integrationId))
    .limit(1);
  const currentWorkspaceUuid = normalizeBitbucketUuid(integration?.platform_account_id ?? null);
  const currentWorkspaceSlug = WorkspaceSlugSchema.safeParse(integration?.platform_account_login);
  if (
    !integration ||
    integration.owned_by_organization_id !== input.organizationId ||
    integration.owned_by_user_id !== null ||
    integration.platform !== 'bitbucket' ||
    integration.integration_type !== 'workspace_access_token' ||
    integration.integration_status !== 'active' ||
    integration.suspended_at !== null ||
    integration.auth_invalid_at !== null ||
    integration.platform_installation_id !== null ||
    currentWorkspaceUuid !== input.workspaceUuid ||
    !currentWorkspaceSlug.success ||
    currentWorkspaceSlug.data !== input.workspaceSlug
  ) {
    return null;
  }

  const [config] = await tx
    .select()
    .from(agent_configs)
    .where(
      and(
        eq(agent_configs.owned_by_organization_id, input.organizationId),
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.platform, 'bitbucket')
      )
    )
    .limit(1);
  if (!config?.is_enabled) return null;

  const selectedRepository = selectedRepositoryFromConfig(
    integration.repositories,
    config.config,
    currentWorkspaceSlug.data,
    input.repositoryUuid
  );
  return selectedRepository?.fullName === input.repositoryFullName ? selectedRepository : null;
}

async function safelyRecordFailure(eventId: string, safeCode: string): Promise<void> {
  try {
    await recordBitbucketWebhookFailure(eventId, safeCode);
  } catch {
    return;
  }
}

async function interruptCancelledReviews(cancelledReviews: CancelledReviewRow[]): Promise<void> {
  await Promise.allSettled(
    cancelledReviews
      .filter(review => review.prevStatus === 'queued' || review.prevStatus === 'running')
      .map(review =>
        codeReviewWorkerClient.cancelReview(
          review.id,
          'Bitbucket pull request state superseded this review',
          review.latestActiveAttemptId ?? undefined
        )
      )
  );
}

function isOlderObservation(observed: string, greatestProcessed: string | null): boolean {
  if (!greatestProcessed) return false;
  return new Date(observed).getTime() < new Date(greatestProcessed).getTime();
}

export async function POST(request: NextRequest, context: RouteContext) {
  let rawBody: Uint8Array;
  try {
    rawBody = await readBoundedRawBody(request);
  } catch (error) {
    if (error instanceof WebhookBodyTooLargeError) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { integrationId: integrationIdValue } = await context.params;
  const integrationId = CanonicalUuidSchema.safeParse(integrationIdValue);
  if (!integrationId.success) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const integration = await getIntegrationById(integrationId.data);
  const organizationId = integration?.owned_by_organization_id;
  const workspaceUuid = normalizeBitbucketUuid(integration?.platform_account_id ?? null);
  const workspaceSlug = WorkspaceSlugSchema.safeParse(integration?.platform_account_login);
  if (
    !integration ||
    !organizationId ||
    integration.owned_by_user_id !== null ||
    integration.platform !== 'bitbucket' ||
    integration.integration_type !== 'workspace_access_token' ||
    integration.integration_status !== 'active' ||
    integration.suspended_at !== null ||
    integration.auth_invalid_at !== null ||
    integration.platform_installation_id !== null ||
    !workspaceUuid ||
    !workspaceSlug.success
  ) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const agentConfig = await getAgentConfigForOwner(
    { type: 'org', id: organizationId },
    'code_review',
    'bitbucket'
  );
  if (!agentConfig?.is_enabled) {
    return NextResponse.json({ message: 'Code Reviewer disabled' }, { status: 200 });
  }

  const hookUuid = normalizeBitbucketUuid(request.headers.get('x-hook-uuid'));
  const requestUuid = normalizeBitbucketUuid(request.headers.get('x-request-uuid'));
  const eventKey = request.headers.get('x-event-key');
  const signature = request.headers.get('x-hub-signature');
  if (!hookUuid || !requestUuid || !eventKey || !signature) {
    return NextResponse.json({ error: 'Missing delivery headers' }, { status: 400 });
  }

  let keyring;
  try {
    keyring = parseBitbucketWebhookSigningKeyring(BITBUCKET_CODE_REVIEW_WEBHOOK_SIGNING_KEYS);
  } catch {
    return NextResponse.json({ error: 'Webhook unavailable' }, { status: 503 });
  }
  if (
    !verifyBitbucketWebhookSignature(rawBody, signature, keyring, {
      integrationId: integration.id,
      workspaceUuid,
    })
  ) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  if (!BITBUCKET_PULL_REQUEST_EVENTS.has(eventKey)) {
    return NextResponse.json({ message: 'Event received' }, { status: 200 });
  }

  let payload: z.infer<typeof BitbucketWebhookPayloadSchema>;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
    payload = BitbucketWebhookPayloadSchema.parse(JSON.parse(decoded));
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const payloadWorkspaceUuid = normalizeBitbucketUuid(payload.repository.workspace.uuid);
  const repositoryUuid = normalizeBitbucketUuid(payload.repository.uuid);
  if (payloadWorkspaceUuid !== workspaceUuid || !repositoryUuid) {
    return NextResponse.json({ error: 'Invalid workspace' }, { status: 400 });
  }

  const selectedRepository = selectedRepositoryFromConfig(
    integration.repositories,
    agentConfig.config,
    workspaceSlug.data,
    repositoryUuid
  );
  if (!selectedRepository) {
    return NextResponse.json({ message: 'Repository not selected' }, { status: 200 });
  }

  const identity: BitbucketWebhookIdentity = {
    integrationId: integration.id,
    workspaceUuid,
    repositoryUuid: selectedRepository.uuid,
    pullRequestNumber: payload.pullrequest.id,
  };
  const eventAction = eventKey.slice('pullrequest:'.length);
  const eventSignature = `bitbucket:${hookUuid}:${requestUuid}`;

  let event;
  try {
    event = await insertOrLoadBitbucketWebhookEvent({
      organizationId,
      eventAction,
      eventSignature,
      identity,
    });
  } catch {
    return NextResponse.json({ error: 'Delivery conflict' }, { status: 409 });
  }
  if (event.processed) {
    return NextResponse.json({ message: 'Event already processed' }, { status: 200 });
  }

  let codeReviewerBot;
  try {
    codeReviewerBot = await getUnblockedBotUserForOrg(organizationId, 'code-review');
  } catch {
    await safelyRecordFailure(event.id, 'bot_unavailable');
    return NextResponse.json({ error: 'Code Reviewer bot unavailable' }, { status: 503 });
  }
  if (!codeReviewerBot) {
    await safelyRecordFailure(event.id, 'bot_unavailable');
    return NextResponse.json({ error: 'Code Reviewer bot unavailable' }, { status: 503 });
  }

  let providerResult;
  try {
    providerResult = await fetchBitbucketPullRequestFromTokenService({
      botUserId: codeReviewerBot.id,
      organizationId,
      workspace: {
        integrationId: integration.id,
        workspaceUuid,
        workspaceSlug: workspaceSlug.data,
      },
      repository: {
        repositoryUuid: selectedRepository.uuid,
        repositoryFullName: selectedRepository.fullName,
      },
      pullRequestId: payload.pullrequest.id,
    });
  } catch {
    await safelyRecordFailure(event.id, 'temporarily_unavailable');
    return NextResponse.json({ error: 'Provider read failed' }, { status: 503 });
  }
  if (!providerResult.success) {
    await safelyRecordFailure(event.id, providerResult.reason);
    return NextResponse.json({ error: 'Provider read failed' }, { status: 503 });
  }

  const pullRequest = providerResult.pullRequest;
  if (
    pullRequest.id !== payload.pullrequest.id ||
    pullRequest.source.repositoryUuid !== selectedRepository.uuid ||
    pullRequest.destination.repositoryUuid !== selectedRepository.uuid ||
    pullRequest.source.repositoryFullName !== selectedRepository.fullName ||
    pullRequest.destination.repositoryFullName !== selectedRepository.fullName
  ) {
    await safelyRecordFailure(event.id, 'invalid_provider_state');
    return NextResponse.json({ error: 'Provider state invalid' }, { status: 503 });
  }

  const ownerWithBot = { type: 'org' as const, id: organizationId, userId: codeReviewerBot.id };
  const reviewScope = {
    owner: ownerWithBot,
    platform: 'bitbucket',
    repoFullName: selectedRepository.fullName,
    prNumber: pullRequest.id,
    platformIntegrationId: integration.id,
  } satisfies ReviewScope;
  const observation: BitbucketAuthoritativeObservation = {
    ...identity,
    eventKey,
    updatedOn: pullRequest.updatedOn,
    state: pullRequest.state,
    draft: pullRequest.draft,
    headSha: pullRequest.source.sha,
  };

  let transactionResult: TransactionResult;
  try {
    transactionResult = await db.transaction(async tx => {
      const lifecycleLockKey = bitbucketCodeReviewerLifecycleLockKey(integration.id);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lifecycleLockKey}, 0))`);

      const currentEvent = await loadBitbucketWebhookEventInTransaction(tx, event.id);
      if (!currentEvent) throw new Error('Bitbucket webhook event not found');
      if (currentEvent.processed) {
        return { cancelledReviews: [], created: false };
      }

      const currentSelectedRepository = await selectedRepositoryFromCurrentLifecycleState(tx, {
        organizationId,
        integrationId: integration.id,
        workspaceUuid,
        workspaceSlug: workspaceSlug.data,
        repositoryUuid: selectedRepository.uuid,
        repositoryFullName: selectedRepository.fullName,
      });
      if (!currentSelectedRepository) {
        await completeBitbucketWebhookEventInTransaction(tx, event.id, observation);
        return { cancelledReviews: [], created: false };
      }

      const pullRequestLockKey = [
        'bitbucket-code-review',
        ownerWithBot.type,
        ownerWithBot.id,
        integration.id,
        selectedRepository.uuid,
        pullRequest.id,
      ].join(':');
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${pullRequestLockKey}, 0))`
      );

      const greatestProcessed = await getGreatestProcessedBitbucketObservation(
        tx,
        organizationId,
        identity
      );
      if (isOlderObservation(observation.updatedOn, greatestProcessed)) {
        await completeBitbucketWebhookEventInTransaction(tx, event.id, observation);
        return { cancelledReviews: [], created: false };
      }

      const providerIsReady = pullRequest.state === 'OPEN' && !pullRequest.draft;
      if (!providerIsReady) {
        const cancelledReviews = await cancelActiveReviewsForPRInTransaction(tx, reviewScope);
        await completeBitbucketWebhookEventInTransaction(tx, event.id, observation);
        return { cancelledReviews, created: false };
      }

      if (BITBUCKET_TERMINAL_DELIVERY_EVENTS.has(eventKey)) {
        await completeBitbucketWebhookEventInTransaction(tx, event.id, observation);
        return { cancelledReviews: [], created: false };
      }

      const existingReview = await findExistingReviewInTransaction(
        tx,
        reviewScope,
        pullRequest.source.sha
      );
      if (existingReview) {
        await completeBitbucketWebhookEventInTransaction(tx, event.id, observation);
        return {
          cancelledReviews: [],
          reviewId: existingReview.id,
          created: false,
        };
      }

      const cancelledReviews = await cancelSupersededReviewsForPRInTransaction(
        tx,
        reviewScope,
        pullRequest.source.sha
      );
      const createdReview = await createCodeReviewIfAbsentInTransaction(tx, reviewScope, {
        owner: ownerWithBot,
        platformIntegrationId: integration.id,
        repoFullName: selectedRepository.fullName,
        prNumber: pullRequest.id,
        prUrl: pullRequest.url,
        prTitle: pullRequest.title,
        prAuthor: pullRequest.author.displayName,
        baseRef: pullRequest.destination.branch,
        headRef: pullRequest.source.branch,
        headSha: pullRequest.source.sha,
        platform: 'bitbucket',
        triggerSource: 'webhook',
      });
      await completeBitbucketWebhookEventInTransaction(tx, event.id, observation);
      return {
        cancelledReviews,
        reviewId: createdReview.reviewId,
        created: createdReview.created,
      };
    });
  } catch {
    await safelyRecordFailure(event.id, 'processing_failed');
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 503 });
  }

  await interruptCancelledReviews(transactionResult.cancelledReviews);
  if (transactionResult.created) {
    try {
      await tryDispatchPendingReviews(ownerWithBot);
    } catch {
      // The pending review remains available to the existing dispatcher.
    }
  }

  if (transactionResult.created) {
    return NextResponse.json(
      { message: 'Code review queued', reviewId: transactionResult.reviewId },
      { status: 202 }
    );
  }
  return NextResponse.json(
    { message: 'Event processed', reviewId: transactionResult.reviewId },
    { status: 200 }
  );
}
