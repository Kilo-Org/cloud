import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewTunnelFrame } from '../shared/preview-tunnel-protocol.js';
import type { TunnelPort } from './tunnel-state.js';
import { WebSocketTunnelStream } from './websocket-stream.js';

afterEach(() => {
  vi.useRealTimers();
});

const ID = 0x8000_0001;

function setup(offered: string[] = ['vite-hmr']) {
  const sent: PreviewTunnelFrame[] = [];
  const finished: number[] = [];
  const forgotten: number[] = [];
  const port: TunnelPort = {
    send: frame => {
      sent.push(frame);
      return true;
    },
    finish: id => finished.push(id),
    forget: id => forgotten.push(id),
  };
  const accepted: string[] = [];
  const stream = new WebSocketTunnelStream(ID, port, {
    offered,
    accept: protocol => {
      accepted.push(protocol);
      return new Response(null, { status: 204 });
    },
  });
  return { stream, sent, finished, forgotten, accepted };
}

describe('WebSocketTunnelStream', () => {
  it('accepts an offered protocol and leaves the id to the browser socket', async () => {
    const { stream, finished, forgotten, accepted } = setup();
    expect(stream.onFrame({ type: 'credit', stream: ID, bytes: 0 })).toBeNull();
    expect(stream.onFrame({ type: 'ws_accept', stream: ID, protocol: 'vite-hmr' })).toBeNull();
    expect((await stream.opened()).ok).toBe(true);
    expect(accepted).toEqual(['vite-hmr']);
    expect(forgotten).toEqual([ID]);
    expect(finished).toEqual([]);
  });

  it('refuses a protocol that the browser did not offer', async () => {
    const { stream, sent, finished, accepted } = setup();
    stream.onFrame({ type: 'ws_accept', stream: ID, protocol: 'other' });
    expect(await stream.opened()).toEqual({ ok: false, failure: 'bad_response' });
    expect(sent).toContainEqual({ type: 'reset', stream: ID, code: 'cancelled' });
    expect(accepted).toEqual([]);
    expect(finished).toEqual([ID]);
  });

  it('treats a message before the accept as a violation', () => {
    const { stream } = setup();
    expect(stream.onFrame({ type: 'ws_text', stream: ID, text: 'early' })).toBe(
      'Preview tunnel frame came before the WebSocket accept'
    );
  });

  it('maps a reset before the accept to its failure', async () => {
    const { stream } = setup();
    stream.onFrame({ type: 'reset', stream: ID, code: 'not_listening' });
    expect(await stream.opened()).toEqual({ ok: false, failure: 'not_listening' });
  });

  it('cancels and answers timeout when no accept comes before the backstop', async () => {
    vi.useFakeTimers();
    const { stream, sent } = setup();
    stream.startAcceptBackstop(1_000);
    vi.advanceTimersByTime(1_000);
    expect(await stream.opened()).toEqual({ ok: false, failure: 'timeout' });
    expect(sent).toContainEqual({ type: 'reset', stream: ID, code: 'cancelled' });
  });
});
