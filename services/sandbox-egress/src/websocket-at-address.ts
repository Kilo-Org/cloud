import { createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { cleanEgressHeaders } from '@kilocode/worker-utils/egress-http';
import { isPublicAddress } from './destination.js';
import { stripTestAccessHeaders, type Ec2TestAccess } from './ec2-test-access.js';
import type { HttpsRequestFactory } from './https-transport.js';

const websocketGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function values(value: string | undefined) {
  return (value ?? '').split(',').map(entry => entry.trim().toLowerCase());
}

function sanitized(headers: IncomingMessage['rawHeaders']) {
  const parsed = new Headers();
  for (let i = 0; i < headers.length; i += 2) parsed.append(headers[i], headers[i + 1]);
  return cleanEgressHeaders(parsed);
}

/** Forward one verified WebSocket upgrade to the address selected for this TLS connection. */
export function openWebSocketAtAddress(input: {
  request: IncomingMessage;
  target: URL;
  socket: Duplex;
  head: Buffer;
  address: string;
  signal: AbortSignal;
  send?: HttpsRequestFactory;
  testAccess?: Ec2TestAccess;
}) {
  const { request, target, socket, signal } = input;
  const key = request.headers['sec-websocket-key'];
  if (
    request.method !== 'GET' ||
    request.headers.upgrade?.toLowerCase() !== 'websocket' ||
    !values(request.headers.connection).includes('upgrade') ||
    request.headers['sec-websocket-version'] !== '13' ||
    typeof key !== 'string' ||
    !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
    Buffer.from(key, 'base64').toString('base64') !== key ||
    request.headers['transfer-encoding'] !== undefined ||
    ![undefined, '0'].includes(request.headers['content-length']) ||
    target.protocol !== 'https:' ||
    target.port ||
    target.username ||
    target.password ||
    signal.aborted ||
    input.head.length > 65_536 ||
    !isPublicAddress(input.address)
  ) {
    socket.destroy();
    return;
  }

  const headers = sanitized(request.rawHeaders);
  if (input.testAccess && !input.testAccess.authorizeWorkload(target, request.method, headers)) {
    socket.destroy();
    return;
  }
  headers.set('host', target.host);
  headers.set('connection', 'upgrade');
  headers.set('upgrade', 'websocket');
  headers.set('sec-websocket-key', key);
  headers.set('sec-websocket-version', '13');
  headers.delete('sec-websocket-extensions');
  const upstream = (input.send ?? httpsRequest)({
    hostname: input.address,
    port: 443,
    servername: target.hostname,
    path: target.pathname + target.search,
    method: 'GET',
    headers: Object.fromEntries(headers),
    agent: false,
    signal,
    maxHeaderSize: 32_768,
    minVersion: 'TLSv1.2',
  });
  const deadline = setTimeout(() => {
    upstream.destroy();
    socket.destroy();
  }, 15_000);
  upstream.once('close', () => clearTimeout(deadline));
  upstream.once('error', () => socket.destroy());
  socket.once('close', () => upstream.destroy());
  upstream.once('response', response => {
    response.destroy();
    socket.destroy();
  });
  upstream.once('upgrade', (response, backend, firstBytes) => {
    clearTimeout(deadline);
    const accept = createHash('sha1')
      .update(key + websocketGuid)
      .digest('base64');
    const protocol = response.headers['sec-websocket-protocol'];
    const offered = headers.get('sec-websocket-protocol');
    if (
      socket.destroyed ||
      signal.aborted ||
      response.statusCode !== 101 ||
      response.headers.upgrade?.toLowerCase() !== 'websocket' ||
      !values(response.headers.connection).includes('upgrade') ||
      response.headers['sec-websocket-accept'] !== accept ||
      response.headers['sec-websocket-extensions'] !== undefined ||
      (protocol !== undefined &&
        (typeof protocol !== 'string' ||
          !offered?.split(',').some(name => name.trim() === protocol)))
    ) {
      socket.destroy();
      backend.destroy();
      return;
    }
    const forwarded = sanitized(response.rawHeaders);
    if (input.testAccess) stripTestAccessHeaders(forwarded);
    forwarded.set('sec-websocket-accept', accept);
    if (protocol !== undefined) forwarded.set('sec-websocket-protocol', protocol);
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Connection: Upgrade',
        'Upgrade: websocket',
        ...Array.from(forwarded)
          .filter(([name]) => name !== 'set-cookie')
          .map(([name, value]) => `${name}: ${value}`),
        ...forwarded.getSetCookie().map(value => `Set-Cookie: ${value}`),
        '\r\n',
      ].join('\r\n')
    );
    if (firstBytes.length) socket.write(firstBytes);
    if (input.head.length) backend.write(input.head);
    backend.on('error', () => socket.destroy());
    backend.on('close', () => socket.destroy());
    socket.on('close', () => backend.destroy());
    backend.setTimeout(120_000, () => backend.destroy());
    backend.pipe(socket).pipe(backend);
    socket.resume();
  });
  upstream.end();
}
