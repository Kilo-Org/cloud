import { beforeEach, describe, expect, it } from '@jest/globals';
import { after } from 'next/server';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  getPartnerSession,
  hasRecentPartnerUpstreamError,
  PARTNER_UPSTREAM_ERROR_TTL_SECONDS,
  rememberPartnerUpstreamError,
} from './partner-upstream-error-cache';

jest.mock('next/server', () => ({ after: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { exists: jest.fn(), set: jest.fn() },
}));

const mockedAfter = jest.mocked(after);
const mockedExists = jest.mocked(redisClient.exists);
const mockedSet = jest.mocked(redisClient.set);

const session = { userId: 'user-1', partnerId: 'acme/model', promptCacheKey: 'session-1' };

async function runAfterTasks() {
  for (const [task] of mockedAfter.mock.calls) {
    if (typeof task === 'function') await task();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('getPartnerSession', () => {
  it('identifies the session by the prompt cache key', () => {
    expect(
      getPartnerSession(
        {
          kind: 'responses',
          body: { model: 'acme/model', input: 'hi', prompt_cache_key: 'session-1' },
        },
        null,
        'user-1',
        'acme/model'
      )
    ).toEqual(session);
  });

  it('prefers the task id, from which the gateway derives the upstream prompt cache key', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: { model: 'acme/model', messages: [], prompt_cache_key: 'client-key' },
    };
    expect(getPartnerSession(request, 'task-1', 'user-1', 'acme/model')).toEqual({
      ...session,
      promptCacheKey: 'task-1',
    });
    expect(
      getPartnerSession(
        { kind: 'chat_completions', body: { model: 'acme/model', messages: [] } },
        'task-1',
        'user-1',
        'acme/model'
      )
    ).toEqual({ ...session, promptCacheKey: 'task-1' });
  });

  it.each([
    ['no prompt cache key', { kind: 'chat_completions', body: { model: 'm', messages: [] } }],
    [
      'an empty prompt cache key',
      { kind: 'chat_completions', body: { model: 'm', messages: [], prompt_cache_key: '' } },
    ],
    ['a messages request', { kind: 'messages', body: { model: 'm', messages: [], max_tokens: 1 } }],
  ] as const)('returns null for %s', (_name, request) => {
    expect(getPartnerSession(request as never, null, 'user-1', 'acme/model')).toBeNull();
  });
});

describe('partner upstream error cache', () => {
  it('writes the session with the TTL after the response, under a hashed key', async () => {
    mockedSet.mockResolvedValue('OK');

    rememberPartnerUpstreamError(session);
    expect(mockedSet).not.toHaveBeenCalled();
    await runAfterTasks();

    expect(mockedSet).toHaveBeenCalledWith(
      expect.stringMatching(/^partner-upstream-error:v1:[0-9a-f]{64}$/),
      '1',
      { ex: PARTNER_UPSTREAM_ERROR_TTL_SECONDS }
    );
    expect(PARTNER_UPSTREAM_ERROR_TTL_SECONDS).toBe(300);
  });

  it('keys each caller, partner and prompt cache key separately', async () => {
    mockedSet.mockResolvedValue('OK');
    rememberPartnerUpstreamError(session);
    rememberPartnerUpstreamError({ ...session, userId: 'user-2' });
    rememberPartnerUpstreamError({ ...session, partnerId: 'acme/other' });
    rememberPartnerUpstreamError({ ...session, promptCacheKey: 'session-2' });
    await runAfterTasks();

    expect(new Set(mockedSet.mock.calls.map(([key]) => key)).size).toBe(4);
  });

  it('restarts the TTL when the session is seen again', async () => {
    mockedExists.mockResolvedValue(1);
    mockedSet.mockResolvedValue('OK');

    await expect(hasRecentPartnerUpstreamError(session)).resolves.toBe(true);
    await runAfterTasks();

    expect(mockedSet).toHaveBeenCalledWith(mockedExists.mock.calls[0]?.[0], '1', {
      ex: PARTNER_UPSTREAM_ERROR_TTL_SECONDS,
    });
  });

  it('writes nothing on a miss', async () => {
    mockedExists.mockResolvedValue(0);

    await expect(hasRecentPartnerUpstreamError(session)).resolves.toBe(false);

    expect(mockedAfter).not.toHaveBeenCalled();
  });

  it('still reports a hit when the refresh cannot be registered', async () => {
    mockedExists.mockResolvedValue(1);
    const outsideRequestScope = () => {
      throw new Error('outside a request scope');
    };
    mockedAfter
      .mockImplementationOnce(outsideRequestScope)
      .mockImplementationOnce(outsideRequestScope);

    await expect(hasRecentPartnerUpstreamError(session)).resolves.toBe(true);
    expect(() => rememberPartnerUpstreamError(session)).not.toThrow();
  });

  it('treats Redis trouble as a miss and a lost write', async () => {
    mockedExists.mockRejectedValue(new Error('timeout'));
    mockedSet.mockRejectedValue(new Error('timeout'));

    await expect(hasRecentPartnerUpstreamError(session)).resolves.toBe(false);
    rememberPartnerUpstreamError(session);
    await expect(runAfterTasks()).resolves.toBeUndefined();
  });
});
