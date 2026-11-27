import { createServer, type Socket } from 'node:net';
import { buildEgressAuditRequest } from '@kilocode/worker-utils/egress-audit';
import type { ControlPlaneClient } from './control-plane.js';
import type { HostTlsMaterial } from './host-certificates.js';
import {
  fetchAtAddress,
  type HttpsRequestFactory,
  type PublicResolver,
} from './https-transport.js';
import { stripTestAccessResponse, type Ec2TestAccess } from './ec2-test-access.js';
import { admitConnect } from './connect-admission.js';
import { acceptAuthorizedTls, acceptScmTls } from './scm-intercept.js';
import { readTlsClientHello } from './tls-client-hello.js';
import { openTransparentTunnel } from './tunnel.js';
import { createPolicyRegistry, intercepted, permitted, type PolicyLease } from './policies.js';
import { openWebSocketAtAddress } from './websocket-at-address.js';

type PublicTlsConnection = {
  client: Socket;
  hostname: string;
  head: Buffer;
  address: string;
  lease: PolicyLease;
  signal: AbortSignal;
};

/** The host firewall is the listener's admission boundary. One host has one allocation proof. */
type TransparentTlsOptions = {
  control: ControlPlaneClient;
  token: string;
  resolve: PublicResolver;
  expiresAt: number;
  certificate(hostname: string): Promise<HostTlsMaterial>;
  testAccess?: Ec2TestAccess;
  send?: HttpsRequestFactory;
};

export function createTransparentTlsServer(input: TransparentTlsOptions) {
  const registry = createPolicyRegistry({
    load: (token, signal) => input.control.loadPolicy(token, signal),
    maxEntries: 1,
  });
  const clients = new Set<Socket>();
  const server = createServer({ pauseOnConnect: true }, client => {
    if (clients.size >= 64 || input.expiresAt <= Date.now()) {
      client.destroy();
      return;
    }
    clients.add(client);
    const controller = new AbortController();
    const { signal } = controller;
    let lease: PolicyLease | undefined;
    client.setTimeout(15_000, () => client.destroy());
    client.on('error', () => client.destroy());
    client.on('close', () => {
      controller.abort();
      lease?.release();
      clients.delete(client);
    });
    void (async () => {
      const { hostname, head } = await readTlsClientHello(
        client,
        AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      );
      lease = await registry.acquire(input.token, hostname, () => client.destroy(), signal);
      const decision = await admitConnect({
        hostname,
        policy: lease.policy(),
        resolve: input.resolve,
        signal,
      });
      const policy = lease.policy();
      if (policy.audit) {
        await input.control.recordAudit(
          input.token,
          buildEgressAuditRequest({
            requestId: crypto.randomUUID(),
            allocationRef: policy.allocationRef,
            timestamp: new Date().toISOString(),
            method: 'CONNECT',
            scope: 'connection',
            url: new URL(`https://${hostname}/`),
            decision: decision.kind === 'refuse' ? 'denied' : 'allowed',
          }),
          signal
        );
      }
      const current = lease.policy();
      if (
        decision.kind === 'refuse' ||
        client.destroyed ||
        !permitted(current, hostname) ||
        intercepted(current, hostname) !== (decision.kind === 'intercept')
      ) {
        client.destroy();
        return;
      }
      const connection = { client, head, hostname, lease, signal };
      if (decision.kind === 'intercept') {
        const tls = await input.certificate(hostname);
        if (!client.destroyed)
          acceptScmTls({ ...connection, token: input.token, control: input.control, tls });
        return;
      }
      const testAccess = input.testAccess?.hostname === hostname ? input.testAccess : undefined;
      if (current.allowlist !== undefined || testAccess) {
        const tls = await input.certificate(hostname);
        if (!client.destroyed)
          acceptRestrictedTls(
            { ...connection, address: decision.address },
            { control: input.control, token: input.token, send: input.send, testAccess },
            tls
          );
        return;
      }
      openTransparentTunnel({ ...connection, address: decision.address });
    })().catch(() => client.destroy());
  });
  server.maxConnections = 64;
  return {
    server,
    close() {
      registry.close();
      for (const client of clients) client.destroy();
      server.close();
    },
  };
}

function acceptRestrictedTls(
  connection: PublicTlsConnection,
  input: Pick<TransparentTlsOptions, 'control' | 'token' | 'send' | 'testAccess'>,
  tls: HostTlsMaterial
) {
  const { control, token, send, testAccess } = input;
  acceptAuthorizedTls(
    { ...connection, control, token, tls },
    {
      authorized: policy =>
        (policy.allowlist !== undefined || testAccess !== undefined) &&
        !intercepted(policy, connection.hostname),
      forward: async request => {
        if (
          testAccess &&
          !testAccess.authorizeWorkload(new URL(request.url), request.method, request.headers)
        )
          return new Response(null, { status: 403 });
        const response = await fetchAtAddress(request, connection.address, send);
        return testAccess ? stripTestAccessResponse(response) : response;
      },
      upgrade: (request, target, socket, head) =>
        openWebSocketAtAddress({
          request,
          target,
          socket,
          head,
          address: connection.address,
          signal: connection.signal,
          send,
          testAccess,
        }),
    }
  );
}
