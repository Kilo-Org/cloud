import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types.js';

/**
 * Export-only tombstones for retired SDK-backed sandbox classes. Cloudflare
 * rejects a deploy that stops exporting a class with stored instances, so the
 * names stay exported after their bindings and containers are removed.
 *
 * Nothing reaches these classes. The no-op alarm consumes alarms scheduled by
 * stored instances. Classes already removed by a `deleted_classes` migration are
 * not exported.
 */
abstract class RetiredSandboxTombstone extends DurableObject<Env> {
  async alarm(): Promise<void> {}
}

export class SandboxContainment extends RetiredSandboxTombstone {}
export class SandboxSmallContainment extends RetiredSandboxTombstone {}
