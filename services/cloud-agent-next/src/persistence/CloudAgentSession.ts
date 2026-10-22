import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types.js';

/**
 * Retired legacy `agent_*` session class. Cloudflare rejects a deploy that
 * stops exporting a class with stored instances, so the export stays until a
 * `deleted_classes` migration removes the class and its storage. No binding
 * reaches it; the no-op alarm consumes alarms that legacy instances scheduled.
 */
export class CloudAgentSession extends DurableObject<Env> {
  async alarm(): Promise<void> {}
}
