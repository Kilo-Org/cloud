/* eslint-disable require-await, @typescript-eslint/require-await -- the fake fetch rejects on abort without awaiting */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  requestToolSummaryTranslation,
  TOOL_SUMMARY_TRANSLATION_TIMEOUT_MS,
} from './tool-summary-translation-client';

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));

const { getAuthTokenForRequest, getItemAsync } = vi.hoisted(() => ({
  getAuthTokenForRequest: vi.fn(),
  getItemAsync: vi.fn(),
}));

vi.mock('@/lib/auth/token-owner', () => ({ getAuthTokenForRequest }));
vi.mock('expo-secure-store', () => ({ getItemAsync }));

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

const INPUT = { text: 'Hello world', targetLanguage: 'de', model: 'kilo-auto/small' };

/** The last fetch call, for request-shape assertions. */
function lastFetchCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) {
    throw new Error('fetch was not called');
  }
  return { url: call[0], init: call[1] };
}

/** The parsed JSON request body. */
function lastRequestBody(): {
  model: string;
  stream: boolean;
  messages: { role: string; content: string }[];
} {
  const body = lastFetchCall().init.body;
  if (typeof body !== 'string') {
    throw new TypeError('request body was not a string');
  }
  return JSON.parse(body) as {
    model: string;
    stream: boolean;
    messages: { role: string; content: string }[];
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  getAuthTokenForRequest.mockReset();
  getItemAsync.mockReset();
  getAuthTokenForRequest.mockResolvedValue('token-1');
  getItemAsync.mockResolvedValue('org-1');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('requestToolSummaryTranslation', () => {
  it('posts the translation request with the gateway feature header and endonym prompt', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ choices: [{ message: { content: '  Hallo Welt  ' } }] })
    );

    const result = await requestToolSummaryTranslation(INPUT);

    expect(result).toBe('Hallo Welt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = lastFetchCall();
    expect(url).toBe('https://api.example.com/api/gateway/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: 'Bearer token-1',
      'Content-Type': 'application/json',
      'X-KILOCODE-FEATURE': 'tool-summary-translation',
      'X-KiloCode-OrganizationId': 'org-1',
    });
    const body = lastRequestBody();
    expect(body.model).toBe('kilo-auto/small');
    expect(body.stream).toBe(false);
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[0]?.content).toContain('Deutsch');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Hello world' });
  });

  it('omits the organization header when no organization is set', async () => {
    getItemAsync.mockResolvedValue(null);
    fetchMock.mockResolvedValue(Response.json({ choices: [{ message: { content: 'ok' } }] }));

    await requestToolSummaryTranslation(INPUT);

    expect(lastFetchCall().init.headers).toEqual({
      Authorization: 'Bearer token-1',
      'Content-Type': 'application/json',
      'X-KILOCODE-FEATURE': 'tool-summary-translation',
    });
  });

  it('falls back to the raw language tag when it has no endonym', async () => {
    fetchMock.mockResolvedValue(Response.json({ choices: [{ message: { content: 'ok' } }] }));

    await requestToolSummaryTranslation({ ...INPUT, targetLanguage: 'xx' });

    expect(lastRequestBody().messages[0]?.content).toContain('xx');
  });

  it('returns null without calling the gateway when there is no token', async () => {
    getAuthTokenForRequest.mockResolvedValue(null);

    expect(await requestToolSummaryTranslation(INPUT)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));

    expect(await requestToolSummaryTranslation(INPUT)).toBeNull();
  });

  it('returns null on a malformed body', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));

    expect(await requestToolSummaryTranslation(INPUT)).toBeNull();
  });

  it('returns null when the response shape is unexpected', async () => {
    fetchMock.mockResolvedValue(Response.json({ choices: [] }));

    expect(await requestToolSummaryTranslation(INPUT)).toBeNull();
  });

  it('returns null on empty content', async () => {
    fetchMock.mockResolvedValue(Response.json({ choices: [{ message: { content: '   ' } }] }));

    expect(await requestToolSummaryTranslation(INPUT)).toBeNull();
  });

  it('aborts on the 15s timeout and returns null', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })
    );

    const pending = requestToolSummaryTranslation(INPUT);
    await vi.advanceTimersByTimeAsync(TOOL_SUMMARY_TRANSLATION_TIMEOUT_MS);

    expect(await pending).toBeNull();
  });
});
