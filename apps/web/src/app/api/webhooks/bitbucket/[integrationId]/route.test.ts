/* eslint-disable drizzle/enforce-delete-with-where */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

const mockFetchBitbucketPullRequest = jest.fn();
const mockTryDispatchPendingReviews = jest.fn();
const mockCancelReview = jest.fn();
const mockBitbucketSigningKeys = JSON.stringify({
  active: Buffer.alloc(32, 31).toString('base64'),
  previous: Buffer.alloc(32, 47).toString('base64'),
});

jest.mock('@/lib/config.server', () => {
  const actual: Record<string, unknown> = jest.requireActual('@/lib/config.server');
  return {
    ...actual,
    BITBUCKET_CODE_REVIEW_WEBHOOK_SIGNING_KEYS: JSON.stringify({
      active: Buffer.alloc(32, 31).toString('base64'),
      previous: Buffer.alloc(32, 47).toString('base64'),
    }),
  };
});

jest.mock('@/lib/integrations/platforms/bitbucket/token-service-client', () => ({
  fetchBitbucketPullRequestFromTokenService: (...args: unknown[]) =>
    mockFetchBitbucketPullRequest(...args),
}));

jest.mock('@/lib/code-reviews/dispatch/dispatch-pending-reviews', () => ({
  tryDispatchPendingReviews: (...args: unknown[]) => mockTryDispatchPendingReviews(...args),
}));

jest.mock('@/lib/code-reviews/client/code-review-worker-client', () => ({
  codeReviewWorkerClient: {
    cancelReview: (...args: unknown[]) => mockCancelReview(...args),
  },
}));

import { createHmac, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import {
  agent_configs,
  cloud_agent_code_reviews,
  kilocode_users,
  organization_memberships,
  organizations,
  platform_integrations,
  webhook_events,
  type Organization,
  type PlatformIntegration,
  type User,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { generateBotUserId } from '@/lib/bot-users/types';
import {
  createCodeReview,
  disableBitbucketCodeReviewerForIntegration,
} from '@/lib/code-reviews/db/code-reviews';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  deriveBitbucketWebhookSecret,
  parseBitbucketWebhookSigningKeyring,
} from '@/lib/integrations/platforms/bitbucket/webhook-signing';
import { POST } from './route';

const WORKSPACE_UUID = '11111111-1111-4111-8111-111111111111';
const REPOSITORY_UUID = '22222222-2222-4222-8222-222222222222';
const OTHER_REPOSITORY_UUID = '33333333-3333-4333-8333-333333333333';
const REPOSITORY_FULL_NAME = 'acme/widgets';
const PULL_REQUEST_ID = 42;
const DEFAULT_HEAD_SHA = 'a'.repeat(40);
const DEFAULT_UPDATED_ON = '2026-06-24T13:30:45.123Z';

type ProviderStateOptions = {
  state?: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
  draft?: boolean;
  updatedOn?: string;
  headSha?: string;
};

let ownerUser: User;
let codeReviewerBot: User;
let organization: Organization;

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function providerPullRequest(options: ProviderStateOptions = {}) {
  const state = options.state ?? 'OPEN';
  const draft = options.draft ?? false;
  const updatedOn = options.updatedOn ?? DEFAULT_UPDATED_ON;
  const headSha = options.headSha ?? DEFAULT_HEAD_SHA;

  return {
    success: true as const,
    pullRequest: {
      id: PULL_REQUEST_ID,
      state,
      draft,
      updatedOn,
      title: 'Keep admission ordered',
      author: {
        uuid: '44444444-4444-4444-8444-444444444444',
        displayName: 'Ada Reviewer',
      },
      source: {
        repositoryUuid: REPOSITORY_UUID,
        repositoryFullName: REPOSITORY_FULL_NAME,
        branch: 'feature/ordered-admission',
        sha: headSha,
      },
      destination: {
        repositoryUuid: REPOSITORY_UUID,
        repositoryFullName: REPOSITORY_FULL_NAME,
        branch: 'main',
        sha: 'b'.repeat(40),
      },
      url: `https://bitbucket.org/${REPOSITORY_FULL_NAME}/pull-requests/${PULL_REQUEST_ID}`,
    },
  };
}

async function insertIntegrationAndConfig(
  selectedRepositoryIds: string[] = [REPOSITORY_UUID],
  isEnabled = true
): Promise<PlatformIntegration> {
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_organization_id: organization.id,
      owned_by_user_id: null,
      created_by_user_id: ownerUser.id,
      platform: 'bitbucket',
      integration_type: 'workspace_access_token',
      platform_account_id: WORKSPACE_UUID,
      platform_account_login: 'acme',
      platform_installation_id: null,
      repository_access: 'all',
      repositories: [
        {
          id: REPOSITORY_UUID,
          name: 'widgets',
          full_name: REPOSITORY_FULL_NAME,
          private: true,
          default_branch: 'main',
        },
      ],
      repositories_synced_at: '2026-06-24T08:00:00.000Z',
      integration_status: 'active',
      metadata: { displayName: 'Acme Workspace' },
    })
    .returning();
  if (!integration) throw new Error('Expected Bitbucket integration');

  await db.insert(agent_configs).values({
    owned_by_organization_id: organization.id,
    agent_type: 'code_review',
    platform: 'bitbucket',
    config: {
      review_style: 'balanced',
      focus_areas: [],
      model_slug: 'anthropic/claude-sonnet-4.6',
      repository_selection_mode: 'selected',
      selected_repository_ids: selectedRepositoryIds,
    },
    is_enabled: isEnabled,
    created_by: ownerUser.id,
  });

  return integration;
}

function signingKey(kind: 'active' | 'previous'): Uint8Array {
  const keyring = parseBitbucketWebhookSigningKeyring(mockBitbucketSigningKeys);
  const key = keyring[kind];
  if (!key) throw new Error(`Missing ${kind} signing key`);
  return key;
}

function webhookRequest(
  integration: PlatformIntegration,
  options: {
    eventKey?: string;
    signingKey?: 'active' | 'previous';
    hookUuid?: string;
    requestUuid?: string;
    repositoryUuid?: string;
  } = {}
): NextRequest {
  const repositoryUuid = options.repositoryUuid ?? REPOSITORY_UUID;
  const rawBody = JSON.stringify({
    repository: {
      uuid: `{${repositoryUuid}}`,
      full_name: REPOSITORY_FULL_NAME,
      workspace: {
        uuid: `{${WORKSPACE_UUID}}`,
        slug: 'acme',
      },
    },
    pullrequest: { id: PULL_REQUEST_ID },
  });
  const secret = deriveBitbucketWebhookSecret(signingKey(options.signingKey ?? 'active'), {
    integrationId: integration.id,
    workspaceUuid: WORKSPACE_UUID,
  });
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');

  return new NextRequest(`https://app.kilo.ai/api/webhooks/bitbucket/${integration.id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-event-key': options.eventKey ?? 'pullrequest:created',
      'x-hook-uuid': options.hookUuid ?? randomUUID(),
      'x-request-uuid': options.requestUuid ?? randomUUID(),
      'x-hub-signature': `sha256=${signature}`,
    },
    body: rawBody,
  });
}

function callWebhook(integration: PlatformIntegration, request: NextRequest) {
  return POST(request, { params: Promise.resolve({ integrationId: integration.id }) });
}

async function createExistingReview(
  integration: PlatformIntegration,
  headSha: string,
  status: 'pending' | 'queued' | 'running' = 'pending'
): Promise<string> {
  const reviewId = await createCodeReview({
    owner: { type: 'org', id: organization.id, userId: codeReviewerBot.id },
    platformIntegrationId: integration.id,
    repoFullName: REPOSITORY_FULL_NAME,
    prNumber: PULL_REQUEST_ID,
    prUrl: `https://bitbucket.org/${REPOSITORY_FULL_NAME}/pull-requests/${PULL_REQUEST_ID}`,
    prTitle: 'Existing review',
    prAuthor: 'Ada Reviewer',
    baseRef: 'main',
    headRef: 'feature/existing',
    headSha,
    platform: 'bitbucket',
  });
  if (status !== 'pending') {
    await db
      .update(cloud_agent_code_reviews)
      .set({ status })
      .where(eq(cloud_agent_code_reviews.id, reviewId));
  }
  return reviewId;
}

async function organizationReviews() {
  return db
    .select()
    .from(cloud_agent_code_reviews)
    .where(
      and(
        eq(cloud_agent_code_reviews.owned_by_organization_id, organization.id),
        eq(cloud_agent_code_reviews.platform, 'bitbucket')
      )
    );
}

async function organizationWebhookEvents() {
  return db
    .select()
    .from(webhook_events)
    .where(eq(webhook_events.owned_by_organization_id, organization.id));
}

describe('POST /api/webhooks/bitbucket/[integrationId]', () => {
  beforeAll(async () => {
    ownerUser = await insertTestUser();
    organization = await createTestOrganization('Bitbucket webhook admission', ownerUser.id, 0);
    codeReviewerBot = await insertTestUser({
      id: generateBotUserId(organization.id, 'code-review'),
      is_bot: true,
    });
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: codeReviewerBot.id,
      role: 'member',
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchBitbucketPullRequest.mockResolvedValue(providerPullRequest());
    mockTryDispatchPendingReviews.mockResolvedValue({
      dispatched: 1,
      notDispatched: 0,
      activeCount: 1,
    });
    mockCancelReview.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await db
      .delete(webhook_events)
      .where(eq(webhook_events.owned_by_organization_id, organization.id));
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.owned_by_organization_id, organization.id));
    await db
      .delete(agent_configs)
      .where(eq(agent_configs.owned_by_organization_id, organization.id));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, organization.id));
  });

  afterAll(async () => {
    await db
      .delete(organization_memberships)
      .where(eq(organization_memberships.organization_id, organization.id));
    await db.delete(organizations).where(eq(organizations.id, organization.id));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, codeReviewerBot.id));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, ownerUser.id));
  });

  it.each(['active', 'previous'] as const)(
    'accepts the %s signing key and atomically persists the authoritative observation with the new review',
    async signingKeyKind => {
      const integration = await insertIntegrationAndConfig();

      const response = await callWebhook(
        integration,
        webhookRequest(integration, { signingKey: signingKeyKind })
      );

      expect(response.status).toBe(202);
      const reviews = await organizationReviews();
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toEqual(
        expect.objectContaining({
          owned_by_organization_id: organization.id,
          platform_integration_id: integration.id,
          pr_number: PULL_REQUEST_ID,
          head_sha: DEFAULT_HEAD_SHA,
          status: 'pending',
        })
      );
      const events = await organizationWebhookEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(
        expect.objectContaining({
          processed: true,
          handlers_triggered: ['code_review'],
          errors: null,
          payload: {
            integrationId: integration.id,
            workspaceUuid: WORKSPACE_UUID,
            repositoryUuid: REPOSITORY_UUID,
            pullRequestNumber: PULL_REQUEST_ID,
            eventKey: 'pullrequest:created',
            updatedOn: DEFAULT_UPDATED_ON,
            state: 'OPEN',
            draft: false,
            headSha: DEFAULT_HEAD_SHA,
          },
        })
      );
      expect(mockFetchBitbucketPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          botUserId: codeReviewerBot.id,
          organizationId: organization.id,
          workspace: {
            integrationId: integration.id,
            workspaceUuid: WORKSPACE_UUID,
            workspaceSlug: 'acme',
          },
          repository: {
            repositoryUuid: REPOSITORY_UUID,
            repositoryFullName: REPOSITORY_FULL_NAME,
          },
          pullRequestId: PULL_REQUEST_ID,
        })
      );
      expect(mockTryDispatchPendingReviews).toHaveBeenCalledTimes(1);
    }
  );

  it('acknowledges an unselected repository without persistence or provider access', async () => {
    const integration = await insertIntegrationAndConfig([OTHER_REPOSITORY_UUID]);

    const response = await callWebhook(integration, webhookRequest(integration));

    expect(response.status).toBe(200);
    await expect(organizationWebhookEvents()).resolves.toHaveLength(0);
    await expect(organizationReviews()).resolves.toHaveLength(0);
    expect(mockFetchBitbucketPullRequest).not.toHaveBeenCalled();
  });

  it.each(['disable', 'disconnect'] as const)(
    'completes in-flight admission without work after lifecycle %s wins',
    async lifecycleAction => {
      const integration = await insertIntegrationAndConfig();
      const providerStarted = deferred<void>();
      const providerResponse = deferred<ReturnType<typeof providerPullRequest>>();
      mockFetchBitbucketPullRequest.mockImplementationOnce(async () => {
        providerStarted.resolve(undefined);
        return providerResponse.promise;
      });

      const responsePromise = callWebhook(integration, webhookRequest(integration));
      await providerStarted.promise;
      await disableBitbucketCodeReviewerForIntegration({
        organizationId: organization.id,
        integrationId: integration.id,
      });
      if (lifecycleAction === 'disconnect') {
        await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));
      }
      providerResponse.resolve(providerPullRequest());

      const response = await responsePromise;

      expect(response.status).toBe(200);
      await expect(organizationReviews()).resolves.toHaveLength(0);
      const events = await organizationWebhookEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(expect.objectContaining({ processed: true, errors: null }));
      expect(mockTryDispatchPendingReviews).not.toHaveBeenCalled();
      expect(mockCancelReview).not.toHaveBeenCalled();
    }
  );

  it('completes in-flight admission without work after repository deselection', async () => {
    const integration = await insertIntegrationAndConfig();
    const providerStarted = deferred<void>();
    const providerResponse = deferred<ReturnType<typeof providerPullRequest>>();
    mockFetchBitbucketPullRequest.mockImplementationOnce(async () => {
      providerStarted.resolve(undefined);
      return providerResponse.promise;
    });

    const responsePromise = callWebhook(integration, webhookRequest(integration));
    await providerStarted.promise;
    await db
      .update(agent_configs)
      .set({
        config: {
          review_style: 'balanced',
          focus_areas: [],
          model_slug: 'anthropic/claude-sonnet-4.6',
          repository_selection_mode: 'selected',
          selected_repository_ids: [OTHER_REPOSITORY_UUID],
        },
      })
      .where(
        and(
          eq(agent_configs.owned_by_organization_id, organization.id),
          eq(agent_configs.platform, 'bitbucket')
        )
      );
    providerResponse.resolve(providerPullRequest());

    const response = await responsePromise;

    expect(response.status).toBe(200);
    await expect(organizationReviews()).resolves.toHaveLength(0);
    expect((await organizationWebhookEvents())[0]).toEqual(
      expect.objectContaining({ processed: true, errors: null })
    );
    expect(mockTryDispatchPendingReviews).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'blocked_at',
      blockedAt: '2026-06-24T12:00:00.000Z',
      blockedReason: null,
    },
    {
      name: 'blocked_reason',
      blockedAt: null,
      blockedReason: 'policy_violation',
    },
  ])('refuses provider access when the Code Reviewer bot has $name', async testCase => {
    const integration = await insertIntegrationAndConfig();
    await db
      .update(kilocode_users)
      .set({ blocked_at: testCase.blockedAt, blocked_reason: testCase.blockedReason })
      .where(eq(kilocode_users.id, codeReviewerBot.id));

    try {
      const response = await callWebhook(integration, webhookRequest(integration));

      expect(response.status).toBe(503);
      expect(mockFetchBitbucketPullRequest).not.toHaveBeenCalled();
      await expect(organizationReviews()).resolves.toHaveLength(0);
    } finally {
      await db
        .update(kilocode_users)
        .set({ blocked_at: null, blocked_reason: null })
        .where(eq(kilocode_users.id, codeReviewerBot.id));
    }
  });

  it('resumes the same unprocessed delivery after a provider read failure', async () => {
    const integration = await insertIntegrationAndConfig();
    const hookUuid = randomUUID();
    const requestUuid = randomUUID();
    mockFetchBitbucketPullRequest
      .mockResolvedValueOnce({ success: false, reason: 'temporarily_unavailable' })
      .mockResolvedValueOnce(providerPullRequest());

    const firstResponse = await callWebhook(
      integration,
      webhookRequest(integration, { hookUuid, requestUuid })
    );

    expect(firstResponse.status).toBe(503);
    const [failedEvent] = await organizationWebhookEvents();
    expect(failedEvent).toEqual(
      expect.objectContaining({
        processed: false,
        processed_at: null,
        errors: [{ handler: 'code_review', message: 'temporarily_unavailable' }],
      })
    );

    const retryResponse = await callWebhook(
      integration,
      webhookRequest(integration, { hookUuid, requestUuid })
    );

    expect(retryResponse.status).toBe(202);
    const events = await organizationWebhookEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({ processed: true, errors: null }));
    await expect(organizationReviews()).resolves.toHaveLength(1);
    expect(mockFetchBitbucketPullRequest).toHaveBeenCalledTimes(2);
  });

  it('deduplicates a ready observation when the same head already has a review', async () => {
    const integration = await insertIntegrationAndConfig();
    const existingReviewId = await createExistingReview(integration, DEFAULT_HEAD_SHA);

    const response = await callWebhook(integration, webhookRequest(integration));

    expect(response.status).toBe(200);
    const reviews = await organizationReviews();
    expect(reviews.map(review => review.id)).toEqual([existingReviewId]);
    expect((await organizationWebhookEvents())[0]?.processed).toBe(true);
    expect(mockTryDispatchPendingReviews).not.toHaveBeenCalled();
  });

  it('keeps the newer processed observation when a delayed older observation arrives', async () => {
    const integration = await insertIntegrationAndConfig();
    const newerHead = 'c'.repeat(40);
    const olderHead = 'd'.repeat(40);
    mockFetchBitbucketPullRequest
      .mockResolvedValueOnce(
        providerPullRequest({ updatedOn: '2026-06-24T14:00:00.000Z', headSha: newerHead })
      )
      .mockResolvedValueOnce(
        providerPullRequest({ updatedOn: '2026-06-24T13:00:00.000Z', headSha: olderHead })
      );

    await callWebhook(
      integration,
      webhookRequest(integration, { eventKey: 'pullrequest:updated' })
    );
    const delayedResponse = await callWebhook(
      integration,
      webhookRequest(integration, { eventKey: 'pullrequest:created' })
    );

    expect(delayedResponse.status).toBe(200);
    const reviews = await organizationReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toEqual(expect.objectContaining({ head_sha: newerHead, status: 'pending' }));
    const events = await organizationWebhookEvents();
    expect(events).toHaveLength(2);
    expect(events.every(event => event.processed)).toBe(true);
  });

  it('advances a delayed terminal delivery without cancelling or creating when the provider is ready', async () => {
    const integration = await insertIntegrationAndConfig();
    const existingReviewId = await createExistingReview(integration, 'e'.repeat(40));
    const currentReadyHead = 'f'.repeat(40);
    mockFetchBitbucketPullRequest.mockResolvedValueOnce(
      providerPullRequest({ updatedOn: '2026-06-24T15:00:00.000Z', headSha: currentReadyHead })
    );

    const response = await callWebhook(
      integration,
      webhookRequest(integration, { eventKey: 'pullrequest:fulfilled' })
    );

    expect(response.status).toBe(200);
    const reviews = await organizationReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toEqual(
      expect.objectContaining({ id: existingReviewId, status: 'pending' })
    );
    expect((await organizationWebhookEvents())[0]).toEqual(
      expect.objectContaining({
        processed: true,
        payload: expect.objectContaining({
          eventKey: 'pullrequest:fulfilled',
          state: 'OPEN',
          draft: false,
          headSha: currentReadyHead,
        }),
      })
    );
    expect(mockCancelReview).not.toHaveBeenCalled();
    expect(mockTryDispatchPendingReviews).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'draft',
      eventKey: 'pullrequest:updated',
      provider: { state: 'OPEN' as const, draft: true },
    },
    {
      name: 'terminal',
      eventKey: 'pullrequest:fulfilled',
      provider: { state: 'MERGED' as const, draft: false },
    },
  ])('cancels exact-scope active work when current provider state is $name', async testCase => {
    const integration = await insertIntegrationAndConfig();
    const reviewId = await createExistingReview(integration, DEFAULT_HEAD_SHA, 'queued');
    mockFetchBitbucketPullRequest.mockResolvedValueOnce(providerPullRequest(testCase.provider));

    const response = await callWebhook(
      integration,
      webhookRequest(integration, { eventKey: testCase.eventKey })
    );

    expect(response.status).toBe(200);
    expect((await organizationReviews())[0]).toEqual(
      expect.objectContaining({ id: reviewId, status: 'cancelled', terminal_reason: 'superseded' })
    );
    expect((await organizationWebhookEvents())[0]?.processed).toBe(true);
    expect(mockCancelReview).toHaveBeenCalledWith(reviewId, expect.any(String), undefined);
    expect(mockTryDispatchPendingReviews).not.toHaveBeenCalled();
  });
});
