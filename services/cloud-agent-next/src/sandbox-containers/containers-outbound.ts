import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleManagedScmOutbound } from '../sandbox-outbound.js';
import { withDORetry } from '../utils/do-retry.js';
import { EgressAuditRequestSchema } from '../shared/egress-audit.js';
import { isAllowedEgressUrl, nativeEgressAllowlistSchema } from './egress-policy.js';

export type ContainersOutboundProps = {
  containerId: string;
  egressAllowlist?: string[];
  egressAudit?: boolean;
  allocationRef?: string;
};

export class ContainersOutbound extends WorkerEntrypoint<Cloudflare.Env, ContainersOutboundProps> {
  async fetch(request: Request): Promise<Response> {
    const { containerId, egressAllowlist, egressAudit, allocationRef } = this.ctx.props;
    if (
      (egressAudit !== undefined && typeof egressAudit !== 'boolean') ||
      (egressAudit === true &&
        !EgressAuditRequestSchema.shape.allocationRef.safeParse(allocationRef).success)
    ) {
      return new Response('Egress audit unavailable', { status: 502 });
    }
    if (!containerId) {
      return new Response('SCM authorization unavailable', { status: 502 });
    }
    const policy = nativeEgressAllowlistSchema.optional().safeParse(egressAllowlist);
    if (!policy.success) {
      return new Response('Egress policy unavailable', { status: 502 });
    }
    const url = new URL(request.url);
    const allowed = policy.data === undefined || isAllowedEgressUrl(url, policy.data);
    if (egressAudit === true) {
      try {
        const input = EgressAuditRequestSchema.parse({
          requestId: crypto.randomUUID(),
          allocationRef,
          timestamp: new Date().toISOString(),
          method: request.method.slice(0, 32),
          hostname: url.hostname.slice(0, 253).replace(/[^a-zA-Z0-9._:[\]-]/g, '_'),
          protocol: url.protocol,
          port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
          decision: allowed ? 'allowed' : 'denied',
        });
        await withDORetry(
          () =>
            this.env.SANDBOX_CONTAINERS.get(this.env.SANDBOX_CONTAINERS.idFromString(containerId)),
          async stub => {
            try {
              await stub.recordEgressRequest(input);
            } catch (error) {
              throw Object.assign(new Error('Egress audit persistence failed'), {
                retryable: error instanceof Error && Reflect.get(error, 'retryable') === true,
              });
            }
          },
          'recordEgressRequest',
          {
            maxAttempts: 3,
            baseBackoffMs: 100,
            maxBackoffMs: 500,
            scope: { deadlineAt: Date.now() + 5_000 },
          }
        );
      } catch {
        return new Response('Egress audit unavailable', { status: 502 });
      }
    }
    if (policy.data !== undefined) {
      if (!allowed) return new Response('Egress destination disallowed', { status: 403 });
      const headers = new Headers(request.headers);
      headers.set('Host', url.host);
      request = new Request(request, { headers, redirect: 'manual' });
    }
    return handleManagedScmOutbound(request, this.env, { containerId });
  }
}
