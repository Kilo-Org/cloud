/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CodeReviewOrchestrator } from '../../src/code-review-orchestrator';
import {
  buildGitHubCloudReviewSkillCue,
  GITHUB_CLOUD_REVIEW_SKILL_NAME,
} from '../../src/github-cloud-review-skill';
import {
  BITBUCKET_CLOUD_REVIEW_SKILL_NAME,
  buildBitbucketCloudReviewSkillCue,
} from '../../src/bitbucket-cloud-review-skill';
import type { CodeReview, Owner, SessionInput } from '../../src/types';
import { deriveCallbackToken } from '@kilocode/worker-utils';

function getReviewStub(name = `review-${crypto.randomUUID()}`) {
  const id = env.CODE_REVIEW_ORCHESTRATOR.idFromName(name);
  return env.CODE_REVIEW_ORCHESTRATOR.get(id);
}

function sessionInput(): SessionInput {
  return {
    gitUrl: 'https://example.test/repo.git',
    prompt: 'Review this pull request',
    mode: 'code',
    model: 'test-model',
    upstreamBranch: 'main',
  };
}

function gitlabSessionInput(): SessionInput {
  return {
    ...sessionInput(),
    gitUrl: 'https://gitlab.example.test/acme/repo.git',
    platform: 'gitlab',
  };
}

function githubSessionInput(): SessionInput {
  return {
    githubRepo: 'acme/repo',
    githubToken: 'test-github-token',
    prompt: 'Review this pull request',
    mode: 'code',
    model: 'test-model',
    upstreamBranch: 'main',
    platform: 'github',
  };
}

const BITBUCKET_ORGANIZATION_ID = '123e4567-e89b-12d3-a456-426614174099';

function bitbucketSessionInput(): SessionInput {
  return {
    gitUrl: 'https://bitbucket.org/acme/repo.git',
    prompt: 'Review this pull request',
    mode: 'code',
    model: 'test-model',
    upstreamBranch: 'feature/review-me',
    platform: 'bitbucket',
    kilocodeOrganizationId: BITBUCKET_ORGANIZATION_ID,
    bitbucketWorkspaceUuid: 'a07d5c40-2d2d-4e79-a812-6a47824a77d6',
    bitbucketWorkspaceSlug: 'acme',
    bitbucketRepositoryUuid: '38a47a32-cb87-4a9f-b75d-7224774bba77',
    bitbucketRepositorySlug: 'repo',
    bitbucketIntegrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
    bitbucketPullRequestId: 42,
    bitbucketExpectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
  };
}

function codeReview(overrides: Partial<CodeReview> = {}): CodeReview {
  return {
    reviewId: `review-${crypto.randomUUID()}`,
    authToken: 'test-auth-token',
    sessionInput: sessionInput(),
    owner: {
      type: 'user',
      id: 'user-id',
      userId: 'user-id',
    },
    status: 'queued',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function workerAuthHeaders(): HeadersInit {
  return { Authorization: `Bearer ${env.BACKEND_AUTH_TOKEN}` };
}

function postReview(
  sessionInput: SessionInput,
  owner: Owner,
  reviewId = crypto.randomUUID()
): Promise<Response> {
  return SELF.fetch('https://worker.test/review', {
    method: 'POST',
    headers: { ...workerAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reviewId,
      authToken: 'test-auth-token',
      sessionInput,
      owner,
      agentVersion: 'v2',
    }),
  });
}

function organizationOwner(id = BITBUCKET_ORGANIZATION_ID): Owner {
  return { type: 'org', id, userId: 'user-id' };
}

function personalOwner(): Owner {
  return { type: 'user', id: 'user-id', userId: 'user-id' };
}

function trpcSuccess(data: unknown): Response {
  return Response.json({ result: { data } });
}

function trpcError(
  status: number,
  message: string,
  code = 'INTERNAL_SERVER_ERROR',
  data: Record<string, unknown> = {}
): Response {
  return Response.json(
    {
      error: {
        message,
        code: -32603,
        data: {
          code,
          httpStatus: status,
          path: 'prepareSession',
          ...data,
        },
      },
    },
    { status }
  );
}

function mockSuccessfulCloudAgentNextRun() {
  const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
    const url = String(request);
    if (url.includes('/api/internal/code-review-status/')) {
      return Response.json({ success: true });
    }
    if (url.includes('/trpc/prepareSession')) {
      return trpcSuccess({ cloudAgentSessionId: 'agent-fresh', kiloSessionId: 'ses_fresh' });
    }
    if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
      return trpcSuccess({ executionId: 'exec-fresh', status: 'running' });
    }

    return new Response('unexpected fetch', { status: 500 });
  });
  globalThis.fetch = fetchMock;
  return fetchMock;
}

function fetchCalls(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return fetchMock.mock.calls.filter(([request]) => String(request).includes(path));
}

function hasFetchCall(fetchMock: ReturnType<typeof vi.fn>, path: string): boolean {
  return fetchCalls(fetchMock, path).length > 0;
}

function getFetchCall(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return fetchCalls(fetchMock, path).at(0);
}

function lastStatusUpdateBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const statusCalls = fetchCalls(fetchMock, '/api/internal/code-review-status/');
  const lastCall = statusCalls.at(-1);
  expect(lastCall).toBeDefined();

  const init = lastCall?.[1] as RequestInit | undefined;
  expect(init?.body).toEqual(expect.any(String));
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

async function storedReview(stub: DurableObjectStub<CodeReviewOrchestrator>) {
  return runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) =>
    state.storage.get<CodeReview>('state')
  );
}

async function storedAlarm(stub: DurableObjectStub<CodeReviewOrchestrator>) {
  return runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) =>
    state.storage.getAlarm()
  );
}

const AUTO_RETRY_MIN_DELAY_MS = 2 * 60_000;
const AUTO_RETRY_MAX_DELAY_MS = 5 * 60_000;
const AUTO_RETRY_ALARM_UPPER_SLACK_MS = 1_000;

function expectAutoRetryAlarmInRange(alarm: number | null, retrySchedulingStartedAt: number) {
  expect(alarm).toEqual(expect.any(Number));
  if (alarm === null) {
    throw new Error('Expected auto-retry alarm to be scheduled');
  }
  expect(alarm).toBeGreaterThanOrEqual(retrySchedulingStartedAt + AUTO_RETRY_MIN_DELAY_MS);
  expect(alarm).toBeLessThanOrEqual(
    Date.now() + AUTO_RETRY_MAX_DELAY_MS + AUTO_RETRY_ALARM_UPPER_SLACK_MS
  );
}

async function expectAutoRetryScheduled(
  stub: DurableObjectStub<CodeReviewOrchestrator>,
  retrySchedulingStartedAt: number
) {
  await expect(storedReview(stub)).resolves.toMatchObject({
    status: 'queued',
    sandboxRetryAttempted: true,
  });

  const alarm = await storedAlarm(stub);
  expectAutoRetryAlarmInRange(alarm, retrySchedulingStartedAt);
}

async function expectPrepareFailureSchedulesFreshRetry(
  firstPrepareResponse: () => Response,
  retrySessionId: string,
  retryCliSessionId: string
) {
  const stub = getReviewStub();
  let prepareCalls = 0;
  const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
    const url = String(request);
    if (url.includes('/api/internal/code-review-status/')) {
      return Response.json({ success: true });
    }
    if (url.includes('/trpc/prepareSession')) {
      prepareCalls += 1;
      if (prepareCalls === 1) {
        return firstPrepareResponse();
      }
      return trpcSuccess({
        cloudAgentSessionId: retrySessionId,
        kiloSessionId: retryCliSessionId,
      });
    }
    if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
      return trpcSuccess({ executionId: `exec-${retrySessionId}`, status: 'running' });
    }
    return new Response('unexpected fetch', { status: 500 });
  });
  globalThis.fetch = fetchMock;

  await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
    await state.storage.put('state', codeReview());
    await state.storage.setAlarm(Date.now() + 30_000);
  });

  const retrySchedulingStartedAt = Date.now();
  const ran = await runDurableObjectAlarm(stub);

  expect(ran).toBe(true);
  await expect(stub.status()).resolves.toMatchObject({ status: 'queued' });
  expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
  expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
  await expectAutoRetryScheduled(stub, retrySchedulingStartedAt);

  const retryRan = await runDurableObjectAlarm(stub);
  expect(retryRan).toBe(true);
  await expect(stub.status()).resolves.toMatchObject({
    status: 'running',
    sessionId: retrySessionId,
    cliSessionId: retryCliSessionId,
  });
  expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(2);
  expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(1);
  await expect(storedReview(stub)).resolves.toMatchObject({
    sandboxRetryAttempted: true,
    status: 'running',
    sessionId: retrySessionId,
    cliSessionId: retryCliSessionId,
  });
}

describe('CodeReviewOrchestrator recovery', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('start arms a fallback alarm for a queued review', async () => {
    const stub = getReviewStub();

    await stub.start({
      reviewId: crypto.randomUUID(),
      authToken: 'test-auth-token',
      sessionInput: sessionInput(),
      owner: { type: 'user', id: 'user-id', userId: 'user-id' },
    });

    const alarm = await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) =>
      state.storage.getAlarm()
    );

    expect(alarm).toEqual(expect.any(Number));
    expect(alarm).toBeGreaterThan(Date.now());
  });

  it('status route returns DO status and 404s when no state exists', async () => {
    const missingId = crypto.randomUUID();
    const missingResponse = await SELF.fetch(`https://worker.test/reviews/${missingId}/status`, {
      headers: workerAuthHeaders(),
    });
    expect(missingResponse.status).toBe(404);

    const removedEventsResponse = await SELF.fetch(
      `https://worker.test/reviews/${missingId}/events`,
      { headers: workerAuthHeaders() }
    );
    expect(removedEventsResponse.status).toBe(404);

    const reviewId = crypto.randomUUID();
    const stub = getReviewStub(reviewId);
    await stub.start({
      reviewId,
      authToken: 'test-auth-token',
      sessionInput: sessionInput(),
      owner: { type: 'user', id: 'user-id', userId: 'user-id' },
    });

    const response = await SELF.fetch(`https://worker.test/reviews/${reviewId}/status`, {
      headers: workerAuthHeaders(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      reviewId,
      status: expect.stringMatching(/queued|running/),
    });
  });

  it('POST /review uses attempt-specific durable object names and ignores obsolete version input', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchMock = mockSuccessfulCloudAgentNextRun();
    const reviewId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();

    const response = await SELF.fetch('https://worker.test/review', {
      method: 'POST',
      headers: { ...workerAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reviewId,
        attemptId,
        authToken: 'test-auth-token',
        sessionInput: sessionInput(),
        owner: { type: 'user', id: 'user-id', userId: 'user-id' },
        agentVersion: 'obsolete',
        repositorySize: '100 MB',
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ reviewId, attemptId, status: 'queued' });

    const statusResponse = await SELF.fetch(
      `https://worker.test/reviews/${reviewId}/status?attemptId=${attemptId}`,
      { headers: workerAuthHeaders() }
    );
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      reviewId,
      attemptId,
      status: expect.stringMatching(/queued|running/),
    });

    const prepareCall = getFetchCall(fetchMock, '/trpc/prepareSession');
    const prepareBody = JSON.parse(String(prepareCall?.[1]?.body));
    const expectedCallbackToken = await deriveCallbackToken({
      secret: env.CALLBACK_TOKEN_SECRET,
      scope: 'code-review-status-callback',
      resourceParts: [reviewId, attemptId],
    });
    const statusUpdateCall = getFetchCall(fetchMock, '/api/internal/code-review-status/');
    const statusUpdateInit = statusUpdateCall?.[1] as RequestInit | undefined;
    expect(statusUpdateInit?.headers).toMatchObject({ 'X-Callback-Token': expectedCallbackToken });
    expect(statusUpdateInit?.headers).not.toHaveProperty('X-Internal-Secret');
    expect(prepareBody.callbackTarget).toMatchObject({
      url: expect.stringContaining(`attemptId=${attemptId}`),
      headers: { 'X-Callback-Token': expectedCallbackToken },
    });
    expect(prepareBody.callbackTarget.headers).not.toHaveProperty('X-Internal-Secret');
    expect(prepareBody).not.toHaveProperty('repositorySize');
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '[CodeReviewOrchestrator] Session prepared',
      expect.objectContaining({
        reviewId,
        attemptId,
        cloudAgentSessionId: 'agent-fresh',
        kiloSessionId: 'ses_fresh',
        repositorySize: '100 MB',
        repositorySizeKnown: true,
      })
    );
  });

  it('attaches the trusted GitHub Cloud Review skill to GitHub prepareSession calls', async () => {
    const fetchMock = mockSuccessfulCloudAgentNextRun();
    const reviewId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const originalPrompt = 'Review this pull request';

    const response = await SELF.fetch('https://worker.test/review', {
      method: 'POST',
      headers: { ...workerAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reviewId,
        attemptId,
        authToken: 'test-auth-token',
        sessionInput: {
          ...githubSessionInput(),
          prompt: originalPrompt,
          runtimeSkills: [{ name: 'caller-skill', rawMarkdown: 'untrusted caller skill' }],
        },
        owner: { type: 'user', id: 'user-id', userId: 'user-id' },
        agentVersion: 'v2',
      }),
    });

    expect(response.status).toBe(202);
    await SELF.fetch(`https://worker.test/reviews/${reviewId}/status?attemptId=${attemptId}`, {
      headers: workerAuthHeaders(),
    });

    const prepareCall = getFetchCall(fetchMock, '/trpc/prepareSession');
    const prepareBody = JSON.parse(String(prepareCall?.[1]?.body));
    const expectedCue = buildGitHubCloudReviewSkillCue(reviewId);

    expect(prepareBody.runtimeSkills).toHaveLength(1);
    expect(prepareBody.runtimeSkills[0]).toMatchObject({
      name: GITHUB_CLOUD_REVIEW_SKILL_NAME,
      rawMarkdown: expect.any(String),
    });
    expect(prepareBody.runtimeSkills[0]).not.toHaveProperty('files');

    const rawMarkdown = String(prepareBody.runtimeSkills[0].rawMarkdown);
    expect(rawMarkdown).toContain('---\nname: github-cloud-review');
    expect(rawMarkdown).toContain(
      'line: null is outdated even when legacy position remains numeric'
    );
    expect(rawMarkdown).toContain('Every list read uses --paginate');
    expect(rawMarkdown).toContain('current HEAD');
    expect(rawMarkdown).toContain('one atomic call only');
    expect(rawMarkdown).toContain('trusted existing Kilo summary ID');
    expect(rawMarkdown).toContain('fix link and verify it ends with the current review ID');

    expect(prepareBody.prompt).toBe(`${expectedCue}\n\n${originalPrompt}`);
    expect(prepareBody.prompt).toContain(`The current review ID is ${reviewId}`);
    expect(prepareBody.prompt).not.toContain('untrusted caller skill');
  });

  it('POST /review rejects incomplete Bitbucket review context', async () => {
    const input = bitbucketSessionInput();
    delete input.bitbucketExpectedHeadSha;

    const response = await postReview(input, organizationOwner());

    expect(response.status).toBe(400);
  });

  it.each([
    { name: 'personal owner', owner: personalOwner() },
    {
      name: 'organization owner ID mismatch',
      owner: organizationOwner('223e4567-e89b-12d3-a456-426614174099'),
    },
  ])('POST /review rejects Bitbucket requests with $name', async ({ owner }) => {
    mockSuccessfulCloudAgentNextRun();

    const response = await postReview(bitbucketSessionInput(), owner);

    expect(response.status).toBe(400);
  });

  it('POST /review rejects a caller-supplied Bitbucket git token', async () => {
    mockSuccessfulCloudAgentNextRun();
    const input = bitbucketSessionInput();
    input.gitToken = 'caller-supplied-token';

    const response = await postReview(input, organizationOwner());

    expect(response.status).toBe(400);
  });

  it('POST /review accepts valid organization-owned Bitbucket context', async () => {
    const fetchMock = mockSuccessfulCloudAgentNextRun();

    const response = await postReview(bitbucketSessionInput(), organizationOwner());

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(1);
    });
  });

  it('attaches only the trusted Bitbucket Cloud Review skill and managed review context', async () => {
    const fetchMock = mockSuccessfulCloudAgentNextRun();
    const reviewId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const originalPrompt = 'Review this pull request';
    const bitbucketInput = bitbucketSessionInput();

    const response = await SELF.fetch('https://worker.test/review', {
      method: 'POST',
      headers: { ...workerAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reviewId,
        attemptId,
        authToken: 'test-auth-token',
        sessionInput: {
          ...bitbucketInput,
          runtimeSkills: [{ name: 'caller-skill', rawMarkdown: 'untrusted caller skill' }],
        },
        owner: organizationOwner(),
        agentVersion: 'v2',
      }),
    });

    expect(response.status).toBe(202);
    await SELF.fetch(`https://worker.test/reviews/${reviewId}/status?attemptId=${attemptId}`, {
      headers: workerAuthHeaders(),
    });

    const prepareCall = getFetchCall(fetchMock, '/trpc/prepareSession');
    const prepareBody = JSON.parse(String(prepareCall?.[1]?.body));
    if (!bitbucketInput.bitbucketPullRequestId || !bitbucketInput.bitbucketExpectedHeadSha) {
      throw new Error('Expected complete Bitbucket review context');
    }
    const expectedCue = buildBitbucketCloudReviewSkillCue(
      reviewId,
      bitbucketInput.bitbucketPullRequestId,
      bitbucketInput.bitbucketExpectedHeadSha
    );

    expect(prepareBody).toMatchObject({
      platform: 'bitbucket',
      gitUrl: bitbucketInput.gitUrl,
      kilocodeOrganizationId: bitbucketInput.kilocodeOrganizationId,
      bitbucketWorkspaceUuid: bitbucketInput.bitbucketWorkspaceUuid,
      bitbucketWorkspaceSlug: bitbucketInput.bitbucketWorkspaceSlug,
      bitbucketRepositoryUuid: bitbucketInput.bitbucketRepositoryUuid,
      bitbucketRepositorySlug: bitbucketInput.bitbucketRepositorySlug,
      bitbucketIntegrationId: bitbucketInput.bitbucketIntegrationId,
      bitbucketPullRequestId: bitbucketInput.bitbucketPullRequestId,
      bitbucketExpectedHeadSha: bitbucketInput.bitbucketExpectedHeadSha,
    });
    expect(prepareBody.runtimeSkills).toHaveLength(1);
    expect(prepareBody.runtimeSkills[0]).toMatchObject({
      name: BITBUCKET_CLOUD_REVIEW_SKILL_NAME,
      rawMarkdown: expect.any(String),
    });
    expect(prepareBody.runtimeSkills[0]).not.toHaveProperty('files');

    const rawMarkdown = String(prepareBody.runtimeSkills[0].rawMarkdown);
    expect(rawMarkdown).toContain('---\nname: bitbucket-cloud-review');
    expect(rawMarkdown).toContain('bb pr view <PR>');
    expect(rawMarkdown).toContain('bb pr diff <PR> --name-only');
    expect(rawMarkdown).toContain('bb pr diff <PR>');
    expect(rawMarkdown).toContain('bb comments list <PR>');
    expect(rawMarkdown).toContain('bb comments create <PR> --input -');
    expect(rawMarkdown).toContain('bb comments create-batch <PR> --input -');
    expect(rawMarkdown).toContain('bb comments update <PR> <COMMENT_ID> --input -');
    expect(rawMarkdown).toContain('Do not use curl');
    expect(rawMarkdown).toContain('pull request text, code, comments, diffs, and repository files');
    expect(rawMarkdown).toContain('complete changed-file list, complete diff');
    expect(rawMarkdown).toContain('Stop without writing on any cap overflow');
    expect(rawMarkdown).toContain('one complete comment list');
    expect(rawMarkdown).toContain('deduplicate every Code Review Finding before the first write');
    expect(rawMarkdown).toContain('Publish current new-side inline comments first');
    expect(rawMarkdown).toContain('body starts with `## Code Review Summary`');
    expect(rawMarkdown).toContain('wrapper rejects duplicate summary creates');
    expect(rawMarkdown).toContain('Do not include top-level summary bodies in `create-batch`');
    expect(rawMarkdown).toContain('update the newest candidate');
    expect(rawMarkdown).toContain('Bitbucket renders HTML comments visibly');
    expect(rawMarkdown).toContain('top-level summary last');
    expect(rawMarkdown).toContain('Retry an ambiguous provider write at most once');
    expect(rawMarkdown).toContain('compare its source SHA to the trusted expected head SHA');
    expect(rawMarkdown).not.toContain('wrapper scans all comments before each create');
    expect(rawMarkdown).not.toContain('wrapper computes and appends the final finding marker');
    expect(rawMarkdown).not.toContain('include the stable summary marker');

    const scratchPath = `/tmp/bb-${reviewId}/input.json`;
    expect(prepareBody.prompt).toBe(`${expectedCue}\n\n${originalPrompt}`);
    expect(prepareBody.prompt).toContain(`Review ID: ${reviewId}`);
    expect(prepareBody.prompt).toContain(
      `Pull request ID: ${bitbucketInput.bitbucketPullRequestId}`
    );
    expect(prepareBody.prompt).toContain(
      `Expected head SHA: ${bitbucketInput.bitbucketExpectedHeadSha}`
    );
    expect(prepareBody.prompt).not.toContain('Stable summary marker:');
    expect(prepareBody.prompt).not.toContain('<!-- kilo-review:bitbucket');
    expect(prepareBody.prompt).toContain(`Scratch JSON path: ${scratchPath}`);
    expect(prepareBody.prompt).toContain(
      `bb pr diff ${bitbucketInput.bitbucketPullRequestId} --name-only`
    );
    expect(prepareBody.prompt).toContain(
      `bb comments create-batch ${bitbucketInput.bitbucketPullRequestId} --input - < ${scratchPath}`
    );
    expect(prepareBody.prompt).toContain(
      `bb comments create ${bitbucketInput.bitbucketPullRequestId} --input - < ${scratchPath}`
    );
    expect(prepareBody.prompt).not.toContain('Integration ID:');
    expect(prepareBody.prompt).not.toContain('Finding marker inputs:');
    expect(prepareBody.prompt).not.toContain('BITBUCKET_TOKEN');
    expect(prepareBody.prompt).not.toContain('untrusted caller skill');
  });

  it('prepares fresh GitLab code-review sessions without selector transport', async () => {
    const fetchMock = mockSuccessfulCloudAgentNextRun();
    const reviewId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const originalPrompt = 'Review this pull request';

    const response = await SELF.fetch('https://worker.test/review', {
      method: 'POST',
      headers: { ...workerAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reviewId,
        attemptId,
        authToken: 'test-auth-token',
        sessionInput: {
          ...gitlabSessionInput(),
          prompt: originalPrompt,
          runtimeSkills: [{ name: 'caller-skill', rawMarkdown: 'untrusted caller skill' }],
        },
        owner: { type: 'user', id: 'user-id', userId: 'user-id' },
      }),
    });

    expect(response.status).toBe(202);
    await SELF.fetch(`https://worker.test/reviews/${reviewId}/status?attemptId=${attemptId}`, {
      headers: workerAuthHeaders(),
    });
    const prepareCall = getFetchCall(fetchMock, '/trpc/prepareSession');
    const prepareBody = JSON.parse(String(prepareCall?.[1]?.body));
    expect(prepareBody).toMatchObject({ platform: 'gitlab' });
    expect(prepareBody.prompt).toBe(originalPrompt);
    expect(prepareBody.prompt).not.toContain(GITHUB_CLOUD_REVIEW_SKILL_NAME);
    expect(prepareBody).not.toHaveProperty('runtimeSkills');
    expect(prepareBody).not.toHaveProperty('gitlabCodeReviewTokenRef');
  });

  it('fresh attempt dispatch does not reuse failed state from an earlier attempt', async () => {
    mockSuccessfulCloudAgentNextRun();
    const reviewId = crypto.randomUUID();
    const attemptA = crypto.randomUUID();
    const attemptB = crypto.randomUUID();

    const failedStub = getReviewStub(`${reviewId}:${attemptA}`);
    await runInDurableObject(failedStub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          reviewId,
          attemptId: attemptA,
          status: 'failed',
          errorMessage: 'old failure',
        })
      );
    });

    const response = await SELF.fetch('https://worker.test/review', {
      method: 'POST',
      headers: { ...workerAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reviewId,
        attemptId: attemptB,
        authToken: 'test-auth-token',
        sessionInput: sessionInput(),
        owner: { type: 'user', id: 'user-id', userId: 'user-id' },
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      reviewId,
      attemptId: attemptB,
      status: expect.stringMatching(/queued|running/),
    });

    const failedStatus = await failedStub.status();
    expect(failedStatus).toMatchObject({ reviewId, attemptId: attemptA, status: 'failed' });
    const freshStatusResponse = await SELF.fetch(
      `https://worker.test/reviews/${reviewId}/status?attemptId=${attemptB}`,
      { headers: workerAuthHeaders() }
    );
    await expect(freshStatusResponse.json()).resolves.toMatchObject({
      reviewId,
      attemptId: attemptB,
      status: expect.stringMatching(/queued|running/),
    });
  });

  it('retry-fresh route requires auth', async () => {
    const response = await SELF.fetch(
      `https://worker.test/reviews/${crypto.randomUUID()}/retry-fresh`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'test' }),
      }
    );

    expect(response.status).toBe(401);
  });

  it('retry-fresh starts a fresh session without continuation APIs', async () => {
    const reviewId = crypto.randomUUID();
    const stub = getReviewStub(reviewId);
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcSuccess({
          cloudAgentSessionId: 'agent-retry-fresh',
          kiloSessionId: 'ses_retry_fresh',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-retry-fresh', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          reviewId,
          status: 'running',
          sessionId: 'agent-old',
          cliSessionId: 'ses_old',
          sandboxId: 'sandbox-old',
          previousCloudAgentSessionId: 'agent-previous',
          errorMessage: 'Container shutdown: SIGTERM',
          terminalReason: 'sandbox_error',
        })
      );
    });

    const response = await SELF.fetch(`https://worker.test/reviews/${reviewId}/retry-fresh`, {
      method: 'POST',
      headers: { ...workerAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'agent-old', reason: 'Container shutdown: SIGTERM' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: false, reviewId });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(0);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    expect(fetchCalls(fetchMock, '/trpc/getSessionHealth')).toHaveLength(0);
    expect(fetchCalls(fetchMock, '/trpc/updateSession')).toHaveLength(0);
    expect(fetchCalls(fetchMock, '/trpc/sendMessageV2')).toHaveLength(0);
  });

  it('retry-fresh starts a new retry attempt durable object instead of resetting the failed attempt', async () => {
    const reviewId = crypto.randomUUID();
    const failedAttemptId = crypto.randomUUID();
    const retryAttemptId = crypto.randomUUID();
    const failedStub = getReviewStub(`${reviewId}:${failedAttemptId}`);
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcSuccess({
          cloudAgentSessionId: 'agent-retry-fresh',
          kiloSessionId: 'ses_retry_fresh',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-retry-fresh', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(failedStub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          reviewId,
          attemptId: failedAttemptId,
          status: 'running',
          sessionId: 'agent-old',
          cliSessionId: 'ses_old',
          errorMessage: 'Container shutdown: SIGTERM',
          terminalReason: 'sandbox_error',
          repositorySize: '100 MB',
        })
      );
    });

    const retrySchedulingStartedAt = Date.now();
    const response = await SELF.fetch(`https://worker.test/reviews/${reviewId}/retry-fresh`, {
      method: 'POST',
      headers: { ...workerAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'agent-old',
        reason: 'Container shutdown: SIGTERM',
        failedAttemptId,
        retryAttemptId,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, reviewId });

    const oldStatus = await failedStub.status();
    expect(oldStatus).toMatchObject({ reviewId, attemptId: failedAttemptId, status: 'running' });
    await expect(storedReview(failedStub)).resolves.toMatchObject({ sandboxRetryAttempted: true });

    const retryStub = getReviewStub(`${reviewId}:${retryAttemptId}`);
    await expect(retryStub.status()).resolves.toMatchObject({
      reviewId,
      attemptId: retryAttemptId,
      status: 'queued',
    });
    await expect(storedReview(retryStub)).resolves.toMatchObject({
      repositorySize: '100 MB',
    });
    const retryAlarm = await storedAlarm(retryStub);
    expectAutoRetryAlarmInRange(retryAlarm, retrySchedulingStartedAt);
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(0);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);

    const ranRetry = await runDurableObjectAlarm(retryStub);
    expect(ranRetry).toBe(true);
    await expect(retryStub.status()).resolves.toMatchObject({
      reviewId,
      attemptId: retryAttemptId,
      status: 'running',
      sessionId: 'agent-retry-fresh',
      cliSessionId: 'ses_retry_fresh',
    });
  });

  it('retry-fresh ignores mismatched sessions', async () => {
    const reviewId = crypto.randomUUID();
    const stub = getReviewStub(reviewId);

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          reviewId,
          status: 'running',
          sessionId: 'agent-current',
        })
      );
    });

    const response = await SELF.fetch(`https://worker.test/reviews/${reviewId}/retry-fresh`, {
      method: 'POST',
      headers: { ...workerAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'agent-old', reason: 'Container shutdown: SIGTERM' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: false, reviewId });
    await expect(storedReview(stub)).resolves.toMatchObject({
      status: 'running',
      sessionId: 'agent-current',
    });
  });

  it('retry-fresh ignores exhausted retries', async () => {
    const reviewId = crypto.randomUUID();
    const stub = getReviewStub(reviewId);

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          reviewId,
          status: 'running',
          sessionId: 'agent-current',
          sandboxRetryAttempted: true,
        })
      );
    });

    const response = await SELF.fetch(`https://worker.test/reviews/${reviewId}/retry-fresh`, {
      method: 'POST',
      headers: { ...workerAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'agent-current', reason: 'Container shutdown: SIGTERM' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: false, reviewId });
  });

  it('queued review alarm retries runReview and transitions to running', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcSuccess({
          cloudAgentSessionId: 'agent-test-session',
          kiloSessionId: 'ses_test_session',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-test', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const status = await stub.status();
    expect(status).toMatchObject({
      status: 'running',
      sessionId: 'agent-test-session',
      cliSessionId: 'ses_test_session',
    });
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toBe(true);
  });

  it('retries prepareSession once after a sandbox 500 and initiates the retry session', async () => {
    const stub = getReviewStub();
    let prepareCalls = 0;
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        prepareCalls += 1;
        if (prepareCalls === 1) {
          return trpcError(500, 'SandboxError: HTTP error! status: 500 during setup');
        }
        return trpcSuccess({
          cloudAgentSessionId: 'agent-retry-session',
          kiloSessionId: 'ses_retry_session',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-retry', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const retrySchedulingStartedAt = Date.now();
    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({ status: 'queued' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    await expectAutoRetryScheduled(stub, retrySchedulingStartedAt);

    const retryRan = await runDurableObjectAlarm(stub);
    expect(retryRan).toBe(true);
    const status = await stub.status();
    expect(status).toMatchObject({
      status: 'running',
      sessionId: 'agent-retry-session',
      cliSessionId: 'ses_retry_session',
    });

    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(2);
    const initiateCalls = fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2');
    expect(initiateCalls).toHaveLength(1);

    await expect(storedReview(stub)).resolves.toMatchObject({
      sandboxRetryAttempted: true,
      status: 'running',
      sessionId: 'agent-retry-session',
      cliSessionId: 'ses_retry_session',
    });

    const failedStatusUpdates = fetchCalls(fetchMock, '/api/internal/code-review-status/').filter(
      call => {
        const init = call[1] as RequestInit | undefined;
        if (typeof init?.body !== 'string') return false;
        return (JSON.parse(init.body) as { status?: string }).status === 'failed';
      }
    );
    expect(failedStatusUpdates).toHaveLength(0);
  });

  it('retries prepareSession from a structured workspace mkdir retry marker', async () => {
    const stub = getReviewStub();
    let prepareCalls = 0;
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        prepareCalls += 1;
        if (prepareCalls === 1) {
          return trpcError(
            500,
            'Failed to create workspace directory: FileSystemError: mkdir operation failed with exit code NaN',
            'INTERNAL_SERVER_ERROR',
            { error: 'sandbox_internal_server_error', retryable: true }
          );
        }
        return trpcSuccess({
          cloudAgentSessionId: 'agent-workspace-retry',
          kiloSessionId: 'ses_workspace_retry',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-workspace-retry', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const retrySchedulingStartedAt = Date.now();
    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({ status: 'queued' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    await expectAutoRetryScheduled(stub, retrySchedulingStartedAt);

    const retryRan = await runDurableObjectAlarm(stub);
    expect(retryRan).toBe(true);
    const status = await stub.status();
    expect(status).toMatchObject({
      status: 'running',
      sessionId: 'agent-workspace-retry',
      cliSessionId: 'ses_workspace_retry',
    });

    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(2);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(1);

    await expect(storedReview(stub)).resolves.toMatchObject({
      sandboxRetryAttempted: true,
      status: 'running',
      sessionId: 'agent-workspace-retry',
      cliSessionId: 'ses_workspace_retry',
    });

    const failedStatusUpdates = fetchCalls(fetchMock, '/api/internal/code-review-status/').filter(
      call => {
        const init = call[1] as RequestInit | undefined;
        if (typeof init?.body !== 'string') return false;
        return (JSON.parse(init.body) as { status?: string }).status === 'failed';
      }
    );
    expect(failedStatusUpdates).toHaveLength(0);
  });

  it('retries workspace mkdir prose once by default', async () => {
    const stub = getReviewStub();
    let prepareCalls = 0;
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        prepareCalls += 1;
        if (prepareCalls === 1) {
          return trpcError(
            500,
            'Failed to create workspace directory: FileSystemError: mkdir operation failed with exit code NaN'
          );
        }
        return trpcSuccess({
          cloudAgentSessionId: 'agent-workspace-prose-retry',
          kiloSessionId: 'ses_workspace_prose_retry',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-workspace-prose-retry', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const retrySchedulingStartedAt = Date.now();
    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({ status: 'queued' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    await expectAutoRetryScheduled(stub, retrySchedulingStartedAt);

    const retryRan = await runDurableObjectAlarm(stub);
    expect(retryRan).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({
      status: 'running',
      sessionId: 'agent-workspace-prose-retry',
      cliSessionId: 'ses_workspace_prose_retry',
    });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(2);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(1);
    await expect(storedReview(stub)).resolves.toMatchObject({
      sandboxRetryAttempted: true,
      status: 'running',
      sessionId: 'agent-workspace-prose-retry',
      cliSessionId: 'ses_workspace_prose_retry',
    });
  });

  it.each([
    {
      name: 'workspace admission low disk',
      response: () =>
        trpcError(
          500,
          'Failed to start wrapper: Workspace admission rejected: 1036 MB available below 2048 MB threshold after cleanup'
        ),
      sessionId: 'agent-workspace-admission-retry',
      cliSessionId: 'ses_workspace_admission_retry',
    },
    {
      name: 'git clone timeout',
      response: () => trpcError(500, 'git clone timed out after 600000ms'),
      sessionId: 'agent-git-clone-timeout-retry',
      cliSessionId: 'ses_git_clone_timeout_retry',
    },
    {
      name: 'durable object storage timeout',
      response: () => trpcError(500, 'durable object storage operation exceeded timeout'),
      sessionId: 'agent-do-storage-timeout-retry',
      cliSessionId: 'ses_do_storage_timeout_retry',
    },
  ])(
    'retries prepareSession once after transient $name',
    async ({ response, sessionId, cliSessionId }) => {
      await expectPrepareFailureSchedulesFreshRetry(response, sessionId, cliSessionId);
    }
  );

  it.each([
    {
      name: 'wrapper cleanup blocked',
      response: () => trpcError(500, 'Wrapper cleanup is required before delivery can launch'),
      sessionId: 'agent-wrapper-cleanup-retry',
      cliSessionId: 'ses_wrapper_cleanup_retry',
    },
    {
      name: 'missing git executable',
      response: () => trpcError(500, "ENOENT: no such file or directory, posix_spawn 'git'"),
      sessionId: 'agent-missing-git-retry',
      cliSessionId: 'ses_missing_git_retry',
    },
    {
      name: 'checkout local changes conflict',
      response: () =>
        trpcError(
          500,
          'Failed to checkout pull ref refs/pull/68/head: error: Your local changes to the following files would be overwritten by checkout:\n\tbuild_gui_exe.bat\nPlease commit your changes or stash them before you switch branches.'
        ),
      sessionId: 'agent-checkout-conflict-retry',
      cliSessionId: 'ses_checkout_conflict_retry',
    },
    {
      name: 'session snapshot restore failure',
      response: () =>
        trpcError(500, 'Session snapshot restore failed: kilo import failed exitCode=1'),
      sessionId: 'agent-snapshot-restore-retry',
      cliSessionId: 'ses_snapshot_restore_retry',
    },
    {
      name: 'durable object storage reset',
      response: () =>
        trpcError(
          500,
          'Internal error while starting up Durable Object storage caused object to be reset.'
        ),
      sessionId: 'agent-do-storage-reset-retry',
      cliSessionId: 'ses_do_storage_reset_retry',
    },
  ])('retries prepareSession once after $name', async ({ response, sessionId, cliSessionId }) => {
    await expectPrepareFailureSchedulesFreshRetry(response, sessionId, cliSessionId);
  });

  it('retries prepareSession once after wrapper waitForPort readiness timeout', async () => {
    const stub = getReviewStub();
    let prepareCalls = 0;
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        prepareCalls += 1;
        if (prepareCalls === 1) {
          return trpcError(
            500,
            'Wrapper did not become ready on port 5353 within 30000ms: waitForPort timed out'
          );
        }
        return trpcSuccess({
          cloudAgentSessionId: 'agent-wrapper-timeout-retry',
          kiloSessionId: 'ses_wrapper_timeout_retry',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-wrapper-timeout-retry', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const retrySchedulingStartedAt = Date.now();
    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({ status: 'queued' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    await expectAutoRetryScheduled(stub, retrySchedulingStartedAt);

    const retryRan = await runDurableObjectAlarm(stub);
    expect(retryRan).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({
      status: 'running',
      sessionId: 'agent-wrapper-timeout-retry',
      cliSessionId: 'ses_wrapper_timeout_retry',
    });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(2);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(1);
    await expect(storedReview(stub)).resolves.toMatchObject({ sandboxRetryAttempted: true });
  });

  it('retries prepareSession once after wrapper kilo server startup timeout', async () => {
    const stub = getReviewStub();
    let prepareCalls = 0;
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        prepareCalls += 1;
        if (prepareCalls === 1) {
          return trpcError(
            500,
            'Wrapper did not become ready on port 5353 within 30000ms: waitForPort timed out | wrapperFileLog: failed to start kilo server: Timeout waiting for server to start after 45000ms'
          );
        }
        return trpcSuccess({
          cloudAgentSessionId: 'agent-kilo-startup-retry',
          kiloSessionId: 'ses_kilo_startup_retry',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-kilo-startup-retry', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const retrySchedulingStartedAt = Date.now();
    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({ status: 'queued' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    await expectAutoRetryScheduled(stub, retrySchedulingStartedAt);

    const retryRan = await runDurableObjectAlarm(stub);
    expect(retryRan).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({
      status: 'running',
      sessionId: 'agent-kilo-startup-retry',
      cliSessionId: 'ses_kilo_startup_retry',
    });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(2);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(1);
    await expect(storedReview(stub)).resolves.toMatchObject({ sandboxRetryAttempted: true });
  });

  it('retries prepareSession once after wrapper version mismatch', async () => {
    const stub = getReviewStub();
    let prepareCalls = 0;
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        prepareCalls += 1;
        if (prepareCalls === 1) {
          return trpcError(
            500,
            'Wrapper version mismatch after startup: expected 2.0.0, got 1.9.9'
          );
        }
        return trpcSuccess({
          cloudAgentSessionId: 'agent-wrapper-version-retry',
          kiloSessionId: 'ses_wrapper_version_retry',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-wrapper-version-retry', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const retrySchedulingStartedAt = Date.now();
    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({ status: 'queued' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    await expectAutoRetryScheduled(stub, retrySchedulingStartedAt);

    const retryRan = await runDurableObjectAlarm(stub);
    expect(retryRan).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({
      status: 'running',
      sessionId: 'agent-wrapper-version-retry',
      cliSessionId: 'ses_wrapper_version_retry',
    });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(2);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(1);
    await expect(storedReview(stub)).resolves.toMatchObject({ sandboxRetryAttempted: true });
  });

  it('fails after a second sandbox 500 without initiating', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(500, 'SandboxError: HTTP error! status: 500 during setup');
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const retrySchedulingStartedAt = Date.now();
    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({ status: 'queued' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    await expectAutoRetryScheduled(stub, retrySchedulingStartedAt);

    const retryRan = await runDurableObjectAlarm(stub);
    expect(retryRan).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({
      status: 'failed',
      terminalReason: 'sandbox_error',
    });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(2);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    await expect(storedReview(stub)).resolves.toMatchObject({
      status: 'failed',
      sandboxRetryAttempted: true,
    });
  });

  it('cancels a running review through Cloud Agent Next interruption', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/interruptSession')) {
        return trpcSuccess({ success: true });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({ status: 'running', sessionId: 'agent-running' })
      );
    });

    await expect(stub.cancel('superseded')).resolves.toBe(true);
    await expect(stub.status()).resolves.toMatchObject({
      status: 'cancelled',
      errorMessage: 'Review cancelled: superseded',
    });
    expect(fetchCalls(fetchMock, '/trpc/interruptSession')).toHaveLength(1);
  });

  it('does not retry billing failures from prepareSession', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(402, 'Insufficient credits: $1 minimum required', 'PAYMENT_REQUIRED');
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({ status: 'failed' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    expect(lastStatusUpdateBody(fetchMock)).toMatchObject({
      status: 'failed',
      terminalReason: 'billing',
    });
    await expect(storedReview(stub)).resolves.toMatchObject({
      status: 'failed',
      terminalReason: 'billing',
    });
  });

  it('does not retry cancelled prepareSession body failures', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(500, 'User cancelled during setup');
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({ status: 'failed' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    const stored = await storedReview(stub);
    expect(stored).toMatchObject({ status: 'failed' });
    expect(stored?.sandboxRetryAttempted).toBeUndefined();
  });

  it('does not retry unexpected local prepareSession errors', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        throw new Error('Zod validation failed before request completed');
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({ status: 'failed' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    const stored = await storedReview(stub);
    expect(stored).toMatchObject({ status: 'failed' });
    expect(stored?.sandboxRetryAttempted).toBeUndefined();
  });

  it('does not retry deterministic prepareSession 400 failures', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(400, 'Branch not found: main', 'BAD_REQUEST');
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({ status: 'failed' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    const stored = await storedReview(stub);
    expect(stored).toMatchObject({ status: 'failed' });
    expect(stored?.sandboxRetryAttempted).toBeUndefined();
  });

  it('does not retry unclassified prepareSession 500 failures', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(500, 'Unexpected cloud-agent-next service failure');
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({ status: 'failed' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    const stored = await storedReview(stub);
    expect(stored).toMatchObject({ status: 'failed' });
    expect(stored?.sandboxRetryAttempted).toBeUndefined();
  });

  it('maps selected-model prepareSession 400 failures to action-required terminal reason', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(
          400,
          'Selected model is not available for this cloud agent session',
          'BAD_REQUEST'
        );
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({
      status: 'failed',
      terminalReason: 'selected_model_unavailable',
    });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    expect(lastStatusUpdateBody(fetchMock)).toMatchObject({
      status: 'failed',
      terminalReason: 'selected_model_unavailable',
    });
    await expect(storedReview(stub)).resolves.toMatchObject({
      status: 'failed',
      terminalReason: 'selected_model_unavailable',
    });
  });

  it('maps provider-routing prepareSession failures to action-required terminal reason', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(
          400,
          'Not Found: {"error":"No eligible provider can serve the selected model.","error_type":"provider_not_allowed","message":"No eligible provider can serve the selected model. Select another model or update the provider routing settings."}',
          'BAD_REQUEST'
        );
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({
      status: 'failed',
      terminalReason: 'selected_model_unavailable',
    });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    expect(lastStatusUpdateBody(fetchMock)).toMatchObject({
      status: 'failed',
      terminalReason: 'selected_model_unavailable',
    });
    await expect(storedReview(stub)).resolves.toMatchObject({
      status: 'failed',
      terminalReason: 'selected_model_unavailable',
    });
  });

  it('maps model-not-allowed prepareSession 400 failures to action-required terminal reason', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(
          400,
          'Not Found: The requested model is not allowed for your team.',
          'BAD_REQUEST'
        );
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({
      status: 'failed',
      terminalReason: 'selected_model_unavailable',
    });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    expect(lastStatusUpdateBody(fetchMock)).toMatchObject({
      status: 'failed',
      terminalReason: 'selected_model_unavailable',
    });
  });

  it('does not retry configured-session lookup failures nested in wrapper readiness output', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(
          500,
          'Wrapper did not become ready on port 5353 within 30000ms: waitForPort timed out | wrapperFileLog: configured session ses_missing not found: Session get returned no data for ses_missing'
        );
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({ status: 'failed' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    const stored = await storedReview(stub);
    expect(stored).toMatchObject({ status: 'failed' });
    expect(stored?.sandboxRetryAttempted).toBeUndefined();
  });

  it('does not retry repo-specific checkout failures that surface as prepareSession 500s', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(
          500,
          'SandboxError: HTTP error! status: 500 during setup | Failed to checkout pull ref: Object does not exist on the server'
        );
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({ status: 'failed' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    const stored = await storedReview(stub);
    expect(stored).toMatchObject({ status: 'failed' });
    expect(stored?.sandboxRetryAttempted).toBeUndefined();
  });

  it('always prepares a fresh Bitbucket session instead of continuing a previous session', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_bitbucket_session';
    const fetchMock = mockSuccessfulCloudAgentNextRun();

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          previousCloudAgentSessionId: previousSessionId,
          sessionInput: bitbucketSessionInput(),
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({
      status: 'running',
      sessionId: 'agent-fresh',
      cliSessionId: 'ses_fresh',
    });
    expect(fetchCalls(fetchMock, '/trpc/getSessionHealth')).toHaveLength(0);
    expect(fetchCalls(fetchMock, '/trpc/updateSession')).toHaveLength(0);
    expect(fetchCalls(fetchMock, '/trpc/sendMessageV2')).toHaveLength(0);
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(1);
  });

  it('continues a healthy previous cloud-agent-next session for follow-up reviews', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_session';
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/getSessionHealth')) {
        return trpcSuccess({
          cloudAgentSessionId: previousSessionId,
          sandboxId: 'ses-healthy',
          sandboxStatus: 'healthy',
          executionHealth: 'none',
        });
      }
      if (url.includes('/trpc/updateSession')) {
        return trpcSuccess({ success: true });
      }
      if (url.includes('/trpc/sendMessageV2')) {
        return trpcSuccess({ executionId: 'exec-followup', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          previousCloudAgentSessionId: previousSessionId,
          sessionInput: gitlabSessionInput(),
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const status = await stub.status();
    expect(status).toMatchObject({
      status: 'running',
      sessionId: previousSessionId,
    });
    expect(status.cliSessionId).toBeUndefined();
    expect(hasFetchCall(fetchMock, '/trpc/getSessionHealth')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/updateSession')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/sendMessageV2')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toBe(false);
    const updateCall = getFetchCall(fetchMock, '/trpc/updateSession');
    const updateBody = JSON.parse(String(updateCall?.[1]?.body));
    expect(updateBody).not.toHaveProperty('gitlabCodeReviewTokenRef');
    expect(updateBody).not.toHaveProperty('gitlabCodeReviewRepositoryUrl');
  });

  it('skips continuation and prepares a fresh session when previous sandbox is unreachable', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_unreachable';
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/getSessionHealth')) {
        return trpcSuccess({
          cloudAgentSessionId: previousSessionId,
          sandboxStatus: 'unreachable',
          executionHealth: 'none',
        });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcSuccess({
          cloudAgentSessionId: 'agent-fresh-session',
          kiloSessionId: 'ses_fresh_session',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-fresh', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          previousCloudAgentSessionId: previousSessionId,
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const status = await stub.status();
    expect(status).toMatchObject({
      status: 'running',
      sessionId: 'agent-fresh-session',
      cliSessionId: 'ses_fresh_session',
    });
    expect(hasFetchCall(fetchMock, '/trpc/getSessionHealth')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/updateSession')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/sendMessageV2')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toBe(true);
  });

  it('continues a session when abandoned legacy execution rows are omitted from current health', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_stranded_legacy';
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/'))
        return Response.json({ success: true });
      if (url.includes('/trpc/getSessionHealth')) {
        return trpcSuccess({
          cloudAgentSessionId: previousSessionId,
          sandboxStatus: 'healthy',
          executionHealth: 'none',
        });
      }
      if (url.includes('/trpc/updateSession')) return trpcSuccess({ success: true });
      if (url.includes('/trpc/sendMessageV2')) {
        return trpcSuccess({
          executionId: 'msg_followup',
          status: 'started',
          messageId: 'msg_followup',
          delivery: 'queued',
        });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;
    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({ previousCloudAgentSessionId: previousSessionId })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    await runDurableObjectAlarm(stub);

    expect(hasFetchCall(fetchMock, '/trpc/sendMessageV2')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(false);
  });

  it('skips continuation and prepares a fresh session when previous execution is stale', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_stale';
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/getSessionHealth')) {
        return trpcSuccess({
          cloudAgentSessionId: previousSessionId,
          sandboxStatus: 'healthy',
          executionHealth: 'stale',
          activeExecutionId: 'exec-stale',
        });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcSuccess({
          cloudAgentSessionId: 'agent-fresh-stale',
          kiloSessionId: 'ses_fresh_stale',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-fresh', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          previousCloudAgentSessionId: previousSessionId,
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const status = await stub.status();
    expect(status).toMatchObject({
      status: 'running',
      sessionId: 'agent-fresh-stale',
      cliSessionId: 'ses_fresh_stale',
    });
    expect(hasFetchCall(fetchMock, '/trpc/updateSession')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/sendMessageV2')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(true);
  });

  it('skips continuation and prepares a fresh session when previous execution is active', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_active';
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/getSessionHealth')) {
        return trpcSuccess({
          cloudAgentSessionId: previousSessionId,
          sandboxStatus: 'healthy',
          executionHealth: 'healthy',
          activeExecutionId: 'exec-active',
          activeExecutionStatus: 'running',
        });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcSuccess({
          cloudAgentSessionId: 'agent-fresh-active',
          kiloSessionId: 'ses_fresh_active',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-fresh', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          previousCloudAgentSessionId: previousSessionId,
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const status = await stub.status();
    expect(status).toMatchObject({
      status: 'running',
      sessionId: 'agent-fresh-active',
      cliSessionId: 'ses_fresh_active',
    });
    expect(hasFetchCall(fetchMock, '/trpc/updateSession')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/sendMessageV2')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(true);
  });

  it('falls back to a fresh session when health preflight returns an error', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_missing';
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/getSessionHealth')) {
        return new Response('Session not found', { status: 404 });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcSuccess({
          cloudAgentSessionId: 'agent-fresh-after-error',
          kiloSessionId: 'ses_fresh_after_error',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-fresh', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          previousCloudAgentSessionId: previousSessionId,
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const status = await stub.status();
    expect(status).toMatchObject({
      status: 'running',
      sessionId: 'agent-fresh-after-error',
      cliSessionId: 'ses_fresh_after_error',
    });
    expect(hasFetchCall(fetchMock, '/trpc/getSessionHealth')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/updateSession')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/sendMessageV2')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(true);
  });

  it('falls back to a fresh session when sendMessageV2 fails after healthy preflight', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_send_failure';
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/getSessionHealth')) {
        return trpcSuccess({
          cloudAgentSessionId: previousSessionId,
          sandboxStatus: 'healthy',
          executionHealth: 'none',
        });
      }
      if (url.includes('/trpc/updateSession')) {
        return trpcSuccess({ success: true });
      }
      if (url.includes('/trpc/sendMessageV2')) {
        return new Response('Session not found', { status: 404 });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcSuccess({
          cloudAgentSessionId: 'agent-fresh-after-send-failure',
          kiloSessionId: 'ses_fresh_after_send_failure',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-fresh', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          previousCloudAgentSessionId: previousSessionId,
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const status = await stub.status();
    expect(status).toMatchObject({
      status: 'running',
      sessionId: 'agent-fresh-after-send-failure',
      cliSessionId: 'ses_fresh_after_send_failure',
    });
    expect(hasFetchCall(fetchMock, '/trpc/getSessionHealth')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/updateSession')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/sendMessageV2')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(true);

    const updateCall = getFetchCall(fetchMock, '/trpc/updateSession');
    const updateBody = JSON.parse(String(updateCall?.[1]?.body));
    expect(updateBody).toMatchObject({
      cloudAgentSessionId: previousSessionId,
      callbackTarget: {
        url: expect.stringContaining('/api/internal/code-review-status/'),
        headers: { 'X-Callback-Token': expect.stringMatching(/^[0-9a-f]{64}$/) },
      },
    });
    expect(updateBody.callbackTarget.headers).not.toHaveProperty('X-Internal-Secret');
  });

  it('retries with a fresh session when sendMessageV2 fails with a sandbox 500', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_sandbox_500';
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/getSessionHealth')) {
        return trpcSuccess({
          cloudAgentSessionId: previousSessionId,
          sandboxStatus: 'healthy',
          executionHealth: 'none',
        });
      }
      if (url.includes('/trpc/updateSession')) {
        return trpcSuccess({ success: true });
      }
      if (url.includes('/trpc/sendMessageV2')) {
        return trpcError(500, 'Container failed with internal server error status: 500');
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcSuccess({
          cloudAgentSessionId: 'agent-fresh-after-sandbox-500',
          kiloSessionId: 'ses_fresh_after_sandbox_500',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-fresh-sandbox', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          previousCloudAgentSessionId: previousSessionId,
          sessionId: previousSessionId,
          cliSessionId: 'ses_previous',
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const retrySchedulingStartedAt = Date.now();
    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({ status: 'queued' });
    expect(fetchCalls(fetchMock, '/trpc/getSessionHealth')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/updateSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/sendMessageV2')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(0);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    await expectAutoRetryScheduled(stub, retrySchedulingStartedAt);

    const retryRan = await runDurableObjectAlarm(stub);
    expect(retryRan).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({
      status: 'running',
      sessionId: 'agent-fresh-after-sandbox-500',
      cliSessionId: 'ses_fresh_after_sandbox_500',
    });
    expect(fetchCalls(fetchMock, '/trpc/getSessionHealth')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/updateSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/sendMessageV2')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(1);

    const stored = await storedReview(stub);
    expect(stored).toMatchObject({
      sandboxRetryAttempted: true,
      status: 'running',
      sessionId: 'agent-fresh-after-sandbox-500',
      cliSessionId: 'ses_fresh_after_sandbox_500',
    });
  });

  it('fails with sandbox_error when sendMessageV2 retry also hits a sandbox 500', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_sandbox_repeat';
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/getSessionHealth')) {
        return trpcSuccess({
          cloudAgentSessionId: previousSessionId,
          sandboxStatus: 'healthy',
          executionHealth: 'none',
        });
      }
      if (url.includes('/trpc/updateSession')) {
        return trpcSuccess({ success: true });
      }
      if (url.includes('/trpc/sendMessageV2')) {
        return trpcError(500, 'SandboxError: HTTP error! status: 500 during resume');
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(500, 'SandboxError: HTTP error! status: 500 during setup');
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          previousCloudAgentSessionId: previousSessionId,
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const retrySchedulingStartedAt = Date.now();
    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({ status: 'queued' });
    expect(fetchCalls(fetchMock, '/trpc/sendMessageV2')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(0);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    await expectAutoRetryScheduled(stub, retrySchedulingStartedAt);

    const retryRan = await runDurableObjectAlarm(stub);
    expect(retryRan).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({
      status: 'failed',
      terminalReason: 'sandbox_error',
    });
    expect(fetchCalls(fetchMock, '/trpc/sendMessageV2')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
  });

  it('aborts alarm recovery before cloud-agent calls when DB is already terminal', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({
          success: true,
          message: 'Review already in terminal state',
          currentStatus: 'cancelled',
        });
      }
      return new Response('cloud-agent should not be called', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const status = await stub.status();
    expect(status.status).toBe('cancelled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown DB terminal reasons when DB is already terminal', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({
          success: true,
          message: 'Review already in terminal state',
          currentStatus: 'cancelled',
          terminalReason: 'future_terminal_reason',
        });
      }
      return new Response('cloud-agent should not be called', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const status = await stub.status();
    expect(status.status).toBe('cancelled');
    expect(status.terminalReason).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('terminal cleanup alarm still deletes storage', async () => {
    const stub = getReviewStub();

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          status: 'completed',
          completedAt: new Date().toISOString(),
        })
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const stored = await runInDurableObject(
      stub,
      async (_instance: CodeReviewOrchestrator, state) => state.storage.get('state')
    );
    expect(stored).toBeUndefined();
  });
});
