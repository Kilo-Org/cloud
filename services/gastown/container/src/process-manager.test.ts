import { describe, it, expect, vi } from 'vitest';

// Mock heavy imports so the module can be loaded without spinning up
// a real SDK server or hono app.
vi.mock('@kilocode/sdk', () => ({
  createKilo: vi.fn(),
}));
// Mock workspace helpers to return a path that actually exists on the
// test runner so ensureSDKServer's process.chdir doesn't ENOENT.
const TEST_WORKSPACE = process.cwd();
vi.mock('./agent-runner', () => ({
  runAgent: vi.fn(),
  buildKiloConfigContent: vi.fn(
    (kilocodeToken: string, model: string, smallModel: string, organizationId?: string) =>
      JSON.stringify({ kilocodeToken, model, smallModel, organizationId })
  ),
  resolveGitCredentials: vi.fn(),
  writeMayorSystemPromptToAgentsMd: vi.fn(),
  ensureMayorWorkspaceForTown: vi.fn(async (_townId: string) => TEST_WORKSPACE),
  mayorWorkdirForTown: vi.fn((_townId: string) => TEST_WORKSPACE),
}));
vi.mock('./control-server', () => ({
  getCurrentTownConfig: vi.fn(() => ({})),
  getLastAppliedEnvVarKeys: vi.fn(() => new Set<string>()),
  RESERVED_ENV_KEYS: new Set<string>(),
}));
vi.mock('./completion-reporter', () => ({
  reportAgentCompleted: vi.fn(),
  reportMayorWaiting: vi.fn(),
}));
vi.mock('./token-refresh', () => ({
  refreshTokenIfNearExpiry: vi.fn(),
}));

const { applyModelToSession, withStartAgentLock, awaitHydration, bootHydration } =
  await import('./process-manager');

type PromptCall = {
  path: { id: string };
  body: {
    parts: Array<{ type: 'text'; text: string }>;
    model: { providerID: string; modelID: string };
    noReply?: boolean;
  };
};

function makeClient(impl?: (args: PromptCall) => Promise<unknown>) {
  const calls: PromptCall[] = [];
  const prompt = vi.fn(async (args: PromptCall) => {
    calls.push(args);
    if (impl) return impl(args);
    return {};
  });
  return { client: { session: { prompt } }, calls, prompt };
}

describe('applyModelToSession', () => {
  it('sends the startup prompt with the model for a fresh session', async () => {
    const { client, calls } = makeClient();
    await applyModelToSession({
      client,
      sessionId: 'sess-new',
      model: 'anthropic/claude-sonnet-4.6',
      prompt: 'STARTUP PROMPT',
      resumedSession: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toEqual({ id: 'sess-new' });
    expect(calls[0].body.parts).toEqual([{ type: 'text', text: 'STARTUP PROMPT' }]);
    expect(calls[0].body.model).toEqual({
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4.6',
    });
    expect(calls[0].body.noReply).toBeUndefined();
  });

  it('pushes the new model with noReply:true for a resumed session without replaying the startup prompt', async () => {
    const { client, calls } = makeClient();
    await applyModelToSession({
      client,
      sessionId: 'sess-resumed',
      model: 'anthropic/claude-opus-4.7',
      prompt: 'STARTUP PROMPT (must not be sent)',
      resumedSession: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toEqual({ id: 'sess-resumed' });
    expect(calls[0].body.model).toEqual({
      providerID: 'kilo',
      modelID: 'anthropic/claude-opus-4.7',
    });
    expect(calls[0].body.noReply).toBe(true);
    expect(calls[0].body.parts).toEqual([{ type: 'text', text: '' }]);
    // Ensure the MAYOR_STARTUP_PROMPT is NOT replayed on resume.
    expect(calls[0].body.parts[0].text).not.toContain('STARTUP PROMPT');
  });

  it('swallows errors from the resumed-session prompt so the hot-swap can continue', async () => {
    const { client } = makeClient(async () => {
      throw new Error('simulated SDK failure');
    });
    // Should not throw — errors on the noReply path are logged and ignored.
    await expect(
      applyModelToSession({
        client,
        sessionId: 'sess-resumed',
        model: 'anthropic/claude-opus-4.7',
        prompt: 'STARTUP PROMPT',
        resumedSession: true,
      })
    ).resolves.toBeUndefined();
  });

  it('propagates errors for a fresh session (so the hot-swap can roll back)', async () => {
    const { client } = makeClient(async () => {
      throw new Error('simulated SDK failure');
    });
    await expect(
      applyModelToSession({
        client,
        sessionId: 'sess-new',
        model: 'anthropic/claude-sonnet-4.6',
        prompt: 'STARTUP PROMPT',
        resumedSession: false,
      })
    ).rejects.toThrow('simulated SDK failure');
  });
});

describe('withStartAgentLock', () => {
  it('serialises concurrent callers for the same agentId', async () => {
    const order: string[] = [];
    let secondStartedBeforeFirstFinished = false;

    // Fire both in the same microtask so they race on the lock.
    const first = withStartAgentLock('agent-1', async () => {
      order.push('first:start');
      await new Promise(r => setTimeout(r, 20));
      order.push('first:end');
      return 1;
    });
    const second = withStartAgentLock('agent-1', async () => {
      // If the lock works, `first:end` has already been pushed.
      if (!order.includes('first:end')) {
        secondStartedBeforeFirstFinished = true;
      }
      order.push('second:start');
      order.push('second:end');
      return 2;
    });

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(secondStartedBeforeFirstFinished).toBe(false);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('runs concurrently for different agentIds', async () => {
    const order: string[] = [];

    const a = withStartAgentLock('agent-a', async () => {
      order.push('a:start');
      await new Promise(r => setTimeout(r, 20));
      order.push('a:end');
    });
    const b = withStartAgentLock('agent-b', async () => {
      order.push('b:start');
      await new Promise(r => setTimeout(r, 20));
      order.push('b:end');
    });

    await Promise.all([a, b]);

    // Both should have started before either ended (no serialisation across ids).
    expect(order.indexOf('b:start')).toBeLessThan(order.indexOf('a:end'));
  });

  it('releases the lock when the fn throws so subsequent callers can proceed', async () => {
    await expect(
      withStartAgentLock('agent-err', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const result = await withStartAgentLock('agent-err', async () => 'ok');
    expect(result).toBe('ok');
  });
});

describe('awaitHydration', () => {
  it('resolves immediately before any bootHydration call', async () => {
    // Module-init state must not block /agents/start in test/dev contexts
    // where bootHydration never runs.
    let resolved = false;
    void awaitHydration().then(() => {
      resolved = true;
    });
    await new Promise(r => setTimeout(r, 0));
    expect(resolved).toBe(true);
  });

  it('prewarms mayor SDK with env that mirrors buildAgentEnv (mayor tools require GASTOWN_AGENT_ROLE/AGENT_ID/TOWN_ID)', async () => {
    // Without these env vars in the snapshot kilo serve takes at spawn,
    // GastownPlugin (plugin/index.ts) treats the prewarmed mayor as a
    // rig agent (or fails the createMayorClientFromEnv guard) and the
    // server boots with NO mayor tools. ensureSDKServer's cache hit on
    // the next /agents/start hands back that defective server.
    const { createKilo } = (await import('@kilocode/sdk')) as unknown as {
      createKilo: ReturnType<typeof vi.fn>;
    };

    const prev = {
      apiUrl: process.env.GASTOWN_API_URL,
      townId: process.env.GASTOWN_TOWN_ID,
      token: process.env.GASTOWN_CONTAINER_TOKEN,
    };
    process.env.GASTOWN_API_URL = 'http://test.invalid';
    process.env.GASTOWN_TOWN_ID = 'town-prewarm';
    process.env.GASTOWN_CONTAINER_TOKEN = 'tok-prewarm';

    let capturedEnv: Record<string, string | undefined> | null = null;
    createKilo.mockImplementationOnce(() => {
      // Snapshot the keys plugin/index.ts and plugin/client.ts read.
      capturedEnv = {
        GASTOWN_AGENT_ID: process.env.GASTOWN_AGENT_ID,
        GASTOWN_AGENT_ROLE: process.env.GASTOWN_AGENT_ROLE,
        GASTOWN_TOWN_ID: process.env.GASTOWN_TOWN_ID,
        GASTOWN_API_URL: process.env.GASTOWN_API_URL,
        GASTOWN_CONTAINER_TOKEN: process.env.GASTOWN_CONTAINER_TOKEN,
        KILO_CONFIG_CONTENT: process.env.KILO_CONFIG_CONTENT,
      };
      return Promise.resolve({
        client: {} as unknown,
        server: { url: 'http://127.0.0.1:9999/', close: () => {} },
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/container-registry')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (url.includes('/mayor-id')) {
        return new Response(
          JSON.stringify({
            success: true,
            agentId: 'mayor-agent-1',
            model: 'anthropic/claude-sonnet-4.6',
            smallModel: 'anthropic/claude-haiku-4.5',
            kilocodeToken: 'kc-tok',
            organizationId: null,
          }),
          { status: 200 }
        );
      }
      // db-snapshot etc: 404 -> fresh start
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    try {
      await bootHydration();
      const env = capturedEnv as Record<string, string | undefined> | null;
      expect(env).not.toBeNull();
      expect(env).toMatchObject({
        GASTOWN_AGENT_ID: 'mayor-agent-1',
        GASTOWN_AGENT_ROLE: 'mayor',
        GASTOWN_TOWN_ID: 'town-prewarm',
        GASTOWN_CONTAINER_TOKEN: 'tok-prewarm',
      });
      expect(env?.KILO_CONFIG_CONTENT).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
      if (prev.apiUrl !== undefined) process.env.GASTOWN_API_URL = prev.apiUrl;
      else delete process.env.GASTOWN_API_URL;
      if (prev.townId !== undefined) process.env.GASTOWN_TOWN_ID = prev.townId;
      else delete process.env.GASTOWN_TOWN_ID;
      if (prev.token !== undefined) process.env.GASTOWN_CONTAINER_TOKEN = prev.token;
      else delete process.env.GASTOWN_CONTAINER_TOKEN;
    }
  });

  it('blocks awaiters while bootHydration is in flight and releases them when it returns', async () => {
    // Drive bootHydration into its registry-fetch path with a fetch
    // stub that we can hold open from the test, so we can observe a
    // real "in flight" window for the gate.
    const prev = {
      apiUrl: process.env.GASTOWN_API_URL,
      townId: process.env.GASTOWN_TOWN_ID,
      token: process.env.GASTOWN_CONTAINER_TOKEN,
    };
    process.env.GASTOWN_API_URL = 'http://test.invalid';
    process.env.GASTOWN_TOWN_ID = 'town-test';
    process.env.GASTOWN_CONTAINER_TOKEN = 'tok-test';

    // Use a single barrier the fetch stub awaits so every call (registry
    // fetch + prewarm endpoints) holds the gate until we release it,
    // and each call gets its own Response (avoids "body already read").
    let releaseFetch!: () => void;
    const fetchBarrier = new Promise<void>(resolve => {
      releaseFetch = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      await fetchBarrier;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/container-registry')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, agentId: null }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const hydrationPromise = bootHydration();
      let awaiterResolved = false;
      void awaitHydration().then(() => {
        awaiterResolved = true;
      });

      // Yield to let the registry fetch start. The gate is now held
      // until the fetch resolves.
      await new Promise(r => setTimeout(r, 10));
      expect(awaiterResolved).toBe(false);

      releaseFetch();
      await hydrationPromise;
      // After bootHydration returns, the gate must release any awaiters.
      await new Promise(r => setTimeout(r, 0));
      expect(awaiterResolved).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (prev.apiUrl !== undefined) process.env.GASTOWN_API_URL = prev.apiUrl;
      else delete process.env.GASTOWN_API_URL;
      if (prev.townId !== undefined) process.env.GASTOWN_TOWN_ID = prev.townId;
      else delete process.env.GASTOWN_TOWN_ID;
      if (prev.token !== undefined) process.env.GASTOWN_CONTAINER_TOKEN = prev.token;
      else delete process.env.GASTOWN_CONTAINER_TOKEN;
    }
  });
});
