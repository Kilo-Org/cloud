import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { buildEgressAuditRequest } from '@kilocode/worker-utils/egress-audit';
import { cleanEgressHeaders } from '@kilocode/worker-utils/egress-http';
import type { ControlPlaneClient } from './control-plane.js';
import { permitted, intercepted, type PolicyLease } from './policies.js';
import type { ProxyMaterial } from './deployment.js';

function headersOf(request: IncomingMessage) {
  const headers = new Headers();
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    headers.append(request.rawHeaders[i], request.rawHeaders[i + 1]);
  return cleanEgressHeaders(headers);
}
async function send(response: Response, outgoing: ServerResponse, signal: AbortSignal) {
  const headers = cleanEgressHeaders(response.headers);
  const rawHeaders: string[] = [];
  for (const [key, value] of headers) if (key !== 'set-cookie') rawHeaders.push(key, value);
  for (const value of headers.getSetCookie()) rawHeaders.push('set-cookie', value);
  outgoing.writeHead(response.status, rawHeaders);
  if (!response.body) {
    outgoing.end();
    return;
  }
  const body = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>, { signal });
  body.once('error', () => outgoing.destroy());
  outgoing.once('close', () => body.destroy());
  body.pipe(outgoing);
}

export function openScmTunnel(input: {
  client: Socket;
  head: Buffer;
  hostname: string;
  token: string;
  lease: PolicyLease;
  signal: AbortSignal;
  control: ControlPlaneClient;
  tls: ProxyMaterial['tls'];
}) {
  const { client, head, hostname, token, lease, signal } = input;
  client.setTimeout(120_000);
  let busy = false;
  const inner = createHttpServer(
    { maxHeaderSize: 32_768, insecureHTTPParser: false },
    (request, response) => {
      void (async () => {
        const host = request.headers.host?.toLowerCase();
        if (
          busy ||
          (host !== hostname && host !== `${hostname}:443`) ||
          !request.url?.startsWith('/') ||
          request.url.startsWith('//') ||
          /[\\#]/.test(request.url) ||
          request.rawHeaders.filter(
            (_, i) =>
              i % 2 === 0 &&
              ['host', 'authorization', 'private-token'].includes(
                request.rawHeaders[i].toLowerCase()
              )
          ).length >
            [host, request.headers.authorization, request.headers['private-token']].filter(
              value => value !== undefined
            ).length
        ) {
          response.writeHead(403, { Connection: 'close' }).end();
          client.destroy();
          return;
        }
        busy = true;
        const policy = await lease.refresh();
        if (!intercepted(policy, hostname) || !permitted(policy, hostname) || client.destroyed) {
          client.destroy();
          return;
        }
        const target = new URL(request.url, `https://${hostname}`);
        if (target.hostname !== hostname) {
          client.destroy();
          return;
        }
        const options: RequestInit & { duplex: 'half' } = {
          method: request.method,
          headers: headersOf(request),
          redirect: 'manual',
          signal,
          duplex: 'half',
          ...(request.method === 'GET' || request.method === 'HEAD'
            ? {}
            : { body: Readable.toWeb(request) as ReadableStream<Uint8Array> }),
        };
        if (policy.audit)
          await input.control.recordAudit(
            token,
            buildEgressAuditRequest({
              requestId: crypto.randomUUID(),
              allocationRef: policy.allocationRef,
              timestamp: new Date().toISOString(),
              method: request.method ?? 'GET',
              url: target,
              decision: 'allowed',
            }),
            signal
          );
        lease.policy();
        const upstream = await input.control.forwardScm(
          token,
          new Request(target, options),
          signal
        );
        await send(upstream, response, signal);
      })().catch(() => {
        if (!response.headersSent) response.writeHead(503, { Connection: 'close' }).end();
        else response.destroy();
      });
      response.once('finish', () => {
        busy = false;
      });
    }
  );
  inner.maxHeadersCount = 64;
  inner.headersTimeout = 15_000;
  inner.requestTimeout = 120_000;
  inner.keepAliveTimeout = 5_000;
  inner.on('clientError', (_error, socket) => socket.destroy());
  inner.on('connect', (_request, socket) => socket.destroy());
  inner.on('upgrade', (_request, socket) => socket.destroy());
  const tls = createTlsServer(
    {
      key: input.tls.privateKey,
      cert: input.tls.certificate,
      minVersion: 'TLSv1.2',
      ALPNProtocols: ['http/1.1'],
      handshakeTimeout: 10_000,
    },
    secure => {
      if (
        typeof secure.servername !== 'string' ||
        secure.servername.toLowerCase().replace(/\.$/, '') !== hostname ||
        signal.aborted
      ) {
        secure.destroy();
        return;
      }
      secure.on('error', () => client.destroy());
      inner.emit('connection', secure);
    }
  );
  tls.on('tlsClientError', () => client.destroy());
  client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if (head.length) client.unshift(head);
  tls.emit('connection', client);
  client.resume();
}
