/* eslint-disable import/no-nodejs-modules, max-lines, typescript-eslint/consistent-type-definitions -- the fake hub vendors a minimal HTTP + WebSocket server so the E2E adds no dependency; AGENTS.md prefers type over interface */
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { z } from 'zod';

/*
 * A fake loopback hub for the local-agents E2E: it serves the pairing page and
 * speaks just enough WebSocket to run the SPEC handshake, auth, ext.hello, and
 * JSON-RPC envelopes. The framing is hand-rolled so the test adds no runtime
 * dependency to the extension package.
 */

export type FakeHubFrame = Record<string, unknown>;

const frameSchema = z.record(z.string(), z.unknown());

export type FakeHub = {
  close(): Promise<void>;
  connected: boolean;
  frames: FakeHubFrame[];
  origin: string | undefined;
  pairingUrl(hubId: string, key: string): string;
  port: number;
  send(frame: FakeHubFrame): void;
  wsUrl: string;
};

const WS_GUID = '258EAFA5-E914-47DA-95CA-5AB0DC854C11';
const HUB_ID = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

const encodeFrame = (text: string): Buffer => {
  const payload = Buffer.from(text, 'utf8');

  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([129, payload.length]), payload]);
  }

  if (payload.length < 65_536) {
    const header = Buffer.alloc(4);
    header[0] = 129;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);

    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 129;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);

  return Buffer.concat([header, payload]);
};

const encodeControlFrame = (opcode: number, payload: Buffer): Buffer =>
  Buffer.concat([Buffer.from([128 | opcode, payload.length]), payload]);

type DecodedFrame =
  | { kind: 'text'; text: string }
  | { kind: 'close' }
  | { kind: 'ping'; payload: Buffer }
  | { kind: 'pong' };

const decodeFrames = (buffer: Buffer): { frames: DecodedFrame[]; rest: Buffer } => {
  const frames: DecodedFrame[] = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset] ?? 0;
    const second = buffer[offset + 1] ?? 0;
    const opcode = first & 15;
    const masked = (second & 128) !== 0;
    let length = second & 127;
    let cursor = offset + 2;

    if (length === 126) {
      if (cursor + 2 > buffer.length) {
        break;
      }

      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) {
        break;
      }

      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }

    const maskOffset = cursor;

    if (masked) {
      cursor += 4;
    }

    if (cursor + length > buffer.length) {
      break;
    }

    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));

    if (masked) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (buffer[maskOffset + (index % 4)] ?? 0);
      }
    }

    if (opcode === 1) {
      frames.push({ kind: 'text', text: payload.toString('utf8') });
    } else if (opcode === 8) {
      frames.push({ kind: 'close' });
    } else if (opcode === 9) {
      frames.push({ kind: 'ping', payload });
    } else if (opcode === 10) {
      frames.push({ kind: 'pong' });
    }

    offset = cursor + length;
  }

  return { frames, rest: buffer.subarray(offset) };
};

export const fakeHubBase64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64url');

export const fakeHubMac = (key: string, message: string): string =>
  createHmac('sha256', Buffer.from(key, 'base64url')).update(message, 'utf8').digest('base64url');

export const fakeHubNonce = (fill: number): string =>
  fakeHubBase64Url(new Uint8Array(16).fill(fill));

export const FAKE_HUB_ID = HUB_ID;

const startServer = async (): Promise<Server> => {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url?.startsWith('/__kilo_browser_pair') === true) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><body>Pairing in progress…</body></html>');

      return;
    }

    response.writeHead(404);
    response.end();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return server;
};

export const startFakeHub = async (): Promise<FakeHub> => {
  const server = await startServer();
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const hub: FakeHub = {
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
    connected: false,
    frames: [],
    origin: undefined,
    pairingUrl: (hubId, key) =>
      `http://127.0.0.1:${port}/__kilo_browser_pair#v=1&hub=${hubId}&k=${encodeURIComponent(key)}&ws=${encodeURIComponent(hub.wsUrl)}`,
    port,
    send: () => {
      /* Rebound to the socket once it opens. */
    },
    wsUrl: `ws://127.0.0.1:${port}/__kilo_browser`,
  };
  let socket: Duplex | null = null;

  server.on('upgrade', (request: IncomingMessage, stream: Duplex) => {
    const { 'sec-websocket-key': key, origin } = request.headers;

    if (typeof key !== 'string' || typeof origin !== 'string') {
      stream.destroy();

      return;
    }

    hub.connected = true;
    hub.origin = origin;
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    stream.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    socket = stream;
    let buffer: Buffer = Buffer.alloc(0);

    stream.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeFrames(buffer);
      buffer = decoded.rest;

      for (const frame of decoded.frames) {
        if (frame.kind === 'text') {
          hub.frames.push(frameSchema.parse(JSON.parse(frame.text)));
        } else if (frame.kind === 'close') {
          stream.end(encodeControlFrame(8, Buffer.alloc(0)));
        } else if (frame.kind === 'ping') {
          stream.write(encodeControlFrame(10, frame.payload));
        }
      }
    });
    stream.on('error', () => {
      /* The close event drives connection state. */
    });
    stream.on('close', () => {
      hub.connected = false;
    });
  });

  hub.send = (frame: FakeHubFrame) => {
    socket?.write(encodeFrame(JSON.stringify(frame)));
  };

  return hub;
};
