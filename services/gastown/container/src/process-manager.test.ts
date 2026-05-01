import { describe, it, expect, vi } from 'vitest';

// Mock heavy imports so the module can be loaded without spinning up
// a real SDK server or hono app.
vi.mock('@kilocode/sdk', () => ({
  createKilo: vi.fn(),
}));
vi.mock('./agent-runner', () => ({
  runAgent: vi.fn(),
  buildKiloConfigContent: vi.fn(),
  resolveGitCredentials: vi.fn(),
  writeMayorSystemPromptToAgentsMd: vi.fn(),
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

const { applyModelToSession } = await import('./process-manager');

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
