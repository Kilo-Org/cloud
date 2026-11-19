import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_STREAM_IDLE_PING_INTERVAL_MS,
  withEventStreamIdlePing,
} from './event-stream-idle-ping.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function heldUpstream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel,
  });
  return {
    body,
    cancel,
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    controller,
  };
}

/** Reads one chunk if it arrives within `ms` of fake time; `undefined` when nothing arrived. */
async function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pending: { read?: Promise<ReadableStreamReadResult<Uint8Array>> },
  ms: number
): Promise<string | undefined> {
  let settled: ReadableStreamReadResult<Uint8Array> | undefined;
  pending.read ??= reader.read();
  void pending.read.then(result => {
    settled = result;
  });
  await vi.advanceTimersByTimeAsync(ms);
  if (!settled) return undefined;
  pending.read = undefined;
  return settled.done ? 'done' : decoder.decode(settled.value);
}

describe('withEventStreamIdlePing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a comment while the upstream is silent, and a gone client cancels the upstream', async () => {
    const upstream = heldUpstream();
    const reader = withEventStreamIdlePing(upstream.body).getReader();
    const pending = {};

    expect(
      await readWithin(reader, pending, EVENT_STREAM_IDLE_PING_INTERVAL_MS - 1)
    ).toBeUndefined();
    expect(await readWithin(reader, pending, 1)).toBe(': ping\n\n');

    await reader.cancel('client closed');
    expect(upstream.cancel).toHaveBeenCalledWith('client closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never writes inside an open event and stays quiet while data flows', async () => {
    const upstream = heldUpstream();
    const reader = withEventStreamIdlePing(upstream.body).getReader();
    const pending = {};

    upstream.send('data: {"choices":');
    expect(await readWithin(reader, pending, 0)).toBe('data: {"choices":');
    expect(
      await readWithin(reader, pending, EVENT_STREAM_IDLE_PING_INTERVAL_MS * 3)
    ).toBeUndefined();

    upstream.send('[]}\n');
    expect(await readWithin(reader, pending, 0)).toBe('[]}\n');
    upstream.send('\n');
    expect(await readWithin(reader, pending, 0)).toBe('\n');
    upstream.send('data: {}\r\n\r\n');
    expect(await readWithin(reader, pending, EVENT_STREAM_IDLE_PING_INTERVAL_MS)).toBe(
      'data: {}\r\n\r\n'
    );
    expect(await readWithin(reader, pending, EVENT_STREAM_IDLE_PING_INTERVAL_MS)).toBe(
      ': ping\n\n'
    );
  });

  it('passes the upstream end and error through and stops its timer', async () => {
    const ended = heldUpstream();
    const endedReader = withEventStreamIdlePing(ended.body).getReader();
    ended.send('data: [DONE]\n\n');
    ended.controller.close();
    expect(decoder.decode((await endedReader.read()).value)).toBe('data: [DONE]\n\n');
    expect((await endedReader.read()).done).toBe(true);

    const failed = heldUpstream();
    const failedReader = withEventStreamIdlePing(failed.body).getReader();
    failed.controller.error(new Error('upstream reset'));
    await expect(failedReader.read()).rejects.toThrow('upstream reset');
    expect(vi.getTimerCount()).toBe(0);
  });
});
