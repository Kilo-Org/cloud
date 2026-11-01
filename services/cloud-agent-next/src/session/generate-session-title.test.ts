import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateSessionTitle } from './generate-session-title.js';
import type { Env } from '../types.js';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../logger.js', () => ({
  logger: { withFields: () => ({ warn, withFields: () => ({ warn }) }) },
}));

const metadata = {
  identity: { sessionId: 'workspace_12345678-1234-1234-1234-123456789abc', userId: 'oauth/user' },
  auth: { kiloSessionId: 'ses_12345678901234567890123456' },
};
const turn = { type: 'prompt', prompt: 'Fix the login form validation' } as const;

function setup() {
  const run = vi.fn().mockResolvedValue({ response: 'Fix login form validation' });
  const persist = vi.fn().mockResolvedValue({ applied: true });
  const eligible = vi.fn().mockResolvedValue(true);
  const env = {
    AI: { run },
    SESSION_INGEST: {
      setGeneratedTitleForCloudAgent: persist,
      canGenerateTitleForCloudAgent: eligible,
    },
  } as unknown as Pick<Env, 'AI' | 'SESSION_INGEST'>;
  return { env, run, persist, eligible };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('generateSessionTitle', () => {
  it('checks workspace eligibility before sending the first message to the model', async () => {
    const { env, run, persist, eligible } = setup();
    eligible.mockResolvedValue(false);
    await generateSessionTitle(env, metadata, turn);
    expect(eligible).toHaveBeenCalledExactlyOnceWith({
      sessionId: metadata.auth.kiloSessionId,
      kiloUserId: metadata.identity.userId,
      cloudAgentSessionId: metadata.identity.sessionId,
    });
    expect(run).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('skips inference when workspace eligibility cannot be checked', async () => {
    const { env, run, persist, eligible } = setup();
    eligible.mockRejectedValue(new Error('unavailable'));
    await expect(generateSessionTitle(env, metadata, turn)).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Session title eligibility check failed');
  });

  it('bounds a stalled workspace eligibility check without starting inference', async () => {
    vi.useFakeTimers();
    const { env, run, persist, eligible } = setup();
    eligible.mockReturnValue(new Promise(() => {}));
    const task = generateSessionTitle(env, metadata, turn);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(task).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('uses a small model and persists a normalized title for the owning session', async () => {
    const { env, run, persist } = setup();
    run.mockResolvedValue({ response: ' "Fix login\n form validation" ' });

    await generateSessionTitle(env, metadata, turn);

    expect(run).toHaveBeenCalledExactlyOnceWith(
      '@cf/meta/llama-3.2-3b-instruct',
      {
        messages: [
          expect.objectContaining({ role: 'system' }),
          { role: 'user', content: turn.prompt },
        ],
        max_tokens: 64,
        temperature: 0,
      },
      { signal: expect.any(AbortSignal) }
    );
    expect(persist).toHaveBeenCalledExactlyOnceWith({
      sessionId: metadata.auth.kiloSessionId,
      kiloUserId: metadata.identity.userId,
      cloudAgentSessionId: metadata.identity.sessionId,
      title: 'Fix login form validation',
    });
  });

  it('bounds the first message sent to the title model', async () => {
    const { env, run } = setup();
    await generateSessionTitle(env, metadata, { type: 'prompt', prompt: 'x'.repeat(20_000) });
    expect(run.mock.calls[0]?.[1].messages[1].content).toHaveLength(4096);
  });

  it('summarizes slash commands without sending attachment URLs', async () => {
    const { env, run } = setup();
    await generateSessionTitle(env, metadata, {
      type: 'command',
      command: 'review',
      arguments: 'the login changes',
    });
    expect(run.mock.calls[0]?.[1].messages[1].content).toBe('/review the login changes');
  });

  it('uses text parts when the prompt is empty, ignoring files', async () => {
    const { env, run } = setup();
    await generateSessionTitle(env, metadata, {
      type: 'prompt',
      prompt: '',
      parts: [
        { type: 'text', text: 'Fix login' },
        { type: 'file', mime: 'image/png', url: 'https://private.test/signed' },
      ],
    });
    expect(run.mock.calls[0]?.[1].messages[1].content).toBe('Fix login');
  });

  it('skips inference without a binding, session ID, or message text', async () => {
    const { env, run, persist } = setup();
    await generateSessionTitle({ ...env, AI: undefined }, metadata, turn);
    await generateSessionTitle(env, { ...metadata, auth: {} }, turn);
    await generateSessionTitle(env, metadata, { type: 'prompt', prompt: '  ' });
    expect(run).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('retries a failed inference once', async () => {
    const { env, run, persist } = setup();
    run.mockRejectedValueOnce(new Error('unavailable'));
    await generateSessionTitle(env, metadata, turn);
    expect(run).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([null, {}, { response: '' }, { response: '""' }, { response: 'x'.repeat(201) }])(
    'does not persist invalid output %j',
    async output => {
      const { env, run, persist } = setup();
      run.mockResolvedValue(output);
      await expect(generateSessionTitle(env, metadata, turn)).resolves.toBeUndefined();
      expect(run).toHaveBeenCalledTimes(1);
      expect(persist).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('Session title model returned an invalid title');
    }
  );

  it('bounds stalled inference and ignores a late response', async () => {
    vi.useFakeTimers();
    const { env, run, persist } = setup();
    let complete: (output: { response: string }) => void = () => {};
    run.mockReturnValue(
      new Promise(resolve => {
        complete = resolve;
      })
    );
    const task = generateSessionTitle(env, metadata, turn);
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(task).resolves.toBeUndefined();
    complete({ response: 'Late title' });
    await Promise.resolve();
    expect(persist).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(2);
    for (const call of run.mock.calls) expect(call[2].signal.aborted).toBe(true);
  });

  it('does not propagate persistence failures or regenerate a refused title', async () => {
    const { env, run, persist } = setup();
    persist.mockRejectedValueOnce(new Error('unavailable'));
    await expect(generateSessionTitle(env, metadata, turn)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Session title persistence failed');
    expect(run).toHaveBeenCalledTimes(1);

    persist.mockResolvedValue({ applied: false });
    await generateSessionTitle(env, metadata, turn);
    expect(run).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledTimes(2);
  });
});
