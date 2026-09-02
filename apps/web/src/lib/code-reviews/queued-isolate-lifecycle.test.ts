const mockPull = jest.fn();
const mockGetComment = jest.fn();
const mockUpdateComment = jest.fn();
const mockGetCheck = jest.fn();
const mockUpdateCheck = jest.fn();
const mockWakeup = jest.fn();
const mockSendCodeReviewDisabledEmail = jest.fn();
let mockFailSettlement = false;

jest.mock('@/lib/email', () => ({
  sendCodeReviewDisabledEmail: (...args: unknown[]) => mockSendCodeReviewDisabledEmail(...args),
}));
jest.mock('@kilocode/worker-utils', () =>
  jest.requireActual('@kilocode/worker-utils/callback-token')
);
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    pulls: { get: mockPull },
    issues: { getComment: mockGetComment, updateComment: mockUpdateComment },
    checks: { get: mockGetCheck, update: mockUpdateCheck },
  })),
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: jest.fn().mockResolvedValue({ token: 'fixture-only' }),
}));
jest.mock('@/lib/integrations/platforms/github/app-selector', () => ({
  getGitHubAppCredentials: () => ({ appId: '123' }),
  getGitHubAppName: () => 'KiloConnect',
}));
jest.mock('./dispatch/dispatch-pending-reviews', () => ({
  tryDispatchPendingReviews: (...args: unknown[]) => mockWakeup(...args),
}));
jest.mock('@kilocode/db/operation-ledger', () => {
  const actual = jest.requireActual('@kilocode/db/operation-ledger');
  return {
    ...actual,
    settleOperation: (...args: unknown[]) => {
      if (mockFailSettlement) throw new Error('Injected ledger failure');
      return actual.settleOperation(...args);
    },
  };
});

import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { deriveCallbackToken } from '@kilocode/worker-utils/callback-token';
import { db } from '@/lib/drizzle';
import { INTERNAL_API_SECRET, CALLBACK_TOKEN_SECRET } from '@/lib/config.server';
import { POST } from '@/app/api/internal/code-review-status/[reviewId]/route';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { generateBotUserId } from '@/lib/bot-users/types';
import {
  cloud_agent_code_reviews,
  cloud_agent_code_review_attempts,
  code_review_analytics_results,
  code_review_analytics_findings,
  organizations,
  organization_memberships,
  platform_integrations,
  kilocode_users,
  operation_ledgers,
  analytics_event_outbox,
  agent_configs,
  microdollar_usage,
  microdollar_usage_metadata,
  type User,
} from '@kilocode/db/schema';
import { IsolateReviewRequestSchema } from '@/lib/isolate-review-worker-client';
import type { ManualCodeReviewConfig } from '@kilocode/db/schema-types';
import {
  getCodeReviewActionRequiredCopy,
  getCodeReviewActionRequiredState,
} from './action-required';
import {
  admitCodeReviewAttemptForDispatch,
  createCodeReviewAttempt,
  updateCodeReviewStatus,
  cancelCodeReview,
  failReservedQueuedReview,
} from './db/code-reviews';
import {
  acquireIsolatePublicationFence,
  blockCodeReviewOnPublicationFence,
  publicationFromAttempt,
  requestIsolateIdentityCleanup,
  updateIsolatePublicationOn,
} from './db/publication-fences';
import {
  getIsolateFenceForAttempt,
  recoverQueuedIsolateReviews,
} from './client/queued-isolate-review-client';
import { cronPendingCodeReviewCreatedAtWindowSql } from './dispatch/dispatch-constants';
import {
  bindQueuedIsolatePreparation,
  resumeQueuedIsolateFinalization,
} from './queued-isolate-lifecycle';
import {
  QueuedIsolateIdentitySchema,
  type QueuedIsolateNotificationSchema,
  type QueuedIsolateIdentity,
} from './queued-isolate-contract';

type WorkerState = {
  runId: string;
  status: 'pending' | 'cloning' | 'running' | 'completed' | 'error';
  input: Record<string, never>;
  terminationReason?: 'completed' | 'cancelled' | 'execution_deadline';
  requestIds?: string[];
  usageRequestCounts?: Record<string, number>;
  taskSessions?: { sessionId: string; parentSessionId: string }[];
  completedAt?: string;
  summaryPublished?: boolean;
  summaryCommentId?: number;
  summaryBodyHash?: string;
  gateResult?: 'pass';
  queued: {
    identity: QueuedIsolateIdentity;
    admitted: boolean;
    cancellationRequested: boolean;
    callback: { url: string; token: string };
    maintenanceScheduleId: string;
    operations: {
      id: string;
      kind: 'review' | 'summary';
      fingerprint: string;
      state: 'prepared' | 'sent' | 'confirmed';
    }[];
    safety: Notification['safety'];
    acknowledgedSequence: number;
    fenceReleased: boolean;
    cleaned: boolean;
    pendingNotification?: Notification;
    result?: Notification['result'];
  };
};
const { updateQueuedSafety } = jest.requireActual<{
  updateQueuedSafety: (state: WorkerState) => WorkerState;
}>('../../../../../services/isolate-review/src/queued-review');

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const snapshot = {
  headSha: 'a'.repeat(40),
  baseTipSha: 'b'.repeat(40),
  mergeBaseSha: 'c'.repeat(40),
};
type Notification = z.infer<typeof QueuedIsolateNotificationSchema>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('authenticated queued isolate lifecycle with PostgreSQL', () => {
  let user: User;
  let bot: User;
  let organizationId: string;
  let integrationId: string;
  let identity: QueuedIsolateIdentity;
  let request: z.infer<typeof IsolateReviewRequestSchema>;
  let preparationHash: string;
  let comment: {
    id: number;
    body: string;
    issue_url: string;
    user: { login: string; type: string };
    performed_via_github_app: { id: number };
  };
  let check: {
    id: number;
    head_sha: string;
    app: { id: number };
    external_id: string;
    status: string;
    conclusion: string | null;
  };
  const reviewIds: string[] = [];
  const usageIds: string[] = [];

  async function candidate(head = snapshot.headSha, prNumber = 42) {
    const reservation = crypto.randomUUID();
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        owned_by_organization_id: organizationId,
        platform_integration_id: integrationId,
        repo_full_name: 'acme/widget',
        pr_number: prNumber,
        pr_url: `https://github.com/acme/widget/pull/${prNumber}`,
        pr_title: 'Lifecycle fixture',
        pr_author: 'author',
        base_ref: 'main',
        head_ref: 'feature',
        head_sha: head,
        status: 'queued',
        dispatch_reservation_id: reservation,
        check_run_id: 33,
      })
      .returning();
    reviewIds.push(review.id);
    const attempt = await admitCodeReviewAttemptForDispatch({
      codeReviewId: review.id,
      dispatchReservationId: reservation,
      previousStatus: 'pending',
    });
    const identity: QueuedIsolateIdentity = {
      reviewId: review.id,
      attemptId: attempt.id,
      generation: crypto.randomUUID(),
      organizationId,
      integrationId,
      executionUserId: user.id,
      target: { host: 'github.com', repoFullName: 'acme/widget', prNumber },
      snapshot: { ...snapshot, headSha: head },
    };
    return { identity, dispatchReservationId: reservation };
  }

  function notice(
    execution: Notification['safety']['execution'] = 'completed',
    sequence = 1
  ): Notification {
    const terminal = ['completed', 'failed', 'cancelled'].includes(execution);
    return {
      version: 1,
      identity,
      safety: {
        sequence,
        execution,
        cancellationRequested: execution === 'cancelled',
        publication: execution === 'completed' ? 'settled' : 'not_started',
        quiescent: terminal,
        observedAt: new Date().toISOString(),
      },
      ...(terminal
        ? {
            result: {
              reason:
                execution === 'completed'
                  ? ('completed' as const)
                  : execution === 'cancelled'
                    ? ('cancelled' as const)
                    : ('admission_failed' as const),
              completedAt: new Date().toISOString(),
              sessions: [{ sessionId: identity.attemptId, parentSessionId: null }],
              summary:
                execution === 'completed'
                  ? { commentId: comment.id, bodyHash: hash(comment.body) }
                  : null,
              gateResult: execution === 'completed' ? ('pass' as const) : null,
              analytics: {
                marker:
                  '<!-- kilo-review-analytics:v1 {"schemaVersion":1,"taxonomyVersion":1,"change":{"type":"bug_fix","impact":"high","complexity":"low","confidence":"high"},"findings":[{"severity":"warning","category":"correctness","securityClass":null}]} -->',
                omitted: false,
              },
            },
          }
        : {}),
    };
  }

  async function callback(
    body: unknown,
    options: { signingIdentity?: QueuedIsolateIdentity; scope?: string; backend?: string } = {}
  ) {
    const signingIdentity = options.signingIdentity ?? identity;
    const scope = options.scope ?? 'queued-isolate-callback';
    const token = await deriveCallbackToken({
      secret: scope === 'queued-isolate-callback' ? INTERNAL_API_SECRET : CALLBACK_TOKEN_SECRET,
      scope,
      resourceParts:
        scope === 'queued-isolate-callback'
          ? [JSON.stringify(QueuedIsolateIdentitySchema.parse(signingIdentity))]
          : [identity.reviewId, identity.attemptId],
    });
    const req = new NextRequest(
      `http://localhost/api/internal/code-review-status/${identity.reviewId}?attemptId=${identity.attemptId}&backend=${options.backend ?? 'isolate'}`,
      {
        method: 'POST',
        headers: { 'X-Callback-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const response = await POST(req, { params: Promise.resolve({ reviewId: identity.reviewId }) });
    return { status: response.status, body: await response.json() };
  }

  const authority = (
    operation: 'execute' | 'publish' | 'reconcile' = 'execute',
    operationId = identity.attemptId
  ) => ({ version: 1, identity, preparationHash, operation, operationId });
  const fence = async (input = identity) => {
    const [attempt] = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(
        and(
          eq(cloud_agent_code_review_attempts.id, input.attemptId),
          eq(cloud_agent_code_review_attempts.code_review_id, input.reviewId)
        )
      );
    const publication = attempt ? publicationFromAttempt(attempt) : null;
    if (!publication) throw new Error('Missing attempt publication state');
    return publication;
  };
  const review = async () =>
    (
      await db
        .select()
        .from(cloud_agent_code_reviews)
        .where(eq(cloud_agent_code_reviews.id, identity.reviewId))
    )[0];

  beforeAll(async () => {
    user = await insertTestUser({ id: `oauth/github/lifecycle-${crypto.randomUUID()}` });
    const [org] = await db.insert(organizations).values({ name: 'Lifecycle tests' }).returning();
    organizationId = org.id;
    bot = await insertTestUser({
      id: generateBotUserId(organizationId, 'code-review'),
      is_bot: true,
    });
    await db.insert(organization_memberships).values([
      { organization_id: organizationId, kilo_user_id: user.id, role: 'owner' },
      { organization_id: organizationId, kilo_user_id: bot.id, role: 'member' },
    ]);
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organizationId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: '12345',
        platform_account_id: crypto.randomUUID(),
        platform_account_login: 'acme',
        repository_access: 'all',
        integration_status: 'active',
        github_app_type: 'standard',
      })
      .returning();
    integrationId = integration.id;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockFailSettlement = false;
    mockWakeup.mockResolvedValue(undefined);
    mockSendCodeReviewDisabledEmail.mockResolvedValue({ sent: true });
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
    const input = await candidate();
    identity = input.identity;
    await acquireIsolatePublicationFence(input);
    await db
      .update(cloud_agent_code_review_attempts)
      .set({ analytics_enabled_at_dispatch: true })
      .where(eq(cloud_agent_code_review_attempts.id, identity.attemptId));
    const start = new Date(Date.now() - 60_000).toISOString();
    await db.insert(operation_ledgers).values({
      operation_key: `review:${identity.reviewId}`,
      domain: 'code_review',
      intent: 'manual',
      kilo_user_id: user.id,
      organization_id: organizationId,
      taxonomy: 'safe-retry',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
    });
    request = IsolateReviewRequestSchema.parse({
      owner: 'acme',
      repo: 'widget',
      pullNumber: 42,
      organizationId,
      ...snapshot,
      model: 'fixture/model',
      expectedIntegrationId: integrationId,
      expectedInstallationId: '12345',
      expectedAppType: 'standard',
      dryRun: false,
      userPrompt: 'Canonical policy',
      preparation: {
        version: 1,
        preparedAt: start,
        requestingUserId: user.id,
        executionUserId: user.id,
        organizationId,
        queued: { identity, gateThreshold: 'warning', summaryHistory: '' },
        settings: {
          reviewStyle: 'balanced',
          focusAreas: [],
          customInstructions: null,
          manualInstructions: null,
          model: 'fixture/model',
          thinkingEffort: null,
          modelSource: 'global',
          disableReviewMd: false,
          analyticsEnabled: true,
        },
        snapshot,
        github: { integrationId, installationId: '12345', appType: 'standard' },
        reviewInstructions: {
          path: 'REVIEW.md',
          sha: snapshot.baseTipSha,
          hash: 'd'.repeat(64),
          characterCount: 12,
          truncated: false,
        },
        hashes: {
          settings: 'd'.repeat(64),
          context: 'e'.repeat(64),
          canonicalPrompt: 'f'.repeat(64),
          adaptedPrompt: '1'.repeat(64),
          system: '2'.repeat(64),
        },
        versions: { cli: '7.4.20', policy: 'fixture', adapter: 'fixture' },
        limitations: [],
      },
    });
    preparationHash = (await bindQueuedIsolatePreparation(identity, request)).hash;
    comment = {
      id: 22,
      body: `<!-- kilo-review -->\nReviewed ${snapshot.headSha}\n<!-- kilo-isolate-review-summary:${hash(identity.attemptId)} -->`,
      issue_url: 'https://api.github.com/repos/acme/widget/issues/42',
      user: { login: 'kiloconnect[bot]', type: 'Bot' },
      performed_via_github_app: { id: 123 },
    };
    check = {
      id: 33,
      head_sha: snapshot.headSha,
      app: { id: 123 },
      external_id: '',
      status: 'in_progress',
      conclusion: null,
    };
    mockPull.mockResolvedValue({
      data: {
        state: 'open',
        head: { sha: snapshot.headSha },
        base: { repo: { full_name: 'acme/widget' } },
      },
    });
    mockGetComment.mockImplementation(async () => ({ data: { ...comment } }));
    mockUpdateComment.mockImplementation(async ({ body }) => {
      comment = { ...comment, body };
      return { data: { ...comment } };
    });
    mockGetCheck.mockImplementation(async () => ({ data: { ...check } }));
    mockUpdateCheck.mockImplementation(async ({ status, conclusion, external_id }) => {
      check = { ...check, status, conclusion, external_id };
      return { data: { ...check } };
    });
  });

  afterEach(async () => {
    expect(fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    await db
      .delete(cloud_agent_code_reviews)
      .where(inArray(cloud_agent_code_reviews.id, reviewIds));
    await db.delete(operation_ledgers).where(eq(operation_ledgers.kilo_user_id, user.id));
    await db
      .delete(agent_configs)
      .where(eq(agent_configs.owned_by_organization_id, organizationId));
    await db
      .delete(analytics_event_outbox)
      .where(eq(analytics_event_outbox.distinct_id, user.google_user_email));
    if (usageIds.length) {
      await db
        .delete(microdollar_usage_metadata)
        .where(inArray(microdollar_usage_metadata.id, usageIds));
      await db.delete(microdollar_usage).where(inArray(microdollar_usage.id, usageIds));
    }
    await db
      .update(kilocode_users)
      .set({ blocked_reason: null })
      .where(eq(kilocode_users.id, user.id));
    await db
      .update(platform_integrations)
      .set({ integration_status: 'active' })
      .where(eq(platform_integrations.id, integrationId));
    reviewIds.length = 0;
    usageIds.length = 0;
  });

  afterAll(async () => {
    await db.delete(platform_integrations).where(eq(platform_integrations.id, integrationId));
    await db
      .delete(organization_memberships)
      .where(eq(organization_memberships.organization_id, organizationId));
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, [user.id, bot.id]));
  });

  it.each(['cancelled', 'failed'] as const)(
    'finishes the exact gate after %s before preparation binding',
    async status => {
      await db.transaction(tx => updateIsolatePublicationOn(tx, identity, { preparation: null }));
      if (status === 'cancelled') await cancelCodeReview(identity.reviewId, identity.attemptId);
      else {
        const row = await review();
        await failReservedQueuedReview(
          identity.reviewId,
          row.dispatch_reservation_id!,
          'Preparation failed'
        );
      }
      await expect(bindQueuedIsolatePreparation(identity, request)).rejects.toThrow(
        'no longer authorized'
      );
      const notification = notice('cancelled');
      notification.result!.sessions[0].requestCount = 0;
      const response = await callback(notification);
      expect(response.status).toBe(200);
      expect(response.body.fenceReleased).toBe(true);
      expect(mockUpdateCheck).toHaveBeenCalledTimes(1);
      expect(mockUpdateCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          check_run_id: 33,
          status: 'completed',
          conclusion: status === 'cancelled' ? 'cancelled' : 'failure',
        })
      );
      expect((await fence()).web_publications).toEqual([
        expect.objectContaining({ kind: 'gate', targetId: 33, state: 'confirmed' }),
      ]);
      await callback(notification);
      expect(mockUpdateCheck).toHaveBeenCalledTimes(1);
      expect((await review()).status).toBe(status);
    }
  );

  it('keeps an unprepared cancellation fenced while its gate response is delayed', async () => {
    await db.transaction(tx => updateIsolatePublicationOn(tx, identity, { preparation: null }));
    await cancelCodeReview(identity.reviewId, identity.attemptId);
    const entered = deferred<void>();
    const resume = deferred<void>();
    mockUpdateCheck.mockImplementationOnce(async ({ status, conclusion, external_id }) => {
      entered.resolve();
      await resume.promise;
      check = { ...check, status, conclusion, external_id };
      return { data: { ...check } };
    });
    const notification = notice('cancelled');
    notification.result!.sessions[0].requestCount = 0;
    const response = callback(notification);
    await entered.promise;
    try {
      expect(await fence()).toMatchObject({
        released_at: null,
        web_finalization: 'uncertain',
        web_publications: [expect.objectContaining({ kind: 'gate', targetId: 33, state: 'sent' })],
      });
    } finally {
      resume.resolve();
    }
    expect((await response).body.fenceReleased).toBe(true);
    await callback(notification);
    expect(mockUpdateCheck).toHaveBeenCalledTimes(1);
  });

  it.each(['check', 'app', 'head', 'installation'] as const)(
    'does not broaden unprepared gate authority after %s changes',
    async changed => {
      await db.transaction(tx => updateIsolatePublicationOn(tx, identity, { preparation: null }));
      await cancelCodeReview(identity.reviewId, identity.attemptId);
      if (changed === 'check')
        await db
          .update(cloud_agent_code_reviews)
          .set({ check_run_id: 99 })
          .where(eq(cloud_agent_code_reviews.id, identity.reviewId));
      if (changed === 'app') check.app.id = 999;
      if (changed === 'head') check.head_sha = 'f'.repeat(40);
      if (changed === 'installation')
        await db
          .update(platform_integrations)
          .set({ platform_installation_id: '98765' })
          .where(eq(platform_integrations.id, integrationId));
      try {
        const notification = notice('cancelled');
        notification.result!.sessions[0].requestCount = 0;
        expect((await callback(notification)).status).toBe(200);
        expect(mockUpdateCheck).not.toHaveBeenCalled();
      } finally {
        if (changed === 'installation')
          await db
            .update(platform_integrations)
            .set({ platform_installation_id: '12345' })
            .where(eq(platform_integrations.id, integrationId));
      }
    }
  );

  it('binds immutable canonical preparation and rejects wrong authorization dimensions', async () => {
    expect(await bindQueuedIsolatePreparation(identity, request)).toEqual(
      (await fence()).preparation
    );
    await expect(
      bindQueuedIsolatePreparation(identity, { ...request, userPrompt: 'changed' })
    ).rejects.toThrow('immutable');
    expect((await callback(authority())).body.authorized).toBe(true);
    for (const changed of [
      { ...identity, executionUserId: 'oauth/github/other' },
      { ...identity, organizationId: crypto.randomUUID() },
      { ...identity, integrationId: crypto.randomUUID() },
      { ...identity, generation: crypto.randomUUID() },
      { ...identity, snapshot: { ...snapshot, baseTipSha: 'd'.repeat(40) } },
    ]) {
      expect((await callback({ ...authority(), identity: changed })).status).toBe(401);
      expect(
        (await callback({ ...authority(), identity: changed }, { signingIdentity: changed })).status
      ).toBe(409);
    }
    expect(
      (await callback({ ...authority(), preparationHash: '0'.repeat(64) })).body.authorized
    ).toBe(false);
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'fixture blocked' })
      .where(eq(kilocode_users.id, user.id));
    expect((await callback(authority())).body.authorized).toBe(false);
    await db
      .update(kilocode_users)
      .set({ blocked_reason: null })
      .where(eq(kilocode_users.id, user.id));
    await db
      .update(platform_integrations)
      .set({ integration_status: 'suspended' })
      .where(eq(platform_integrations.id, integrationId));
    expect((await callback(authority())).body.authorized).toBe(false);
  });

  it('reads publication state only for the requested review and attempt', async () => {
    expect(await getIsolateFenceForAttempt(identity.reviewId, identity.attemptId)).toEqual(
      await fence()
    );
    const other = await candidate(snapshot.headSha, 43);
    for (const [reviewId, attemptId] of [
      [other.identity.reviewId, identity.attemptId],
      [identity.reviewId, other.identity.attemptId],
      [other.identity.reviewId, other.identity.attemptId],
    ])
      await expect(getIsolateFenceForAttempt(reviewId, attemptId)).rejects.toThrow(
        'publication fence is missing'
      );
  });

  it('retains concurrent authorization and notification patches through finalization', async () => {
    const operations = [crypto.randomUUID(), crypto.randomUUID()];
    const running = notice('running');
    const responses = await Promise.all([
      ...operations.map(operation => callback(authority('publish', operation))),
      callback(running),
    ]);
    expect(responses.every(response => response.status === 200)).toBe(true);
    expect(responses.slice(0, 2).every(response => response.body.authorized === true)).toBe(true);
    const prepared = await fence();
    expect(prepared.authorized_operation_ids).toEqual(expect.arrayContaining(operations));
    expect(prepared.authorized_operation_ids).toHaveLength(2);
    expect(prepared.safety).toEqual(running.safety);
    const payload = notice('failed', 2);
    expect((await callback(payload)).body.fenceReleased).toBe(true);
    const [attempt] = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(
        and(
          eq(cloud_agent_code_review_attempts.id, identity.attemptId),
          eq(cloud_agent_code_review_attempts.code_review_id, identity.reviewId)
        )
      );
    expect(attempt.publication_state).toEqual({
      identity,
      preparation: prepared.preparation,
      gate_authorization: prepared.gate_authorization,
      authorized_operation_ids: prepared.authorized_operation_ids,
      safety: payload.safety,
      terminal_result: payload.result,
      usage_settlement: { totals: null },
      canonical_settled_at: expect.any(String),
      queue_wakeup_at: expect.any(String),
      web_finalization: 'settled',
      web_publications: [expect.objectContaining({ kind: 'gate', state: 'confirmed' })],
      identity_digest: null,
      identity_cleanup_requested: false,
      released_at: expect.any(String),
    });
    expect(attempt).toMatchObject({
      status: 'failed',
      reviewer_backend: 'isolate',
      reviewer_execution_id: identity.attemptId,
    });
  });

  it('rejects legacy tokens and prevents legacy mutation of an isolate attempt', async () => {
    expect((await callback(authority(), { scope: 'code-review-status-callback' })).status).toBe(
      401
    );
    expect(
      (
        await callback(
          { status: 'completed' },
          { backend: 'legacy', scope: 'code-review-status-callback' }
        )
      ).status
    ).toBe(409);
    expect((await review()).status).toBe('queued');
    expect((await fence()).safety).toBeNull();
  });

  it('moves queued to running without fabricating sessions and admits exact reconciliation after supersession', async () => {
    expect((await callback(notice('not_started'))).status).toBe(200);
    expect((await review()).status).toBe('queued');
    expect((await callback(notice('running', 2))).status).toBe(200);
    expect(await review()).toMatchObject({
      status: 'running',
      session_id: null,
      cli_session_id: null,
    });
    const operation = crypto.randomUUID();
    expect((await callback(authority('publish', operation))).body.authorized).toBe(true);
    await updateCodeReviewStatus(identity.reviewId, 'cancelled', { terminalReason: 'superseded' });
    expect((await callback(authority())).body.authorized).toBe(false);
    expect((await callback(authority('reconcile', operation))).body.authorized).toBe(true);
    expect((await callback(authority('reconcile', crypto.randomUUID()))).body.authorized).toBe(
      false
    );
  });

  it.each(['completed', 'cancelled'] as const)(
    'acknowledges Worker-generated cloning, pending submission and publication reports through %s',
    async outcome => {
      let state: WorkerState = {
        runId: identity.attemptId,
        status: 'pending',
        input: {},
        queued: {
          identity,
          admitted: true,
          cancellationRequested: false,
          callback: { url: 'http://localhost/callback', token: 'a'.repeat(64) },
          maintenanceScheduleId: 'fixture',
          operations: [],
          safety: notice('not_started').safety,
          acknowledgedSequence: 0,
          fenceReleased: false,
          cleaned: false,
        },
      };
      async function report() {
        state = updateQueuedSafety(state);
        const queued = state.queued;
        if (!queued?.pendingNotification) throw new Error('Missing Worker notification');
        const response = await callback(queued.pendingNotification);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          notificationRecorded: true,
          sequence: queued.pendingNotification.safety.sequence,
        });
        state = {
          ...state,
          queued: {
            ...queued,
            acknowledgedSequence: response.body.sequence,
            pendingNotification: undefined,
          },
        };
        return response.body;
      }
      function operation(kind: 'review' | 'summary', status: 'prepared' | 'sent' | 'confirmed') {
        if (!state.queued) throw new Error('Missing Worker state');
        const existing = state.queued.operations.find(item => item.kind === kind);
        state.queued.operations = [
          ...state.queued.operations.filter(item => item.kind !== kind),
          { id: existing?.id ?? crypto.randomUUID(), kind, fingerprint: hash(kind), state: status },
        ];
      }
      await report();
      expect((await review()).status).toBe('queued');
      state.status = 'cloning';
      expect((await report()).fenceReleased).toBe(false);
      expect((await review()).status).toBe('running');
      const cloningSafety = state.queued.safety;
      state.status = 'pending';
      state = updateQueuedSafety(state);
      if (state.queued.pendingNotification) await report();
      expect(state.queued.safety).toEqual(cloningSafety);
      expect(state.queued.pendingNotification).toBeUndefined();
      expect((await fence()).safety).toEqual(cloningSafety);
      expect((await callback(notice('not_started', cloningSafety.sequence + 1))).status).toBe(409);
      state.status = 'running';
      operation('review', 'prepared');
      await report();
      operation('review', 'sent');
      expect((await report()).fenceReleased).toBe(false);
      operation('review', 'confirmed');
      await report();
      operation('summary', 'prepared');
      state = updateQueuedSafety(state);
      expect(state.queued?.pendingNotification).toBeUndefined();
      operation('summary', 'sent');
      expect((await report()).fenceReleased).toBe(false);
      if (outcome === 'completed') {
        operation('summary', 'confirmed');
        expect((await report()).fenceReleased).toBe(false);
      }
      state = {
        ...state,
        status: outcome === 'completed' ? 'completed' : 'error',
        terminationReason: outcome,
        completedAt: new Date().toISOString(),
        summaryPublished: outcome === 'completed',
        summaryCommentId: comment.id,
        summaryBodyHash: hash(comment.body),
        gateResult: 'pass',
      };
      if (!state.queued) throw new Error('Missing Worker state');
      state.queued.cancellationRequested = outcome === 'cancelled';
      if (outcome === 'cancelled') {
        expect((await report()).fenceReleased).toBe(false);
        expect((await fence()).safety).toMatchObject({
          publication: 'uncertain',
          quiescent: false,
        });
        operation('summary', 'confirmed');
      }
      expect((await report()).fenceReleased).toBe(true);
      expect((await review()).status).toBe(outcome);
      expect((await fence()).safety).toMatchObject({ publication: 'settled', quiescent: true });
      expect(mockWakeup).toHaveBeenCalledTimes(1);
      const retained = state.queued;
      if (!retained) throw new Error('Missing Worker state');
      expect(
        (
          await callback({
            version: 1,
            identity,
            safety: {
              ...retained.safety,
              sequence: retained.safety.sequence + 1,
              quiescent: false,
              publication: 'uncertain',
            },
            result: retained.result,
          })
        ).status
      ).toBe(409);
    }
  );

  it.each([
    'admission_failed',
    'submission_error',
    'credentials_expired',
    'execution_deadline',
    'absolute_deadline',
    'publication_incomplete',
    'cancelled',
  ] as const)('settles %s once without fresh-session retry', async reason => {
    const payload = notice(reason === 'cancelled' ? 'cancelled' : 'failed');
    if (!payload.result) throw new Error('Missing result');
    payload.result.reason = reason;
    expect((await callback(payload)).body.fenceReleased).toBe(true);
    expect((await callback(payload)).body.fenceReleased).toBe(true);
    const expected = reason === 'cancelled' ? 'cancelled' : 'failed';
    expect(await review()).toMatchObject({
      status: expected,
      terminal_reason: reason,
      session_id: null,
      cli_session_id: null,
    });
    const [attempt] = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.id, identity.attemptId));
    expect(attempt).toMatchObject({
      status: expected,
      session_id: null,
      cli_session_id: null,
      execution_id: null,
    });
    const ledger = await db
      .select()
      .from(operation_ledgers)
      .where(eq(operation_ledgers.operation_key, `review:${identity.reviewId}`));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe(reason === 'cancelled' ? 'no_op' : 'failed');
    expect(
      await db
        .select()
        .from(analytics_event_outbox)
        .where(
          and(
            eq(analytics_event_outbox.distinct_id, user.google_user_email),
            eq(analytics_event_outbox.event_name, 'code_review_settled')
          )
        )
    ).toHaveLength(1);
    expect(mockUpdateCheck).toHaveBeenCalledTimes(1);
    expect(mockUpdateComment).not.toHaveBeenCalled();
    expect(mockWakeup).toHaveBeenCalledTimes(1);
  });

  const automationConfig = async () =>
    (
      await db
        .select()
        .from(agent_configs)
        .where(
          and(
            eq(agent_configs.owned_by_organization_id, organizationId),
            eq(agent_configs.agent_type, 'code_review'),
            eq(agent_configs.platform, 'github')
          )
        )
    )[0];

  async function enableAutomation() {
    await db.insert(agent_configs).values({
      owned_by_organization_id: organizationId,
      agent_type: 'code_review',
      platform: 'github',
      config: {},
      is_enabled: true,
      created_by: user.id,
    });
    return automationConfig();
  }

  it.each(['byok_invalid_key', 'selected_model_unavailable'] as const)(
    'disables automation and notifies once for %s without releasing unresolved publication',
    async reason => {
      await enableAutomation();
      const payload = notice('failed');
      if (!payload.result) throw new Error('Missing result');
      payload.result.reason = reason;
      payload.result.sessions[0].requestCount = 0;
      payload.safety.publication = 'uncertain';
      payload.safety.quiescent = false;
      const responses = await Promise.all([callback(payload), callback(payload)]);
      expect(responses.every(response => response.status === 200)).toBe(true);
      expect(responses.every(response => response.body.fenceReleased === false)).toBe(true);
      expect(await review()).toMatchObject({ status: 'failed', terminal_reason: reason });
      const config = await automationConfig();
      const copy = getCodeReviewActionRequiredCopy(reason);
      expect(config.is_enabled).toBe(false);
      expect(getCodeReviewActionRequiredState(config)).toMatchObject({
        reason,
        triggeringReviewId: identity.reviewId,
        lastErrorMessage: copy.description,
        emailSentAt: expect.any(String),
      });
      expect(JSON.stringify(config.runtime_state)).not.toContain(user.google_user_email);
      expect(mockSendCodeReviewDisabledEmail).toHaveBeenCalledTimes(1);
      expect(mockSendCodeReviewDisabledEmail).toHaveBeenCalledWith(
        user.google_user_email,
        expect.objectContaining({ reason: copy.emailReason })
      );
      expect(mockUpdateCheck).not.toHaveBeenCalled();
      expect(mockWakeup).not.toHaveBeenCalled();
      const settled = {
        ...payload,
        safety: { ...payload.safety, sequence: 2, publication: 'settled', quiescent: true },
      };
      expect((await callback(settled)).body.fenceReleased).toBe(true);
      expect(check.conclusion).toBe('action_required');
      expect(mockUpdateCheck).toHaveBeenCalledTimes(1);
      expect(mockUpdateCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          conclusion: 'action_required',
          output: { title: copy.checkTitle, summary: copy.checkSummary },
        })
      );
      expect((await callback(settled)).body.fenceReleased).toBe(true);
      expect(mockSendCodeReviewDisabledEmail).toHaveBeenCalledTimes(1);
      expect(await automationConfig()).toEqual(config);
      await db
        .update(agent_configs)
        .set({ is_enabled: true, runtime_state: null })
        .where(eq(agent_configs.id, config.id));
      expect((await callback(settled)).status).toBe(200);
      expect((await automationConfig()).is_enabled).toBe(true);
      expect(mockSendCodeReviewDisabledEmail).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps manual review settings and automation enabled after an actionable provider failure', async () => {
    const config = await enableAutomation();
    const manualConfig: ManualCodeReviewConfig = {
      agentConfig: { review_style: 'balanced', focus_areas: [], model_slug: 'fixture/model' },
      instructions: 'Manual review instructions',
      outputMode: 'provider',
    };
    await db
      .update(cloud_agent_code_reviews)
      .set({ manual_config: manualConfig })
      .where(eq(cloud_agent_code_reviews.id, identity.reviewId));
    const payload = notice('failed');
    if (!payload.result) throw new Error('Missing result');
    payload.result.reason = 'byok_invalid_key';
    expect((await callback(payload)).body.fenceReleased).toBe(true);
    expect((await callback(payload)).body.fenceReleased).toBe(true);
    expect(await review()).toMatchObject({
      status: 'failed',
      terminal_reason: 'byok_invalid_key',
      manual_config: manualConfig,
    });
    expect(await automationConfig()).toEqual(config);
    expect(mockSendCodeReviewDisabledEmail).not.toHaveBeenCalled();
    expect(check.conclusion).toBe('action_required');
    expect(mockUpdateCheck).toHaveBeenCalledTimes(1);
  });

  it('retries action-required settlement after its disable operation fails', async () => {
    const payload = notice('failed');
    if (!payload.result) throw new Error('Missing result');
    payload.result.reason = 'byok_invalid_key';
    expect((await callback(payload)).status).toBe(409);
    expect((await review()).status).toBe('queued');
    expect((await fence()).canonical_settled_at).toBeNull();
    expect(mockSendCodeReviewDisabledEmail).not.toHaveBeenCalled();
    expect(mockUpdateCheck).not.toHaveBeenCalled();
    await enableAutomation();
    expect((await callback(payload)).body.fenceReleased).toBe(true);
    expect((await callback(payload)).body.fenceReleased).toBe(true);
    expect((await automationConfig()).is_enabled).toBe(false);
    expect(mockSendCodeReviewDisabledEmail).toHaveBeenCalledTimes(1);
    expect(mockUpdateCheck).toHaveBeenCalledTimes(1);
  });

  it.each(['cancelled', 'superseded', 'replacement_attempt', 'identity_cleanup'] as const)(
    'does not disable automation for an actionable result after %s',
    async change => {
      const config = await enableAutomation();
      if (change === 'replacement_attempt')
        await createCodeReviewAttempt({ codeReviewId: identity.reviewId });
      else if (change === 'identity_cleanup')
        await db.transaction(tx => requestIsolateIdentityCleanup(tx, user.id));
      else
        await updateCodeReviewStatus(identity.reviewId, 'cancelled', {
          terminalReason: change === 'superseded' ? 'superseded' : 'user_cancelled',
        });
      const payload = notice('failed');
      if (!payload.result) throw new Error('Missing result');
      payload.result.reason = 'byok_invalid_key';
      expect((await callback(payload)).status).toBe(200);
      expect((await callback(payload)).status).toBe(200);
      expect(await automationConfig()).toEqual(config);
      expect(mockSendCodeReviewDisabledEmail).not.toHaveBeenCalled();
    }
  );

  it('atomically rolls back notification, terminalization and analytics when settlement fails', async () => {
    const payload = notice();
    mockFailSettlement = true;
    expect((await callback(payload)).status).toBe(409);
    expect((await review()).status).toBe('queued');
    expect((await fence()).safety).toBeNull();
    expect(
      await db
        .select()
        .from(code_review_analytics_results)
        .where(eq(code_review_analytics_results.code_review_id, identity.reviewId))
    ).toHaveLength(0);
    mockFailSettlement = false;
    expect((await callback(payload)).body.fenceReleased).toBe(true);
    expect((await callback(payload)).body.fenceReleased).toBe(true);
    const [analytics] = await db
      .select()
      .from(code_review_analytics_results)
      .where(eq(code_review_analytics_results.code_review_id, identity.reviewId));
    expect(analytics.capture_status).toBe('captured');
    expect(
      await db
        .select()
        .from(code_review_analytics_findings)
        .where(eq(code_review_analytics_findings.analytics_result_id, analytics.id))
    ).toHaveLength(1);
    expect(mockUpdateComment).toHaveBeenCalledTimes(1);
    expect(comment.body).toContain('Review guidance: REVIEW.md');
  });

  it('fails a missing required gate result instead of publishing a passing check', async () => {
    const payload = notice();
    if (!payload.result) throw new Error('Missing result');
    payload.result.gateResult = null;
    expect((await callback(payload)).body.fenceReleased).toBe(true);
    expect((await review()).status).toBe('failed');
    expect(check.conclusion).toBe('failure');
    expect(mockUpdateComment).not.toHaveBeenCalled();
  });

  it('keeps an explicit failing review gate non-passing', async () => {
    const payload = notice();
    if (!payload.result) throw new Error('Missing result');
    payload.result.gateResult = 'fail';
    expect((await callback(payload)).body.fenceReleased).toBe(true);
    expect((await review()).status).toBe('completed');
    expect(check.conclusion).toBe('failure');
  });

  it('holds cross-review successor wakeup while an authorized footer response is delayed', async () => {
    const entered = deferred<void>();
    const response = deferred<{ data: typeof comment }>();
    mockUpdateComment.mockImplementation(({ body }) => {
      comment = { ...comment, body };
      entered.resolve();
      return response.promise;
    });
    const payload = notice();
    const first = callback(payload);
    await entered.promise;
    expect((await fence()).released_at).toBeNull();
    const successor = await candidate('d'.repeat(40));
    await db.transaction(tx =>
      blockCodeReviewOnPublicationFence(tx, {
        reviewId: successor.identity.reviewId,
        attemptId: successor.identity.attemptId,
        dispatchReservationId: successor.dispatchReservationId,
        target: successor.identity.target,
      })
    );
    const [blocked] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, successor.identity.reviewId));
    expect(blocked.blocked_by_attempt_id).toBe(identity.attemptId);
    mockGetComment.mockResolvedValue({ data: { ...comment, body: 'not-yet-visible' } });
    expect((await callback(payload)).body.fenceReleased).toBe(false);
    expect(mockUpdateComment).toHaveBeenCalledTimes(1);
    expect(mockWakeup).not.toHaveBeenCalled();
    response.resolve({ data: { ...comment } });
    expect((await first).body.fenceReleased).toBe(true);
    expect((await fence()).released_at).not.toBeNull();
    const [next] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, successor.identity.reviewId));
    expect(next).toMatchObject({
      status: 'pending',
      head_sha: 'd'.repeat(40),
      dispatch_reservation_id: null,
    });
    expect(mockWakeup).toHaveBeenCalledTimes(1);
  });

  it('never replays a timed-out write; only exact read evidence releases it', async () => {
    const payload = notice();
    let desired = '';
    mockUpdateComment.mockImplementation(async ({ body }) => {
      desired = body;
      throw new Error('lost response');
    });
    expect((await callback(payload)).body.fenceReleased).toBe(false);
    expect((await callback(payload)).body.fenceReleased).toBe(false);
    expect((await fence()).web_finalization).toBe('uncertain');
    expect(mockUpdateComment).toHaveBeenCalledTimes(1);
    comment = { ...comment, body: desired };
    expect((await callback(payload)).body.fenceReleased).toBe(true);
    expect(mockUpdateComment).toHaveBeenCalledTimes(1);
  });

  it('retries durable queue wakeup after a lost response without replaying publication', async () => {
    const payload = notice();
    mockWakeup.mockRejectedValueOnce(new Error('wakeup unavailable'));
    expect((await callback(payload)).body.fenceReleased).toBe(false);
    expect((await fence()).released_at).not.toBeNull();
    expect((await fence()).queue_wakeup_at).toBeNull();
    expect((await callback(payload)).body.fenceReleased).toBe(true);
    expect(mockUpdateComment).toHaveBeenCalledTimes(1);
    expect(mockUpdateCheck).toHaveBeenCalledTimes(1);
    expect(mockWakeup).toHaveBeenCalledTimes(2);
  });

  it.each(['retained', 'redacted'] as const)(
    'recovers a released %s attempt with the dispatch freshness options',
    async retention => {
      mockWakeup.mockRejectedValueOnce(new Error('wakeup unavailable'));
      expect((await callback(notice('cancelled'))).body.fenceReleased).toBe(false);
      if (retention === 'redacted')
        await db.transaction(tx => requestIsolateIdentityCleanup(tx, user.id));
      const retained = await fence();
      expect(retained.released_at).not.toBeNull();
      expect(retained.queue_wakeup_at).toBeNull();
      await db
        .update(cloud_agent_code_review_attempts)
        .set({ updated_at: new Date(Date.now() - 60_000).toISOString() })
        .where(
          and(
            eq(cloud_agent_code_review_attempts.id, identity.attemptId),
            eq(cloud_agent_code_review_attempts.code_review_id, identity.reviewId)
          )
        );
      const options = { pendingCreatedAtWindow: cronPendingCodeReviewCreatedAtWindowSql() };
      await recoverQueuedIsolateReviews(options);
      expect(mockWakeup).toHaveBeenNthCalledWith(
        2,
        { type: 'org', id: organizationId, userId: bot.id },
        options
      );
      expect(await fence()).toEqual({
        ...retained,
        queue_wakeup_at: expect.any(String),
        updated_at: expect.any(String),
      });
      await recoverQueuedIsolateReviews(options);
      expect(mockWakeup).toHaveBeenCalledTimes(2);
      expect(mockUpdateCheck).toHaveBeenCalledTimes(1);
      expect(mockUpdateComment).not.toHaveBeenCalled();
    }
  );

  it('does not restore redacted publication JSON after an in-flight queue wakeup', async () => {
    const entered = deferred<void>();
    const resume = deferred<void>();
    mockWakeup.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
    });
    const completion = callback(notice());
    await entered.promise;
    let redacted = await fence();
    try {
      expect(redacted.released_at).not.toBeNull();
      expect(redacted.queue_wakeup_at).toBeNull();
      await db.transaction(tx => requestIsolateIdentityCleanup(tx, user.id));
      redacted = await fence();
      expect(redacted.identity.executionUserId).toBe('deleted');
      expect(redacted.terminal_result).toBeNull();
      expect(redacted.usage_settlement).toBeNull();
      expect(redacted.gate_authorization).toBeNull();
      expect(redacted.web_publications.every(operation => operation.body === undefined)).toBe(true);
    } finally {
      resume.resolve();
    }
    expect((await completion).body.fenceReleased).toBe(true);
    expect(await fence()).toEqual({
      ...redacted,
      queue_wakeup_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(mockWakeup).toHaveBeenCalledTimes(1);
    expect(mockUpdateCheck).toHaveBeenCalledTimes(1);
    expect(mockUpdateComment).toHaveBeenCalledTimes(1);
  });

  it('accepts superseded-holder safety without changing a successor or publishing', async () => {
    const payload = notice('cancelled', 2);
    if (!payload.result) throw new Error('Missing result');
    payload.result.sessions[0].requestCount = 1;
    await insertUsage(identity.attemptId, 100);
    payload.safety.publication = 'uncertain';
    payload.safety.quiescent = false;
    await updateCodeReviewStatus(identity.reviewId, 'cancelled', { terminalReason: 'superseded' });
    const successor = await candidate('d'.repeat(40));
    expect((await callback(payload)).body.fenceReleased).toBe(false);
    expect(
      (await callback({ ...payload, safety: { ...payload.safety, sequence: 1 } })).body
        .fenceReleased
    ).toBe(false);
    expect((await callback(notice('running', 3))).status).toBe(409);
    const safe = {
      ...payload,
      safety: { ...payload.safety, sequence: 3, publication: 'settled', quiescent: true },
    };
    expect((await callback(safe)).body.fenceReleased).toBe(true);
    expect((await review()).terminal_reason).toBe('superseded');
    expect((await review()).total_cost_musd).toBeNull();
    expect((await fence()).canonical_settled_at).toBeNull();
    expect((await fence()).usage_settlement).toEqual({ totals: null });
    expect(mockUpdateCheck).not.toHaveBeenCalled();
    expect(mockUpdateComment).not.toHaveBeenCalled();
    expect(await acquireIsolatePublicationFence(successor)).toMatchObject({ outcome: 'acquired' });
    expect((await callback(safe)).body.fenceReleased).toBe(true);
    const [next] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, successor.identity.reviewId));
    expect(next.status).toBe('queued');
    const nextFence = await fence(successor.identity);
    expect(nextFence.safety).toBeNull();
    expect(nextFence.released_at).toBeNull();
  });

  it('suppresses an old holder after a new attempt is created on the same review', async () => {
    const next = await createCodeReviewAttempt({ codeReviewId: identity.reviewId });
    expect((await callback(notice('failed'))).body.fenceReleased).toBe(true);
    expect((await review()).status).toBe('queued');
    const [attempt] = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.id, next.id));
    expect(attempt.status).toBe('pending');
    expect(mockUpdateCheck).not.toHaveBeenCalled();
  });

  it('aggregates root and child billing only within execution user, organization and time bounds', async () => {
    const child = crypto.randomUUID();
    const payload = notice();
    if (!payload.result) throw new Error('Missing result');
    payload.result.sessions[0].requestCount = 1;
    payload.result.sessions.push({
      sessionId: child,
      parentSessionId: identity.attemptId,
      requestCount: 1,
    });
    const within = new Date(Date.now() - 1000).toISOString();
    for (const row of [
      { session: identity.attemptId, user: user.id, org: organizationId, at: within, tokens: 100 },
      { session: child, user: user.id, org: organizationId, at: within, tokens: 200 },
      { session: child, user: 'other-user', org: organizationId, at: within, tokens: 1000 },
      { session: child, user: user.id, org: crypto.randomUUID(), at: within, tokens: 1000 },
      {
        session: child,
        user: user.id,
        org: organizationId,
        at: '2020-01-01T00:00:00Z',
        tokens: 1000,
      },
      {
        session: child,
        user: user.id,
        org: organizationId,
        at: new Date(Date.now() + 60_000).toISOString(),
        tokens: 1000,
      },
      {
        session: crypto.randomUUID(),
        user: user.id,
        org: organizationId,
        at: within,
        tokens: 1000,
      },
    ]) {
      const id = crypto.randomUUID();
      usageIds.push(id);
      await db.insert(microdollar_usage).values({
        id,
        kilo_user_id: row.user,
        organization_id: row.org,
        created_at: row.at,
        input_tokens: row.tokens,
        output_tokens: 10,
        cache_hit_tokens: 5,
        cache_write_tokens: 5,
        cost: row.tokens,
        model: 'fixture/model',
      });
      await db
        .insert(microdollar_usage_metadata)
        .values({ id, message_id: id, session_id: row.session, created_at: row.at });
    }
    expect((await callback(payload)).body.fenceReleased).toBe(true);
    expect(await review()).toMatchObject({
      total_tokens_in: 300,
      total_tokens_out: 20,
      total_cost_musd: 300,
      session_id: null,
      cli_session_id: null,
    });
    expect(comment.body).toContain('Input: 280');
    expect(comment.body).toContain('Output: 20');
    expect(comment.body).toContain('Cached: 20');
  });

  async function insertUsage(
    sessionId: string,
    tokens: number,
    at = new Date().toISOString(),
    model: string | null = 'fixture/model'
  ) {
    const id = crypto.randomUUID();
    const classifier = model === 'auto-routing/classifier';
    usageIds.push(id);
    await db.insert(microdollar_usage).values({
      id,
      kilo_user_id: user.id,
      organization_id: organizationId,
      created_at: at,
      input_tokens: classifier ? 0 : tokens,
      output_tokens: classifier ? 0 : 10,
      cache_hit_tokens: classifier ? 0 : 5,
      cache_write_tokens: classifier ? 0 : 5,
      cost: tokens,
      model,
    });
    await db.insert(microdollar_usage_metadata).values({
      id,
      message_id: id,
      session_id: sessionId,
      created_at: at,
    });
  }

  it('counts inference separately from classifier overhead while retaining all costs', async () => {
    const payload = notice();
    if (!payload.result) throw new Error('Missing result');
    const child = crypto.randomUUID();
    payload.result.sessions[0].requestCount = 1;
    payload.result.sessions.push({
      sessionId: child,
      parentSessionId: identity.attemptId,
      requestCount: 1,
    });
    for (const session of [identity.attemptId, child]) {
      await insertUsage(session, 100);
      await insertUsage(session, 7, undefined, 'auto-routing/classifier');
    }
    expect((await callback(payload)).body).toMatchObject({
      usageSettled: true,
      fenceReleased: true,
    });
    expect(await review()).toMatchObject({
      total_tokens_in: 200,
      total_tokens_out: 20,
      total_cost_musd: 214,
    });
    expect((await fence()).usage_settlement).toEqual({
      totals: { tokensIn: 200, tokensOut: 20, cacheHit: 10, cacheWrite: 10, cost: 214 },
    });
    expect(comment.body).toContain('Input: 180');
    expect(comment.body).toContain('Output: 20');
    expect((await callback(payload)).body.usageSettled).toBe(true);
    expect(mockUpdateComment).toHaveBeenCalledTimes(1);
  });

  it('does not mistake classifier rows for missing inference billing', async () => {
    const payload = notice();
    if (!payload.result) throw new Error('Missing result');
    payload.result.sessions[0].requestCount = 2;
    await insertUsage(identity.attemptId, 7, undefined, 'auto-routing/classifier');
    await insertUsage(identity.attemptId, 100);
    expect((await callback(payload)).body).toMatchObject({
      usageSettled: false,
      fenceReleased: true,
    });
    expect((await fence()).usage_settlement).toBeNull();
    expect((await review()).total_cost_musd).toBeNull();
    await insertUsage(identity.attemptId, 9, undefined, 'auto-routing/classifier');
    expect((await callback(payload)).body.usageSettled).toBe(false);
    await insertUsage(identity.attemptId, 200, undefined, null);
    expect((await callback(payload)).body.usageSettled).toBe(true);
    expect(await review()).toMatchObject({
      total_tokens_in: 300,
      total_tokens_out: 20,
      total_cost_musd: 316,
    });
  });

  it('leaves classifier-only billing incomplete until inference arrives or the deadline expires', async () => {
    const payload = notice('failed');
    if (!payload.result) throw new Error('Missing result');
    payload.result.sessions[0].requestCount = 1;
    await insertUsage(identity.attemptId, 7, undefined, 'auto-routing/classifier');
    expect((await callback(payload)).body).toMatchObject({
      usageSettled: false,
      fenceReleased: true,
    });
    const deadline = new Date(payload.result.completedAt).getTime() + 24 * 60 * 60 * 1000;
    jest.spyOn(Date, 'now').mockReturnValue(deadline);
    expect((await callback(payload)).body.usageSettled).toBe(true);
    expect((await fence()).usage_settlement).toEqual({
      totals: null,
      unavailableReason: 'billing_incomplete',
    });
    expect((await review()).total_cost_musd).toBeNull();
  });

  it.each(['complete', 'delayed', 'replacement_attempt'] as const)(
    'recovers %s usage after pre-recorded ordinary cancellation without changing canonical outcome',
    async delivery => {
      await updateCodeReviewStatus(identity.reviewId, 'cancelled', {
        terminalReason: 'user_cancelled',
      });
      const cancelled = await review();
      const payload = notice('completed');
      if (!payload.result) throw new Error('Missing result');
      const child = crypto.randomUUID();
      payload.result.sessions[0].requestCount = 1;
      payload.result.sessions.push({
        sessionId: child,
        parentSessionId: identity.attemptId,
        requestCount: 1,
      });
      await insertUsage(identity.attemptId, 100);
      if (delivery === 'complete') await insertUsage(child, 200);
      expect((await callback(payload)).body).toMatchObject({
        fenceReleased: true,
        usageSettled: delivery === 'complete',
      });
      expect((await fence()).canonical_settled_at).not.toBeNull();
      expect(await review()).toMatchObject({
        status: 'cancelled',
        terminal_reason: 'user_cancelled',
        completed_at: cancelled.completed_at,
        total_cost_musd: delivery === 'complete' ? 300 : null,
      });
      const [attempt] = await db
        .select()
        .from(cloud_agent_code_review_attempts)
        .where(eq(cloud_agent_code_review_attempts.id, identity.attemptId));
      expect(attempt).toMatchObject({
        status: 'cancelled',
        terminal_reason: 'user_cancelled',
        completed_at: cancelled.completed_at,
      });
      const [ledger] = await db
        .select()
        .from(operation_ledgers)
        .where(eq(operation_ledgers.operation_key, `review:${identity.reviewId}`));
      expect(ledger.status).toBe('no_op');
      const checkpoint = (await fence()).canonical_settled_at;
      const successor = await candidate(
        'd'.repeat(40),
        delivery === 'replacement_attempt' ? 43 : 42
      );
      const [next] = await db
        .select()
        .from(cloud_agent_code_reviews)
        .where(eq(cloud_agent_code_reviews.id, successor.identity.reviewId));
      if (delivery === 'replacement_attempt') {
        await createCodeReviewAttempt({ codeReviewId: identity.reviewId });
        await db
          .update(cloud_agent_code_reviews)
          .set({ status: 'queued', total_cost_musd: 777 })
          .where(eq(cloud_agent_code_reviews.id, identity.reviewId));
      }
      const beforeRecovery = await review();
      if (delivery !== 'complete') await insertUsage(child, 200);
      expect((await callback(payload)).body).toMatchObject({
        fenceReleased: true,
        usageSettled: true,
      });
      expect((await callback(payload)).body.usageSettled).toBe(true);
      if (delivery === 'replacement_attempt') expect(await review()).toEqual(beforeRecovery);
      else
        expect(await review()).toMatchObject({
          status: 'cancelled',
          terminal_reason: 'user_cancelled',
          completed_at: cancelled.completed_at,
          total_cost_musd: 300,
        });
      expect((await fence()).canonical_settled_at).toBe(checkpoint);
      expect(
        (
          await db
            .select()
            .from(cloud_agent_code_reviews)
            .where(eq(cloud_agent_code_reviews.id, next.id))
        )[0]
      ).toEqual(next);
      expect(
        await db
          .select()
          .from(code_review_analytics_results)
          .where(eq(code_review_analytics_results.code_review_id, identity.reviewId))
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(analytics_event_outbox)
          .where(
            and(
              eq(analytics_event_outbox.distinct_id, user.google_user_email),
              eq(analytics_event_outbox.event_name, 'code_review_settled')
            )
          )
      ).toHaveLength(1);
      expect(mockUpdateComment).not.toHaveBeenCalled();
      expect(mockUpdateCheck).toHaveBeenCalledTimes(1);
      expect(check.conclusion).toBe('cancelled');
      expect(mockWakeup).toHaveBeenCalledTimes(1);
    }
  );

  it('recovers delayed root and child billing after release without replaying publication or changing a successor', async () => {
    const payload = notice();
    if (!payload.result) throw new Error('Missing result');
    const child = crypto.randomUUID();
    payload.result.completedAt = new Date(Date.now() - 30_000).toISOString();
    payload.result.sessions[0].requestCount = 2;
    payload.result.sessions.push({
      sessionId: child,
      parentSessionId: identity.attemptId,
      requestCount: 1,
    });
    expect((await callback(payload)).body).toMatchObject({
      fenceReleased: true,
      usageSettled: false,
    });
    expect(await review()).toMatchObject({
      status: 'completed',
      total_cost_musd: null,
      total_tokens_in: null,
    });
    expect((await fence()).usage_settlement).toBeNull();
    expect(comment.body).not.toContain('Input:');
    const successor = await candidate('d'.repeat(40));
    expect(await acquireIsolatePublicationFence(successor)).toMatchObject({ outcome: 'acquired' });
    const [next] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, successor.identity.reviewId));
    comment.body = '<!-- kilo-review -->\nSuccessor summary';
    await insertUsage(identity.attemptId, 100);
    expect((await callback(payload)).body.usageSettled).toBe(false);
    expect((await review()).total_cost_musd).toBeNull();
    await insertUsage(child, 200);
    expect((await callback(payload)).body.usageSettled).toBe(false);
    expect((await review()).total_cost_musd).toBeNull();
    await insertUsage(identity.attemptId, 50);
    const responses = await Promise.all([callback(payload), callback(payload)]);
    expect(responses.every(response => response.body.usageSettled === true)).toBe(true);
    expect(await review()).toMatchObject({
      total_tokens_in: 350,
      total_tokens_out: 30,
      total_cost_musd: 350,
      session_id: null,
      cli_session_id: null,
    });
    expect((await fence()).usage_settlement?.totals?.cost).toBe(350);
    expect(mockUpdateComment).toHaveBeenCalledTimes(1);
    expect(mockUpdateCheck).toHaveBeenCalledTimes(1);
    expect(mockWakeup).toHaveBeenCalledTimes(1);
    expect(comment.body).toBe('<!-- kilo-review -->\nSuccessor summary');
    expect(
      (
        await db
          .select()
          .from(cloud_agent_code_reviews)
          .where(eq(cloud_agent_code_reviews.id, next.id))
      )[0]
    ).toEqual(next);
    expect(
      await db
        .select()
        .from(code_review_analytics_results)
        .where(eq(code_review_analytics_results.code_review_id, identity.reviewId))
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(analytics_event_outbox)
        .where(
          and(
            eq(analytics_event_outbox.distinct_id, user.google_user_email),
            eq(analytics_event_outbox.event_name, 'code_review_settled')
          )
        )
    ).toHaveLength(1);
  });

  it.each(['execution_deadline', 'cancelled'] as const)(
    'settles earlier root and child usage after a proven unsent request and %s',
    async reason => {
      const child = crypto.randomUUID();
      const generated = updateQueuedSafety({
        runId: identity.attemptId,
        status: 'error',
        input: {},
        terminationReason: reason,
        completedAt: new Date().toISOString(),
        requestIds: [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()],
        usageRequestCounts: { [identity.attemptId]: 1, [child]: 1 },
        taskSessions: [{ sessionId: child, parentSessionId: identity.attemptId }],
        queued: {
          identity,
          admitted: true,
          cancellationRequested: reason === 'cancelled',
          callback: { url: 'https://app.kilo.ai', token: 'a'.repeat(64) },
          maintenanceScheduleId: 'fixture',
          operations: [
            {
              id: crypto.randomUUID(),
              kind: 'summary',
              fingerprint: 'b'.repeat(64),
              state: 'sent',
            },
          ],
          safety: notice('running').safety,
          acknowledgedSequence: 0,
          fenceReleased: false,
          cleaned: false,
        },
      });
      const payload = generated.queued.pendingNotification;
      if (!payload?.result) throw new Error('Missing Worker terminal evidence');
      await insertUsage(identity.attemptId, 100);
      expect((await callback(payload)).body).toMatchObject({
        usageSettled: false,
        fenceReleased: false,
      });
      await insertUsage(child, 200);
      expect((await callback(payload)).body).toMatchObject({
        usageSettled: true,
        fenceReleased: false,
      });
      expect(await review()).toMatchObject({
        total_cost_musd: 300,
        total_tokens_in: 300,
        session_id: null,
        cli_session_id: null,
      });
      expect((await fence()).released_at).toBeNull();
      expect(mockWakeup).not.toHaveBeenCalled();
      const resolved = {
        ...payload,
        safety: {
          ...payload.safety,
          sequence: payload.safety.sequence + 1,
          publication: 'settled',
          quiescent: true,
        },
      };
      expect((await callback(resolved)).body).toMatchObject({
        usageSettled: true,
        fenceReleased: true,
      });
      expect((await callback(resolved)).body.usageSettled).toBe(true);
      expect(mockWakeup).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['uncertain', 'settled'] as const)(
    'ends incomplete billing recovery at the query deadline without relaxing %s publication evidence',
    async publication => {
      const payload = notice('cancelled');
      if (!payload.result) throw new Error('Missing result');
      payload.result.sessions[0].requestCount = 2;
      payload.safety.publication = publication;
      payload.safety.quiescent = publication === 'settled';
      await insertUsage(identity.attemptId, 100);
      expect((await callback(payload)).body).toMatchObject({
        usageSettled: false,
        fenceReleased: publication === 'settled',
      });
      expect((await review()).total_cost_musd).toBeNull();
      const deadline = new Date(payload.result.completedAt).getTime() + 24 * 60 * 60 * 1000;
      const clock = jest.spyOn(Date, 'now').mockReturnValue(deadline - 1);
      expect((await callback(payload)).body.usageSettled).toBe(false);
      clock.mockReturnValue(deadline);
      expect((await callback(payload)).body).toMatchObject({
        usageSettled: true,
        fenceReleased: publication === 'settled',
      });
      expect((await fence()).usage_settlement).toEqual({
        totals: null,
        unavailableReason: 'billing_incomplete',
      });
      expect((await review()).total_cost_musd).toBeNull();
      await insertUsage(identity.attemptId, 200, new Date(deadline + 1).toISOString());
      expect((await callback(payload)).body.usageSettled).toBe(true);
      expect((await review()).total_cost_musd).toBeNull();
      if (publication === 'uncertain') {
        expect((await fence()).released_at).toBeNull();
        expect(mockWakeup).not.toHaveBeenCalled();
        payload.safety = {
          ...payload.safety,
          sequence: 2,
          publication: 'settled',
          quiescent: true,
        };
        expect((await callback(payload)).body).toMatchObject({
          usageSettled: true,
          fenceReleased: true,
        });
      }
      expect(mockWakeup).toHaveBeenCalledTimes(1);
    }
  );

  it('does not present extra root records as a missing child or mutate a replacement attempt during usage recovery', async () => {
    const payload = notice();
    if (!payload.result) throw new Error('Missing result');
    const child = crypto.randomUUID();
    payload.result.sessions[0].requestCount = 1;
    payload.result.sessions.push({
      sessionId: child,
      parentSessionId: identity.attemptId,
      requestCount: 1,
    });
    await insertUsage(identity.attemptId, 100);
    await insertUsage(identity.attemptId, 200);
    expect((await callback(payload)).body).toMatchObject({
      usageSettled: false,
      fenceReleased: true,
    });
    expect((await review()).total_cost_musd).toBeNull();
    await createCodeReviewAttempt({ codeReviewId: identity.reviewId });
    await db
      .update(cloud_agent_code_reviews)
      .set({ status: 'queued', total_cost_musd: 999 })
      .where(eq(cloud_agent_code_reviews.id, identity.reviewId));
    await insertUsage(child, 300);
    const next = await review();
    expect((await callback(payload)).body.usageSettled).toBe(true);
    expect(await review()).toEqual(next);
    expect((await fence()).usage_settlement).toEqual({ totals: null });
  });

  it('cleans pending usage identity after release and never reconstructs it from duplicate notifications', async () => {
    const payload = notice();
    if (!payload.result) throw new Error('Missing result');
    payload.result.sessions[0].requestCount = 1;
    expect((await callback(payload)).body).toMatchObject({
      usageSettled: false,
      fenceReleased: true,
    });
    await db.transaction(tx => requestIsolateIdentityCleanup(tx, user.id));
    await insertUsage(identity.attemptId, 100);
    expect((await callback(payload)).body.usageSettled).toBe(true);
    expect((await fence()).identity.executionUserId).toBe('deleted');
    expect((await fence()).terminal_result).toBeNull();
    expect((await fence()).usage_settlement).toBeNull();
    expect((await review()).total_cost_musd).toBeNull();
  });

  it('rejects an invalid session tree and invalid execution time before settlement', async () => {
    const payload = notice();
    if (!payload.result) throw new Error('Missing result');
    payload.result.sessions.push({
      sessionId: crypto.randomUUID(),
      parentSessionId: crypto.randomUUID(),
    });
    expect((await callback(payload)).status).toBe(400);
    payload.result.sessions.pop();
    payload.result.completedAt = '2020-01-01T00:00:00Z';
    expect((await callback(payload)).status).toBe(409);
    expect((await review()).status).toBe('queued');
  });

  it('denies new work after identity cleanup while authorizing exact read-only reconciliation through the organization bot', async () => {
    const operation = crypto.randomUUID();
    expect((await callback(authority('publish', operation))).body.authorized).toBe(true);
    await db.transaction(tx => requestIsolateIdentityCleanup(tx, user.id));
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'soft-deleted at 2026-09-01T00:00:00Z' })
      .where(eq(kilocode_users.id, user.id));
    expect((await callback(authority())).body.authorized).toBe(false);
    expect((await callback(authority('publish', crypto.randomUUID()))).body.authorized).toBe(false);
    expect((await callback(authority('reconcile', operation))).body).toMatchObject({
      authorized: true,
      reconciliationUserId: bot.id,
    });
    expect((await fence()).identity).toEqual(identity);
    const payload = notice('cancelled');
    expect((await callback(payload)).body.fenceReleased).toBe(true);
    expect((await callback(payload)).body.fenceReleased).toBe(true);
    expect((await fence()).identity.executionUserId).toBe('deleted');
    expect((await fence()).terminal_result).toBeNull();
    expect(mockWakeup).toHaveBeenCalledWith(
      { type: 'org', id: organizationId, userId: bot.id },
      {}
    );
    expect(mockUpdateCheck).not.toHaveBeenCalled();
    expect(mockUpdateComment).not.toHaveBeenCalled();
  });

  it('does not suppress a sent operation using a stale prepared read', async () => {
    const entered = deferred<void>();
    const held = deferred<{ data: typeof comment }>();
    let reads = 0;
    mockGetComment.mockImplementation(async () => {
      reads++;
      if (reads === 2) {
        entered.resolve();
        return held.promise;
      }
      return { data: { ...comment } };
    });
    mockUpdateComment.mockRejectedValue(new Error('ambiguous write'));
    const payload = notice();
    const first = callback(payload);
    await entered.promise;
    expect((await callback(payload)).body.fenceReleased).toBe(false);
    held.resolve({ data: { ...comment, body: `${comment.body}\nConcurrent edit` } });
    expect((await first).body.fenceReleased).toBe(false);
    expect((await fence()).web_publications.find(item => item.kind === 'footer')?.state).toBe(
      'sent'
    );
    expect((await fence()).released_at).toBeNull();
    expect(mockUpdateComment).toHaveBeenCalledTimes(1);
  });

  it('finalizes a server-authorized reused summary without requiring a create-only operation marker', async () => {
    comment.body = '<!-- kilo-review -->\nUpdated legacy summary';
    expect((await callback(notice())).body.fenceReleased).toBe(true);
    expect(mockUpdateComment).toHaveBeenCalledTimes(1);
    expect(comment.body).toContain('Review guidance: REVIEW.md');
  });

  it.each(['edited', 'foreign', 'missing', 'wrong-pr', 'wrong-app'])(
    'suppresses a never-sent footer when its exact summary is %s',
    async kind => {
      const payload = notice();
      if (kind === 'edited') comment.body += '\nUser edit';
      if (kind === 'foreign') comment.user = { login: 'other', type: 'User' };
      if (kind === 'missing') mockGetComment.mockRejectedValue({ status: 404 });
      if (kind === 'wrong-pr')
        comment.issue_url = 'https://api.github.com/repos/acme/widget/issues/43';
      if (kind === 'wrong-app') comment.performed_via_github_app = { id: 999 };
      expect((await callback(payload)).body.fenceReleased).toBe(true);
      expect(mockUpdateComment).not.toHaveBeenCalled();
    }
  );

  it('preserves an existing canonical cancellation and settles its attempt and ledger', async () => {
    await updateCodeReviewStatus(identity.reviewId, 'cancelled', { terminalReason: 'superseded' });
    expect((await callback(notice('cancelled'))).body.fenceReleased).toBe(true);
    const [attempt] = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.id, identity.attemptId));
    expect(attempt).toMatchObject({ status: 'cancelled', terminal_reason: 'superseded' });
    const [ledger] = await db
      .select()
      .from(operation_ledgers)
      .where(eq(operation_ledgers.operation_key, `review:${identity.reviewId}`));
    expect(ledger.status).toBe('superseded');
    expect(mockUpdateCheck).not.toHaveBeenCalled();
    expect(mockUpdateComment).not.toHaveBeenCalled();
  });

  it('resumes provider preparation after a transient read failure', async () => {
    const payload = notice();
    mockGetComment.mockRejectedValueOnce(new Error('read unavailable'));
    expect((await callback(payload)).body.fenceReleased).toBe(false);
    expect((await review()).status).toBe('completed');
    expect((await fence()).web_publications).toHaveLength(0);
    expect(await resumeQueuedIsolateFinalization(identity)).toBe(true);
    expect(mockUpdateComment).toHaveBeenCalledTimes(1);
  });
});
