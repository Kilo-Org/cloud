import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { createServer as createTlsServer } from 'node:tls';
import { buildEgressAuditRequest } from '@kilocode/worker-utils/egress-audit';
import { incomingRequest, sendHttpResponse } from './http-message.js';
import type { ControlPlaneClient } from './control-plane.js';
import type { AwsEgressPolicy } from '@kilocode/worker-utils/aws-egress';
import { permitted, intercepted, type PolicyLease } from './policies.js';
import type { HostTlsMaterial } from './host-certificates.js';

type AuthorizedTls = {
  client: Socket;
  head: Buffer;
  hostname: string;
  token: string;
  lease: PolicyLease;
  signal: AbortSignal;
  control: ControlPlaneClient;
  tls: HostTlsMaterial;
};

export function acceptScmTls(input: AuthorizedTls) {
  acceptAuthorizedTls(input, {
    authorized: policy => intercepted(policy, input.hostname),
    forward: request => input.control.forwardScm(input.token, request, input.signal),
  });
}

export function acceptAuthorizedTls(
  input: AuthorizedTls,
  transport: {
    authorized(policy: AwsEgressPolicy): boolean;
    forward(request: Request): Promise<Response>;
    upgrade?(this: void, request: IncomingMessage, target: URL, socket: Duplex, head: Buffer): void;
  }
) {
  const { client, head, hostname, token, lease, signal } = input;
  client.setTimeout(120_000);
  let busy = false;
  async function admit(request: IncomingMessage) {
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
          ['host', 'authorization', 'private-token'].includes(request.rawHeaders[i].toLowerCase())
      ).length >
        [host, request.headers.authorization, request.headers['private-token']].filter(
          value => value !== undefined
        ).length
    )
      return null;
    busy = true;
    const policy = await lease.refresh();
    if (!transport.authorized(policy) || !permitted(policy, hostname) || client.destroyed)
      return null;
    const target = new URL(request.url, `https://${hostname}`);
    if (target.hostname !== hostname) return null;
    if (policy.audit) {
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
    }
    lease.policy();
    return target;
  }
  const inner = createHttpServer(
    { maxHeaderSize: 32_768, insecureHTTPParser: false },
    (request, response) => {
      void (async () => {
        const target = await admit(request);
        if (!target) {
          response.writeHead(403, { Connection: 'close' }).end();
          client.destroy();
          return;
        }
        const upstream = await transport.forward(incomingRequest(request, target, signal));
        sendHttpResponse(upstream, response, signal);
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
  inner.on('upgrade', (request, socket, firstBytes) => {
    if (!transport.upgrade) {
      socket.destroy();
      return;
    }
    socket.pause();
    const upgrade = transport.upgrade;
    void admit(request)
      .then(target => {
        if (!target) socket.destroy();
        else upgrade(request, target, socket, firstBytes);
      })
      .catch(() => socket.destroy());
  });
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
  // TLS reads the buffered ClientHello when it takes ownership of the raw socket.
  if (head.length) client.unshift(head);
  tls.emit('connection', client);
}
