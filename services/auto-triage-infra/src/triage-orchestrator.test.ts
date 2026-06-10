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

function createHarness() {
  let storedState = createTicket();
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
