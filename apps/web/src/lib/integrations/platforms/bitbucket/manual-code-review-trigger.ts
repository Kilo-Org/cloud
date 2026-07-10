import 'server-only';

import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { agent_configs, platform_integrations } from '@kilocode/db/schema';
import { CodeReviewAgentConfigSchema } from '@kilocode/db/schema-types';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { getUnblockedBotUserForOrg } from '@/lib/bot-users/bot-user-service';
import {
  bitbucketCodeReviewerLifecycleLockKey,
  cancelSupersededReviewsForPRInTransaction,
  createCodeReviewIfAbsentInTransaction,
  findExistingReviewInTransaction,
  type CancelledReviewRow,
  type ReviewScope,
} from '@/lib/code-reviews/db/code-reviews';
import { codeReviewWorkerClient } from '@/lib/code-reviews/client/code-review-worker-client';
import { tryDispatchPendingReviews } from '@/lib/code-reviews/dispatch/dispatch-pending-reviews';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { getBitbucketCodeReviewerReadiness } from './workspace-access-token-repository-cache';
import { fetchBitbucketPullRequestFromTokenService } from './token-service-client';

const BitbucketSlugSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/);
const CanonicalUuidSchema = z
  .string()
  .uuid()
  .refine(value => value === value.toLowerCase());
const CachedRepositorySchema = z
  .object({
    id: CanonicalUuidSchema,
    full_name: z.string().min(3).max(511),
  })
  .passthrough();

type SelectedRepository = {
  uuid: string;
  fullName: string;
};

type ParsedBitbucketPullRequestUrl = {
  workspaceSlug: string;
  repositorySlug: string;
  repositoryFullName: string;
  pullRequestId: number;
};

type TransactionResult = {
  cancelledReviews: CancelledReviewRow[];
  reviewId: string;
  created: boolean;
};

export type ManualBitbucketCodeReviewTriggerResult = {
  status: 'queued' | 'already_exists';
  reviewId: string;
};

export type ManualBitbucketCodeReviewTriggerErrorCode =
  | 'invalid_url'
  | 'code_reviewer_disabled'
  | 'connection_not_ready'
  | 'workspace_mismatch'
  | 'repository_not_selected'
  | 'bot_unavailable'
  | 'provider_read_failed'
  | 'invalid_provider_state'
  | 'pull_request_not_open'
  | 'pull_request_draft'
  | 'lifecycle_changed'
  | 'processing_failed';

export class ManualBitbucketCodeReviewTriggerError extends Error {
  constructor(
    readonly code: ManualBitbucketCodeReviewTriggerErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ManualBitbucketCodeReviewTriggerError';
  }
}

function triggerError(code: ManualBitbucketCodeReviewTriggerErrorCode, message: string): never {
  throw new ManualBitbucketCodeReviewTriggerError(code, message);
}

function decodeUrlPathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    triggerError(
      'invalid_url',
      'Enter a Bitbucket pull request URL like https://bitbucket.org/workspace/repo/pull-requests/123.'
    );
  }
}

function parseBitbucketPullRequestUrl(value: string): ParsedBitbucketPullRequestUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    triggerError(
      'invalid_url',
      'Enter a Bitbucket pull request URL like https://bitbucket.org/workspace/repo/pull-requests/123.'
    );
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'bitbucket.org' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== ''
  ) {
    triggerError(
      'invalid_url',
      'Enter a Bitbucket pull request URL like https://bitbucket.org/workspace/repo/pull-requests/123.'
    );
  }

  const [workspaceSegment, repositorySegment, pullRequestsSegment, pullRequestIdSegment] =
    url.pathname.split('/').filter(Boolean);
  const workspaceSlug = decodeUrlPathSegment(workspaceSegment ?? '');
  const repositorySlug = decodeUrlPathSegment(repositorySegment ?? '');
  const pullRequestId = Number(pullRequestIdSegment);
  if (
    pullRequestsSegment !== 'pull-requests' ||
    !BitbucketSlugSchema.safeParse(workspaceSlug).success ||
    !BitbucketSlugSchema.safeParse(repositorySlug).success ||
    !Number.isSafeInteger(pullRequestId) ||
    pullRequestId <= 0
  ) {
    triggerError(
      'invalid_url',
      'Enter a Bitbucket pull request URL like https://bitbucket.org/workspace/repo/pull-requests/123.'
    );
  }

  return {
    workspaceSlug,
    repositorySlug,
    repositoryFullName: `${workspaceSlug}/${repositorySlug}`,
    pullRequestId,
  };
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
    !BitbucketSlugSchema.safeParse(repositorySlug).success
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
  const currentWorkspaceSlug = BitbucketSlugSchema.safeParse(integration?.platform_account_login);
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

export async function triggerManualBitbucketCodeReview(input: {
  organizationId: string;
  pullRequestUrl: string;
}): Promise<ManualBitbucketCodeReviewTriggerResult> {
  const parsedUrl = parseBitbucketPullRequestUrl(input.pullRequestUrl);
  const readiness = await getBitbucketCodeReviewerReadiness(input.organizationId);
  if (
    !readiness.connected ||
    !readiness.ready ||
    !readiness.integrationId ||
    !readiness.workspace
  ) {
    triggerError(
      'connection_not_ready',
      'Connect Bitbucket and confirm the Workspace Access Token has Code Reviewer permissions before starting a manual review.'
    );
  }
  if (readiness.workspace.slug !== parsedUrl.workspaceSlug) {
    triggerError('workspace_mismatch', 'The pull request URL does not match this organization.');
  }
  if (readiness.repositoryCache.status !== 'available') {
    triggerError(
      'connection_not_ready',
      'Refresh the Bitbucket repository cache before starting a manual review.'
    );
  }

  const selectedRepository = readiness.repositoryCache.repositories.find(
    repository => repository.fullName === parsedUrl.repositoryFullName
  );
  if (!selectedRepository) {
    triggerError(
      'repository_not_selected',
      'Select this Bitbucket repository in Code Reviewer settings before starting a manual review.'
    );
  }

  const agentConfig = await getAgentConfigForOwner(
    { type: 'org', id: input.organizationId },
    'code_review',
    'bitbucket'
  );
  const parsedConfig = CodeReviewAgentConfigSchema.safeParse(agentConfig?.config);
  if (!agentConfig?.is_enabled || !parsedConfig.success) {
    triggerError(
      'code_reviewer_disabled',
      'Enable Bitbucket Code Reviewer before starting a manual review.'
    );
  }
  if (
    parsedConfig.data.repository_selection_mode !== 'selected' ||
    !parsedConfig.data.selected_repository_ids?.includes(selectedRepository.id)
  ) {
    triggerError(
      'repository_not_selected',
      'Select this Bitbucket repository in Code Reviewer settings before starting a manual review.'
    );
  }

  const integration = await getIntegrationById(readiness.integrationId, input.organizationId);
  const workspaceUuid = readiness.workspace.uuid;
  const workspaceSlug = readiness.workspace.slug;
  if (!integration) {
    triggerError('connection_not_ready', 'Reconnect Bitbucket before starting a manual review.');
  }

  const codeReviewerBot = await getUnblockedBotUserForOrg(input.organizationId, 'code-review');
  if (!codeReviewerBot) {
    triggerError(
      'bot_unavailable',
      'Code Reviewer bot setup is incomplete. Disable and re-enable Bitbucket Code Reviewer, then try again.'
    );
  }

  let providerResult;
  try {
    providerResult = await fetchBitbucketPullRequestFromTokenService({
      botUserId: codeReviewerBot.id,
      organizationId: input.organizationId,
      workspace: {
        integrationId: integration.id,
        workspaceUuid,
        workspaceSlug,
      },
      repository: {
        repositoryUuid: selectedRepository.id,
        repositoryFullName: selectedRepository.fullName,
      },
      pullRequestId: parsedUrl.pullRequestId,
    });
  } catch {
    triggerError(
      'provider_read_failed',
      'Bitbucket pull request details could not be loaded. Try again in a minute.'
    );
  }
  if (!providerResult.success) {
    triggerError(
      'provider_read_failed',
      'Bitbucket pull request details could not be loaded. Check the URL and token permissions, then try again.'
    );
  }

  const pullRequest = providerResult.pullRequest;
  if (
    pullRequest.id !== parsedUrl.pullRequestId ||
    pullRequest.source.repositoryUuid !== selectedRepository.id ||
    pullRequest.destination.repositoryUuid !== selectedRepository.id ||
    pullRequest.source.repositoryFullName !== selectedRepository.fullName ||
    pullRequest.destination.repositoryFullName !== selectedRepository.fullName
  ) {
    triggerError(
      'invalid_provider_state',
      'Bitbucket returned pull request data that does not match the selected repository.'
    );
  }
  if (pullRequest.state !== 'OPEN') {
    triggerError(
      'pull_request_not_open',
      'Bitbucket Code Reviewer can only start on open pull requests.'
    );
  }
  if (pullRequest.draft) {
    triggerError(
      'pull_request_draft',
      'Bitbucket Code Reviewer can only start on non-draft pull requests.'
    );
  }

  const ownerWithBot = {
    type: 'org' as const,
    id: input.organizationId,
    userId: codeReviewerBot.id,
  };
  const reviewScope = {
    owner: ownerWithBot,
    platform: 'bitbucket',
    repoFullName: selectedRepository.fullName,
    prNumber: pullRequest.id,
    platformIntegrationId: integration.id,
  } satisfies ReviewScope;

  let transactionResult: TransactionResult;
  try {
    transactionResult = await db.transaction(async tx => {
      const lifecycleLockKey = bitbucketCodeReviewerLifecycleLockKey(integration.id);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lifecycleLockKey}, 0))`);

      const currentSelectedRepository = await selectedRepositoryFromCurrentLifecycleState(tx, {
        organizationId: input.organizationId,
        integrationId: integration.id,
        workspaceUuid,
        workspaceSlug,
        repositoryUuid: selectedRepository.id,
        repositoryFullName: selectedRepository.fullName,
      });
      if (!currentSelectedRepository) {
        triggerError(
          'lifecycle_changed',
          'Bitbucket Code Reviewer settings changed while starting the review. Refresh and try again.'
        );
      }

      const pullRequestLockKey = [
        'bitbucket-code-review',
        ownerWithBot.type,
        ownerWithBot.id,
        integration.id,
        selectedRepository.id,
        pullRequest.id,
      ].join(':');
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${pullRequestLockKey}, 0))`
      );

      const existingReview = await findExistingReviewInTransaction(
        tx,
        reviewScope,
        pullRequest.source.sha
      );
      if (existingReview) {
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
        triggerSource: 'manual',
      });
      return {
        cancelledReviews,
        reviewId: createdReview.reviewId,
        created: createdReview.created,
      };
    });
  } catch (error) {
    if (error instanceof ManualBitbucketCodeReviewTriggerError) throw error;
    triggerError(
      'processing_failed',
      'Bitbucket Code Reviewer could not start this review. Try again in a minute.'
    );
  }

  await interruptCancelledReviews(transactionResult.cancelledReviews);
  if (transactionResult.created) {
    try {
      await tryDispatchPendingReviews(ownerWithBot);
    } catch {
      // The pending review remains available to the existing dispatcher.
    }
  }

  return {
    status: transactionResult.created ? 'queued' : 'already_exists',
    reviewId: transactionResult.reviewId,
  };
}
