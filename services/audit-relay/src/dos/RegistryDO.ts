import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import type { StreamHead } from './StreamDO';

export type StreamHeadRecord = StreamHead & { stream: string };

const HEAD_PREFIX = 'head:';
const VERIFIED_CHECKPOINT_KEY = 'verified_checkpoint';

/**
 * One index object for every audit stream: one key per stream holding its newest archived head.
 * The hourly checkpoint reads it, and the verify passes plan from it; the per-stream objects stay
 * the chain authority.
 */
export class RegistryDO extends DurableObject<Env> {
  async recordHead(stream: string, seq: number, hash: string): Promise<void> {
    const key = `${HEAD_PREFIX}${stream}`;
    const current = await this.ctx.storage.get<StreamHead>(key);
    if (current && current.seq >= seq) return;
    // No I/O boundary between this read and write, so the input gate keeps it atomic against a
    // concurrent recordHead for the same stream.
    await this.ctx.storage.put<StreamHead>(key, { seq, hash });
  }

  /** Every stream's head, ordered by stream name. */
  async listStreams(): Promise<StreamHeadRecord[]> {
    const heads = await this.ctx.storage.list<StreamHead>({ prefix: HEAD_PREFIX });
    return [...heads].map(([key, head]) => ({
      stream: key.slice(HEAD_PREFIX.length),
      seq: head.seq,
      hash: head.hash,
    }));
  }

  async recordVerifiedCheckpoint(key: string): Promise<void> {
    await this.ctx.storage.put(VERIFIED_CHECKPOINT_KEY, key);
  }

  async lastVerifiedCheckpoint(): Promise<string | null> {
    return (await this.ctx.storage.get<string>(VERIFIED_CHECKPOINT_KEY)) ?? null;
  }
}

export function getRegistryDOStub(env: Pick<Env, 'AUDIT_REGISTRY'>): DurableObjectStub<RegistryDO> {
  return env.AUDIT_REGISTRY.get(env.AUDIT_REGISTRY.idFromName('registry'));
}
