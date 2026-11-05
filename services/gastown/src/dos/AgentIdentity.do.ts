import { retryable } from 'cloudflare:durable-objects';
import { DurableObject } from 'cloudflare:workers';

/**
 * Agent Identity DO stub — agent CVs and performance analytics
 * will be implemented in Phase 3 (#224).
 * Exported here so the wrangler migration can register it.
 */
export class AgentIdentityDO extends DurableObject<Env> {
  static {
    /* oxlint-disable typescript/unbound-method -- Cloudflare marks original prototype functions without invoking them. */
    retryable(this.prototype.ping);
    /* oxlint-enable typescript/unbound-method */
  }
  async ping(): Promise<string> {
    return 'pong';
  }
}

export function getAgentIdentityDOStub(env: Env, agentIdentity: string) {
  return env.AGENT_IDENTITY.get(env.AGENT_IDENTITY.idFromName(agentIdentity));
}
