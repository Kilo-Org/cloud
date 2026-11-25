import {
  UtsPublicJwkSchema,
  UtsSignerIndexSchema,
  type UtsPublicJwk,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import { UTS_MAX_TOKEN_LIFETIME_SECONDS } from './claims';
import { PrivateJwkSchema, type KeyMaterial } from './ed25519';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Design 5.7: each signing key signs for 30 days. The next key is created when its predecessor
 * starts to sign, so it is published for a full interval before its own first token.
 */
export const ROTATION_INTERVAL_MS = 30 * DAY_MS;

/** Design 5.7: a key is published at least 7 days before it signs its first token. */
export const NEXT_KEY_MIN_LEAD_MS = 7 * DAY_MS;

/**
 * Design 5.7: a retired key stays published until 10 minutes after the last token it signed
 * expires. The signer refuses any token that outlives the UTS maximum lifetime, so the last
 * token a key signed expires at most that long after the key retired.
 */
export const RETIRED_KEY_PUBLISHED_MS = UTS_MAX_TOKEN_LIFETIME_SECONDS * 1000 + 10 * MINUTE_MS;

const TimestampSchema = z.number().int().nonnegative();

const KeyMaterialShape = {
  kid: z.string().min(1),
  publicJwk: UtsPublicJwkSchema,
  privateJwk: PrivateJwkSchema,
};

/** Everything a signer object keeps: one record in its KV storage (see `README.md`). */
export const SignerStateSchema = z.strictObject({
  signer: UtsSignerIndexSchema,
  /** The key that signs now. */
  current: z.strictObject({ ...KeyMaterialShape, activatedAt: TimestampSchema }),
  /** The published key that takes over at `activatesAt`. Every state has one. */
  next: z.strictObject({
    ...KeyMaterialShape,
    publishedAt: TimestampSchema,
    activatesAt: TimestampSchema,
  }),
  /** Keys that no longer sign. Only the public half is kept, until `publishedUntil`. */
  retired: z.array(
    z.strictObject({
      kid: z.string().min(1),
      publicJwk: UtsPublicJwkSchema,
      retiredAt: TimestampSchema,
      publishedUntil: TimestampSchema,
    })
  ),
});
export type SignerState = z.infer<typeof SignerStateSchema>;

export type GenerateKey = () => Promise<KeyMaterial>;

/**
 * A key change the signer makes, for its log line now and its audit event once the UTS audit
 * pipeline carries signer events (design 8.3). Every `kid` is public.
 */
export type SignerKeyEvent =
  | {
      type: 'rotated';
      signer: number;
      at: number;
      kid: string;
      retiredKid: string;
      nextKid: string;
    }
  | {
      type: 'removed';
      signer: number;
      at: number;
      kid: string;
      role: 'current' | 'next' | 'retired';
      /** The keys that sign now and next once the removal is done. */
      currentKid: string;
      nextKid: string;
    };

export type Advanced = { state: SignerState; events: SignerKeyEvent[] };

function nextKey(key: KeyMaterial, publishedAt: number, activatesAt: number): SignerState['next'] {
  return { ...key, publishedAt, activatesAt };
}

/**
 * A new object's keys: one that signs at once and the next one, so the key set lists both from
 * the start. No token exists yet, so the first key needs no lead.
 */
export async function bootstrapState(
  signer: number,
  now: number,
  generate: GenerateKey
): Promise<SignerState> {
  const [current, next] = await Promise.all([generate(), generate()]);
  return {
    signer,
    current: { ...current, activatedAt: now },
    next: nextKey(next, now, now + ROTATION_INTERVAL_MS),
    retired: [],
  };
}

/** The time the state next changes on its own: a rotation or a retired key leaving. */
export function nextChangeAt(state: SignerState): number {
  return Math.min(state.next.activatesAt, ...state.retired.map(key => key.publishedUntil));
}

/**
 * Applies every change due at `now`, in order: retired keys past their window leave, and a due
 * next key becomes current while a new next key is created to sign 30 days later. Returns the same
 * state object when nothing is due.
 */
export async function advance(
  state: SignerState,
  now: number,
  generate: GenerateKey
): Promise<Advanced> {
  let result = state;
  const events: SignerKeyEvent[] = [];
  if (result.retired.some(key => key.publishedUntil <= now)) {
    result = { ...result, retired: result.retired.filter(key => key.publishedUntil > now) };
  }
  if (now >= result.next.activatesAt) {
    const { kid, publicJwk, privateJwk } = result.next;
    const created = await generate();
    events.push({
      type: 'rotated',
      signer: result.signer,
      at: now,
      kid,
      retiredKid: result.current.kid,
      nextKid: created.kid,
    });
    result = {
      ...result,
      current: { kid, publicJwk, privateJwk, activatedAt: now },
      next: nextKey(created, now, now + ROTATION_INTERVAL_MS),
      retired: [
        ...result.retired,
        {
          kid: result.current.kid,
          publicJwk: result.current.publicJwk,
          retiredAt: now,
          publishedUntil: now + RETIRED_KEY_PUBLISHED_MS,
        },
      ],
    };
  }
  return { state: result, events };
}

/** Published order: the current key, the next key, then retired keys. */
export function publishedKeys(state: SignerState): UtsPublicJwk[] {
  return [
    state.current.publicJwk,
    state.next.publicJwk,
    ...state.retired.map(key => key.publicJwk),
  ];
}

/**
 * What an emergency removal leaves for the revocation feed (design 5.7): verifiers must reject
 * tokens under `kid` until `revokeUntil`, the time the last token it can have signed has been
 * expired for 10 minutes. The revocation feed writes this entry; until it exists, removal takes
 * the key out of the published set only.
 */
export type KidRemoval = { kid: string; signer: number; removedAt: number; revokeUntil: number };

export type RemoveKeyResult =
  | { status: 'removed'; state: SignerState; removal: KidRemoval; event: SignerKeyEvent }
  | { status: 'unknown_kid' };

/**
 * Emergency removal of one key (design 5.7).
 * - A removed current key is replaced at once by the published next key, which verifiers already
 *   hold, and a new next key is created to sign 30 days later.
 * - A removed next key is replaced by a new one, published at least 7 days before it signs.
 * - A removed retired key leaves the published set.
 * When the signer's storage itself is exposed, the operator removes the next key first and the
 * current key second: the second removal then promotes the key the first removal created.
 */
export async function removeKey(
  state: SignerState,
  kid: string,
  now: number,
  generate: GenerateKey
): Promise<RemoveKeyResult> {
  let result: SignerState;
  let role: 'current' | 'next' | 'retired';
  if (state.retired.some(key => key.kid === kid)) {
    role = 'retired';
    result = { ...state, retired: state.retired.filter(key => key.kid !== kid) };
  } else if (state.next.kid === kid) {
    role = 'next';
    const activatesAt = Math.max(
      state.current.activatedAt + ROTATION_INTERVAL_MS,
      now + NEXT_KEY_MIN_LEAD_MS
    );
    result = { ...state, next: nextKey(await generate(), now, activatesAt) };
  } else if (state.current.kid === kid) {
    role = 'current';
    const { kid: newKid, publicJwk, privateJwk } = state.next;
    result = {
      ...state,
      current: { kid: newKid, publicJwk, privateJwk, activatedAt: now },
      next: nextKey(await generate(), now, now + ROTATION_INTERVAL_MS),
    };
  } else {
    return { status: 'unknown_kid' };
  }
  return {
    status: 'removed',
    state: result,
    removal: {
      kid,
      signer: state.signer,
      removedAt: now,
      revokeUntil: now + RETIRED_KEY_PUBLISHED_MS,
    },
    event: {
      type: 'removed',
      signer: state.signer,
      at: now,
      kid,
      role,
      currentKid: result.current.kid,
      nextKid: result.next.kid,
    },
  };
}
