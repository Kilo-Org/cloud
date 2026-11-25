import { ACCESS_TOKEN_ALGORITHM } from '@kilocode/sts-contracts';
import { z } from 'zod';
import {
  TOKEN_KEY_CURRENT_MS,
  TOKEN_KEY_PUBLISH_AHEAD_MS,
  TOKEN_KEY_RETIRED_GRACE_MS,
} from '../constants';

/**
 * The token-signing key ring of one environment (design 5.7). Exactly one `current` key signs. A
 * `next` key is generated and published `TOKEN_KEY_PUBLISH_AHEAD_MS` before it becomes current, so
 * every verifier holds it first; the current key it replaces turns `retired` and stays published
 * until `TOKEN_KEY_RETIRED_GRACE_MS` after the last token it signed expires. Every function here
 * takes the time as an argument, so the timeline is tested without a clock.
 */
export type TokenKeyState = 'next' | 'current' | 'retired';

const TokenKeySchema = z.strictObject({
  kid: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** The Ed25519 private key, PKCS#8, base64url. Never leaves the token signer object. */
  pkcs8: z.string().min(1),
  /** The public key, base64url (JWK `x`). */
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  state: z.enum(['next', 'current', 'retired']),
  createdAt: z.number().int().nonnegative(),
  /** When a next key becomes current; when a current or retired key did. */
  activatesAt: z.number().int().nonnegative(),
  retiredAt: z.number().int().nonnegative().nullable(),
  /** Latest `exp` (seconds) of a token this key signed, rounded up to a whole minute; 0 for none. */
  maxExp: z.number().int().nonnegative(),
});
export type TokenKey = z.infer<typeof TokenKeySchema>;

export const KeyRingSchema = z.strictObject({ keys: z.array(TokenKeySchema).max(16) });
export type KeyRing = z.infer<typeof KeyRingSchema>;

export type GeneratedKey = Pick<TokenKey, 'kid' | 'pkcs8' | 'x'>;

/** One scheduled change, audited as `ai.kilo.sts.token_key.rotated`. */
export type KeyRingChange =
  | { change: 'created'; kid: string }
  | { change: 'published'; kid: string; activatesAt: number }
  | { change: 'activated'; kid: string; retiredKid: string | null }
  | { change: 'removed'; kid: string; lastTokenExp: number };

/** One emergency removal, audited as `ai.kilo.sts.token_key.revoked`. */
export type KeyRevocation = { kid: string; state: TokenKeyState; replacementKid: string | null };

export type KeyRingAdvance = {
  ring: KeyRing;
  changes: KeyRingChange[];
  revocations: KeyRevocation[];
};

function newKey(generated: GeneratedKey, state: TokenKeyState, now: number, activatesAt: number) {
  return { ...generated, state, createdAt: now, activatesAt, retiredAt: null, maxExp: 0 };
}

/** When a retired key leaves the key set: the grace period after its last token expires. */
function removalAt(key: TokenKey): number {
  return Math.max(key.maxExp * 1000, key.retiredAt ?? key.activatesAt) + TOKEN_KEY_RETIRED_GRACE_MS;
}

/**
 * When the next key is published: a publish-ahead period before the current key's 30 days end.
 * A key generated late (an object that slept through the date) still activates no sooner than a
 * full publish-ahead period after it was published.
 */
function nextActivation(current: TokenKey, now: number): number {
  return Math.max(current.activatesAt + TOKEN_KEY_CURRENT_MS, now + TOKEN_KEY_PUBLISH_AHEAD_MS);
}

/**
 * Applies every change due at `now`, in order: emergency removals (a removed current key is
 * replaced by a freshly generated one at once), a first key for an empty ring, the next key's
 * publication, its activation, and the removal of retired keys past their grace period. Running
 * it again at the same time changes nothing.
 */
export async function advanceKeyRing(
  ring: KeyRing,
  options: {
    now: number;
    revokedKids: readonly string[];
    generate: () => Promise<GeneratedKey>;
  }
): Promise<KeyRingAdvance> {
  const { now, revokedKids, generate } = options;
  const changes: KeyRingChange[] = [];
  const revocations: KeyRevocation[] = [];
  let keys = ring.keys.map(key => ({ ...key }));

  for (const key of keys.filter(candidate => revokedKids.includes(candidate.kid))) {
    revocations.push({ kid: key.kid, state: key.state, replacementKid: null });
  }
  keys = keys.filter(key => !revokedKids.includes(key.kid));

  if (!keys.some(key => key.state === 'current')) {
    const replacement = newKey(await generate(), 'current', now, now);
    keys.push(replacement);
    const revokedCurrent = revocations.find(revocation => revocation.state === 'current');
    if (revokedCurrent === undefined) changes.push({ change: 'created', kid: replacement.kid });
    else revokedCurrent.replacementKid = replacement.kid;
  }

  for (;;) {
    const current = keys.find(key => key.state === 'current');
    if (current === undefined) throw new Error('the key ring has no current key');
    const next = keys.find(key => key.state === 'next');
    if (next === undefined) {
      if (now < current.activatesAt + TOKEN_KEY_CURRENT_MS - TOKEN_KEY_PUBLISH_AHEAD_MS) break;
      const published = newKey(await generate(), 'next', now, nextActivation(current, now));
      keys.push(published);
      changes.push({ change: 'published', kid: published.kid, activatesAt: published.activatesAt });
      continue;
    }
    if (now < next.activatesAt) break;
    current.state = 'retired';
    current.retiredAt = now;
    next.state = 'current';
    changes.push({ change: 'activated', kid: next.kid, retiredKid: current.kid });
  }

  for (const key of keys.filter(candidate => candidate.state === 'retired')) {
    if (now < removalAt(key)) continue;
    changes.push({ change: 'removed', kid: key.kid, lastTokenExp: key.maxExp });
  }
  keys = keys.filter(key => key.state !== 'retired' || now < removalAt(key));

  return { ring: { keys }, changes, revocations };
}

/** When `advanceKeyRing` next has work, or now when a listed key is still in the ring. */
export function keyRingDueAt(ring: KeyRing, revokedKids: readonly string[], now: number): number {
  const current = ring.keys.find(key => key.state === 'current');
  if (current === undefined || ring.keys.some(key => revokedKids.includes(key.kid))) return now;
  const next = ring.keys.find(key => key.state === 'next');
  let due =
    next === undefined
      ? current.activatesAt + TOKEN_KEY_CURRENT_MS - TOKEN_KEY_PUBLISH_AHEAD_MS
      : next.activatesAt;
  for (const key of ring.keys) {
    if (key.state === 'retired') due = Math.min(due, removalAt(key));
  }
  return due;
}

/**
 * Raises a key's recorded latest `exp` after it signed a token expiring at `exp`. The value is
 * rounded up to a whole minute, so a busy signer persists it at most once a minute; the retired
 * key then stays published up to a minute longer. Returns whether the ring changed.
 */
export function recordSignedExp(ring: KeyRing, kid: string, exp: number): boolean {
  const key = ring.keys.find(candidate => candidate.kid === kid);
  const rounded = Math.ceil(exp / 60) * 60;
  if (key === undefined || rounded <= key.maxExp) return false;
  key.maxExp = rounded;
  return true;
}

/**
 * One published key, as `Ed25519PublicJwkSchema` accepts it. Closed, unlike that loose schema's
 * type, so it survives the RPC type mapping of a Durable Object method.
 */
export type TokenJwk = {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  alg: typeof ACCESS_TOKEN_ALGORITHM;
  use: 'sig';
};

/** The public keys verifiers accept: next, current and retired keys inside their grace period. */
export function publishedKeys(ring: KeyRing): TokenJwk[] {
  return ring.keys.map(key => ({
    kty: 'OKP',
    crv: 'Ed25519',
    x: key.x,
    kid: key.kid,
    alg: ACCESS_TOKEN_ALGORITHM,
    use: 'sig',
  }));
}
