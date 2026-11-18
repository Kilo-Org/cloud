import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Minimal RFC 6455 client helpers for `preview-http`. The scenario must send a
 * WebSocket upgrade with an explicit `Host` and `Origin` (Node's `fetch` cannot
 * set `Host`), so this speaks the handshake and framing by hand over
 * `node:net`. The pure encode/parse functions are unit-tested; the connection
 * wrapper is exercised by the (dev-stack) scenario.
 */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const WS_OPCODE_TEXT = 0x1;
export const WS_OPCODE_BINARY = 0x2;
export const WS_OPCODE_CLOSE = 0x8;

export type WebSocketFrame = { opcode: number; payload: Buffer };

export function webSocketAccept(key: string): string {
  return createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
}

function frameHeader(opcode: number, length: number, masked: boolean): Buffer {
  const maskBit = masked ? 0x80 : 0;
  if (length < 126) return Buffer.from([0x80 | opcode, maskBit | length]);
  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = maskBit | 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = maskBit | 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

export function encodeFrame(opcode: number, payload: Buffer, masked: boolean): Buffer {
  if (!masked) return Buffer.concat([frameHeader(opcode, payload.length, false), payload]);
  const mask = randomBytes(4);
  const maskedPayload = Buffer.from(payload);
  for (let index = 0; index < maskedPayload.length; index += 1) {
    maskedPayload[index] ^= mask[index % 4];
  }
  return Buffer.concat([frameHeader(opcode, payload.length, true), mask, maskedPayload]);
}

export function encodeTextFrame(text: string, masked = true): Buffer {
  return encodeFrame(WS_OPCODE_TEXT, Buffer.from(text, 'utf8'), masked);
}

export function encodeBinaryFrame(payload: Buffer, masked = true): Buffer {
  return encodeFrame(WS_OPCODE_BINARY, payload, masked);
}

export function encodeCloseFrame(code = 1000, masked = true): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return encodeFrame(WS_OPCODE_CLOSE, payload, masked);
}

/** Parse as many complete frames as `buffer` holds; return the unparsed tail. */
export function parseFrames(buffer: Buffer): { frames: WebSocketFrame[]; rest: Buffer } {
  const frames: WebSocketFrame[] = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    const maskLength = masked ? 4 : 0;
    if (buffer.length - cursor < maskLength + length) break;
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
    cursor += maskLength;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    frames.push({ opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export function buildClientHandshake(options: {
  path: string;
  host: string;
  origin?: string;
  key: string;
  cookie?: string;
  subprotocol?: string;
}): string {
  const lines = [
    `GET ${options.path} HTTP/1.1`,
    `Host: ${options.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${options.key}`,
    'Sec-WebSocket-Version: 13',
  ];
  if (options.origin !== undefined) lines.push(`Origin: ${options.origin}`);
  if (options.subprotocol !== undefined)
    lines.push(`Sec-WebSocket-Protocol: ${options.subprotocol}`);
  if (options.cookie !== undefined) lines.push(`Cookie: ${options.cookie}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

export function parseHandshakeResponse(
  buffer: Buffer
): { status: number; headers: Record<string, string>; rest: Buffer } | null {
  const marker = buffer.indexOf('\r\n\r\n');
  if (marker < 0) return null;
  const head = buffer.subarray(0, marker).toString('latin1');
  const rest = buffer.subarray(marker + 4);
  const [statusLine, ...headerLines] = head.split('\r\n');
  const status = Number(statusLine?.split(' ')[1] ?? '0');
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { status, headers, rest };
}

export type WebSocketConnection = {
  status: number;
  headers: Record<string, string>;
  nextFrame(timeoutMs: number): Promise<WebSocketFrame>;
  sendText(text: string): void;
  sendBinary(payload: Buffer): void;
  sendClose(code?: number): void;
  destroy(): void;
};

/**
 * Open a raw WebSocket upgrade and resolve once the HTTP handshake is read.
 * `host` is the `Host` header (the preview host); `connectHost` is the TCP
 * target and defaults to `host`. They differ for `*.localhost` previews, where
 * Node must dial loopback while the virtual host travels in `Host`.
 */
export function connectWebSocket(options: {
  host: string;
  connectHost?: string;
  port: number;
  path: string;
  origin?: string;
  cookie?: string;
  subprotocol?: string;
  timeoutMs?: number;
}): Promise<WebSocketConnection> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const key = randomBytes(16).toString('base64');
  const socket = net.connect({ host: options.connectHost ?? options.host, port: options.port });
  return new Promise<WebSocketConnection>((resolve, reject) => {
    let settled = false;
    let handshakeDone = false;
    let buffer: Buffer = Buffer.alloc(0);
    const pending: WebSocketFrame[] = [];
    const waiters: ((frame: WebSocketFrame) => void)[] = [];

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('websocket handshake timed out'));
    }, timeoutMs);

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    const deliver = (frames: WebSocketFrame[]): void => {
      for (const frame of frames) {
        const waiter = waiters.shift();
        if (waiter) waiter(frame);
        else pending.push(frame);
      }
    };

    const connection: Omit<WebSocketConnection, 'status' | 'headers'> = {
      nextFrame: (frameTimeoutMs: number) => {
        const buffered = pending.shift();
        if (buffered !== undefined) return Promise.resolve(buffered);
        return new Promise<WebSocketFrame>((res, rej) => {
          const frameTimer = setTimeout(
            () => rej(new Error('websocket frame timed out')),
            frameTimeoutMs
          );
          waiters.push(frame => {
            clearTimeout(frameTimer);
            res(frame);
          });
        });
      },
      sendText: text => socket.write(encodeTextFrame(text)),
      sendBinary: payload => socket.write(encodeBinaryFrame(payload)),
      sendClose: (code = 1000) => socket.write(encodeCloseFrame(code)),
      destroy: () => socket.destroy(),
    };

    socket.on('connect', () => {
      socket.write(
        buildClientHandshake({
          path: options.path,
          host: `${options.host}:${options.port}`,
          origin: options.origin,
          key,
          ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
          ...(options.subprotocol === undefined ? {} : { subprotocol: options.subprotocol }),
        })
      );
    });

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const parsed = parseHandshakeResponse(buffer);
        if (parsed === null) return;
        handshakeDone = true;
        buffer = parsed.rest;
        clearTimeout(timer);
        settled = true;
        resolve({ status: parsed.status, headers: parsed.headers, ...connection });
        if (buffer.length > 0) {
          const rest = parseFrames(buffer);
          buffer = rest.rest;
          deliver(rest.frames);
        }
        return;
      }
      const parsed = parseFrames(buffer);
      buffer = parsed.rest;
      deliver(parsed.frames);
    });

    socket.on('error', error => fail(error instanceof Error ? error : new Error(String(error))));
    socket.on('close', () => {
      if (!handshakeDone && !settled)
        fail(new Error('websocket connection closed before handshake'));
    });
  });
}
