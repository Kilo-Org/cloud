import type { Span } from '@sentry/nextjs';
import {
  drainSseStream,
  readResponseText,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.shared';

const span = { end: () => {} } as Span;

let now = 0;

/**
 * A body whose chunks arrive at the given `performance.now()` times. With a
 * high-water mark of 0 a chunk is only produced once the reader asks for it, so
 * the clock reads the chunk's time while the reader processes it.
 */
function bodyArrivingAt(chunks: [at: number, text: string][]) {
  const encoder = new TextEncoder();
  const queue = [...chunks];
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = queue.shift();
        if (!next) {
          controller.close();
          return;
        }
        now = next[0];
        controller.enqueue(encoder.encode(next[1]));
      },
    },
    { highWaterMark: 0 }
  );
}

beforeEach(() => {
  now = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('drainSseStream', () => {
  test('times SSE events and ignores keep-alive comments', async () => {
    const events: string[] = [];

    const result = await drainSseStream(
      bodyArrivingAt([
        [100, ': OPENROUTER PROCESSING\n\n'],
        [250, 'data: {"choices":[{"delta":{"content":"Hel'],
        [300, 'lo"}}]}\n\n'],
        [800, 'data: {"choices":[],"usage":{}}\n\n'],
        [900, 'data: [DONE]\n\n'],
      ]),
      event => events.push(event.data),
      span,
      20
    );

    expect(events).toEqual([
      '{"choices":[{"delta":{"content":"Hello"}}]}',
      '{"choices":[],"usage":{}}',
      '[DONE]',
    ]);
    expect(result).toEqual({
      wasAborted: false,
      timing: { latency: 280, generation_time: 600 },
    });
  });

  test('times a body without SSE events by its chunks', async () => {
    const result = await drainSseStream(
      bodyArrivingAt([
        [100, '\n'],
        [400, '{"error":{"code":502,'],
        [450, '"message":"Bad gateway"}}'],
      ]),
      () => {},
      span,
      0
    );

    expect(result.timing).toEqual({ latency: 400, generation_time: 50 });
  });

  test('reports no latency without a request start', async () => {
    const result = await drainSseStream(
      bodyArrivingAt([
        [100, 'data: {}\n\n'],
        [150, 'data: [DONE]\n\n'],
      ]),
      () => {},
      span,
      undefined
    );

    expect(result.timing).toEqual({ latency: null, generation_time: 50 });
  });
});

describe('readResponseText', () => {
  test('times a JSON body from its first non-whitespace chunk', async () => {
    const result = await readResponseText(
      bodyArrivingAt([
        [100, '\n \n'],
        [400, '{"id":"gen-1",'],
        [450, '"model":"m"}'],
      ]),
      0
    );

    expect(result).toEqual({
      text: '\n \n{"id":"gen-1","model":"m"}',
      timing: { latency: 400, generation_time: 50 },
    });
  });

  test('reports no timing for an empty body', async () => {
    const result = await readResponseText(bodyArrivingAt([]), 0);

    expect(result).toEqual({ text: '', timing: { latency: null, generation_time: null } });
  });

  test('rejects with the body error', async () => {
    const error = new Error('Response interrupted');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(error);
      },
    });

    await expect(readResponseText(body, 0)).rejects.toBe(error);
  });
});
