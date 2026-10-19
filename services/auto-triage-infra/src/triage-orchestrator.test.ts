import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    protected ctx: unknown;
    protected env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { TriageOrchestrator } from './triage-orchestrator';
import { classificationCallbackPayloadSchema, type TriageTicket } from './types';

const callbackSecret = 'callback-secret';
const cloudAgentSessionId = 'agent_triage';

function createTicket(): TriageTicket {
  return {
    ticketId: 'ticket-1',
    authToken: 'auth-token',
    sessionInput: {
      repoFullName: 'kilocode/example',
      issueNumber: 42,
      issueTitle: 'Failure callback',
      issueBody: null,
      duplicateThreshold: 0.8,
      autoFixThreshold: 0.9,
      modelSlug: 'test-model',
    },
    owner: { type: 'user', id: 'user-1', userId: 'user-1' },
    status: 'analyzing',
    cloudAgentSessionId,
    callbackSecret,
    updatedAt: '2026-06-10T00:00:00.000Z',
  };
}

function createAutoFixTicket(author?: string): TriageTicket {
  return {
    ...createTicket(),
    issueAuthor: author,
    githubToken: 'github-token',
  };
}

const highConfidencePayload = {
  cloudAgentSessionId,
  status: 'completed' as const,
  lastAssistantMessageText:
    'Classification complete.\n```json\n{"classification":"bug","confidence":0.98,"intentSummary":"Crash on startup","selectedLabels":[]}\n```',
};

function labelsInFetchCalls(
  calls: Array<unknown[]>
): Array<{ labels?: string[]; autoFixSkipped?: boolean }> {
  return calls.map(call => {
    const init = call[1] as { body?: string } | undefined;
    const body = JSON.parse(init?.body ?? '{}') as {
      labels?: string[];
      actionMetadata?: { autoFixSkipped?: boolean };
    };
    return { labels: body.labels, autoFixSkipped: body.actionMetadata?.autoFixSkipped };
  });
}

function createHarness(ticket: TriageTicket = createTicket()) {
  let storedState = ticket;
  const put = vi.fn(async (_key: string, value: TriageTicket) => {
    storedState = structuredClone(value);
  });
  const deleteAlarm = vi.fn(async () => {});
  const context = {
    storage: {
      get: async () => structuredClone(storedState),
      put,
      deleteAlarm,
    },
  } as unknown as DurableObjectState;
  const environment = {
    API_URL: 'https://api.example.com',
    INTERNAL_API_SECRET: 'internal-secret',
  };
  const orchestrator = new TriageOrchestrator(context, environment as never);

  return { orchestrator, getStoredState: () => storedState, put, deleteAlarm };
}

describe('TriageOrchestrator classification failure callbacks', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 }))
    );
  });

  it('persists the structured failure message instead of the legacy error message', async () => {
    const harness = createHarness();

    await harness.orchestrator.completeClassification(callbackSecret, {
      cloudAgentSessionId,
      status: 'failed',
      errorMessage: 'legacy wrapper error',
      failure: {
        code: 'workspace_setup_failed',
        subtype: 'git_clone_timeout',
        message: 'Repository clone timed out',
      },
    });

    expect(harness.getStoredState()).toMatchObject({
      status: 'failed',
      errorMessage: 'Repository clone timed out',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/api/internal/triage-status/ticket-1',
      expect.objectContaining({
        body: JSON.stringify({
          status: 'failed',
          errorMessage: 'Repository clone timed out',
        }),
      })
    );
  });

  it.each([
    { failure: { code: 'future_failure_code' } },
    { failure: { subtype: 'future_workspace_failure' } },
    { failure: { extra: true } },
    { failure: { attempts: -1 } },
    { failure: { message: 'x'.repeat(4_097) } },
  ])('discards incompatible failure and retains the legacy payload: %o', extension => {
    expect(
      classificationCallbackPayloadSchema.parse({
        cloudAgentSessionId,
        status: 'failed',
        errorMessage: 'legacy wrapper error',
        ...extension,
      })
    ).toEqual({
      cloudAgentSessionId,
      status: 'failed',
      errorMessage: 'legacy wrapper error',
      failure: undefined,
    });
  });

  it('persists the legacy error message when structured failure is absent', async () => {
    const harness = createHarness();

    await harness.orchestrator.completeClassification(callbackSecret, {
      cloudAgentSessionId,
      status: 'failed',
      errorMessage: 'legacy wrapper error',
    });

    expect(harness.getStoredState()).toMatchObject({
      status: 'failed',
      errorMessage: 'legacy wrapper error',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/api/internal/triage-status/ticket-1',
      expect.objectContaining({
        body: JSON.stringify({ status: 'failed', errorMessage: 'legacy wrapper error' }),
      })
    );
  });
});

describe('TriageOrchestrator auto-fix label permission gate', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  async function stubFetchResponses(responses: Array<{ urlPart: string; body: unknown }>) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      for (const response of responses) {
        if (url.includes(response.urlPart)) {
          return new Response(JSON.stringify(response.body), { status: 200 });
        }
      }
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  type FetchMock = ReturnType<typeof vi.fn>;

  function calledGithubPermissionApi(fetchMock: FetchMock): boolean {
    return fetchMock.mock.calls.some(call => {
      const input = call[0];
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.includes('api.github.com');
    });
  }

  const permissionUrl = 'https://api.github.com/repos/kilocode/example/collaborators';

  it('withstands a read-permission author at high confidence: auto-fix label is not applied', async () => {
    const harness = createHarness(createAutoFixTicket('outside-contributor'));
    const fetchMock = await stubFetchResponses([
      { urlPart: permissionUrl, body: { permission: 'read' } },
    ]);

    await harness.orchestrator.completeClassification(callbackSecret, highConfidencePayload);

    const calls = labelsInFetchCalls(fetchMock.mock.calls);
    expect(calls.some(call => call.labels?.includes('kilo-triaged'))).toBe(true);
    expect(calls.some(call => call.labels?.includes('kilo-auto-fix'))).toBe(false);
    expect(calls.some(call => call.autoFixSkipped)).toBe(true);
    expect(harness.getStoredState()).toMatchObject({ status: 'actioned' });
  });

  it('applies only worker-owned automation labels when the model selects one', async () => {
    const ticket = {
      ...createAutoFixTicket('repo-maintainer'),
      availableLabels: ['bug', 'kilo-auto-fix'],
    };
    const harness = createHarness(ticket);
    const fetchMock = await stubFetchResponses([
      { urlPart: permissionUrl, body: { permission: 'write' } },
    ]);

    await harness.orchestrator.completeClassification(callbackSecret, {
      cloudAgentSessionId,
      status: 'completed',
      lastAssistantMessageText:
        'Classification complete.\n```json\n{"classification":"bug","confidence":0.5,"intentSummary":"Crash on startup","selectedLabels":["kilo-auto-fix","bug"]}\n```',
    });

    const calls = labelsInFetchCalls(fetchMock.mock.calls);
    const applied = calls.find(call => call.labels !== undefined);
    expect(applied?.labels).toContain('bug');
    expect(applied?.labels).not.toContain('kilo-auto-fix');
    expect(calledGithubPermissionApi(fetchMock)).toBe(false);
  });

  it('applies the auto-fix label for a maintain-tier author at high confidence', async () => {
    const harness = createHarness(createAutoFixTicket('repo-maintainer'));
    const fetchMock = await stubFetchResponses([
      { urlPart: permissionUrl, body: { permission: 'maintain' } },
    ]);

    await harness.orchestrator.completeClassification(callbackSecret, highConfidencePayload);

    const calls = labelsInFetchCalls(fetchMock.mock.calls);
    expect(calls.some(call => call.labels?.includes('kilo-auto-fix'))).toBe(true);
    expect(harness.getStoredState()).toMatchObject({ status: 'actioned' });
  });

  it('applies the auto-fix label for a write-permission author at high confidence', async () => {
    const harness = createHarness(createAutoFixTicket('repo-committer'));
    const fetchMock = await stubFetchResponses([
      { urlPart: permissionUrl, body: { permission: 'write' } },
    ]);

    await harness.orchestrator.completeClassification(callbackSecret, highConfidencePayload);

    const calls = labelsInFetchCalls(fetchMock.mock.calls);
    expect(calls.some(call => call.labels?.includes('kilo-auto-fix'))).toBe(true);
    expect(harness.getStoredState()).toMatchObject({ status: 'actioned' });
  });

  it('fails closed when the permission lookup returns an unexpected level', async () => {
    const harness = createHarness(createAutoFixTicket('unknown-tier'));
    const fetchMock = await stubFetchResponses([
      { urlPart: permissionUrl, body: { permission: 'tier-1' } },
    ]);

    await harness.orchestrator.completeClassification(callbackSecret, highConfidencePayload);

    const calls = labelsInFetchCalls(fetchMock.mock.calls);
    expect(calls.some(call => call.labels?.includes('kilo-auto-fix'))).toBe(false);
    expect(calls.some(call => call.autoFixSkipped)).toBe(true);
  });

  it('fails closed when no GitHub token is available', async () => {
    const ticket = { ...createAutoFixTicket('some-author'), githubToken: undefined };
    const harness = createHarness(ticket);
    const fetchMock = await stubFetchResponses([]);

    await harness.orchestrator.completeClassification(callbackSecret, highConfidencePayload);

    expect(calledGithubPermissionApi(fetchMock)).toBe(false);
    const calls = labelsInFetchCalls(fetchMock.mock.calls);
    expect(calls.some(call => call.labels?.includes('kilo-auto-fix'))).toBe(false);
  });

  it('does not call the permission API on the low-confidence path', async () => {
    const harness = createHarness(createAutoFixTicket('outside-contributor'));
    const fetchMock = await stubFetchResponses([
      { urlPart: permissionUrl, body: { permission: 'read' } },
    ]);

    await harness.orchestrator.completeClassification(callbackSecret, {
      cloudAgentSessionId,
      status: 'completed',
      lastAssistantMessageText:
        'Classification complete.\n```json\n{"classification":"bug","confidence":0.4,"intentSummary":"Crash on startup","selectedLabels":[]}\n```',
    });

    expect(calledGithubPermissionApi(fetchMock)).toBe(false);
  });
});
