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
      modelSlug: 'test-model',
    },
    owner: { type: 'user', id: 'user-1', userId: 'user-1' },
    status: 'analyzing',
    cloudAgentSessionId,
    callbackSecret,
    updatedAt: '2026-06-10T00:00:00.000Z',
  };
}

function payloadFor(classification: string, confidence: number, selectedLabels: string[]) {
  return {
    cloudAgentSessionId,
    status: 'completed' as const,
    lastAssistantMessageText: `Classification complete.\n\`\`\`json\n${JSON.stringify({
      classification,
      confidence,
      intentSummary: 'Reported behavior',
      selectedLabels,
    })}\n\`\`\``,
  };
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Object.entries(value).find(([name]) => name === key)?.[1];
}

function requestBody(call: readonly unknown[]): unknown {
  const raw = field(call[1], 'body');
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function requestUrl(call: readonly unknown[]): string {
  const input = call[0];
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  const url = field(input, 'url');
  return typeof url === 'string' ? url : '';
}

function appliedLabelLists(calls: readonly (readonly unknown[])[]): string[][] {
  return calls.flatMap(call => {
    const labels = field(requestBody(call), 'labels');
    if (!Array.isArray(labels)) return [];
    const names = labels.filter((item): item is string => typeof item === 'string');
    return names.length === labels.length ? [names] : [];
  });
}

function createHarness(ticket: TriageTicket = createTicket()) {
  let storedState = ticket;
  const put = vi.fn(async (_key: string, value: TriageTicket) => {
    storedState = structuredClone(value);
  });
  const deleteAlarm = vi.fn(async () => {});
  const setAlarm = vi.fn(async () => {});
  const context = {
    storage: {
      get: async () => structuredClone(storedState),
      put,
      deleteAlarm,
      setAlarm,
    },
  } as unknown as DurableObjectState;
  const environment = {
    API_URL: 'https://api.example.com',
    INTERNAL_API_SECRET: 'internal-secret',
    SELF_URL: 'https://triage-worker.example.com',
    CLOUD_AGENT_URL: 'https://cloud-agent.example.com',
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

describe('TriageOrchestrator reserved label handling', () => {
  const addLabelUrl = 'https://api.example.com/api/internal/triage/add-label';

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(responses: Array<{ urlPart: string; body: unknown }>) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(addLabelUrl)) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      for (const response of responses) {
        if (url.includes(response.urlPart)) {
          return new Response(JSON.stringify(response.body), { status: 200 });
        }
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it.each(['bug', 'feature'])(
    'applies the selected content labels on the %s path',
    async classification => {
      const harness = createHarness({
        ...createTicket(),
        availableLabels: ['bug', 'kilo-triaged', 'kilo-duplicate'],
      });
      const fetchMock = stubFetch([]);

      await harness.orchestrator.completeClassification(
        callbackSecret,
        payloadFor(classification, 0.97, ['bug', 'kilo-triaged', 'kilo-duplicate'])
      );

      expect(appliedLabelLists(fetchMock.mock.calls)).toEqual([['kilo-triaged', 'bug']]);
      expect(harness.getStoredState()).toMatchObject({ status: 'actioned' });
    }
  );

  it('preserves repository labels whose names match built-in object properties', async () => {
    const harness = createHarness({
      ...createTicket(),
      availableLabels: ['constructor', 'kilo-triaged'],
    });
    const fetchMock = stubFetch([]);

    await harness.orchestrator.completeClassification(
      callbackSecret,
      payloadFor('bug', 0.97, ['constructor', 'kilo-triaged'])
    );

    expect(appliedLabelLists(fetchMock.mock.calls)).toEqual([['kilo-triaged', 'constructor']]);
  });

  it.each(['question', 'unclear'])(
    'applies only triage-owned labels on the %s path',
    async classification => {
      const harness = createHarness({
        ...createTicket(),
        availableLabels: [classification, 'kilo-triaged', 'kilo-duplicate'],
      });
      const fetchMock = stubFetch([]);

      await harness.orchestrator.completeClassification(
        callbackSecret,
        payloadFor(classification, 0.6, [classification, 'kilo-duplicate', 'kilo-triaged'])
      );

      expect(appliedLabelLists(fetchMock.mock.calls)).toEqual([['kilo-triaged', classification]]);
      expect(harness.getStoredState()).toMatchObject({ status: 'actioned' });
    }
  );

  it('leaves triage-applied labels out of the classification candidates', async () => {
    const harness = createHarness({
      ...createTicket(),
      status: 'pending',
      cloudAgentSessionId: undefined,
      callbackSecret: undefined,
    });
    const fetchMock = stubFetch([
      { urlPart: '/api/internal/triage/check-duplicates', body: { isDuplicate: false } },
      {
        urlPart: '/api/internal/triage/classify-config',
        body: {
          githubToken: 'github-token',
          config: { model_slug: 'test-model' },
          excluded_labels: ['skip-me'],
        },
      },
      {
        urlPart: 'api.github.com/repos/kilocode/example/labels',
        body: [{ name: 'bug' }, { name: 'kilo-triaged' }, { name: 'kilo-duplicate' }],
      },
      {
        urlPart: '/trpc/prepareSession',
        body: {
          result: { data: { cloudAgentSessionId: 'agent-1', kiloSessionId: 'kilo-1' } },
        },
      },
      {
        urlPart: '/trpc/initiateFromKilocodeSessionV2',
        body: { result: { data: { executionId: 'exec-1' } } },
      },
    ]);

    await harness.orchestrator.runTriage();

    const prepareCall = fetchMock.mock.calls.find(call =>
      requestUrl(call).includes('/trpc/prepareSession')
    );
    expect(prepareCall).toBeDefined();
    const prompt = field(requestBody(prepareCall ?? []), 'prompt');
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('- "bug"');
    expect(prompt).not.toContain('skip-me');
    expect(prompt).not.toContain('kilo-triaged');
    expect(prompt).not.toContain('kilo-duplicate');
    expect(harness.getStoredState().availableLabels).toEqual(['bug']);
  });
});
