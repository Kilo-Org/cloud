import { createHash } from 'node:crypto';

/**
 * The owned-container Node fixture `preview-http` executes inside the sandbox
 * container via `docker exec node -e <script>`. It uses only `node:` built-ins
 * (the in-container Node has no npm modules) and owns every route the
 * hostname-dispatched preview proxy must exercise: the module-script HTML
 * document, a form POST, relative and absolute `Location` redirects,
 * `Set-Cookie`, a raw cookie echo, a WebSocket echo, a first-chunk-then-release
 * chunked response, a large streamed response, and a streaming request-body
 * sink.
 *
 * `PREVIEW_FIXTURE_SCRIPT` is a string, so the fixture's `BIG_SIZE` literal is
 * interpolated from the host constant below; the host generates the same body
 * with `buildPreviewBigResponseBody` so `preview-http` can assert a known size
 * and hash without trusting the fixture's own report.
 */
export const PREVIEW_FIXTURE_PORT_CANDIDATES = [8765, 8766, 8767] as const;

export const PREVIEW_BIG_RESPONSE_BYTES = 2 * 1024 * 1024 + 123_456;

export function buildPreviewBigResponseBody(): Buffer {
  const body = Buffer.allocUnsafe(PREVIEW_BIG_RESPONSE_BYTES);
  for (let index = 0; index < body.length; index += 1) body[index] = index & 0xff;
  return body;
}

export function previewBigResponseSha256(): string {
  return createHash('sha256').update(buildPreviewBigResponseBody()).digest('hex');
}

export const PREVIEW_FIXTURE_SCRIPT = `
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const port = Number(process.env.PREVIEW_FIXTURE_PORT);
const BIG_SIZE = ${PREVIEW_BIG_RESPONSE_BYTES};
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let heldStream = null;

function bigBody() {
  const body = Buffer.allocUnsafe(BIG_SIZE);
  for (let i = 0; i < BIG_SIZE; i++) body[i] = i & 0xff;
  return body;
}

function serverFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function parseFrames(buffer) {
  const frames = [];
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
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    frames.push({ opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const cookie = req.headers.cookie || '';
  const send = (status, headers, body) => { res.writeHead(status, headers); res.end(body); };
  if (req.method === 'GET' && url.pathname === '/') {
    send(200, { 'Content-Type': 'text/html; charset=utf-8' },
      '<!doctype html><html><head><title>preview-fixture</title></head><body>' +
      '<script type="module" src="/app.js"></script>' +
      '<form method="post" action="/submit"><input name="q" value="hello"></form>' +
      '<a href="/redirect-me">redirect</a>' +
      '<a href="/big">big</a></body></html>');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/app.js') {
    send(200, { 'Content-Type': 'text/javascript; charset=utf-8' },
      "import { x } from '/lib.js';document.title = x;document.body.setAttribute('data-x', x);");
    return;
  }
  if (req.method === 'GET' && url.pathname === '/lib.js') {
    send(200, { 'Content-Type': 'text/javascript; charset=utf-8' }, "export const x = 'preview-lib';");
    return;
  }
  if (req.method === 'POST' && url.pathname === '/submit') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      send(200, { 'Content-Type': 'text/plain; charset=utf-8' }, 'body=' + body + ';cookie=' + cookie);
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/upload') {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
    req.on('end', () => {
      send(200, { 'Content-Type': 'text/plain; charset=utf-8' },
        'bytes=' + bytes + ';sha256=' + hash.digest('hex'));
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.write('first-chunk\\n');
    heldStream = res;
    return;
  }
  if (req.method === 'GET' && url.pathname === '/release') {
    if (heldStream) { heldStream.end('second-chunk\\n'); heldStream = null; }
    send(200, { 'Content-Type': 'text/plain; charset=utf-8' }, 'released');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/big') {
    const body = bigBody();
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    let offset = 0;
    const step = 65536;
    const pump = () => {
      if (offset >= body.length) { res.end(); return; }
      const end = Math.min(offset + step, body.length);
      res.write(body.subarray(offset, end));
      offset = end;
      setImmediate(pump);
    };
    pump();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/redirect-me') {
    send(302, { Location: '/login' }, '');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/abs') {
    send(302, { Location: 'http://localhost:' + port + '/login' }, '');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/login') {
    send(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'app=1; Path=/; HttpOnly' },
      '<html><body>login</body></html>');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/echo-cookie') {
    send(200, { 'Content-Type': 'text/plain; charset=utf-8' }, 'cookie=' + cookie);
    return;
  }
  send(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  let response = 'HTTP/1.1 101 Switching Protocols\\r\\n' +
    'Upgrade: websocket\\r\\n' +
    'Connection: Upgrade\\r\\n' +
    'Sec-WebSocket-Accept: ' + accept + '\\r\\n';
  const offered = req.headers['sec-websocket-protocol'];
  const firstProtocol = offered ? String(offered).split(',')[0].trim() : '';
  if (firstProtocol) response += 'Sec-WebSocket-Protocol: ' + firstProtocol + '\\r\\n';
  response += '\\r\\n';
  socket.write(response);
  let buffered = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    const parsed = parseFrames(buffered);
    buffered = parsed.rest;
    for (const frame of parsed.frames) {
      if (frame.opcode === 0x8) {
        socket.write(serverFrame(0x8, frame.payload.subarray(0, 2)));
        socket.end();
        return;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) socket.write(serverFrame(frame.opcode, frame.payload));
    }
  });
  socket.on('error', () => socket.destroy());
});

server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(process.env.PREVIEW_FIXTURE_PIDFILE, String(process.pid));
});
`.trim();
