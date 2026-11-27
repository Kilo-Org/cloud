import { connect, type Socket } from 'node:net';
import type { PolicyLease } from './policies.js';

export function refuseConnect(socket: Socket, status: 403 | 407 | 502 | 503) {
  if (socket.destroyed) return;
  const reason = {
    403: 'Forbidden',
    407: 'Proxy Authentication Required',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  }[status];
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n${status === 407 ? 'Proxy-Authenticate: Basic realm="kilo"\r\n' : ''}\r\n`
  );
}
/** Pipe only the checked public address; do not resolve the hostname again. */
export function openTunnel(input: {
  client: Socket;
  head: Buffer;
  address: string;
  lease: PolicyLease;
  signal: AbortSignal;
}) {
  const { client, head, address, lease, signal } = input;
  client.setTimeout(120_000);
  const connection = connect({ host: address, port: 443, signal });
  client.once('close', () => connection.destroy());
  let established = false;
  const deadline = setTimeout(() => connection.destroy(new Error('Connection deadline')), 10_000);
  connection.once('error', () => {
    clearTimeout(deadline);
    if (established) client.destroy();
    else refuseConnect(client, 502);
  });
  connection.once('close', () => {
    clearTimeout(deadline);
    client.destroy();
  });
  connection.setTimeout(120_000, () => connection.destroy());
  connection.once('connect', () => {
    clearTimeout(deadline);
    established = true;
    try {
      lease.policy();
    } catch {
      client.destroy();
      return;
    }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) connection.write(head);
    client.pipe(connection).pipe(client);
    client.resume();
  });
}
