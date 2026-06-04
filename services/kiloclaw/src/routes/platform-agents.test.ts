import { afterEach, describe, expect, it, vi } from 'vitest';
import { platform } from './platform';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));

function baseEnv(stub: Record<string, unknown>) {
  return {
    KILOCLAW_INSTANCE: {
      idFromName: (id: string) => id,
      get: () => stub,
    },
    KILOCLAW_AE: { writeDataPoint: vi.fn() },
    KV_CLAW_CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
    },
  } as never;
}

const AGENT_SUMMARY = {
  id: 'work',
  name: 'Work',
  configured: true,
  workspace: '/workspace/work',
  agentDir: '/state/work',
  model: { primary: null, fallbacks: [], source: null },
  rawModel: null,
  settings: {
    thinkingDefault: null,
    verboseDefault: null,
    reasoningDefault: null,
    fastModeDefault: null,
  },
};
const DEFAULTS_SUMMARY = {
  model: null,
  settings: {
    thinkingDefault: null,
    verboseDefault: null,
    reasoningDefault: null,
    fastModeDefault: null,
  },
};

function jsonInit(method: string, body: unknown) {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('platform agent config routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── reads ───────────────────────────────────────────────────────────

  it('GET /agents returns the fleet', async () => {
    const listAgents = vi
      .fn()
      .mockResolvedValue({ etag: 'e1', defaults: DEFAULTS_SUMMARY, agents: [AGENT_SUMMARY] });
    const response = await platform.request('/agents?userId=user-1', {}, baseEnv({ listAgents }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ etag: 'e1', agents: [{ id: 'work' }] });
    expect(listAgents).toHaveBeenCalledTimes(1);
  });

  it('GET /agents requires userId', async () => {
    const listAgents = vi.fn();
    const response = await platform.request('/agents', {}, baseEnv({ listAgents }));

    expect(response.status).toBe(400);
    expect(listAgents).not.toHaveBeenCalled();
  });

  it('GET /agents/:agentId reads one agent', async () => {
    const getAgent = vi.fn().mockResolvedValue({ etag: 'e1', agent: AGENT_SUMMARY });
    const response = await platform.request(
      '/agents/work?userId=user-1',
      {},
      baseEnv({ getAgent })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ agent: { id: 'work' } });
    expect(getAgent).toHaveBeenCalledWith('work');
  });

  // ── writes (payload forwarded opaquely) ─────────────────────────────

  it('POST /agents forwards the create payload to the DO', async () => {
    const createAgent = vi.fn().mockResolvedValue({
      ok: true,
      etag: 'e1',
      agent: AGENT_SUMMARY,
      created: {
        agentId: 'work',
        name: 'Work',
        workspace: '/workspace/work',
        agentDir: '/state/work',
      },
    });
    const response = await platform.request(
      '/agents',
      jsonInit('POST', {
        userId: 'user-1',
        agent: { name: 'Work', workspace: '/workspace/work' },
      }),
      baseEnv({ createAgent })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, created: { agentId: 'work' } });
    expect(createAgent).toHaveBeenCalledWith({ name: 'Work', workspace: '/workspace/work' });
  });

  it('PATCH /agents/:agentId forwards the patch to the DO', async () => {
    const updateAgent = vi.fn().mockResolvedValue({ ok: true, etag: 'e2', agent: AGENT_SUMMARY });
    const response = await platform.request(
      '/agents/work',
      jsonInit('PATCH', {
        userId: 'user-1',
        patch: { etag: 'e1', set: { thinkingDefault: 'high' } },
      }),
      baseEnv({ updateAgent })
    );

    expect(response.status).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith('work', {
      etag: 'e1',
      set: { thinkingDefault: 'high' },
    });
  });

  it('PATCH /agent-defaults forwards the patch to the DO', async () => {
    const updateAgentDefaults = vi
      .fn()
      .mockResolvedValue({ ok: true, etag: 'e2', defaults: DEFAULTS_SUMMARY });
    const response = await platform.request(
      '/agent-defaults',
      jsonInit('PATCH', { userId: 'user-1', patch: { set: { thinkingDefault: 'low' } } }),
      baseEnv({ updateAgentDefaults })
    );

    expect(response.status).toBe(200);
    expect(updateAgentDefaults).toHaveBeenCalledWith({ set: { thinkingDefault: 'low' } });
  });

  it('DELETE /agents/:agentId deletes one agent', async () => {
    const deleteAgent = vi.fn().mockResolvedValue({
      ok: true,
      filesystemDisposition: 'unverified',
      agentId: 'work',
      workspace: '/workspace/work',
      agentDir: '/state/work',
      sessionsDir: '/state/work/sessions',
      removedBindings: 1,
      removedAllow: 0,
    });
    const response = await platform.request(
      '/agents/work?userId=user-1',
      { method: 'DELETE' },
      baseEnv({ deleteAgent })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ filesystemDisposition: 'unverified' });
    expect(deleteAgent).toHaveBeenCalledWith('work');
  });

  // ── envelope validation ─────────────────────────────────────────────

  it('POST /agents rejects a body missing userId', async () => {
    const createAgent = vi.fn();
    const response = await platform.request(
      '/agents',
      jsonInit('POST', { agent: { name: 'Work', workspace: '/w' } }),
      baseEnv({ createAgent })
    );

    expect(response.status).toBe(400);
    expect(createAgent).not.toHaveBeenCalled();
  });

  // ── error-code passthrough ──────────────────────────────────────────
  // Typed errors cross the DO RPC boundary as a RETURNED envelope (GatewayController
  // .status/.code would be stripped if thrown), so these mocks resolve an envelope
  // — the shape the real DO actually returns — and assert the route reconstructs it.

  function errorEnvelope(status: number, code: string | null, message: string) {
    return { agentError: { status, code, message } };
  }

  it('fails closed (501) when the controller lacks the capability', async () => {
    const createAgent = vi
      .fn()
      .mockResolvedValue(
        errorEnvelope(
          501,
          'capability_unavailable',
          'Controller does not advertise required capability "config.agents.create.basic.cli"'
        )
      );
    const response = await platform.request(
      '/agents',
      jsonInit('POST', { userId: 'user-1', agent: { name: 'Work', workspace: '/w' } }),
      baseEnv({ createAgent })
    );

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ code: 'capability_unavailable' });
  });

  it('forwards 404 agent_not_found from a returned envelope', async () => {
    const getAgent = vi
      .fn()
      .mockResolvedValue(errorEnvelope(404, 'agent_not_found', 'Agent not found'));
    const response = await platform.request(
      '/agents/ghost?userId=user-1',
      {},
      baseEnv({ getAgent })
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'agent_not_found' });
  });

  it('forwards 409 config_etag_conflict from a returned envelope', async () => {
    const updateAgent = vi
      .fn()
      .mockResolvedValue(errorEnvelope(409, 'config_etag_conflict', 'Config changed'));
    const response = await platform.request(
      '/agents/work',
      jsonInit('PATCH', {
        userId: 'user-1',
        patch: { etag: 'stale', set: { thinkingDefault: 'high' } },
      }),
      baseEnv({ updateAgent })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'config_etag_conflict' });
  });

  it('redacts the message for an unknown envelope code but keeps the status', async () => {
    const deleteAgent = vi
      .fn()
      .mockResolvedValue(errorEnvelope(500, 'unexpected_internal', 'super secret internal detail'));
    const response = await platform.request(
      '/agents/work?userId=user-1',
      { method: 'DELETE' },
      baseEnv({ deleteAgent })
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).not.toContain('super secret internal detail');
  });

  it('maps an unexpected thrown error (not an envelope) to a generic 500', async () => {
    const listAgents = vi.fn().mockRejectedValue(new Error('DO unreachable'));
    const response = await platform.request('/agents?userId=user-1', {}, baseEnv({ listAgents }));

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).not.toContain('DO unreachable');
  });

  // ── retry policy (non-idempotent mutations must not auto-replay) ─────

  function retryableError(message: string) {
    return Object.assign(new Error(message), { retryable: true });
  }

  it('does not auto-retry createAgent on a retryable DO error', async () => {
    const createAgent = vi.fn().mockRejectedValue(retryableError('DO transient'));
    const response = await platform.request(
      '/agents',
      jsonInit('POST', { userId: 'user-1', agent: { name: 'Work', workspace: '/w' } }),
      baseEnv({ createAgent })
    );

    expect(response.status).toBe(500);
    // A non-idempotent create must surface the failure, never replay (which could
    // return agent_exists for an action that already committed).
    expect(createAgent).toHaveBeenCalledTimes(1);
  });

  it('does not auto-retry deleteAgent on a retryable DO error', async () => {
    const deleteAgent = vi.fn().mockRejectedValue(retryableError('DO transient'));
    const response = await platform.request(
      '/agents/work?userId=user-1',
      { method: 'DELETE' },
      baseEnv({ deleteAgent })
    );

    expect(response.status).toBe(500);
    expect(deleteAgent).toHaveBeenCalledTimes(1);
  });

  it('still auto-retries reads (listAgents) on a retryable DO error', async () => {
    vi.useFakeTimers();
    try {
      const listAgents = vi
        .fn()
        .mockRejectedValueOnce(retryableError('DO transient'))
        .mockResolvedValueOnce({ etag: 'e1', defaults: DEFAULTS_SUMMARY, agents: [] });

      const requestPromise = platform.request('/agents?userId=user-1', {}, baseEnv({ listAgents }));
      await vi.runAllTimersAsync();
      const response = await requestPromise;

      expect(response.status).toBe(200);
      expect(listAgents).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
