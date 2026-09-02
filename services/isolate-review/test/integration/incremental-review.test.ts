import {
  abortAllDurableObjects,
  env,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from 'cloudflare:test';
import { createHash, createHmac } from 'node:crypto';
import { verifyKiloToken } from '@kilocode/worker-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { cloneRepository } from '../../src/git';
import type * as GitModule from '../../src/git';
import type * as GithubTokenModule from '../../src/github-token';
import { resolveGithubApiUrl } from '../../src/github';
import { resolveKiloGatewayUrl } from '../../src/model';
import { createReviewPersistence } from '../../src/persistence';
import type {
  Env,
  IsolateReviewSelection,
  ReviewStatusResponse,
  ReviewTranscriptResponse,
  RunState,
  StartReviewRequest,
  SummaryContent,
} from '../../src/types';

vi.mock('../../src/git', async () => {
  const actual = await vi.importActual<typeof GitModule>('../../src/git');
  return { ...actual, cloneRepository: vi.fn() };
});

vi.mock('../../src/github-token', async () => {
  const actual = await vi.importActual<typeof GithubTokenModule>('../../src/github-token');
  return {
    ...actual,
    resolveGithubCredentials: (options: Parameters<typeof actual.resolveGithubCredentials>[0]) =>
      actual.resolveGithubCredentials({
        ...options,
        service: {
          getTokenForRepo: async () => ({
            success: true,
            token: 'offline-github-fixture',
            installationId: 'fixture-installation',
            accountLogin: 'acme',
            appType: 'standard',
          }),
        },
      }),
  };
});

vi.mock('@kilocode/worker-utils/kilo-token-auth', () => ({
  verifyKiloBearerAgainstCurrentPepper: async ({
    token,
    nextAuthSecret,
  }: {
    token: string | null;
    nextAuthSecret: string;
  }) => {
    if (!token) return null;
    const claims = await verifyKiloToken(token, nextAuthSecret);
    return { userId: claims.kiloUserId };
  },
}));

const bindings = env as Env;
const USER_ID = 'incremental-review-owner';
const BASE_SHA = 'b'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);
const PREVIOUS_SHA = 'a'.repeat(40);
const HEAD_SHA = 'd'.repeat(40);
const HISTORY_SHA = 'e'.repeat(40);
const HISTORY_PARENT_SHA = 'f'.repeat(40);
const REPO_PATH = '/repos/acme/widget';
const PULL_PATH = `${REPO_PATH}/pulls/42`;
const SOURCE_PATH = 'src/limit.ts';
const RETAINED_PATH = 'src/retained.ts';
const ORIGINAL_SOURCE =
  'export function allowed(total: number, limit: number) {\n  return total < limit;\n}\n';
const PREVIOUS_SOURCE = ORIGINAL_SOURCE.replace('total < limit', 'total <= limit');
const HEAD_SOURCE = ORIGINAL_SOURCE.replace('total < limit', 'total >= limit');
const RETAINED_SOURCE = 'export const enabled = true;\n';
const BASELINE_SUMMARY = '<!-- kilo-review -->\nNo actionable findings in the full review.';
const INCREMENTAL_SUMMARY =
  '<!-- kilo-review -->\nThe changed comparison now accepts totals above the limit.';
const DELTA_PATCH =
  '@@ -1,3 +1,3 @@\n export function allowed(total: number, limit: number) {\n-  return total <= limit;\n+  return total >= limit;\n }';
const FULL_PATCH = DELTA_PATCH.replace('-  return total <= limit;', '-  return total < limit;');
const FINDING = {
  path: SOURCE_PATH,
  line: 2,
  side: 'RIGHT',
  body: 'Totals above the limit now pass while smaller totals fail; retain the <= comparison.',
};

type ScriptedTool = { name: string; input: Record<string, unknown> };
type GatewayRequest = {
  model: string;
  stream: boolean;
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools: Array<{ function: { name: string } }>;
};

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function authHeaders(): Record<string, string> {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      kiloUserId: USER_ID,
      version: 3,
      env: 'test',
      apiTokenPepper: 'fixture',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  ).toString('base64url');
  if (
    typeof bindings.NEXTAUTH_SECRET !== 'string' ||
    typeof bindings.INTERNAL_API_SECRET !== 'string'
  ) {
    throw new Error('Expected test-only authentication secrets');
  }
  const payload = `${header}.${claims}`;
  const signature = createHmac('sha256', bindings.NEXTAUTH_SECRET)
    .update(payload)
    .digest('base64url');
  return {
    'content-type': 'application/json',
    'x-internal-api-key': bindings.INTERNAL_API_SECRET,
    authorization: `Bearer ${payload}.${signature}`,
  };
}

function preparedRequest(
  headSha: string,
  selection: IsolateReviewSelection,
  previousSummary?: SummaryContent
): StartReviewRequest {
  const snapshot = { headSha, baseTipSha: BASE_SHA, mergeBaseSha: MERGE_SHA };
  const settings = {
    reviewStyle: 'balanced' as const,
    focusAreas: ['correctness'],
    customInstructions: null,
    manualInstructions: null,
    model: 'fixture/deterministic-review',
    thinkingEffort: null,
    modelSource: 'explicit' as const,
    disableReviewMd: true,
    analyticsEnabled: false,
  };
  const userPrompt = [
    'Review the selected changes, read the relevant files, and propose findings and a summary without publishing.',
    JSON.stringify(selection),
    previousSummary?.body ?? '',
  ].join('\n');
  return {
    owner: 'acme',
    repo: 'widget',
    pullNumber: 42,
    ...snapshot,
    model: settings.model,
    dryRun: true,
    userPrompt,
    reviewMode: selection.requestedMode,
    previousRunId: selection.previousRunId,
    expectedIntegrationId: 'fixture-integration',
    expectedInstallationId: 'fixture-installation',
    expectedAppType: 'standard',
    inference: {
      modelId: settings.model,
      provider: 'openai-compatible',
      thinkingEffort: null,
      variant: null,
      reasoningSupported: false,
      maxOutputTokens: 8000,
    },
    preparation: {
      version: 1,
      preparedAt: new Date().toISOString(),
      requestingUserId: USER_ID,
      executionUserId: USER_ID,
      reviewSelection: selection,
      settings,
      snapshot,
      github: {
        integrationId: 'fixture-integration',
        installationId: 'fixture-installation',
        appType: 'standard',
      },
      hashes: {
        settings: hash(JSON.stringify(settings)),
        context: hash(JSON.stringify({ snapshot, selection })),
        canonicalPrompt: hash(userPrompt),
        adaptedPrompt: hash(userPrompt),
        system: hash('prepared-fixture-system'),
      },
      versions: { cli: '7.4.20', policy: 'fixture-v1', adapter: 'isolate-runtime-v2' },
      limitations: [],
    },
  };
}

function streamReply(index: number, call?: ScriptedTool): Response {
  const base = { id: `completion-${index}`, model: 'fixture/deterministic-review', created: 1 };
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
      choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
  return new Response(
    events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } }
  );
}

async function runReview(input: StartReviewRequest) {
  const response = await SELF.fetch('https://worker.test/reviews', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(202);
  const { runId } = await response.json<{ runId: string }>();
  const stub = bindings.REVIEW_ISOLATE.get(bindings.REVIEW_ISOLATE.idFromName(runId));
  const status = await vi.waitFor(
    async () => {
      await runDurableObjectAlarm(stub);
      const statusResponse = await SELF.fetch(`https://worker.test/reviews/${runId}`, {
        headers: authHeaders(),
      });
      expect(statusResponse.status).toBe(200);
      const status = await statusResponse.json<ReviewStatusResponse>();
      expect(['completed', 'error']).toContain(status.status);
      return status;
    },
    { timeout: 5_000, interval: 10 }
  );
  expect(status.error).toBeUndefined();
  expect(status).toMatchObject({
    status: 'completed',
    terminationReason: 'completed',
    provenance: 'prepared',
    dryRun: true,
    headSha: input.headSha,
    analysisOutcome: {
      status: 'completed',
      parentFinished: true,
      parentFinishReason: 'stop',
    },
    summaryProposal: { publishable: true },
    finalText: 'Review complete.',
  });
  expect(status.published).not.toBe(true);
  expect(status.publishedAt).toBeUndefined();
  expect(status.githubReviewId).toBeUndefined();
  expect(status.summaryCommentId).toBeUndefined();
  expect(status.summaryBodyHash).toBeUndefined();
  expect(status.analysisOutcome?.contextIncompleteReasons ?? []).toEqual([]);
  expect(status.analysisOutcome?.incompleteTaskIds ?? []).toEqual([]);
  const transcriptResponse = await SELF.fetch(`https://worker.test/reviews/${runId}/messages`, {
    headers: authHeaders(),
  });
  expect(transcriptResponse.status).toBe(200);
  const transcript = await transcriptResponse.json<ReviewTranscriptResponse>();
  for (const call of transcript.toolCalls) {
    expect(call).toMatchObject({ state: 'output-available' });
    expect(call.errorText).toBeUndefined();
    expect(call.output).not.toHaveProperty('error');
  }
  const state = await runInDurableObject(stub, (_instance, durableState) =>
    createReviewPersistence(durableState.storage).persistence.get<RunState>('runState')
  );
  expect(state?.input.kiloToken).toBe('');
  expect(state?.githubToken).toBeUndefined();
  expect(state?.summaryOwnership).toBeUndefined();
  expect(state?.summaryContent).toEqual(status.summaryContent);
  return { status, transcript, state };
}

function toolOutput(transcript: ReviewTranscriptResponse, name: string, occurrence = 0): unknown {
  return transcript.toolCalls.filter(call => call.toolName === name)[occurrence]?.output;
}

afterEach(async () => {
  await reset();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('completes a full Think review, then reuses its persisted analysis for a changed-head incremental/history review without GitHub writes', async () => {
  let headSha = PREVIOUS_SHA;
  let script: ScriptedTool[] = [
    { name: 'activate_skill', input: { name: 'github-cloud-review' } },
    { name: 'pr_view', input: {} },
    { name: 'pr_diff', input: {} },
    { name: 'pr_comments', input: {} },
    { name: 'read', input: { path: `/workspace/${SOURCE_PATH}` } },
    { name: 'read', input: { path: `/workspace/${RETAINED_PATH}` } },
    { name: 'upsert_summary', input: { body: BASELINE_SUMMARY } },
  ];
  const gatewayUrl = resolveKiloGatewayUrl(bindings.KILO_GATEWAY_URL);
  const githubOrigin = new URL(resolveGithubApiUrl(bindings.GITHUB_API_URL)).origin;
  const gatewayRequests: Array<{ runId: string; body: GatewayRequest }> = [];
  const githubRequests: Array<{ method: string; url: string }> = [];
  const unexpectedRequests: string[] = [];
  const deltaFile = {
    sha: hash(HEAD_SOURCE).slice(0, 40),
    filename: SOURCE_PATH,
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: DELTA_PATCH,
  };
  const retainedFile = {
    sha: hash(RETAINED_SOURCE).slice(0, 40),
    filename: RETAINED_PATH,
    status: 'added',
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: '@@ -0,0 +1 @@\n+export const enabled = true;',
  };
  const historyCommit = {
    sha: HISTORY_SHA,
    commit: { message: 'Introduce the exclusive limit check' },
    parents: [{ sha: HISTORY_PARENT_SHA }],
  };

  vi.mocked(cloneRepository).mockImplementation(async (workspace, _input, sha) => {
    expect([PREVIOUS_SHA, HEAD_SHA]).toContain(sha);
    const source = sha === PREVIOUS_SHA ? PREVIOUS_SOURCE : HEAD_SOURCE;
    await workspace.mkdir('/workspace/src', { recursive: true });
    await workspace.writeFile(`/workspace/${SOURCE_PATH}`, source);
    await workspace.writeFile(`/workspace/${RETAINED_PATH}`, RETAINED_SOURCE);
    const bytes = new TextEncoder().encode(source + RETAINED_SOURCE).byteLength;
    return {
      tipFileCount: 2,
      tipTotalBytes: bytes,
      vfsTotalBytes: bytes,
      vfsFileCount: 2,
      cloneMs: 0,
    };
  });

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url.href === `${gatewayUrl}/chat/completions`) {
      expect(method).toBe('POST');
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON gateway request');
      const body = JSON.parse(init.body) as GatewayRequest;
      const headers = new Headers(init.headers);
      const runId = headers.get('x-kilo-session');
      if (!runId) throw new Error('Missing review session on gateway request');
      expect(headers.get('x-kilocode-mode')).toBe('code');
      expect(body.stream).toBe(true);
      expect(body.model).toBe('fixture/deterministic-review');
      const index = gatewayRequests.filter(request => request.runId === runId).length;
      expect(index).toBeLessThanOrEqual(script.length);
      const results = body.messages.filter(message => message.role === 'tool');
      expect(results.map(message => message.tool_call_id)).toEqual(
        script.slice(0, index).map((_call, step) => `call-${step}`)
      );
      const call = script[index];
      if (call) expect(body.tools.map(tool => tool.function.name)).toContain(call.name);
      gatewayRequests.push({ runId, body });
      return streamReply(index, call);
    }
    if (url.origin === githubOrigin) {
      githubRequests.push({ method, url: url.pathname + url.search });
      if (method !== 'GET') throw new Error('GitHub mutations are forbidden in this regression');
      if (url.pathname === REPO_PATH) return Response.json({ id: 123, size: 1 });
      if (url.pathname === PULL_PATH) {
        return Response.json({
          title: 'Allow requests at the limit',
          body: 'Preserve inclusive rate limiting.',
          head: { sha: headSha },
          base: { sha: BASE_SHA },
          state: 'open',
          draft: false,
          changed_files: 2,
        });
      }
      if (url.pathname === `${REPO_PATH}/compare/${BASE_SHA}...${headSha}`) {
        return Response.json({
          base_commit: { sha: BASE_SHA },
          merge_base_commit: { sha: MERGE_SHA },
          files: [
            {
              ...deltaFile,
              sha: hash(headSha === PREVIOUS_SHA ? PREVIOUS_SOURCE : HEAD_SOURCE).slice(0, 40),
              patch:
                headSha === PREVIOUS_SHA
                  ? FULL_PATCH.replace('+  return total >= limit;', '+  return total <= limit;')
                  : FULL_PATCH,
            },
            retainedFile,
          ],
        });
      }
      if (url.pathname === `${REPO_PATH}/compare/${PREVIOUS_SHA}...${HEAD_SHA}`) {
        return Response.json({
          base_commit: { sha: PREVIOUS_SHA },
          merge_base_commit: { sha: PREVIOUS_SHA },
          status: 'ahead',
          files: [deltaFile],
        });
      }
      if (
        [
          `${PULL_PATH}/comments`,
          `${PULL_PATH}/reviews`,
          `${REPO_PATH}/issues/42/comments`,
        ].includes(url.pathname)
      ) {
        return Response.json([]);
      }
      if (url.pathname === `${REPO_PATH}/commits`) {
        expect(Object.fromEntries(url.searchParams)).toEqual({
          sha: HEAD_SHA,
          per_page: '20',
          page: '1',
          path: SOURCE_PATH,
        });
        return Response.json([historyCommit]);
      }
      if (url.pathname === `${REPO_PATH}/commits/${HISTORY_SHA}`) {
        return Response.json({
          ...historyCommit,
          files: [
            {
              ...deltaFile,
              sha: hash(ORIGINAL_SOURCE).slice(0, 40),
              status: 'added',
              additions: 3,
              deletions: 0,
              changes: 3,
              patch:
                '@@ -0,0 +1,3 @@\n' +
                ORIGINAL_SOURCE.trimEnd()
                  .split('\n')
                  .map(line => `+${line}`)
                  .join('\n'),
            },
          ],
        });
      }
      if (url.pathname === `${REPO_PATH}/contents/${SOURCE_PATH}`) {
        const ref = url.searchParams.get('ref');
        expect([PREVIOUS_SHA, MERGE_SHA, HISTORY_SHA]).toContain(ref);
        const source = ref === PREVIOUS_SHA ? PREVIOUS_SOURCE : ORIGINAL_SOURCE;
        return Response.json({
          type: 'file',
          path: SOURCE_PATH,
          encoding: 'base64',
          content: btoa(source),
          size: source.length,
          sha: hash(source).slice(0, 40),
        });
      }
    }
    unexpectedRequests.push(`${method} ${url.origin}${url.pathname}`);
    throw new Error('Unexpected request; external networking is disabled');
  });

  const baseline = await runReview(
    preparedRequest(PREVIOUS_SHA, { requestedMode: 'full', effectiveMode: 'full' })
  );
  expect(baseline.status.summaryContent).toEqual({
    body: BASELINE_SUMMARY,
    bodyHash: hash(BASELINE_SUMMARY),
  });
  expect(baseline.status.reviewSelection).toEqual({ requestedMode: 'full', effectiveMode: 'full' });
  expect(baseline.status.publicationOutcome).toEqual({
    review: 'not_requested',
    summary: 'proposed',
  });
  expect(baseline.status.analysisOutcome?.stepCount).toBe(script.length + 1);
  expect(baseline.transcript.toolCalls.map(call => call.toolName)).toEqual(
    script.map(call => call.name)
  );
  expect(toolOutput(baseline.transcript, 'pr_diff')).toMatchObject({
    fileCount: 2,
    filesComplete: true,
    patchesComplete: true,
    contextComplete: true,
  });
  expect(toolOutput(baseline.transcript, 'read')).toMatchObject({
    content: expect.stringContaining('total <= limit'),
  });
  const baselineSummary = baseline.status.summaryContent;
  if (!baselineSummary) throw new Error('Full review did not retain its analysis summary');
  expect(baseline.status.summaryProposal?.bodyHash).not.toBe(baselineSummary.bodyHash);
  expect(toolOutput(baseline.transcript, 'upsert_summary')).toMatchObject({
    dryRun: true,
    publishable: true,
  });

  await abortAllDurableObjects();
  headSha = HEAD_SHA;
  script = [
    { name: 'activate_skill', input: { name: 'github-cloud-review' } },
    { name: 'pr_view', input: {} },
    { name: 'pr_diff', input: {} },
    { name: 'pr_file_patch', input: { path: SOURCE_PATH } },
    { name: 'read', input: { path: `/workspace/${SOURCE_PATH}` } },
    { name: 'pr_file', input: { path: SOURCE_PATH, revision: 'previous' } },
    { name: 'pr_diff', input: { comparison: 'current-pr' } },
    { name: 'pr_file', input: { path: SOURCE_PATH, revision: 'merge-base' } },
    { name: 'pr_history', input: { path: SOURCE_PATH } },
    { name: 'pr_commit', input: { sha: HISTORY_SHA, path: SOURCE_PATH } },
    { name: 'pr_file', input: { path: SOURCE_PATH, revision: 'history', commitSha: HISTORY_SHA } },
    { name: 'pr_comments', input: {} },
    { name: 'submit_review', input: { comments: [FINDING] } },
    { name: 'upsert_summary', input: { body: INCREMENTAL_SUMMARY } },
  ];
  const selection: IsolateReviewSelection = {
    requestedMode: 'incremental',
    effectiveMode: 'incremental',
    previousRunId: baseline.status.runId,
    previousHeadSha: PREVIOUS_SHA,
    previousSummaryHash: baselineSummary.bodyHash,
    changedFileCount: 1,
  };
  const incremental = await runReview(preparedRequest(HEAD_SHA, selection, baselineSummary));
  expect(incremental.status.reviewSelection).toEqual(selection);
  expect(incremental.status.publicationOutcome).toEqual({
    review: 'proposed',
    summary: 'proposed',
  });
  expect(incremental.status.analysisOutcome?.stepCount).toBe(script.length + 1);
  expect(incremental.transcript.toolCalls.map(call => call.toolName)).toEqual(
    script.map(call => call.name)
  );
  expect(incremental.transcript.messages[0]).toMatchObject({
    role: 'user',
    text: expect.stringContaining(BASELINE_SUMMARY),
  });
  expect(toolOutput(incremental.transcript, 'pr_diff')).toMatchObject({
    comparison: 'review',
    previousHeadSha: PREVIOUS_SHA,
    fileCount: 1,
    files: [
      expect.objectContaining({
        filename: SOURCE_PATH,
        patch: DELTA_PATCH,
        oldRevision: 'previous',
      }),
    ],
    filesComplete: true,
    patchesComplete: true,
    contextComplete: true,
  });
  expect(toolOutput(incremental.transcript, 'pr_file_patch')).toMatchObject({
    comparison: 'review',
    body: DELTA_PATCH,
    patchComplete: true,
  });
  expect(toolOutput(incremental.transcript, 'read')).toMatchObject({
    content: expect.stringContaining('total >= limit'),
  });
  expect(toolOutput(incremental.transcript, 'pr_file')).toMatchObject({
    revision: 'previous',
    sha: PREVIOUS_SHA,
    body: PREVIOUS_SOURCE,
  });
  expect(toolOutput(incremental.transcript, 'pr_diff', 1)).toMatchObject({
    comparison: 'current-pr',
    fileCount: 2,
    files: [
      expect.objectContaining({
        filename: SOURCE_PATH,
        patch: FULL_PATCH,
        oldRevision: 'merge-base',
      }),
      expect.objectContaining({ filename: RETAINED_PATH }),
    ],
    contextComplete: true,
  });
  expect(toolOutput(incremental.transcript, 'pr_file', 1)).toMatchObject({
    revision: 'merge-base',
    sha: MERGE_SHA,
    body: ORIGINAL_SOURCE,
  });
  expect(toolOutput(incremental.transcript, 'pr_history')).toMatchObject({
    available: true,
    headSha: HEAD_SHA,
    commits: [expect.objectContaining({ sha: HISTORY_SHA })],
  });
  expect(toolOutput(incremental.transcript, 'pr_commit')).toMatchObject({
    available: true,
    sha: HISTORY_SHA,
    complete: true,
    patch: { path: SOURCE_PATH, patchComplete: true },
  });
  expect(toolOutput(incremental.transcript, 'pr_file', 2)).toMatchObject({
    available: true,
    revision: 'history',
    sha: HISTORY_SHA,
    body: ORIGINAL_SOURCE,
  });
  expect(incremental.state?.historyState).toEqual({ requestCount: 3, commitShas: [HISTORY_SHA] });
  expect(toolOutput(incremental.transcript, 'submit_review')).toMatchObject({
    dryRun: true,
    publishable: true,
    wouldSend: { commit_id: HEAD_SHA, event: 'COMMENT', body: '', comments: [FINDING] },
  });
  expect(toolOutput(incremental.transcript, 'upsert_summary')).toMatchObject({
    dryRun: true,
    publishable: true,
    wouldSend: {
      method: 'POST',
      path: `${REPO_PATH}/issues/42/comments`,
      payload: { body: expect.stringContaining(INCREMENTAL_SUMMARY) },
    },
  });
  expect(incremental.status.summaryContent).toEqual({
    body: INCREMENTAL_SUMMARY,
    bodyHash: hash(INCREMENTAL_SUMMARY),
  });
  const incrementalRequests = gatewayRequests.filter(
    request => request.runId === incremental.status.runId
  );
  expect(incrementalRequests).toHaveLength(script.length + 1);
  const replayedResults = incrementalRequests.at(-1)?.body.messages;
  for (const call of incremental.transcript.toolCalls.filter(call =>
    call.toolName.startsWith('pr_')
  )) {
    expect(
      replayedResults?.find(message => message.tool_call_id === call.toolCallId)
    ).toMatchObject({
      role: 'tool',
      content: JSON.stringify(call.output),
    });
  }
  const workspaceRead = incremental.transcript.toolCalls.find(call => call.toolName === 'read');
  expect(
    replayedResults?.find(message => message.tool_call_id === workspaceRead?.toolCallId)?.content
  ).toEqual(expect.stringContaining('total >= limit'));
  expect(incrementalRequests[0]?.body.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining(BASELINE_SUMMARY) }),
    ])
  );
  expect(
    githubRequests.filter(
      request => request.url === `${REPO_PATH}/compare/${PREVIOUS_SHA}...${HEAD_SHA}?per_page=1`
    ).length
  ).toBeGreaterThanOrEqual(2);
  expect(githubRequests.filter(request => request.method !== 'GET')).toEqual([]);
  expect(unexpectedRequests).toEqual([]);
}, 30_000);
