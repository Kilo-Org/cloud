import { createHash } from 'node:crypto';
import {
  abortAllDurableObjects,
  env,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from 'cloudflare:test';
import { Think, type StepContext, type ThinkSubmissionInspection } from '@cloudflare/think';
import app from '../../src/index';
import { deriveCallbackToken, signKiloToken, verifyKiloToken } from '@kilocode/worker-utils';
import { generateText, type ToolSet } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { admitRepository, cloneRepository, resolveReviewSnapshot } from '../../src/git';
import type * as Git from '../../src/git';
import { resolveGithubCredentials } from '../../src/github-token';
import type * as GithubToken from '../../src/github-token';
import { createReviewPersistence } from '../../src/persistence';
import type * as Persistence from '../../src/persistence';
import { DEFAULT_MODEL, SYSTEM_PROMPT_VERSION } from '../../src/prompt';
import { MAX_RETRIEVAL_BYTES } from '../../src/github';
import { projectReviewTranscript } from '../../src/transcript';
import {
  getQueuedReviewIsolateStub,
  notifyQueuedReview,
  queuedCallback,
  queuedPreparationHash,
  readQueuedJson,
  readQueuedProviderFailure,
  requestQueuedAuthority,
  type QueuedReviewRequest,
  type QueuedReviewState,
} from '../../src/queued-review';
import { ReviewIsolate } from '../../src/review-isolate';
import {
  queuedIdentityKey,
  QueuedIsolateAuthorityRequestSchema,
  QueuedIsolateNotificationSchema,
  type QueuedIsolateIdentity,
  type RunState,
  type StartReviewRequest,
} from '../../src/types';

vi.mock('@kilocode/worker-utils/kilo-token-auth', () => ({
  verifyKiloBearerAgainstCurrentPepper: async ({
    token,
    nextAuthSecret,
  }: {
    token: string;
    nextAuthSecret: string;
  }) => {
    const claims = await verifyKiloToken(token, nextAuthSecret).catch(() => null);
    return claims?.apiTokenPepper === 'fixture-pepper' ? { userId: claims.kiloUserId } : null;
  },
}));
const afterPersistence = vi.hoisted(() => vi.fn<(state: RunState) => void>());
vi.mock('../../src/persistence', async () => {
  const actual = await vi.importActual<typeof Persistence>('../../src/persistence');
  return {
    ...actual,
    createReviewPersistence: (storage: DurableObjectStorage) => {
      const result = actual.createReviewPersistence(storage);
      const put = result.persistence.put.bind(result.persistence);
      result.persistence.put = async (key, value) => {
        await put(key, value);
        if (key === 'runState') afterPersistence(value as RunState);
      };
      return result;
    },
  };
});
vi.mock('../../src/git', async () => ({
  ...(await vi.importActual<typeof Git>('../../src/git')),
  admitRepository: vi.fn(),
  cloneRepository: vi.fn(),
  resolveReviewSnapshot: vi.fn(),
}));
vi.mock('../../src/github-token', async () => ({
  ...(await vi.importActual<typeof GithubToken>('../../src/github-token')),
  resolveGithubCredentials: vi.fn(),
}));

const snapshot = {
  headSha: 'a'.repeat(40),
  baseTipSha: 'b'.repeat(40),
  mergeBaseSha: 'c'.repeat(40),
};
const installationId = 'installation-1';
const inference = {
  modelId: DEFAULT_MODEL,
  provider: 'openai-compatible' as const,
  thinkingEffort: null,
  variant: null,
  reasoningSupported: false,
  maxOutputTokens: 8_000,
};

function fixture(): QueuedReviewRequest {
  const identity: QueuedIsolateIdentity = {
    reviewId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    generation: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    integrationId: crypto.randomUUID(),
    executionUserId: 'arbitrary-user-id',
    target: { host: 'github.com', repoFullName: 'acme/widget', prNumber: 42 },
    snapshot,
  };
  const review: StartReviewRequest = {
    owner: 'acme',
    repo: 'widget',
    pullNumber: 42,
    organizationId: identity.organizationId,
    ...snapshot,
    model: DEFAULT_MODEL,
    expectedIntegrationId: identity.integrationId,
    expectedInstallationId: installationId,
    expectedAppType: 'standard',
    dryRun: false,
    userPrompt: 'Prepared review policy',
    inference,
    preparation: {
      version: 1,
      queued: { identity, gateThreshold: 'off', summaryHistory: '' },
      preparedAt: new Date().toISOString(),
      requestingUserId: 'requesting-user',
      executionUserId: identity.executionUserId,
      organizationId: identity.organizationId,
      settings: {
        reviewStyle: 'strict',
        focusAreas: [],
        customInstructions: null,
        manualInstructions: null,
        model: DEFAULT_MODEL,
        thinkingEffort: null,
        modelSource: 'explicit',
        disableReviewMd: false,
        analyticsEnabled: false,
      },
      snapshot,
      github: { integrationId: identity.integrationId, installationId, appType: 'standard' },
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
  };
  return {
    admission: {
      version: 1,
      identity,
      runId: identity.attemptId,
      preparationHash: queuedPreparationHash(review),
    },
    review,
  };
}

async function executionHeaders(
  request: QueuedReviewRequest,
  overrides: {
    expiresInSeconds?: number;
    tokenSource?: string;
    organizationId?: string;
    pepper?: string;
  } = {}
) {
  if (typeof env.NEXTAUTH_SECRET !== 'string') throw new Error('Expected fixture secret');
  const { token } = await signKiloToken({
    userId: request.admission.identity.executionUserId,
    secret: env.NEXTAUTH_SECRET,
    pepper: overrides.pepper ?? 'fixture-pepper',
    env: 'test',
    expiresInSeconds: overrides.expiresInSeconds ?? 3_600,
    extra: {
      tokenSource: overrides.tokenSource ?? 'isolate-review',
      organizationId: overrides.organizationId ?? request.admission.identity.organizationId,
    },
  });
  return {
    'Content-Type': 'application/json',
    'x-internal-api-key': env.INTERNAL_API_SECRET,
    authorization: `Bearer ${token}`,
  };
}

async function controlHeaders(identity: QueuedIsolateIdentity, operation: 'status' | 'cancel') {
  return {
    'Content-Type': 'application/json',
    'x-internal-api-key': env.INTERNAL_API_SECRET,
    'x-isolate-control-token': await deriveCallbackToken({
      secret: env.INTERNAL_API_SECRET,
      scope: 'queued-isolate-control',
      resourceParts: [operation, queuedIdentityKey(identity)],
    }),
  };
}

async function start(request: QueuedReviewRequest, headers?: HeadersInit) {
  const response = await SELF.fetch('https://worker.test/queued-reviews', {
    method: 'POST',
    headers: headers ?? (await executionHeaders(request)),
    body: JSON.stringify(request),
  });
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: response.headers,
  });
}

async function control(
  identity: QueuedIsolateIdentity,
  operation: 'status' | 'cancel',
  headers?: HeadersInit
) {
  const response = await SELF.fetch(
    `https://worker.test/queued-reviews/${identity.attemptId}/control`,
    {
      method: 'POST',
      headers: headers ?? (await controlHeaders(identity, operation)),
      body: JSON.stringify({ version: 1, identity, operation }),
    }
  );
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: response.headers,
  });
}

function stub(request: QueuedReviewRequest) {
  return getQueuedReviewIsolateStub(env, request.admission.runId);
}

async function readState(request: QueuedReviewRequest) {
  return runInDurableObject(stub(request), (_instance, state) =>
    createReviewPersistence(state.storage).persistence.get<RunState>('runState')
  );
}

async function runClone(request: QueuedReviewRequest) {
  await runInDurableObject(stub(request), instance =>
    instance.runClone({ runId: request.admission.runId })
  );
}

async function maintain(request: QueuedReviewRequest) {
  await runInDurableObject(stub(request), instance =>
    instance.maintainQueuedReview({ runId: request.admission.runId })
  );
}

async function cleanup(request: QueuedReviewRequest) {
  await runInDurableObject(stub(request), instance =>
    instance.cleanupReview({ runId: request.admission.runId })
  );
}

async function execute(tools: ToolSet, name: string, input: unknown) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error('Missing fixture tool');
  return execute(input as never, { toolCallId: 'fixture-call', messages: [] });
}

function gate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}

function requestUrl(request: RequestInfo | URL) {
  return typeof request === 'string'
    ? request
    : request instanceof URL
      ? request.href
      : request.url;
}

function requestBody(init?: RequestInit) {
  if (typeof init?.body !== 'string') throw new Error('Expected string request body');
  return init.body;
}

function streamedJsonResponse(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        const chunk = bytes.slice(offset, offset + 4_096);
        offset += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

type ResponsesToolCall = { name: string; input: Record<string, unknown> };
type ResponsesWireBody = {
  model: string;
  stream: boolean;
  store: boolean;
  input: Array<{
    type?: string;
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
    call_id?: string;
    output?: string;
  }>;
};

function responsesReply(index: number, model: string, call?: ResponsesToolCall) {
  const item = call
    ? {
        type: 'function_call',
        id: `fc_${index}`,
        call_id: `call_${index}`,
        name: call.name,
        arguments: JSON.stringify(call.input),
        status: 'completed',
      }
    : {
        type: 'message',
        id: `msg_${index}`,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Review complete.', annotations: [] }],
        status: 'completed',
      };
  const response = {
    id: `resp_${index}`,
    created_at: 1,
    model,
    output: [item],
    status: 'completed',
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const events = [
    { type: 'response.created', response: { id: response.id, created_at: 1, model } },
    { type: 'response.output_item.added', output_index: 0, item },
    call
      ? {
          type: 'response.function_call_arguments.delta',
          item_id: item.id,
          output_index: 0,
          delta: JSON.stringify(call.input),
        }
      : {
          type: 'response.output_text.delta',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: 'Review complete.',
        },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const submitMessages = vi.fn<ReviewIsolate['submitMessages']>();
const providerWrites: Array<{ path: string; body: string }> = [];
const notifications: Array<ReturnType<typeof QueuedIsolateNotificationSchema.parse>> = [];

async function fixtureFetch(request: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const nativeRequest = new Request(request instanceof URL ? request.href : request, init);
  const url = new URL(nativeRequest.url);
  if (
    url.origin === 'https://app.kilo.ai' &&
    url.pathname.startsWith('/api/internal/code-review-status/')
  ) {
    const body: unknown = JSON.parse(requestBody(init));
    const authority = QueuedIsolateAuthorityRequestSchema.safeParse(body);
    if (authority.success)
      return Response.json({
        ...authority.data,
        authorized: true,
        ...(authority.data.operation === 'reconcile'
          ? { reconciliationUserId: `bot-code-review-${authority.data.identity.organizationId}` }
          : {}),
      });
    const notification = QueuedIsolateNotificationSchema.parse(body);
    notifications.push(notification);
    return Response.json({
      version: 1,
      identity: notification.identity,
      sequence: notification.safety.sequence,
      notificationRecorded: true,
      fenceReleased: notification.safety.quiescent,
      usageSettled: notification.safety.quiescent,
    });
  }
  if (url.origin !== 'https://api.github.com')
    throw new Error('Unexpected external network request');
  if (init?.method === 'POST' || init?.method === 'PATCH') {
    providerWrites.push({ path: url.pathname, body: requestBody(init) });
    return Response.json({ id: url.pathname.endsWith('/reviews') ? 17 : 22 });
  }
  if (url.pathname.endsWith('/pulls/42'))
    return Response.json({
      head: { sha: snapshot.headSha },
      base: { sha: snapshot.baseTipSha },
      state: 'open',
      draft: false,
      changed_files: 1,
    });
  if (url.pathname.includes('/compare/'))
    return Response.json({
      base_commit: { sha: snapshot.baseTipSha },
      merge_base_commit: { sha: snapshot.mergeBaseSha },
      files: [
        {
          sha: snapshot.headSha,
          filename: 'source.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -0,0 +1 @@\n+first',
        },
      ],
    });
  if (url.pathname.endsWith('/comments') || url.pathname.endsWith('/reviews'))
    return Response.json([]);
  throw new Error('Unexpected GitHub fixture read');
}

async function invokeTerminal(
  instance: ReviewIsolate,
  request: QueuedReviewRequest,
  status: 'completed' | 'error' | 'aborted',
  error?: string
) {
  const hook = Reflect.get(instance, 'onSubmissionStatus');
  if (typeof hook !== 'function') throw new Error('Missing submission hook');
  await Reflect.apply(hook, instance, [
    {
      submissionId: 'queued-submission',
      idempotencyKey: request.admission.runId,
      status,
      error,
      createdAt: Date.now(),
    } satisfies ThinkSubmissionInspection,
  ]);
}

describe('native queued callback transport', () => {
  async function callbackFixture(): Promise<QueuedReviewState> {
    const { admission } = fixture();
    const safety: QueuedReviewState['safety'] = {
      sequence: 1,
      execution: 'not_started',
      cancellationRequested: false,
      publication: 'not_started',
      quiescent: false,
      observedAt: new Date().toISOString(),
    };
    return {
      identity: admission.identity,
      preparationHash: admission.preparationHash,
      admitted: false,
      cancellationRequested: false,
      callback: await queuedCallback(env, admission.identity),
      maintenanceScheduleId: 'native-callback-fixture',
      operations: [],
      safety,
      fenceReleased: false,
      pendingNotification: { version: 1, identity: admission.identity, safety },
      acknowledgedSequence: 0,
      cleaned: false,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['authority', 'notification'] as const)(
    'delivers %s with native Worker request options',
    async kind => {
      const queued = await callbackFixture();
      const send = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input instanceof URL ? input.href : input, init);
        expect(request.url).toBe(queued.callback.url);
        expect(request.method).toBe('POST');
        expect(request.redirect).toBe('manual');
        expect(request.headers.get('X-Callback-Token')).toBe(queued.callback.token);
        const body: unknown = await request.json();
        if (kind === 'authority') {
          const authority = QueuedIsolateAuthorityRequestSchema.parse(body);
          return Response.json({ ...authority, authorized: true });
        }
        const notification = QueuedIsolateNotificationSchema.parse(body);
        return Response.json({
          version: 1,
          identity: notification.identity,
          sequence: notification.safety.sequence,
          notificationRecorded: true,
          fenceReleased: false,
          usageSettled: false,
        });
      });
      vi.stubGlobal('fetch', send);

      if (kind === 'authority') {
        expect(await requestQueuedAuthority(queued, 'execute', crypto.randomUUID())).toBe(true);
      } else {
        expect(await notifyQueuedReview(queued)).toMatchObject({
          identity: queued.identity,
          sequence: queued.safety.sequence,
          notificationRecorded: true,
        });
      }
      expect(send).toHaveBeenCalledOnce();
    }
  );

  it.each(
    (['authority', 'notification'] as const).flatMap(kind =>
      [301, 302, 303, 307, 308].map(status => ({ kind, status }))
    )
  )('rejects $kind HTTP $status without forwarding its capability', async ({ kind, status }) => {
    const queued = await callbackFixture();
    const requests: Request[] = [];
    const cancel = vi.fn();
    const send = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input instanceof URL ? input.href : input, init);
      requests.push(request);
      await request.body?.cancel();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('Untrusted redirect response'));
          },
          cancel,
        }),
        { status, headers: { Location: 'https://redirect.invalid/callback' } }
      );
    });
    vi.stubGlobal('fetch', send);

    await expect(
      kind === 'authority'
        ? requestQueuedAuthority(queued, 'execute', crypto.randomUUID())
        : notifyQueuedReview(queued)
    ).rejects.toThrow('Queued review callback unavailable');
    expect(send).toHaveBeenCalledOnce();
    expect(requests.map(request => request.url)).toEqual([queued.callback.url]);
    expect(requests[0].redirect).toBe('manual');
    expect(requests[0].headers.get('X-Callback-Token')).toBe(queued.callback.token);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('queued isolate admission and safety contract', () => {
  beforeEach(() => {
    notifications.length = 0;
    providerWrites.length = 0;
    afterPersistence.mockReset();
    vi.mocked(admitRepository).mockReset().mockResolvedValue({ sizeKiB: 1 });
    vi.mocked(resolveReviewSnapshot).mockReset().mockResolvedValue(snapshot);
    vi.mocked(cloneRepository).mockReset().mockResolvedValue({
      tipFileCount: 1,
      tipTotalBytes: 5,
      vfsTotalBytes: 5,
      vfsFileCount: 1,
      cloneMs: 1,
    });
    vi.mocked(resolveGithubCredentials)
      .mockReset()
      .mockResolvedValue({ token: 'github-fixture', installationId, appType: 'standard' });
    submitMessages.mockReset().mockImplementation(async (_messages, options) => ({
      accepted: true,
      submissionId: 'queued-submission',
      idempotencyKey: options?.idempotencyKey,
      status: 'running',
      createdAt: Date.now(),
    }));
    vi.spyOn(ReviewIsolate.prototype, 'submitMessages').mockImplementation(submitMessages);
    vi.spyOn(Think.prototype, 'cancelSubmission').mockResolvedValue();
    const schedule = Reflect.get(ReviewIsolate.prototype, 'schedule') as ReviewIsolate['schedule'];
    vi.spyOn(ReviewIsolate.prototype, 'schedule').mockImplementation(
      function (when, callback, payload, options) {
        return schedule.call(
          this,
          callback === 'runClone' ? 3_600 : when,
          callback,
          payload,
          options
        );
      }
    );
    vi.stubGlobal('fetch', vi.fn(fixtureFetch));
  });

  afterEach(async () => {
    await reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function canonicalSummaryRequest() {
    const request = fixture();
    const queued = request.review.preparation?.queued;
    if (!queued) throw new Error('Missing canonical fixture');
    const body =
      '<!-- kilo-review -->\nLegacy finding\n\n---\n<!-- kilo-usage -->\n<sub>Old usage</sub>';
    queued.gateThreshold = 'warning';
    queued.summaryHistory =
      '<!-- kilo-review-history -->\nArchived legacy finding\n<!-- /kilo-review-history -->';
    queued.summaryTarget = {
      commentId: 22,
      bodyHash: createHash('sha256').update(body).digest('hex'),
      authorId: 456,
      authorLogin: 'kiloconnect[bot]',
      appId: 123,
    };
    request.admission.preparationHash = queuedPreparationHash(request.review);
    const comment = {
      id: 22,
      body,
      user: { id: 456, login: 'kiloconnect[bot]', type: 'Bot' },
      issue_url: 'https://api.github.com/repos/acme/widget/issues/42',
      performed_via_github_app: { id: 123 },
    };
    return { request, comment };
  }

  function serveCanonicalSummary(comment: ReturnType<typeof canonicalSummaryRequest>['comment']) {
    vi.mocked(fetch).mockImplementation(async (request, init) => {
      const path = new URL(requestUrl(request)).pathname;
      if (!init?.method || init.method === 'GET') {
        if (path === '/repos/acme/widget/issues/42/comments') return Response.json([comment]);
        if (path === '/repos/acme/widget/issues/comments/22') return Response.json(comment);
      }
      return fixtureFetch(request, init);
    });
  }

  it('updates the exact canonical legacy summary with code-owned history and a persisted gate result', async () => {
    const { request, comment } = canonicalSummaryRequest();
    serveCanonicalSummary(comment);
    expect((await start(request)).status).toBe(202);
    await runClone(request);
    await runInDurableObject(stub(request), async instance => {
      const tools = instance.getTools();
      const { instructions } = await instance.beforeTurn({
        system: '',
        messages: [],
        tools,
        model: instance.getModel(),
        continuation: false,
      });
      expect(instructions).toContain(`canonical review ${request.admission.identity.reviewId}`);
      expect(instructions).toContain('merge-gate threshold is warning');
      expect(instructions).not.toContain('This isolate has no canonical review ID');
      expect(instructions).toContain(
        "override the skill's direct experimental previous-run ownership"
      );
      expect(
        await execute(tools, 'upsert_summary', { body: 'Current findings', gateResult: 'fail' })
      ).toEqual({ id: 22 });
      await instance.onStepEnd({ finishReason: 'stop', toolCalls: [] } as StepContext);
      await invokeTerminal(instance, request, 'completed');
    });
    expect(providerWrites).toHaveLength(1);
    expect(providerWrites[0].path).toBe('/repos/acme/widget/issues/comments/22');
    expect(JSON.parse(providerWrites[0].body).body).toBe(
      '<!-- kilo-review -->\nCurrent findings\n\n' +
        request.review.preparation?.queued?.summaryHistory
    );
    expect(providerWrites[0].body).not.toContain('Old usage');
    expect(await readState(request)).toMatchObject({
      status: 'completed',
      gateResult: 'fail',
      queued: {
        operations: [
          expect.objectContaining({ kind: 'summary', state: 'confirmed', commentId: 22 }),
        ],
      },
    });
    await abortAllDurableObjects();
    expect(await readState(request)).toMatchObject({ gateResult: 'fail' });
  });

  it('publishes a clean summary through the real Think Responses loop after an empty first-page comment hash', async () => {
    const { request, comment } = canonicalSummaryRequest();
    const model = 'openai/gpt-5.6-sol-discounted';
    const preparation = request.review.preparation;
    if (!preparation?.queued) throw new Error('Missing prepared queued fixture');
    request.review.model = model;
    request.review.inference = { ...inference, modelId: model, provider: 'openai' };
    preparation.settings.model = model;
    request.admission.preparationHash = queuedPreparationHash(request.review);
    const commentInput = { category: 'issue', id: comment.id, offset: 0, bodyHash: '' };
    const commentHash = createHash('sha256').update(comment.body).digest('hex');
    const summary = 'No Issues Found. The previously reported issue is fixed.';
    const script: ResponsesToolCall[] = [
      { name: 'activate_skill', input: { name: 'github-cloud-review' } },
      { name: 'pr_view', input: { offset: 0, bodyHash: '' } },
      { name: 'pr_diff', input: {} },
      { name: 'pr_comments', input: { category: 'inline', page: 1, offset: 0 } },
      { name: 'pr_comments', input: { category: 'issue', page: 1, offset: 0 } },
      { name: 'pr_comments', input: { category: 'reviews', page: 1, offset: 0 } },
      { name: 'pr_comment', input: commentInput },
      { name: 'upsert_summary', input: { body: summary, gateResult: 'pass' } },
    ];
    const requests: ResponsesWireBody[] = [];
    serveCanonicalSummary(comment);
    const served = vi.mocked(fetch).getMockImplementation();
    if (!served) throw new Error('Missing canonical summary transport');
    vi.spyOn(ReviewIsolate.prototype, 'submitMessages').mockRestore();
    vi.spyOn(Think.prototype, 'cancelSubmission').mockRestore();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const nativeRequest = new Request(input instanceof URL ? input.href : input, init);
      const url = new URL(nativeRequest.url);
      if (url.origin !== 'https://api.kilo.ai') return served(input, init);
      expect(url.pathname.endsWith('/responses')).toBe(true);
      const body = await nativeRequest.json<ResponsesWireBody>();
      expect(body).toMatchObject({ model, stream: true, store: false });
      const index = requests.length;
      requests.push(body);
      if (index > script.length) throw new Error('Unexpected additional Responses request');
      return responsesReply(index, model, script[index]);
    });

    expect((await start(request)).status).toBe(202);
    await runClone(request);
    const terminal = await vi.waitFor(
      async () => {
        const state = await readState(request);
        expect(['completed', 'error']).toContain(state?.status);
        return state;
      },
      { timeout: 5_000, interval: 10 }
    );
    expect(terminal).toMatchObject({
      status: 'completed',
      terminationReason: 'completed',
      input: { kiloToken: '' },
      gateResult: 'pass',
      analysisOutcome: { status: 'completed' },
      publicationOutcome: { review: 'not_requested', summary: 'confirmed' },
      queued: {
        operations: [
          expect.objectContaining({ kind: 'summary', state: 'confirmed', commentId: 22 }),
        ],
        safety: { publication: 'settled', quiescent: true },
      },
    });
    expect(terminal?.analysisOutcome?.contextIncompleteReasons ?? []).toEqual([]);
    expect(terminal?.systemPromptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(terminal?.input.preparation?.hashes.workerSystem).toBe(terminal?.systemPromptHash);
    expect(requests).toHaveLength(script.length + 1);
    expect(providerWrites).toEqual([
      {
        path: '/repos/acme/widget/issues/comments/22',
        body: JSON.stringify({
          body: `<!-- kilo-review -->\n${summary}\n\n${preparation.queued.summaryHistory}`,
        }),
      },
    ]);
    expect(providerWrites[0].body).not.toContain('Old usage');
    using transcript = await stub(request).getTranscript(
      request.admission.identity.executionUserId
    );
    expect(transcript?.toolCalls.map(call => call.toolName)).toEqual(script.map(call => call.name));
    expect(transcript?.toolCalls.every(call => call.state === 'output-available')).toBe(true);
    expect(transcript?.toolCalls.filter(call => call.toolName === 'pr_comment')).toEqual([
      expect.objectContaining({
        state: 'output-available',
        input: commentInput,
        output: expect.objectContaining({
          id: comment.id,
          bodyHash: commentHash,
          serverOwnedBlocksExcluded: true,
          nextOffset: null,
        }),
      }),
    ]);
    await abortAllDurableObjects();
    using retained = await stub(request).getTranscript(request.admission.identity.executionUserId);
    expect(retained?.toolCalls).toEqual(transcript?.toolCalls);
    expect((await readState(request))?.terminationReason).toBe('completed');
  });

  it.each([
    'first-page-empty',
    'valid-continuation',
    'stale-first-page',
    'missing-continuation',
    'empty-continuation',
    'stale-continuation',
  ] as const)(
    'runs the real Think Responses loop with %s and retains its publication and transcript contract',
    async scenario => {
      const request = fixture();
      const model = 'openai/gpt-5.4-mini';
      request.review.model = model;
      request.review.inference = { ...inference, modelId: model, provider: 'openai' };
      if (!request.review.preparation) throw new Error('Missing prepared fixture');
      request.review.preparation.settings.model = model;
      request.admission.preparationHash = queuedPreparationHash(request.review);
      const valid = scenario === 'first-page-empty' || scenario === 'valid-continuation';
      const description =
        scenario === 'first-page-empty'
          ? 'A stable PR description for the first-page fixture.'
          : 'x'.repeat(MAX_RETRIEVAL_BYTES + 50);
      const descriptionHash = createHash('sha256').update(description).digest('hex');
      const script: ResponsesToolCall[] = [
        { name: 'activate_skill', input: { name: 'github-cloud-review' } },
        { name: 'pr_view', input: { offset: 0, bodyHash: '' } },
        ...(scenario === 'first-page-empty' ? [] : [{ name: 'pr_view', input: {} }]),
        ...(!valid ? [{ name: 'pr_view', input: { offset: 0, bodyHash: '' } }] : []),
        { name: 'pr_diff', input: {} },
        { name: 'pr_comments', input: {} },
        {
          name: 'submit_review',
          input: {
            comments: [{ path: 'source.ts', line: 1, side: 'RIGHT', body: 'Fixture finding' }],
          },
        },
        { name: 'upsert_summary', input: { body: 'Fixture summary' } },
      ];
      const requests: ResponsesWireBody[] = [];
      const instructions: string[] = [];
      const beforeTurn = Reflect.get(
        ReviewIsolate.prototype,
        'beforeTurn'
      ) as ReviewIsolate['beforeTurn'];
      vi.spyOn(ReviewIsolate.prototype, 'beforeTurn').mockImplementation(async function (context) {
        const turn = await beforeTurn.call(this, context);
        if (typeof turn.instructions !== 'string')
          throw new Error('Missing canonical instructions');
        instructions.push(turn.instructions);
        return turn;
      });
      vi.spyOn(ReviewIsolate.prototype, 'submitMessages').mockRestore();
      vi.spyOn(Think.prototype, 'cancelSubmission').mockRestore();
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const nativeRequest = new Request(input instanceof URL ? input.href : input, init);
        const url = new URL(nativeRequest.url);
        if (url.origin !== 'https://api.kilo.ai') {
          const response = await fixtureFetch(input, init);
          if (url.origin === 'https://api.github.com' && url.pathname.endsWith('/pulls/42')) {
            const pull = await response.json<Record<string, unknown>>();
            return Response.json({ ...pull, body: description });
          }
          return response;
        }
        expect(url.pathname.endsWith('/responses')).toBe(true);
        const body = await nativeRequest.json<ResponsesWireBody>();
        expect(body).toMatchObject({ model, stream: true, store: false });
        const index = requests.length;
        requests.push(body);
        if (index > script.length) throw new Error('Unexpected additional Responses request');
        let call = script[index];
        if (index === 2 && scenario !== 'first-page-empty') {
          const output = body.input.find(
            item => item.type === 'function_call_output' && item.call_id === 'call_1'
          )?.output;
          if (!output) throw new Error('Missing first-page tool result');
          const page = JSON.parse(output) as { nextOffset: number; bodyHash: string };
          expect(page.bodyHash).toBe(descriptionHash);
          expect(page.nextOffset).toBeGreaterThan(0);
          call = {
            name: 'pr_view',
            input: {
              offset: scenario === 'stale-first-page' ? 0 : page.nextOffset,
              ...(scenario === 'missing-continuation'
                ? {}
                : {
                    bodyHash:
                      scenario === 'valid-continuation'
                        ? page.bodyHash
                        : scenario === 'empty-continuation'
                          ? ''
                          : 'stale-fixture-hash',
                  }),
            },
          };
        }
        return responsesReply(index, model, call);
      });

      expect((await start(request)).status).toBe(202);
      await runClone(request);
      const terminal = await vi.waitFor(
        async () => {
          const state = await readState(request);
          expect(['completed', 'error']).toContain(state?.status);
          return state;
        },
        { timeout: 5_000, interval: 10 }
      );
      expect(instructions).toHaveLength(1);
      const canonical = instructions[0];
      const systemHash = createHash('sha256').update(canonical).digest('hex');
      expect(canonical).toContain(`canonical review ${request.admission.identity.reviewId}`);
      expect(canonical).toContain('QUEUED PUBLICATION POLICY');
      expect(canonical).not.toContain('RAW / DEFAULT REVIEW POLICY');
      expect(terminal?.systemPromptHash).toBe(systemHash);
      expect(terminal?.systemPromptVersion).toBe(SYSTEM_PROMPT_VERSION);
      expect(terminal?.input.preparation?.hashes.workerSystem).toBe(systemHash);
      expect(requests).toHaveLength(script.length + 1);
      for (const body of requests) {
        const system = body.input
          .filter(item => item.role === 'system' || item.role === 'developer')
          .map(item =>
            typeof item.content === 'string'
              ? item.content
              : (item.content?.map(part => part.text ?? '').join('') ?? '')
          )
          .join('\n');
        expect(system.split(canonical)).toHaveLength(2);
        expect(system).toContain('github-cloud-review');
      }
      expect(terminal).toMatchObject({
        status: valid ? 'completed' : 'error',
        terminationReason: valid ? 'completed' : 'required_context_incomplete',
        input: { kiloToken: '' },
      });
      expect(providerWrites).toHaveLength(valid ? 2 : 0);
      if (!valid) {
        expect(terminal?.analysisOutcome?.contextIncompleteReasons).toEqual([
          'PR description changed or continuation lacks its body hash',
        ]);
        expect(terminal?.queued?.operations).toEqual([]);
      }
      const transcript = await runInDurableObject(stub(request), async instance => {
        const live = await instance.getTranscript(request.admission.identity.executionUserId);
        const stored = projectReviewTranscript(await instance.syncMessagesFromStorage());
        expect(live).toEqual({ runId: request.admission.runId, ...stored });
        return live;
      });
      expect(transcript?.toolCalls.map(call => call.toolName)).toEqual(
        script.map(call => call.name)
      );
      const pages = transcript?.toolCalls.filter(call => call.toolName === 'pr_view');
      expect(pages?.[0]).toMatchObject({
        state: 'output-available',
        input: { offset: 0, bodyHash: '' },
        output: { bodyHash: descriptionHash },
      });
      if (!valid) {
        expect(pages?.[1]).toMatchObject({ state: 'output-error' });
        expect(pages?.[2]).toMatchObject({
          state: 'output-available',
          output: { bodyHash: descriptionHash },
        });
      }
      await abortAllDurableObjects();
      using retained = await stub(request).getTranscript(
        request.admission.identity.executionUserId
      );
      expect(retained?.[Symbol.dispose]).toBeTypeOf('function');
      const hydration = await runInDurableObject(stub(request), async instance => {
        const initialized = Boolean(instance.session);
        await instance.__unsafe_ensureInitialized();
        const stored = projectReviewTranscript(await instance.session.getHistory());
        const hydrated = await instance.getTranscript(request.admission.identity.executionUserId);
        return { initialized, stored, hydrated };
      });
      expect(hydration.stored.toolCalls).toEqual(transcript?.toolCalls);
      expect(hydration.hydrated).toEqual(transcript);
      expect(
        retained?.toolCalls.length,
        `Cold native RPC read: initialized=${hydration.initialized}, stored=${hydration.stored.toolCalls.length}, hydrated=${hydration.hydrated?.toolCalls.length}`
      ).toBe(transcript?.toolCalls.length);
      expect(retained?.toolCalls).toEqual(transcript?.toolCalls);
      expect(retained?.messages).toEqual(transcript?.messages);
      expect((await readState(request))?.terminationReason).toBe(terminal?.terminationReason);
    }
  );

  it.each([
    { id: 23 },
    { body: '<!-- kilo-review -->\nEdited summary' },
    { body: 'Marker removed' },
    { issue_url: 'https://api.github.com/repos/acme/widget/issues/43' },
    { user: { id: 999, login: 'kiloconnect[bot]', type: 'Bot' } },
    { user: { id: 456, login: 'foreign[bot]', type: 'Bot' } },
    { user: { id: 456, login: 'kiloconnect[bot]', type: 'User' } },
    { performed_via_github_app: { id: 999 } },
  ])('refuses a changed canonical summary target: %j', async changed => {
    const { request, comment } = canonicalSummaryRequest();
    serveCanonicalSummary({ ...comment, ...changed });
    expect((await start(request)).status).toBe(202);
    await runClone(request);
    await runInDurableObject(stub(request), async instance => {
      const publication = execute(instance.getTools(), 'upsert_summary', {
        body: 'Summary',
        gateResult: 'pass',
      });
      if ('issue_url' in changed) await expect(publication).rejects.toThrow('does not belong');
      else await expect(publication).resolves.toMatchObject({ publishable: false });
    });
    expect(providerWrites).toHaveLength(0);
  });

  it.each(['all', 'warning', 'critical'] as const)(
    'cannot complete with missing or invalid required %s gate output',
    async threshold => {
      const request = fixture();
      if (!request.review.preparation?.queued) throw new Error('Missing queued policy');
      request.review.preparation.queued.gateThreshold = threshold;
      request.admission.preparationHash = queuedPreparationHash(request.review);
      expect((await start(request)).status).toBe(202);
      await runClone(request);
      await runInDurableObject(stub(request), async instance => {
        for (const gateResult of [undefined, null, 'PASS', true]) {
          expect(
            await execute(instance.getTools(), 'upsert_summary', { body: 'Summary', gateResult })
          ).toMatchObject({ publishable: false });
        }
        await instance.onStepEnd({ finishReason: 'stop', toolCalls: [] } as StepContext);
        await invokeTerminal(instance, request, 'completed');
      });
      expect(providerWrites).toHaveLength(0);
      expect(await readState(request)).toMatchObject({
        status: 'error',
        terminationReason: 'parent_incomplete',
      });
    }
  );

  it('creates a canonical summary with a valid passing gate and no previous-run proof', async () => {
    const request = fixture();
    if (!request.review.preparation?.queued) throw new Error('Missing queued policy');
    request.review.preparation.queued.gateThreshold = 'critical';
    request.admission.preparationHash = queuedPreparationHash(request.review);
    expect((await start(request)).status).toBe(202);
    await runClone(request);
    await runInDurableObject(stub(request), async instance => {
      expect(
        await execute(instance.getTools(), 'upsert_summary', {
          body: 'No critical findings',
          gateResult: 'pass',
        })
      ).toEqual({ id: 22 });
      await instance.onStepEnd({ finishReason: 'stop', toolCalls: [] } as StepContext);
      await invokeTerminal(instance, request, 'completed');
      expect(await instance.getReview(request.admission.identity.executionUserId)).toMatchObject({
        status: 'completed',
        gateResult: 'pass',
      });
    });
    expect(providerWrites).toHaveLength(1);
    expect(providerWrites[0].path).toBe('/repos/acme/widget/issues/42/comments');
  });

  it.each(['pending', 'confirmed'] as const)(
    'binds gate result and content to the accepted summary when a competing proposal resumes during %s publication',
    async phase => {
      const request = fixture();
      if (!request.review.preparation?.queued) throw new Error('Missing queued policy');
      request.review.preparation.queued.gateThreshold = 'warning';
      request.admission.preparationHash = queuedPreparationHash(request.review);
      expect((await start(request)).status).toBe(202);
      await runClone(request);
      const preflightEntered = gate();
      const resumePreflight = gate();
      const writeEntered = gate();
      const resumeWrite = gate();
      let summaryReads = 0;
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        const path = new URL(requestUrl(url)).pathname;
        if (path === '/repos/acme/widget/issues/42/comments') {
          if (init?.method === 'POST') {
            writeEntered.release();
            await resumeWrite.promise;
          } else if (++summaryReads === 1) {
            preflightEntered.release();
            await resumePreflight.promise;
          }
        }
        return fixtureFetch(url, init);
      });
      await runInDurableObject(stub(request), async instance => {
        const tools = instance.getTools();
        const competing = execute(tools, 'upsert_summary', {
          body: 'Competing summary',
          gateResult: 'pass',
        }).then(
          value => ({ value }),
          error => ({ error })
        );
        let publishing: Promise<unknown> | undefined;
        try {
          await preflightEntered.promise;
          publishing = execute(tools, 'upsert_summary', {
            body: 'Accepted warning',
            gateResult: 'fail',
          });
          await writeEntered.promise;
          if (phase === 'confirmed') {
            resumeWrite.release();
            await publishing;
          }
          resumePreflight.release();
          const competingResult = await competing;
          resumeWrite.release();
          expect(await publishing).toEqual({ id: 22 });
          expect(competingResult).toMatchObject(
            phase === 'pending'
              ? { value: { publishable: false } }
              : {
                  error: expect.objectContaining({
                    message: expect.stringContaining('already published'),
                  }),
                }
          );
          await instance.onStepEnd({ finishReason: 'stop', toolCalls: [] } as StepContext);
          await invokeTerminal(instance, request, 'completed');
        } finally {
          resumePreflight.release();
          resumeWrite.release();
          await Promise.allSettled([competing, publishing]);
        }
      });
      await abortAllDurableObjects();
      const state = await readState(request);
      expect(state).toMatchObject({
        status: 'completed',
        gateResult: 'fail',
        summaryContent: { body: '<!-- kilo-review -->\nAccepted warning' },
      });
      expect(state?.summaryProposal?.fingerprint).toBe(state?.summaryFingerprint);
      expect(state?.queued?.operations).toEqual([
        expect.objectContaining({
          state: 'confirmed',
          fingerprint: state?.summaryFingerprint,
        }),
      ]);
      expect(providerWrites).toHaveLength(1);
      expect(JSON.parse(providerWrites[0].body).body).toContain('Accepted warning');
      expect(JSON.parse(providerWrites[0].body).body).not.toContain('Competing summary');
    }
  );

  it('binds gate result to the authorizing call when equal summary fingerprints compete before authorization', async () => {
    const request = fixture();
    if (!request.review.preparation?.queued) throw new Error('Missing queued policy');
    request.review.preparation.queued.gateThreshold = 'warning';
    request.admission.preparationHash = queuedPreparationHash(request.review);
    expect((await start(request)).status).toBe(202);
    await runClone(request);
    const firstAuthority = gate();
    const secondAuthority = gate();
    const resumeFirst = gate();
    const resumeSecond = gate();
    let authorizations = 0;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (typeof init?.body === 'string') {
        const authority = QueuedIsolateAuthorityRequestSchema.safeParse(JSON.parse(init.body));
        if (authority.success && authority.data.operation === 'publish') {
          if (++authorizations === 1) {
            firstAuthority.release();
            await resumeFirst.promise;
          } else {
            secondAuthority.release();
            await resumeSecond.promise;
          }
        }
      }
      return fixtureFetch(url, init);
    });
    await runInDurableObject(stub(request), async instance => {
      const firstTools = instance.getTools();
      const secondTools = instance.getTools();
      const publishing = execute(firstTools, 'upsert_summary', {
        body: 'Accepted warning',
        gateResult: 'fail',
      });
      let competing: Promise<unknown> | undefined;
      try {
        await firstAuthority.promise;
        competing = execute(secondTools, 'upsert_summary', {
          body: 'Accepted warning',
          gateResult: 'pass',
        }).then(
          value => ({ value }),
          error => ({ error })
        );
        await secondAuthority.promise;
        resumeFirst.release();
        expect(await publishing).toEqual({ id: 22 });
        resumeSecond.release();
        expect(await competing).toMatchObject({
          error: expect.objectContaining({
            message: expect.stringContaining('already pending or confirmed'),
          }),
        });
        await instance.onStepEnd({ finishReason: 'stop', toolCalls: [] } as StepContext);
        await invokeTerminal(instance, request, 'completed');
      } finally {
        resumeFirst.release();
        resumeSecond.release();
        await Promise.allSettled([publishing, competing]);
      }
    });
    await abortAllDurableObjects();
    const state = await readState(request);
    expect(state).toMatchObject({
      status: 'completed',
      gateResult: 'fail',
      summaryContent: { body: '<!-- kilo-review -->\nAccepted warning' },
    });
    expect(state?.summaryProposal?.fingerprint).toBe(state?.summaryFingerprint);
    expect(providerWrites).toHaveLength(1);
  });

  it('rechecks summary hash after awaited canonical publication authority', async () => {
    const { request, comment } = canonicalSummaryRequest();
    serveCanonicalSummary(comment);
    const provider = vi.mocked(fetch).getMockImplementation();
    if (!provider) throw new Error('Missing provider fixture');
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const response = await provider(url, init);
      if (typeof init?.body === 'string' && JSON.parse(init.body).operation === 'publish')
        comment.body += '\nConcurrent edit';
      return response;
    });
    expect((await start(request)).status).toBe(202);
    await runClone(request);
    await runInDurableObject(stub(request), async instance => {
      await expect(
        execute(instance.getTools(), 'upsert_summary', { body: 'Summary', gateResult: 'pass' })
      ).rejects.toThrow('body changed');
    });
    expect(providerWrites).toHaveLength(0);
  });

  it('requires current candidate authority for a canonical legacy-summary update', async () => {
    const { request, comment } = canonicalSummaryRequest();
    serveCanonicalSummary(comment);
    const provider = vi.mocked(fetch).getMockImplementation();
    if (!provider) throw new Error('Missing provider fixture');
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (typeof init?.body === 'string') {
        const data = QueuedIsolateAuthorityRequestSchema.safeParse(JSON.parse(init.body));
        if (data.success && data.data.operation === 'publish')
          return Response.json({ ...data.data, authorized: false });
      }
      return provider(url, init);
    });
    expect((await start(request)).status).toBe(202);
    await runClone(request);
    await runInDurableObject(stub(request), async instance => {
      await expect(
        execute(instance.getTools(), 'upsert_summary', { body: 'Summary', gateResult: 'pass' })
      ).rejects.toThrow('authority denied');
    });
    expect(providerWrites).toHaveLength(0);
  });

  it('retains canonical history evidence for read-only reconciliation after cleanup', async () => {
    const { request, comment } = canonicalSummaryRequest();
    serveCanonicalSummary(comment);
    const provider = vi.mocked(fetch).getMockImplementation();
    if (!provider) throw new Error('Missing provider fixture');
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (init?.method === 'PATCH') comment.body = JSON.parse(requestBody(init)).body;
      return provider(url, init);
    });
    expect((await start(request)).status).toBe(202);
    await runClone(request);
    await runInDurableObject(stub(request), async (instance, durableState) => {
      await execute(instance.getTools(), 'upsert_summary', { body: 'Summary', gateResult: 'pass' });
      const persistence = createReviewPersistence(durableState.storage).persistence;
      const state = await persistence.get<RunState>('runState');
      if (!state?.queued) throw new Error('Missing persisted state');
      const sentBody = providerWrites[0].body;
      await persistence.put('runState', {
        ...state,
        summaryPublished: false,
        summaryCommentId: undefined,
        summaryPending: true,
        summaryPendingCommentId: 22,
        summaryPendingFingerprint: state.summaryFingerprint,
        summaryPendingBodyHash: state.summaryBodyHash,
        queued: {
          ...state.queued,
          operations: state.queued.operations.map(operation => ({
            ...operation,
            state: 'sent',
            requestBody: sentBody,
          })),
        },
      });
    });
    await cleanup(request);
    await abortAllDurableObjects();
    await maintain(request);
    expect(await readState(request)).toMatchObject({
      queued: { cleaned: true, safety: { publication: 'settled', quiescent: true } },
    });
    expect(providerWrites).toHaveLength(1);
  });

  it('rejects canonical metadata through direct admission and mismatched queued generations', async () => {
    const request = fixture();
    const direct = env.REVIEW_ISOLATE.getByName(crypto.randomUUID());
    await runInDurableObject(direct, async instance => {
      await expect(
        instance.startReview(crypto.randomUUID(), {
          ...request.review,
          userId: request.admission.identity.executionUserId,
          kiloToken: 'fixture',
          credentialsExpireAt: Date.now() + 60_000,
        })
      ).rejects.toThrow('queued admission');
    });
    if (!request.review.preparation?.queued) throw new Error('Missing queued policy');
    request.review.preparation.queued.identity = {
      ...request.admission.identity,
      generation: crypto.randomUUID(),
    };
    request.admission.preparationHash = queuedPreparationHash(request.review);
    expect((await start(request)).status).not.toBe(202);
    expect(submitMessages).not.toHaveBeenCalled();
  });

  it('admits one logical execution through real routes across concurrent starts and eviction', async () => {
    const request = fixture();
    const results = await Promise.all([start(request), start(request)]);
    expect(results.map(response => response.status)).toEqual([202, 202]);
    await Promise.all([runClone(request), runClone(request)]);
    expect(cloneRepository).toHaveBeenCalledOnce();
    expect(submitMessages).toHaveBeenCalledOnce();
    const state = await readState(request);
    expect(state).toMatchObject({
      runId: request.admission.runId,
      status: 'running',
      queued: { admitted: true, identity: request.admission.identity },
    });
    const direct = await runInDurableObject(
      env.REVIEW_ISOLATE.getByName(request.admission.runId),
      (_instance, state) => createReviewPersistence(state.storage).persistence.get('runState')
    );
    expect(direct).toBeUndefined();
    await abortAllDurableObjects();
    expect((await start(request)).status).toBe(202);
    await runClone(request);
    expect(submitMessages).toHaveBeenCalledOnce();
    expect((await readState(request))?.credentialsExpireAt).toBe(state?.credentialsExpireAt);
  });

  it.each(['completed', 'cancelled'] as const)(
    'retains acknowledged cloning evidence through a pending submission and %s after eviction',
    async outcome => {
      const request = fixture();
      submitMessages.mockImplementation(async (_messages, options) => ({
        accepted: true,
        submissionId: 'queued-submission',
        idempotencyKey: options?.idempotencyKey,
        status: 'pending',
        createdAt: Date.now(),
      }));
      expect((await start(request)).status).toBe(202);
      const entered = gate();
      const held = gate();
      vi.mocked(cloneRepository).mockImplementation(async () => {
        entered.release();
        await held.promise;
        return { tipFileCount: 1, tipTotalBytes: 5, vfsTotalBytes: 5, vfsFileCount: 1, cloneMs: 1 };
      });
      await runInDurableObject(stub(request), async (instance, durableState) => {
        const cloning = instance.runClone({ runId: request.admission.runId });
        try {
          await entered.promise;
          await instance.maintainQueuedReview({ runId: request.admission.runId });
          await instance.maintainQueuedReview({ runId: request.admission.runId });
          const state = await createReviewPersistence(
            durableState.storage
          ).persistence.get<RunState>('runState');
          expect(state).toMatchObject({
            status: 'cloning',
            queued: { safety: { execution: 'running', quiescent: false } },
          });
          expect(state?.queued?.acknowledgedSequence).toBe(state?.queued?.safety.sequence);
          expect(state?.queued?.pendingNotification).toBeUndefined();
          expect(notifications.map(notification => notification.safety.execution)).toEqual([
            'not_started',
            'running',
          ]);
        } finally {
          held.release();
          await cloning;
        }
      });
      await abortAllDurableObjects();
      await maintain(request);
      const pending = await readState(request);
      expect(pending).toMatchObject({
        status: 'pending',
        submissionId: 'queued-submission',
        queued: { safety: { execution: 'running', quiescent: false } },
      });
      expect(pending?.queued?.acknowledgedSequence).toBe(pending?.queued?.safety.sequence);
      expect(pending?.queued?.pendingNotification).toBeUndefined();
      expect(notifications).toHaveLength(2);
      if (outcome === 'completed') {
        await runInDurableObject(stub(request), async instance => {
          await execute(instance.getTools(), 'upsert_summary', { body: 'Summary' });
          await instance.onStepEnd({ finishReason: 'stop', toolCalls: [] } as StepContext);
          await invokeTerminal(instance, request, 'completed');
        });
      } else {
        expect((await control(request.admission.identity, 'cancel')).status).toBe(200);
      }
      await maintain(request);
      await maintain(request);
      const terminal = await readState(request);
      expect(terminal).toMatchObject({
        status: outcome === 'completed' ? 'completed' : 'error',
        terminationReason: outcome,
        queued: {
          safety: { execution: outcome, quiescent: true },
          fenceReleased: true,
        },
      });
      expect(terminal?.queued?.acknowledgedSequence).toBe(terminal?.queued?.safety.sequence);
      expect(terminal?.queued?.pendingNotification).toBeUndefined();
      expect(notifications.at(-1)?.safety.execution).toBe(outcome);
      expect(submitMessages).toHaveBeenCalledOnce();
      expect(providerWrites).toHaveLength(outcome === 'completed' ? 1 : 0);
    }
  );

  it.each([
    'generation',
    'organizationId',
    'integrationId',
    'reviewId',
    'executionUserId',
  ] as const)('rejects changed %s after eviction', async field => {
    const request = fixture();
    expect((await start(request)).status).toBe(202);
    await abortAllDurableObjects();
    const identity = { ...request.admission.identity, [field]: crypto.randomUUID() };
    const response = await control(identity, 'cancel');
    expect(response.status).toBe(409);
    expect((await readState(request))?.queued?.cancellationRequested).toBe(false);
  });

  it('rejects changed snapshot or accepted preparation without refreshing credentials', async () => {
    const request = fixture();
    expect((await start(request)).status).toBe(202);
    await abortAllDurableObjects();
    const changed = structuredClone(request);
    changed.review.userPrompt = 'Other accepted prompt';
    changed.admission.preparationHash = queuedPreparationHash(changed.review);
    expect((await start(changed)).status).toBe(409);
    const head = '9'.repeat(40);
    changed.admission.identity.snapshot.headSha = head;
    changed.review.headSha = head;
    if (!changed.review.preparation) throw new Error('Expected preparation');
    changed.review.preparation.snapshot.headSha = head;
    changed.admission.preparationHash = queuedPreparationHash(changed.review);
    expect((await start(changed)).status).toBe(409);
    expect((await readState(request))?.input.userPrompt).toBe(request.review.userPrompt);
  });

  it.each([
    { tokenSource: 'cloud-agent' },
    { expiresInSeconds: -1 },
    { expiresInSeconds: 3_601 },
    { organizationId: crypto.randomUUID() },
    { pepper: 'stale-pepper' },
  ])('rejects invalid execution authentication: %j', async overrides => {
    const request = fixture();
    const response = await start(request, await executionHeaders(request, overrides));
    expect([401, 403]).toContain(response.status);
    expect(await readState(request)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires backend authentication and rejects control tokens as execution permission', async () => {
    const request = fixture();
    expect(
      (
        await start(request, {
          ...(await executionHeaders(request)),
          'x-internal-api-key': 'wrong-key',
        })
      ).status
    ).toBe(401);
    expect(
      (await start(request, await controlHeaders(request.admission.identity, 'status'))).status
    ).toBe(401);
    expect(await readState(request)).toBeUndefined();
  });

  it('requires affirmative, matching canonical authority and does not start on denial', async () => {
    const request = fixture();
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const body = QueuedIsolateAuthorityRequestSchema.parse(JSON.parse(requestBody(init)));
      return Response.json({ ...body, authorized: false });
    });
    expect((await start(request)).status).toBe(202);
    await runClone(request);
    expect(cloneRepository).not.toHaveBeenCalled();
    expect(await readState(request)).toMatchObject({
      status: 'error',
      queued: { admitted: false, safety: { execution: 'failed', quiescent: true } },
    });
  });

  it.each(['generation', 'preparationHash', 'operationId'] as const)(
    'refuses a stale authority %s',
    async field => {
      const request = fixture();
      vi.mocked(fetch).mockImplementation(async (_url, init) => {
        const body = QueuedIsolateAuthorityRequestSchema.parse(JSON.parse(requestBody(init)));
        return Response.json({
          ...body,
          authorized: true,
          ...(field === 'generation'
            ? { identity: { ...body.identity, generation: crypto.randomUUID() } }
            : { [field]: field === 'preparationHash' ? '0'.repeat(64) : crypto.randomUUID() }),
        });
      });
      expect((await start(request)).status).toBe(202);
      expect((await readState(request))?.queued?.admitted).toBe(false);
      await runClone(request);
      expect(cloneRepository).not.toHaveBeenCalled();
    }
  );

  it('retains cancellation before start across cleanup and eviction', async () => {
    const request = fixture();
    const response = await control(request.admission.identity, 'cancel');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      safety: { execution: 'cancelled', cancellationRequested: true, quiescent: true },
    });
    await cleanup(request);
    await abortAllDurableObjects();
    expect((await start(request)).status).toBe(202);
    await runClone(request);
    expect(cloneRepository).not.toHaveBeenCalled();
    expect(await readState(request)).toMatchObject({
      input: { kiloToken: '' },
      queued: { cleaned: true, admitted: false, safety: { execution: 'cancelled' } },
    });
  });

  it('does not apply an execute grant returned after cancellation committed', async () => {
    const request = fixture();
    const entered = gate();
    const held = gate();
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      entered.release();
      await held.promise;
      return fixtureFetch(url, init);
    });
    await runInDurableObject(stub(request), async instance => {
      const starting = instance.startQueuedReview(request, {
        userId: request.admission.identity.executionUserId,
        kiloToken: 'execution-fixture',
        credentialsExpireAt: Date.now() + 3_600_000,
      });
      await entered.promise;
      await instance.controlQueuedReview({
        version: 1,
        identity: request.admission.identity,
        operation: 'cancel',
      });
      held.release();
      await starting;
    });
    await runClone(request);
    expect(cloneRepository).not.toHaveBeenCalled();
    expect((await readState(request))?.queued?.safety.quiescent).toBe(true);
  });

  it('fences clone completion and late submission status after cancellation', async () => {
    const request = fixture();
    expect((await start(request)).status).toBe(202);
    const entered = gate();
    const held = gate();
    vi.mocked(cloneRepository).mockImplementation(async () => {
      entered.release();
      await held.promise;
      return { tipFileCount: 1, tipTotalBytes: 5, vfsTotalBytes: 5, vfsFileCount: 1, cloneMs: 1 };
    });
    await runInDurableObject(stub(request), async instance => {
      const cloning = instance.runClone({ runId: request.admission.runId });
      await entered.promise;
      await instance.controlQueuedReview({
        version: 1,
        identity: request.admission.identity,
        operation: 'cancel',
      });
      held.release();
      await cloning;
      await invokeTerminal(instance, request, 'completed');
    });
    expect(submitMessages).not.toHaveBeenCalled();
    expect(await readState(request)).toMatchObject({
      status: 'error',
      terminationReason: 'cancelled',
      queued: { safety: { quiescent: true } },
    });
  });

  it('accepts separately scoped status/cancel after bearer expiry and rejects forged operation scope', async () => {
    const request = fixture();
    expect((await start(request)).status).toBe(202);
    const headers = await executionHeaders(request, { expiresInSeconds: -1 });
    expect((await start(request, headers)).status).toBe(401);
    const statusHeaders = await controlHeaders(request.admission.identity, 'status');
    expect((await control(request.admission.identity, 'cancel', statusHeaders)).status).toBe(401);
    expect((await control(request.admission.identity, 'status')).status).toBe(200);
    expect((await control(request.admission.identity, 'cancel')).status).toBe(200);
    expect((await readState(request))?.input.kiloToken).toBe('');
  });

  it('rechecks active state after held publication authority without sending', async () => {
    const request = fixture();
    await start(request);
    await runClone(request);
    const entered = gate();
    const held = gate();
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (requestUrl(url).startsWith('https://app.kilo.ai')) {
        entered.release();
        await held.promise;
      }
      return fixtureFetch(url, init);
    });
    await runInDurableObject(stub(request), async instance => {
      const publishing = expect(
        execute(instance.getTools(), 'upsert_summary', { body: 'Summary' })
      ).rejects.toThrow();
      await entered.promise;
      await instance.controlQueuedReview({
        version: 1,
        identity: request.admission.identity,
        operation: 'cancel',
      });
      held.release();
      await publishing;
    });
    expect(providerWrites).toHaveLength(0);
    expect((await readState(request))?.queued?.safety).toMatchObject({
      publication: 'not_started',
      quiescent: true,
    });
  });

  it.each(['cancelled', 'byok_invalid_key'] as const)(
    'retains the publication fence after %s while its response is held',
    async reason => {
      const request = fixture();
      await start(request);
      await runClone(request);
      const entered = gate();
      const held = gate();
      await runInDurableObject(stub(request), async (instance, durableState) => {
        const persistence = createReviewPersistence(durableState.storage).persistence;
        vi.mocked(fetch).mockImplementation(async (url, init) => {
          if (
            new URL(requestUrl(url)).origin === 'https://api.github.com' &&
            init?.method === 'POST'
          ) {
            expect((await persistence.get<RunState>('runState'))?.queued?.operations).toEqual([
              expect.objectContaining({ state: 'sent', requestBody: expect.any(String) }),
            ]);
            entered.release();
            await held.promise;
          }
          return fixtureFetch(url, init);
        });
        const publishing = execute(instance.getTools(), 'upsert_summary', { body: 'Summary' });
        await entered.promise;
        if (reason === 'cancelled')
          await instance.controlQueuedReview({
            version: 1,
            identity: request.admission.identity,
            operation: 'cancel',
          });
        else
          await invokeTerminal(
            instance,
            request,
            'error',
            '[BYOK] Your API key is invalid or has been revoked. Please check your API key configuration.'
          );
        const terminal = await instance.controlQueuedReview({
          version: 1,
          identity: request.admission.identity,
          operation: 'status',
        });
        expect(terminal).toMatchObject({
          safety: {
            execution: reason === 'cancelled' ? 'cancelled' : 'failed',
            publication: 'uncertain',
            quiescent: false,
          },
        });
        await instance.cleanupReview({ runId: request.admission.runId });
        expect(
          (await persistence.get<RunState>('runState'))?.queued?.operations[0]?.requestBody
        ).toContain('Summary');
        held.release();
        await publishing;
      });
      const settled = await readState(request);
      expect(settled).toMatchObject({
        status: 'error',
        terminationReason: reason,
        input: { kiloToken: '' },
        queued: {
          cleaned: true,
          result: { reason },
          safety: {
            execution: reason === 'cancelled' ? 'cancelled' : 'failed',
            publication: 'settled',
            quiescent: true,
          },
        },
      });
      expect(settled?.queued?.operations[0]?.requestBody).toBeUndefined();
      expect(providerWrites).toHaveLength(1);
    }
  );

  it('confirms a streamed summary response above 16 KiB without stalling or repeating the write', async () => {
    const request = fixture();
    expect((await start(request)).status).toBe(202);
    await runClone(request);
    const body = 'Valid summary content.\n'.repeat(2_500);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(16_384);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(65_536);
    await runInDurableObject(stub(request), async (instance, durableState) => {
      let providerResponse: Response | undefined;
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (
          new URL(requestUrl(url)).origin === 'https://api.github.com' &&
          init?.method === 'POST'
        ) {
          const sent = requestBody(init);
          providerWrites.push({ path: new URL(requestUrl(url)).pathname, body: sent });
          providerResponse = streamedJsonResponse({ id: 22, ...JSON.parse(sent) });
          return providerResponse;
        }
        return fixtureFetch(url, init);
      });
      const tools = instance.getTools();
      const publishing = execute(tools, 'upsert_summary', { body });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          publishing,
          new Promise<'stalled'>(resolve => {
            timeout = setTimeout(() => resolve('stalled'), 1_000);
          }),
        ]);
        if (result === 'stalled') {
          await providerResponse?.arrayBuffer();
          await publishing.catch(() => {});
        }
        expect(result).toEqual({ id: 22 });
      } finally {
        clearTimeout(timeout);
      }
      const published = await createReviewPersistence(
        durableState.storage
      ).persistence.get<RunState>('runState');
      expect(published?.publicationOutcome?.summary).toBe('confirmed');
      expect(published?.queued?.operations).toEqual([
        expect.objectContaining({ kind: 'summary', state: 'confirmed', responseId: 22 }),
      ]);
      await expect(execute(tools, 'upsert_summary', { body })).resolves.toEqual({ id: 22 });
      await instance.onStepEnd({ finishReason: 'stop', toolCalls: [] } as StepContext);
      await invokeTerminal(instance, request, 'completed');
    });
    await abortAllDurableObjects();
    expect(await readState(request)).toMatchObject({
      status: 'completed',
      queued: { safety: { execution: 'completed', publication: 'settled', quiescent: true } },
    });
    expect((await start(request)).status).toBe(202);
    await runClone(request);
    expect(providerWrites).toHaveLength(1);
  });

  it('rejects oversized callback responses without waiting for stream cancellation', async () => {
    const held = gate();
    const cancel = vi.fn(() => held.promise);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify({ body: 'x'.repeat(32_768) }))
          );
        },
        cancel,
      })
    );
    const reading = readQueuedJson(response).then(
      () => 'accepted',
      (error: unknown) => (error instanceof Error ? error.message : 'unexpected error')
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        reading,
        new Promise<'stalled'>(resolve => {
          timeout = setTimeout(() => resolve('stalled'), 1_000);
        }),
      ]);
      expect(cancel).toHaveBeenCalledOnce();
      expect(result).toContain('response exceeds limit');
    } finally {
      held.release();
      await reading;
      clearTimeout(timeout);
    }
  });

  it('keeps uncertainty after response loss, eviction, absent reads, and exhausted reconciliation', async () => {
    const request = fixture();
    await start(request);
    await runClone(request);
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (new URL(requestUrl(url)).origin === 'https://api.github.com' && init?.method === 'POST')
        throw new Error('lost response');
      return fixtureFetch(url, init);
    });
    await runInDurableObject(stub(request), async instance => {
      await expect(
        execute(instance.getTools(), 'upsert_summary', { body: 'Summary' })
      ).rejects.toThrow('lost response');
    });
    await control(request.admission.identity, 'cancel');
    await cleanup(request);
    await abortAllDurableObjects();
    await maintain(request);
    await maintain(request);
    await maintain(request);
    const state = await readState(request);
    expect(state).toMatchObject({
      summaryReconciliationAttempts: 2,
      input: { kiloToken: '' },
      queued: { safety: { execution: 'cancelled', publication: 'uncertain', quiescent: false } },
    });
    expect(state?.queued?.operations[0]?.requestBody).toContain('Summary');
    expect(submitMessages).toHaveBeenCalledOnce();
    const schedules = await runInDurableObject(stub(request), instance => instance.listSchedules());
    expect(schedules.some(schedule => schedule.callback === 'maintainQueuedReview')).toBe(true);
  });

  it('reconciles only the exact persisted summary read-only after credential scrubbing', async () => {
    const request = fixture();
    await start(request);
    await runClone(request);
    let sentBody = '';
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (new URL(requestUrl(url)).origin === 'https://api.github.com' && init?.method === 'POST') {
        sentBody = requestBody(init);
        throw new Error('lost response');
      }
      return fixtureFetch(url, init);
    });
    await runInDurableObject(stub(request), async instance => {
      await expect(
        execute(instance.getTools(), 'upsert_summary', { body: 'Summary' })
      ).rejects.toThrow();
    });
    await control(request.admission.identity, 'cancel');
    await cleanup(request);
    await abortAllDurableObjects();
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (requestUrl(url).includes('/issues/42/comments'))
        return Response.json([
          {
            id: 22,
            body: (JSON.parse(sentBody) as { body: string }).body,
            user: { login: 'kilo-code[bot]' },
            issue_url: 'https://api.github.com/repos/acme/widget/issues/42',
          },
        ]);
      return fixtureFetch(url, init);
    });
    await maintain(request);
    expect(await readState(request)).toMatchObject({
      queued: { safety: { execution: 'cancelled', publication: 'settled', quiescent: true } },
    });
    expect(providerWrites).toHaveLength(0);
    expect(resolveGithubCredentials).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowDirectToken: false,
        input: expect.objectContaining({
          kiloToken: '',
          userId: `bot-code-review-${request.admission.identity.organizationId}`,
          expectedIntegrationId: request.admission.identity.integrationId,
        }),
      })
    );
  });

  it('does not mistake a matching historical review for an ambiguous new write', async () => {
    const request = fixture();
    await start(request);
    await runClone(request);
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (requestUrl(url).endsWith('/reviews') && init?.method === 'POST')
        throw new Error('lost review response');
      return fixtureFetch(url, init);
    });
    await runInDurableObject(stub(request), async instance => {
      await expect(
        execute(instance.getTools(), 'submit_review', {
          comments: [{ path: 'source.ts', line: 1, side: 'RIGHT', body: 'Finding' }],
        })
      ).rejects.toThrow();
    });
    await control(request.admission.identity, 'cancel');
    await cleanup(request);
    await abortAllDurableObjects();
    await maintain(request);
    expect((await readState(request))?.queued?.safety).toMatchObject({
      publication: 'uncertain',
      quiescent: false,
    });
    expect((await readState(request))?.queued?.operations[0]?.responseId).toBeUndefined();
  });

  it.each([false, true])(
    'retries terminal bookkeeping across cleanup until usage settles (fenceReleased=%s)',
    async fenceReleased => {
      const request = fixture();
      await control(request.admission.identity, 'cancel');
      vi.mocked(fetch).mockImplementation(async (_url, init) => {
        const notification = QueuedIsolateNotificationSchema.parse(JSON.parse(requestBody(init)));
        notifications.push(notification);
        return Response.json({
          version: 1,
          identity: notification.identity,
          sequence: notification.safety.sequence,
          notificationRecorded: true,
          fenceReleased,
          usageSettled: false,
        });
      });
      await maintain(request);
      const pending = (await readState(request))?.queued?.pendingNotification;
      expect(pending?.result).toMatchObject({
        reason: 'cancelled',
        sessions: [{ sessionId: request.admission.identity.attemptId, parentSessionId: null }],
      });
      await cleanup(request);
      await abortAllDurableObjects();
      await maintain(request);
      expect((await readState(request))?.queued?.pendingNotification).toEqual(pending);
      expect(notifications).toEqual([pending, pending]);
      expect(await runInDurableObject(stub(request), instance => instance.listSchedules())).toEqual(
        expect.arrayContaining([expect.objectContaining({ callback: 'maintainQueuedReview' })])
      );
      vi.mocked(fetch).mockImplementation(fixtureFetch);
      await maintain(request);
      expect((await readState(request))?.queued).toMatchObject({
        fenceReleased: true,
        acknowledgedSequence: pending?.safety.sequence,
      });
      expect((await readState(request))?.queued?.pendingNotification).toBeUndefined();
    }
  );

  it.each(['delayed_billing', 'billing_deadline'] as const)(
    'retries terminal usage while publication remains uncertain through %s',
    async recovery => {
      const request = fixture();
      await start(request);
      await runClone(request);
      let writes = 0;
      let usageSettled = false;
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (requestUrl(url).endsWith('/chat/completions')) {
          return Response.json({
            id: crypto.randomUUID(),
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Reviewed' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        }
        if (
          new URL(requestUrl(url)).origin === 'https://api.github.com' &&
          init?.method === 'POST'
        ) {
          writes++;
          throw new Error('Lost summary response');
        }
        if (requestUrl(url).startsWith('https://app.kilo.ai')) {
          const notification = QueuedIsolateNotificationSchema.safeParse(
            JSON.parse(requestBody(init))
          );
          if (notification.success) {
            notifications.push(notification.data);
            const result = notification.data.result;
            const deadline = result
              ? new Date(result.completedAt).getTime() + 24 * 60 * 60 * 1000
              : Infinity;
            return Response.json({
              version: 1,
              identity: notification.data.identity,
              sequence: notification.data.safety.sequence,
              notificationRecorded: true,
              fenceReleased: false,
              usageSettled: usageSettled || Date.now() >= deadline,
            });
          }
        }
        return fixtureFetch(url, init);
      });
      await runInDurableObject(stub(request), async instance => {
        await generateText({ model: instance.getModel(), prompt: 'Root request', maxRetries: 0 });
        await execute(instance.getTools(), 'task', {
          description: 'Inspect source',
          prompt: 'Inspect source.',
          subagent_type: 'explore',
          task_id: 'billing-child',
        });
        await expect(
          execute(instance.getTools(), 'upsert_summary', { body: 'Summary' })
        ).rejects.toThrow();
      });
      await control(request.admission.identity, 'cancel');
      await maintain(request);
      const terminal = (await readState(request))?.queued?.pendingNotification;
      expect(terminal?.safety).toMatchObject({
        execution: 'cancelled',
        publication: 'uncertain',
        quiescent: false,
      });
      expect(terminal?.result?.sessions.map(session => session.requestCount)).toEqual([1, 1]);
      await maintain(request);
      expect((await readState(request))?.queued?.pendingNotification).toEqual(terminal);
      await cleanup(request);
      await abortAllDurableObjects();
      await maintain(request);
      expect(notifications.slice(-2)).toEqual([terminal, terminal]);
      if (!terminal?.result) throw new Error('Missing terminal result');
      if (recovery === 'delayed_billing') usageSettled = true;
      else
        vi.spyOn(Date, 'now').mockReturnValue(
          new Date(terminal.result.completedAt).getTime() + 24 * 60 * 60 * 1000
        );
      await maintain(request);
      const settled = await readState(request);
      expect(settled?.queued?.pendingNotification).toBeUndefined();
      expect(settled?.queued).toMatchObject({
        acknowledgedSequence: terminal.safety.sequence,
        safety: terminal.safety,
        fenceReleased: false,
        cleaned: true,
      });
      const sent = notifications.length;
      await maintain(request);
      expect(notifications).toHaveLength(sent);
      expect(await runInDurableObject(stub(request), instance => instance.listSchedules())).toEqual(
        expect.arrayContaining([expect.objectContaining({ callback: 'maintainQueuedReview' })])
      );
      expect(writes).toBe(1);
    }
  );

  it('rejects malformed or oversized provider error evidence and ignores unrelated payload fields', async () => {
    const safeMessage =
      '[BYOK] Your API key is invalid or has been revoked. Please check your API key configuration.';
    for (const body of [
      safeMessage,
      JSON.stringify({ metadata: { message: safeMessage } }),
      JSON.stringify({ error: `${safeMessage}${'x'.repeat(16_384)}` }),
      JSON.stringify({ error: { privateDetail: safeMessage } }),
    ]) {
      expect(await readQueuedProviderFailure(new Response(body, { status: 401 }))).toBeNull();
    }
    expect(
      await readQueuedProviderFailure(
        Response.json({ error_type: 'provider_not_allowed' }, { status: 403 })
      )
    ).toBe('selected_model_unavailable');
  });

  it.each(['anthropic', 'openai', 'openrouter', 'openai-compatible'] as const)(
    'propagates safe BYOK failures before %s SDK parsing and scrubs provider payloads',
    async provider => {
      const request = fixture();
      request.review.inference = { ...inference, provider };
      request.admission.preparationHash = queuedPreparationHash(request.review);
      expect((await start(request)).status).toBe(202);
      await runClone(request);
      const privateDetail = 'private-provider-credential';
      const safeMessage =
        '[BYOK] Your API key is invalid or has been revoked. Please check your API key configuration.';
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (new URL(requestUrl(url)).origin !== 'https://api.kilo.ai')
          return fixtureFetch(url, init);
        return Response.json(
          { error: safeMessage, error_type: 'byok_error', message: safeMessage, privateDetail },
          { status: 401 }
        );
      });
      await runInDurableObject(stub(request), async instance => {
        await expect(
          generateText({ model: instance.getModel(), prompt: 'Review', maxRetries: 0 })
        ).rejects.toMatchObject({
          message: 'Isolate review: byok_invalid_key',
          statusCode: 401,
          isRetryable: false,
          responseBody: undefined,
          requestBodyValues: undefined,
        });
        await invokeTerminal(instance, request, 'error', privateDetail);
      });
      const terminal = await readState(request);
      expect(terminal).toMatchObject({
        status: 'error',
        terminationReason: 'byok_invalid_key',
        error: 'Isolate review: byok_invalid_key',
        input: { kiloToken: '' },
        queued: {
          safety: { execution: 'failed', quiescent: true },
          result: {
            reason: 'byok_invalid_key',
            sessions: [{ sessionId: request.admission.runId, requestCount: 1 }],
          },
        },
      });
      expect(JSON.stringify(terminal)).not.toContain(privateDetail);
      expect(terminal?.githubToken).toBeUndefined();
      await maintain(request);
      await maintain(request);
      expect(notifications.at(-1)?.result?.reason).toBe('byok_invalid_key');
      expect(JSON.stringify(notifications)).not.toContain(privateDetail);
      await cleanup(request);
      await abortAllDurableObjects();
      expect((await readState(request))?.queued?.result).toEqual(terminal?.queued?.result);
      expect(providerWrites).toHaveLength(0);
    }
  );

  it.each([
    {
      reason: 'byok_invalid_key',
      status: 403,
      error: {
        message:
          '[BYOK] Your API key does not have permission to access this resource. Please check your API key permissions.',
      },
    },
    {
      reason: 'selected_model_unavailable',
      status: 404,
      error: {
        message: 'No eligible provider can serve the selected model.',
      },
    },
  ])(
    'terminates required child inference on $reason without permitting later publication',
    async failure => {
      const request = fixture();
      expect((await start(request)).status).toBe(202);
      await runClone(request);
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (new URL(requestUrl(url)).origin !== 'https://api.kilo.ai')
          return fixtureFetch(url, init);
        return Response.json({ error: failure.error }, { status: failure.status });
      });
      await runInDurableObject(stub(request), async instance => {
        const tools = instance.getTools();
        await expect(
          execute(tools, 'task', {
            description: 'Inspect source',
            prompt: 'Inspect source.',
            subagent_type: 'explore',
            task_id: 'failed-child',
          })
        ).rejects.toThrow('terminal');
        await expect(
          execute(tools, 'upsert_summary', { body: 'Must not publish' })
        ).rejects.toThrow();
      });
      const terminal = await readState(request);
      expect(terminal?.terminationReason).toBe(failure.reason);
      expect(terminal?.queued?.result?.reason).toBe(failure.reason);
      expect(terminal?.queued?.result?.sessions).toEqual([
        { sessionId: request.admission.runId, parentSessionId: null, requestCount: 0 },
        {
          sessionId: terminal?.taskSessions?.[0]?.sessionId,
          parentSessionId: request.admission.runId,
          requestCount: 1,
        },
      ]);
      expect(providerWrites).toHaveLength(0);
    }
  );

  it.each([
    { status: 401, message: 'Unauthorized private-provider-credential' },
    { status: 402, message: '[BYOK] Your API account has insufficient funds.' },
    { status: 429, message: '[BYOK] Your API key has hit its rate limit.' },
    { status: 503, message: 'Provider unavailable private-provider-credential' },
  ])(
    'keeps non-actionable HTTP $status failures generic without retaining raw provider details',
    async failure => {
      const request = fixture();
      expect((await start(request)).status).toBe(202);
      await runClone(request);
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (new URL(requestUrl(url)).origin !== 'https://api.kilo.ai')
          return fixtureFetch(url, init);
        return Response.json(
          { error: failure.message, error_type: 'byok_error' },
          { status: failure.status }
        );
      });
      await runInDurableObject(stub(request), async instance => {
        await expect(
          generateText({ model: instance.getModel(), prompt: 'Review', maxRetries: 0 })
        ).rejects.toMatchObject({
          message: `Isolate inference request failed (${failure.status})`,
          statusCode: failure.status,
          responseBody: undefined,
        });
        await invokeTerminal(instance, request, 'error', failure.message);
      });
      const terminal = await readState(request);
      expect(terminal).toMatchObject({
        terminationReason: 'submission_error',
        error: 'Isolate review: submission_error',
        queued: { result: { reason: 'submission_error' } },
      });
      expect(JSON.stringify(terminal)).not.toContain(failure.message);
    }
  );

  it('classifies submission-only errors without persisting their raw payload or changing cancellation', async () => {
    const request = fixture();
    expect((await start(request)).status).toBe(202);
    await runClone(request);
    const error =
      'Forbidden: [BYOK] Your API key does not have permission to access this resource. Please check your API key permissions. private-provider-credential';
    await runInDurableObject(stub(request), instance =>
      invokeTerminal(instance, request, 'error', error)
    );
    const failed = await readState(request);
    expect(failed?.queued?.result?.reason).toBe('byok_invalid_key');
    expect(failed?.error).toBe('Isolate review: byok_invalid_key');
    expect(JSON.stringify(failed)).not.toContain('private-provider-credential');
    await control(request.admission.identity, 'cancel');
    expect((await readState(request))?.queued?.result).toEqual(failed?.queued?.result);

    const cancelled = fixture();
    expect((await start(cancelled)).status).toBe(202);
    await runClone(cancelled);
    await control(cancelled.admission.identity, 'cancel');
    await runInDurableObject(stub(cancelled), instance =>
      invokeTerminal(instance, cancelled, 'error', error)
    );
    expect((await readState(cancelled))?.queued?.result?.reason).toBe('cancelled');
    expect(providerWrites).toHaveLength(0);
  });

  it('persists per-session inference request counts before sending and retains them through terminal cleanup', async () => {
    const request = fixture();
    await start(request);
    await runClone(request);
    const observed: string[] = [];
    await runInDurableObject(stub(request), async (instance, durableState) => {
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (!requestUrl(url).endsWith('/chat/completions')) return fixtureFetch(url, init);
        const headers = new Headers(init?.headers);
        const sessionId = headers.get('x-kilo-session');
        if (!sessionId) throw new Error('Missing inference session');
        observed.push(sessionId);
        const persisted = await createReviewPersistence(
          durableState.storage
        ).persistence.get<RunState>('runState');
        expect(persisted?.usageRequestCounts?.[sessionId]).toBeGreaterThanOrEqual(1);
        expect(persisted?.requestIds).toContain(headers.get('x-kilo-request'));
        return Response.json({
          id: crypto.randomUUID(),
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Reviewed' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      });
      await Promise.all([
        generateText({ model: instance.getModel(), prompt: 'First root request', maxRetries: 0 }),
        generateText({ model: instance.getModel(), prompt: 'Second root request', maxRetries: 0 }),
        execute(instance.getTools(), 'task', {
          description: 'Inspect source',
          prompt: 'Inspect source.',
          subagent_type: 'explore',
          task_id: 'usage-child',
        }),
      ]);
    });
    const before = await readState(request);
    const child = before?.taskSessions?.[0];
    if (!child) throw new Error('Missing child session');
    expect(observed.filter(id => id === request.admission.runId)).toHaveLength(2);
    expect(observed.filter(id => id === child.sessionId)).toHaveLength(1);
    await abortAllDurableObjects();
    await control(request.admission.identity, 'cancel');
    const result = (await readState(request))?.queued?.result;
    expect(result?.sessions).toEqual([
      { sessionId: request.admission.runId, parentSessionId: null, requestCount: 2 },
      { sessionId: child.sessionId, parentSessionId: request.admission.runId, requestCount: 1 },
    ]);
    await cleanup(request);
    await abortAllDurableObjects();
    const retained = await readState(request);
    expect(retained?.queued?.result).toEqual(result);
    expect(retained?.usageRequestCounts).toBeUndefined();
    expect(retained?.input.kiloToken).toBe('');
  });

  it.each(['deadline', 'abort'] as const)(
    'excludes proven unsent inference after persisted intent and %s from terminal billing counts',
    async interruption => {
      const request = fixture();
      await start(request);
      await runClone(request);
      const sent: string[] = [];
      const now = Date.now();
      await runInDurableObject(stub(request), async instance => {
        const controller = new AbortController();
        vi.mocked(fetch).mockImplementation(async (url, init) => {
          if (!requestUrl(url).endsWith('/chat/completions')) return fixtureFetch(url, init);
          sent.push(new Headers(init?.headers).get('x-kilo-session') ?? '');
          return Response.json({
            id: crypto.randomUUID(),
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Reviewed' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        });
        await generateText({ model: instance.getModel(), prompt: 'Billed root', maxRetries: 0 });
        await execute(instance.getTools(), 'task', {
          description: 'Inspect source',
          prompt: 'Inspect source.',
          subagent_type: 'explore',
          task_id: 'billed-child',
        });
        expect(sent).toHaveLength(2);
        let interrupted = false;
        afterPersistence.mockImplementation(state => {
          if (interrupted || state.requestIds?.length !== 3) return;
          interrupted = true;
          expect(state.usageRequestCounts?.[request.admission.runId]).toBe(2);
          expect(sent).toHaveLength(2);
          if (interruption === 'abort') controller.abort();
          else vi.spyOn(Date, 'now').mockReturnValue((state.executionDeadlineAt ?? now) + 1);
        });
        await expect(
          generateText({
            model: instance.getModel(),
            prompt: 'Must not be billed',
            maxRetries: 0,
            abortSignal: controller.signal,
          })
        ).rejects.toThrow(/abort|terminal|deadline/i);
        expect(interrupted).toBe(true);
      });
      expect(sent).toHaveLength(2);
      await control(request.admission.identity, 'cancel');
      const terminal = await readState(request);
      const child = terminal?.taskSessions?.[0];
      expect(child).toBeDefined();
      expect(terminal?.queued?.result?.sessions).toEqual([
        { sessionId: request.admission.runId, parentSessionId: null, requestCount: 1 },
        { sessionId: child?.sessionId, parentSessionId: request.admission.runId, requestCount: 1 },
      ]);
      const result = terminal?.queued?.result;
      await cleanup(request);
      await abortAllDurableObjects();
      await maintain(request);
      await maintain(request);
      expect((await readState(request))?.queued?.result).toEqual(result);
      expect((await readState(request))?.queued?.pendingNotification).toBeUndefined();
      expect(
        await runInDurableObject(stub(request), instance => instance.listSchedules())
      ).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ callback: 'maintainQueuedReview' })])
      );
      vi.spyOn(Date, 'now').mockReturnValue(now);
    }
  );

  it.each(['lost_response', 'crash_after_intent'] as const)(
    'retains uncertain inference counts across eviction after %s',
    async interruption => {
      const request = fixture();
      await start(request);
      await runClone(request);
      let requests = 0;
      await runInDurableObject(stub(request), async instance => {
        vi.mocked(fetch).mockImplementation(async (url, init) => {
          if (!requestUrl(url).endsWith('/chat/completions')) return fixtureFetch(url, init);
          requests++;
          if (requests > 1) throw new Error('Lost inference response');
          return Response.json({
            id: crypto.randomUUID(),
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Reviewed' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        });
        await generateText({ model: instance.getModel(), prompt: 'Billed request', maxRetries: 0 });
        if (interruption === 'crash_after_intent') {
          afterPersistence.mockImplementation(state => {
            if (state.requestIds?.length === 2) throw new Error('Crash after durable intent');
          });
        }
        await expect(
          generateText({ model: instance.getModel(), prompt: 'Uncertain request', maxRetries: 0 })
        ).rejects.toThrow();
      });
      afterPersistence.mockReset();
      expect(requests).toBe(interruption === 'lost_response' ? 2 : 1);
      await abortAllDurableObjects();
      await control(request.admission.identity, 'cancel');
      const result = (await readState(request))?.queued?.result;
      expect(result?.sessions).toEqual([
        { sessionId: request.admission.runId, parentSessionId: null, requestCount: 2 },
      ]);
      await cleanup(request);
      await abortAllDurableObjects();
      expect((await readState(request))?.queued?.result).toEqual(result);
    }
  );

  it('retains sequenced notifications through response loss, terminal cleanup and stale acknowledgements', async () => {
    const request = fixture();
    await start(request);
    await runClone(request);
    const recorded = await readState(request);
    const first = recorded?.queued?.pendingNotification;
    if (!first) throw new Error('Expected durable notification');
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const notification = QueuedIsolateNotificationSchema.parse(JSON.parse(requestBody(init)));
      notifications.push(notification);
      throw new Error('lost acknowledgement');
    });
    await control(request.admission.identity, 'cancel');
    await cleanup(request);
    await maintain(request);
    await abortAllDurableObjects();
    expect((await readState(request))?.queued?.pendingNotification).toEqual(first);
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const notification = QueuedIsolateNotificationSchema.parse(JSON.parse(requestBody(init)));
      return Response.json({
        version: 1,
        identity: { ...notification.identity, generation: crypto.randomUUID() },
        sequence: notification.safety.sequence,
        notificationRecorded: true,
        fenceReleased: true,
      });
    });
    await maintain(request);
    expect((await readState(request))?.queued?.acknowledgedSequence).toBe(0);
    vi.mocked(fetch).mockImplementation(fixtureFetch);
    await maintain(request);
    const afterFirst = await readState(request);
    expect(afterFirst?.queued?.acknowledgedSequence).toBe(first.safety.sequence);
    expect(afterFirst?.queued?.pendingNotification?.safety.execution).toBe('cancelled');
    await maintain(request);
    expect((await readState(request))?.queued?.pendingNotification).toBeUndefined();
    const schedules = await runInDurableObject(stub(request), instance => instance.listSchedules());
    expect(schedules.some(schedule => schedule.callback === 'maintainQueuedReview')).toBe(false);
  });

  it.each([
    { dryRun: true },
    { gitToken: 'untrusted-direct-token' },
    { reviewMode: 'incremental' },
    { expectedAppType: 'lite' },
    { inference: undefined },
    { inference: { ...inference, modelId: 'mismatched-model' } },
    { preparation: undefined },
    { owner: 'another-owner' },
    { pullNumber: 43 },
  ])('rejects unsupported or mismatched queued preparation: %j', async overrides => {
    const request = fixture();
    const response = await SELF.fetch('https://worker.test/queued-reviews', {
      method: 'POST',
      headers: await executionHeaders(request),
      body: JSON.stringify({ ...request, review: { ...request.review, ...overrides } }),
    });
    await response.arrayBuffer();
    expect(response.status).toBe(400);
    expect(await readState(request)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps direct/manual Worker routes production-excluded', async () => {
    for (const path of ['/reviews', '/reviews/example', '/reviews/example/messages']) {
      const response = await app.request(
        `https://worker.test${path}`,
        {
          method: path === '/reviews' ? 'POST' : 'GET',
        },
        { ...env, ENVIRONMENT: 'production' }
      );
      expect(response.status).toBe(403);
      await response.arrayBuffer();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('recovers ambiguous admission with the pinned request without replacing execution credentials', async () => {
    const request = fixture();
    vi.mocked(fetch).mockRejectedValueOnce(new Error('authority unavailable'));
    const response = await start(request);
    expect(response.status).toBe(500);
    const before = await readState(request);
    expect(before?.queued?.admitted).toBe(false);
    await runClone(request);
    expect(cloneRepository).not.toHaveBeenCalled();
    await abortAllDurableObjects();
    expect((await start(request)).status).toBe(202);
    expect((await readState(request))?.input.kiloToken).toBe(before?.input.kiloToken);
    expect((await readState(request))?.credentialsExpireAt).toBe(before?.credentialsExpireAt);
    await runClone(request);
    expect(submitMessages).toHaveBeenCalledOnce();
  });

  it('reports successful execution only after both authorized provider operations settle', async () => {
    const request = fixture();
    await start(request);
    await runClone(request);
    await runInDurableObject(stub(request), async instance => {
      const tools = instance.getTools();
      await execute(tools, 'submit_review', {
        comments: [{ path: 'source.ts', line: 1, side: 'RIGHT', body: 'Finding' }],
      });
      await execute(tools, 'upsert_summary', { body: 'Summary' });
      await instance.onStepEnd({ finishReason: 'stop', toolCalls: [] } as StepContext);
      await invokeTerminal(instance, request, 'completed');
      await invokeTerminal(instance, request, 'error');
    });
    const state = await readState(request);
    expect(state).toMatchObject({
      status: 'completed',
      queued: {
        safety: { execution: 'completed', publication: 'settled', quiescent: true },
        result: {
          reason: 'completed',
          completedAt: state?.completedAt,
          sessions: [{ sessionId: request.admission.runId, parentSessionId: null }],
          summary: { commentId: state?.summaryCommentId, bodyHash: state?.summaryBodyHash },
        },
      },
    });
    expect(state?.queued?.operations.map(operation => operation.state)).toEqual([
      'confirmed',
      'confirmed',
    ]);
    expect(providerWrites).toHaveLength(2);
    await abortAllDurableObjects();
    expect((await start(request)).status).toBe(202);
    await runClone(request);
    expect(providerWrites).toHaveLength(2);
  });

  it('does not release sent publication evidence when its execution deadline expires', async () => {
    const request = fixture();
    await start(request);
    await runClone(request);
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (new URL(requestUrl(url)).origin === 'https://api.github.com' && init?.method === 'POST') {
        throw new DOMException('Timed out', 'TimeoutError');
      }
      return fixtureFetch(url, init);
    });
    await runInDurableObject(stub(request), async instance => {
      await expect(
        execute(instance.getTools(), 'upsert_summary', { body: 'Summary' })
      ).rejects.toThrow('Timed out');
      await instance.expireCredentials({ runId: request.admission.runId });
    });
    await cleanup(request);
    await abortAllDurableObjects();
    expect(await readState(request)).toMatchObject({
      input: { kiloToken: '' },
      terminationReason: 'credentials_expired',
      queued: { safety: { execution: 'failed', publication: 'uncertain', quiescent: false } },
    });
  });

  it('pins one preparation and its retention schedules when conflicting starts race', async () => {
    const request = fixture();
    const other = structuredClone(request);
    other.review.userPrompt = 'Conflicting prepared prompt';
    other.admission.preparationHash = queuedPreparationHash(other.review);
    await runInDurableObject(stub(request), async instance => {
      const schedule = vi.spyOn(instance, 'schedule');
      const credentials = {
        userId: request.admission.identity.executionUserId,
        kiloToken: 'execution-fixture',
        credentialsExpireAt: Date.now() + 3_600_000,
      };
      const results = await Promise.allSettled([
        instance.startQueuedReview(request, credentials),
        instance.startQueuedReview(other, {
          ...credentials,
          credentialsExpireAt: Date.now() + 60_000,
        }),
      ]);
      expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(
        schedule.mock.calls.filter(([, callback]) => callback === 'expireCredentials')
      ).toHaveLength(1);
      expect(
        schedule.mock.calls.filter(([, callback]) => callback === 'cleanupReview')
      ).toHaveLength(1);
    });
  });

  it('retains a never-sent operation as safely suppressed when cancellation fences the transport', async () => {
    const request = fixture();
    await start(request);
    await runClone(request);
    await runInDurableObject(stub(request), async instance => {
      const controller = new AbortController();
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (requestUrl(url).startsWith('https://app.kilo.ai')) controller.abort();
        return fixtureFetch(url, init);
      });
      const publish = instance.getTools().upsert_summary?.execute;
      if (!publish) throw new Error('Expected summary tool');
      await expect(
        publish({ body: 'Summary' } as never, {
          toolCallId: 'aborted-publication',
          messages: [],
          abortSignal: controller.signal,
          context: {},
        })
      ).rejects.toThrow();
      await instance.controlQueuedReview({
        version: 1,
        identity: request.admission.identity,
        operation: 'cancel',
      });
    });
    expect(providerWrites).toHaveLength(0);
    const state = await readState(request);
    expect(state?.queued?.operations).toEqual([expect.objectContaining({ state: 'not_sent' })]);
    expect(state?.queued?.safety.quiescent).toBe(true);
  });

  it('treats cancellation of an acknowledged terminal execution as an idempotent no-op', async () => {
    const request = fixture();
    await start(request);
    await runInDurableObject(stub(request), instance =>
      instance.expireCredentials({ runId: request.admission.runId })
    );
    await maintain(request);
    await maintain(request);
    const before = await readState(request);
    expect(before?.queued?.pendingNotification).toBeUndefined();
    await control(request.admission.identity, 'cancel');
    expect((await readState(request))?.queued).toEqual(before?.queued);
  });

  it('runs durable notification recovery from the actual alarm', async () => {
    const request = fixture();
    await control(request.admission.identity, 'cancel');
    const schedules = await runInDurableObject(stub(request), instance => instance.listSchedules());
    const maintenance = schedules.find(schedule => schedule.callback === 'maintainQueuedReview');
    if (!maintenance) throw new Error('Expected maintenance schedule');
    await abortAllDurableObjects();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(maintenance.time * 1000 + 1_000);
    try {
      expect(await runDurableObjectAlarm(stub(request))).toBe(true);
    } finally {
      clock.mockRestore();
    }
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications[0]?.safety).toMatchObject({ execution: 'cancelled', quiescent: true });
  });
});
