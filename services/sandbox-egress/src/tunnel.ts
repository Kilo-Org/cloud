import { connect, type Socket } from 'node:net';
import type { PolicyLease } from './policies.js';

/** Pipe only the checked public address; do not resolve the hostname again. */
type Tunnel = {
  client: Socket;
  head: Buffer;
  address: string;
  lease: PolicyLease;
  signal: AbortSignal;
};

export function openTransparentTunnel(input: Tunnel) {
  const { client, head, address, lease, signal } = input;
  client.setTimeout(120_000);
  const connection = connect({ host: address, port: 443, signal });
  client.once('close', () => connection.destroy());
  const deadline = setTimeout(() => connection.destroy(new Error('Connection deadline')), 10_000);
  connection.once('error', () => {
    clearTimeout(deadline);
    client.destroy();
  });
  connection.once('close', () => {
    clearTimeout(deadline);
    client.destroy();
  });
  connection.setTimeout(120_000, () => connection.destroy());
  connection.once('connect', () => {
    clearTimeout(deadline);
    try {
      lease.policy();
    } catch {
      client.destroy();
      return;
    }
    if (head.length) connection.write(head);
    client.pipe(connection).pipe(client);
    client.resume();
  });
}
