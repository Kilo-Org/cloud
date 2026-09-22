/* eslint-disable require-await, @typescript-eslint/require-await -- the fake fetch rejects on abort without awaiting */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  requestToolSummaryTranslations,
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

const INPUT = { texts: ['Hello world'], targetLanguage: 'de', model: 'kilo-auto/small' };

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

/** A chat-completions response whose message content is `content`. */
function contentResponse(content: string): Response {
  return Response.json({ choices: [{ message: { content } }] });
}

/** The gateway reply an N-text batch expects: a JSON array of translations. */
function arrayContent(translations: string[]): Response {
  return contentResponse(JSON.stringify(translations));
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

describe('requestToolSummaryTranslations', () => {
  it('posts ONE request for the batch with the gateway header and endonym prompt', async () => {
    fetchMock.mockResolvedValue(arrayContent(['  Hallo Welt  ', 'Zweiter Satz']));

    const result = await requestToolSummaryTranslations({
      ...INPUT,
      texts: ['Hello world', 'Second sentence'],
    });

    expect(result).toEqual(['Hallo Welt', 'Zweiter Satz']);
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
    // The whole batch rides in the one user message as a JSON array.
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: JSON.stringify(['Hello world', 'Second sentence']),
    });
  });

  it('omits the organization header when no organization is set', async () => {
    getItemAsync.mockResolvedValue(null);
    fetchMock.mockResolvedValue(arrayContent(['ok']));

    await requestToolSummaryTranslations(INPUT);

    expect(lastFetchCall().init.headers).toEqual({
      Authorization: 'Bearer token-1',
      'Content-Type': 'application/json',
      'X-KILOCODE-FEATURE': 'tool-summary-translation',
    });
  });

  it('falls back to the raw language tag when it has no endonym', async () => {
    fetchMock.mockResolvedValue(arrayContent(['ok']));

    await requestToolSummaryTranslations({ ...INPUT, targetLanguage: 'xx' });

    expect(lastRequestBody().messages[0]?.content).toContain('xx');
  });

  it('parses a fenced JSON array', async () => {
    fetchMock.mockResolvedValue(contentResponse('```json\n["Hallo Welt", "Zweiter Satz"]\n```'));

    const result = await requestToolSummaryTranslations({
      ...INPUT,
      texts: ['Hello world', 'Second sentence'],
    });

    expect(result).toEqual(['Hallo Welt', 'Zweiter Satz']);
  });

  it('makes no fetch and returns an empty array for no texts', async () => {
    expect(await requestToolSummaryTranslations({ ...INPUT, texts: [] })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns one null per text without calling the gateway when there is no token', async () => {
    getAuthTokenForRequest.mockResolvedValue(null);

    expect(await requestToolSummaryTranslations({ ...INPUT, texts: ['a', 'b'] })).toEqual([
      null,
      null,
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns one null per text on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));

    expect(await requestToolSummaryTranslations({ ...INPUT, texts: ['a', 'b'] })).toEqual([
      null,
      null,
    ]);
  });

  it('returns one null per text on a malformed body', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));

    expect(await requestToolSummaryTranslations(INPUT)).toEqual([null]);
  });

  it('returns one null per text when the response shape is unexpected', async () => {
    fetchMock.mockResolvedValue(Response.json({ choices: [] }));

    expect(await requestToolSummaryTranslations(INPUT)).toEqual([null]);
  });

  it('returns one null per text when the content is not a JSON array', async () => {
    fetchMock.mockResolvedValue(contentResponse('{"translation":"Hallo"}'));

    expect(await requestToolSummaryTranslations({ ...INPUT, texts: ['a', 'b'] })).toEqual([
      null,
      null,
    ]);
  });

  it('returns one null per text when the array length does not match the batch', async () => {
    fetchMock.mockResolvedValue(arrayContent(['Hallo']));

    expect(await requestToolSummaryTranslations({ ...INPUT, texts: ['a', 'b'] })).toEqual([
      null,
      null,
    ]);
  });

  it('returns null at a position whose entry is not a string', async () => {
    fetchMock.mockResolvedValue(contentResponse('["eins", 2, "drei"]'));

    expect(await requestToolSummaryTranslations({ ...INPUT, texts: ['a', 'b', 'c'] })).toEqual([
      'eins',
      null,
      'drei',
    ]);
  });

  it('returns null at a position whose entry is blank', async () => {
    fetchMock.mockResolvedValue(contentResponse('["eins", "   " ]'));

    expect(await requestToolSummaryTranslations({ ...INPUT, texts: ['a', 'b'] })).toEqual([
      'eins',
      null,
    ]);
  });

  it('returns one null per text on empty content', async () => {
    fetchMock.mockResolvedValue(contentResponse('   '));

    expect(await requestToolSummaryTranslations(INPUT)).toEqual([null]);
  });

  it('aborts on the 15s timeout and returns one null per text', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })
    );

    const pending = requestToolSummaryTranslations(INPUT);
    await vi.advanceTimersByTimeAsync(TOOL_SUMMARY_TRANSLATION_TIMEOUT_MS);

    expect(await pending).toEqual([null]);
  });

  it('scales the abort timeout with the batch size', async () => {
    vi.useFakeTimers();
    let aborted = false;
    fetchMock.mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })
    );

    const pending = requestToolSummaryTranslations({ ...INPUT, texts: ['a', 'b', 'c'] });
    const scaled = TOOL_SUMMARY_TRANSLATION_TIMEOUT_MS + 2000 * 2;
    await vi.advanceTimersByTimeAsync(scaled - 1);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual([null, null, null]);
  });

  it('caps the scaled abort timeout at 60s', async () => {
    vi.useFakeTimers();
    let aborted = false;
    fetchMock.mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })
    );

    const texts = Array.from({ length: 40 }, (_unused, index) => `text ${index}`);
    const pending = requestToolSummaryTranslations({ ...INPUT, texts });
    // 15s + 2s per extra text would be 93s; the deadline is capped at 60s.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual(texts.map(() => null));
  });
});
