import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, startSession, type DriverConfig } from '../e2e/client.js';
import { cleanupOwnedSessions } from '../e2e/smoke-cleanup.js';

vi.mock('../e2e/auth.js', () => ({ mintApiToken: () => 'test-token' }));

afterEach(() => vi.unstubAllGlobals());

describe('owned session cleanup', () => {
  it.each([
    'No accepted wrapper messages or pending queued messages',
    'No session work to interrupt',
  ])('allows the documented idle response: %s', async message => {
    const stop = vi.fn().mockResolvedValue(undefined);
    await cleanupOwnedSessions(new Set(['idle']), {
      interrupt: async () => ({ success: false, message }),
      stopOwnedSandboxes: stop,
    });
    expect(stop.mock.calls).toEqual([['idle']]);
  });

  it('cancels pending demand before teardown so a failed scenario cannot respawn', async () => {
    const pending = new Set(['owned-a', 'owned-b', 'unrelated']);
    const actions: string[] = [];
    const recreated: string[] = [];
    await cleanupOwnedSessions(new Set(['owned-a', 'owned-b']), {
      interrupt: async id => {
        actions.push(`interrupt:${id}`);
        pending.delete(id);
        return { success: true };
      },
      stopOwnedSandboxes: async id => {
        actions.push(`stop:${id}`);
        if (pending.has(id)) recreated.push(id);
      },
    });
    expect(actions).toEqual([
      'interrupt:owned-a',
      'interrupt:owned-b',
      'stop:owned-a',
      'stop:owned-b',
    ]);
    expect(recreated).toEqual([]);
    expect([...pending]).toEqual(['unrelated']);
  });

  it('reports failed cancellation, skips its teardown, and cleans other owned sessions', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    await expect(
      cleanupOwnedSessions(new Set(['failed', 'idle']), {
        interrupt: async id =>
          id === 'failed'
            ? { success: false, message: 'interruption failed' }
            : {
                success: false,
                message: 'No accepted wrapper messages or pending queued messages',
              },
        stopOwnedSandboxes: stop,
      })
    ).rejects.toThrow('Owned session cleanup failed');
    expect(stop.mock.calls).toEqual([['idle']]);
  });

  it('does not tear down a session after an interruption transport failure', async () => {
    const stop = vi.fn();
    await expect(
      cleanupOwnedSessions(new Set(['owned']), {
        interrupt: async () => {
          throw new Error('transport failed');
        },
        stopOwnedSandboxes: stop,
      })
    ).rejects.toThrow('Owned session cleanup failed');
    expect(stop).not.toHaveBeenCalled();
  });
});

describe('smoke session ownership tracking', () => {
  function config(onSessionCreated: (sessionId: string) => void): DriverConfig {
    return {
      ...DEFAULT_CONFIG,
      user: { id: 'matrix-user', email: 'matrix@example.test', api_token_pepper: 'test' },
      nextAuthSecret: 'test',
      internalApiSecret: 'test',
      onSessionCreated,
    };
  }

  it('retains the owned unified session when a post-start assertion fails', async () => {
    const owned = new Set<string>();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          result: { data: { cloudAgentSessionId: 'agent_owned' } },
        })
      )
    );
    await expect(
      startSession(
        {
          ...config(id => owned.add(id)),
          expectControlPlane: true,
        },
        { prompt: 'test' }
      )
    ).rejects.toThrow('expected an enrolled');
    expect([...owned]).toEqual(['agent_owned']);
  });

  it('retains a legacy prepared session when initiation fails', async () => {
    const owned = new Set<string>();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            result: {
              data: {
                cloudAgentSessionId: 'agent_prepared',
                kiloSessionId: 'ses_prepared',
              },
            },
          })
        )
        .mockResolvedValueOnce(
          Response.json({ error: { message: 'initiation failed' } }, { status: 503 })
        )
    );
    await expect(
      startSession(
        config(id => owned.add(id)),
        { prompt: 'test' },
        'legacy'
      )
    ).rejects.toThrow('initiation failed');
    expect([...owned]).toEqual(['agent_prepared']);
  });
});
