import { CLOUD_AGENT_SESSION_SYNC_ORIGIN } from '@kilocode/worker-utils/cloud-agent-session-sync';
import { egressDomainSchema } from '@kilocode/worker-utils/egress-allowlist';
import type { SandboxContainers } from '../sandbox-containers/SandboxContainers.js';
import { isAllowedEgressUrl } from '../sandbox-control/egress-policy.js';
import { EgressAuditRequestSchema } from '../shared/egress-audit.js';
import type { Env } from '../types.js';
import { withDORetry } from '../utils/do-retry.js';

const SESSION_SYNC_HOSTNAME = new URL(CLOUD_AGENT_SESSION_SYNC_ORIGIN).hostname;

type EgressAuditStoreStub = Pick<DurableObjectStub<SandboxContainers>, 'recordEgressRequest'>;

/**
 * The egress audit store of one logical sandbox. The rows live in the
 * `SandboxContainers` object named by the logical sandbox id, for every
 * provider: the store is per logical sandbox and provider-neutral in use, and
 * that object starts no container for these calls. A Containers outbound
 * handler knows only the object id; the other callers know the logical id.
 * Both name the same object.
 */
export function egressAuditStore(
  env: Pick<Env, 'SANDBOX_CONTAINERS'>,
  sandbox: { containerId: string } | { logicalSandboxId: string }
): DurableObjectStub<SandboxContainers> {
  const namespace = env.SANDBOX_CONTAINERS;
  return 'containerId' in sandbox
    ? namespace.get(namespace.idFromString(sandbox.containerId))
    : namespace.getByName(sandbox.logicalSandboxId);
}

export type SandboxEgressPolicy = {
  /** The canonical effective allowlist. Without it, every destination is allowed. */
  allowlist?: readonly string[];
  /** Records one audit row for each request before the allowlist decision is applied. */
  audit?: { allocationRef: string; store: () => EgressAuditStoreStub };
};

/**
 * The shared egress proxy core of every transport: the allowlist check, the
 * audit record, the upstream `Host` and redirect rules, and the Session Sync
 * binding. `next` is the transport's last step, which sends the request.
 */
export async function proxySandboxEgress(
  request: Request,
  env: Pick<Env, 'SESSION_SYNC'>,
  policy: SandboxEgressPolicy,
  next: (request: Request) => Promise<Response>
): Promise<Response> {
  const url = new URL(request.url);
  const allowed = policy.allowlist === undefined || isAllowedEgressUrl(url, policy.allowlist);
  if (policy.audit !== undefined) {
    const audit = policy.audit;
    try {
      const input = EgressAuditRequestSchema.parse({
        requestId: crypto.randomUUID(),
        allocationRef: audit.allocationRef,
        timestamp: new Date().toISOString(),
        method: request.method.slice(0, 32),
        hostname: url.hostname.slice(0, 253).replace(/[^a-zA-Z0-9._:[\]-]/g, '_'),
        protocol: url.protocol,
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
        decision: allowed ? 'allowed' : 'denied',
      });
      await withDORetry(
        audit.store,
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
  if (!allowed) return new Response('Egress destination disallowed', { status: 403 });
  if (policy.audit !== undefined || policy.allowlist !== undefined) {
    const headers = new Headers(request.headers);
    if (policy.allowlist !== undefined) headers.set('Host', url.host);
    request = new Request(request, { headers, redirect: 'manual' });
  }
  // Match the allowlist's canonical form so `session-sync.kiloapps.io.` cannot skip the binding.
  if (egressDomainSchema.safeParse(url.hostname).data === SESSION_SYNC_HOSTNAME) {
    // The runtime handle must reach Session Sync only through its binding.
    if (url.origin !== CLOUD_AGENT_SESSION_SYNC_ORIGIN) {
      return new Response('Session Sync requires HTTPS', { status: 403 });
    }
    if (!env.SESSION_SYNC) {
      return Response.json(
        { error: { code: 'auth_unavailable', retryable: true } },
        { status: 503 }
      );
    }
    return env.SESSION_SYNC.fetch(request);
  }
  return next(request);
}
