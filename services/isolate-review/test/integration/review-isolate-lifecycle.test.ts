import {
  abortAllDurableObjects,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  reset,
} from 'cloudflare:test';
import { Think, type StepContext, type ThinkSubmissionInspection } from '@cloudflare/think';
import { generateText, type ToolSet, type UIMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admitRepository,
  cloneRepository,
  RepoTooLargeError,
  resolveReviewSnapshot,
} from '../../src/git';
import { resolveIsolateReviewInference } from '../../src/model';
import { resolveGithubCredentials } from '../../src/github-token';
import { buildTaskReviewContext, DEFAULT_MODEL, SYSTEM_PROMPT_VERSION } from '../../src/prompt';
import {
  createGithubTools,
  GITHUB_TOOL_NAMES,
  READ_ONLY_GITHUB_TOOL_NAMES,
} from '../../src/github';
import { MAX_TASK_STEPS } from '../../src/task';
import { createHash } from 'node:crypto';
import type * as GitModule from '../../src/git';
import type * as GithubModule from '../../src/github';
import type * as ModelModule from '../../src/model';
import type * as GithubTokenModule from '../../src/github-token';
import { createReviewPersistence } from '../../src/persistence';
import { ReviewIsolate } from '../../src/review-isolate';
import type {
  IsolateReviewPreparation,
  IsolateReviewSelection,
  RunState,
  StartReviewInput,
} from '../../src/types';

vi.mock('../../src/git', async () => {
  const actual = await vi.importActual<typeof GitModule>('../../src/git');
  return {
    ...actual,
    admitRepository: vi.fn(),
    cloneRepository: vi.fn(),
    resolveReviewSnapshot: vi.fn(),
  };
});

vi.mock('../../src/github', async () => {
  const actual = await vi.importActual<typeof GithubModule>('../../src/github');
  return { ...actual, createGithubTools: vi.fn(actual.createGithubTools) };
});

vi.mock('../../src/model', async () => {
  const actual = await vi.importActual<typeof ModelModule>('../../src/model');
  return { ...actual, resolveIsolateReviewInference: vi.fn() };
});

vi.mock('../../src/github-token', async () => {
  const actual = await vi.importActual<typeof GithubTokenModule>('../../src/github-token');
  return { ...actual, resolveGithubCredentials: vi.fn(actual.resolveGithubCredentials) };
});

const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);
const FIRST_HEAD = 'd'.repeat(40);
const snapshot = { headSha: HEAD_SHA, baseTipSha: BASE_SHA, mergeBaseSha: MERGE_SHA };
const inference = {
  modelId: DEFAULT_MODEL,
  provider: 'openai-compatible' as const,
  thinkingEffort: null,
  variant: null,
  reasoningSupported: false,
  maxOutputTokens: 8_000,
};
const summaryProposal = {
  fingerprint: 'e'.repeat(64),
  bodyHash: 'f'.repeat(64),
  publishable: true,
};
const summaryOwnership = {
  previousRunId: 'prior-run',
  commentId: 9,
  bodyHash: createHash('sha256').update('<!-- kilo-review -->\nExisting summary').digest('hex'),
};
const cleanAnalysis = {
  status: 'running' as const,
  stepCount: 1,
  parentFinishReason: 'stop',
  parentFinished: true,
};
const pullFixture = () => ({
  head: { sha: HEAD_SHA },
  base: { sha: BASE_SHA },
  state: 'open',
  draft: false,
  changed_files: 1,
});
const compareFixture = () => ({
  base_commit: { sha: BASE_SHA },
  merge_base_commit: { sha: MERGE_SHA },
  files: [
    {
      sha: HEAD_SHA,
      filename: 'source.ts',
      status: 'modified',
      additions: 2,
      deletions: 0,
      changes: 2,
      patch: '@@ -0,0 +1,2 @@\n+first\n+second',
    },
  ],
});

function inlineFixture(comment: Record<string, unknown>, id = 1) {
  return {
    id,
    user: { login: 'kilo-code[bot]' },
    subject_type: 'line',
    commit_id: HEAD_SHA,
    pull_request_url: 'https://api.github.com/repos/acme/widget/pulls/42',
    ...comment,
  };
}

const input: StartReviewInput = {
  owner: 'acme',
  repo: 'widget',
  pullNumber: 42,
  userId: 'review-owner',
  gitToken: 'fixture-token',
  kiloToken: 'kilo-token',
  dryRun: false,
};

const baselineSummaryBody = '<!-- kilo-review -->\nPrevious review findings';
const baselineSummary = {
  body: baselineSummaryBody,
  bodyHash: createHash('sha256').update(baselineSummaryBody).digest('hex'),
};
const HISTORY_SHA = '1'.repeat(40);
const HISTORY_PARENT_SHA = '2'.repeat(40);

function preparedReviewInput(
  reviewSelection: IsolateReviewSelection = { requestedMode: 'full', effectiveMode: 'full' }
): StartReviewInput & { preparation: IsolateReviewPreparation } {
  return {
    ...input,
    gitToken: undefined,
    organizationId: 'org-1',
    credentialsExpireAt: Date.now() + 3_600_000,
    ...snapshot,
    dryRun: true,
    model: inference.modelId,
    reviewMode: reviewSelection.requestedMode,
    previousRunId: reviewSelection.previousRunId,
    userPrompt: 'Complete canonical prepared review policy',
    expectedIntegrationId: 'integration-1',
    expectedInstallationId: 'installation-1',
    expectedAppType: 'standard',
    preparation: {
      version: 1,
      preparedAt: new Date().toISOString(),
      requestingUserId: 'requesting-owner',
      executionUserId: 'review-owner',
      organizationId: 'org-1',
      reviewSelection,
      settings: {
        reviewStyle: 'strict',
        focusAreas: ['correctness'],
        customInstructions: null,
        manualInstructions: null,
        model: inference.modelId,
        thinkingEffort: null,
        modelSource: 'explicit',
        disableReviewMd: false,
        analyticsEnabled: false,
      },
      snapshot,
      github: {
        integrationId: 'integration-1',
        installationId: 'installation-1',
        appType: 'standard',
      },
      reviewInstructions: {
        path: 'REVIEW.md',
        sha: BASE_SHA,
        hash: '6'.repeat(64),
        characterCount: 20,
        truncated: false,
      },
      hashes: {
        settings: 'a'.repeat(64),
        context: 'b'.repeat(64),
        canonicalPrompt: 'c'.repeat(64),
        adaptedPrompt: 'd'.repeat(64),
        system: 'e'.repeat(64),
      },
      versions: { cli: '7.4.20', policy: '1', adapter: '1' },
      limitations: [],
    },
  };
}

function completedPreparedBaseline() {
  const prepared = preparedReviewInput();
  return {
    status: 'completed',
    provenance: 'prepared',
    headSha: FIRST_HEAD,
    baseTipSha: BASE_SHA,
    mergeBaseSha: MERGE_SHA,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    completedAt: new Date(Date.now() - 30_000).toISOString(),
    cleanupAt: Date.now() + 23 * 60 * 60 * 1000,
    terminationReason: 'completed',
    installationId: 'installation-1',
    appType: 'standard',
    analysisOutcome: {
      ...cleanAnalysis,
      status: 'completed',
      contextIncompleteReasons: [],
      incompleteTaskIds: [],
    },
    publicationOutcome: { review: 'not_requested', summary: 'proposed' },
    summaryProposal,
    summaryContent: baselineSummary,
    reviewSelection: prepared.preparation.reviewSelection,
    input: {
      ...prepared,
      gitToken: '',
      kiloToken: '',
      headSha: FIRST_HEAD,
      preparation: {
        ...prepared.preparation,
        snapshot: { ...snapshot, headSha: FIRST_HEAD },
        hashes: {
          ...prepared.preparation.hashes,
          context: '3'.repeat(64),
          canonicalPrompt: '4'.repeat(64),
          adaptedPrompt: '5'.repeat(64),
        },
      },
    },
  } satisfies Partial<RunState>;
}

function incrementalSelection(previousRunId: string) {
  return {
    requestedMode: 'incremental',
    effectiveMode: 'incremental',
    previousRunId,
    previousHeadSha: FIRST_HEAD,
    previousSummaryHash: baselineSummary.bodyHash,
    changedFileCount: 1,
  } satisfies IsolateReviewSelection;
}

function incrementalCompareFixture() {
  return {
    ...compareFixture(),
    base_commit: { sha: FIRST_HEAD },
    merge_base_commit: { sha: FIRST_HEAD },
    status: 'ahead',
  };
}

function historyCommitFixture(sha = HISTORY_SHA) {
  return {
    sha,
    commit: { message: 'Historical change' },
    parents: [{ sha: HISTORY_PARENT_SHA }],
  };
}

function historyGithubResponse(url: string, options?: RequestInit): Response {
  const path = new URL(url).pathname;
  if (path.endsWith('/commits')) return Response.json([historyCommitFixture()]);
  if (path.includes('/commits/')) {
    return Response.json({
      ...historyCommitFixture(path.slice(path.lastIndexOf('/') + 1)),
      files: compareFixture().files,
    });
  }
  if (path.endsWith('/contents/source.ts')) {
    return Response.json({
      type: 'file',
      path: 'source.ts',
      encoding: 'base64',
      content: btoa('Historical source'),
      size: 'Historical source'.length,
      sha: '3'.repeat(40),
    });
  }
  if (path.endsWith(`/compare/${FIRST_HEAD}...${HEAD_SHA}`))
    return Response.json(incrementalCompareFixture());
  return fixtureGithubResponse(url, options);
}

const cloneStats = {
  tipFileCount: 2,
  tipTotalBytes: 20,
  vfsTotalBytes: 40,
  vfsFileCount: 4,
  cloneMs: 5,
};

function submitInspection(
  runId: string,
  status: ThinkSubmissionInspection['status'],
  submissionId: string
): ThinkSubmissionInspection & { accepted: boolean } {
  return {
    accepted: false,
    submissionId,
    idempotencyKey: runId,
    status,
    createdAt: Date.now(),
  };
}

async function seedState(runId: string, overrides: Partial<RunState> = {}): Promise<void> {
  await runInDurableObject(
    env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
    async (_instance, state) => {
      await createReviewPersistence(state.storage).persistence.put('runState', {
        runId,
        status: 'pending',
        credentialsExpireAt: Date.now() + 3_600_000,
        inferenceResolved: overrides.status === 'running',
        executionDeadlineAt: overrides.status === 'running' ? Date.now() + 720_000 : undefined,
        baseTipSha: BASE_SHA,
        mergeBaseSha: MERGE_SHA,
        analysisOutcome: { status: 'running', stepCount: 0 },
        publicationOutcome: { review: 'not_requested', summary: 'not_requested' },
        ...overrides,
        input: {
          ...input,
          ...overrides.input,
          inference: overrides.input?.inference ?? {
            ...inference,
            modelId: overrides.input?.model ?? DEFAULT_MODEL,
          },
        },
      } satisfies RunState);
    }
  );
}

async function readState(runId: string): Promise<RunState | undefined> {
  return runInDurableObject(
    env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
    (_instance, state) =>
      createReviewPersistence(state.storage).persistence.get<RunState>('runState')
  );
}

async function executeTool(tools: ToolSet, name: string, args: unknown): Promise<unknown> {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`${name} has no execute function`);
  return execute(args as never, { toolCallId: 'test-call', messages: [], context: {} } as never);
}

function createGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>(release => {
    resolve = release;
  });
  if (!resolve) throw new Error('Asynchronous gate was not initialized');
  return { promise, resolve };
}

async function finishSubmission(
  instance: ReviewIsolate,
  runId: string,
  finishReason = 'stop'
): Promise<void> {
  await instance.onStepEnd({
    finishReason,
    toolCalls: finishReason === 'tool-calls' ? [{}] : [],
  } as StepContext);
  await completeSubmission(instance, runId);
}

async function completeSubmission(instance: ReviewIsolate, runId: string): Promise<void> {
  const hook = Reflect.get(instance, 'onSubmissionStatus');
  if (typeof hook !== 'function') throw new Error('Submission status hook is unavailable');
  await Reflect.apply(hook, instance, [
    submitInspection(runId, 'completed', 'completed-submission'),
  ]);
}

function chatReply(finishReason = 'stop', toolCalls?: unknown[]): Response {
  return Response.json({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Delegated result',
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function streamReply(
  index: number,
  call?: { name: string; input: Record<string, unknown> },
  finishReason = call ? 'tool_calls' : 'stop'
): Response {
  const base = { id: `completion-${index}`, model: DEFAULT_MODEL, created: 1 };
  const delta = call
    ? {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call-${index}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          },
        ],
      }
    : { role: 'assistant', content: 'Review complete.' };
  const events = [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
  return new Response(
    events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } }
  );
}

function fixtureGithubResponse(url: string, options?: RequestInit): Response {
  const path = new URL(url).pathname;
  if (options?.method === 'POST' || options?.method === 'PATCH')
    return Response.json({ id: path.endsWith('/reviews') ? 17 : 22 });
  if (path.includes('/compare/')) return Response.json(compareFixture());
  if (path.endsWith('/pulls/42')) return Response.json(pullFixture());
  return Response.json([]);
}

describe('ReviewIsolate lifecycle', () => {
  const submitMessages = vi.spyOn(ReviewIsolate.prototype, 'submitMessages');

  beforeEach(() => {
    vi.mocked(admitRepository).mockReset().mockResolvedValue({ sizeKiB: 1 });
    vi.mocked(resolveReviewSnapshot).mockReset().mockResolvedValue(snapshot);
    vi.mocked(resolveGithubCredentials).mockReset();
    vi.mocked(resolveIsolateReviewInference)
      .mockReset()
      .mockImplementation(async options => ({
        ...inference,
        modelId: options.model ?? DEFAULT_MODEL,
      }));
    vi.mocked(cloneRepository).mockReset().mockResolvedValue(cloneStats);
    submitMessages
      .mockReset()
      .mockRejectedValue(new Error('Unexpected submission in offline lifecycle test'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('External networking is disabled in lifecycle tests');
      })
    );
  });

  afterEach(async () => {
    await reset();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('arms both retention schedules before persisting review credentials', async () => {
    const runId = crypto.randomUUID();
    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async (instance, durableState) => {
        const persistence = createReviewPersistence(durableState.storage).persistence;
        const observed: Array<{ callback: string; stateExists: boolean }> = [];
        const originalSchedule = instance.schedule.bind(instance);
        const schedule = vi
          .spyOn(instance, 'schedule')
          .mockImplementation(async (when, callback, payload, options) => {
            observed.push({
              callback: String(callback),
              stateExists: (await persistence.get<RunState>('runState')) !== undefined,
            });
            return originalSchedule(when, callback, payload, options);
          });

        try {
          await instance.startReview(runId, input);
          return {
            observed,
            schedules: await instance.listSchedules(),
            state: await persistence.get<RunState>('runState'),
          };
        } finally {
          for (const scheduled of await instance.listSchedules()) {
            await instance.cancelSchedule(scheduled.id);
          }
          schedule.mockRestore();
        }
      }
    );

    expect(result.observed).toEqual([
      { callback: 'expireCredentials', stateExists: false },
      { callback: 'cleanupReview', stateExists: false },
      { callback: 'expireReview', stateExists: false },
      { callback: 'runClone', stateExists: true },
    ]);
    expect(result.schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callback: 'expireCredentials',
          delayInSeconds: 3_600,
          payload: { runId },
        }),
        expect.objectContaining({
          callback: 'cleanupReview',
          delayInSeconds: 86_400,
          payload: { runId },
        }),
      ])
    );
    expect(result.state?.credentialsExpireAt).toEqual(expect.any(Number));
    expect(result.state?.cleanupAt).toEqual(expect.any(Number));
    expect((result.state?.cleanupAt ?? 0) - (result.state?.credentialsExpireAt ?? 0)).toBe(
      23 * 60 * 60 * 1000
    );
  });

  it('does not persist credentials if retention scheduling fails', async () => {
    const runId = crypto.randomUUID();
    const stored = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async (instance, durableState) => {
        const schedule = vi
          .spyOn(instance, 'schedule')
          .mockRejectedValueOnce(new Error('scheduler unavailable'));
        try {
          await expect(instance.startReview(runId, input)).rejects.toThrow('scheduler unavailable');
          return createReviewPersistence(durableState.storage).persistence.get<RunState>(
            'runState'
          );
        } finally {
          schedule.mockRestore();
        }
      }
    );

    expect(stored).toBeUndefined();
  });

  it('persists and reports oversize repository metadata on terminal rejection', async () => {
    const runId = crypto.randomUUID();
    const error = new RepoTooLargeError(50_000);
    vi.mocked(admitRepository).mockRejectedValueOnce(error);
    await seedState(runId);

    const review = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        await instance.runClone({ runId });
        return instance.getReview('review-owner');
      }
    );
    expect(review).toMatchObject({
      status: 'error',
      error: error.message,
      githubSizeKiB: 50_000,
      cloneAttempts: 1,
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    });
    expect(review?.cloneCompletedAt).toBeUndefined();
    await expect(readState(runId)).resolves.toMatchObject({
      githubSizeKiB: 50_000,
      completedAt: review?.completedAt,
      input: { gitToken: '', kiloToken: '' },
    });
    expect(cloneRepository).not.toHaveBeenCalled();
    expect(submitMessages).not.toHaveBeenCalled();
  });

  it('recovers an existing non-terminal submission with the run idempotency key', async () => {
    const runId = crypto.randomUUID();
    submitMessages.mockResolvedValue(submitInspection(runId, 'running', 'existing-submission'));
    await seedState(runId);

    await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      instance => instance.runClone({ runId })
    );

    expect(submitMessages).toHaveBeenCalledWith([expect.objectContaining({ role: 'user' })], {
      idempotencyKey: runId,
    });
    await expect(readState(runId)).resolves.toMatchObject({
      runId,
      status: 'running',
      submissionId: 'existing-submission',
      cloneAttempts: 1,
      input,
    });
  });

  it('reuses the first persisted head SHA after an interrupted clone', async () => {
    const runId = crypto.randomUUID();
    vi.mocked(resolveReviewSnapshot)
      .mockResolvedValueOnce({ ...snapshot, headSha: FIRST_HEAD })
      .mockResolvedValue({ ...snapshot, headSha: 'e'.repeat(40) });
    vi.mocked(cloneRepository)
      .mockRejectedValueOnce(new Error('clone interrupted'))
      .mockResolvedValueOnce(cloneStats);
    submitMessages.mockResolvedValue(submitInspection(runId, 'running', 'existing-submission'));
    await seedState(runId);

    const stub = env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId));
    await expect(
      runInDurableObject(stub, instance => instance.runClone({ runId }))
    ).rejects.toThrow('clone interrupted');
    await expect(readState(runId)).resolves.toMatchObject({ headSha: FIRST_HEAD });

    await runInDurableObject(stub, instance => instance.runClone({ runId }));

    expect(resolveReviewSnapshot).toHaveBeenCalledOnce();
    expect(cloneRepository).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining(input),
      FIRST_HEAD,
      expect.anything()
    );
    expect(cloneRepository).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining(input),
      FIRST_HEAD,
      expect.anything()
    );
    await expect(readState(runId)).resolves.toMatchObject({
      headSha: FIRST_HEAD,
      cloneAttempts: 2,
    });
  });

  it('persists one execution deadline and applies the remaining budget to model and tool calls', async () => {
    const runId = crypto.randomUUID();
    submitMessages.mockResolvedValue(submitInspection(runId, 'running', 'existing-submission'));
    await seedState(runId);

    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async (instance, durableState) => {
        await instance.runClone({ runId });
        const state = await createReviewPersistence(durableState.storage).persistence.get<RunState>(
          'runState'
        );
        const config = await instance.beforeTurn({
          system: '',
          messages: [],
          tools: {},
          model: instance.getModel(),
          continuation: false,
        });
        return { state, timeout: config.timeout };
      }
    );

    expect(result.state?.executionDeadlineAt).toEqual(expect.any(Number));
    expect(result.timeout).toEqual({
      totalMs: expect.any(Number),
      toolMs: expect.any(Number),
    });
    if (typeof result.timeout !== 'object' || !result.timeout) {
      throw new Error('Review timeout was not configured');
    }
    expect(result.timeout.totalMs).toBeGreaterThan(0);
    expect(result.timeout.totalMs).toBeLessThanOrEqual(12 * 60 * 1000);
    expect(result.timeout.toolMs).toBe(result.timeout.totalMs);
  });

  it.each([
    { evicted: false, finishReason: 'stop' },
    { evicted: true, finishReason: 'stop' },
    { evicted: false, finishReason: 'tool-calls' },
    { evicted: true, finishReason: 'tool-calls' },
  ] as const)(
    'limits continued Think loops to the remaining cumulative steps (evicted=$evicted, finish=$finishReason)',
    async ({ evicted, finishReason }) => {
      const runId = crypto.randomUUID();
      await seedState(runId, {
        status: 'running',
        headSha: HEAD_SHA,
        githubToken: 'minted-token',
        input: { ...input, dryRun: true },
        summaryProposal,
        analysisOutcome: { status: 'running', stepCount: 37 },
      });
      const fetchMock = vi.fn<typeof fetch>(async () => streamReply(0, undefined, 'length'));
      vi.stubGlobal('fetch', fetchMock);
      await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          await instance.__unsafe_ensureInitialized();
          await instance.getReview('review-owner');
          await instance.workspace.mkdir('/workspace', { recursive: true });
          await instance.workspace.writeFile('/workspace/source.ts', 'source');
          expect(
            await instance.runTurn({ input: 'Continue the review investigation.' })
          ).toMatchObject({
            status: 'completed',
          });
        }
      );
      await expect(readState(runId)).resolves.toMatchObject({
        status: 'running',
        analysisOutcome: { stepCount: 38, parentFinished: false, parentFinishReason: 'length' },
      });
      if (evicted) await abortAllDurableObjects();
      let continuedRequests = 0;
      fetchMock.mockImplementation(async () => {
        const index = continuedRequests++;
        expect(index).toBeLessThan(2);
        return streamReply(
          index + 1,
          index === 1 && finishReason === 'stop'
            ? undefined
            : { name: 'read', input: { path: '/workspace/source.ts' } }
        );
      });
      const review = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          await instance.__unsafe_ensureInitialized();
          await instance.getReview('review-owner');
          const config = await instance.beforeTurn({
            system: '',
            messages: [],
            tools: instance.getTools(),
            model: instance.getModel(),
            continuation: true,
          });
          expect(config.maxSteps).toBe(2);
          expect(await instance.runTurn({ continuation: true })).toMatchObject({
            status: 'completed',
          });
          await completeSubmission(instance, runId);
          return instance.getReview('review-owner');
        }
      );
      expect(continuedRequests).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(review).toMatchObject({
        status: finishReason === 'stop' ? 'completed' : 'error',
        terminationReason: finishReason === 'stop' ? 'completed' : 'step_limit',
        analysisOutcome: {
          status: finishReason === 'stop' ? 'completed' : 'incomplete',
          stepCount: 40,
          parentFinished: finishReason === 'stop',
          parentFinishReason: finishReason,
        },
      });
    }
  );

  it.each([false, true])(
    'terminalizes an exhausted cumulative parent budget before another inference (evicted=%s)',
    async evicted => {
      const runId = crypto.randomUUID();
      await seedState(runId, {
        status: 'running',
        headSha: HEAD_SHA,
        githubToken: 'minted-token',
        input: { ...input, dryRun: true },
        summaryProposal,
        analysisOutcome: {
          status: 'running',
          stepCount: 40,
          parentFinishReason: 'tool-calls',
          parentFinished: false,
        },
      });
      await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          await instance.__unsafe_ensureInitialized();
          await instance.getReview('review-owner');
          await instance.addMessages([
            { id: 'budget-user', role: 'user', parts: [{ type: 'text', text: 'Review.' }] },
            {
              id: 'budget-assistant',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Incomplete investigation.' }],
            },
          ]);
        }
      );
      if (evicted) await abortAllDurableObjects();
      const fetchMock = vi.fn<typeof fetch>(async () => streamReply(0));
      vi.stubGlobal('fetch', fetchMock);
      const review = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          await instance.__unsafe_ensureInitialized();
          await instance.getReview('review-owner');
          await instance.runTurn({ continuation: true }).catch(() => undefined);
          return instance.getReview('review-owner');
        }
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(review).toMatchObject({
        status: 'error',
        error: 'Parent review exhausted its step budget',
        terminationReason: 'step_limit',
        analysisOutcome: { status: 'incomplete', stepCount: 40, parentFinished: false },
      });
      await expect(readState(runId)).resolves.toMatchObject({
        status: 'error',
        terminationReason: 'step_limit',
        input: { gitToken: '', kiloToken: '' },
      });
    }
  );

  it('persists clone diagnostics before failed admission and preserves first-start times and the deadline on retry', async () => {
    const runId = crypto.randomUUID();
    const stub = env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId));
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await seedState(runId, { createdAt: new Date(now).toISOString() });
      clock.mockReturnValue(now + 1000);
      const first = await runInDurableObject(stub, async (instance, durableState) => {
        const persistence = createReviewPersistence(durableState.storage).persistence;
        let beforeSubmission: RunState | undefined;
        submitMessages.mockImplementationOnce(async () => {
          beforeSubmission = await persistence.get<RunState>('runState');
          throw new Error('submission interrupted');
        });
        await expect(instance.runClone({ runId })).rejects.toThrow('submission interrupted');
        return { beforeSubmission, state: await persistence.get<RunState>('runState') };
      });
      expect(first.beforeSubmission).toMatchObject({
        status: 'cloning',
        createdAt: new Date(now).toISOString(),
        startedAt: new Date(now + 1000).toISOString(),
        cloneCompletedAt: new Date(now + 1000).toISOString(),
        cloneAttempts: 1,
        githubSizeKiB: 1,
        tipFileCount: 2,
        tipTotalBytes: 20,
        vfsTotalBytes: 40,
        cloneMs: 5,
        executionDeadlineAt: now + 1000 + 12 * 60 * 1000,
      });
      expect(first.state).toEqual(first.beforeSubmission);
      expect(first.state?.completedAt).toBeUndefined();

      clock.mockReturnValue(now + 2000);
      submitMessages.mockResolvedValueOnce(
        submitInspection(runId, 'running', 'existing-submission')
      );
      await runInDurableObject(stub, instance => instance.runClone({ runId }));

      await expect(readState(runId)).resolves.toMatchObject({
        createdAt: first.state?.createdAt,
        startedAt: first.state?.startedAt,
        executionDeadlineAt: first.state?.executionDeadlineAt,
        cloneCompletedAt: new Date(now + 2000).toISOString(),
        cloneAttempts: 2,
        status: 'running',
      });
      expect(resolveReviewSnapshot).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it('terminalizes an expired execution deadline without submitting more work', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, {
      status: 'cloning',
      githubToken: 'minted-token',
      executionDeadlineAt: Date.now() - 1,
    });

    await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      instance => instance.runClone({ runId })
    );

    await expect(readState(runId)).resolves.toMatchObject({
      status: 'error',
      error: 'Review execution deadline exceeded',
      input: { gitToken: '', kiloToken: '' },
    });
    expect(cloneRepository).not.toHaveBeenCalled();
    expect(submitMessages).not.toHaveBeenCalled();
  });

  it('rejects an inference turn after its persisted execution deadline expires', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, {
      status: 'running',
      headSha: HEAD_SHA,
      githubToken: 'minted-token',
      executionDeadlineAt: Date.now() - 1,
    });

    await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        await instance.getReview('review-owner');
        await expect(
          instance.beforeTurn({
            system: '',
            messages: [],
            tools: {},
            model: 'fixture/model',
            continuation: false,
          })
        ).rejects.toThrow('Review execution deadline exceeded');
        expect(() => instance.getModel()).toThrow('Review execution deadline exceeded');
      }
    );
  });

  it('keeps raw Git metadata available to clone work but hidden from the review workspace', async () => {
    const runId = crypto.randomUUID();
    submitMessages.mockResolvedValue(submitInspection(runId, 'running', 'existing-submission'));
    await seedState(runId);

    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        await instance.workspace.mkdir('/workspace/.git', { recursive: true });
        await instance.workspace.writeFile('/workspace/.git/config', 'private metadata');
        await instance.workspace.writeFile('/workspace/source.ts', 'visible source');
        let rawPaths: string[] = [];
        vi.mocked(cloneRepository).mockImplementationOnce(async workspace => {
          rawPaths = (await workspace.glob('**/*')).map(entry => entry.path);
          return cloneStats;
        });

        await instance.runClone({ runId });

        return { rawPaths, visible: await instance.workspace.glob('**/*') };
      }
    );

    expect(result.rawPaths).toContain('/workspace/.git/config');
    expect(result.visible).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '/workspace/.git/config' })])
    );
    expect(result.visible).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '/workspace/source.ts', size: 14 })])
    );
  });

  it('attributes concurrent parent and child requests without shared-header mutation and exposes every session', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, {
      status: 'running',
      headSha: HEAD_SHA,
      githubToken: 'minted-token',
      input: { ...input, model: 'kilo-auto/efficient' },
    });
    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async (instance, durableState) => {
        const fetchMock = vi.fn<typeof fetch>(async () => chatReply());
        vi.stubGlobal('fetch', fetchMock);
        await instance.getReview('review-owner');
        const tools = instance.getTools();
        const [parent, explore, general] = await Promise.all([
          generateText({ model: instance.getModel(), prompt: 'Review this change' }),
          executeTool(tools, 'task', {
            description: 'Explore source',
            prompt: 'Inspect source.',
            subagent_type: 'explore',
            task_id: 'explore-child',
          }),
          executeTool(tools, 'task', {
            description: 'Verify auth',
            prompt: 'Verify auth.',
            subagent_type: 'general',
            task_id: 'general-child',
          }),
        ]);
        const checkpoint = await createReviewPersistence(durableState.storage).persistence.get(
          'task:explore-child'
        );
        const requests = fetchMock.mock.calls.map(([, options]) => {
          if (typeof options?.body !== 'string') throw new Error('Expected a JSON request body');
          const body = JSON.parse(options.body) as { model: string };
          const headers = new Headers(options.headers);
          return {
            sessionId: headers.get('x-kilo-session'),
            taskId: headers.get('x-kilocode-taskid'),
            parentSessionId: headers.get('x-kilocode-parent-taskid'),
            mode: headers.get('x-kilocode-mode'),
            requestId: headers.get('x-kilo-request'),
            model: body.model,
          };
        });
        return {
          parent: parent.text,
          explore,
          general,
          checkpoint,
          requests,
          status: await instance.getReview('review-owner'),
        };
      }
    );
    const exploreSession = result.status?.taskSessions?.find(
      task => task.taskId === 'explore-child'
    );
    const generalSession = result.status?.taskSessions?.find(
      task => task.taskId === 'general-child'
    );
    expect(exploreSession).toMatchObject({
      sessionId: expect.any(String),
      parentSessionId: runId,
      mode: 'explore',
    });
    expect(generalSession).toMatchObject({
      sessionId: expect.any(String),
      parentSessionId: runId,
      mode: 'general',
    });
    expect(new Set([runId, exploreSession?.sessionId, generalSession?.sessionId]).size).toBe(3);
    expect(result.requests).toEqual(
      expect.arrayContaining([
        {
          sessionId: runId,
          taskId: runId,
          parentSessionId: null,
          mode: 'code',
          requestId: expect.any(String),
          model: 'kilo-auto/efficient',
        },
        {
          sessionId: exploreSession?.sessionId,
          taskId: exploreSession?.sessionId,
          parentSessionId: runId,
          mode: 'explore',
          requestId: expect.any(String),
          model: 'kilo-auto/efficient',
        },
        {
          sessionId: generalSession?.sessionId,
          taskId: generalSession?.sessionId,
          parentSessionId: runId,
          mode: 'general',
          requestId: expect.any(String),
          model: 'kilo-auto/efficient',
        },
      ])
    );
    expect(result.status?.usageSessions).toHaveLength(3);
    expect(result.status?.requestIds?.sort()).toEqual(
      result.requests.map(request => request.requestId).sort()
    );
    expect(result.status?.analysisOutcome?.incompleteTaskIds).toEqual([]);
    expect(result.explore).toMatchObject({
      metadata: { taskId: 'explore-child', state: 'completed' },
    });
    expect(result.general).toMatchObject({
      metadata: { taskId: 'general-child', state: 'completed' },
    });
    expect(result.checkpoint).toMatchObject({
      state: 'completed',
      sessionId: exploreSession?.sessionId,
      mode: 'explore',
      lastText: 'Delegated result',
    });
  });

  it('keeps nonempty step-limited child work incomplete in parent status', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, {
      status: 'running',
      headSha: HEAD_SHA,
      githubToken: 'minted-token',
      summaryProposal,
      input: { ...input, dryRun: true },
    });
    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        let request = 0;
        vi.stubGlobal(
          'fetch',
          vi.fn<typeof fetch>(async () =>
            chatReply('tool_calls', [
              {
                id: `read-${request++}`,
                type: 'function',
                function: {
                  name: 'read',
                  arguments: JSON.stringify({ path: '/workspace/source.ts' }),
                },
              },
            ])
          )
        );
        await instance.getReview('review-owner');
        await instance.workspace.mkdir('/workspace', { recursive: true });
        await instance.workspace.writeFile('/workspace/source.ts', 'source');
        const child = await executeTool(instance.getTools(), 'task', {
          description: 'Investigate',
          prompt: 'Inspect source.',
          subagent_type: 'general',
          task_id: 'unfinished',
        });
        await finishSubmission(instance, runId);
        return { child, status: await instance.getReview('review-owner'), requests: request };
      }
    );
    expect(result.requests).toBe(MAX_TASK_STEPS);
    expect(result.child).toMatchObject({
      metadata: { state: 'error', stepCount: MAX_TASK_STEPS, finishReason: 'tool-calls' },
    });
    expect(result.status).toMatchObject({
      status: 'error',
      terminationReason: 'child_incomplete',
      analysisOutcome: { status: 'incomplete', incompleteTaskIds: ['unfinished'] },
    });
  });

  it('retains child identity across eviction and clears failed state only after a genuine resumed finish', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, {
      status: 'running',
      headSha: HEAD_SHA,
      githubToken: 'minted-token',
      summaryProposal,
      input: { ...input, dryRun: true },
    });
    const assignment = {
      description: 'Investigate',
      prompt: 'Inspect source.',
      subagent_type: 'explore',
      task_id: 'resume-me',
    };
    const first = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        vi.stubGlobal(
          'fetch',
          vi.fn<typeof fetch>(async () => chatReply('length'))
        );
        await instance.getReview('review-owner');
        const child = await executeTool(instance.getTools(), 'task', assignment);
        return { child, status: await instance.getReview('review-owner') };
      }
    );
    expect(first.child).toMatchObject({ metadata: { state: 'error' } });
    expect(first.status?.analysisOutcome?.incompleteTaskIds).toEqual(['resume-me']);
    await abortAllDurableObjects();
    const resumed = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        vi.stubGlobal(
          'fetch',
          vi.fn<typeof fetch>(async () => chatReply())
        );
        await instance.getReview('review-owner');
        const child = await executeTool(instance.getTools(), 'task', assignment);
        await finishSubmission(instance, runId);
        return { child, status: await instance.getReview('review-owner') };
      }
    );
    expect(resumed.child).toMatchObject({
      metadata: {
        state: 'completed',
        resumed: true,
        sessionId: first.status?.taskSessions?.[0]?.sessionId,
        mode: 'explore',
      },
    });
    expect(resumed.status?.usageSessions).toEqual(first.status?.usageSessions);
    expect(resumed.status?.requestIds).toHaveLength(2);
    expect(resumed.status).toMatchObject({
      status: 'completed',
      analysisOutcome: { status: 'completed', incompleteTaskIds: [] },
    });
  });

  it('recovers auto-ID running children through ephemeral parent context after real DO recreation', async () => {
    const runId = crypto.randomUUID();
    const prepared = {
      ...preparedReviewInput(),
      userPrompt: '  Complete canonical prepared review policy\n',
    };
    const tasks = (['general', 'explore'] as const).map(mode => ({
      taskId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      parentSessionId: runId,
      mode,
    }));
    const completedTask = {
      taskId: 'already-completed',
      sessionId: crypto.randomUUID(),
      parentSessionId: runId,
      mode: 'general' as const,
    };
    const taskSessions = [...tasks, completedTask];
    await seedState(runId, {
      status: 'running',
      headSha: HEAD_SHA,
      githubToken: 'minted-token',
      createdAt: new Date().toISOString(),
      input: prepared,
      taskSessions,
      usageSessions: [runId, ...taskSessions.map(task => task.sessionId)],
      analysisOutcome: {
        status: 'running',
        stepCount: 4,
        incompleteTaskIds: tasks.map(task => task.taskId),
      },
    });
    const originalMessages: UIMessage[] = [
      {
        id: 'canonical-user',
        role: 'user',
        parts: [{ type: 'text', text: prepared.userPrompt }],
      },
      {
        id: 'interrupted-parent',
        role: 'assistant',
        parts: tasks.map(
          task =>
            ({
              type: 'tool-task',
              toolCallId: `interrupted-${task.mode}`,
              state: 'input-available',
              input: {
                description: `Investigate ${task.mode}`,
                prompt: `Original ${task.mode} investigation.`,
                subagent_type: task.mode,
              },
            }) satisfies UIMessage['parts'][number]
        ),
      },
    ];
    const beforeEviction = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async (instance, durableState) => {
        await instance.__unsafe_ensureInitialized();
        const persistence = createReviewPersistence(durableState.storage).persistence;
        for (const task of tasks) {
          await persistence.put(`task:${task.taskId}`, {
            subagentType: task.mode,
            sessionId: task.sessionId,
            mode: task.mode,
            state: 'running',
            messages: [
              { role: 'user', content: buildTaskReviewContext(prepared, snapshot) },
              { role: 'user', content: `Original ${task.mode} investigation.` },
            ],
            stepCount: 2,
            finishReason: 'tool-calls',
          });
        }
        await instance.getReview('review-owner');
        const config = await instance.beforeTurn({
          system: '',
          messages: [{ role: 'user', content: prepared.userPrompt }],
          tools: instance.getTools(),
          model: instance.getModel(),
          continuation: false,
        });
        expect(config.messages).toBeUndefined();
        await instance.addMessages(originalMessages);
        return persistence.get<RunState>('runState');
      }
    );
    await abortAllDurableObjects();
    let parentRequests = 0;
    let writes = 0;
    const childSessions: string[] = [];
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (new URL(url).pathname.endsWith('/chat/completions')) {
        if (typeof options?.body !== 'string') throw new Error('Missing inference request');
        const body = JSON.parse(options.body) as {
          stream?: boolean;
          messages: Array<{ role: string; content: unknown }>;
        };
        const headers = new Headers(options.headers);
        if (headers.get('x-kilocode-mode') !== 'code') {
          const session = tasks.find(task => task.sessionId === headers.get('x-kilo-session'));
          if (!session) throw new Error('Recovery created a replacement child session');
          expect(headers.get('x-kilocode-mode')).toBe(session.mode);
          expect(headers.get('x-kilocode-parent-taskid')).toBe(runId);
          expect(JSON.stringify(body.messages)).toContain(
            `Original ${session.mode} investigation.`
          );
          childSessions.push(session.sessionId);
          return chatReply();
        }
        expect(body.stream).toBe(true);
        const index = parentRequests++;
        expect(index).toBeLessThan(4);
        const hint = body.messages.find(
          message =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.startsWith('Required child investigations are unfinished.')
        )?.content;
        if (typeof hint !== 'string') throw new Error('Missing original child recovery identities');
        const resumable = JSON.parse(hint.slice(hint.indexOf('\n') + 1)) as Array<{
          task_id: string;
          subagent_type: 'general' | 'explore';
        }>;
        expect(resumable).toEqual(
          tasks.map(task => ({ task_id: task.taskId, subagent_type: task.mode }))
        );
        expect(JSON.stringify(body.messages)).toContain(
          'The tool call was interrupted before a result was recorded.'
        );
        const task = resumable[index];
        if (task) {
          return streamReply(index, {
            name: 'task',
            input: {
              ...task,
              description: 'Resume required investigation',
              prompt: 'Finish the original persisted investigation.',
            },
          });
        }
        return streamReply(
          index,
          index === 2
            ? { name: 'upsert_summary', input: { body: 'Completed investigations.' } }
            : undefined
        );
      }
      if (options?.method === 'POST' || options?.method === 'PATCH') writes++;
      return fixtureGithubResponse(url, options);
    });
    vi.stubGlobal('fetch', fetchMock);
    const recovered = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async (instance, durableState) => {
        await instance.__unsafe_ensureInitialized();
        const persistence = createReviewPersistence(durableState.storage).persistence;
        await instance.getReview('review-owner');
        for (const task of tasks) {
          expect(await persistence.get(`task:${task.taskId}`)).toMatchObject({
            state: 'running',
            sessionId: task.sessionId,
            stepCount: 2,
          });
        }
        expect(await instance.runTurn({ continuation: true })).toMatchObject({
          status: 'completed',
        });
        const next = await instance.beforeTurn({
          system: '',
          messages: [],
          tools: instance.getTools(),
          model: instance.getModel(),
          continuation: true,
        });
        expect(next.messages).toBeUndefined();
        for (const task of tasks) {
          expect(await persistence.get(`task:${task.taskId}`)).toMatchObject({
            state: 'completed',
            sessionId: task.sessionId,
            mode: task.mode,
          });
        }
        await completeSubmission(instance, runId);
        return {
          review: await instance.getReview('review-owner'),
          transcript: await instance.getTranscript('review-owner'),
          state: await persistence.get<RunState>('runState'),
        };
      }
    );
    expect(parentRequests).toBe(4);
    expect(childSessions).toEqual(tasks.map(task => task.sessionId));
    expect(writes).toBe(0);
    expect(recovered.review).toMatchObject({
      status: 'completed',
      taskSessions,
      analysisOutcome: { status: 'completed', stepCount: 8, incompleteTaskIds: [] },
      summaryProposal: { publishable: true },
      usageSessions: beforeEviction?.usageSessions,
      systemPromptHash: beforeEviction?.systemPromptHash,
    });
    expect(recovered.state?.input.userPrompt).toBe(prepared.userPrompt);
    expect(recovered.state?.input.preparation).toEqual(beforeEviction?.input.preparation);
    expect(recovered.transcript?.messages.filter(message => message.role === 'user')).toEqual([
      { id: 'canonical-user', role: 'user', text: prepared.userPrompt },
    ]);
    expect(
      recovered.transcript?.toolCalls
        .filter(call => call.toolName === 'task' && call.state === 'output-available')
        .map(call => call.output)
    ).toEqual(
      tasks.map(task =>
        expect.objectContaining({
          metadata: expect.objectContaining({ ...task, resumed: true, state: 'completed' }),
        })
      )
    );
  });

  it.each(['anthropic', 'openai'] as const)(
    'inherits resolved %s settings in parent and child generations',
    async provider => {
      const runId = crypto.randomUUID();
      const model =
        provider === 'anthropic' ? 'anthropic/claude-sonnet-4.6' : 'openai/gpt-5.4-mini';
      await seedState(runId, {
        status: 'running',
        headSha: HEAD_SHA,
        githubToken: 'minted-token',
        input: {
          ...input,
          model,
          thinkingEffort: 'high',
          inference: {
            modelId: model,
            provider,
            thinkingEffort: 'high',
            variant: { reasoning: { enabled: true, effort: 'high' }, verbosity: 'high' },
            reasoningSupported: true,
            maxOutputTokens: 8_000,
          },
        },
      });
      const requests = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          const fetchMock = vi.fn<typeof fetch>(async () =>
            Response.json(
              provider === 'anthropic'
                ? {
                    id: 'msg_fixture',
                    type: 'message',
                    role: 'assistant',
                    model,
                    content: [{ type: 'text', text: 'Verified' }],
                    stop_reason: 'end_turn',
                    stop_sequence: null,
                    usage: { input_tokens: 1, output_tokens: 1 },
                  }
                : {
                    id: 'resp_fixture',
                    object: 'response',
                    created_at: 1,
                    model,
                    status: 'completed',
                    output: [
                      {
                        id: 'msg_fixture',
                        type: 'message',
                        role: 'assistant',
                        status: 'completed',
                        content: [{ type: 'output_text', text: 'Verified', annotations: [] }],
                      },
                    ],
                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                  }
            )
          );
          vi.stubGlobal('fetch', fetchMock);
          await instance.getReview('review-owner');
          await generateText({ model: instance.getModel(), prompt: 'Verify.' });
          expect(
            await executeTool(instance.getTools(), 'task', {
              description: 'Verify',
              prompt: 'Inspect.',
              subagent_type: 'general',
            })
          ).toMatchObject({ metadata: { state: 'completed' } });
          return fetchMock.mock.calls.map(([url, options]) => {
            if (typeof options?.body !== 'string') throw new Error('Expected JSON request');
            return {
              url: typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url,
              body: JSON.parse(options.body) as Record<string, unknown>,
            };
          });
        }
      );
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.body.model).toBe(model);
        if (provider === 'anthropic') {
          expect(request.body).toMatchObject({
            max_tokens: 8_000,
            thinking: { type: 'adaptive' },
            output_config: { effort: 'high' },
          });
          expect(request.url).toContain('/messages');
        } else {
          expect(request.body).toMatchObject({
            max_output_tokens: 8_000,
            store: false,
            reasoning: { effort: 'high', summary: 'auto' },
            text: { verbosity: 'high' },
            include: ['reasoning.encrypted_content'],
          });
          expect(request.url).toContain('/responses');
        }
      }
    }
  );

  it('refuses inference rather than dropping request IDs at the existing tracking bound', async () => {
    const runId = crypto.randomUUID();
    const requestIds = Array.from({ length: 1_000 }, (_, index) => `request-${index}`);
    await seedState(runId, { status: 'running', headSha: HEAD_SHA, requestIds });
    await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        const fetchMock = vi.fn<typeof fetch>(async () => chatReply());
        vi.stubGlobal('fetch', fetchMock);
        await instance.getReview('review-owner');
        await expect(
          generateText({ model: instance.getModel(), prompt: 'Review.', maxRetries: 0 })
        ).rejects.toThrow('request tracking exhausted');
        expect(fetchMock).not.toHaveBeenCalled();
        expect((await instance.getReview('review-owner'))?.requestIds).toEqual(requestIds);
      }
    );
  });

  it('reports historical runs without child IDs as root-only legacy sessions', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, {
      status: 'completed',
      input: { ...input, kiloToken: '', gitToken: '' },
    });
    const status = await env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)).getReview(
      'review-owner'
    );
    expect(status?.usageSessions).toEqual([runId]);
    expect(status?.taskSessions).toBeUndefined();
    expect(status?.systemPromptHash).toBeUndefined();
    expect(status?.summaryContent).toBeUndefined();
  });

  it.each(['completed', 'error'] as const)(
    'retains diagnostics and removes the checkout after a fast %s notification, retries, and polling',
    async status => {
      const runId = crypto.randomUUID();
      await seedState(runId, {
        input: { ...input, dryRun: true },
        analysisOutcome: cleanAnalysis,
        summaryProposal,
      });
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const result = await runInDurableObject(
          env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
          async (instance, durableState) => {
            const persistence = createReviewPersistence(durableState.storage).persistence;
            const hook = Reflect.get(instance, 'onSubmissionStatus');
            if (typeof hook !== 'function')
              throw new Error('Submission status hook is unavailable');
            let beforeSubmission: RunState | undefined;
            submitMessages.mockImplementationOnce(async () => {
              beforeSubmission = await persistence.get<RunState>('runState');
              clock.mockReturnValue(now + 1000);
              await Reflect.apply(hook, instance, [
                submitInspection(runId, status, 'terminal-submission'),
              ]);
              return submitInspection(runId, 'running', 'terminal-submission');
            });
            await instance.workspace.mkdir('/workspace/.git', { recursive: true });
            await instance.workspace.writeFile('/workspace/.git/config', 'private metadata');
            await instance.workspace.writeFile('/workspace/source.ts', 'private source');
            await instance.runClone({ runId });
            const review = await instance.getReview('review-owner');

            clock.mockReturnValue(now + 2000);
            await Reflect.apply(hook, instance, [
              submitInspection(runId, status, 'terminal-submission'),
            ]);
            await instance.runClone({ runId });
            return {
              beforeSubmission,
              review,
              polled: await instance.getReview('review-owner'),
              workspace: await instance.workspace.stat('/workspace'),
              state: await persistence.get<RunState>('runState'),
            };
          }
        );

        const diagnostics = {
          startedAt: new Date(now).toISOString(),
          cloneCompletedAt: new Date(now).toISOString(),
          cloneAttempts: 1,
          githubSizeKiB: 1,
          tipFileCount: 2,
          tipTotalBytes: 20,
          vfsTotalBytes: 40,
          cloneMs: 5,
        };
        expect(result.beforeSubmission).toMatchObject({ ...diagnostics, status: 'cloning' });
        expect(result.beforeSubmission?.completedAt).toBeUndefined();
        expect(result.workspace).toBeNull();
        expect(result.state).toMatchObject({
          ...diagnostics,
          status,
          submissionId: 'terminal-submission',
          completedAt: new Date(now + 1000).toISOString(),
          input: { gitToken: '', kiloToken: '' },
        });
        expect(result.review).toMatchObject({
          ...diagnostics,
          status,
          completedAt: new Date(now + 1000).toISOString(),
        });
        expect(result.polled).toEqual(result.review);
        expect(submitMessages).toHaveBeenCalledOnce();
      } finally {
        clock.mockRestore();
      }
    }
  );

  it('executes credential expiry through the real Agent alarm and preserves later Think and cleanup schedules', async () => {
    const runId = crypto.randomUUID();
    const stub = env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId));
    const scheduled = await runInDurableObject(stub, async (instance, durableState) => {
      await instance.startReview(runId, input);
      const persistence = createReviewPersistence(durableState.storage).persistence;
      const submission = await Think.prototype.submitMessages.call(
        instance,
        [
          {
            id: crypto.randomUUID(),
            role: 'user',
            parts: [{ type: 'text', text: 'Review this change' }],
          },
        ],
        { idempotencyKey: runId }
      );
      const current = await persistence.get<RunState>('runState');
      if (!current) throw new Error('Review state was not initialized');
      await persistence.put('runState', {
        ...current,
        status: 'running',
        submissionId: submission.submissionId,
        githubToken: 'minted-token',
      } satisfies RunState);
      await persistence.put('task:retained', { state: 'running' });
      await instance.workspace.mkdir('/workspace', { recursive: true });
      await instance.workspace.writeFile('/workspace/private.ts', 'private source');

      for (const schedule of await instance.listSchedules()) {
        if (schedule.callback === 'runClone' || schedule.callback === '_drainThinkSubmissions') {
          await instance.cancelSchedule(schedule.id);
        }
      }
      await instance.schedule(2 * 60 * 60, '_drainThinkSubmissions', undefined, {
        idempotent: true,
      });
      const schedules = await instance.listSchedules();
      const expiry = schedules.find(schedule => schedule.callback === 'expireCredentials');
      if (!expiry) throw new Error('Credential expiry was not scheduled');
      return { submissionId: submission.submissionId, expiresAt: expiry.time * 1000, schedules };
    });

    expect(scheduled.schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callback: 'expireCredentials' }),
        expect.objectContaining({ callback: '_drainThinkSubmissions' }),
        expect.objectContaining({ callback: 'cleanupReview' }),
      ])
    );

    const clock = vi.spyOn(Date, 'now').mockReturnValue(scheduled.expiresAt + 1000);
    try {
      await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    } finally {
      clock.mockRestore();
    }

    const result = await runInDurableObject(stub, async (instance, durableState) => {
      const persistence = createReviewPersistence(durableState.storage).persistence;
      return {
        state: await persistence.get<RunState>('runState'),
        checkpoint: await persistence.get<{ state: string }>('task:retained'),
        workspace: await instance.workspace.stat('/workspace'),
        submission: await instance.inspectSubmission(scheduled.submissionId),
        schedules: await instance.listSchedules(),
        alarm: await durableState.storage.getAlarm(),
      };
    });

    expect(result.state).toMatchObject({
      status: 'error',
      error: 'Review credentials expired before completion',
      input: { gitToken: '', kiloToken: '' },
    });
    expect(result.state?.githubToken).toBeUndefined();
    expect(result.checkpoint).toEqual({ state: 'running' });
    expect(result.workspace).toBeNull();
    expect(result.submission?.status).toBe('aborted');
    expect(result.schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callback: '_drainThinkSubmissions' }),
        expect.objectContaining({ callback: 'cleanupReview' }),
      ])
    );
    expect(result.schedules).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ callback: 'expireCredentials' })])
    );
    expect(result.alarm).not.toBeNull();
  });

  it.each(['direct', 'scheduled'] as const)(
    'executes real %s cleanup destruction and reinitializes clean application and framework state',
    async mode => {
      const runId = crypto.randomUUID();
      const id = env.REVIEW_ISOLATE.idFromName(runId);
      const stub = env.REVIEW_ISOLATE.get(id);
      const scheduled = await runInDurableObject(stub, async (instance, durableState) => {
        await instance.startReview(runId, input);
        const persistence = createReviewPersistence(durableState.storage).persistence;
        const submission = await Think.prototype.submitMessages.call(
          instance,
          [
            {
              id: crypto.randomUUID(),
              role: 'user',
              parts: [{ type: 'text', text: 'Review this change' }],
            },
          ],
          { idempotencyKey: runId }
        );
        const current = await persistence.get<RunState>('runState');
        if (!current) throw new Error('Review state was not initialized');
        await persistence.put('runState', {
          ...current,
          status: 'running',
          submissionId: submission.submissionId,
          githubToken: 'minted-token',
        } satisfies RunState);
        await persistence.put('task:destroyed', { state: 'completed', output: 'private analysis' });
        await instance.workspace.mkdir('/workspace/.git', { recursive: true });
        await instance.workspace.writeFile('/workspace/.git/config', 'private metadata');
        await instance.workspace.writeFile('/workspace/private.ts', 'private source');

        for (const schedule of await instance.listSchedules()) {
          if (schedule.callback === 'runClone' || schedule.callback === '_drainThinkSubmissions') {
            await instance.cancelSchedule(schedule.id);
          }
        }
        await instance.schedule(48 * 60 * 60, '_drainThinkSubmissions', undefined, {
          idempotent: true,
        });
        return instance.listSchedules();
      });

      expect(scheduled).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ callback: 'expireCredentials' }),
          expect.objectContaining({ callback: 'cleanupReview' }),
          expect.objectContaining({ callback: '_drainThinkSubmissions' }),
        ])
      );

      if (mode === 'scheduled') {
        const expiry = scheduled.find(schedule => schedule.callback === 'expireCredentials');
        const cleanup = scheduled.find(schedule => schedule.callback === 'cleanupReview');
        if (!expiry || !cleanup) throw new Error('Retention callbacks were not scheduled');
        await runInDurableObject(stub, instance => instance.cancelSchedule(expiry.id));
        const clock = vi.spyOn(Date, 'now').mockReturnValue(cleanup.time * 1000 + 1000);
        try {
          await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
        } finally {
          clock.mockRestore();
        }
      } else {
        await expect(stub.cleanupReview({ runId })).resolves.toBeUndefined();
      }
      await abortAllDurableObjects();

      const freshStub = env.REVIEW_ISOLATE.get(id);
      const result = await runInDurableObject(freshStub, async (instance, durableState) => {
        const persistence = createReviewPersistence(durableState.storage).persistence;
        return {
          state: await persistence.get<RunState>('runState'),
          checkpoint: await persistence.get('task:destroyed'),
          checkout: await instance.workspace.stat('/workspace/private.ts'),
          gitMetadata: await instance.workspace.stat('/workspace/.git/config'),
          submissions: await instance.listSubmissions(),
          schedules: await instance.listSchedules(),
          alarm: await durableState.storage.getAlarm(),
        };
      });

      expect(result).toEqual({
        state: undefined,
        checkpoint: undefined,
        checkout: null,
        gitMetadata: null,
        submissions: [],
        schedules: [],
        alarm: null,
      });
    }
  );

  it('suppresses differently formatted missing workflow-table errors after successful cleanup', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId);

    await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        const destroy = vi.spyOn(instance, 'destroy').mockResolvedValue(undefined);
        const alarm = vi
          .spyOn(Think.prototype, 'alarm')
          .mockRejectedValue(
            new Error(
              'SQLite engine failure: no such table: cf_think_workflow_notifications (code 1)'
            )
          );
        try {
          await instance.cleanupReview({ runId });
          await expect(instance.alarm()).resolves.toBeUndefined();
        } finally {
          alarm.mockRestore();
          destroy.mockRestore();
        }
      }
    );
  });

  it.each([
    {
      label: 'the cleanup table error before destruction',
      cleanup: false,
      error: new Error(
        'SQL query failed: no such table: cf_think_workflow_notifications: SQLITE_ERROR'
      ),
    },
    {
      label: 'another missing framework table after destruction',
      cleanup: true,
      error: new Error('SQL query failed: no such table: cf_agents_schedules: SQLITE_ERROR'),
    },
    {
      label: 'a similarly named missing framework table after destruction',
      cleanup: true,
      error: new Error(
        'SQLite engine failure: no such table: cf_think_workflow_notifications_archive'
      ),
    },
    {
      label: 'an unrelated framework failure after destruction',
      cleanup: true,
      error: new Error('scheduler unavailable'),
    },
    {
      label: 'a non-Error framework rejection after destruction',
      cleanup: true,
      error: 'scheduler unavailable',
    },
  ])('propagates $label', async ({ cleanup, error }) => {
    const runId = crypto.randomUUID();
    await seedState(runId);

    await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        const destroy = vi.spyOn(instance, 'destroy').mockResolvedValue(undefined);
        const alarm = vi.spyOn(Think.prototype, 'alarm').mockRejectedValue(error);
        try {
          if (cleanup) await instance.cleanupReview({ runId });
          await expect(instance.alarm()).rejects.toBe(error);
        } finally {
          alarm.mockRestore();
          destroy.mockRestore();
        }
      }
    );
  });

  it('does not suppress a missing framework table when cleanup destruction fails', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId);
    const frameworkError = new Error(
      'SQL query failed: no such table: cf_think_workflow_notifications: SQLITE_ERROR'
    );

    await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        const destroy = vi
          .spyOn(instance, 'destroy')
          .mockRejectedValue(new Error('destroy failed'));
        const alarm = vi.spyOn(Think.prototype, 'alarm').mockRejectedValue(frameworkError);
        try {
          await expect(instance.cleanupReview({ runId })).rejects.toThrow('destroy failed');
          await expect(instance.alarm()).rejects.toBe(frameworkError);
        } finally {
          alarm.mockRestore();
          destroy.mockRestore();
        }
      }
    );
  });

  it('expires stranded review credentials even when submission cancellation fails', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, {
      status: 'running',
      submissionId: 'stranded-submission',
      githubToken: 'minted-token',
    });

    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async (instance, durableState) => {
        const cancel = vi
          .spyOn(Think.prototype, 'cancelSubmission')
          .mockRejectedValue(new Error('cancellation unavailable'));
        try {
          await instance.expireCredentials({ runId });
          return {
            cancelCalls: cancel.mock.calls,
            state: await createReviewPersistence(durableState.storage).persistence.get<RunState>(
              'runState'
            ),
          };
        } finally {
          cancel.mockRestore();
        }
      }
    );

    expect(result.cancelCalls).toEqual([
      ['stranded-submission', 'Review credentials expired before completion'],
    ]);
    expect(result.state).toMatchObject({
      status: 'error',
      error: 'Review credentials expired before completion',
      input: { gitToken: '', kiloToken: '' },
    });
    expect(result.state?.githubToken).toBeUndefined();
  });

  it('ignores retention callbacks for another run and destroys the matching review safely', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, { githubToken: 'minted-token' });

    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async (instance, durableState) => {
        const destroy = vi.spyOn(instance, 'destroy').mockResolvedValue(undefined);
        try {
          await instance.expireCredentials({ runId: 'another-run' });
          await instance.cleanupReview({ runId: 'another-run' });
          const beforeCleanup = await createReviewPersistence(
            durableState.storage
          ).persistence.get<RunState>('runState');
          await instance.cleanupReview({ runId });
          return { beforeCleanup, destroyCalls: destroy.mock.calls.length };
        } finally {
          destroy.mockRestore();
        }
      }
    );

    expect(result.beforeCleanup).toMatchObject({
      runId,
      status: 'pending',
      githubToken: 'minted-token',
      input,
    });
    expect(result.destroyCalls).toBe(1);
  });

  it('rejects unauthorized reads before scheduling or loading a transcript', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId);

    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        const schedule = vi.spyOn(instance, 'schedule');
        const inspect = vi.spyOn(instance, 'inspectSubmission');
        const getMessages = vi.spyOn(instance, 'getMessages');
        try {
          return {
            review: await instance.getReview('another-user'),
            transcript: await instance.getTranscript('another-user'),
            scheduleCalls: schedule.mock.calls.length,
            inspectCalls: inspect.mock.calls.length,
            transcriptCalls: getMessages.mock.calls.length,
          };
        } finally {
          schedule.mockRestore();
          inspect.mockRestore();
          getMessages.mockRestore();
        }
      }
    );

    expect(result).toEqual({
      review: null,
      transcript: null,
      scheduleCalls: 0,
      inspectCalls: 0,
      transcriptCalls: 0,
    });
  });

  it('rejects another user before inspecting a running Think submission', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, { status: 'running', submissionId: 'private-submission' });

    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        const inspect = vi.spyOn(instance, 'inspectSubmission');
        try {
          return {
            review: await instance.getReview('another-user'),
            inspectCalls: inspect.mock.calls.length,
          };
        } finally {
          inspect.mockRestore();
        }
      }
    );

    expect(result).toEqual({ review: null, inspectCalls: 0 });
  });

  it('durably records both publication phases and still records a summary after inline publication', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, {
      status: 'running',
      headSha: HEAD_SHA,
      githubToken: 'minted-token',
    });

    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async (instance, durableState) => {
        const persistence = createReviewPersistence(durableState.storage).persistence;
        const pending: RunState[] = [];
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, options?: RequestInit) => {
            const path = new URL(url).pathname;
            if (path.includes('/compare/')) return Response.json(compareFixture());
            if (options?.method === 'POST') {
              const current = await persistence.get<RunState>('runState');
              if (!current) throw new Error('Review state was not persisted before publication');
              pending.push(current);
              return Response.json({ id: path.endsWith('/reviews') ? 17 : 22 });
            }
            if (path.endsWith('/pulls/42')) {
              return Response.json(pullFixture());
            }
            return Response.json([]);
          })
        );

        await instance.getReview('review-owner');
        const tools = instance.getTools();
        await executeTool(tools, 'pr_comments', {});
        await executeTool(tools, 'submit_review', {
          body: '',
          comments: [{ path: 'source.ts', line: 1, side: 'RIGHT', body: 'Issue' }],
        });
        const afterReview = await persistence.get<RunState>('runState');
        await executeTool(tools, 'upsert_summary', { body: 'Summary' });
        return {
          pending,
          afterReview,
          afterSummary: await persistence.get<RunState>('runState'),
        };
      }
    );

    expect(result.pending).toHaveLength(2);
    expect(result.pending[0]).toMatchObject({
      reviewPending: true,
      reviewPendingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.pending[1]).toMatchObject({
      reviewId: 17,
      reviewPending: false,
      summaryPending: true,
      summaryPendingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      published: true,
    });
    expect(result.pending[1]?.reviewPendingFingerprint).toBeUndefined();
    expect(result.afterReview).toMatchObject({
      reviewId: 17,
      reviewPending: false,
      published: true,
      publishedAt: expect.any(String),
    });
    expect(result.afterReview?.reviewPendingFingerprint).toBeUndefined();
    expect(result.afterReview?.summaryPublished).toBeUndefined();
    expect(result.afterSummary).toMatchObject({
      reviewId: 17,
      summaryCommentId: 22,
      summaryPending: false,
      summaryPublished: true,
      published: true,
      publishedAt: result.afterReview?.publishedAt,
    });
    expect(result.afterSummary?.reviewPendingFingerprint).toBeUndefined();
    expect(result.afterSummary?.summaryPendingFingerprint).toBeUndefined();
    expect(result.afterSummary?.summaryPendingCommentId).toBeUndefined();
  });

  it('serializes simultaneous inline and summary publication without losing pending or completed state', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, {
      status: 'running',
      headSha: HEAD_SHA,
      githubToken: 'minted-token',
    });

    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async (instance, durableState) => {
        const persistence = createReviewPersistence(durableState.storage).persistence;
        const headChecksReady = createGate();
        const reviewWriteStarted = createGate();
        const summaryWriteStarted = createGate();
        const releaseReview = createGate();
        const releaseSummary = createGate();
        let headChecks = 0;
        let synchronizePublication = false;
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, options?: RequestInit) => {
            const path = new URL(url).pathname;
            if (path.includes('/compare/')) return Response.json(compareFixture());
            if (path.endsWith('/pulls/42')) {
              if (synchronizePublication) {
                headChecks += 1;
                if (headChecks === 2) headChecksReady.resolve();
                await headChecksReady.promise;
              }
              return Response.json(pullFixture());
            }
            if (options?.method === 'POST' && path.endsWith('/reviews')) {
              reviewWriteStarted.resolve();
              await releaseReview.promise;
              return Response.json({ id: 17 });
            }
            if (options?.method === 'POST' && path.endsWith('/issues/42/comments')) {
              summaryWriteStarted.resolve();
              await releaseSummary.promise;
              return Response.json({ id: 22 });
            }
            return Response.json([]);
          })
        );

        await instance.getReview('review-owner');
        const tools = instance.getTools();
        await executeTool(tools, 'pr_comments', {});
        synchronizePublication = true;
        const review = executeTool(tools, 'submit_review', {
          body: 'Concurrent review',
          comments: [{ path: 'source.ts', line: 1, side: 'RIGHT', body: 'Issue' }],
        });
        const summary = executeTool(instance.getTools(), 'upsert_summary', {
          body: 'Concurrent summary',
        });

        try {
          await Promise.all([reviewWriteStarted.promise, summaryWriteStarted.promise]);
          const pending = await persistence.get<RunState>('runState');
          releaseReview.resolve();
          const reviewResult = await review;
          const afterReview = await persistence.get<RunState>('runState');
          releaseSummary.resolve();
          const summaryResult = await summary;
          return {
            pending,
            afterReview,
            reviewResult,
            summaryResult,
            state: await persistence.get<RunState>('runState'),
          };
        } finally {
          releaseReview.resolve();
          releaseSummary.resolve();
        }
      }
    );

    expect(result.pending).toMatchObject({
      reviewPending: true,
      reviewPendingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      summaryPending: true,
      summaryPendingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.pending?.reviewPendingFingerprint).not.toBe(
      result.pending?.summaryPendingFingerprint
    );
    expect(result.afterReview).toMatchObject({
      reviewId: 17,
      reviewPending: false,
      summaryPending: true,
      summaryPendingFingerprint: result.pending?.summaryPendingFingerprint,
    });
    expect(result.afterReview?.reviewPendingFingerprint).toBeUndefined();
    expect(result.reviewResult).toEqual({ id: 17 });
    expect(result.summaryResult).toEqual({ id: 22 });
    expect(result.state).toMatchObject({
      reviewId: 17,
      reviewPending: false,
      summaryCommentId: 22,
      summaryPending: false,
      summaryPublished: true,
      published: true,
    });
    expect(result.state?.reviewPendingFingerprint).toBeUndefined();
    expect(result.state?.summaryPendingFingerprint).toBeUndefined();
    expect(result.state?.summaryPendingCommentId).toBeUndefined();
  });

  it.each([
    { kind: 'review', method: 'POST' },
    { kind: 'summary', method: 'POST' },
    { kind: 'summary', method: 'PATCH' },
  ] as const)(
    'durably clears a definitively rejected $kind $method before a corrected retry',
    async ({ kind, method }) => {
      const runId = crypto.randomUUID();
      const publicationId = kind === 'review' ? 17 : method === 'PATCH' ? 9 : 22;
      await seedState(runId, {
        status: 'running',
        headSha: HEAD_SHA,
        githubToken: 'minted-token',
        input: method === 'PATCH' ? { ...input, existingSummaryCommentId: 9 } : input,
        summaryOwnership: method === 'PATCH' ? summaryOwnership : undefined,
      });

      const result = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async (instance, durableState) => {
          const persistence = createReviewPersistence(durableState.storage).persistence;
          const pendingStates: RunState[] = [];
          let writeCalls = 0;
          vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, options?: RequestInit) => {
              const path = new URL(url).pathname;
              if (path.includes('/compare/')) return Response.json(compareFixture());
              if (options?.method === method) {
                writeCalls += 1;
                const state = await persistence.get<RunState>('runState');
                if (!state) throw new Error('Publication state is missing');
                pendingStates.push(state);
                if (writeCalls === 1) {
                  return new Response('{"message":"invalid publication"}', { status: 422 });
                }
                return Response.json({ id: publicationId });
              }
              if (options?.method === 'POST' || options?.method === 'PATCH') {
                throw new Error(`Unexpected ${options.method} publication`);
              }
              if (path.endsWith('/issues/comments/9')) {
                return Response.json({
                  id: 9,
                  body: '<!-- kilo-review -->\nExisting summary',
                  issue_url: 'https://api.github.com/repos/acme/widget/issues/42',
                  user: { login: 'kilo-code[bot]' },
                });
              }
              if (path.endsWith('/pulls/42')) {
                return Response.json(pullFixture());
              }
              return Response.json([]);
            })
          );

          await instance.getReview('review-owner');
          const tools = instance.getTools();
          const name = kind === 'review' ? 'submit_review' : 'upsert_summary';
          const initial =
            kind === 'review'
              ? {
                  body: '',
                  comments: [{ path: 'source.ts', line: 1, side: 'RIGHT', body: 'Issue' }],
                }
              : { body: 'Invalid summary' };
          const corrected =
            kind === 'review'
              ? {
                  body: '',
                  comments: [
                    { path: 'source.ts', line: 2, side: 'RIGHT', body: 'Corrected issue' },
                  ],
                }
              : { body: 'Corrected summary' };
          if (kind === 'review') await executeTool(tools, 'pr_comments', {});
          const rejection = await executeTool(tools, name, initial);
          const rejectedState = await persistence.get<RunState>('runState');
          const publication = await executeTool(tools, name, corrected);
          return {
            rejection,
            rejectedState,
            publication,
            pendingStates,
            writeCalls,
            publishedState: await persistence.get<RunState>('runState'),
          };
        }
      );

      expect(result.rejection).toEqual({
        error: '{"message":"invalid publication"}',
        status: 422,
        publicationOutcome: 'rejected',
      });
      expect(result.rejectedState).toMatchObject(
        kind === 'review' ? { reviewPending: false } : { summaryPending: false }
      );
      expect(result.rejectedState?.published).toBeUndefined();
      expect(result.rejectedState?.reviewPendingFingerprint).toBeUndefined();
      expect(result.rejectedState?.summaryPendingFingerprint).toBeUndefined();
      expect(result.rejectedState?.summaryPendingCommentId).toBeUndefined();
      expect(result.pendingStates).toHaveLength(2);
      const fingerprints = result.pendingStates.map(state =>
        kind === 'review' ? state.reviewPendingFingerprint : state.summaryPendingFingerprint
      );
      expect(fingerprints).toEqual([
        expect.stringMatching(/^[a-f0-9]{64}$/),
        expect.stringMatching(/^[a-f0-9]{64}$/),
      ]);
      expect(fingerprints[0]).not.toBe(fingerprints[1]);
      expect(
        result.pendingStates.every(state =>
          kind === 'review' ? state.reviewPending : state.summaryPending
        )
      ).toBe(true);
      if (method === 'PATCH') {
        expect(result.pendingStates).toEqual([
          expect.objectContaining({ summaryPendingCommentId: 9 }),
          expect.objectContaining({ summaryPendingCommentId: 9 }),
        ]);
      }
      expect(result.publication).toEqual({ id: publicationId });
      expect(result.publishedState).toMatchObject(
        kind === 'review'
          ? { reviewId: 17, reviewPending: false, published: true }
          : { summaryCommentId: publicationId, summaryPending: false, summaryPublished: true }
      );
      expect(result.publishedState?.reviewPendingFingerprint).toBeUndefined();
      expect(result.publishedState?.summaryPendingFingerprint).toBeUndefined();
      expect(result.publishedState?.summaryPendingCommentId).toBeUndefined();
      expect(result.writeCalls).toBe(2);
    }
  );

  it.each(
    (['review', 'summary'] as const).flatMap(kind =>
      [false, true].flatMap(dryRun =>
        (['before-call', 'preflight', 'after-proposal'] as const).map(timing => ({
          kind,
          dryRun,
          timing,
        }))
      )
    )
  )(
    'fences unfinished children $timing and retries the same $kind tool after completion (dryRun=$dryRun)',
    async ({ kind, dryRun, timing }) => {
      const runId = crypto.randomUUID();
      const actualGithub = await vi.importActual<typeof GithubModule>('../../src/github');
      await seedState(runId, {
        status: 'running',
        headSha: HEAD_SHA,
        githubToken: 'minted-token',
        input: { ...input, dryRun },
        summaryProposal,
        reviewProposal: { fingerprint: 'a'.repeat(64), publishable: true },
      });
      const result = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async (instance, durableState) => {
          const persistence = createReviewPersistence(durableState.storage).persistence;
          const preflightEntered = createGate();
          const releasePreflight = createGate();
          const assignment = {
            description: 'Required investigation',
            prompt: 'Inspect the required evidence.',
            subagent_type: 'general',
            task_id: 'required-child',
          };
          let childFinishes = false;
          let writes = 0;
          let tools: ToolSet = {};
          let runningChild: RunState | undefined;
          const startChild = async () => {
            expect(await executeTool(tools, 'task', assignment)).toMatchObject({
              metadata: { taskId: 'required-child', state: 'error' },
            });
          };
          vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, options?: RequestInit) => {
              const path = new URL(url).pathname;
              if (path.endsWith('/chat/completions')) {
                runningChild ??= await persistence.get<RunState>('runState');
                return chatReply(childFinishes ? 'stop' : 'length');
              }
              if (timing === 'preflight' && path.endsWith('/pulls/42')) {
                preflightEntered.resolve();
                await releasePreflight.promise;
              }
              if (options?.method === 'POST' || options?.method === 'PATCH') writes++;
              return fixtureGithubResponse(url, options);
            })
          );
          if (timing === 'after-proposal') {
            vi.mocked(createGithubTools).mockImplementationOnce(options =>
              actualGithub.createGithubTools({
                ...options,
                onProposal: async event => {
                  await options.onProposal?.(event);
                  await startChild();
                },
              })
            );
          }
          await instance.getReview('review-owner');
          tools = instance.getTools();
          const name = kind === 'review' ? 'submit_review' : 'upsert_summary';
          const args =
            kind === 'review'
              ? { comments: [{ path: 'source.ts', line: 1, side: 'RIGHT', body: 'Issue' }] }
              : { body: 'Completed summary' };
          try {
            if (timing === 'before-call') await startChild();
            const rejected = expect(executeTool(tools, name, args)).rejects.toThrow(
              'Required child investigations are incomplete; refusing publication'
            );
            if (timing === 'preflight') {
              await preflightEntered.promise;
              await startChild();
              releasePreflight.resolve();
            }
            await rejected;
            const blocked = await persistence.get<RunState>('runState');
            expect(writes).toBe(0);
            expect(blocked?.analysisOutcome?.incompleteTaskIds).toEqual(['required-child']);
            expect(blocked?.reviewProposal?.publishable).toBe(false);
            expect(blocked?.summaryProposal?.publishable).toBe(false);
            expect(blocked?.reviewPending).not.toBe(true);
            expect(blocked?.summaryPending).not.toBe(true);
            expect(blocked?.reviewPublicationAttempts).toBeUndefined();
            expect(blocked?.summaryPublicationAttempts).toBeUndefined();
            expect(blocked?.publicationOutcome?.[kind]).toBe('rejected');
            expect(blocked?.analysisOutcome?.contextIncompleteReasons ?? []).toEqual([]);
            childFinishes = true;
            const resumed = await executeTool(tools, 'task', assignment);
            expect(resumed).toMatchObject({
              metadata: {
                taskId: 'required-child',
                sessionId: blocked?.taskSessions?.[0]?.sessionId,
                state: 'completed',
                resumed: true,
              },
            });
            const completed = await persistence.get<RunState>('runState');
            expect(completed?.analysisOutcome?.incompleteTaskIds).toEqual([]);
            expect(completed?.analysisOutcome?.parentFinished).not.toBe(true);
            expect(completed?.taskSessions).toEqual(blocked?.taskSessions);
            const publication = await executeTool(tools, name, args);
            return {
              runningChild,
              publication,
              writes,
              state: await persistence.get<RunState>('runState'),
            };
          } finally {
            releasePreflight.resolve();
          }
        }
      );
      expect(result.runningChild).toMatchObject({
        analysisOutcome: { incompleteTaskIds: ['required-child'] },
        reviewProposal: { publishable: false },
        summaryProposal: { publishable: false },
      });
      expect(result.publication).toMatchObject(
        dryRun ? { dryRun: true, publishable: true } : { id: kind === 'review' ? 17 : 22 }
      );
      expect(result.writes).toBe(dryRun ? 0 : 1);
      expect(result.state?.publicationOutcome?.[kind]).toBe(dryRun ? 'proposed' : 'confirmed');
      expect(
        (kind === 'review' ? result.state?.reviewProposal : result.state?.summaryProposal)
          ?.publishable
      ).toBe(true);
      expect(result.state?.analysisOutcome?.incompleteTaskIds).toEqual([]);
      expect(result.state?.analysisOutcome?.contextIncompleteReasons ?? []).toEqual([]);
    }
  );

  it.each(['review', 'summary'] as const)(
    'checks persisted context immediately before a new %s write',
    async kind => {
      const runId = crypto.randomUUID();
      await seedState(runId, { status: 'running', headSha: HEAD_SHA, githubToken: 'minted-token' });
      const fetchMock = vi.fn(async (url: string, options?: RequestInit) =>
        fixtureGithubResponse(url, options)
      );
      vi.stubGlobal('fetch', fetchMock);
      const result = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async (instance, durableState) => {
          await instance.getReview('review-owner');
          const tools = instance.getTools();
          const persistence = createReviewPersistence(durableState.storage).persistence;
          const state = await persistence.get<RunState>('runState');
          if (!state) throw new Error('Missing review fixture');
          await persistence.put('runState', {
            ...state,
            analysisOutcome: {
              status: 'running',
              stepCount: 0,
              contextIncompleteReasons: ['Missing immutable evidence'],
            },
          } satisfies RunState);
          await expect(
            executeTool(
              tools,
              kind === 'review' ? 'submit_review' : 'upsert_summary',
              kind === 'review'
                ? { comments: [{ path: 'source.ts', line: 1, side: 'RIGHT', body: 'Issue' }] }
                : { body: 'Summary' }
            )
          ).rejects.toThrow('Required review context is incomplete; refusing publication');
          const rejected = await persistence.get<RunState>('runState');
          await finishSubmission(instance, runId);
          return { rejected, review: await instance.getReview('review-owner') };
        }
      );
      expect(
        fetchMock.mock.calls.some(
          ([, options]) => options?.method === 'POST' || options?.method === 'PATCH'
        )
      ).toBe(false);
      expect(result.rejected?.reviewPending).not.toBe(true);
      expect(result.rejected?.summaryPending).not.toBe(true);
      expect(result.rejected?.publicationOutcome?.[kind]).toBe('rejected');
      expect(result.review).toMatchObject({
        status: 'error',
        terminationReason: 'required_context_incomplete',
      });
    }
  );

  it('restores persisted context incompleteness into reconstructed GitHub tools', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, {
      status: 'running',
      headSha: HEAD_SHA,
      githubToken: 'minted-token',
      analysisOutcome: {
        status: 'running',
        stepCount: 1,
        contextIncompleteReasons: ['Missing immutable evidence'],
      },
    });
    await abortAllDurableObjects();
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) =>
      fixtureGithubResponse(url, options)
    );
    vi.stubGlobal('fetch', fetchMock);
    await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        await instance.getReview('review-owner');
        await expect(
          executeTool(instance.getTools(), 'upsert_summary', { body: 'Summary' })
        ).resolves.toMatchObject({
          publishable: false,
          blockedReason: 'Missing immutable evidence',
        });
      }
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(readState(runId)).resolves.toMatchObject({
      analysisOutcome: { contextIncompleteReasons: ['Missing immutable evidence'] },
      publicationOutcome: { summary: 'rejected' },
    });
  });

  describe('durable optional history', () => {
    it('rehydrates the selected delta, discovered SHA authority, and shared 20-request budget after real eviction', async () => {
      const runId = crypto.randomUUID();
      const selection = incrementalSelection(crypto.randomUUID());
      await seedState(runId, {
        status: 'running',
        headSha: HEAD_SHA,
        githubToken: 'minted-token',
        input: preparedReviewInput(selection),
        reviewSelection: selection,
        historyState: { requestCount: 17, commitShas: [] },
      });
      const fetchMock = vi.fn(async (url: string, options?: RequestInit) =>
        historyGithubResponse(url, options)
      );
      vi.stubGlobal('fetch', fetchMock);
      await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          await instance.getReview('review-owner');
          expect(await executeTool(instance.getTools(), 'pr_history', {})).toMatchObject({
            available: true,
            commits: [{ sha: HISTORY_SHA, parents: [HISTORY_PARENT_SHA] }],
          });
        }
      );
      expect((await readState(runId))?.historyState).toEqual({
        requestCount: 18,
        commitShas: [HISTORY_SHA],
      });
      await abortAllDurableObjects();
      const result = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          const rehydrated = await instance.getReview('review-owner');
          const tools = instance.getTools();
          expect(await executeTool(tools, 'pr_commit', { sha: HISTORY_PARENT_SHA })).toMatchObject({
            available: false,
          });
          expect(await executeTool(tools, 'pr_commit', { sha: HISTORY_SHA })).toMatchObject({
            available: true,
            sha: HISTORY_SHA,
          });
          expect(
            await executeTool(tools, 'pr_file', {
              path: 'source.ts',
              revision: 'history',
              commitSha: HISTORY_SHA,
            })
          ).toMatchObject({ available: true, body: 'Historical source' });
          expect(await executeTool(instance.getTools(), 'pr_history', {})).toMatchObject({
            available: false,
            complete: false,
          });
          expect(await executeTool(tools, 'pr_commit', { sha: HEAD_SHA })).toMatchObject({
            available: false,
          });
          const diff = await executeTool(instance.getTools(), 'pr_diff', {});
          await executeTool(instance.getTools(), 'upsert_summary', {
            body: 'Review remains complete',
          });
          await finishSubmission(instance, runId);
          return { rehydrated, diff, review: await instance.getReview('review-owner') };
        }
      );
      expect(result.rehydrated?.reviewSelection).toEqual(selection);
      expect(result.diff).toMatchObject({ previousHeadSha: FIRST_HEAD, fileCount: 1 });
      expect(result.review).toMatchObject({
        status: 'completed',
        terminationReason: 'completed',
        reviewSelection: selection,
        analysisOutcome: { status: 'completed' },
      });
      const state = await readState(runId);
      expect(state?.historyState).toEqual({ requestCount: 20, commitShas: [HISTORY_SHA] });
      expect(state?.analysisOutcome?.contextIncompleteReasons ?? []).toEqual([]);
      const optionalRequests = fetchMock.mock.calls.filter(([url]) =>
        /\/commits(?:\/|\?)|\/contents\//.test(url)
      );
      expect(optionalRequests).toHaveLength(3);
      expect(
        fetchMock.mock.calls.every(([, options]) => (options?.method ?? 'GET') === 'GET')
      ).toBe(true);
    });

    it('reserves the final request before HTTP and shares it across concurrent reconstructed tools and a task child', async () => {
      const runId = crypto.randomUUID();
      await seedState(runId, {
        status: 'running',
        headSha: HEAD_SHA,
        githubToken: 'minted-token',
        historyState: { requestCount: 19, commitShas: [] },
      });
      const result = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async (instance, durableState) => {
          const persistence = createReviewPersistence(durableState.storage).persistence;
          const entered = createGate();
          const release = createGate();
          let reads = 0;
          let modelReplies = 0;
          let beforeHttp: RunState | undefined;
          let childHistory: unknown;
          vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, options?: RequestInit) => {
              if (new URL(url).pathname.endsWith('/chat/completions')) {
                if (modelReplies++ === 0) {
                  return chatReply('tool_calls', [
                    {
                      id: 'child-history-call',
                      type: 'function',
                      function: { name: 'pr_history', arguments: '{}' },
                    },
                  ]);
                }
                if (typeof options?.body !== 'string') throw new Error('Missing child request');
                const body = JSON.parse(options.body) as {
                  messages: Array<{ role: string; content: string }>;
                };
                const toolMessage = body.messages.find(message => message.role === 'tool');
                if (!toolMessage) throw new Error('Missing child history result');
                childHistory = JSON.parse(toolMessage.content);
                return chatReply();
              }
              if (!new URL(url).pathname.endsWith('/commits')) {
                throw new Error('Unexpected offline history request');
              }
              reads++;
              if (reads === 1) {
                beforeHttp = await persistence.get<RunState>('runState');
                entered.resolve();
                await release.promise;
              }
              return Response.json([historyCommitFixture()]);
            })
          );
          await instance.getReview('review-owner');
          const parentTools = instance.getTools();
          const reconstructedTools = instance.getTools();
          const pending = executeTool(parentTools, 'pr_history', {});
          try {
            await entered.promise;
            const blocked = await executeTool(reconstructedTools, 'pr_history', {
              path: 'source.ts',
            });
            const child = await executeTool(reconstructedTools, 'task', {
              description: 'Historical context',
              prompt: 'Inspect optional history.',
              subagent_type: 'explore',
              task_id: 'history-child',
            });
            release.resolve();
            const history = await pending;
            return {
              beforeHttp,
              reads,
              blocked,
              child,
              childHistory,
              history,
              state: await persistence.get<RunState>('runState'),
            };
          } finally {
            release.resolve();
          }
        }
      );
      expect(result.beforeHttp?.historyState).toEqual({ requestCount: 20, commitShas: [] });
      expect(result.reads).toBe(1);
      expect(result.blocked).toMatchObject({ available: false, complete: false });
      expect(result.childHistory).toMatchObject({ available: false, complete: false });
      expect(result.child).toMatchObject({ metadata: { state: 'completed' } });
      expect(result.history).toMatchObject({ available: true, commits: [{ sha: HISTORY_SHA }] });
      expect(result.state?.historyState).toEqual({ requestCount: 20, commitShas: [HISTORY_SHA] });
      expect(result.state?.analysisOutcome?.contextIncompleteReasons ?? []).toEqual([]);
      expect(result.state?.analysisOutcome?.incompleteTaskIds).toEqual([]);
    });

    it('does not refund the last persisted request or send a retry after optional history fails', async () => {
      const runId = crypto.randomUUID();
      await seedState(runId, {
        status: 'running',
        headSha: HEAD_SHA,
        githubToken: 'minted-token',
        historyState: { requestCount: 19, commitShas: [] },
      });
      const fetchMock = vi.fn(async () => new Response('Unavailable', { status: 503 }));
      vi.stubGlobal('fetch', fetchMock);
      await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          await instance.getReview('review-owner');
          expect(await executeTool(instance.getTools(), 'pr_history', {})).toMatchObject({
            available: false,
          });
          expect(
            await executeTool(instance.getTools(), 'pr_commit', { sha: HEAD_SHA })
          ).toMatchObject({ available: false });
        }
      );
      expect(fetchMock).toHaveBeenCalledOnce();
      expect((await readState(runId))?.historyState).toEqual({ requestCount: 20, commitShas: [] });
      expect((await readState(runId))?.analysisOutcome?.contextIncompleteReasons ?? []).toEqual([]);
    });

    it('atomically caps discoveries at 100 across stale tool closures and never exposes or authorizes the rejected SHA', async () => {
      const runId = crypto.randomUUID();
      const known = Array.from({ length: 99 }, (_, index) =>
        (index + 1).toString(16).padStart(40, '0')
      );
      const secondSha = '3'.repeat(40);
      await seedState(runId, {
        status: 'running',
        headSha: HEAD_SHA,
        githubToken: 'minted-token',
        historyState: { requestCount: 0, commitShas: known },
      });
      const fetchMock = vi.fn(async (url: string) =>
        Response.json([
          historyCommitFixture(
            new URL(url).searchParams.get('path') === 'first.ts' ? HISTORY_SHA : secondSha
          ),
        ])
      );
      vi.stubGlobal('fetch', fetchMock);
      const results = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          await instance.getReview('review-owner');
          const first = instance.getTools();
          const second = instance.getTools();
          return Promise.all([
            executeTool(first, 'pr_history', { path: 'first.ts' }),
            executeTool(second, 'pr_history', { path: 'second.ts' }),
          ]);
        }
      );
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ available: true }),
          expect.objectContaining({ available: false, complete: false }),
        ])
      );
      const state = await readState(runId);
      expect(state?.historyState?.requestCount).toBe(2);
      expect(state?.historyState?.commitShas).toHaveLength(100);
      const discovered = state?.historyState?.commitShas.filter(sha => !known.includes(sha));
      expect(discovered).toHaveLength(1);
      const rejectedSha = discovered?.includes(HISTORY_SHA) ? secondSha : HISTORY_SHA;
      expect(JSON.stringify(results)).not.toContain(rejectedSha);
      await abortAllDurableObjects();
      await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          await instance.getReview('review-owner');
          expect(
            await executeTool(instance.getTools(), 'pr_commit', { sha: rejectedSha })
          ).toMatchObject({ available: false });
        }
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((await readState(runId))?.historyState).toEqual(state?.historyState);
      expect(state?.analysisOutcome?.contextIncompleteReasons ?? []).toEqual([]);
    });

    it.each(['cancellation', 'execution deadline'] as const)(
      'does not authorize late discoveries or new history reads after %s',
      async termination => {
        const runId = crypto.randomUUID();
        const deadline = Date.now() + 60_000;
        await seedState(runId, {
          status: 'running',
          headSha: HEAD_SHA,
          githubToken: 'minted-token',
          executionDeadlineAt: deadline,
          historyState: { requestCount: 0, commitShas: [] },
        });
        const result = await runInDurableObject(
          env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
          async (instance, durableState) => {
            const persistence = createReviewPersistence(durableState.storage).persistence;
            const entered = createGate();
            const release = createGate();
            const fetchMock = vi.fn(async () => {
              entered.resolve();
              await release.promise;
              return Response.json([historyCommitFixture()]);
            });
            vi.stubGlobal('fetch', fetchMock);
            await instance.getReview('review-owner');
            const tools = instance.getTools();
            const pending = executeTool(tools, 'pr_history', {});
            await entered.promise;
            const clock =
              termination === 'execution deadline'
                ? vi.spyOn(Date, 'now').mockReturnValue(deadline + 1)
                : undefined;
            try {
              if (termination === 'cancellation') await instance.cancelReview('review-owner');
              else await instance.expireReview({ runId });
              const terminal = await persistence.get<RunState>('runState');
              release.resolve();
              const history = await pending;
              const later = await Promise.all([
                executeTool(tools, 'pr_history', {}),
                executeTool(tools, 'pr_commit', { sha: HEAD_SHA }),
                executeTool(tools, 'pr_file', {
                  path: 'source.ts',
                  revision: 'history',
                  commitSha: HEAD_SHA,
                }),
              ]);
              return {
                terminal,
                history,
                later,
                reads: fetchMock.mock.calls.length,
                state: await persistence.get<RunState>('runState'),
              };
            } finally {
              release.resolve();
              clock?.mockRestore();
            }
          }
        );
        expect(result.history).toMatchObject({ available: false, complete: false });
        expect(result.history).not.toHaveProperty('commits');
        for (const later of result.later) expect(later).toMatchObject({ available: false });
        expect(result.reads).toBe(1);
        expect(result.state).toEqual(result.terminal);
        expect(result.state).toMatchObject({
          status: 'error',
          terminationReason: termination === 'cancellation' ? 'cancelled' : 'execution_deadline',
          historyState: { requestCount: 1, commitShas: [] },
          input: { gitToken: '', kiloToken: '' },
        });
        expect(result.state?.analysisOutcome?.contextIncompleteReasons ?? []).toEqual([]);
      }
    );
  });

  it.each(['review', 'summary'] as const)(
    'persists the %s reconciliation budget across tool and DO recreation without another write',
    async kind => {
      const runId = crypto.randomUUID();
      await seedState(runId, { status: 'running', headSha: HEAD_SHA, githubToken: 'minted-token' });
      let writes = 0;
      let reconciliationReads = 0;
      const reconciliationPath = kind === 'review' ? '/pulls/42/reviews' : '/issues/42/comments';
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, options?: RequestInit) => {
          if (options?.method === 'POST' || options?.method === 'PATCH') {
            writes++;
            throw new Error('Lost publication response');
          }
          if (writes && new URL(url).pathname.endsWith(reconciliationPath)) reconciliationReads++;
          return fixtureGithubResponse(url, options);
        })
      );
      const name = kind === 'review' ? 'submit_review' : 'upsert_summary';
      const args =
        kind === 'review'
          ? { comments: [{ path: 'source.ts', line: 1, side: 'RIGHT', body: 'Issue' }] }
          : { body: 'Summary' };
      const counter =
        kind === 'review' ? 'reviewReconciliationAttempts' : 'summaryReconciliationAttempts';
      await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          await instance.getReview('review-owner');
          await expect(executeTool(instance.getTools(), name, args)).rejects.toThrow(
            'Lost publication response'
          );
          await expect(executeTool(instance.getTools(), name, args)).rejects.toThrow(
            /publication is pending/i
          );
        }
      );
      expect((await readState(runId))?.[counter]).toBe(1);
      await abortAllDurableObjects();
      const review = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          await instance.getReview('review-owner');
          await expect(executeTool(instance.getTools(), name, args)).rejects.toThrow(
            /publication is pending/i
          );
          expect(reconciliationReads).toBe(2);
          await expect(executeTool(instance.getTools(), name, args)).rejects.toThrow(
            /reconciliation budget exhausted/i
          );
          return instance.getReview('review-owner');
        }
      );
      expect(review?.[counter]).toBe(2);
      expect(reconciliationReads).toBe(2);
      expect(writes).toBe(1);
      expect((await readState(runId))?.publicationOutcome?.[kind]).toBe('pending');
    }
  );

  it('reserves reconciliation capacity atomically without holding the queue during reads', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, { status: 'running', headSha: HEAD_SHA, githubToken: 'minted-token' });
    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        const entered = createGate();
        const release = createGate();
        let writes = 0;
        let reads = 0;
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, options?: RequestInit) => {
            if (options?.method === 'POST') {
              writes++;
              throw new Error('Lost publication response');
            }
            if (writes && new URL(url).pathname.endsWith('/issues/42/comments')) {
              reads++;
              if (reads === 2) entered.resolve();
              await release.promise;
            }
            return fixtureGithubResponse(url, options);
          })
        );
        await instance.getReview('review-owner');
        const args = { body: 'Summary' };
        await expect(executeTool(instance.getTools(), 'upsert_summary', args)).rejects.toThrow(
          'Lost publication response'
        );
        const firstTools = instance.getTools();
        const secondTools = instance.getTools();
        const thirdTools = instance.getTools();
        const first = expect(executeTool(firstTools, 'upsert_summary', args)).rejects.toThrow(
          /publication is pending/i
        );
        const second = expect(executeTool(secondTools, 'upsert_summary', args)).rejects.toThrow(
          /publication is pending/i
        );
        try {
          await entered.promise;
          await expect(executeTool(thirdTools, 'upsert_summary', args)).rejects.toThrow(
            /reconciliation budget exhausted/i
          );
          const state = await instance.getReview('review-owner');
          release.resolve();
          await Promise.all([first, second]);
          return { writes, reads, state };
        } finally {
          release.resolve();
        }
      }
    );
    expect(result).toMatchObject({
      writes: 1,
      reads: 2,
      state: {
        status: 'running',
        summaryReconciliationAttempts: 2,
        publicationOutcome: { summary: 'pending' },
      },
    });
  });

  it('keeps an original late acknowledgement confirmed when its concurrent read-only reconciliation fails', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, { status: 'running', headSha: HEAD_SHA, githubToken: 'minted-token' });
    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        const writing = createGate();
        const reading = createGate();
        const releaseWrite = createGate();
        const releaseRead = createGate();
        let writes = 0;
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, options?: RequestInit) => {
            if (options?.method === 'POST') {
              writes++;
              writing.resolve();
              await releaseWrite.promise;
            } else if (writes && new URL(url).pathname.endsWith('/issues/42/comments')) {
              reading.resolve();
              await releaseRead.promise;
            }
            return fixtureGithubResponse(url, options);
          })
        );
        await instance.getReview('review-owner');
        const args = { body: 'Summary' };
        const original = executeTool(instance.getTools(), 'upsert_summary', args);
        try {
          await writing.promise;
          const reconciliation = expect(
            executeTool(instance.getTools(), 'upsert_summary', args)
          ).rejects.toThrow(/publication is pending/i);
          await reading.promise;
          releaseWrite.resolve();
          await original;
          releaseRead.resolve();
          await reconciliation;
          await finishSubmission(instance, runId);
          return { writes, review: await instance.getReview('review-owner') };
        } finally {
          releaseWrite.resolve();
          releaseRead.resolve();
        }
      }
    );
    expect(result).toMatchObject({
      writes: 1,
      review: {
        status: 'completed',
        summaryCommentId: 22,
        published: true,
        publicationOutcome: { summary: 'confirmed' },
      },
    });
  });

  it('does not let a late repeated acknowledgement erase rejection of an intended correction', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, { status: 'running', headSha: HEAD_SHA, githubToken: 'minted-token' });
    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        const reading = createGate();
        const release = createGate();
        let writes = 0;
        let reads = 0;
        let publishedBody = '';
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, options?: RequestInit) => {
            if (options?.method === 'POST') {
              writes++;
              if (typeof options.body !== 'string') throw new Error('Missing publication payload');
              publishedBody = (JSON.parse(options.body) as { body: string }).body;
              throw new Error('Lost publication response');
            }
            if (writes && new URL(url).pathname.endsWith('/issues/42/comments')) {
              reads++;
              if (reads === 2) {
                reading.resolve();
                await release.promise;
              }
              return Response.json([
                {
                  id: 22,
                  body: publishedBody,
                  user: { login: 'kilo-code[bot]' },
                  issue_url: 'https://api.github.com/repos/acme/widget/issues/42',
                },
              ]);
            }
            return fixtureGithubResponse(url, options);
          })
        );
        await instance.getReview('review-owner');
        const args = { body: 'Summary' };
        await expect(executeTool(instance.getTools(), 'upsert_summary', args)).rejects.toThrow(
          'Lost publication response'
        );
        const firstTools = instance.getTools();
        const secondTools = instance.getTools();
        const first = executeTool(firstTools, 'upsert_summary', args);
        const second = executeTool(secondTools, 'upsert_summary', args);
        try {
          await reading.promise;
          await first;
          await expect(
            executeTool(instance.getTools(), 'upsert_summary', { body: 'Corrected summary' })
          ).rejects.toThrow(/conflicting/);
          release.resolve();
          await second;
          await finishSubmission(instance, runId);
          return { writes, review: await instance.getReview('review-owner') };
        } finally {
          release.resolve();
        }
      }
    );
    expect(result).toMatchObject({
      writes: 1,
      review: {
        status: 'error',
        terminationReason: 'publication_incomplete',
        summaryCommentId: 22,
        published: true,
        publicationOutcome: { summary: 'rejected' },
      },
    });
  });

  it.each([
    { kind: 'review', rejected: 'conflicting' },
    { kind: 'summary', rejected: 'conflicting' },
    { kind: 'review', rejected: 'invalid' },
    { kind: 'summary', rejected: 'invalid' },
  ] as const)(
    'retains confirmed IDs but rejects completion after a $rejected new $kind publication',
    async ({ kind, rejected }) => {
      const runId = crypto.randomUUID();
      await seedState(runId, { status: 'running', headSha: HEAD_SHA, githubToken: 'minted-token' });
      const fetchMock = vi.fn(async (url: string, options?: RequestInit) =>
        fixtureGithubResponse(url, options)
      );
      vi.stubGlobal('fetch', fetchMock);
      const result = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async (instance, durableState) => {
          await instance.getReview('review-owner');
          const persistence = createReviewPersistence(durableState.storage).persistence;
          const tools = instance.getTools();
          const reviewArgs = {
            comments: [{ path: 'source.ts', line: 1, side: 'RIGHT', body: 'Issue' }],
          };
          const summaryArgs = { body: 'Summary' };
          await executeTool(tools, 'submit_review', reviewArgs);
          await executeTool(tools, 'upsert_summary', summaryArgs);
          const confirmed = await persistence.get<RunState>('runState');
          const name = kind === 'review' ? 'submit_review' : 'upsert_summary';
          const replay = await executeTool(
            instance.getTools(),
            name,
            kind === 'review' ? reviewArgs : summaryArgs
          );
          expect(replay).toEqual({ id: kind === 'review' ? 17 : 22 });
          expect((await persistence.get<RunState>('runState'))?.publicationOutcome?.[kind]).toBe(
            'confirmed'
          );
          const changed =
            kind === 'review'
              ? {
                  comments: [
                    {
                      path: 'source.ts',
                      line: 1,
                      side: rejected === 'invalid' ? 'LEFT' : 'RIGHT',
                      body: 'Corrected issue',
                    },
                  ],
                }
              : { body: rejected === 'invalid' ? '' : 'Corrected summary' };
          const failure = executeTool(instance.getTools(), name, changed);
          if (rejected === 'conflicting') await expect(failure).rejects.toThrow(/conflicting/);
          else await expect(failure).resolves.toHaveProperty('error');
          await finishSubmission(instance, runId);
          return {
            confirmed,
            state: await persistence.get<RunState>('runState'),
            review: await instance.getReview('review-owner'),
          };
        }
      );
      expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(
        2
      );
      expect(result.state).toMatchObject({
        status: 'error',
        terminationReason: 'publication_incomplete',
        reviewId: 17,
        summaryCommentId: 22,
        reviewFingerprint: result.confirmed?.reviewFingerprint,
        summaryFingerprint: result.confirmed?.summaryFingerprint,
        summaryBodyHash: result.confirmed?.summaryBodyHash,
        published: true,
        publishedAt: result.confirmed?.publishedAt,
      });
      expect(result.review?.publicationOutcome?.[kind]).toBe('rejected');
      expect(result.review?.analysisOutcome?.status).toBe('completed');
    }
  );

  it('bounds definitive publication retries even when tools are reconstructed', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, { status: 'running', headSha: HEAD_SHA, githubToken: 'minted-token' });
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) =>
      options?.method === 'POST'
        ? Response.json({ message: 'invalid publication' }, { status: 422 })
        : fixtureGithubResponse(url, options)
    );
    vi.stubGlobal('fetch', fetchMock);
    await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        await instance.getReview('review-owner');
        for (const attempt of [1, 2]) {
          const result = await executeTool(instance.getTools(), 'submit_review', {
            comments: [{ path: 'source.ts', line: 1, side: 'RIGHT', body: `Issue ${attempt}` }],
          });
          expect(result).toMatchObject({ status: 422, publicationOutcome: 'rejected' });
        }
        await expect(
          executeTool(instance.getTools(), 'submit_review', {
            comments: [{ path: 'source.ts', line: 1, side: 'RIGHT', body: 'Issue 3' }],
          })
        ).rejects.toThrow('Publication retry budget exhausted');
      }
    );
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(
      2
    );
    await expect(readState(runId)).resolves.toMatchObject({
      reviewPublicationAttempts: 2,
      reviewPending: false,
      publicationOutcome: { review: 'rejected' },
    });
  });

  it.each(['review', 'summary'] as const)(
    'recovers an accepted %s publication after transport interruption without another POST',
    async kind => {
      const runId = crypto.randomUUID();
      await seedState(runId, {
        status: 'running',
        headSha: HEAD_SHA,
        githubToken: 'minted-token',
      });

      const result = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async (instance, durableState) => {
          const persistence = createReviewPersistence(durableState.storage).persistence;
          const publishedReviews: Array<Record<string, unknown>> = [];
          const publishedReviewComments: Array<Record<string, unknown>> = [];
          const publishedIssueComments: Array<Record<string, unknown>> = [];
          let postCalls = 0;
          let requestCalls = 0;
          vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, options?: RequestInit) => {
              requestCalls += 1;
              const path = new URL(url).pathname;
              if (path.includes('/compare/')) return Response.json(compareFixture());
              if (options?.method === 'POST') {
                postCalls += 1;
                if (typeof options.body !== 'string')
                  throw new Error('Publication body is missing');
                const payload = JSON.parse(options.body) as {
                  commit_id?: string;
                  body: string;
                  comments?: Array<Record<string, unknown>>;
                };
                if (kind === 'review') {
                  publishedReviews.push({
                    id: 17,
                    commit_id: payload.commit_id,
                    state: 'COMMENTED',
                    pull_request_url: 'https://api.github.com/repos/acme/widget/pulls/42',
                    body: payload.body,
                    user: { login: 'kilo-code[bot]' },
                  });
                  publishedReviewComments.push(
                    ...(payload.comments ?? []).map((comment, index) =>
                      inlineFixture(comment, index + 1)
                    )
                  );
                } else {
                  publishedIssueComments.push({
                    id: 22,
                    body: payload.body,
                    issue_url: 'https://api.github.com/repos/acme/widget/issues/42',
                    user: { login: 'kilo-code[bot]' },
                  });
                }
                throw new Error('connection interrupted after acceptance');
              }
              if (path.endsWith('/pulls/42')) return Response.json(pullFixture());
              if (path.endsWith('/reviews/17/comments'))
                return Response.json(publishedReviewComments);
              if (path.endsWith('/reviews/99/comments')) {
                return Response.json([
                  inlineFixture({
                    path: 'other.ts',
                    line: 9,
                    side: 'RIGHT',
                    body: 'Different issue',
                  }),
                ]);
              }
              if (path.endsWith('/pulls/42/reviews')) return Response.json(publishedReviews);
              if (path.endsWith('/issues/42/comments'))
                return Response.json(publishedIssueComments);
              return Response.json([]);
            })
          );

          await instance.getReview('review-owner');
          const tools = instance.getTools();
          const name = kind === 'review' ? 'submit_review' : 'upsert_summary';
          const args =
            kind === 'review'
              ? {
                  body: 'Review body',
                  comments: [{ path: 'source.ts', line: 1, side: 'RIGHT', body: 'Issue' }],
                }
              : { body: 'Summary' };
          if (kind === 'review') await executeTool(tools, 'pr_comments', {});
          await expect(executeTool(tools, name, args)).rejects.toThrow(
            'connection interrupted after acceptance'
          );
          const pendingState = await persistence.get<RunState>('runState');
          const mismatched =
            kind === 'review'
              ? {
                  body: 'Different review',
                  comments: [{ path: 'other.ts', line: 9, side: 'RIGHT', body: 'Different issue' }],
                }
              : { body: 'Different summary' };
          if (kind === 'review') {
            publishedReviews.push({
              id: 99,
              commit_id: HEAD_SHA,
              state: 'COMMENTED',
              pull_request_url: 'https://api.github.com/repos/acme/widget/pulls/42',
              body: '',
              user: { login: 'kilo-code[bot]' },
            });
          } else {
            publishedIssueComments.push({
              id: 99,
              body: `<!-- kilo-review -->\n${mismatched.body}`,
              issue_url: 'https://api.github.com/repos/acme/widget/issues/42',
              user: { login: 'kilo-code[bot]' },
            });
          }
          const requestsBeforeMismatch = requestCalls;
          await expect(executeTool(instance.getTools(), name, mismatched)).rejects.toThrow(
            'fingerprint does not match the pending operation'
          );
          const requestsAfterMismatch = requestCalls;
          const mismatchedState = await persistence.get<RunState>('runState');
          const recovered = await executeTool(instance.getTools(), name, args);
          return {
            pendingState,
            mismatchedState,
            recovered,
            postCalls,
            requestsBeforeMismatch,
            requestsAfterMismatch,
            reviewBodies: publishedReviews.map(review => review.body),
            state: await persistence.get<RunState>('runState'),
          };
        }
      );

      const pendingPublication =
        kind === 'review'
          ? {
              reviewPending: true,
              reviewPendingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
            }
          : {
              summaryPending: true,
              summaryPendingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
            };
      expect(result.pendingState).toMatchObject(pendingPublication);
      expect(result.mismatchedState).toMatchObject(pendingPublication);
      expect(result.mismatchedState?.reviewId).toBeUndefined();
      expect(result.mismatchedState?.summaryCommentId).toBeUndefined();
      expect(result.requestsAfterMismatch).toBe(result.requestsBeforeMismatch);
      expect(result.recovered).toEqual(kind === 'review' ? { id: 17 } : { id: 22 });
      if (kind === 'review') expect(result.reviewBodies).toEqual(['', '']);
      expect(result.state).toMatchObject(
        kind === 'review'
          ? { reviewId: 17, reviewPending: false, published: true }
          : { summaryCommentId: 22, summaryPending: false, summaryPublished: true }
      );
      expect(result.state?.reviewPendingFingerprint).toBeUndefined();
      expect(result.state?.summaryPendingFingerprint).toBeUndefined();
      expect(result.state?.summaryPendingCommentId).toBeUndefined();
      expect(result.postCalls).toBe(1);
    }
  );

  it('recovers a fingerprinted existing-summary PATCH after response loss without another write', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, {
      status: 'running',
      headSha: HEAD_SHA,
      githubToken: 'minted-token',
      input: { ...input, existingSummaryCommentId: 9 },
      summaryOwnership,
    });

    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async (instance, durableState) => {
        const persistence = createReviewPersistence(durableState.storage).persistence;
        const remote = {
          id: 9,
          body: '<!-- kilo-review -->\nExisting summary',
          issue_url: 'https://api.github.com/repos/acme/widget/issues/42',
          user: { login: 'kilo-code[bot]' },
        };
        let patchCalls = 0;
        let postCalls = 0;
        let commentReads = 0;
        let stateBeforePatch: RunState | undefined;
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, options?: RequestInit) => {
            const path = new URL(url).pathname;
            if (path.includes('/compare/')) return Response.json(compareFixture());
            if (options?.method === 'PATCH') {
              patchCalls += 1;
              stateBeforePatch = await persistence.get<RunState>('runState');
              if (typeof options.body !== 'string') throw new Error('PATCH body is missing');
              remote.body = (JSON.parse(options.body) as { body: string }).body;
              throw new Error('PATCH response interrupted after acceptance');
            }
            if (options?.method === 'POST') {
              postCalls += 1;
              throw new Error('Unexpected summary creation');
            }
            if (path.endsWith('/issues/comments/9')) {
              commentReads += 1;
              return Response.json(remote);
            }
            if (path.endsWith('/pulls/42')) {
              return Response.json(pullFixture());
            }
            return Response.json([]);
          })
        );

        await instance.getReview('review-owner');
        await expect(
          executeTool(instance.getTools(), 'upsert_summary', { body: 'Updated summary' })
        ).rejects.toThrow('PATCH response interrupted after acceptance');
        const pendingState = await persistence.get<RunState>('runState');
        const readsBeforeMismatch = commentReads;
        await expect(
          executeTool(instance.getTools(), 'upsert_summary', { body: 'Different summary' })
        ).rejects.toThrow('fingerprint does not match the pending operation');
        const readsAfterMismatch = commentReads;
        const recovered = await executeTool(instance.getTools(), 'upsert_summary', {
          body: 'Updated summary',
        });
        return {
          stateBeforePatch,
          pendingState,
          recovered,
          patchCalls,
          postCalls,
          readsBeforeMismatch,
          readsAfterMismatch,
          publishedBody: remote.body,
          state: await persistence.get<RunState>('runState'),
        };
      }
    );

    expect(result.stateBeforePatch).toMatchObject({
      summaryPending: true,
      summaryPendingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      summaryPendingCommentId: 9,
    });
    expect(result.pendingState).toMatchObject({
      summaryPending: true,
      summaryPendingFingerprint: result.stateBeforePatch?.summaryPendingFingerprint,
      summaryPendingCommentId: 9,
    });
    expect(result.readsAfterMismatch).toBe(result.readsBeforeMismatch);
    expect(result.recovered).toEqual({ id: 9 });
    expect(result.publishedBody.startsWith('<!-- kilo-review -->')).toBe(true);
    expect(result.publishedBody).toContain('Updated summary');
    expect(result.state).toMatchObject({
      summaryCommentId: 9,
      summaryPending: false,
      summaryPublished: true,
      summaryBodyHash: createHash('sha256').update(result.publishedBody).digest('hex'),
    });
    expect(result.state?.summaryPendingFingerprint).toBeUndefined();
    expect(result.state?.summaryPendingCommentId).toBeUndefined();
    expect(result.patchCalls).toBe(1);
    expect(result.postCalls).toBe(0);
  });

  it.each(['review', 'summary'] as const)(
    'retains an unresolved %s publication and refuses a duplicate POST',
    async kind => {
      const runId = crypto.randomUUID();
      await seedState(runId, {
        status: 'running',
        headSha: HEAD_SHA,
        githubToken: 'minted-token',
      });

      const result = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async (instance, durableState) => {
          let postCalls = 0;
          vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, options?: RequestInit) => {
              if (options?.method === 'POST') {
                postCalls += 1;
                throw new Error('connection interrupted');
              }
              if (new URL(url).pathname.includes('/compare/'))
                return Response.json(compareFixture());
              if (new URL(url).pathname.endsWith('/pulls/42')) {
                return Response.json(pullFixture());
              }
              return Response.json([]);
            })
          );

          await instance.getReview('review-owner');
          const tools = instance.getTools();
          const name = kind === 'review' ? 'submit_review' : 'upsert_summary';
          const args =
            kind === 'review'
              ? {
                  body: '',
                  comments: [{ path: 'source.ts', line: 1, side: 'RIGHT', body: 'Issue' }],
                }
              : { body: 'Summary' };
          if (kind === 'review') await executeTool(tools, 'pr_comments', {});
          await expect(executeTool(tools, name, args)).rejects.toThrow('connection interrupted');
          await expect(executeTool(instance.getTools(), name, args)).rejects.toThrow(
            kind === 'review' ? 'Review publication is pending' : 'Summary publication is pending'
          );
          return {
            postCalls,
            state: await createReviewPersistence(durableState.storage).persistence.get<RunState>(
              'runState'
            ),
          };
        }
      );

      expect(result.postCalls).toBe(1);
      expect(result.state).toMatchObject(
        kind === 'review' ? { reviewPending: true } : { summaryPending: true }
      );
    }
  );

  it('reports a persisted application error when polling a completed live submission without a summary', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, {
      status: 'running',
      submissionId: 'completed-submission',
      githubToken: 'minted-token',
      analysisOutcome: cleanAnalysis,
    });

    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async (instance, durableState) => {
        const inspect = vi
          .spyOn(instance, 'inspectSubmission')
          .mockResolvedValue(submitInspection(runId, 'completed', 'completed-submission'));
        try {
          return {
            review: await instance.getReview('review-owner'),
            state: await createReviewPersistence(durableState.storage).persistence.get<RunState>(
              'runState'
            ),
          };
        } finally {
          inspect.mockRestore();
        }
      }
    );

    expect(result.review).toMatchObject({
      status: 'error',
      error: 'Review completed without a valid summary proposal',
    });
    expect(result.state).toMatchObject({
      status: 'error',
      input: { gitToken: '', kiloToken: '' },
    });
  });

  it('rejects a live completion notification when the required summary is missing', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, {
      status: 'running',
      submissionId: 'completed-submission',
      githubToken: 'minted-token',
      analysisOutcome: cleanAnalysis,
    });

    await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        const hook = Reflect.get(instance, 'onSubmissionStatus');
        if (typeof hook !== 'function') throw new Error('Submission status hook is unavailable');
        await Reflect.apply(hook, instance, [
          submitInspection(runId, 'completed', 'completed-submission'),
        ]);
      }
    );

    await expect(readState(runId)).resolves.toMatchObject({
      status: 'error',
      error: 'Review completed without a valid summary proposal',
      input: { gitToken: '', kiloToken: '' },
    });
  });

  it('does not replace a persisted application error with a completed Think submission', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, {
      status: 'error',
      error: 'Review completed without a valid summary proposal',
      submissionId: 'completed-submission',
      input: { ...input, gitToken: '', kiloToken: '' },
    });

    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        const inspect = vi
          .spyOn(instance, 'inspectSubmission')
          .mockResolvedValue(submitInspection(runId, 'completed', 'completed-submission'));
        try {
          return {
            review: await instance.getReview('review-owner'),
            inspectCalls: inspect.mock.calls.length,
          };
        } finally {
          inspect.mockRestore();
        }
      }
    );

    expect(result.review).toMatchObject({
      status: 'error',
      error: 'Review completed without a valid summary proposal',
    });
    expect(result.inspectCalls).toBe(0);
  });

  it('completes a dry run without a published summary and scrubs credentials', async () => {
    const runId = crypto.randomUUID();
    submitMessages.mockResolvedValue(submitInspection(runId, 'completed', 'completed-submission'));
    await seedState(runId, {
      input: { ...input, dryRun: true },
      analysisOutcome: cleanAnalysis,
      summaryProposal,
    });

    await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      instance => instance.runClone({ runId })
    );

    await expect(readState(runId)).resolves.toMatchObject({
      runId,
      status: 'completed',
      submissionId: 'completed-submission',
      input: { gitToken: '', kiloToken: '' },
    });
    const state = await readState(runId);
    expect(state?.githubToken).toBeUndefined();
  });

  it('fails a completed live submission when its required summary was not published', async () => {
    const runId = crypto.randomUUID();
    submitMessages.mockResolvedValue(submitInspection(runId, 'completed', 'completed-submission'));
    await seedState(runId, { published: true, reviewId: 17, analysisOutcome: cleanAnalysis });

    await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      instance => instance.runClone({ runId })
    );

    await expect(readState(runId)).resolves.toMatchObject({
      runId,
      status: 'error',
      error: 'Review completed without a valid summary proposal',
      submissionId: 'completed-submission',
      reviewId: 17,
      input: { gitToken: '', kiloToken: '' },
    });
  });

  it.each(['token', 'snapshot', 'inference', 'clone'] as const)(
    'fences a delayed %s completion after cancellation or verified credential expiry',
    async stage => {
      for (const termination of ['cancel', 'expiry'] as const) {
        const runId = crypto.randomUUID();
        const expiresAt = Date.now() + 60_000;
        await seedState(runId, { credentialsExpireAt: expiresAt });
        const entered = createGate();
        const release = createGate();
        const delayed = async () => {
          entered.resolve();
          await release.promise;
        };
        if (stage === 'token')
          vi.mocked(resolveGithubCredentials).mockImplementationOnce(async () => {
            await delayed();
            return { token: 'late-github-token' };
          });
        if (stage === 'snapshot')
          vi.mocked(resolveReviewSnapshot).mockImplementationOnce(async () => {
            await delayed();
            return snapshot;
          });
        if (stage === 'inference')
          vi.mocked(resolveIsolateReviewInference).mockImplementationOnce(async () => {
            await delayed();
            return inference;
          });
        if (stage === 'clone')
          vi.mocked(cloneRepository).mockImplementationOnce(
            async (workspace, _input, sha, options) => {
              expect(options?.signal).toBeInstanceOf(AbortSignal);
              expect(vi.mocked(admitRepository).mock.calls.at(-1)?.[3]).toBe(sha);
              expect(options?.signal).toBe(vi.mocked(admitRepository).mock.calls.at(-1)?.[4]);
              await delayed();
              expect(options?.signal?.aborted).toBe(true);
              await workspace.mkdir('/workspace', { recursive: true });
              await workspace.writeFile('/workspace/late.ts', 'late clone');
              return cloneStats;
            }
          );
        const result = await runInDurableObject(
          env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
          async (instance, durableState) => {
            const persistence = createReviewPersistence(durableState.storage).persistence;
            const running = instance.runClone({ runId });
            await entered.promise;
            let clock: ReturnType<typeof vi.spyOn> | undefined;
            try {
              if (termination === 'cancel') await instance.cancelReview('review-owner');
              else {
                clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
                await instance.expireReview({ runId });
              }
              const terminal = await persistence.get<RunState>('runState');
              release.resolve();
              await running;
              return {
                terminal,
                final: await persistence.get<RunState>('runState'),
                checkout: await instance.workspace.stat('/workspace'),
              };
            } finally {
              release.resolve();
              clock?.mockRestore();
              await running;
            }
          }
        );
        expect(result.terminal).toMatchObject({
          status: 'error',
          terminationReason: termination === 'cancel' ? 'cancelled' : 'credentials_expired',
          input: { gitToken: '', kiloToken: '' },
        });
        expect(result.final).toEqual(result.terminal);
        expect(result.final?.githubToken).toBeUndefined();
        expect(result.final?.submissionId).toBeUndefined();
        expect(result.checkout).toBeNull();
        expect(submitMessages).not.toHaveBeenCalled();
      }
    }
  );

  it('keeps all admission attempts inside one five-minute budget', async () => {
    const runId = crypto.randomUUID();
    const now = Date.now();
    await seedState(runId, { createdAt: new Date(now).toISOString() });
    vi.mocked(cloneRepository).mockRejectedValueOnce(new Error('retryable clone error'));
    const stub = env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId));
    await expect(
      runInDurableObject(stub, instance => instance.runClone({ runId }))
    ).rejects.toThrow('retryable clone error');
    const before = await readState(runId);
    expect(before?.admissionDeadlineAt).toBe(now + 300_000);
    expect(before?.absoluteDeadlineAt).toBe(now + 1_020_000);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 300_001);
    try {
      await runInDurableObject(stub, instance => instance.runClone({ runId }));
    } finally {
      clock.mockRestore();
    }
    expect(cloneRepository).toHaveBeenCalledOnce();
    expect(submitMessages).not.toHaveBeenCalled();
    await expect(readState(runId)).resolves.toMatchObject({
      status: 'error',
      terminationReason: 'admission_deadline',
      cloneAttempts: 1,
      admissionDeadlineAt: before?.admissionDeadlineAt,
    });
  });

  it('bounds admission, model/tools, and the absolute deadline by verified JWT expiry', async () => {
    const runId = crypto.randomUUID();
    const now = Date.now();
    const expiry = now + 90_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    submitMessages.mockResolvedValue(submitInspection(runId, 'running', 'running-submission'));
    try {
      const result = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async (instance, durableState) => {
          await instance.startReview(runId, { ...input, credentialsExpireAt: expiry });
          await instance.runClone({ runId });
          const state = await createReviewPersistence(
            durableState.storage
          ).persistence.get<RunState>('runState');
          const turn = await instance.beforeTurn({
            system: '',
            messages: [],
            tools: {},
            model: instance.getModel(),
            continuation: false,
          });
          return { state, timeout: turn.timeout };
        }
      );
      expect(result.state).toMatchObject({
        credentialsExpireAt: expiry,
        admissionDeadlineAt: expiry,
        executionDeadlineAt: expiry,
        absoluteDeadlineAt: expiry,
      });
      expect(result.timeout).toEqual({ totalMs: 90_000, toolMs: 90_000 });
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps the model deadline armed when the earlier admission alarm is consumed', async () => {
    const runId = crypto.randomUUID();
    const stub = env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId));
    const now = Math.floor(Date.now() / 1000) * 1000 + 123;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    submitMessages.mockResolvedValue(submitInspection(runId, 'running', 'deadline-submission'));
    try {
      const schedules = await runInDurableObject(stub, async instance => {
        await instance.startReview(runId, input);
        clock.mockReturnValue(now + 240_000);
        await instance.runClone({ runId });
        for (const scheduled of await instance.listSchedules()) {
          if (scheduled.callback === 'runClone') await instance.cancelSchedule(scheduled.id);
        }
        return instance.listSchedules();
      });
      const deadlines = schedules
        .filter(scheduled => scheduled.callback === 'expireReview')
        .sort((a, b) => a.time - b.time);
      expect(deadlines).toHaveLength(2);
      const admission = deadlines[0];
      const execution = deadlines[1];
      if (!admission || !execution) throw new Error('Expected separate phase deadlines');
      expect(admission.time * 1000).toBeGreaterThanOrEqual(now + 300_000);
      expect(execution.time * 1000).toBeGreaterThanOrEqual(now + 960_000);
      clock.mockReturnValue(admission.time * 1000 + 1);
      await runDurableObjectAlarm(stub);
      await expect(readState(runId)).resolves.toMatchObject({ status: 'running' });
      const remaining = await runInDurableObject(stub, instance => instance.listSchedules());
      expect(remaining).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: execution.id })])
      );
      clock.mockReturnValue(execution.time * 1000 + 1);
      await runDurableObjectAlarm(stub);
      await expect(readState(runId)).resolves.toMatchObject({
        status: 'error',
        terminationReason: 'execution_deadline',
        input: { gitToken: '', kiloToken: '' },
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('does not expose a model for caller-supplied inference before admission resolves it', async () => {
    const runId = crypto.randomUUID();
    await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        await instance.startReview(runId, { ...input, model: inference.modelId, inference });
        expect(() => instance.getModel()).toThrow('Review inference has not been resolved');
        await instance.cancelReview('review-owner');
      }
    );
    expect(submitMessages).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'preserves the exact prepared prompt and resolves inference only when absent (supplied=%s)',
    async withInference => {
      const runId = crypto.randomUUID();
      const preparedInput: StartReviewInput = {
        ...input,
        gitToken: undefined,
        credentialsExpireAt: Date.now() + 3_600_000,
        ...snapshot,
        model: inference.modelId,
        inference: withInference ? inference : undefined,
        userPrompt: '  Complete prepared policy\n',
        expectedIntegrationId: 'integration-1',
        expectedInstallationId: 'installation-1',
        expectedAppType: 'standard',
        preparation: {
          version: 1,
          preparedAt: new Date().toISOString(),
          requestingUserId: 'review-owner',
          executionUserId: 'review-owner',
          settings: {
            reviewStyle: 'strict',
            focusAreas: ['correctness'],
            customInstructions: 'saved instructions',
            manualInstructions: 'manual instructions',
            model: inference.modelId,
            thinkingEffort: null,
            modelSource: 'explicit',
            disableReviewMd: true,
            analyticsEnabled: false,
          },
          snapshot,
          github: {
            integrationId: 'integration-1',
            installationId: 'installation-1',
            appType: 'standard',
          },
          hashes: {
            settings: 'a'.repeat(64),
            context: 'b'.repeat(64),
            canonicalPrompt: 'c'.repeat(64),
            adaptedPrompt: 'd'.repeat(64),
            system: 'e'.repeat(64),
          },
          versions: { cli: '7.4.20', policy: '1', adapter: '1' },
          limitations: [],
        },
      };
      vi.mocked(resolveGithubCredentials).mockResolvedValueOnce({
        token: 'minted-token',
        installationId: 'installation-1',
        appType: 'standard',
      });
      submitMessages.mockResolvedValue(submitInspection(runId, 'running', 'prepared-submission'));
      const observed = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          await instance.startReview(runId, preparedInput);
          await instance.runClone({ runId });
          const tools = instance.getTools();
          const turn = await instance.beforeTurn({
            system: 'framework fallback',
            messages: [],
            tools,
            model: instance.getModel(),
            continuation: false,
          });
          const fetchMock = vi.fn<typeof fetch>(async () => chatReply());
          vi.stubGlobal('fetch', fetchMock);
          await generateText({
            model: instance.getModel(),
            system: turn.instructions,
            prompt: preparedInput.userPrompt,
          });
          expect(
            await executeTool(tools, 'task', {
              description: 'Prepared child',
              prompt: 'Inspect source.',
              subagent_type: 'general',
            })
          ).toMatchObject({ metadata: { state: 'completed' } });
          const requests = fetchMock.mock.calls.map(([, options]) => {
            if (typeof options?.body !== 'string') throw new Error('Expected JSON request');
            return JSON.parse(options.body) as {
              messages: Array<{ role: string; content: string }>;
              tools?: Array<{ function: { name: string } }>;
            };
          });
          return { turn, requests, status: await instance.getReview('review-owner') };
        }
      );
      expect(observed.turn.instructions).not.toContain('RAW / DEFAULT REVIEW POLICY');
      expect(observed.turn.instructions).toContain('Safety and completeness');
      expect(observed.turn.activeTools).toEqual(expect.arrayContaining([...GITHUB_TOOL_NAMES]));
      const sentSystem = observed.requests[0]?.messages.find(
        message => message.role === 'system'
      )?.content;
      expect(sentSystem).toBe(observed.turn.instructions);
      if (!sentSystem) throw new Error('No system prompt was sent');
      const actualHash = createHash('sha256').update(sentSystem).digest('hex');
      expect(observed.status?.systemPromptHash).toBe(actualHash);
      expect(observed.status?.systemPromptVersion).toBe(SYSTEM_PROMPT_VERSION);
      expect(observed.status?.preparation?.hashes.workerSystem).toBe(actualHash);
      expect(actualHash).not.toBe(preparedInput.preparation?.hashes.system);
      expect(observed.status?.preparation?.hashes.system).toBe(
        preparedInput.preparation?.hashes.system
      );
      const childRequest = observed.requests[1];
      const childText = childRequest?.messages.map(message => message.content).join('\n') ?? '';
      expect(childText).toContain(preparedInput.userPrompt);
      expect(childText).toContain(HEAD_SHA);
      expect(childText).toContain(BASE_SHA);
      expect(childText).toContain(MERGE_SHA);
      expect(childText).not.toContain('RAW / DEFAULT REVIEW POLICY');
      const childTools = childRequest?.tools?.map(entry => entry.function.name) ?? [];
      expect(childTools).toEqual(expect.arrayContaining([...READ_ONLY_GITHUB_TOOL_NAMES]));
      for (const denied of [
        'task',
        'activate_skill',
        'submit_review',
        'upsert_summary',
        'write',
        'edit',
        'delete',
        'bash',
      ])
        expect(childTools).not.toContain(denied);
      expect(resolveIsolateReviewInference).toHaveBeenCalledTimes(withInference ? 0 : 1);
      expect(submitMessages).toHaveBeenCalledWith(
        [expect.objectContaining({ parts: [{ type: 'text', text: preparedInput.userPrompt }] })],
        { idempotencyKey: runId }
      );
      const state = await readState(runId);
      expect(state).toMatchObject({
        status: 'running',
        provenance: 'prepared',
        input: { inference, preparation: preparedInput.preparation },
      });
      expect(state?.input.preparation).not.toHaveProperty('inference');
    }
  );

  describe('prepared incremental admission', () => {
    beforeEach(() => {
      vi.mocked(resolveGithubCredentials).mockResolvedValue({
        token: 'minted-token',
        installationId: 'installation-1',
        appType: 'standard',
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, options?: RequestInit) => {
          if (
            (options?.method !== undefined && options.method !== 'GET') ||
            new URL(url).pathname !== `/repos/acme/widget/compare/${FIRST_HEAD}...${HEAD_SHA}`
          ) {
            throw new Error('Unexpected incremental admission request');
          }
          return Response.json(incrementalCompareFixture());
        })
      );
    });

    it('authenticates a completed dry baseline and persists selection before inference or clone without summary ownership', async () => {
      const previousRunId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      const selection = incrementalSelection(previousRunId);
      const baseline = completedPreparedBaseline();
      await seedState(previousRunId, {
        ...baseline,
        input: { ...baseline.input, owner: 'ACME', repo: 'Widget' },
      });
      const priorState = await readState(previousRunId);
      submitMessages.mockResolvedValue(
        submitInspection(runId, 'running', 'incremental-submission')
      );
      const result = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async (instance, durableState) => {
          const persistence = createReviewPersistence(durableState.storage).persistence;
          const admitted: Array<RunState | undefined> = [];
          vi.mocked(resolveIsolateReviewInference).mockImplementationOnce(async () => {
            admitted.push(await persistence.get<RunState>('runState'));
            return inference;
          });
          vi.mocked(cloneRepository).mockImplementationOnce(async () => {
            admitted.push(await persistence.get<RunState>('runState'));
            return cloneStats;
          });
          await instance.startReview(runId, { ...preparedReviewInput(selection), dryRun: false });
          await instance.runClone({ runId });
          return {
            admitted,
            review: await instance.getReview('review-owner'),
            state: await persistence.get<RunState>('runState'),
          };
        }
      );
      expect(result.admitted).toHaveLength(2);
      for (const state of result.admitted) {
        expect(state?.reviewSelection).toEqual(selection);
        expect(state?.summaryOwnership).toBeUndefined();
      }
      expect(result.state?.reviewSelection).toEqual(selection);
      expect(result.review).toMatchObject({ status: 'running', reviewSelection: selection });
      expect(priorState?.summaryCommentId).toBeUndefined();
      expect(priorState?.publicationOutcome?.summary).toBe('proposed');
      expect(result.state?.summaryOwnership).toBeUndefined();
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]).toBe(
        `https://api.github.com/repos/acme/widget/compare/${FIRST_HEAD}...${HEAD_SHA}?per_page=1`
      );
      expect(resolveIsolateReviewInference).toHaveBeenCalledOnce();
      expect(cloneRepository).toHaveBeenCalledOnce();
      expect(submitMessages).toHaveBeenCalledOnce();
      await expect(readState(previousRunId)).resolves.toEqual(priorState);
    });

    it.each([
      {
        label: 'another execution user',
        override: baseline => ({ input: { ...baseline.input, userId: 'other-user' } }),
      },
      {
        label: 'another organization',
        override: baseline => ({ input: { ...baseline.input, organizationId: 'other-org' } }),
      },
      {
        label: 'another repository',
        override: baseline => ({ input: { ...baseline.input, repo: 'other-repo' } }),
      },
      {
        label: 'another pull request',
        override: baseline => ({ input: { ...baseline.input, pullNumber: 43 } }),
      },
      { label: 'another installation', override: () => ({ installationId: 'installation-2' }) },
      { label: 'another app', override: () => ({ appType: 'lite' }) },
      {
        label: 'another integration',
        override: baseline => ({
          input: {
            ...baseline.input,
            expectedIntegrationId: 'integration-2',
            preparation: {
              ...baseline.input.preparation,
              github: { ...baseline.input.preparation.github, integrationId: 'integration-2' },
            },
          },
        }),
      },
      { label: 'expired retention', override: () => ({ cleanupAt: Date.now() - 1 }) },
      { label: 'a raw review', override: () => ({ provenance: 'raw' }) },
      { label: 'an errored review', override: () => ({ status: 'error' }) },
      { label: 'a cancelled termination', override: () => ({ terminationReason: 'cancelled' }) },
      {
        label: 'an unfinished parent',
        override: baseline => ({
          analysisOutcome: { ...baseline.analysisOutcome, parentFinished: false },
        }),
      },
      {
        label: 'incomplete required context',
        override: baseline => ({
          analysisOutcome: {
            ...baseline.analysisOutcome,
            contextIncompleteReasons: ['Missing patch'],
          },
        }),
      },
      {
        label: 'an incomplete child',
        override: baseline => ({
          analysisOutcome: { ...baseline.analysisOutcome, incompleteTaskIds: ['unfinished-child'] },
        }),
      },
      {
        label: 'a preparation snapshot that disagrees with status',
        override: baseline => ({
          input: {
            ...baseline.input,
            preparation: {
              ...baseline.input.preparation,
              snapshot: { ...baseline.input.preparation.snapshot, headSha: 'e'.repeat(40) },
            },
          },
        }),
      },
      {
        label: 'a changed base',
        override: baseline => ({
          baseTipSha: 'f'.repeat(40),
          input: {
            ...baseline.input,
            baseTipSha: 'f'.repeat(40),
            preparation: {
              ...baseline.input.preparation,
              snapshot: { ...baseline.input.preparation.snapshot, baseTipSha: 'f'.repeat(40) },
            },
          },
        }),
      },
      {
        label: 'changed settings',
        override: baseline => ({
          input: {
            ...baseline.input,
            preparation: {
              ...baseline.input.preparation,
              hashes: { ...baseline.input.preparation.hashes, settings: '7'.repeat(64) },
            },
          },
        }),
      },
      {
        label: 'changed REVIEW.md content',
        override: baseline => ({
          input: {
            ...baseline.input,
            preparation: {
              ...baseline.input.preparation,
              reviewInstructions: {
                path: 'REVIEW.md',
                sha: BASE_SHA,
                hash: '7'.repeat(64),
                characterCount: 20,
                truncated: false,
              },
            },
          },
        }),
      },
      ...(['policy', 'adapter'] as const).map(version => ({
        label: `a changed ${version} version`,
        override: (baseline: ReturnType<typeof completedPreparedBaseline>) => ({
          input: {
            ...baseline.input,
            preparation: {
              ...baseline.input.preparation,
              versions: { ...baseline.input.preparation.versions, [version]: '2' },
            },
          },
        }),
      })),
      { label: 'legacy missing summary content', override: () => ({ summaryContent: undefined }) },
      {
        label: 'a forged summary body',
        override: () => ({
          summaryContent: { ...baselineSummary, body: 'Changed after preparation' },
        }),
      },
      {
        label: 'an empty summary with a valid hash',
        override: () => ({
          summaryContent: {
            body: '   ',
            bodyHash: createHash('sha256').update('   ').digest('hex'),
          },
        }),
      },
    ] satisfies Array<{
      label: string;
      override: (baseline: ReturnType<typeof completedPreparedBaseline>) => Partial<RunState>;
    }>)(
      'rejects $label before clone or inference instead of silently falling back',
      async ({ override }) => {
        const previousRunId = crypto.randomUUID();
        const runId = crypto.randomUUID();
        const baseline = completedPreparedBaseline();
        await seedState(previousRunId, { ...baseline, ...override(baseline) });
        submitMessages.mockResolvedValue(
          submitInspection(runId, 'running', 'unexpected-submission')
        );
        await runInDurableObject(
          env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
          async instance => {
            await instance.startReview(
              runId,
              preparedReviewInput(incrementalSelection(previousRunId))
            );
            await expect(instance.runClone({ runId })).rejects.toThrow();
          }
        );
        const state = await readState(runId);
        expect(state?.reviewSelection?.effectiveMode).not.toBe('full');
        expect(state?.status).not.toBe('running');
        expect(cloneRepository).not.toHaveBeenCalled();
        expect(resolveIsolateReviewInference).not.toHaveBeenCalled();
        expect(submitMessages).not.toHaveBeenCalled();
      }
    );

    it.each([
      'missing baseline',
      'summary hash',
      'changed-file count',
      'non-ancestor comparison',
    ] as const)('rejects an invalidated incremental assertion: %s', async invalidation => {
      const previousRunId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      if (invalidation !== 'missing baseline')
        await seedState(previousRunId, completedPreparedBaseline());
      const selection = incrementalSelection(previousRunId);
      if (invalidation === 'summary hash') selection.previousSummaryHash = '0'.repeat(64);
      if (invalidation === 'changed-file count') selection.changedFileCount = 2;
      if (invalidation === 'non-ancestor comparison') {
        vi.mocked(globalThis.fetch).mockResolvedValue(
          Response.json({ ...incrementalCompareFixture(), status: 'diverged' })
        );
      }
      submitMessages.mockResolvedValue(submitInspection(runId, 'running', 'unexpected-submission'));
      await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          await instance.startReview(runId, preparedReviewInput(selection));
          await expect(instance.runClone({ runId })).rejects.toThrow();
        }
      );
      expect((await readState(runId))?.reviewSelection?.effectiveMode).not.toBe('full');
      expect(cloneRepository).not.toHaveBeenCalled();
      expect(resolveIsolateReviewInference).not.toHaveBeenCalled();
      expect(submitMessages).not.toHaveBeenCalled();
    });

    it('still requires confirmed previous ownership for an explicit summary target on a dry incremental run', async () => {
      const previousRunId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      await seedState(previousRunId, completedPreparedBaseline());
      await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          await instance.startReview(runId, {
            ...preparedReviewInput(incrementalSelection(previousRunId)),
            existingSummaryCommentId: 9,
          });
          await expect(instance.runClone({ runId })).rejects.toThrow(/summary ownership/i);
        }
      );
      expect(cloneRepository).not.toHaveBeenCalled();
      expect(resolveIsolateReviewInference).not.toHaveBeenCalled();
      expect(submitMessages).not.toHaveBeenCalled();
    });

    it('retains a prepared full fallback through clone interruption and eviction without re-probing an eligible baseline', async () => {
      const previousRunId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      const selection: IsolateReviewSelection = {
        requestedMode: 'incremental',
        effectiveMode: 'full',
        previousRunId,
        fallbackReason: 'previous_summary_unavailable',
      };
      await seedState(previousRunId, completedPreparedBaseline());
      vi.mocked(cloneRepository).mockRejectedValueOnce(new Error('clone interrupted'));
      submitMessages.mockResolvedValue(submitInspection(runId, 'running', 'fallback-submission'));
      const priorReads = vi.spyOn(ReviewIsolate.prototype, 'getReview');
      try {
        await runInDurableObject(
          env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
          async instance => {
            await instance.startReview(runId, preparedReviewInput(selection));
            await expect(instance.runClone({ runId })).rejects.toThrow('clone interrupted');
          }
        );
        expect((await readState(runId))?.reviewSelection).toEqual(selection);
        await abortAllDurableObjects();
        await runInDurableObject(
          env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
          instance => instance.runClone({ runId })
        );
        expect(priorReads).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
      } finally {
        priorReads.mockRestore();
      }
      const result = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => ({
          review: await instance.getReview('review-owner'),
          previousFile: await executeTool(instance.getTools(), 'pr_file', {
            path: 'source.ts',
            revision: 'previous',
          }),
        })
      );
      expect(result.review).toMatchObject({ status: 'running', reviewSelection: selection });
      expect(result.previousFile).toMatchObject({ error: expect.stringContaining('incremental') });
      expect((await readState(runId))?.reviewSelection).toEqual(selection);
      expect(cloneRepository).toHaveBeenCalledTimes(2);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  it('persists cancellation before invoking reentrant Think cancellation and cleanup', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, {
      status: 'running',
      submissionId: 'cancelled-submission',
      githubToken: 'minted-token',
    });
    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async (instance, durableState) => {
        const persistence = createReviewPersistence(durableState.storage).persistence;
        let atCancellation: RunState | undefined;
        const cancel = vi
          .spyOn(Think.prototype, 'cancelSubmission')
          .mockImplementationOnce(async () => {
            atCancellation = await persistence.get<RunState>('runState');
            const hook = Reflect.get(instance, 'onSubmissionStatus');
            if (typeof hook !== 'function')
              throw new Error('Submission status hook is unavailable');
            await Reflect.apply(hook, instance, [
              submitInspection(runId, 'aborted', 'cancelled-submission'),
            ]);
          });
        try {
          await instance.cancelReview('review-owner');
          return { atCancellation, state: await persistence.get<RunState>('runState') };
        } finally {
          cancel.mockRestore();
        }
      }
    );
    expect(result.atCancellation).toMatchObject({
      status: 'error',
      terminationReason: 'cancelled',
      input: { gitToken: '', kiloToken: '' },
    });
    expect(result.state).toEqual(result.atCancellation);
  });

  it.each(['cancel', 'expiry'] as const)(
    'rejects new publication after %s wins a delayed final preflight read',
    async termination => {
      const runId = crypto.randomUUID();
      const expiresAt = Date.now() + 60_000;
      await seedState(runId, {
        status: 'running',
        headSha: HEAD_SHA,
        githubToken: 'minted-token',
        credentialsExpireAt: expiresAt,
      });
      const result = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async (instance, durableState) => {
          const persistence = createReviewPersistence(durableState.storage).persistence;
          const entered = createGate();
          const release = createGate();
          let writes = 0;
          vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, options?: RequestInit) => {
              if (options?.method === 'POST' || options?.method === 'PATCH') writes++;
              if (new URL(url).pathname.endsWith('/pulls/42')) {
                entered.resolve();
                await release.promise;
              }
              return fixtureGithubResponse(url, options);
            })
          );
          await instance.getReview('review-owner');
          const tools = instance.getTools();
          const pending = executeTool(tools, 'upsert_summary', { body: 'Summary' });
          const rejected = expect(pending).rejects.toThrow(/terminal|aborted|expired/i);
          await entered.promise;
          const clock =
            termination === 'expiry'
              ? vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1)
              : undefined;
          try {
            if (termination === 'cancel') await instance.cancelReview('review-owner');
            else await instance.expireReview({ runId });
            const terminal = await persistence.get<RunState>('runState');
            release.resolve();
            await rejected;
            return { writes, terminal, state: await persistence.get<RunState>('runState') };
          } finally {
            release.resolve();
            clock?.mockRestore();
          }
        }
      );
      expect(result.writes).toBe(0);
      expect(result.state).toEqual(result.terminal);
      expect(result.state?.summaryPending).not.toBe(true);
    }
  );

  it.each(['review', 'summary'] as const)(
    'records a late %s acknowledgement without reopening cancellation or restoring credentials',
    async kind => {
      const runId = crypto.randomUUID();
      await seedState(runId, { status: 'running', headSha: HEAD_SHA, githubToken: 'minted-token' });
      const result = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async (instance, durableState) => {
          const persistence = createReviewPersistence(durableState.storage).persistence;
          const entered = createGate();
          const release = createGate();
          let writes = 0;
          let publishedBody = '';
          vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, options?: RequestInit) => {
              if (options?.method === 'POST') {
                writes++;
                if (typeof options.body !== 'string')
                  throw new Error('Missing publication payload');
                publishedBody = (JSON.parse(options.body) as { body: string }).body;
                entered.resolve();
                await release.promise;
              }
              return fixtureGithubResponse(url, options);
            })
          );
          await instance.getReview('review-owner');
          const tools = instance.getTools();
          if (kind === 'review') await executeTool(tools, 'pr_comments', {});
          const pending = executeTool(
            tools,
            kind === 'review' ? 'submit_review' : 'upsert_summary',
            kind === 'review'
              ? { comments: [{ path: 'source.ts', line: 1, side: 'RIGHT', body: 'Issue' }] }
              : { body: 'Summary' }
          );
          await entered.promise;
          try {
            await instance.cancelReview('review-owner');
            const terminal = await persistence.get<RunState>('runState');
            release.resolve();
            await pending;
            return {
              writes,
              terminal,
              publishedBody,
              state: await persistence.get<RunState>('runState'),
              review: await instance.getReview('review-owner'),
            };
          } finally {
            release.resolve();
          }
        }
      );
      expect(result.writes).toBe(1);
      expect(result.state).toMatchObject({
        status: 'error',
        terminationReason: 'cancelled',
        completedAt: result.terminal?.completedAt,
        published: true,
        input: { kiloToken: '', gitToken: '' },
      });
      expect(result.state?.githubToken).toBeUndefined();
      expect(result.state?.publicationOutcome?.[kind]).toBe('confirmed');
      expect(result.review?.status).toBe('error');
      if (kind === 'review') {
        expect(result.state?.reviewId).toBe(17);
        expect(result.state?.reviewFingerprint).toBe(result.terminal?.reviewPendingFingerprint);
      } else {
        expect(result.state?.summaryCommentId).toBe(22);
        expect(result.state?.summaryFingerprint).toBe(result.terminal?.summaryPendingFingerprint);
        expect(result.publishedBody.startsWith('<!-- kilo-review -->')).toBe(true);
        expect(result.publishedBody).toContain('Summary');
        expect(result.state?.summaryBodyHash).toBe(
          createHash('sha256').update(result.publishedBody).digest('hex')
        );
      }
    }
  );

  it.each([true, false])(
    'completes zero-inline analysis only after a valid summary and clean parent finish (dryRun=%s)',
    async dryRun => {
      const runId = crypto.randomUUID();
      const cleanupAt = Date.now() + 86_400_000;
      const body = '<!-- kilo-review -->\nNo Issues Found';
      const summaryContent = { body, bodyHash: createHash('sha256').update(body).digest('hex') };
      const publicationBody = `${body}\n<!-- kilo-isolate-review-summary:${createHash('sha256').update(runId).digest('hex')} -->`;
      const publicationBodyHash = createHash('sha256').update(publicationBody).digest('hex');
      await seedState(runId, {
        status: 'running',
        headSha: HEAD_SHA,
        githubToken: 'minted-token',
        cleanupAt,
        input: { ...input, dryRun },
      });
      const fetchMock = vi.fn(async (url: string, options?: RequestInit) =>
        fixtureGithubResponse(url, options)
      );
      vi.stubGlobal('fetch', fetchMock);
      const review = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async (instance, durableState) => {
          await instance.getReview('review-owner');
          await executeTool(instance.getTools(), 'upsert_summary', { body: 'No Issues Found' });
          const proposed = await createReviewPersistence(
            durableState.storage
          ).persistence.get<RunState>('runState');
          expect(proposed?.summaryContent).toEqual(summaryContent);
          expect(proposed?.summaryProposal).not.toHaveProperty('summaryContent');
          expect(proposed?.summaryProposal?.bodyHash).toBe(publicationBodyHash);
          expect((await instance.getReview('review-owner'))?.summaryContent).toBeUndefined();
          await finishSubmission(instance, runId);
          return instance.getReview('review-owner');
        }
      );
      expect(review).toMatchObject({
        status: 'completed',
        terminationReason: 'completed',
        cleanupAt,
        summaryContent,
        analysisOutcome: { status: 'completed', parentFinishReason: 'stop' },
        publicationOutcome: { review: 'not_requested', summary: dryRun ? 'proposed' : 'confirmed' },
        summaryProposal: { publishable: true, bodyHash: publicationBodyHash },
      });
      expect(summaryContent.bodyHash).not.toBe(publicationBodyHash);
      expect(review?.summaryBodyHash).toBe(dryRun ? undefined : publicationBodyHash);
      expect((await readState(runId))?.summaryContent).toEqual(summaryContent);
      expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(
        dryRun ? 0 : 1
      );
    }
  );

  it.each([true, false])(
    'rejects a clean finish with no valid summary proposal (dryRun=%s)',
    async dryRun => {
      const runId = crypto.randomUUID();
      await seedState(runId, { status: 'running', input: { ...input, dryRun } });
      await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          await instance.getReview('review-owner');
          await finishSubmission(instance, runId);
        }
      );
      await expect(readState(runId)).resolves.toMatchObject({
        status: 'error',
        terminationReason: 'missing_summary',
        analysisOutcome: { status: 'incomplete' },
      });
    }
  );

  it.each([
    {
      label: 'step budget',
      analysis: { stepCount: 39 },
      finishReason: 'tool-calls',
      reason: 'step_limit',
    },
    {
      label: 'clean finish above the cumulative step budget',
      analysis: { stepCount: 40 },
      finishReason: 'stop',
      reason: 'step_limit',
    },
    {
      label: 'length limit',
      analysis: { stepCount: 1 },
      finishReason: 'length',
      reason: 'parent_incomplete',
    },
    {
      label: 'required context',
      analysis: { stepCount: 1, contextIncompleteReasons: ['missing immutable evidence'] },
      finishReason: 'stop',
      reason: 'required_context_incomplete',
    },
    {
      label: 'child exhaustion',
      analysis: { stepCount: 1, incompleteTaskIds: ['child-1'] },
      finishReason: 'stop',
      reason: 'child_incomplete',
    },
  ])(
    'keeps a provisional summary incomplete after $label',
    async ({ analysis, finishReason, reason }) => {
      const runId = crypto.randomUUID();
      await seedState(runId, {
        status: 'running',
        input: { ...input, dryRun: true },
        summaryProposal,
        summaryContent: baselineSummary,
        analysisOutcome: { status: 'running', ...analysis },
      });
      await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          await instance.getReview('review-owner');
          await finishSubmission(instance, runId, finishReason);
          expect((await instance.getReview('review-owner'))?.summaryContent).toBeUndefined();
        }
      );
      await expect(readState(runId)).resolves.toMatchObject({
        status: 'error',
        terminationReason: reason,
        summaryContent: baselineSummary,
        analysisOutcome: { status: 'incomplete', parentFinishReason: finishReason },
      });
    }
  );

  it.each(['pending', 'rejected'] as const)(
    'does not complete when the summary is confirmed but inline publication remains %s',
    async outcome => {
      const runId = crypto.randomUUID();
      await seedState(runId, {
        status: 'running',
        summaryProposal,
        summaryPublished: true,
        summaryCommentId: 22,
        summaryBodyHash: summaryProposal.bodyHash,
        published: true,
        reviewPending: outcome === 'pending',
        publicationOutcome: { review: outcome, summary: 'confirmed' },
      });
      await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async instance => {
          await instance.getReview('review-owner');
          await finishSubmission(instance, runId);
        }
      );
      await expect(readState(runId)).resolves.toMatchObject({
        status: 'error',
        terminationReason: 'publication_incomplete',
        published: true,
        summaryCommentId: 22,
        analysisOutcome: { status: 'completed' },
        publicationOutcome: {
          review: outcome === 'pending' ? 'uncertain' : 'rejected',
          summary: 'confirmed',
        },
      });
    }
  );

  it('does not advertise raw GitHub Lite proposals as publishable', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, {
      status: 'running',
      headSha: HEAD_SHA,
      githubToken: 'minted-token',
      appType: 'lite',
      input: { ...input, dryRun: true },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => fixtureGithubResponse(url, options))
    );
    const review = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        await instance.getReview('review-owner');
        const proposal = await executeTool(instance.getTools(), 'upsert_summary', {
          body: 'Read-only summary',
        });
        expect(proposal).toMatchObject({ dryRun: true, publishable: false });
        await finishSubmission(instance, runId);
        return instance.getReview('review-owner');
      }
    );
    expect(review).toMatchObject({
      status: 'completed',
      appType: 'lite',
      summaryProposal: {
        publishable: false,
        blockedReason: 'GitHub Lite installations cannot publish reviews',
      },
    });
  });

  it('keeps publication-only ownership restrictions separate from dry-run analysis completion', async () => {
    const runId = crypto.randomUUID();
    await seedState(runId, {
      status: 'running',
      headSha: HEAD_SHA,
      githubToken: 'minted-token',
      input: { ...input, dryRun: true },
    });
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (new URL(url).pathname.endsWith('/issues/42/comments'))
        return Response.json([
          {
            id: 99,
            body: '<!-- kilo-review -->\nProduction summary',
            user: { login: 'kilo-code[bot]' },
            issue_url: 'https://api.github.com/repos/acme/widget/issues/42',
          },
        ]);
      return fixtureGithubResponse(url, options);
    });
    vi.stubGlobal('fetch', fetchMock);
    const review = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async instance => {
        await instance.getReview('review-owner');
        const proposal = await executeTool(instance.getTools(), 'upsert_summary', {
          body: 'Read-only summary',
        });
        expect(proposal).toMatchObject({ dryRun: true, publishable: false });
        await finishSubmission(instance, runId);
        return instance.getReview('review-owner');
      }
    );
    expect(review).toMatchObject({
      status: 'completed',
      summaryProposal: { publishable: false, blockedReason: expect.stringContaining('ownership') },
    });
    expect(
      fetchMock.mock.calls.every(
        ([, options]) => options?.method !== 'POST' && options?.method !== 'PATCH'
      )
    ).toBe(true);
  });

  it.each([
    { label: 'valid prior run', override: {}, valid: true },
    {
      label: 'wrong execution owner',
      override: { input: { ...input, userId: 'other-owner' } },
      valid: false,
    },
    {
      label: 'wrong organization',
      override: { input: { ...input, organizationId: 'other-org' } },
      valid: false,
    },
    {
      label: 'wrong repository',
      override: { input: { ...input, repo: 'other-repo' } },
      valid: false,
    },
    { label: 'wrong PR', override: { input: { ...input, pullNumber: 43 } }, valid: false },
    {
      label: 'wrong installation',
      override: { installationId: 'other-installation' },
      valid: false,
    },
    { label: 'wrong app', override: { appType: 'lite' }, valid: false },
    { label: 'missing body hash', override: { summaryBodyHash: undefined }, valid: false },
    {
      label: 'legacy unknown publication',
      override: { publicationOutcome: undefined },
      valid: false,
    },
  ] satisfies Array<{ label: string; override: Partial<RunState>; valid: boolean }>)(
    'proves summary ownership against authenticated prior state: $label',
    async ({ override, valid }) => {
      const previousRunId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      await seedState(previousRunId, {
        status: 'completed',
        input: { ...input, gitToken: '', kiloToken: '' },
        installationId: 'installation-1',
        appType: 'standard',
        summaryCommentId: 9,
        summaryBodyHash: summaryOwnership.bodyHash,
        summaryPublished: true,
        publicationOutcome: { review: 'not_requested', summary: 'confirmed' },
        ...override,
      });
      await seedState(runId, { input: { ...input, previousRunId } });
      vi.mocked(resolveGithubCredentials).mockResolvedValueOnce({
        token: 'minted-token',
        installationId: 'installation-1',
        appType: 'standard',
      });
      submitMessages.mockResolvedValueOnce(
        submitInspection(runId, 'running', 'owned-summary-submission')
      );
      const promise = runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        instance => instance.runClone({ runId })
      );
      if (valid) {
        await promise;
        await expect(readState(runId)).resolves.toMatchObject({
          summaryOwnership: { previousRunId, commentId: 9, bodyHash: summaryOwnership.bodyHash },
        });
        expect(submitMessages).toHaveBeenCalledOnce();
      } else {
        await expect(promise).rejects.toThrow('Previous summary ownership could not be proven');
        expect(cloneRepository).not.toHaveBeenCalled();
        expect(resolveIsolateReviewInference).not.toHaveBeenCalled();
        expect(submitMessages).not.toHaveBeenCalled();
      }
    }
  );

  it('completes a live submission once its summary publication is confirmed', async () => {
    const runId = crypto.randomUUID();
    submitMessages.mockResolvedValue(submitInspection(runId, 'completed', 'completed-submission'));
    await seedState(runId, {
      summaryCommentId: 22,
      summaryPublished: true,
      published: true,
      summaryBodyHash: summaryProposal.bodyHash,
      analysisOutcome: cleanAnalysis,
      summaryProposal,
      publicationOutcome: { review: 'not_requested', summary: 'confirmed' },
    });

    await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      instance => instance.runClone({ runId })
    );

    await expect(readState(runId)).resolves.toMatchObject({
      runId,
      status: 'completed',
      summaryCommentId: 22,
      summaryPublished: true,
      input: { gitToken: '', kiloToken: '' },
    });
  });
});
