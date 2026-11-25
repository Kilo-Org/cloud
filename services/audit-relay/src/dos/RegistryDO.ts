import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import type { StreamHead } from './StreamDO';

export type StreamHeadRecord = StreamHead & { stream: string };

const STREAMS_KEY = 'streams';
const VERIFIED_CHECKPOINT_KEY = 'verified_checkpoint';

/**
 * One index object for every audit stream. The hourly checkpoint reads it, and the daily and
 * monthly verify jobs start from it; the per-stream objects stay the chain authority.
 */
export class RegistryDO extends DurableObject<Env> {
  async recordHead(stream: string, seq: number, hash: string): Promise<void> {
    const streams = await this.readStreams();
    const current = streams[stream];
    if (current && current.seq >= seq) return;
    // Read-modify-write with no I/O boundary between the read and the write: the Durable Object
    // input gate keeps this sequence atomic against a concurrent recordHead.
    await this.ctx.storage.put(STREAMS_KEY, { ...streams, [stream]: { seq, hash } });
  }

  async listStreams(): Promise<StreamHeadRecord[]> {
    const streams = await this.readStreams();
    return Object.entries(streams)
      .map(([stream, head]) => ({ stream, seq: head.seq, hash: head.hash }))
      .sort((left, right) =>
        left.stream < right.stream ? -1 : left.stream > right.stream ? 1 : 0
      );
  }

  async recordVerifiedCheckpoint(key: string): Promise<void> {
    await this.ctx.storage.put(VERIFIED_CHECKPOINT_KEY, key);
  }

  async lastVerifiedCheckpoint(): Promise<string | null> {
    return (await this.ctx.storage.get<string>(VERIFIED_CHECKPOINT_KEY)) ?? null;
  }

  private async readStreams(): Promise<Record<string, StreamHead>> {
    return (await this.ctx.storage.get<Record<string, StreamHead>>(STREAMS_KEY)) ?? {};
  }
}

export function getRegistryDOStub(env: Pick<Env, 'AUDIT_REGISTRY'>): DurableObjectStub<RegistryDO> {
  return env.AUDIT_REGISTRY.get(env.AUDIT_REGISTRY.idFromName('registry'));
}
