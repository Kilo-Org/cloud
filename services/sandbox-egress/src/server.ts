import { createServer as createHttpServer } from 'node:http';
import { Socket } from 'node:net';
import { buildEgressAuditRequest } from '@kilocode/worker-utils/egress-audit';
import type { ControlPlaneClient } from './control-plane.js';
import { EgressTransportError } from './destination.js';
import { createPolicyRegistry, permitted, intercepted, type PolicyLease } from './policies.js';
import type { PublicResolver } from './https-transport.js';
import type { ProxyMaterial } from './deployment.js';
import { denyPlainHttp } from './plain-http.js';
import { connectIdentity, admitConnect } from './connect-admission.js';
import { openTunnel, refuseConnect } from './tunnel.js';
import { openScmTunnel } from './scm-intercept.js';

/** Explicit HTTPS proxy. The outer CONNECT authority owns tunnel admission; only managed SCM is opened. */
export function createEgressServer(input: {
  control: ControlPlaneClient;
  resolve: PublicResolver;
  tls: ProxyMaterial['tls'];
  expiresAt: number;
  maxConnections?: number;
}) {
  const sockets = new Set<Socket>();
  const registry = createPolicyRegistry({
    load: (token, signal) => input.control.loadPolicy(token, signal),
  });
  let draining = false;
  const server = createHttpServer(
    { maxHeaderSize: 16_384, insecureHTTPParser: false },
    (request, response) => {
      if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(!draining && input.expiresAt > Date.now() ? 200 : 503).end();
        return;
      }
      void denyPlainHttp(request, response, { control: input.control, registry });
    }
  );
  server.maxHeadersCount = 32;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.on('connection', socket => {
    if (draining || sockets.size >= (input.maxConnections ?? 256)) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setTimeout(20_000, () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {
      /* Transport errors never include request or credential data in logs. */
    });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('connect', (request, rawSocket, head) => {
    if (!(rawSocket instanceof Socket)) {
      rawSocket.destroy();
      return;
    }
    const client = rawSocket;
    client.pause();
    const controller = new AbortController();
    let lease: PolicyLease | undefined;
    client.once('close', () => {
      controller.abort();
      lease?.release();
    });
    const identity = connectIdentity(request);
    if (identity.kind === 'refuse') {
      refuseConnect(client, identity.status);
      return;
    }
    const { hostname, token } = identity.identity;
    const signal = controller.signal;
    const proof = token;
    async function audit(decision: 'allowed' | 'denied') {
      if (!lease) throw new Error('Policy unavailable');
      const policy = lease.policy();
      if (!policy.audit) return;
      await input.control.recordAudit(
        proof,
        buildEgressAuditRequest({
          requestId: crypto.randomUUID(),
          allocationRef: policy.allocationRef,
          timestamp: new Date().toISOString(),
          method: 'CONNECT',
          scope: 'connection',
          url: new URL(`https://${hostname}/`),
          decision,
        }),
        signal
      );
    }
    void (async () => {
      if (draining || input.expiresAt <= Date.now()) throw new Error('Proxy unavailable');
      lease = await registry.acquire(token, hostname, () => client.destroy(), signal);
      const decision = await admitConnect({
        hostname,
        policy: lease.policy(),
        resolve: input.resolve,
        signal,
      });
      if (decision.kind === 'refuse') {
        await audit('denied');
        refuseConnect(client, 403);
        return;
      }
      const opensTls = decision.kind === 'intercept';
      await audit('allowed');
      if (
        client.destroyed ||
        !permitted(lease.policy(), hostname) ||
        intercepted(lease.policy(), hostname) !== opensTls
      ) {
        client.destroy();
        return;
      }
      if (opensTls) {
        openScmTunnel({
          client,
          head,
          hostname,
          token,
          lease,
          signal,
          control: input.control,
          tls: input.tls,
        });
        return;
      }
      if (decision.kind === 'tunnel')
        openTunnel({ client, head, address: decision.address, lease, signal });
    })().catch(error => {
      refuseConnect(
        client,
        error instanceof EgressTransportError && error.code === 'destination_denied' ? 403 : 503
      );
    });
  });

  return {
    server,
    close() {
      draining = true;
      registry.close();
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
