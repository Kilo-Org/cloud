import { createServer, type IncomingMessage } from 'node:http';
import { egressDomainSchema } from '@kilocode/worker-utils/egress-allowlist';
import { buildEgressAuditRequest } from '@kilocode/worker-utils/egress-audit';
import type { ControlPlaneClient } from './control-plane.js';
import { admitConnect } from './connect-admission.js';
import { incomingRequest, sendHttpResponse } from './http-message.js';
import { fetchHttpAtAddress, type PublicResolver } from './https-transport.js';
import { createPolicyRegistry, intercepted, permitted, type PolicyLease } from './policies.js';

function originTarget(request: IncomingMessage) {
  const authority = /^([A-Za-z0-9.-]+)(?::80)?$/.exec(request.headers.host ?? '');
  if (
    !authority ||
    request.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === 'host')
      .length !== 1 ||
    !request.url?.startsWith('/') ||
    request.url.startsWith('//') ||
    /[\\#]/.test(request.url) ||
    request.url.length > 16_384
  )
    return undefined;
  const hostname = egressDomainSchema.safeParse(authority[1]).data;
  return hostname ? new URL(request.url, `http://${hostname}`) : undefined;
}

/** Accept direct HTTP only from the firewall-owned bridge. Managed SCM requires HTTPS. */
export function createTransparentHttpServer(input: {
  control: ControlPlaneClient;
  token: string;
  resolve: PublicResolver;
  expiresAt: number;
  forward?: typeof fetchHttpAtAddress;
}) {
  const registry = createPolicyRegistry({
    load: (token, signal) => input.control.loadPolicy(token, signal),
    maxEntries: 1,
  });
  const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    response.shouldKeepAlive = false;
    const close = (code: number) => response.writeHead(code, { Connection: 'close' }).end();
    const url = originTarget(request);
    if (!url) {
      close(400);
      return;
    }
    if (input.expiresAt <= Date.now()) {
      close(503);
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    let lease: PolicyLease | undefined;
    response.once('close', () => {
      controller.abort();
      lease?.release();
    });
    void (async () => {
      lease = await registry.acquire(input.token, url.hostname, () => response.destroy(), signal);
      const decision = await admitConnect({
        hostname: url.hostname,
        policy: lease.policy(),
        resolve: input.resolve,
        signal,
      });
      const policy = lease.policy();
      const allowed = decision.kind === 'tunnel';
      if (policy.audit)
        await input.control.recordAudit(
          input.token,
          buildEgressAuditRequest({
            requestId: crypto.randomUUID(),
            allocationRef: policy.allocationRef,
            timestamp: new Date().toISOString(),
            method: request.method ?? 'GET',
            url,
            decision: allowed ? 'allowed' : 'denied',
          }),
          signal
        );
      const current = lease.policy();
      if (signal.aborted) return;
      if (!allowed || !permitted(current, url.hostname) || intercepted(current, url.hostname)) {
        close(403);
        return;
      }
      const upstream = await (input.forward ?? fetchHttpAtAddress)(
        incomingRequest(request, url, signal),
        decision.address
      );
      sendHttpResponse(upstream, response, signal);
    })().catch(() => {
      if (!response.headersSent && !response.destroyed) close(503);
      else response.destroy();
    });
  });
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 1;
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  return {
    server,
    close() {
      registry.close();
      server.close();
      server.closeAllConnections();
    },
  };
}
