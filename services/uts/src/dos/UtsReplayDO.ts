import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { readConfig, type Env, type UtsConfig } from '../env';

/**
 * The DPoP `jti` replay check of one grant (design 5.7, RFC 9449 section 11.1). One object per
 * grant, named `<environment>:replay:<grant id>`, in the `eu` jurisdiction like the signers. It
 * keeps each proof's `jti` until the proof can no longer be accepted, in KV storage, and an alarm
 * deletes the expired entries; an object with nothing left deletes all its storage.
 *
 * `consume` awaits only storage calls, which hold the input gate, so no other call of the same
 * object runs between the check and the write.
 */

const REPLAY_NAME_PATTERN =
  /^(production|staging|development):replay:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const KEY_PREFIX = 'jti:';
/** `storage.delete` takes at most 128 keys per call. */
const DELETE_BATCH = 128;

const ConsumeSchema = z.strictObject({
  jti: z.string().regex(/^[\x21-\x7e]{16,128}$/),
  notAfter: z.number().int().positive(),
});
const ExpirySchema = z.number().int().positive();

export type ConsumeResult =
  | { status: 'fresh' }
  | { status: 'replayed' }
  | { status: 'misconfigured'; reason: string };

/** Null for an object this environment may use; otherwise why it is refused. */
function refusalOf(config: UtsConfig, id: DurableObjectId): string | null {
  const match = id.name === undefined ? null : REPLAY_NAME_PATTERN.exec(id.name);
  if (match === null || match[1] !== config.environment) {
    return 'replay object was not created by its grant name';
  }
  const jurisdiction = id.jurisdiction ?? 'none';
  if (jurisdiction !== config.jurisdiction) {
    return `replay object is in jurisdiction ${jurisdiction}, not ${config.jurisdiction}`;
  }
  return null;
}

export class UtsReplayDO extends DurableObject<Env> {
  readonly #refusal: string | null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#refusal = refusalOf(readConfig(env), ctx.id);
  }

  /**
   * Records `jti` until `notAfter` (epoch milliseconds). `replayed` when the same `jti` is still
   * recorded, so a proof is accepted at most once per grant.
   */
  async consume(jti: string, notAfter: number): Promise<ConsumeResult> {
    if (this.#refusal !== null) return { status: 'misconfigured', reason: this.#refusal };
    const input = ConsumeSchema.parse({ jti, notAfter });
    const key = `${KEY_PREFIX}${input.jti}`;
    const seen = ExpirySchema.optional().parse(await this.ctx.storage.get(key));
    if (seen !== undefined && seen > Date.now()) return { status: 'replayed' };
    await this.ctx.storage.put(key, input.notAfter);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(input.notAfter);
    }
    return { status: 'fresh' };
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const expired: string[] = [];
    let next: number | null = null;
    for (const [key, value] of await this.ctx.storage.list({ prefix: KEY_PREFIX })) {
      const expiry = ExpirySchema.parse(value);
      if (expiry <= now) expired.push(key);
      else next = next === null ? expiry : Math.min(next, expiry);
    }
    if (next === null) {
      await this.ctx.storage.deleteAll();
      return;
    }
    for (let start = 0; start < expired.length; start += DELETE_BATCH) {
      await this.ctx.storage.delete(expired.slice(start, start + DELETE_BATCH));
    }
    await this.ctx.storage.setAlarm(next);
  }
}
