import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupSession,
  cleanupSessionUntilSettled,
  startSession,
  type DriverConfig,
  type StartSessionResult,
} from '../e2e/client.js';

function config(onSessionCreated: (sessionId: string) => void): DriverConfig {
  return {
    workerUrl: 'http://worker.test',
    user: {
      id: 'user_test',
      email: 'test@example.com',
      api_token_pepper: 'pepper',
    },
    nextAuthSecret: 'test-secret',
    gitUrl: 'https://example.com/repo.git',
    model: 'kilo/fake-deterministic',
    fakeLlmUrl: 'http://fake-llm.test',
    onSessionCreated,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('startSession row tracking', () => {
  it('reports a successfully created session to the matrix cleanup hook', async () => {
    const result: StartSessionResult = {
      cloudAgentSessionId: 'agent_created',
      kiloSessionId: 'ses_created',
      messageId: 'msg_created',
      delivery: 'queued',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ result: { data: result } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    const onSessionCreated = vi.fn();

    await expect(startSession(config(onSessionCreated), { prompt: 'hello' })).resolves.toEqual(
      result
    );
    expect(onSessionCreated).toHaveBeenCalledExactlyOnceWith('agent_created');
  });

  it('does not report a session when creation fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })));
    const onSessionCreated = vi.fn();

    await expect(startSession(config(onSessionCreated), { prompt: 'hello' })).rejects.toThrow(
      'tRPC start failed: 503'
    );
    expect(onSessionCreated).not.toHaveBeenCalled();
  });
});

describe('cleanupSession', () => {
  it('uses the trusted cleanup endpoint with the internal API secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { data: { success: true } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const cleanupConfig = { ...config(vi.fn()), internalApiSecret: 'internal-secret' };

    await expect(cleanupSession(cleanupConfig, 'agent_created')).resolves.toEqual({
      success: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://worker.test/trpc/cleanupSession'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-internal-api-key': 'internal-secret' }),
        body: JSON.stringify({ sessionId: 'agent_created' }),
      })
    );
  });

  it('polls a retryable physical-cleanup state until deletion settles', async () => {
    const retryable = new Response(JSON.stringify({ error: { data: { retryable: true } } }), {
      status: 500,
    });
    const settled = new Response(JSON.stringify({ result: { data: { success: true } } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(retryable).mockResolvedValueOnce(settled);
    vi.stubGlobal('fetch', fetchMock);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      cleanupSessionUntilSettled(
        { ...config(vi.fn()), internalApiSecret: 'internal-secret' },
        'agent_created',
        { sleep }
      )
    ).resolves.toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it('fails before the request when the internal API secret is unavailable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(cleanupSession(config(vi.fn()), 'agent_created')).rejects.toThrow(
      'cleanupSession requires INTERNAL_API_SECRET'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
