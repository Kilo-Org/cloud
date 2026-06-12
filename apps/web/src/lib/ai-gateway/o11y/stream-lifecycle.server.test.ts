import { createHash } from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';
import {
  createStreamLifecycleTracker,
  isEventStreamContentType,
  observeEventStream,
  shouldObserveEventStream,
  type StreamOutcome,
} from './stream-lifecycle.server';

const encoder = new TextEncoder();

function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function observe(chunks: string[]) {
  const outcomes: StreamOutcome[] = [];
  const body = observeEventStream(stream(chunks), outcome => outcomes.push(outcome));
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  return { text: new TextDecoder().decode(bytes), outcome: outcomes[0] };
}

function outcome(overrides: Partial<StreamOutcome> = {}): StreamOutcome {
  return {
    bytes: 20,
    chunks: 2,
    sha256: 'abc',
    events: 2,
    malformed_events: 0,
    last_event_type: '[DONE]',
    terminal_event: true,
    unterminated_final_block: false,
    disposition: 'eof',
    ...overrides,
  };
}

describe('event stream lifecycle observation', () => {
  it('does not lock the source until the observed stream is first pulled', async () => {
    const source = stream(['data: [DONE]\n\n']);
    const body = observeEventStream(source, jest.fn());

    expect(source.locked).toBe(false);

    const reader = body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(source.locked).toBe(true);

    await reader.read();
    expect(source.locked).toBe(false);
  });

  it('preserves exact bytes and detects split terminal events with common delimiters', async () => {
    const input = [
      'event: response.completed\r',
      '\ndata: {"type":"response.completed"}\r\n\r',
      '\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DO',
      'NE]\r\r',
    ];
    const result = await observe(input);

    expect(result.text).toBe(input.join(''));
    expect(result.outcome).toMatchObject({
      bytes: encoder.encode(input.join('')).byteLength,
      chunks: input.length,
      events: 3,
      terminal_event: true,
      last_event_type: '[DONE]',
      unterminated_final_block: false,
      disposition: 'eof',
    });
    expect(result.outcome?.sha256).toBe(
      createHash('sha256')
        .update(encoder.encode(input.join('')))
        .digest('hex')
    );
  });

  it.each([
    ['response incomplete', 'data: {"type":"response.incomplete"}\n\n'],
    ['response failed', 'data: {"type":"response.failed"}\n\n'],
    ['message stop', 'data: {"type":"message_stop"}\n\n'],
    ['chat finish reason', 'data: {"choices":[{"finish_reason":"length"}]}\n\n'],
  ])('recognizes %s terminal events', async (_name, input) => {
    const result = await observe([input]);
    expect(result.outcome?.terminal_event).toBe(true);
  });

  it('records malformed events and an unterminated final block without retaining the payload', async () => {
    const result = await observe(['data: not-json\n\ndata: {"type":"partial"}']);

    expect(result.outcome).toMatchObject({
      events: 1,
      malformed_events: 1,
      terminal_event: false,
      unterminated_final_block: true,
      disposition: 'eof',
    });
  });

  it('bounds oversized events and resumes scanning after a split CRLF delimiter', async () => {
    const input = [`data: ${'x'.repeat(70_000)}\r`, '\n\r', '\ndata: [DONE]\r\n\r\n'];
    const result = await observe(input);

    expect(result.text).toBe(input.join(''));
    expect(result.outcome).toMatchObject({
      events: 2,
      malformed_events: 1,
      last_event_type: '[DONE]',
      terminal_event: true,
      unterminated_final_block: false,
    });
  });

  it.each([
    ['LF then CRLF', ['data: {"type":"partial"}\n\r', '\ndata: [DONE]\n\n']],
    ['CRLF then LF', ['data: {"type":"partial"}\r\n', '\ndata: [DONE]\n\n']],
    ['CR then CRLF', ['data: {"type":"partial"}\r', '\r\ndata: [DONE]\n\n']],
    ['LF then CR', ['data: {"type":"partial"}\n', '\rdata: [DONE]\n\n']],
  ])('parses mixed %s blank-line delimiters across chunks', async (_name, input) => {
    const result = await observe(input);
    expect(result.outcome).toMatchObject({
      events: 2,
      last_event_type: '[DONE]',
      terminal_event: true,
      unterminated_final_block: false,
    });
  });

  it('records cancellation and propagates it to the source', async () => {
    const cancel = jest.fn<(reason?: unknown) => void>();
    const outcomes: StreamOutcome[] = [];
    const source = new ReadableStream<Uint8Array>({ cancel });
    const reader = observeEventStream(source, value => outcomes.push(value)).getReader();

    await reader.cancel('stop');

    expect(cancel).toHaveBeenCalledWith('stop');
    expect(outcomes[0]?.disposition).toBe('cancel');
  });

  it('records source errors and preserves the error', async () => {
    const failure = new Error('stream failed');
    const outcomes: StreamOutcome[] = [];
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(failure);
      },
    });
    const reader = observeEventStream(source, value => outcomes.push(value)).getReader();

    await expect(reader.read()).rejects.toBe(failure);
    expect(outcomes[0]?.disposition).toBe('error');
  });

  it('reports a throwing EOF callback without altering byte delivery or cleanup', async () => {
    const report = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const source = stream(['data: [DONE]\n\n']);
    const body = observeEventStream(source, () => {
      throw new Error('callback failed');
    });

    await expect(new Response(body).text()).resolves.toBe('data: [DONE]\n\n');
    expect(source.locked).toBe(false);
    expect(report).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'ai_stream_lifecycle_observer_failure',
        error_type: 'Error',
      })
    );
    report.mockRestore();
  });

  it('reports a throwing cancellation callback without blocking source cancellation', async () => {
    const report = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const cancel = jest.fn<(reason?: unknown) => void>();
    const source = new ReadableStream<Uint8Array>({ cancel });
    const reader = observeEventStream(source, () => {
      throw new Error('callback failed');
    }).getReader();

    await expect(reader.cancel('stop')).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledWith('stop');
    expect(source.locked).toBe(false);
    expect(report).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'ai_stream_lifecycle_observer_failure',
        error_type: 'Error',
      })
    );
    report.mockRestore();
  });

  it('does not close an already cancelled stream when a pending pull settles', async () => {
    const cancel = jest.fn<(reason?: unknown) => void>();
    const outcomes: StreamOutcome[] = [];
    const source = new ReadableStream<Uint8Array>({ cancel });
    const reader = observeEventStream(source, outcome => outcomes.push(outcome)).getReader();
    const pending = reader.read();

    await Promise.resolve();
    await reader.cancel('stop');

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(cancel).toHaveBeenCalledWith('stop');
    expect(source.locked).toBe(false);
    expect(outcomes).toEqual([expect.objectContaining({ disposition: 'cancel' })]);
  });
});

describe('event stream content type', () => {
  it.each([
    'text/event-stream',
    'Text/Event-Stream',
    'TEXT/EVENT-STREAM; charset=utf-8',
    ' text/event-stream ; charset=UTF-8',
  ])('accepts %s', contentType => {
    expect(isEventStreamContentType(contentType)).toBe(true);
  });

  it.each([null, '', 'application/json', 'application/text/event-stream'])(
    'rejects %s',
    contentType => {
      expect(isEventStreamContentType(contentType)).toBe(false);
    }
  );
});

describe('event stream observation scope', () => {
  it('observes successful direct-provider event streams', () => {
    expect(
      shouldObserveEventStream({
        provider_id: 'custom',
        status: 200,
        has_body: true,
        content_type: 'Text/Event-Stream; charset=utf-8',
      })
    ).toBe(true);
  });

  it.each([
    ['non-custom provider', { provider_id: 'openrouter' }],
    ['unsuccessful response', { status: 500 }],
    ['bodyless response', { has_body: false }],
    ['non-event response', { content_type: 'application/json' }],
  ])('does not observe %s', (_name, override) => {
    expect(
      shouldObserveEventStream({
        provider_id: 'custom',
        status: 200,
        has_body: true,
        content_type: 'text/event-stream',
        ...override,
      })
    ).toBe(false);
  });
});

describe('stream lifecycle correlation logging', () => {
  const context = {
    attempt_id: 'attempt',
    provider_id: 'provider',
    api_kind: 'responses',
  };

  it('emits machine-readable structural records by default', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tracker = createStreamLifecycleTracker(context);

    tracker.observe('provider', outcome());
    tracker.observe('final', outcome({ terminal_event: false }));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual(
      expect.objectContaining({
        event: 'ai_stream_lifecycle',
        attempt_id: 'attempt',
        provider_id: 'provider',
        api_kind: 'responses',
        classification: 'divergence',
      })
    );
    warn.mockRestore();
  });

  it('always logs confirmed divergence with structural outcomes', () => {
    const log = jest.fn();
    const tracker = createStreamLifecycleTracker(context, { random: () => 1, log });

    tracker.observe('provider', outcome());
    tracker.observe('final', outcome({ terminal_event: false }));

    expect(log).toHaveBeenCalledWith(
      'AI stream lifecycle anomaly',
      expect.objectContaining({
        attempt_id: 'attempt',
        classification: 'divergence',
        provider: expect.objectContaining({ disposition: 'eof' }),
        final: expect.objectContaining({ terminal_event: false }),
      })
    );
  });

  it.each([
    ['missing terminal event', { terminal_event: false }],
    ['unterminated final block', { unterminated_final_block: true }],
    ['malformed framing', { malformed_events: 1 }],
  ])('always logs source incomplete for provider EOF with %s', (_name, overrides) => {
    const log = jest.fn();
    const tracker = createStreamLifecycleTracker(context, { random: () => 1, log });
    const incomplete = outcome(overrides);

    tracker.observe('provider', incomplete);
    tracker.observe('final', incomplete);

    expect(log).toHaveBeenCalledWith(
      'AI stream lifecycle anomaly',
      expect.objectContaining({ classification: 'source_incomplete' })
    );
  });

  it('always logs branch errors', () => {
    const log = jest.fn();
    const tracker = createStreamLifecycleTracker(context, { random: () => 1, log });

    tracker.observe('provider', outcome({ disposition: 'error' }));
    tracker.observe('final', outcome());

    expect(log).toHaveBeenCalledWith(
      'AI stream lifecycle anomaly',
      expect.objectContaining({ classification: 'error' })
    );
  });

  it('always logs final cancellation after a complete provider stream', () => {
    const log = jest.fn();
    const tracker = createStreamLifecycleTracker(context, { random: () => 1, log });

    tracker.observe('provider', outcome());
    tracker.observe('final', outcome({ disposition: 'cancel' }));

    expect(log).toHaveBeenCalledWith(
      'AI stream lifecycle anomaly',
      expect.objectContaining({ classification: 'final_cancelled' })
    );
  });

  it('keeps provider cancellation sampled as inconclusive', () => {
    const log = jest.fn();
    const tracker = createStreamLifecycleTracker(context, { random: () => 1, log });

    tracker.observe('provider', outcome({ disposition: 'cancel' }));
    tracker.observe('final', outcome({ disposition: 'cancel' }));

    expect(log).not.toHaveBeenCalled();
  });

  it('samples provider cancellation and other inconclusive pairs at 0.01%', () => {
    const sampled = jest.fn();
    const skipped = jest.fn();
    const included = createStreamLifecycleTracker(context, { random: () => 0.00009, log: sampled });
    const excluded = createStreamLifecycleTracker(context, { random: () => 0.0001, log: skipped });

    for (const tracker of [included, excluded]) {
      tracker.observe('provider', outcome({ disposition: 'cancel' }));
      tracker.observe('final', outcome({ disposition: 'cancel' }));
    }

    expect(sampled).toHaveBeenCalledWith(
      'AI stream lifecycle inconclusive',
      expect.objectContaining({ classification: 'inconclusive' })
    );
    expect(skipped).not.toHaveBeenCalled();
  });

  it('samples complete matching pairs as controls', () => {
    const sampled = jest.fn();
    const skipped = jest.fn();
    const included = createStreamLifecycleTracker(context, { random: () => 0.0009, log: sampled });
    const excluded = createStreamLifecycleTracker(context, { random: () => 0.001, log: skipped });

    for (const tracker of [included, excluded]) {
      tracker.observe('provider', outcome());
      tracker.observe('final', outcome());
    }

    expect(sampled).toHaveBeenCalledWith('AI stream lifecycle control', expect.any(Object));
    expect(skipped).not.toHaveBeenCalled();
  });

  it('emits at most one paired record', () => {
    const log = jest.fn();
    const tracker = createStreamLifecycleTracker(context, { random: () => 0, log });

    tracker.observe('provider', outcome());
    tracker.observe('final', outcome());
    tracker.observe('final', outcome({ sha256: 'different' }));
    tracker.observe('provider', outcome({ disposition: 'error' }));

    expect(log).toHaveBeenCalledTimes(1);
  });
});
