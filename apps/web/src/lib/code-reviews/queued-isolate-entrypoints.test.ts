const mockErrors = jest.fn();
jest.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockErrors(...args),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
  setTag: jest.fn(),
  startSpan: (_context: unknown, callback: () => unknown) => callback(),
  trpcMiddleware:
    () =>
    ({ next }: { next: () => unknown }) =>
      next(),
}));
const mockFlag = jest.fn();
const mockFlagPayload = jest.fn();
const mockPull = jest.fn();
const mockSummary = jest.fn();
const mockListComments = jest.fn();
const mockComment = jest.fn();
const mockUpdateComment = jest.fn();
const mockLegacySummaryWrite = jest.fn();
const mockCreateCheck = jest.fn();
const mockCheck = jest.fn();
const mockUpdateCheck = jest.fn();
const mockHead = jest.fn();
const mockBitbucketPull = jest.fn();
const mockAfter: Promise<unknown>[] = [];
let mockLocalMode = false;

jest.mock('./client/legacy-code-review-worker-client', () => {
  const previous = process.env.CODE_REVIEW_WORKER_URL;
  process.env.CODE_REVIEW_WORKER_URL = 'https://legacy.test';
  try {
    return jest.requireActual('./client/legacy-code-review-worker-client');
  } finally {
    if (previous === undefined) delete process.env.CODE_REVIEW_WORKER_URL;
    else process.env.CODE_REVIEW_WORKER_URL = previous;
  }
});
jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: (work: Promise<unknown>) => mockAfter.push(work),
}));
jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual('@/lib/config.server'),
  ISOLATE_REVIEW_WORKER_URL: 'https://isolate.test',
  isLocalCodeReviewDevelopmentEnabled: () => mockLocalMode,
  BITBUCKET_CODE_REVIEW_WEBHOOK_SIGNING_KEYS: JSON.stringify({
    active: Buffer.alloc(32, 7).toString('base64'),
  }),
}));
jest.mock('@/lib/posthog', () => ({
  __esModule: true,
  default: () => ({
    getFeatureFlag: (...args: unknown[]) => mockFlag(...args),
    getFeatureFlagPayload: (...args: unknown[]) => mockFlagPayload(...args),
    capture: jest.fn(),
  }),
  shutdownPosthog: jest.fn(),
}));
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    pulls: { get: (...args: unknown[]) => mockPull(...args) },
    repos: {
      compareCommits: async () => ({
        data: { base_commit: { sha: 'b'.repeat(40) }, merge_base_commit: { sha: 'c'.repeat(40) } },
      }),
    },
    issues: {
      listComments: mockListComments,
      getComment: mockComment,
      updateComment: mockUpdateComment,
    },
    checks: { get: mockCheck, update: mockUpdateCheck },
  })),
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: jest.fn().mockResolvedValue({ token: 'fixture-only' }),
  findKiloReviewComment: (...args: unknown[]) => mockSummary(...args),
  updateKiloReviewComment: (...args: unknown[]) => mockLegacySummaryWrite(...args),
  fetchPRInlineComments: jest.fn().mockResolvedValue([]),
  getPRHeadCommit: (...args: unknown[]) => mockHead(...args),
  fetchGitHubRootTextFileAtRef: jest.fn().mockResolvedValue('Check authorization boundaries.'),
  fetchGitHubRepositorySize: jest.fn().mockResolvedValue(null),
  createCheckRun: (...args: unknown[]) => mockCreateCheck(...args),
  updateCheckRun: jest.fn().mockResolvedValue(undefined),
  addReactionToPR: jest.fn().mockResolvedValue(undefined),
  isMergeCommit: jest.fn().mockResolvedValue(false),
}));
jest.mock('@/lib/integrations/platforms/github/app-selector', () => ({
  getGitHubAppCredentials: () => ({ appId: '123' }),
  getGitHubAppName: () => 'KiloConnect',
}));
jest.mock('./isolate-review-model', () => ({
  resolveIsolateReviewInference: async ({
    model,
    thinkingEffort,
  }: {
    model: string;
    thinkingEffort?: string;
  }) => ({
    modelId: model,
    thinkingEffort: thinkingEffort ?? null,
    provider: 'openai-compatible',
    variant: null,
    reasoningSupported: true,
    maxOutputTokens: 8192,
  }),
}));
jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  addReactionToMR: jest.fn().mockResolvedValue(undefined),
  setCommitStatus: jest.fn().mockResolvedValue(undefined),
  isMergeCommit: jest.fn().mockResolvedValue(false),
  findKiloReviewNote: jest.fn().mockResolvedValue(null),
  fetchMRInlineComments: jest.fn().mockResolvedValue([]),
  getMRHeadCommit: (...args: unknown[]) => mockHead(...args),
  getMRDiffRefs: jest.fn().mockResolvedValue({
    baseSha: 'b'.repeat(40),
    startSha: 'c'.repeat(40),
    headSha: 'a'.repeat(40),
  }),
  fetchGitLabRepositorySize: jest.fn().mockResolvedValue(null),
  fetchGitLabRootTextFileAtRef: jest.fn().mockResolvedValue(null),
}));
jest.mock('@/lib/integrations/gitlab-service', () => ({
  getOrCreateProjectAccessToken: jest.fn().mockResolvedValue('fixture-only'),
  getValidGitLabToken: jest.fn().mockResolvedValue('fixture-only'),
}));
jest.mock('@/lib/integrations/platforms/bitbucket/token-service-client', () => ({
  fetchBitbucketPullRequestFromTokenService: (...args: unknown[]) => mockBitbucketPull(...args),
}));

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { deriveCallbackToken, verifyCallbackToken } from '@kilocode/worker-utils/callback-token';
import { db } from '@/lib/drizzle';
import { CALLBACK_TOKEN_SECRET, INTERNAL_API_SECRET } from '@/lib/config.server';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { generateBotUserId } from '@/lib/bot-users/types';
import { POST } from '@/app/api/internal/code-review-status/[reviewId]/route';
import { POST as bitbucketWebhook } from '@/app/api/webhooks/bitbucket/[integrationId]/route';
import { handlePullRequest } from '@/lib/integrations/platforms/github/webhook-handlers/pull-request-handler';
import { handleMergeRequestCodeReview } from '@/lib/integrations/platforms/gitlab/webhook-handlers/merge-request-handler';
import type { MergeRequestPayload } from '@/lib/integrations/platforms/gitlab/webhook-schemas';
import { deriveBitbucketWebhookSecret } from '@/lib/integrations/platforms/bitbucket/webhook-signing';
import { codeReviewRouter } from '@/routers/code-reviews/code-reviews-router';
import {
  agent_configs,
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  organization_memberships,
  organizations,
  platform_integrations,
  kilocode_users,
  type PlatformIntegration,
  type User,
} from '@kilocode/db/schema';
import { createDefaultCodeReviewConfig } from './core/default-config';
import { createManualCodeReviewJob } from './manual-code-review-jobs';
import { createCodeReview, getCodeReviewById, getLatestCodeReviewAttempt } from './db/code-reviews';
import { codeReviewWorkerClient } from './client/code-review-worker-client';
import { tryDispatchPendingReviews } from './dispatch/dispatch-pending-reviews';
import { dispatchPendingCodeReviewOwners } from './dispatch/dispatch-pending-code-review-owners';
import { reapStaleCodeReviews } from './reap-stale-reviews';
import { IsolateReviewRequestSchema } from '@/lib/isolate-review-worker-client';
import {
  QueuedIsolateAdmissionSchema,
  QueuedIsolateIdentitySchema,
  QueuedIsolateControlRequestSchema,
  QueuedIsolateNotificationSchema,
  type QueuedIsolateIdentity,
  type QueuedIsolateSafety,
} from './queued-isolate-contract';
import type { CodeReviewPayload } from './triggers/prepare-review-payload';
import { publicationFromAttempt } from './db/publication-fences';

const REPO = 'acme/queued-entrypoints';
const head = 'a'.repeat(40);
const nextHead = 'd'.repeat(40);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const AdmissionBodySchema = z.object({
  admission: QueuedIsolateAdmissionSchema,
  review: IsolateReviewRequestSchema,
});
type Admission = z.infer<typeof AdmissionBodySchema>;
type Notification = z.infer<typeof QueuedIsolateNotificationSchema>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function safety(overrides: Partial<QueuedIsolateSafety> = {}): QueuedIsolateSafety {
  return {
    sequence: 1,
    execution: 'not_started',
    cancellationRequested: false,
    publication: 'not_started',
    quiescent: false,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function candidateCallback(identity: QueuedIsolateIdentity, body: unknown) {
  const token = await deriveCallbackToken({
    secret: INTERNAL_API_SECRET,
    scope: 'queued-isolate-callback',
    resourceParts: [JSON.stringify(QueuedIsolateIdentitySchema.parse(identity))],
  });
  return POST(
    new NextRequest(
      `http://localhost/api/internal/code-review-status/${identity.reviewId}?backend=isolate&attemptId=${identity.attemptId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Callback-Token': token },
        body: JSON.stringify(body),
      }
    ),
    { params: Promise.resolve({ reviewId: identity.reviewId }) }
  );
}

async function legacyCallback(reviewId: string, attemptId: string, status: string) {
  const token = await deriveCallbackToken({
    secret: CALLBACK_TOKEN_SECRET,
    scope: 'code-review-status-callback',
    resourceParts: [reviewId, attemptId],
  });
  return POST(
    new NextRequest(
      `http://localhost/api/internal/code-review-status/${reviewId}?attemptId=${attemptId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Callback-Token': token },
        body: JSON.stringify({ status }),
      }
    ),
    { params: Promise.resolve({ reviewId }) }
  );
}

function notice(
  identity: QueuedIsolateIdentity,
  state: QueuedIsolateSafety,
  summary: { commentId: number; bodyHash: string } | null = null
): Notification {
  const terminal = ['completed', 'failed', 'cancelled'].includes(state.execution);
  return QueuedIsolateNotificationSchema.parse({
    version: 1,
    identity,
    safety: state,
    ...(terminal
      ? {
          result: {
            reason:
              state.execution === 'completed'
                ? 'completed'
                : state.execution === 'cancelled'
                  ? 'cancelled'
                  : 'admission_failed',
            completedAt: new Date().toISOString(),
            sessions: [{ sessionId: identity.attemptId, parentSessionId: null, requestCount: 0 }],
            summary,
            gateResult: null,
            analytics: { marker: null, omitted: false },
          },
        }
      : {}),
  });
}

async function fenceFor(identity: QueuedIsolateIdentity) {
  const [attempt] = await db
    .select()
    .from(cloud_agent_code_review_attempts)
    .where(eq(cloud_agent_code_review_attempts.id, identity.attemptId));
  const fence = attempt ? publicationFromAttempt(attempt) : null;
  if (!fence) throw new Error('Missing isolate publication');
  expect(fence.generation).toBe(identity.generation);
  return fence;
}

describe('queued entrypoints with real PostgreSQL, dispatch, preparation and authenticated callbacks', () => {
  let user: User;
  let bot: User;
  let organizationId: string;
  let github: PlatformIntegration;
  let personal: PlatformIntegration;
  let gitlab: PlatformIntegration;
  let bitbucket: PlatformIntegration;
  let currentHead: string;
  let rejectControls: boolean;
  let rejectAdmissions: boolean;
  let summaryBody: string | null;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  const admissions: Admission[] = [];
  const legacyDispatches: CodeReviewPayload[] = [];
  const controls: z.infer<typeof QueuedIsolateControlRequestSchema>[] = [];
  const legacyControls: string[] = [];
  const states = new Map<string, QueuedIsolateSafety>();
  const unexpected: string[] = [];
  const repositoryUuid = randomUUID();
  const orgOwner = () => ({ type: 'org' as const, id: organizationId, userId: bot.id });
  const config = () => ({
    ...createDefaultCodeReviewConfig(),
    model_slug: 'fixture/model',
    gate_threshold: 'off' as const,
  });
  const caller = (actor = user) => codeReviewRouter.createCaller({ user: actor });
  const comment = () => ({
    id: 77,
    body: summaryBody ?? '',
    issue_url: `https://api.github.com/repos/${REPO}/issues/42`,
    user: { id: 456, login: 'kiloconnect[bot]', type: 'Bot' },
    performed_via_github_app: { id: 123 },
    updated_at: '2026-09-01T12:00:00.000Z',
  });
  const pull = (number = 42) => ({
    number,
    title: 'Entry point fixture',
    state: 'open',
    draft: false,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    user: {
      id: 123,
      login: 'contributor',
      type: 'User',
      avatar_url: 'https://example.test/avatar',
    },
    head: { sha: currentHead, ref: 'feature', repo: { full_name: REPO } },
    base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: REPO } },
  });

  async function webhook(integration = github, action = 'opened', number = 42) {
    return handlePullRequest(
      {
        action,
        installation: { id: 12345 },
        repository: {
          id: 123,
          name: 'queued-entrypoints',
          full_name: REPO,
          owner: { login: 'acme' },
        },
        pull_request: pull(number),
      },
      integration
    );
  }

  async function pending(number = 42) {
    return createCodeReview({
      owner: orgOwner(),
      platformIntegrationId: github.id,
      platform: 'github',
      repoFullName: REPO,
      prNumber: number,
      prUrl: `https://github.com/${REPO}/pull/${number}`,
      prTitle: 'Pending fixture',
      prAuthor: 'contributor',
      baseRef: 'main',
      headRef: 'feature',
      headSha: currentHead,
      triggerSource: 'manual',
    });
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockLocalMode = false;
    currentHead = head;
    rejectControls = false;
    rejectAdmissions = false;
    summaryBody = null;
    admissions.length = 0;
    legacyDispatches.length = 0;
    controls.length = 0;
    legacyControls.length = 0;
    mockAfter.length = 0;
    unexpected.length = 0;
    states.clear();
    user = await insertTestUser({ id: `oauth/github/entrypoint-${randomUUID()}` });
    const [org] = await db
      .insert(organizations)
      .values({ name: 'Entrypoint fixture', plan: 'enterprise', require_seats: false })
      .returning();
    organizationId = org.id;
    bot = await insertTestUser({
      id: generateBotUserId(organizationId, 'code-review'),
      is_bot: true,
    });
    await db.insert(organization_memberships).values(
      [user, bot].map(actor => ({
        organization_id: organizationId,
        kilo_user_id: actor.id,
        role: 'owner' as const,
      }))
    );
    [github, personal, gitlab, bitbucket] = await db
      .insert(platform_integrations)
      .values([
        {
          owned_by_organization_id: organizationId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: String(Math.floor(Math.random() * 1e12)),
          github_app_type: 'standard',
          integration_status: 'active',
        },
        {
          owned_by_user_id: user.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: String(Math.floor(Math.random() * 1e12)),
          github_app_type: 'standard',
          integration_status: 'active',
        },
        {
          owned_by_organization_id: organizationId,
          platform: 'gitlab',
          integration_type: 'oauth',
          integration_status: 'active',
          metadata: { gitlab_instance_url: 'https://gitlab.com' },
        },
        {
          owned_by_organization_id: organizationId,
          platform: 'bitbucket',
          integration_type: 'workspace_access_token',
          integration_status: 'active',
          platform_account_id: randomUUID(),
          platform_account_login: 'acme',
          repositories: [
            { id: repositoryUuid, name: 'queued-entrypoints', full_name: REPO, private: true },
          ],
        },
      ])
      .returning();
    await db.insert(agent_configs).values([
      ...['github', 'gitlab', 'bitbucket'].map(platform => ({
        owned_by_organization_id: organizationId,
        agent_type: 'code_review',
        platform,
        is_enabled: true,
        created_by: user.id,
        config: {
          ...config(),
          ...(platform === 'bitbucket'
            ? { repository_selection_mode: 'selected', selected_repository_ids: [repositoryUuid] }
            : {}),
        },
      })),
      {
        owned_by_user_id: user.id,
        agent_type: 'code_review',
        platform: 'github',
        is_enabled: true,
        created_by: user.id,
        config: config(),
      },
    ]);
    mockFlag.mockReset().mockResolvedValue(true);
    mockFlagPayload.mockReset().mockResolvedValue({ organizationIds: [organizationId] });
    mockPull
      .mockReset()
      .mockImplementation(async ({ pull_number }) => ({ data: pull(pull_number) }));
    mockHead.mockReset().mockImplementation(async () => currentHead);
    mockSummary
      .mockReset()
      .mockImplementation(async () =>
        summaryBody === null ? null : { commentId: 77, body: summaryBody }
      );
    mockListComments
      .mockReset()
      .mockImplementation(async ({ issue_number }: { issue_number: number }) => ({
        data: summaryBody !== null && issue_number === 42 ? [comment()] : [],
      }));
    mockComment.mockReset().mockImplementation(async () => ({ data: comment() }));
    mockUpdateComment.mockReset().mockImplementation(async ({ body }) => {
      summaryBody = body;
      return { data: comment() };
    });
    mockLegacySummaryWrite.mockReset().mockResolvedValue(undefined);
    mockCreateCheck.mockReset().mockResolvedValue(33);
    mockCheck.mockReset().mockImplementation(async ({ check_run_id }) => ({
      data: {
        id: check_run_id,
        head_sha: head,
        app: { id: 123 },
        status: 'queued',
        conclusion: null,
      },
    }));
    mockUpdateCheck.mockReset().mockImplementation(async ({ check_run_id, ...rest }) => ({
      data: { id: check_run_id, ...rest },
    }));
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (
        url.origin === 'https://api.github.com' &&
        url.pathname.startsWith(`/repos/${REPO}/pulls/`) &&
        (!init?.method || init.method === 'GET')
      )
        return Response.json(pull(Number(url.pathname.split('/').at(-1))));
      if (url.origin === 'https://isolate.test' && url.pathname === '/queued-reviews') {
        const body = AdmissionBodySchema.parse(JSON.parse(String(init?.body)));
        const identity = body.admission.identity;
        expect(new Headers(init?.headers).get('x-internal-api-key') === INTERNAL_API_SECRET).toBe(
          true
        );
        expect(new Headers(init?.headers).has('Authorization')).toBe(true);
        expect((await getLatestCodeReviewAttempt(identity.reviewId))?.reviewer_backend).toBe(
          'isolate'
        );
        const authority = await candidateCallback(identity, {
          version: 1,
          identity,
          preparationHash: body.admission.preparationHash,
          operation: 'execute',
          operationId: identity.attemptId,
        });
        expect(authority.status).toBe(200);
        expect(await authority.json()).toMatchObject({ authorized: true });
        admissions.push(body);
        states.set(identity.attemptId, safety());
        if (rejectAdmissions) throw new Error('Lost admission response');
        return Response.json({ version: 1, identity, safety: states.get(identity.attemptId) });
      }
      if (url.origin === 'https://isolate.test' && url.pathname.endsWith('/control')) {
        const body = QueuedIsolateControlRequestSchema.parse(JSON.parse(String(init?.body)));
        expect(
          await verifyCallbackToken({
            token: new Headers(init?.headers).get('x-isolate-control-token'),
            secret: INTERNAL_API_SECRET,
            scope: 'queued-isolate-control',
            resourceParts: [body.operation, JSON.stringify(body.identity)],
          })
        ).toBe(true);
        expect(new Headers(init?.headers).has('Authorization')).toBe(false);
        controls.push(body);
        if (rejectControls) throw new Error('Isolate control unavailable');
        return Response.json({
          version: 1,
          identity: body.identity,
          safety: states.get(body.identity.attemptId) ?? safety(),
        });
      }
      if (url.origin === 'https://legacy.test') {
        if (url.pathname === '/review' && init?.method === 'POST') {
          const body = JSON.parse(String(init?.body)) as CodeReviewPayload;
          expect((await getLatestCodeReviewAttempt(body.reviewId))?.reviewer_backend).toBe(
            'legacy'
          );
          legacyDispatches.push(body);
          return Response.json({
            reviewId: body.reviewId,
            attemptId: body.attemptId,
            status: 'queued',
          });
        }
        const control = /^\/reviews\/([a-f0-9-]+)\/(cancel|status|retry-fresh)$/.exec(url.pathname);
        if (control && (init?.method ?? 'GET') === (control[2] === 'status' ? 'GET' : 'POST')) {
          legacyControls.push(url.pathname);
          return Response.json({ reviewId: control[1], success: true, status: 'running' });
        }
      }
      unexpected.push(`${init?.method ?? 'GET'} ${url.origin}${url.pathname}`);
      throw new Error('Unexpected external request');
    });
  });

  afterEach(async () => {
    await Promise.all(mockAfter);
    expect(unexpected).toEqual([]);
    fetchSpy.mockRestore();
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, REPO));
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, [user.id, bot.id]));
  });

  it.each([true, false])(
    'routes actual GitHub webhook creation with membership=%s',
    async listed => {
      mockFlagPayload.mockResolvedValue({ organizationIds: listed ? [organizationId] : [] });
      expect((await webhook()).status).toBe(202);
      expect(
        await db
          .select({
            status: cloud_agent_code_reviews.status,
            error: cloud_agent_code_reviews.error_message,
          })
          .from(cloud_agent_code_reviews)
          .where(eq(cloud_agent_code_reviews.repo_full_name, REPO))
      ).toEqual([{ status: 'queued', error: null }]);
      expect(mockErrors.mock.calls.map(([error]) => String(error))).toEqual([]);
      expect(admissions).toHaveLength(listed ? 1 : 0);
      expect(legacyDispatches).toHaveLength(listed ? 0 : 1);
      const reviewId = listed
        ? admissions[0].admission.identity.reviewId
        : legacyDispatches[0].reviewId;
      expect((await getLatestCodeReviewAttempt(reviewId))?.reviewer_backend).toBe(
        listed ? 'isolate' : 'legacy'
      );
    }
  );

  it('never exposes embedded publication state or blocker references through public review reads', async () => {
    await webhook();
    const identity = admissions[0].admission.identity;
    const [attempt] = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.id, identity.attemptId));
    if (!attempt.publication_state) throw new Error('Missing isolate publication');
    const body = 'Private retained publication body';
    const digest = 'f'.repeat(64);
    await db
      .update(cloud_agent_code_review_attempts)
      .set({
        publication_state: {
          ...attempt.publication_state,
          identity_digest: digest,
          web_publications: [
            { id: randomUUID(), kind: 'footer', targetId: 77, state: 'prepared', body },
          ],
        },
      })
      .where(eq(cloud_agent_code_review_attempts.id, identity.attemptId));

    for (const role of ['owner', 'admin', 'member'] as const) {
      await db
        .update(organization_memberships)
        .set({ role })
        .where(
          and(
            eq(organization_memberships.organization_id, organizationId),
            eq(organization_memberships.kilo_user_id, user.id)
          )
        );
      const detail = await caller().get({ reviewId: identity.reviewId });
      if (!detail.success) throw new Error('Expected public review detail');
      expect(detail.review).not.toHaveProperty('blocked_by_attempt_id');
      expect(detail.attempts).toHaveLength(1);
      expect(detail.attempts[0]).not.toHaveProperty('publication_state');
      expect(detail.attempts[0].reviewer_execution_id).toBe(
        role === 'member' ? null : identity.attemptId
      );
      for (const internalValue of [body, digest, identity.generation, identity.executionUserId]) {
        expect(JSON.stringify(detail)).not.toContain(internalValue);
      }
      const list = await caller().listForOrganization({ organizationId });
      if (!list.success) throw new Error('Expected public review list');
      expect(list.reviews).toHaveLength(1);
      expect(list.reviews[0]).not.toHaveProperty('blocked_by_attempt_id');
    }
    const retained = await fenceFor(identity);
    expect(retained.preparation).not.toBeNull();
    expect(retained.identity_digest).toBe(digest);
    expect(retained.web_publications[0].body).toBe(body);
  });

  it('keeps personal GitHub webhook work on legacy without consulting the allowlist', async () => {
    expect((await webhook(personal)).status).toBe(202);
    expect(legacyDispatches).toHaveLength(1);
    expect(admissions).toHaveLength(0);
    expect(mockFlag).not.toHaveBeenCalled();
  });

  it('keeps an allowlisted GitLab webhook on the legacy transport', async () => {
    const payload = {
      object_kind: 'merge_request',
      user: { id: 1, username: 'contributor', name: 'Contributor' },
      project: {
        id: 123,
        path_with_namespace: REPO,
        web_url: `https://gitlab.com/${REPO}`,
        default_branch: 'main',
      },
      object_attributes: {
        id: 456,
        iid: 42,
        title: 'GitLab fixture',
        action: 'open',
        url: `https://gitlab.com/${REPO}/-/merge_requests/42`,
        source_branch: 'feature',
        target_branch: 'main',
        source_project_id: 123,
        target_project_id: 123,
        state: 'opened',
        draft: false,
        work_in_progress: false,
        last_commit: { id: head, message: 'Fixture commit' },
      },
    } as MergeRequestPayload;
    expect((await handleMergeRequestCodeReview(payload, gitlab)).status).toBe(202);
    expect(legacyDispatches).toHaveLength(1);
    expect(legacyDispatches[0].sessionInput).toMatchObject({ platform: 'gitlab' });
    expect((await getLatestCodeReviewAttempt(legacyDispatches[0].reviewId))?.reviewer_backend).toBe(
      'legacy'
    );
    expect(admissions).toHaveLength(0);
    expect(mockFlag).not.toHaveBeenCalled();
  });

  it('keeps an authenticated allowlisted Bitbucket webhook on legacy and deduplicates delivery', async () => {
    const workspaceUuid = bitbucket.platform_account_id;
    if (!workspaceUuid) throw new Error('Missing workspace');
    mockBitbucketPull.mockResolvedValue({
      success: true,
      pullRequest: {
        id: 42,
        title: 'Bitbucket fixture',
        state: 'OPEN',
        draft: false,
        author: { displayName: 'Contributor', uuid: randomUUID() },
        url: `https://bitbucket.org/${REPO}/pull-requests/42`,
        updatedOn: new Date().toISOString(),
        source: { sha: head, branch: 'feature', repositoryUuid, repositoryFullName: REPO },
        destination: {
          sha: 'b'.repeat(40),
          branch: 'main',
          repositoryUuid,
          repositoryFullName: REPO,
        },
      },
    });
    const raw = JSON.stringify({
      repository: { uuid: repositoryUuid, workspace: { uuid: workspaceUuid } },
      pullrequest: { id: 42 },
    });
    const secret = deriveBitbucketWebhookSecret(Buffer.alloc(32, 7), {
      integrationId: bitbucket.id,
      workspaceUuid,
    });
    const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    const headers = {
      'Content-Type': 'application/json',
      'x-hook-uuid': randomUUID(),
      'x-request-uuid': randomUUID(),
      'x-event-key': 'pullrequest:created',
      'x-hub-signature': signature,
    };
    const request = () =>
      new NextRequest(`http://localhost/api/webhooks/bitbucket/${bitbucket.id}`, {
        method: 'POST',
        headers,
        body: raw,
      });
    const first = await bitbucketWebhook(request(), {
      params: Promise.resolve({ integrationId: bitbucket.id }),
    });
    expect(first.status).toBe(202);
    expect(legacyDispatches).toHaveLength(1);
    expect(legacyDispatches[0].sessionInput).toMatchObject({
      platform: 'bitbucket',
      bitbucketExpectedHeadSha: head,
    });
    expect((await getLatestCodeReviewAttempt(legacyDispatches[0].reviewId))?.reviewer_backend).toBe(
      'legacy'
    );
    expect(
      (
        await bitbucketWebhook(request(), {
          params: Promise.resolve({ integrationId: bitbucket.id }),
        })
      ).status
    ).toBe(200);
    expect(legacyDispatches).toHaveLength(1);
    expect(mockBitbucketPull).toHaveBeenCalledTimes(1);
    expect(admissions).toHaveLength(0);
    expect(mockFlag).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'action-required', 'unselected-repository'] as const)(
    'retains the webhook %s gate before selection',
    async gate => {
      await db
        .update(agent_configs)
        .set({
          is_enabled: gate !== 'disabled',
          ...(gate === 'action-required'
            ? {
                runtime_state: {
                  code_review_action_required: {
                    reason: 'byok_invalid_key',
                    detectedAt: minutesAgo(10),
                    lastSeenAt: minutesAgo(9),
                    lastErrorMessage: 'Fixture invalid key',
                  },
                },
              }
            : {}),
          ...(gate === 'unselected-repository'
            ? {
                config: {
                  ...config(),
                  repository_selection_mode: 'selected',
                  selected_repository_ids: [999],
                },
              }
            : {}),
        })
        .where(
          and(
            eq(agent_configs.owned_by_organization_id, organizationId),
            eq(agent_configs.platform, 'github')
          )
        );
      expect((await webhook()).status).toBe(200);
      expect(admissions).toHaveLength(0);
      expect(legacyDispatches).toHaveLength(0);
      expect(mockFlag).not.toHaveBeenCalled();
    }
  );

  it('denies cancellation and retrigger by a nonmember without touching either transport', async () => {
    await webhook();
    const identity = admissions[0].admission.identity;
    const stranger = await insertTestUser();
    try {
      await expect(caller(stranger).cancel({ reviewId: identity.reviewId })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      await expect(
        caller(stranger).retrigger({ reviewId: identity.reviewId })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(controls).toHaveLength(0);
      expect(legacyControls).toHaveLength(0);
      expect((await getLatestCodeReviewAttempt(identity.reviewId))?.id).toBe(identity.attemptId);
    } finally {
      await db.delete(kilocode_users).where(eq(kilocode_users.id, stranger.id));
    }
  });

  it.each(['provider', 'kilo', 'council'] as const)(
    'routes ordinary manual %s creation through the real dispatcher',
    async mode => {
      mockLocalMode = mode === 'kilo';
      const result = await createManualCodeReviewJob({
        owner: orgOwner(),
        input: {
          platform: 'github',
          url: `https://github.com/${REPO}/pull/42`,
          modelSlug: 'fixture/manual-model',
          instructions: 'Check the manual requirement.',
          ...(mode === 'council'
            ? {
                council: {
                  enabled: true,
                  aggregation_strategy: 'advisory',
                  specialists: [
                    {
                      id: 'security',
                      role: 'security',
                      name: 'Security',
                      lens: 'Review security',
                      enabled: true,
                      required: false,
                    },
                    {
                      id: 'correctness',
                      role: 'correctness',
                      name: 'Correctness',
                      lens: 'Review correctness',
                      enabled: true,
                      required: false,
                    },
                  ],
                },
              }
            : {}),
        },
      });
      expect(result.outputMode).toBe(mode === 'kilo' ? 'kilo' : 'provider');
      expect((await getLatestCodeReviewAttempt(result.reviewId))?.reviewer_backend).toBe(
        mode === 'provider' ? 'isolate' : 'legacy'
      );
      expect(admissions).toHaveLength(mode === 'provider' ? 1 : 0);
      expect(legacyDispatches).toHaveLength(mode === 'provider' ? 0 : 1);
      if (mode === 'provider')
        expect(admissions[0].review.preparation?.settings).toMatchObject({
          model: 'fixture/manual-model',
          manualInstructions: 'Check the manual requirement.',
        });
      else expect(mockFlag).not.toHaveBeenCalled();
    }
  );

  it('retries a legacy terminal review as a new isolate attempt without migrating old controls', async () => {
    mockFlag.mockResolvedValue(false);
    await webhook();
    const old = legacyDispatches[0];
    const oldAttempt = await getLatestCodeReviewAttempt(old.reviewId);
    if (!oldAttempt) throw new Error('Missing legacy attempt');
    mockFlag.mockResolvedValue(true);
    await codeReviewWorkerClient.getReviewStatus(old.reviewId, oldAttempt.id);
    await codeReviewWorkerClient.cancelReview(old.reviewId, 'fixture', oldAttempt.id);
    await codeReviewWorkerClient.retryReviewFresh(old.reviewId, {
      failedAttemptId: oldAttempt.id,
      reason: 'fixture',
    });
    expect(admissions).toHaveLength(0);
    expect(legacyControls).toHaveLength(3);
    expect((await legacyCallback(old.reviewId, oldAttempt.id, 'cancelled')).status).toBe(200);
    await Promise.all(mockAfter);
    expect(await caller().retrigger({ reviewId: old.reviewId })).toMatchObject({ success: true });
    expect(admissions).toHaveLength(1);
    expect(admissions[0].admission.identity.attemptId).not.toBe(oldAttempt.id);
    expect(
      (
        await db
          .select()
          .from(cloud_agent_code_review_attempts)
          .where(eq(cloud_agent_code_review_attempts.id, oldAttempt.id))
      )[0].reviewer_backend
    ).toBe('legacy');
    expect((await getLatestCodeReviewAttempt(old.reviewId))?.reviewer_backend).toBe('isolate');
  });

  it('preserves legacy callback dispatch before its held summary write without treating it as quiescence', async () => {
    mockFlag.mockResolvedValue(false);
    await webhook();
    const first = legacyDispatches[0];
    const attempt = await getLatestCodeReviewAttempt(first.reviewId);
    if (!attempt) throw new Error('Missing attempt');
    summaryBody = '<!-- kilo-review -->\nLegacy result';
    const entered = deferred<void>();
    const finish = deferred<void>();
    mockLegacySummaryWrite.mockImplementation(async () => {
      entered.resolve();
      await finish.promise;
    });
    currentHead = nextHead;
    const successorId = await pending(43);
    mockSummary.mockImplementation(async (_installation, _owner, _repo, number) =>
      number === 42 ? { commentId: 77, body: summaryBody } : null
    );
    mockFlag.mockResolvedValue(true);
    const completion = legacyCallback(first.reviewId, attempt.id, 'completed');
    try {
      await entered.promise;
      await Promise.all(mockAfter);
      expect(admissions).toHaveLength(1);
      expect(admissions[0].admission.identity).toMatchObject({
        reviewId: successorId,
        snapshot: { headSha: nextHead },
      });
      expect((await getCodeReviewById(first.reviewId))?.status).toBe('completed');
      expect((await getLatestCodeReviewAttempt(first.reviewId))?.publication_state).toBeNull();
    } finally {
      finish.resolve();
    }
    expect((await completion).status).toBe(200);
  });

  it('drains pending work from a real candidate terminal callback exactly once', async () => {
    await webhook();
    const identity = admissions[0].admission.identity;
    const secondId = await pending(43);
    const notification = notice(identity, safety({ execution: 'failed', quiescent: true }));
    const first = await candidateCallback(identity, notification);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ fenceReleased: true });
    expect(admissions).toHaveLength(2);
    expect(admissions[1].admission.identity.reviewId).toBe(secondId);
    expect((await candidateCallback(identity, notification)).status).toBe(200);
    expect(admissions).toHaveLength(2);
    expect(legacyDispatches).toHaveLength(0);
  });

  it.each([true, false])(
    'keeps a delayed isolate write fenced across webhook supersession and cron with rollout=%s',
    async enabled => {
      await webhook();
      const first = admissions[0];
      const identity = first.admission.identity;
      const operationId = randomUUID();
      const authority = await candidateCallback(identity, {
        version: 1,
        identity,
        preparationHash: first.admission.preparationHash,
        operation: 'publish',
        operationId,
      });
      expect(await authority.json()).toMatchObject({ authorized: true });
      const unresolved = safety({ execution: 'running', publication: 'pending' });
      states.set(identity.attemptId, unresolved);
      expect((await candidateCallback(identity, notice(identity, unresolved))).status).toBe(200);
      const providerResponse = deferred<void>();
      const delayedWrite = providerResponse.promise.then(() => {
        summaryBody = '<!-- kilo-review -->\nLate candidate result';
      });
      rejectControls = true;
      currentHead = nextHead;
      mockFlag.mockResolvedValue(enabled);
      expect((await webhook(github, 'synchronize')).status).toBe(202);
      const [successor] = await db
        .select()
        .from(cloud_agent_code_reviews)
        .where(
          and(
            eq(cloud_agent_code_reviews.repo_full_name, REPO),
            eq(cloud_agent_code_reviews.head_sha, nextHead)
          )
        );
      expect(successor.id).not.toBe(identity.reviewId);
      expect(successor).toMatchObject({ status: 'pending', dispatch_reservation_id: null });
      expect((await getCodeReviewById(identity.reviewId))?.terminal_reason).toBe('superseded');
      expect(
        controls.some(
          control =>
            control.operation === 'cancel' && control.identity.attemptId === identity.attemptId
        )
      ).toBe(true);
      const uncertain = notice(
        identity,
        safety({
          sequence: 2,
          execution: 'cancelled',
          cancellationRequested: true,
          publication: 'uncertain',
        })
      );
      expect(await (await candidateCallback(identity, uncertain)).json()).toMatchObject({
        fenceReleased: false,
      });
      await db
        .update(cloud_agent_code_reviews)
        .set({ created_at: minutesAgo(5000), updated_at: minutesAgo(5000) })
        .where(eq(cloud_agent_code_reviews.id, successor.id));
      await db
        .update(cloud_agent_code_review_attempts)
        .set({ updated_at: minutesAgo(5000) })
        .where(eq(cloud_agent_code_review_attempts.id, identity.attemptId));
      await reapStaleCodeReviews();
      await dispatchPendingCodeReviewOwners();
      await tryDispatchPendingReviews(orgOwner());
      expect((await getCodeReviewById(successor.id))?.status).toBe('pending');
      expect(admissions).toHaveLength(1);
      expect(legacyDispatches).toHaveLength(0);
      expect((await fenceFor(identity)).released_at).toBeNull();
      expect(await (await candidateCallback(identity, uncertain)).json()).toMatchObject({
        fenceReleased: false,
      });
      providerResponse.resolve();
      await delayedWrite;
      const safe = {
        ...uncertain,
        safety: {
          ...uncertain.safety,
          sequence: 3,
          publication: 'settled' as const,
          quiescent: true,
        },
      };
      expect(await (await candidateCallback(identity, safe)).json()).toMatchObject({
        fenceReleased: true,
      });
      await dispatchPendingCodeReviewOwners();
      expect(admissions).toHaveLength(enabled ? 2 : 1);
      expect(legacyDispatches).toHaveLength(enabled ? 0 : 1);
      expect((await getLatestCodeReviewAttempt(successor.id))?.reviewer_backend).toBe(
        enabled ? 'isolate' : 'legacy'
      );
      if (enabled) {
        expect(admissions[1].review.headSha).toBe(nextHead);
        expect(admissions[1].review.preparation?.queued?.summaryTarget?.bodyHash).toBe(
          hash(summaryBody ?? '')
        );
      } else expect(legacyDispatches[0].reviewId).toBe(successor.id);
      const successorBefore = await getCodeReviewById(successor.id);
      expect((await candidateCallback(identity, safe)).status).toBe(200);
      const staleIdentity = { ...identity, generation: randomUUID() };
      expect(
        (await candidateCallback(staleIdentity, { ...safe, identity: staleIdentity })).status
      ).toBe(409);
      expect(await getCodeReviewById(successor.id)).toEqual(successorBefore);
      expect(mockUpdateComment).not.toHaveBeenCalled();
    }
  );

  it.each([true, false])(
    'holds a candidate-owned footer across separate successor rows with rollout=%s',
    async enabled => {
      await db
        .update(agent_configs)
        .set({ config: { ...config(), disable_review_md: false } })
        .where(
          and(
            eq(agent_configs.owned_by_organization_id, organizationId),
            eq(agent_configs.platform, 'github')
          )
        );
      await webhook();
      const identity = admissions[0].admission.identity;
      summaryBody = `<!-- kilo-review -->\nCandidate result\n<!-- kilo-isolate-review-summary:${hash(identity.attemptId)} -->`;
      const entered = deferred<void>();
      const finish = deferred<void>();
      mockUpdateComment.mockImplementation(async ({ body }) => {
        entered.resolve();
        await finish.promise;
        summaryBody = body;
        return { data: comment() };
      });
      const notification = notice(
        identity,
        safety({ execution: 'completed', publication: 'settled', quiescent: true }),
        { commentId: 77, bodyHash: hash(summaryBody) }
      );
      const completion = candidateCallback(identity, notification);
      try {
        await Promise.race([
          entered.promise,
          completion.then(async response => {
            throw new Error(
              `Callback completed before footer: ${response.status} ${JSON.stringify(await response.clone().json())} ${JSON.stringify((await fenceFor(identity)).web_publications)}`
            );
          }),
        ]);
        expect((await getCodeReviewById(identity.reviewId))?.status).toBe('completed');
        expect((await fenceFor(identity)).web_publications).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: 'footer', state: 'sent' })])
        );
        currentHead = nextHead;
        mockFlag.mockResolvedValue(enabled);
        expect((await webhook(github, 'synchronize')).status).toBe(202);
        const duplicate = await candidateCallback(identity, notification);
        expect(await duplicate.json()).toMatchObject({ fenceReleased: false });
        expect(admissions).toHaveLength(1);
        expect(legacyDispatches).toHaveLength(0);
        expect((await fenceFor(identity)).released_at).toBeNull();
      } finally {
        finish.resolve();
      }
      expect(await (await completion).json()).toMatchObject({ fenceReleased: true });
      expect(admissions).toHaveLength(enabled ? 2 : 1);
      expect(legacyDispatches).toHaveLength(enabled ? 0 : 1);
      expect(mockUpdateComment).toHaveBeenCalledTimes(1);
      await dispatchPendingCodeReviewOwners();
      expect(admissions.length + legacyDispatches.length).toBe(2);
    }
  );

  it('does not let an unresolved isolate holder starve an unrelated PR', async () => {
    await webhook();
    const identity = admissions[0].admission.identity;
    rejectControls = true;
    currentHead = nextHead;
    await webhook(github, 'synchronize');
    expect(admissions).toHaveLength(1);
    expect((await webhook(github, 'opened', 43)).status).toBe(202);
    expect(admissions).toHaveLength(2);
    expect(admissions[1].admission.identity.target.prNumber).toBe(43);
    expect((await fenceFor(identity)).released_at).toBeNull();
  });

  it('recovers a lost wakeup beyond the normal cron window using persisted blocker identity', async () => {
    await webhook();
    const identity = admissions[0].admission.identity;
    currentHead = nextHead;
    await webhook(github, 'synchronize');
    const [blocked] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.blocked_by_attempt_id, identity.attemptId));
    await db
      .update(cloud_agent_code_reviews)
      .set({ created_at: minutesAgo(5000), updated_at: minutesAgo(5000) })
      .where(eq(cloud_agent_code_reviews.id, blocked.id));
    const {
      recordIsolatePublicationSafety,
      setIsolateWebFinalization,
      releaseIsolatePublicationFence,
    } = await import('./db/publication-fences');
    await recordIsolatePublicationSafety({
      identity,
      safety: safety({ execution: 'cancelled', cancellationRequested: true, quiescent: true }),
    });
    await setIsolateWebFinalization({ identity, expected: 'pending', state: 'suppressed' });
    expect(await releaseIsolatePublicationFence(identity)).toBe(true);
    expect(admissions).toHaveLength(1);
    await dispatchPendingCodeReviewOwners();
    expect(admissions).toHaveLength(2);
    expect(admissions[1].admission.identity.reviewId).toBe(blocked.id);
    await dispatchPendingCodeReviewOwners();
    expect(admissions).toHaveLength(2);
  });

  it('recovers ambiguous admission and cancellation on pinned isolate affinity after flag removal', async () => {
    rejectAdmissions = true;
    await webhook();
    expect(admissions).toHaveLength(1);
    const identity = admissions[0].admission.identity;
    mockFlag.mockResolvedValue(false);
    await db
      .update(cloud_agent_code_reviews)
      .set({ updated_at: minutesAgo(10) })
      .where(eq(cloud_agent_code_reviews.id, identity.reviewId));
    await db
      .update(cloud_agent_code_review_attempts)
      .set({ updated_at: minutesAgo(1) })
      .where(eq(cloud_agent_code_review_attempts.id, identity.attemptId));
    await dispatchPendingCodeReviewOwners();
    expect(await caller().cancel({ reviewId: identity.reviewId })).toMatchObject({ success: true });
    expect(controls.some(control => control.operation === 'status')).toBe(true);
    expect(controls.some(control => control.operation === 'cancel')).toBe(true);
    expect(admissions).toHaveLength(1);
    expect(legacyDispatches).toHaveLength(0);
    expect(legacyControls).toHaveLength(0);
    expect((await fenceFor(identity)).released_at).toBeNull();
  });
});
