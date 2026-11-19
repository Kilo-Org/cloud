import { describe, expect, it } from 'vitest';
import {
  PREVIEW_TUNNEL_DATA_MAX_BYTES,
  PREVIEW_TUNNEL_JSON_MAX_BYTES,
  PREVIEW_TUNNEL_WS_MESSAGE_MAX_BYTES,
  PreviewTunnelFrameTooLargeError,
  decodeWorkerTunnelFrame,
  decodeWrapperTunnelFrame,
  encodePreviewTunnelFrame,
  parsePreviewTunnelName,
  previewResponseHasNoBody,
  previewTunnelName,
  previewTunnelUrl,
  type PreviewTunnelFrame,
} from './preview-tunnel-protocol.js';

function raw(type: number, stream: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(5 + payload.byteLength);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, stream);
  out.set(payload, 5);
  return out;
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function violation(result: ReturnType<typeof decodeWrapperTunnelFrame>): number | null {
  return result.ok ? null : result.violation.code;
}

describe('preview tunnel frame codec', () => {
  const wrapperFrames: PreviewTunnelFrame[] = [
    { type: 'head', stream: 1, head: { status: 200, headers: [['a', 'b']] } },
    { type: 'data', stream: 2, bytes: new Uint8Array([1, 2, 3]) },
    { type: 'end', stream: 3 },
    { type: 'reset', stream: 4, code: 'not_listening' },
    { type: 'credit', stream: 5, bytes: 65_536 },
    { type: 'ws_accept', stream: 0x8000_0001, protocol: 'vite-hmr' },
    { type: 'ws_text', stream: 0x8000_0002, text: 'héllo' },
    { type: 'ws_binary', stream: 0x8000_0003, bytes: new Uint8Array([9]) },
    { type: 'ws_close', stream: 0xffff_ffff, code: 4000, reason: 'app closed' },
  ];

  it.each(wrapperFrames)('round-trips a $type frame from the wrapper', frame => {
    expect(decodeWrapperTunnelFrame(encodePreviewTunnelFrame(frame))).toEqual({ ok: true, frame });
  });

  const workerFrames: PreviewTunnelFrame[] = [
    {
      type: 'open',
      stream: 1,
      open: { port: 5173, method: 'GET', path: '/a?b', headers: [['x', 'y']] },
    },
    {
      type: 'ws_open',
      stream: 0x8000_0000,
      open: { port: 5173, path: '/hmr', headers: [], protocols: ['vite-hmr'] },
    },
  ];

  it.each(workerFrames)('round-trips a $type frame from the Worker', frame => {
    const bytes = encodePreviewTunnelFrame(frame);
    expect(decodeWorkerTunnelFrame(bytes)).toEqual({ ok: true, frame });
  });

  it('decodes a frame inside a larger buffer', () => {
    const frame = encodePreviewTunnelFrame({ type: 'credit', stream: 7, bytes: 10 });
    const padded = new Uint8Array(frame.byteLength + 8);
    padded.set(frame, 4);
    expect(decodeWrapperTunnelFrame(padded.subarray(4, 4 + frame.byteLength))).toEqual({
      ok: true,
      frame: { type: 'credit', stream: 7, bytes: 10 },
    });
  });

  it('refuses a frame type that the sender may not send', () => {
    const open = encodePreviewTunnelFrame(workerFrames[0] as PreviewTunnelFrame);
    expect(violation(decodeWrapperTunnelFrame(open))).toBe(1008);
    const head = encodePreviewTunnelFrame(wrapperFrames[0] as PreviewTunnelFrame);
    expect(violation(decodeWorkerTunnelFrame(head))).toBe(1008);
  });

  it.each([0, 12, 255])('refuses the unknown frame type %i', type => {
    expect(violation(decodeWrapperTunnelFrame(raw(type, 1)))).toBe(1008);
  });

  it('refuses a short frame and stream id zero', () => {
    expect(violation(decodeWrapperTunnelFrame(new Uint8Array([3, 0, 0])))).toBe(1008);
    expect(violation(decodeWrapperTunnelFrame(raw(4, 0)))).toBe(1008);
  });

  it('accepts a data frame at the bound and refuses one over it', () => {
    const atBound = raw(3, 1, new Uint8Array(PREVIEW_TUNNEL_DATA_MAX_BYTES));
    expect(decodeWrapperTunnelFrame(atBound).ok).toBe(true);
    const over = raw(3, 1, new Uint8Array(PREVIEW_TUNNEL_DATA_MAX_BYTES + 1));
    expect(violation(decodeWrapperTunnelFrame(over))).toBe(1008);
  });

  it('refuses a WebSocket message over 1 MiB with 1009', () => {
    const atBound = raw(10, 0x8000_0000, new Uint8Array(PREVIEW_TUNNEL_WS_MESSAGE_MAX_BYTES));
    expect(decodeWrapperTunnelFrame(atBound).ok).toBe(true);
    const binary = raw(10, 0x8000_0000, new Uint8Array(PREVIEW_TUNNEL_WS_MESSAGE_MAX_BYTES + 1));
    expect(violation(decodeWrapperTunnelFrame(binary))).toBe(1009);
    const text = raw(9, 0x8000_0000, new Uint8Array(PREVIEW_TUNNEL_WS_MESSAGE_MAX_BYTES + 1));
    expect(violation(decodeWrapperTunnelFrame(text))).toBe(1009);
  });

  it('refuses a head over 64 KiB, invalid JSON and an invalid head', () => {
    const big = { status: 200, headers: [['x', 'y'.repeat(PREVIEW_TUNNEL_JSON_MAX_BYTES)]] };
    expect(violation(decodeWrapperTunnelFrame(raw(2, 1, json(big))))).toBe(1008);
    expect(violation(decodeWrapperTunnelFrame(raw(2, 1, json({ status: 101, headers: [] }))))).toBe(
      1008
    );
    expect(
      violation(decodeWrapperTunnelFrame(raw(2, 1, json({ status: 200, headers: [], x: 1 }))))
    ).toBe(1008);
    expect(violation(decodeWrapperTunnelFrame(raw(2, 1, new Uint8Array([123]))))).toBe(1008);
    expect(violation(decodeWrapperTunnelFrame(raw(5, 1, json({ code: 'other' }))))).toBe(1008);
  });

  it('refuses a credit of the wrong size, an end with a payload and text that is not UTF-8', () => {
    expect(violation(decodeWrapperTunnelFrame(raw(6, 1, new Uint8Array(3))))).toBe(1008);
    expect(violation(decodeWrapperTunnelFrame(raw(4, 1, new Uint8Array(1))))).toBe(1008);
    expect(violation(decodeWrapperTunnelFrame(raw(9, 0x8000_0000, new Uint8Array([0xff]))))).toBe(
      1008
    );
  });

  it('refuses an open for a port outside the preview range', () => {
    const open = { port: 80, method: 'GET', path: '/', headers: [] };
    expect(violation(decodeWorkerTunnelFrame(raw(1, 1, json(open))))).toBe(1008);
  });

  it('will not encode a frame over its bound', () => {
    const head = { status: 200, headers: [['x', 'y'.repeat(PREVIEW_TUNNEL_JSON_MAX_BYTES)]] };
    expect(() => encodePreviewTunnelFrame({ type: 'head', stream: 1, head } as never)).toThrow(
      PreviewTunnelFrameTooLargeError
    );
    expect(() =>
      encodePreviewTunnelFrame({
        type: 'data',
        stream: 1,
        bytes: new Uint8Array(PREVIEW_TUNNEL_DATA_MAX_BYTES + 1),
      })
    ).toThrow(PreviewTunnelFrameTooLargeError);
    expect(() =>
      encodePreviewTunnelFrame({
        type: 'ws_binary',
        stream: 0x8000_0000,
        bytes: new Uint8Array(PREVIEW_TUNNEL_WS_MESSAGE_MAX_BYTES + 1),
      })
    ).toThrow(PreviewTunnelFrameTooLargeError);
  });
});

describe('preview tunnel addresses', () => {
  it('puts the tunnel path on the control host and keeps the encoded sandbox id', () => {
    expect(previewTunnelUrl('wss://worker.example/sandbox-control/sbx%3Aa')).toBe(
      'wss://worker.example/sandbox-preview-tunnel/sbx%3Aa'
    );
    expect(previewTunnelUrl('ws://127.0.0.1:8794/prefix/sandbox-control/sbx_1?x=1')).toBe(
      'ws://127.0.0.1:8794/prefix/sandbox-preview-tunnel/sbx_1'
    );
    expect(previewTunnelUrl('wss://worker.example/other/sbx_1')).toBeNull();
    expect(previewTunnelUrl('not a url')).toBeNull();
  });

  it('splits the Durable Object name on the last colon', () => {
    const allocationId = '00000000-0000-4000-8000-000000000001';
    const name = previewTunnelName('ses:sbx:1', allocationId);
    expect(parsePreviewTunnelName(name)).toEqual({ sandboxId: 'ses:sbx:1', allocationId });
    expect(parsePreviewTunnelName(undefined)).toBeNull();
    expect(parsePreviewTunnelName('no-colon')).toBeNull();
    expect(parsePreviewTunnelName(':a')).toBeNull();
    expect(parsePreviewTunnelName('a:')).toBeNull();
  });
});

describe('previewResponseHasNoBody', () => {
  it('names the answer to HEAD and the statuses without a body', () => {
    expect(previewResponseHasNoBody('head', 200)).toBe(true);
    for (const status of [101, 204, 205, 304]) {
      expect(previewResponseHasNoBody('GET', status)).toBe(true);
    }
    expect(previewResponseHasNoBody('GET', 200)).toBe(false);
    expect(previewResponseHasNoBody('POST', 404)).toBe(false);
  });
});
