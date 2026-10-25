import { timeResponseBody } from '@kilocode/web-shared/lib/ai-gateway/processUsage.shared';

const encoder = new TextEncoder();

function createTimedBody(isStreaming: boolean) {
  let now = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  const source = new TransformStream<Uint8Array, Uint8Array>();
  const writer = source.writable.getWriter();
  const timed = timeResponseBody(source.readable, isStreaming);
  const reader = timed.body.getReader();
  const decoder = new TextDecoder();
  let received = '';

  return {
    timing: timed.timing,
    async deliver(at: number, text: string) {
      now = at;
      void writer.write(encoder.encode(text));
      const { value } = await reader.read();
      received += decoder.decode(value);
    },
    async finish() {
      void writer.close();
      expect((await reader.read()).done).toBe(true);
      return received;
    },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('timeResponseBody', () => {
  test('measures streamed responses from the first SSE event, ignoring keep-alive comments', async () => {
    const body = createTimedBody(true);

    await body.deliver(100, ': OPENROUTER PROCESSING\n\n');
    await body.deliver(250, 'data: {"choices":[{"delta":{"content":"Hel');
    await body.deliver(300, 'lo"}}]}\n\n');
    await body.deliver(800, 'data: {"choices":[],"usage":{}}\n\n');
    await body.deliver(900, 'data: [DONE]\n\n');

    expect(await body.finish()).toBe(
      ': OPENROUTER PROCESSING\n\n' +
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
        'data: {"choices":[],"usage":{}}\n\n' +
        'data: [DONE]\n\n'
    );
    expect(body.timing(20)).toEqual({ latency: 280, generation_time: 600 });
  });

  test('measures JSON responses from the first non-whitespace chunk', async () => {
    const body = createTimedBody(false);

    await body.deliver(100, '\n \n');
    await body.deliver(400, '{"id":"gen-1",');
    await body.deliver(450, '"model":"m"}');

    expect(await body.finish()).toBe('\n \n{"id":"gen-1","model":"m"}');
    expect(body.timing(0)).toEqual({ latency: 400, generation_time: 50 });
  });

  test('reports no latency without a request start', async () => {
    const body = createTimedBody(true);

    await body.deliver(100, 'data: {}\n\n');
    await body.deliver(150, 'data: [DONE]\n\n');
    await body.finish();

    expect(body.timing(undefined)).toEqual({ latency: null, generation_time: 50 });
  });

  test('reports no timing when no chunk arrived', async () => {
    const body = createTimedBody(true);

    await body.deliver(100, ': OPENROUTER PROCESSING\n\n');
    await body.finish();

    expect(body.timing(0)).toEqual({ latency: null, generation_time: null });
  });
});
