import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleManagedScmOutbound } from '../sandbox-outbound.js';
import { EgressAuditRequestSchema } from '../shared/egress-audit.js';
import { getSentryConfig } from '../shared/sentry.js';
import { nativeEgressAllowlistSchema } from '../sandbox-control/egress-policy.js';
import { egressAuditStore, proxySandboxEgress } from '../egress/sandbox-egress.js';

type SentryEnv = Parameters<typeof getSentryConfig>[0];

/** The configured Sentry envelope endpoint, which the runtime may reach in every egress mode. */
function trustedSentryEnvelopeHostname(request: Request, env: SentryEnv): string | undefined {
  const sentry = getSentryConfig(env);
  if (!sentry || request.method !== 'POST') return undefined;
  const dsn = new URL(sentry.dsn);
  const url = new URL(request.url);
  return url.origin === dsn.origin &&
    !url.username &&
    !url.password &&
    url.pathname === `/api${dsn.pathname}/envelope/`
    ? dsn.hostname
    : undefined;
}

export type ContainersOutboundProps = {
  containerId: string;
  egressAllowlist?: string[];
  egressAudit?: boolean;
  allocationRef?: string;
};

export class ContainersOutbound extends WorkerEntrypoint<
  Cloudflare.Env & SentryEnv,
  ContainersOutboundProps
> {
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
    const sentryHostname =
      policy.data === undefined ? undefined : trustedSentryEnvelopeHostname(request, this.env);
    // The pinned allowlist stays unchanged; only this request may reach the envelope host.
    const allowlist =
      policy.data === undefined || sentryHostname === undefined
        ? policy.data
        : (nativeEgressAllowlistSchema.safeParse([...policy.data, sentryHostname]).data ??
          policy.data);
    return proxySandboxEgress(
      request,
      this.env,
      {
        ...(allowlist === undefined ? {} : { allowlist }),
        ...(egressAudit === true && allocationRef !== undefined
          ? {
              audit: {
                allocationRef,
                store: () => egressAuditStore(this.env, { containerId }),
              },
            }
          : {}),
      },
      upstream => handleManagedScmOutbound(upstream, this.env, { containerId })
    );
  }
}
