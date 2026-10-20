import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleManagedScmOutbound } from '../sandbox-outbound.js';
import { getSentryConfig } from '../shared/sentry.js';
import { isAllowedEgressUrl, nativeEgressAllowlistSchema } from './egress-policy.js';

export type ContainersOutboundProps = { containerId: string; egressAllowlist?: string[] };

export class ContainersOutbound extends WorkerEntrypoint<
  Cloudflare.Env & Parameters<typeof getSentryConfig>[0],
  ContainersOutboundProps
> {
  fetch(request: Request): Promise<Response> {
    const { containerId, egressAllowlist } = this.ctx.props;
    if (!containerId) {
      return Promise.resolve(new Response('SCM authorization unavailable', { status: 502 }));
    }
    if (egressAllowlist !== undefined) {
      const policy = nativeEgressAllowlistSchema.safeParse(egressAllowlist);
      if (!policy.success) {
        return Promise.resolve(new Response('Egress policy unavailable', { status: 502 }));
      }
      const url = new URL(request.url);
      if (!isAllowedEgressUrl(url, policy.data)) {
        const sentry = getSentryConfig(this.env);
        const dsn = sentry ? new URL(sentry.dsn) : undefined;
        if (
          !dsn ||
          request.method !== 'POST' ||
          url.origin !== dsn.origin ||
          url.username ||
          url.password ||
          url.pathname !== `/api${dsn.pathname}/envelope/`
        ) {
          return Promise.resolve(new Response('Egress destination disallowed', { status: 403 }));
        }
      }
      const headers = new Headers(request.headers);
      headers.set('Host', url.host);
      request = new Request(request, { headers, redirect: 'manual' });
    }
    return handleManagedScmOutbound(request, this.env, { containerId });
  }
}
