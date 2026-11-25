import {
  SignerKeysResultSchema,
  UtsJwksSchema,
  type SignerKeysBinding,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';

/**
 * How long an isolate serves the key set it read before it asks the mint Worker again. A key-set
 * change reaches a verifier within this plus the verifier's own 5 minutes. Token keys need no
 * faster path: a next key is published 7 days ahead, and an emergency removal reaches verifiers
 * through the revocation feed within 60 seconds.
 */
export const KEY_SET_FRESH_MS = 60 * 1000;

export type KeySetRead =
  | { status: 'ok'; body: string }
  /** The call failed or timed out; the next request tries again. */
  | { status: 'unavailable' }
  /** The mint Worker refused this caller or answered a shape this Worker does not accept: a deploy error. */
  | { status: 'misconfigured'; reason: 'denied' | 'invalid_answer' };

/**
 * The last key set this isolate read, as a settled value. A pending promise is never shared:
 * awaiting another request's I/O can hang once that request ends.
 */
let lastRead: { environment: UtsEnvironment; body: string; readAt: number } | null = null;

/**
 * Reads every signer's public keys over the internal binding and serializes the key set. The
 * revocation-feed slice adds its two feed keys to the same `keys` array; `UtsJwksSchema` rejects a
 * duplicate `kid` across both.
 */
async function readFromMint(binding: SignerKeysBinding): Promise<KeySetRead> {
  let answer: unknown;
  try {
    answer = await binding.publicKeys();
  } catch (error) {
    console.error(JSON.stringify({ event: 'uts_feed.signer_keys.failed', error: String(error) }));
    return { status: 'unavailable' };
  }
  const parsed = SignerKeysResultSchema.safeParse(answer);
  if (!parsed.success) {
    console.error(JSON.stringify({ event: 'uts_feed.signer_keys.invalid_answer' }));
    return { status: 'misconfigured', reason: 'invalid_answer' };
  }
  if (parsed.data.status === 'denied') {
    console.error(JSON.stringify({ event: 'uts_feed.signer_keys.denied' }));
    return { status: 'misconfigured', reason: 'denied' };
  }
  const jwks = UtsJwksSchema.safeParse({
    keys: parsed.data.signers.flatMap(entry => entry.keys),
  });
  if (!jwks.success) {
    console.error(JSON.stringify({ event: 'uts_feed.signer_keys.duplicate_kid' }));
    return { status: 'misconfigured', reason: 'invalid_answer' };
  }
  return { status: 'ok', body: JSON.stringify(jwks.data) };
}

export async function readKeySet(
  binding: SignerKeysBinding,
  environment: UtsEnvironment,
  now: number
): Promise<KeySetRead> {
  const held = lastRead;
  if (held !== null && held.environment === environment && now - held.readAt < KEY_SET_FRESH_MS) {
    return { status: 'ok', body: held.body };
  }
  const read = await readFromMint(binding);
  // A read that started before the one now held finished late; it must not replace newer keys.
  const latest = lastRead;
  if (read.status === 'ok' && (latest === null || latest.readAt <= now)) {
    lastRead = { environment, body: read.body, readAt: now };
  }
  return read;
}

/** Test seam: the next read goes to the mint Worker. */
export function forgetKeySet(): void {
  lastRead = null;
}
