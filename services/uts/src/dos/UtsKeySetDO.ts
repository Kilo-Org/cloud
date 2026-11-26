import type { SignerKeysAnswer } from '@kilocode/uts-contracts';
import { DurableObject } from 'cloudflare:workers';
import { readConfig, type Env, type UtsConfig } from '../env';
import {
  newSignerKeysCache,
  readSignerObjects,
  signerKeysAnswer,
  type SignerKeysCache,
} from '../signer-keys';
import { dataCenter } from './data-center';
import { keySetShardOfObjectId } from './stubs';

/**
 * A refused shard (wrong name or jurisdiction) answers every call with `misconfigured`: a deploy
 * error that no retry fixes.
 */
export type KeySetShardResult =
  | { status: 'ok'; answer: SignerKeysAnswer }
  | { status: 'misconfigured'; reason: string };

type Phase =
  | { status: 'serving'; shard: number; cache: SignerKeysCache; logged: boolean }
  | { status: 'refused'; reason: string };

/**
 * One of the 8 key-set shards (design 5.7), named `<environment>:keyset:<0-7>`, in the `eu`
 * jurisdiction with the western-Europe hint. Each `SignerKeys` isolate asks one shard, so the 16
 * signer objects see at most 8 reads per 2 seconds, whatever the number of feed isolates
 * (design 3). The shard keeps the 2-second combined copy and each signer's held keys as plain
 * data in memory and stores nothing: a restarted shard reads the signers again, and the feed
 * Worker keeps its own held keys. Workers RPC exposes every public method of the class, so the
 * only public member is the RPC method `signerKeys`.
 */
export class UtsKeySetDO extends DurableObject<Env> {
  readonly #config: UtsConfig;
  readonly #phase: Phase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#config = readConfig(env);
    const id = keySetShardOfObjectId(this.#config, ctx.id);
    if (id.status === 'refused') {
      console.error(JSON.stringify({ event: 'uts.key_set_shard.refused', reason: id.reason }));
      this.#phase = id;
    } else {
      this.#phase = {
        status: 'serving',
        shard: id.index,
        cache: newSignerKeysCache(),
        logged: false,
      };
    }
  }

  /** Every signer's keys: the shard's copy while under 2 seconds old, else a new read. */
  async signerKeys(): Promise<KeySetShardResult> {
    const phase = this.#phase;
    if (phase.status === 'refused') return { status: 'misconfigured', reason: phase.reason };
    if (!phase.logged) {
      phase.logged = true;
      this.ctx.waitUntil(this.#logStarted(phase.shard));
    }
    const answer = await signerKeysAnswer(phase.cache, startedAt =>
      readSignerObjects(this.env, this.#config, startedAt)
    );
    return { status: 'ok', answer };
  }

  /** Records where this shard runs, once per start (design 5.7 proof run). */
  async #logStarted(shard: number): Promise<void> {
    console.log(
      JSON.stringify({
        event: 'uts.key_set_shard.started',
        shard,
        jurisdiction: this.#config.jurisdiction,
        colo: this.#config.jurisdiction === 'none' ? null : await dataCenter(),
      })
    );
  }
}
