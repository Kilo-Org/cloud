import { DurableObject } from 'cloudflare:workers';

/**
 * Agent Identity DO stub — agent CVs and performance analytics
 * will be implemented in Phase 3 (#224).
 * Exported here so the wrangler migration can register it.
 */
export class AgentIdentityDO extends DurableObject<Env> {
  async ping(): Promise<string> {
    return 'pong';
  }
}
