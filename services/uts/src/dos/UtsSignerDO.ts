import { type SignerPublicKeys, UTS_MAX_TOKENS_PER_CALL } from '@kilocode/uts-contracts';
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
  type SignerKeyEvent,
  type SignerState,
} from '../keys/lifecycle';
import { dataCenter } from './data-center';
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

/**
 * A refused object (wrong name or jurisdiction) answers every call with `misconfigured`: a deploy
 * error that no retry fixes, so callers report it as a server error, not as a transient one.
 */
type Misconfigured = { status: 'misconfigured'; reason: string };

export type SignResult =
  | { status: 'signed'; kid: string; token: string }
  | { status: 'refused'; reason: SignRefusal }
  | Misconfigured;

/** `invalid_batch`: not a list of 1 to 8 claim sets. */
export type SignManyResult =
  | { status: 'signed'; kid: string; tokens: string[] }
  | { status: 'refused'; reason: SignRefusal | 'invalid_batch' }
  | Misconfigured;

/** One mint signs at most 8 tokens (design 5.3). */
const ClaimBatchSchema = z.array(z.unknown()).min(1).max(UTS_MAX_TOKENS_PER_CALL);

type Admission =
  | { status: 'admitted'; claims: SignableClaims }
  | { status: 'refused'; reason: SignRefusal };

export type PublicKeysResult = ({ status: 'ok' } & SignerPublicKeys) | Misconfigured;

export type RemoveKidResult =
  | { status: 'removed'; removal: KidRemoval }
  | { status: 'unknown_kid' }
  | Misconfigured;

type Loaded = { state: SignerState; signingKey: CryptoKey };

/** Loading runs once per start, before any call; a refused object never creates keys. */
type Phase =
  | { status: 'loading' }
  | { status: 'refused'; reason: string }
  | ({ status: 'ready' } & Loaded);

type Settled = Exclude<Phase, { status: 'loading' }>;

type Step<R> = (
  state: SignerState,
  now: number
) => Promise<{ state: SignerState; events: SignerKeyEvent[]; result: R }>;

const KidSchema = z.string().min(1);

function logEvents(events: readonly SignerKeyEvent[]): void {
  for (const event of events) {
    console.log(JSON.stringify({ event: 'uts.signer.key_event', ...event }));
  }
}

/** A compact JWS over `claims` with header `alg: EdDSA`, `typ: at+jwt` and the current `kid`. */
async function signWith(loaded: Loaded, claims: SignableClaims): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: UTS_TOKEN_ALG, typ: UTS_TOKEN_TYPE, kid: loaded.state.current.kid })
    .sign(loaded.signingKey);
}

/**
 * One of the 16 UTS token signers (design 5.7). It generates its own Ed25519 keys and keeps them
 * in its own storage. Workers RPC exposes every public method of the class, so the only public
 * members are the RPC methods `publicKeys`, `sign`, `signMany` and `removeKid` and the platform's
 * `alarm`; every other member is `#`-private, and no RPC method returns or accepts a private key.
 * An alarm rotates the signing key every 30 days, creates the next key at each rotation, and drops
 * a retired key once its window ends.
 */
export class UtsSignerDO extends DurableObject<Env> {
  readonly #config: UtsConfig;
  #phase: Phase = { status: 'loading' };
  /** The alarm time this instance has confirmed in storage; null until it has. */
  #alarmAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#config = readConfig(env);
    // A load that throws (a storage failure) resets the object, and the next call loads again; the
    // catch only keeps that rejection from surfacing as unhandled.
    ctx
      .blockConcurrencyWhile(() => this.#load())
      .catch((error: unknown) => {
        console.error(JSON.stringify({ event: 'uts.signer.load_failed', error: String(error) }));
      });
  }

  async publicKeys(): Promise<PublicKeysResult> {
    const phase = await this.#current();
    if (phase.status === 'refused') return { status: 'misconfigured', reason: phase.reason };
    // Each of the 8 key-set shards reads each object at most once per 2 seconds (its copy), so
    // this read can also check the stored alarm and set it again when it is gone. `sign` runs far
    // more often and skips that read.
    await this.#scheduleAlarm(phase.state, 'confirm');
    return { status: 'ok', signer: phase.state.signer, keys: publishedKeys(phase.state) };
  }

  /**
   * Signs one access-token claim set with the current key: compact JWS, header `alg: EdDSA`,
   * `typ: at+jwt`, `kid`. The claim set must name this environment's issuer, be issued now, and
   * expire within the UTS maximum lifetime, which bounds how long a retired key stays published.
   */
  async sign(claims: unknown): Promise<SignResult> {
    const admission = this.#admit(claims, Math.floor(Date.now() / 1000));
    if (admission.status === 'refused') return admission;
    const phase = await this.#current();
    if (phase.status === 'refused') return { status: 'misconfigured', reason: phase.reason };
    const token = await signWith(phase, admission.claims);
    return { status: 'signed', kid: phase.state.current.kid, token };
  }

  /**
   * Signs the claim sets of one mint, 1 to 8, in one call (design 5.7), in order and with the same
   * key. Each set passes the check `sign` applies, and one refused set refuses the whole batch, so a
   * mint gets every token or none.
   */
  async signMany(claims: unknown): Promise<SignManyResult> {
    const batch = ClaimBatchSchema.safeParse(claims);
    if (!batch.success) return { status: 'refused', reason: 'invalid_batch' };
    const nowSeconds = Math.floor(Date.now() / 1000);
    const admitted: SignableClaims[] = [];
    for (const item of batch.data) {
      const admission = this.#admit(item, nowSeconds);
      if (admission.status === 'refused') return admission;
      admitted.push(admission.claims);
    }
    const phase = await this.#current();
    if (phase.status === 'refused') return { status: 'misconfigured', reason: phase.reason };
    const tokens = await Promise.all(admitted.map(item => signWith(phase, item)));
    return { status: 'signed', kid: phase.state.current.kid, tokens };
  }

  /**
   * Emergency removal of one `kid` from this signer's published keys. An internal operation: only
   * the mint Worker binds this namespace, and no route calls it until the operator route that
   * audits and alerts on it exists. The result is the entry the revocation feed carries.
   */
  async removeKid(kid: string): Promise<RemoveKidResult> {
    const target = KidSchema.parse(kid);
    const phase = this.#settled();
    if (phase.status === 'refused') return { status: 'misconfigured', reason: phase.reason };
    return await this.#transition<RemoveKidResult>(async (state, now) => {
      const removed = await removeKey(state, target, now, () => generateSigningKey(state.signer));
      if (removed.status === 'unknown_kid') return { state, events: [], result: removed };
      return {
        state: removed.state,
        events: [removed.event],
        result: { status: 'removed', removal: removed.removal },
      };
    });
  }

  override async alarm(): Promise<void> {
    // The alarm that runs now is no longer stored; the transition stores the next one.
    this.#alarmAt = null;
    if (this.#settled().status === 'refused') return;
    await this.#transition(async (state, now) => ({
      ...(await advance(state, now, () => generateSigningKey(state.signer))),
      result: undefined,
    }));
  }

  /**
   * The signer's admission check: the claim set must name this environment's issuer, be issued
   * now, and expire within the UTS maximum lifetime.
   */
  #admit(claims: unknown, nowSeconds: number): Admission {
    const parsed = SignableClaimsSchema.safeParse(claims);
    if (!parsed.success) return { status: 'refused', reason: 'invalid_claims' };
    const checked = parsed.data;
    if (checked.iss !== this.#config.endpoints.issuer) {
      return { status: 'refused', reason: 'issuer_mismatch' };
    }
    if (checked.env !== this.#config.environment) {
      return { status: 'refused', reason: 'environment_mismatch' };
    }
    if (Math.abs(checked.iat - nowSeconds) > IAT_SKEW_SECONDS) {
      return { status: 'refused', reason: 'issued_at_out_of_range' };
    }
    if (checked.exp > nowSeconds + UTS_MAX_TOKEN_LIFETIME_SECONDS) {
      return { status: 'refused', reason: 'expires_too_late' };
    }
    return { status: 'admitted', claims: checked };
  }

  /** The phase once loading is done; loading always finishes before a call runs. */
  #settled(): Settled {
    if (this.#phase.status === 'loading') throw new Error('signer state is not loaded');
    return this.#phase;
  }

  /**
   * The settled phase with every due change applied. A change that is due already (its alarm ran
   * out of retries) is applied before the call answers, and an alarm this instance has not
   * confirmed in storage is set again. In the steady state this costs no storage call.
   */
  async #current(): Promise<Settled> {
    const phase = this.#settled();
    if (phase.status === 'refused') return phase;
    const due = nextChangeAt(phase.state);
    if (due <= Date.now()) {
      await this.#transition(async (state, now) => ({
        ...(await advance(state, now, () => generateSigningKey(state.signer))),
        result: undefined,
      }));
      return this.#settled();
    }
    if (this.#alarmAt !== due) await this.#scheduleAlarm(phase.state);
    return phase;
  }

  async #load(): Promise<void> {
    const now = Date.now();
    const stored: unknown = await this.ctx.storage.get(STATE_KEY);
    if (stored !== undefined) {
      await this.#scheduleAlarm(await this.#advanceStored(SignerStateSchema.parse(stored), now));
      return;
    }
    const id = signerOfObjectId(this.#config, this.ctx.id);
    if (id.status === 'refused') {
      console.error(JSON.stringify({ event: 'uts.signer.refused', reason: id.reason }));
      this.#phase = id;
      return;
    }
    await this.#scheduleAlarm(await this.#bootstrap(id.index, now));
  }

  async #advanceStored(stored: SignerState, now: number): Promise<SignerState> {
    const { state, events } = await advance(stored, now, () => generateSigningKey(stored.signer));
    if (state !== stored) {
      await this.#commit(state);
    } else {
      this.#phase = {
        status: 'ready',
        state,
        signingKey: await importSigningKey(state.current.privateJwk),
      };
    }
    logEvents(events);
    return state;
  }

  /**
   * A new object takes its signer index from its name, once, and keeps it in its state. Its log
   * line records where it landed, which never changes (design 5.7 proof run).
   */
  async #bootstrap(signer: number, now: number): Promise<SignerState> {
    const state = await bootstrapState(signer, now, () => generateSigningKey(signer));
    await this.#commit(state);
    console.log(
      JSON.stringify({
        event: 'uts.signer.bootstrapped',
        signer,
        jurisdiction: this.#config.jurisdiction,
        colo: this.#config.jurisdiction === 'none' ? null : await dataCenter(),
        kids: publishedKeys(state).map(key => key.kid),
      })
    );
    return state;
  }

  /** Persist first, cache second: memory never holds a state storage does not. */
  async #commit(state: SignerState): Promise<void> {
    const previous = this.#phase;
    const signingKey =
      previous.status === 'ready' && previous.state.current.kid === state.current.kid
        ? previous.signingKey
        : await importSigningKey(state.current.privateJwk);
    await this.ctx.storage.put(STATE_KEY, state);
    this.#phase = { status: 'ready', state, signingKey };
  }

  /**
   * Stores the alarm for the next change. `cached` trusts the alarm this instance has already
   * confirmed; `confirm` reads storage even then.
   */
  async #scheduleAlarm(state: SignerState, mode: 'cached' | 'confirm' = 'cached'): Promise<void> {
    const at = nextChangeAt(state);
    if (mode === 'cached' && this.#alarmAt === at) return;
    if ((await this.ctx.storage.getAlarm()) !== at) await this.ctx.storage.setAlarm(at);
    this.#alarmAt = at;
  }

  /**
   * Every state change runs here, one at a time: no request runs while a change is computed and
   * stored, so a change never overwrites a newer one and `sign` always sees a stored key.
   */
  async #transition<R>(step: Step<R>): Promise<R> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const phase = this.#settled();
      if (phase.status === 'refused') throw new Error(phase.reason);
      const { state, events, result } = await step(phase.state, Date.now());
      if (state !== phase.state) await this.#commit(state);
      await this.#scheduleAlarm(state);
      logEvents(events);
      return result;
    });
  }
}
