import { z } from 'zod';
import { PREVIEW_PORT_MAX, PREVIEW_PORT_MIN } from './preview-port.js';

/**
 * The preview tunnel: one binary WebSocket from the wrapper to the
 * `PreviewTunnel` Durable Object for each allocation. It carries many preview
 * streams. A frame is `[type u8][stream u32 big-endian][payload]`.
 *
 * The Worker treats the wrapper as untrusted: a frame that breaks this
 * protocol closes the tunnel. The bounds below are the protocol contract for
 * both sides.
 */

export const PREVIEW_TUNNEL_PATH_PREFIX = '/sandbox-preview-tunnel/';

/** Each side holds at most this much unread data for each stream and direction. */
export const PREVIEW_TUNNEL_WINDOW_BYTES = 256 * 1024;
export const PREVIEW_TUNNEL_DATA_MAX_BYTES = 64 * 1024;
export const PREVIEW_TUNNEL_JSON_MAX_BYTES = 64 * 1024;
export const PREVIEW_TUNNEL_WS_MESSAGE_MAX_BYTES = 1024 * 1024;

/** Open HTTP streams for each tunnel; a browser keeps about 100 requests in flight. */
export const PREVIEW_TUNNEL_MAX_HTTP_STREAMS = 128;
export const PREVIEW_TUNNEL_MAX_WS_STREAMS = 128;
/** Requests that wait for a free HTTP stream, and how long each waits. */
export const PREVIEW_TUNNEL_MAX_STREAM_WAITERS = 512;
export const PREVIEW_TUNNEL_STREAM_WAIT_MS = 10_000;

/**
 * The wrapper acknowledges each open at once, before its loopback connect.
 * Only a tunnel that sends no frame in this time counts as dead.
 */
export const PREVIEW_TUNNEL_ACK_TIMEOUT_MS = 3_000;
/** How long a request waits for a tunnel after the Worker asks for one. */
export const PREVIEW_TUNNEL_CONNECT_WAIT_MS = 10_000;
/** The wrapper's time to response headers, as on the Containers path. */
export const PREVIEW_TUNNEL_HEAD_TIMEOUT_MS = 60_000;
/** The wrapper's time to an open loopback WebSocket. */
export const PREVIEW_TUNNEL_SOCKET_TIMEOUT_MS = 10_000;
/** The Worker's own limits, a little after the wrapper's. */
export const PREVIEW_TUNNEL_HEAD_BACKSTOP_MS = PREVIEW_TUNNEL_HEAD_TIMEOUT_MS + 5_000;
export const PREVIEW_TUNNEL_ACCEPT_BACKSTOP_MS = PREVIEW_TUNNEL_SOCKET_TIMEOUT_MS + 5_000;

export const PREVIEW_TUNNEL_PING_INTERVAL_MS = 30_000;
export const PREVIEW_TUNNEL_MISSED_PONG_LIMIT = 2;
export const PREVIEW_TUNNEL_IDLE_CLOSE_MS = 5 * 60_000;

export const PREVIEW_TUNNEL_CLOSE = {
  idle: 1000,
  unsupportedData: 1003,
  violation: 1008,
  tooBig: 1009,
  replaced: 4001,
  noAck: 4002,
} as const;

/** HTTP stream ids are below this; WebSocket stream ids are at or above it. */
export const PREVIEW_TUNNEL_WS_ID_BASE = 0x8000_0000;
export const PREVIEW_TUNNEL_MAX_STREAM_ID = 0xffff_ffff;

export function isPreviewTunnelWebSocketId(stream: number): boolean {
  return stream >= PREVIEW_TUNNEL_WS_ID_BASE;
}

/** A response without a body: the answer to HEAD, and the statuses 101, 204, 205 and 304. */
export function previewResponseHasNoBody(method: string, status: number): boolean {
  return (
    method.toUpperCase() === 'HEAD' ||
    status === 101 ||
    status === 204 ||
    status === 205 ||
    status === 304
  );
}

/** The tunnel URL on the host of the wrapper's control URL, or null for another form. */
export function previewTunnelUrl(controlUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(controlUrl);
  } catch {
    return null;
  }
  const match = /^(.*)\/sandbox-control\/([^/]+)$/.exec(url.pathname);
  if (match === null) return null;
  url.pathname = `${match[1]}${PREVIEW_TUNNEL_PATH_PREFIX}${match[2]}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** The `PreviewTunnel` name: the allocation id is a UUID, so it splits on the last `:`. */
export function previewTunnelName(sandboxId: string, allocationId: string): string {
  return `${sandboxId}:${allocationId}`;
}

export function parsePreviewTunnelName(
  name: string | undefined
): { sandboxId: string; allocationId: string } | null {
  if (name === undefined) return null;
  const split = name.lastIndexOf(':');
  if (split <= 0 || split === name.length - 1) return null;
  return { sandboxId: name.slice(0, split), allocationId: name.slice(split + 1) };
}

const FRAME_TYPE = {
  open: 1,
  head: 2,
  data: 3,
  end: 4,
  reset: 5,
  credit: 6,
  ws_open: 7,
  ws_accept: 8,
  ws_text: 9,
  ws_binary: 10,
  ws_close: 11,
} as const;

type FrameTypeName = keyof typeof FRAME_TYPE;
const FRAME_TYPE_NAMES = new Map<number, FrameTypeName>(
  Object.entries(FRAME_TYPE).map(([name, code]) => [code, name as FrameTypeName])
);

const headerListSchema = z.array(z.tuple([z.string(), z.string()]));
const portSchema = z.number().int().min(PREVIEW_PORT_MIN).max(PREVIEW_PORT_MAX);
const pathSchema = z.string().min(1).startsWith('/');

const openSchema = z
  .object({
    port: portSchema,
    method: z.string().regex(/^[A-Za-z]{1,16}$/),
    path: pathSchema,
    headers: headerListSchema,
  })
  .strict();
const wsOpenSchema = z
  .object({
    port: portSchema,
    path: pathSchema,
    headers: headerListSchema,
    protocols: z.array(z.string()).max(32),
  })
  .strict();
const headSchema = z
  .object({ status: z.number().int().min(200).max(599), headers: headerListSchema })
  .strict();

export const PREVIEW_TUNNEL_RESET_CODES = [
  'reserved',
  'not_listening',
  'timeout',
  'bad_response',
  'busy',
  'cancelled',
  'protocol',
] as const;
export type PreviewTunnelResetCode = (typeof PREVIEW_TUNNEL_RESET_CODES)[number];

const resetSchema = z.object({ code: z.enum(PREVIEW_TUNNEL_RESET_CODES) }).strict();
const wsAcceptSchema = z.object({ protocol: z.string().max(256) }).strict();
const wsCloseSchema = z
  .object({ code: z.number().int().min(1000).max(4999), reason: z.string().max(123) })
  .strict();

export type PreviewTunnelOpen = z.infer<typeof openSchema>;
export type PreviewTunnelWebSocketOpen = z.infer<typeof wsOpenSchema>;
export type PreviewTunnelHead = z.infer<typeof headSchema>;

export type PreviewTunnelFrame =
  | { type: 'open'; stream: number; open: PreviewTunnelOpen }
  | { type: 'head'; stream: number; head: PreviewTunnelHead }
  | { type: 'data'; stream: number; bytes: Uint8Array }
  | { type: 'end'; stream: number }
  | { type: 'reset'; stream: number; code: PreviewTunnelResetCode }
  | { type: 'credit'; stream: number; bytes: number }
  | { type: 'ws_open'; stream: number; open: PreviewTunnelWebSocketOpen }
  | { type: 'ws_accept'; stream: number; protocol: string }
  | { type: 'ws_text'; stream: number; text: string }
  | { type: 'ws_binary'; stream: number; bytes: Uint8Array }
  | { type: 'ws_close'; stream: number; code: number; reason: string };

export type PreviewTunnelViolation = { code: 1008 | 1009; reason: string };

export type PreviewTunnelDecodeResult =
  | { ok: true; frame: PreviewTunnelFrame }
  | { ok: false; violation: PreviewTunnelViolation };

export class PreviewTunnelFrameTooLargeError extends Error {
  constructor() {
    super('Preview tunnel frame is too large');
  }
}

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const HEADER_BYTES = 5;

function withHeader(
  type: FrameTypeName,
  stream: number,
  payload: Uint8Array
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(HEADER_BYTES + payload.byteLength);
  out[0] = FRAME_TYPE[type];
  new DataView(out.buffer).setUint32(1, stream);
  out.set(payload, HEADER_BYTES);
  return out;
}

function jsonPayload(value: unknown): Uint8Array {
  const payload = encoder.encode(JSON.stringify(value));
  if (payload.byteLength > PREVIEW_TUNNEL_JSON_MAX_BYTES) {
    throw new PreviewTunnelFrameTooLargeError();
  }
  return payload;
}

function boundedBytes(bytes: Uint8Array, max: number): Uint8Array {
  if (bytes.byteLength > max) throw new PreviewTunnelFrameTooLargeError();
  return bytes;
}

/** Encodes one frame; throws `PreviewTunnelFrameTooLargeError` over a bound. */
export function encodePreviewTunnelFrame(frame: PreviewTunnelFrame): Uint8Array<ArrayBuffer> {
  switch (frame.type) {
    case 'open':
      return withHeader(frame.type, frame.stream, jsonPayload(frame.open));
    case 'ws_open':
      return withHeader(frame.type, frame.stream, jsonPayload(frame.open));
    case 'head':
      return withHeader(frame.type, frame.stream, jsonPayload(frame.head));
    case 'reset':
      return withHeader(frame.type, frame.stream, jsonPayload({ code: frame.code }));
    case 'ws_accept':
      return withHeader(frame.type, frame.stream, jsonPayload({ protocol: frame.protocol }));
    case 'ws_close':
      return withHeader(
        frame.type,
        frame.stream,
        jsonPayload({ code: frame.code, reason: frame.reason })
      );
    case 'data':
      return withHeader(
        frame.type,
        frame.stream,
        boundedBytes(frame.bytes, PREVIEW_TUNNEL_DATA_MAX_BYTES)
      );
    case 'end':
      return withHeader(frame.type, frame.stream, new Uint8Array(0));
    case 'credit': {
      const payload = new Uint8Array(4);
      new DataView(payload.buffer).setUint32(0, frame.bytes);
      return withHeader(frame.type, frame.stream, payload);
    }
    case 'ws_text':
      return withHeader(
        frame.type,
        frame.stream,
        boundedBytes(encoder.encode(frame.text), PREVIEW_TUNNEL_WS_MESSAGE_MAX_BYTES)
      );
    case 'ws_binary':
      return withHeader(
        frame.type,
        frame.stream,
        boundedBytes(frame.bytes, PREVIEW_TUNNEL_WS_MESSAGE_MAX_BYTES)
      );
  }
}

class Violation extends Error {
  constructor(
    readonly code: 1008 | 1009,
    reason: string
  ) {
    super(reason);
  }
}

function parseJson<T>(payload: Uint8Array, schema: z.ZodType<T>): T {
  if (payload.byteLength > PREVIEW_TUNNEL_JSON_MAX_BYTES) {
    throw new Violation(1008, 'Preview tunnel head is too large');
  }
  let value: unknown;
  try {
    value = JSON.parse(strictDecoder.decode(payload));
  } catch {
    throw new Violation(1008, 'Preview tunnel head is not JSON');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Violation(1008, 'Preview tunnel head is invalid');
  return parsed.data;
}

function dataBytes(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > PREVIEW_TUNNEL_DATA_MAX_BYTES) {
    throw new Violation(1008, 'Preview tunnel data frame is too large');
  }
  return payload;
}

function messageBytes(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > PREVIEW_TUNNEL_WS_MESSAGE_MAX_BYTES) {
    throw new Violation(1009, 'Preview tunnel WebSocket message is too large');
  }
  return payload;
}

function emptyPayload(payload: Uint8Array): void {
  if (payload.byteLength !== 0) throw new Violation(1008, 'Preview tunnel end has a payload');
}

function frameOf(type: FrameTypeName, stream: number, payload: Uint8Array): PreviewTunnelFrame {
  switch (type) {
    case 'open':
      return { type, stream, open: parseJson(payload, openSchema) };
    case 'ws_open':
      return { type, stream, open: parseJson(payload, wsOpenSchema) };
    case 'head':
      return { type, stream, head: parseJson(payload, headSchema) };
    case 'reset':
      return { type, stream, code: parseJson(payload, resetSchema).code };
    case 'ws_accept':
      return { type, stream, protocol: parseJson(payload, wsAcceptSchema).protocol };
    case 'ws_close':
      return { type, stream, ...parseJson(payload, wsCloseSchema) };
    case 'data':
      return { type, stream, bytes: dataBytes(payload) };
    case 'end':
      emptyPayload(payload);
      return { type, stream };
    case 'credit':
      if (payload.byteLength !== 4) throw new Violation(1008, 'Preview tunnel credit is invalid');
      return {
        type,
        stream,
        bytes: new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0),
      };
    case 'ws_text': {
      const bytes = messageBytes(payload);
      try {
        return { type, stream, text: strictDecoder.decode(bytes) };
      } catch {
        throw new Violation(1008, 'Preview tunnel text is not UTF-8');
      }
    }
    case 'ws_binary':
      return { type, stream, bytes: messageBytes(payload) };
  }
}

function decodeFrom(
  message: ArrayBuffer | ArrayBufferView,
  allowed: ReadonlySet<FrameTypeName>
): PreviewTunnelDecodeResult {
  const bytes =
    message instanceof ArrayBuffer
      ? new Uint8Array(message)
      : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  try {
    if (bytes.byteLength < HEADER_BYTES) throw new Violation(1008, 'Preview tunnel frame is short');
    const type = FRAME_TYPE_NAMES.get(bytes[0] ?? 0);
    if (type === undefined || !allowed.has(type)) {
      throw new Violation(1008, 'Preview tunnel frame type is not allowed');
    }
    const stream = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES).getUint32(1);
    if (stream === 0) throw new Violation(1008, 'Preview tunnel stream id is zero');
    return { ok: true, frame: frameOf(type, stream, bytes.subarray(HEADER_BYTES)) };
  } catch (error) {
    if (error instanceof Violation) {
      return { ok: false, violation: { code: error.code, reason: error.message } };
    }
    throw error;
  }
}

const FROM_WRAPPER = new Set<FrameTypeName>([
  'head',
  'data',
  'end',
  'reset',
  'credit',
  'ws_accept',
  'ws_text',
  'ws_binary',
  'ws_close',
]);
const FROM_WORKER = new Set<FrameTypeName>([
  'open',
  'data',
  'end',
  'reset',
  'credit',
  'ws_open',
  'ws_text',
  'ws_binary',
  'ws_close',
]);

/** Decodes a frame that the wrapper sent; the Durable Object closes the tunnel on a violation. */
export function decodeWrapperTunnelFrame(
  message: ArrayBuffer | ArrayBufferView
): PreviewTunnelDecodeResult {
  return decodeFrom(message, FROM_WRAPPER);
}

/** Decodes a frame that the Durable Object sent. */
export function decodeWorkerTunnelFrame(
  message: ArrayBuffer | ArrayBufferView
): PreviewTunnelDecodeResult {
  return decodeFrom(message, FROM_WORKER);
}
