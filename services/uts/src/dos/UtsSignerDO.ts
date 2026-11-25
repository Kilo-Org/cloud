import type { SignerPublicKeys } from '@kilocode/uts-contracts';
import { DurableObject } from 'cloudflare:workers';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { readConfig, type Env, type UtsConfig } from '../env';
import {
  SignableClaimsSchema,
  UTS_MAX_TOKEN_LIFETIME_SECONDS,
  UTS_TOKEN_ALG,
  UTS_TOKEN_TYPE,
  type SignableClaims,
} from '../keys/claims';
import { generateSigningKey, importSigningKey } from '../keys/ed25519';
import {
  advance,
  bootstrapState,
  nextChangeAt,
  publishedKeys,
  removeKey,
  SignerStateSchema,
  type KidRemoval,
  type SignerState,
} from '../keys/lifecycle';
import { signerOfObjectId } from './stubs';

/**
 * KV storage key of the whole signer state. Key material lives in KV storage, not in SQL rows: a
 * Workers trace records each SQL statement's bound values, while a KV get or put records the key
 * name only (`services/sts/src/crypto/key-store.ts`).
 */
const STATE_KEY = 'signer-state';

/** Design 7 allows 60 seconds of clock skew on `iat`. */
const IAT_SKEW_SECONDS = 60;

export type SignRefusal =
  | 'invalid_claims'
  | 'issuer_mismatch'
  | 'environment_mismatch'
  | 'issued_at_out_of_range'
  | 'expires_too_late';

export type SignResult =
  | { status: 'signed'; kid: string; token: string }
  | { status: 'refused'; reason: SignRefusal };

export type RemoveKidResult =
  | { status: 'removed'; removal: KidRemoval }
  | { status: 'unknown_kid' };

type Loaded = { state: SignerState; signingKey: CryptoKey };

/** Loading runs once per start, before any call; a refused object never creates keys. */
type Phase =
  | { status: 'loading' }
  | { status: 'refused'; reason: string }
  | ({ status: 'ready' } & Loaded);

const KidSchema = z.string().min(1);

/**
 * The Cloudflare data center this object runs in, from the edge trace of an outbound request, or
 * null when the trace does not answer within 2 seconds. A Durable Object never moves, so a signer
 * asks once, when it creates its first keys.
 */
async function dataCenter(): Promise<string | null> {
  try {
    const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
      signal: AbortSignal.timeout(2000),
    });
    return /^colo=([A-Z]{3})$/m.exec(await response.text())?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * One of the 16 UTS token signers (design 5.7). It generates its own Ed25519 keys, keeps them in
 * its own storage, never exports a private key over any method, and publishes the public halves
 * under their own `kid`s. An alarm rotates the signing key every 30 days, publishes the next key
 * 7 days before its first use, and drops a retired key once its window ends.
 */
export class UtsSignerDO extends DurableObject<Env> {
  private readonly config: UtsConfig;
  private phase: Phase = { status: 'loading' };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = readConfig(env);
    // A load that throws (a storage failure) resets the object, and the next call loads again; the
    // catch only keeps that rejection from surfacing as unhandled.
    ctx
      .blockConcurrencyWhile(() => this.load())
      .catch((error: unknown) => {
        console.error(JSON.stringify({ event: 'uts.signer.load_failed', error: String(error) }));
      });
  }

  async publicKeys(): Promise<SignerPublicKeys> {
    const { state } = this.ready();
    return { signer: state.signer, keys: publishedKeys(state) };
  }

  /**
   * Signs one access-token claim set with the current key: compact JWS, header `alg: EdDSA`,
   * `typ: at+jwt`, `kid`. The claim set must name this environment's issuer, be issued now, and
   * expire within the UTS maximum lifetime, which bounds how long a retired key stays published.
   */
  async sign(claims: unknown): Promise<SignResult> {
    const parsed = SignableClaimsSchema.safeParse(claims);
    if (!parsed.success) return { status: 'refused', reason: 'invalid_claims' };
    const nowSeconds = Math.floor(Date.now() / 1000);
    const refusal = this.refusalFor(parsed.data, nowSeconds);
    if (refusal !== null) return { status: 'refused', reason: refusal };
    const { state, signingKey } = this.ready();
    const token = await new SignJWT(parsed.data)
      .setProtectedHeader({ alg: UTS_TOKEN_ALG, typ: UTS_TOKEN_TYPE, kid: state.current.kid })
      .sign(signingKey);
    return { status: 'signed', kid: state.current.kid, token };
  }

  /**
   * Emergency removal of one `kid` from this signer's published keys. An internal operation: only
   * the mint Worker binds this namespace. The result is the entry the revocation feed carries.
   */
  async removeKid(kid: string): Promise<RemoveKidResult> {
    const target = KidSchema.parse(kid);
    return await this.transition<RemoveKidResult>(async (state, now) => {
      const removed = await removeKey(state, target, now, () => generateSigningKey(state.signer));
      if (removed.status === 'unknown_kid') return { state, result: removed };
      return { state: removed.state, result: { status: 'removed', removal: removed.removal } };
    });
  }

  override async alarm(): Promise<void> {
    await this.transition(async (state, now) => ({
      state: await advance(state, now, () => generateSigningKey(state.signer)),
      result: undefined,
    }));
  }

  private refusalFor(claims: SignableClaims, nowSeconds: number): SignRefusal | null {
    if (claims.iss !== this.config.endpoints.issuer) return 'issuer_mismatch';
    if (claims.env !== this.config.environment) return 'environment_mismatch';
    if (Math.abs(claims.iat - nowSeconds) > IAT_SKEW_SECONDS) return 'issued_at_out_of_range';
    if (claims.exp > nowSeconds + UTS_MAX_TOKEN_LIFETIME_SECONDS) return 'expires_too_late';
    return null;
  }

  /** The loaded state; a refused object answers every call with its reason. */
  private ready(): Loaded {
    if (this.phase.status === 'ready') return this.phase;
    throw new Error(
      this.phase.status === 'refused' ? this.phase.reason : 'signer state is not loaded'
    );
  }

  private async load(): Promise<void> {
    const now = Date.now();
    const stored: unknown = await this.ctx.storage.get(STATE_KEY);
    if (stored !== undefined) {
      await this.scheduleAlarm(await this.advanceStored(SignerStateSchema.parse(stored), now));
      return;
    }
    const id = signerOfObjectId(this.config, this.ctx.id);
    if (id.status === 'refused') {
      console.error(JSON.stringify({ event: 'uts.signer.refused', reason: id.reason }));
      this.phase = id;
      return;
    }
    await this.scheduleAlarm(await this.bootstrap(id.signer, now));
  }

  private async advanceStored(stored: SignerState, now: number): Promise<SignerState> {
    const state = await advance(stored, now, () => generateSigningKey(stored.signer));
    if (state !== stored) {
      await this.commit(state);
    } else {
      this.phase = {
        status: 'ready',
        state,
        signingKey: await importSigningKey(state.current.privateJwk),
      };
    }
    return state;
  }

  /**
   * A new object takes its signer index from its name, once, and keeps it in its state. Its log
   * line records where it landed, which never changes (design 5.7 proof run).
   */
  private async bootstrap(signer: number, now: number): Promise<SignerState> {
    const state = await bootstrapState(signer, now, () => generateSigningKey(signer));
    await this.commit(state);
    console.log(
      JSON.stringify({
        event: 'uts.signer.bootstrapped',
        signer,
        jurisdiction: this.config.jurisdiction,
        colo: this.config.jurisdiction === 'none' ? null : await dataCenter(),
        kids: publishedKeys(state).map(key => key.kid),
      })
    );
    return state;
  }

  /** Persist first, cache second: memory never holds a state storage does not. */
  private async commit(state: SignerState): Promise<void> {
    const previous = this.phase;
    const signingKey =
      previous.status === 'ready' && previous.state.current.kid === state.current.kid
        ? previous.signingKey
        : await importSigningKey(state.current.privateJwk);
    await this.ctx.storage.put(STATE_KEY, state);
    this.phase = { status: 'ready', state, signingKey };
  }

  private async scheduleAlarm(state: SignerState): Promise<void> {
    const at = nextChangeAt(state);
    if ((await this.ctx.storage.getAlarm()) !== at) await this.ctx.storage.setAlarm(at);
  }

  /**
   * Every state change runs here, one at a time: no request runs while a change is computed and
   * stored, so a change never overwrites a newer one and `sign` always sees a stored key.
   */
  private async transition<R>(
    step: (state: SignerState, now: number) => Promise<{ state: SignerState; result: R }>
  ): Promise<R> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const { state: before } = this.ready();
      const { state, result } = await step(before, Date.now());
      if (state !== before) await this.commit(state);
      await this.scheduleAlarm(state);
      return result;
    });
  }
}
