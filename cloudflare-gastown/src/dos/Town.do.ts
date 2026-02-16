import { DurableObject } from 'cloudflare:workers';

/**
 * Town DO stub — cross-rig coordination will be implemented in Phase 2 (#215).
 * Exported here so the wrangler migration can register it.
 */
export class TownDO extends DurableObject<Env> {
  async ping(): Promise<string> {
    return 'pong';
  }
}
