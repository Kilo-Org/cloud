import { createHash } from 'node:crypto';
import net from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  WS_OPCODE_BINARY,
  WS_OPCODE_CLOSE,
  WS_OPCODE_TEXT,
  buildClientHandshake,
  connectWebSocket,
  encodeBinaryFrame,
  encodeCloseFrame,
  encodeTextFrame,
  parseFrames,
  parseHandshakeResponse,
  webSocketAccept,
} from '../../e2e/preview-ws.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

describe('webSocketAccept', () => {
  it('matches the RFC 6455 example key', () => {
    expect(webSocketAccept('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('encode/parse frames', () => {
  it('round-trips a masked client text frame', () => {
    const parsed = parseFrames(encodeTextFrame('hello'));
    expect(parsed.frames).toHaveLength(1);
    expect(parsed.frames[0]?.opcode).toBe(WS_OPCODE_TEXT);
    expect(parsed.frames[0]?.payload.toString('utf8')).toBe('hello');
    expect(parsed.rest).toHaveLength(0);
  });

  it('round-trips a masked binary frame and a close frame', () => {
    const binary = Buffer.from([0, 1, 2, 250, 251, 252]);
    const parsed = parseFrames(Buffer.concat([encodeBinaryFrame(binary), encodeCloseFrame(1000)]));
    expect(parsed.frames.map(frame => frame.opcode)).toEqual([WS_OPCODE_BINARY, WS_OPCODE_CLOSE]);
    expect(parsed.frames[0]?.payload.equals(binary)).toBe(true);
    expect(parsed.frames[1]?.payload.readUInt16BE(0)).toBe(1000);
  });

  it('returns an incomplete frame as the unparsed tail', () => {
    const whole = encodeTextFrame('partial');
    const split = parseFrames(whole.subarray(0, whole.length - 2));
    expect(split.frames).toHaveLength(0);
    expect(split.rest).toHaveLength(whole.length - 2);
  });

  it('parses an unmasked server frame', () => {
    const payload = Buffer.from('server', 'utf8');
    const header = Buffer.from([0x80 | WS_OPCODE_TEXT, payload.length]);
    const parsed = parseFrames(Buffer.concat([header, payload]));
    expect(parsed.frames[0]?.payload.toString('utf8')).toBe('server');
  });
});

describe('buildClientHandshake', () => {
  it('includes the Host, Origin, subprotocol and cookie when offered', () => {
    const handshake = buildClientHandshake({
      path: '/ws',
      host: 'p8765-abc.localhost:8794',
      origin: 'http://p8765-abc.localhost:8794',
      key: 'key==',
      cookie: 'kilo_preview=tok; app=1',
      subprotocol: 'kilo-test',
    });
    expect(handshake).toContain('GET /ws HTTP/1.1\r\n');
    expect(handshake).toContain('Host: p8765-abc.localhost:8794\r\n');
    expect(handshake).toContain('Origin: http://p8765-abc.localhost:8794\r\n');
    expect(handshake).toContain('Sec-WebSocket-Protocol: kilo-test\r\n');
    expect(handshake).toContain('Cookie: kilo_preview=tok; app=1\r\n');
    expect(handshake.endsWith('\r\n\r\n')).toBe(true);
  });

  it('omits Origin when the caller sends none (the missing-Origin case)', () => {
    const handshake = buildClientHandshake({ path: '/ws', host: 'h:1', key: 'k' });
    expect(handshake).not.toContain('Origin:');
  });
});

describe('parseHandshakeResponse', () => {
  it('parses status, headers and the trailing frame bytes', () => {
    const frame = encodeTextFrame('after');
    const buffer = Buffer.concat([
      Buffer.from(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
          'Sec-WebSocket-Protocol: kilo-test\r\n\r\n'
      ),
      frame,
    ]);
    const parsed = parseHandshakeResponse(buffer);
    expect(parsed?.status).toBe(101);
    expect(parsed?.headers.upgrade).toBe('websocket');
    expect(parsed?.headers['sec-websocket-protocol']).toBe('kilo-test');
    expect(parsed?.rest.length).toBe(frame.length);
  });

  it('returns null until the header terminator arrives', () => {
    expect(parseHandshakeResponse(Buffer.from('HTTP/1.1 403 Forbidden\r\n'))).toBeNull();
  });
});

describe('connectWebSocket', () => {
  it('dials connectHost while sending the preview host as the Host header', async () => {
    let requestHead = '';
    const server = net.createServer(socket => {
      socket.once('data', (chunk: Buffer) => {
        requestHead = chunk.toString('latin1');
        const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(requestHead)?.[1]?.trim() ?? '';
        const accept = createHash('sha1')
          .update(key + WS_GUID)
          .digest('base64');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        );
      });
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
    try {
      const connection = await connectWebSocket({
        host: 'p8765-abc.localhost',
        connectHost: '127.0.0.1',
        port,
        path: '/ws',
        timeoutMs: 5_000,
      });
      expect(connection.status).toBe(101);
      connection.destroy();
      expect(requestHead).toContain(`Host: p8765-abc.localhost:${port}\r\n`);
    } finally {
      server.close();
    }
  });
});
