import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildEgressAuditRequest } from '@kilocode/worker-utils/egress-audit';
import { parseProxyAuthorization, type ControlPlaneClient } from './control-plane.js';
import type { createPolicyRegistry, PolicyLease } from './policies.js';

export async function denyPlainHttp(
  request: IncomingMessage,
  response: ServerResponse,
  input: {
    control: ControlPlaneClient;
    registry: Pick<ReturnType<typeof createPolicyRegistry>, 'acquire'>;
  }
) {
  const token = parseProxyAuthorization(request.headers['proxy-authorization']);
  if (!token) {
    response
      .writeHead(407, { Connection: 'close', 'Proxy-Authenticate': 'Basic realm="kilo"' })
      .end();
    return;
  }
  const controller = new AbortController();
  request.socket.once('close', () => controller.abort());
  let lease: PolicyLease | undefined;
  try {
    const url = new URL(request.url ?? '');
    if (
      url.protocol !== 'http:' ||
      url.username ||
      url.password ||
      (request.url?.length ?? 0) > 16_384
    )
      throw new Error('Invalid HTTP target');
    lease = await input.registry.acquire(
      token,
      url.hostname,
      () => response.destroy(),
      controller.signal
    );
    const policy = lease.policy();
    if (policy.audit)
      await input.control.recordAudit(
        token,
        buildEgressAuditRequest({
          requestId: crypto.randomUUID(),
          allocationRef: policy.allocationRef,
          timestamp: new Date().toISOString(),
          method: request.method ?? 'GET',
          url,
          decision: 'denied',
        }),
        controller.signal
      );
    lease.policy();
    response.writeHead(403, { Connection: 'close' }).end('HTTPS CONNECT required');
  } catch {
    response.writeHead(503, { Connection: 'close' }).end();
  } finally {
    lease?.release();
  }
}
