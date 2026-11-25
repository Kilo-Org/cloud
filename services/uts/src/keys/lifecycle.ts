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

/** Design 5.7: each signing key signs for 30 days. */
export const ROTATION_INTERVAL_MS = 30 * DAY_MS;

/** Design 5.7: the next key is published 7 days before it signs its first token. */
export const NEXT_KEY_LEAD_MS = 7 * DAY_MS;

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
  /** The published key that takes over at `activatesAt`; null between a rotation and its next lead. */
  next: z
    .strictObject({
      ...KeyMaterialShape,
      publishedAt: TimestampSchema,
      activatesAt: TimestampSchema,
    })
    .nullable(),
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
    next: { ...next, publishedAt: now, activatesAt: now + ROTATION_INTERVAL_MS },
    retired: [],
  };
}

function nextKeyDueAt(state: SignerState): number {
  return state.current.activatedAt + ROTATION_INTERVAL_MS - NEXT_KEY_LEAD_MS;
}

/** The time the state next changes on its own: a key due, a rotation, or a retired key leaving. */
export function nextChangeAt(state: SignerState): number {
  return Math.min(
    state.next === null ? nextKeyDueAt(state) : state.next.activatesAt,
    ...state.retired.map(key => key.publishedUntil)
  );
}

/**
 * Applies every change due at `now`, in order: retired keys past their window leave, a due next
 * key becomes current, and a next key is generated once the current one is 7 days from its end.
 * A late run never shortens the lead: a next key generated late activates 7 days after `now`.
 * Returns the same object when nothing is due.
 */
export async function advance(
  state: SignerState,
  now: number,
  generate: GenerateKey
): Promise<SignerState> {
  let result = state;
  if (result.retired.some(key => key.publishedUntil <= now)) {
    result = { ...result, retired: result.retired.filter(key => key.publishedUntil > now) };
  }
  if (result.next !== null && now >= result.next.activatesAt) {
    const { kid, publicJwk, privateJwk } = result.next;
    result = {
      ...result,
      current: { kid, publicJwk, privateJwk, activatedAt: now },
      next: null,
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
  if (result.next === null && now >= nextKeyDueAt(result)) {
    const key = await generate();
    result = {
      ...result,
      next: {
        ...key,
        publishedAt: now,
        activatesAt: Math.max(
          result.current.activatedAt + ROTATION_INTERVAL_MS,
          now + NEXT_KEY_LEAD_MS
        ),
      },
    };
  }
  return result;
}

/** Published order: the current key, the next key, then retired keys. */
export function publishedKeys(state: SignerState): UtsPublicJwk[] {
  return [
    state.current.publicJwk,
    ...(state.next === null ? [] : [state.next.publicJwk]),
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
  | { status: 'removed'; state: SignerState; removal: KidRemoval }
  | { status: 'unknown_kid' };

/**
 * Emergency removal of one key. A removed current key is replaced at once by the next key, which
 * verifiers already hold; without a next key, a fresh key signs at once and verifiers fetch it on
 * its unknown `kid`. Clients refresh with their grants and receive tokens under the new key.
 */
export async function removeKey(
  state: SignerState,
  kid: string,
  now: number,
  generate: GenerateKey
): Promise<RemoveKeyResult> {
  let result: SignerState;
  if (state.retired.some(key => key.kid === kid)) {
    result = { ...state, retired: state.retired.filter(key => key.kid !== kid) };
  } else if (state.next?.kid === kid) {
    result = { ...state, next: null };
  } else if (state.current.kid === kid) {
    const replacement = state.next ?? (await generate());
    const { kid: newKid, publicJwk, privateJwk } = replacement;
    result = {
      ...state,
      current: { kid: newKid, publicJwk, privateJwk, activatedAt: now },
      next: null,
    };
  } else {
    return { status: 'unknown_kid' };
  }
  return {
    status: 'removed',
    state: await advance(result, now, generate),
    removal: {
      kid,
      signer: state.signer,
      removedAt: now,
      revokeUntil: now + RETIRED_KEY_PUBLISHED_MS,
    },
  };
}
