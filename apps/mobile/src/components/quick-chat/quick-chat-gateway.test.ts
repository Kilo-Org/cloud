import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  beginAuthenticatedOwner,
  confirmAuthenticatedOwner,
  getAuthenticatedOwner,
} from '@/lib/context-scope';
import {
  initializeLocalAccess,
  setLocalAccessContextReady,
  setLocalAccessOwner,
} from '@/lib/local-access';
import {
  captureMobileActionAdmission,
  type MobileActionAdmission,
} from '@/lib/local-access-transport';

import {
  parseSseDataLine,
  type QuickChatCompletionInput,
  streamQuickChatCompletion,
} from './quick-chat-gateway';

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://gateway.test' }));

const fetchMock = vi.hoisted(() => vi.fn());

let admission: MobileActionAdmission | undefined = undefined;
let stopAccess: (() => void) | undefined = undefined;
beforeEach(async () => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'A');
  stopAccess = initializeLocalAccess({
    storage: {
      read: vi.fn().mockResolvedValue({ status: 'absent' }),
      write: vi.fn().mockResolvedValue('committed'),
    },
    authenticate: vi.fn().mockResolvedValue({ status: 'authenticated' }),
    lifecycle: { getCurrentState: () => 'active', subscribe: () => () => undefined },
  });
  await setLocalAccessOwner('A', currentAuthEpoch());
  setLocalAccessContextReady(true);
  admission = captureMobileActionAdmission(getAuthenticatedOwner(), 'org-1');
});

afterEach(() => {
  stopAccess?.();
  vi.unstubAllGlobals();
});

/** A ReadableStream that enqueues the given chunks then closes. */
function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

const baseInput: QuickChatCompletionInput = {
  model: 'test-model',
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ],
  organizationId: 'org-1',
  authToken: 'token-1',
  get admission() {
    if (!admission) {
      throw new Error('Missing test admission');
    }
    return admission;
  },
  turnId: 'turn-1',
  onDispatch: () => undefined,
};

async function collect(generator: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const value of generator) {
    out.push(value);
  }
  return out;
}

describe('parseSseDataLine', () => {
  it('extracts the content delta from a data line', () => {
    expect(parseSseDataLine('data: {"choices":[{"delta":{"content":"Hi"}}]}')).toEqual({
      content: 'Hi',
      done: false,
    });
  });

  it('returns a null content for an empty delta', () => {
    expect(parseSseDataLine('data: {"choices":[{"delta":{}}]}').content).toBeNull();
  });

  it('marks [DONE] as the terminal event', () => {
    expect(parseSseDataLine('data: [DONE]')).toEqual({ content: null, done: true });
  });

  it('ignores non-data lines and malformed JSON', () => {
    expect(parseSseDataLine(': keep-alive').content).toBeNull();
    expect(parseSseDataLine('data: not-json').content).toBeNull();
  });
});

describe('streamQuickChatCompletion', () => {
  it('concatenates content deltas across SSE chunks and stops at [DONE]', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: chunkedStream([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n',
      ]),
    });

    const out = await collect(streamQuickChatCompletion(baseInput));

    expect(out).toEqual(['Hel', 'lo', ' world']);
  });

  it('sends the feature header and no tools field', async () => {
    fetchMock.mockResolvedValue({ ok: true, body: chunkedStream(['data: [DONE]\n\n']) });

    await collect(streamQuickChatCompletion(baseInput));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.test/api/gateway/chat/completions');

    const headers = init.headers as Record<string, string>;
    const headerNames = Object.keys(headers);
    const featureKey = headerNames.find(key => key.toLowerCase() === 'x-kilocode-feature');
    expect(featureKey).toBeDefined();
    expect(featureKey ? headers[featureKey] : undefined).toBe('quick-chat');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(body.stream).toBe(true);
    expect(body.model).toBe('test-model');
    expect(body.messages).toEqual(baseInput.messages);
  });

  it('omits the organization header when organizationId is absent', async () => {
    fetchMock.mockResolvedValue({ ok: true, body: chunkedStream(['data: [DONE]\n\n']) });

    await collect(
      streamQuickChatCompletion({
        ...baseInput,
        organizationId: null,
        admission: captureMobileActionAdmission(getAuthenticatedOwner(), null),
      })
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const hasOrgHeader = Object.keys(headers).some(
      key => key.toLowerCase() === 'x-kilocode-organizationid'
    );
    expect(hasOrgHeader).toBe(false);
  });

  it('stops reading when the signal aborts', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: chunkedStream([
        'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"second"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    });

    const controller = new AbortController();
    const generator = streamQuickChatCompletion({ ...baseInput, signal: controller.signal });

    const first = await generator.next();
    expect(first.done).toBe(false);
    expect(first.value).toBe('first');

    controller.abort();

    const afterAbort = await generator.next();
    expect(afterAbort.done).toBe(true);
  });

  it('throws when the gateway responds with a non-OK status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await expect(collect(streamQuickChatCompletion(baseInput))).rejects.toThrow(
      'Gateway request failed with status 500'
    );
  });
});
