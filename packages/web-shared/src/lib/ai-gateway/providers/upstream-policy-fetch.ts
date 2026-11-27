import type { Dispatcher } from 'undici';
import { upstreamDispatcherFor } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-connection';
import {
  findUpstreamUrlViolation,
  isUpstreamUrlPolicyEnforced,
  type UpstreamUrlViolation,
} from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-url-policy';

/** The upstream URL policy refused the request; nothing was sent, or a redirect was not followed. */
export class UpstreamUrlPolicyError extends Error {
  constructor(readonly rejection: UpstreamUrlViolation | 'redirect') {
    super(`The upstream URL policy refused the request: ${rejection}`);
    this.name = 'UpstreamUrlPolicyError';
  }
}

/**
 * Fetches a URL that an organization or user configured, under the same policy as gateway upstream
 * requests (see upstream-url-policy.ts): where the policy is enforced, a refused URL is never
 * dialed and the connection goes to the addresses the policy checked. A redirect is refused rather
 * than followed, because it could point anywhere.
 */
export async function fetchWithUpstreamUrlPolicy(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  let dispatcher: Dispatcher | undefined;
  if (isUpstreamUrlPolicyEnforced()) {
    const decision = await findUpstreamUrlViolation(url, { signal: init.signal ?? undefined });
    if (!decision.allowed) throw new UpstreamUrlPolicyError(decision.violation);
    dispatcher = upstreamDispatcherFor(decision.hostname, decision.addresses, decision.expiresAt);
  }
  const requestInit: RequestInit & { dispatcher?: Dispatcher } = {
    ...init,
    redirect: 'manual',
    ...(dispatcher ? { dispatcher } : {}),
  };
  const response = await fetch(url, requestInit);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamUrlPolicyError('redirect');
  }
  return response;
}
