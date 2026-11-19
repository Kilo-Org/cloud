import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PREVIEW_TUNNEL_DATA_MAX_BYTES,
  PREVIEW_TUNNEL_WINDOW_BYTES,
  type PreviewTunnelFrame,
} from '../shared/preview-tunnel-protocol.js';
import { HttpTunnelStream } from './http-stream.js';
import type { TunnelPort } from './tunnel-state.js';
import { StreamSlots } from './stream-slots.js';

afterEach(() => {
  vi.useRealTimers();
});

function fakePort() {
  const sent: PreviewTunnelFrame[] = [];
  const finished: number[] = [];
  const port: TunnelPort = {
    send: frame => {
      sent.push(frame);
      return true;
    },
    finish: id => finished.push(id),
    forget: () => undefined,
  };
  return { port, sent, finished };
}

const chunk = new Uint8Array(PREVIEW_TUNNEL_DATA_MAX_BYTES);
const head = (status: number, headers: [string, string][] = []): PreviewTunnelFrame => ({
  type: 'head',
  stream: 1,
  head: { status, headers },
});

describe('HttpTunnelStream', () => {
  it('treats response data over the credit as a violation while the browser does not read', async () => {
    const { port } = fakePort();
    const stream = new HttpTunnelStream(1, port, 'GET');
    expect(stream.onFrame(head(200))).toBeNull();
    const result = await stream.headResult();
    expect(result.ok).toBe(true);
    const windowChunks = PREVIEW_TUNNEL_WINDOW_BYTES / PREVIEW_TUNNEL_DATA_MAX_BYTES;
    for (let index = 0; index < windowChunks; index += 1) {
      expect(stream.onFrame({ type: 'data', stream: 1, bytes: chunk })).toBeNull();
    }
    expect(stream.onFrame({ type: 'data', stream: 1, bytes: new Uint8Array(1) })).toBe(
      'Preview tunnel data is over the credit'
    );
  });

  it('returns credit as the browser reads and keeps the slot until the body drains', async () => {
    const { port, sent, finished } = fakePort();
    const release = vi.fn();
    const stream = new HttpTunnelStream(1, port, 'GET');
    stream.adoptSlot(release);
    stream.onFrame(head(200));
    stream.onFrame({ type: 'data', stream: 1, bytes: new Uint8Array([1, 2, 3]) });
    const result = await stream.headResult();
    if (!result.ok) throw new Error('expected a response');
    const reader = result.response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
    expect(sent).toContainEqual({ type: 'credit', stream: 1, bytes: 3 });
    expect(release).not.toHaveBeenCalled();
    stream.onFrame({ type: 'end', stream: 1 });
    expect((await reader.read()).done).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(finished).toEqual([1]);
  });

  it.each(['disconnect', 'reset'] as const)(
    'keeps completed response slots through %s until the browser drains or cancels',
    async failure => {
      const slots = new StreamSlots(() => ({ capacity: 2, maxWaiters: 0, waitMs: 1 }));
      const responses: Response[] = [];
      for (let id = 1; id <= 2; id += 1) {
        expect(await slots.acquire()).toBe(true);
        const stream = new HttpTunnelStream(id, fakePort().port, 'GET');
        stream.adoptSlot(() => slots.release());
        stream.onFrame(head(200));
        for (let bytes = 0; bytes < PREVIEW_TUNNEL_WINDOW_BYTES; bytes += chunk.length) {
          stream.onFrame({ type: 'data', stream: id, bytes: chunk });
        }
        stream.onFrame({ type: 'end', stream: id });
        const result = await stream.headResult();
        if (!result.ok) throw new Error('Expected a complete response');
        responses.push(result.response);
        if (failure === 'disconnect') stream.fail();
        else stream.onFrame({ type: 'reset', stream: id, code: 'cancelled' });
      }
      expect(slots.inUse).toBe(2);
      expect(await slots.acquire()).toBe(false);
      expect((await responses[0].arrayBuffer()).byteLength).toBe(PREVIEW_TUNNEL_WINDOW_BYTES);
      expect(await slots.acquire()).toBe(true);
      await responses[1].body?.cancel();
      expect(slots.inUse).toBe(1);
      slots.release();
    }
  );

  it('treats request credit over the window as a violation', () => {
    const { port } = fakePort();
    const stream = new HttpTunnelStream(1, port, 'POST');
    expect(stream.onFrame({ type: 'credit', stream: 1, bytes: 0 })).toBeNull();
    expect(stream.onFrame({ type: 'credit', stream: 1, bytes: 1 })).toBe(
      'Preview tunnel credit is over the window'
    );
  });

  it('fails only the stream when a header cannot be sent', async () => {
    const { port, sent, finished } = fakePort();
    const stream = new HttpTunnelStream(1, port, 'GET');
    expect(stream.onFrame(head(200, [['bad header', 'x']]))).toBeNull();
    expect(await stream.headResult()).toEqual({ ok: false, failure: 'bad_response' });
    expect(sent).toContainEqual({ type: 'reset', stream: 1, code: 'bad_response' });
    expect(finished).toEqual([1]);
  });

  it('answers a no-body status without a body and finishes on the end', async () => {
    const { port, finished } = fakePort();
    const release = vi.fn();
    const stream = new HttpTunnelStream(1, port, 'GET');
    stream.adoptSlot(release);
    stream.onFrame(head(304));
    const result = await stream.headResult();
    expect(result.ok && result.response.body).toBeNull();
    expect(stream.onFrame({ type: 'data', stream: 1, bytes: chunk })).toBe(
      'Preview tunnel data has no open body'
    );
    expect(stream.onFrame({ type: 'end', stream: 1 })).toBeNull();
    expect(release).toHaveBeenCalledTimes(1);
    expect(finished).toEqual([1]);
  });

  it('cancels the request and answers timeout when no head comes before the backstop', async () => {
    vi.useFakeTimers();
    const { port, sent } = fakePort();
    const stream = new HttpTunnelStream(1, port, 'GET');
    stream.startHeadBackstop(1_000);
    vi.advanceTimersByTime(1_000);
    expect(await stream.headResult()).toEqual({ ok: false, failure: 'timeout' });
    expect(sent).toContainEqual({ type: 'reset', stream: 1, code: 'cancelled' });
  });

  it('errors the body when the tunnel closes after the head', async () => {
    const { port } = fakePort();
    const stream = new HttpTunnelStream(1, port, 'GET');
    stream.onFrame(head(200));
    const result = await stream.headResult();
    if (!result.ok) throw new Error('expected a response');
    stream.fail();
    await expect(result.response.arrayBuffer()).rejects.toThrow('Preview stream closed');
  });

  it('releases an adopted slot at once when the stream already ended', () => {
    const { port } = fakePort();
    const stream = new HttpTunnelStream(1, port, 'GET');
    stream.onFrame({ type: 'reset', stream: 1, code: 'not_listening' });
    const release = vi.fn();
    stream.adoptSlot(release);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
