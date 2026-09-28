import 'server-only';

import { createHash, randomBytes, randomUUID } from 'crypto';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { decodeClientDataJSON, isoBase64URL } from '@simplewebauthn/server/helpers';
import {
  passkey_challenges,
  passkey_credentials,
  passkey_sign_in_tickets,
  type PasskeyChallenge,
  type PasskeyCredential,
  type PasskeySignInTicket,
} from '@kilocode/db/schema';

import { NEXTAUTH_URL } from '@/lib/config.server';
import { db } from '@/lib/drizzle';

/**
 * WebAuthn ceremonies for passkey registration and sign-in.
 *
 * The relying party is fixed by configuration, never by the request: `rpId` is
 * the host of `NEXTAUTH_URL` without the port and the accepted origin is that
 * URL's origin. A request-derived rpId would be `api.kilo.ai` for the mobile
 * app (which reaches these routes through `API_BASE_URL`), and neither that
 * host nor its origin can satisfy the associated-domain/credential binding the
 * browser or platform authenticator created against `app.kilo.ai`.
 *
 * Resolved per ceremony rather than at module load: `@/lib/user/server` imports
 * this module for the sign-in provider, so importing it must not require a
 * WebAuthn configuration. A process without a relying party still loads the
 * route graph and only fails when a ceremony actually runs.
 */
function getRelyingParty(): { rpId: string; expectedOrigin: string } {
  const url = new URL(NEXTAUTH_URL);
  return { rpId: url.hostname, expectedOrigin: url.origin };
}

const rpName = 'Kilo Code';

/** Challenges are single-use and short-lived: the user completes the ceremony now. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Sign-in tickets are single-use and short-lived: they are redeemed immediately. */
const SIGN_IN_TICKET_TTL_MS = 2 * 60 * 1000;

/** A ceremony name; a challenge only ever authorizes its own ceremony. */
type PasskeyCeremony = 'registration' | 'authentication';

export type PasskeyErrorCode =
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_ALREADY_USED'
  | 'WRONG_CHALLENGE'
  | 'UNKNOWN_CREDENTIAL'
  | 'VERIFICATION_FAILED';

/**
 * A refused passkey ceremony. `code` is the stable contract the routes return;
 * message text is never surfaced to the client.
 */
export class PasskeyVerificationError extends Error {
  readonly code: PasskeyErrorCode;

  constructor(code: PasskeyErrorCode) {
    super(code);
    this.name = 'PasskeyVerificationError';
    this.code = code;
  }
}

export type RegistrationOptionsResult = {
  challengeId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
};

export type AuthenticationOptionsResult = {
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
};

/**
 * Consume a challenge row atomically. Exactly one caller can win the
 * `UPDATE ... WHERE consumed_at IS NULL AND expires_at > NOW()`: a replayed or
 * concurrent ceremony matches no row. The losing caller is classified with a
 * follow-up read (never a write) so it can be told whether the challenge had
 * already been used or is gone.
 */
async function consumeChallenge(
  challengeId: string,
  ceremony: PasskeyCeremony
): Promise<PasskeyChallenge> {
  const [consumed] = await db
    .update(passkey_challenges)
    .set({ consumed_at: sql`NOW()` })
    .where(
      and(
        eq(passkey_challenges.id, challengeId),
        eq(passkey_challenges.kind, ceremony),
        isNull(passkey_challenges.consumed_at),
        sql`${passkey_challenges.expires_at} > NOW()`
      )
    )
    .returning();

  if (consumed) {
    return consumed;
  }

  const [existing] = await db
    .select({
      kind: passkey_challenges.kind,
      consumed_at: passkey_challenges.consumed_at,
    })
    .from(passkey_challenges)
    .where(eq(passkey_challenges.id, challengeId))
    .limit(1);

  // A row consumed by an earlier ceremony is a replay; everything else (no
  // row, another ceremony's challenge, or an expired challenge) has no live
  // challenge to verify against.
  if (existing && existing.kind === ceremony && existing.consumed_at !== null) {
    throw new PasskeyVerificationError('CHALLENGE_ALREADY_USED');
  }
  throw new PasskeyVerificationError('CHALLENGE_EXPIRED');
}

/**
 * Read the challenge the client claims it signed, from the client data. Used
 * only to name a mismatch precisely; verification still runs against the
 * challenge stored on the row.
 */
function readPresentedChallenge(response: {
  response?: { clientDataJSON?: unknown };
}): string | null {
  const clientDataJSON = response.response?.clientDataJSON;
  if (typeof clientDataJSON !== 'string') {
    return null;
  }
  try {
    return decodeClientDataJSON(clientDataJSON).challenge;
  } catch {
    return null;
  }
}

/**
 * Create the WebAuthn registration options for a signed-in user and store the
 * challenge server-side.
 *
 * `options.user.id` is the SHA-256 of the Kilo user id, not the id itself:
 * WebAuthn caps `user.id` at 64 bytes and a Kilo user id can be an
 * `oauth/...` string. `residentKey: 'required'` makes the credential
 * discoverable, which is what the usernameless sign-in path needs.
 */
export async function createRegistrationOptions(
  kiloUserId: string,
  email: string
): Promise<RegistrationOptionsResult> {
  const { rpId } = getRelyingParty();

  const existingCredentials = await db
    .select({
      credential_id: passkey_credentials.credential_id,
      transports: passkey_credentials.transports,
    })
    .from(passkey_credentials)
    .where(eq(passkey_credentials.kilo_user_id, kiloUserId));

  const options = await generateRegistrationOptions({
    rpName,
    rpID: rpId,
    userName: email,
    userID: new Uint8Array(createHash('sha256').update(kiloUserId).digest()),
    attestationType: 'none',
    excludeCredentials: existingCredentials.map(credential => ({
      id: credential.credential_id,
      transports: credential.transports ?? undefined,
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
  });

  const challengeId = randomUUID();
  await db.insert(passkey_challenges).values({
    id: challengeId,
    challenge: options.challenge,
    kind: 'registration',
    kilo_user_id: kiloUserId,
    expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
  });

  return { challengeId, options };
}

/**
 * Verify a registration attestation against the challenge stored on the row —
 * never against anything in the request body — and bind the resulting
 * credential to the authenticated user.
 *
 * Refuses a challenge that is missing, consumed or expired, refuses an
 * attestation that does not verify (including one signed for another origin or
 * rpId, both of which the library checks against this configuration), and
 * refuses a credential id that is already bound to a user.
 */
export async function verifyRegistration(
  kiloUserId: string,
  challengeId: string,
  response: RegistrationResponseJSON
): Promise<PasskeyCredential> {
  const { rpId, expectedOrigin } = getRelyingParty();

  const challenge = await consumeChallenge(challengeId, 'registration');

  if (challenge.kilo_user_id !== kiloUserId) {
    // The options were minted for another user; the stored credential must
    // come from this user's ceremony only.
    throw new PasskeyVerificationError('VERIFICATION_FAILED');
  }

  const presentedChallenge = readPresentedChallenge(response);
  if (presentedChallenge !== null && presentedChallenge !== challenge.challenge) {
    throw new PasskeyVerificationError('WRONG_CHALLENGE');
  }

  let registrationInfo: Awaited<ReturnType<typeof verifyRegistrationResponse>>['registrationInfo'];
  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin,
      expectedRPID: rpId,
      // The options ask for `userVerification: 'preferred'`, so an
      // authenticator that skipped verification is still a legitimate user.
      requireUserVerification: false,
    });
    if (!verification.verified) {
      throw new PasskeyVerificationError('VERIFICATION_FAILED');
    }
    registrationInfo = verification.registrationInfo;
  } catch (error) {
    if (error instanceof PasskeyVerificationError) {
      throw error;
    }
    throw new PasskeyVerificationError('VERIFICATION_FAILED');
  }

  const { credential, credentialDeviceType, credentialBackedUp, aaguid } = registrationInfo;

  const [bound] = await db
    .select({ kilo_user_id: passkey_credentials.kilo_user_id })
    .from(passkey_credentials)
    .where(eq(passkey_credentials.credential_id, credential.id))
    .limit(1);
  if (bound) {
    // A credential id is unique per user and is never re-bound.
    throw new PasskeyVerificationError('VERIFICATION_FAILED');
  }

  const [inserted] = await db
    .insert(passkey_credentials)
    .values({
      kilo_user_id: kiloUserId,
      credential_id: credential.id,
      public_key: isoBase64URL.fromBuffer(credential.publicKey),
      sign_count: credential.counter,
      transports: credential.transports ?? null,
      device_type: credentialDeviceType,
      backed_up: credentialBackedUp,
      aaguid,
    })
    .returning();

  if (!inserted) {
    throw new PasskeyVerificationError('VERIFICATION_FAILED');
  }
  return inserted;
}

/**
 * Create usernameless (discoverable credential) authentication options and
 * store the challenge server-side. `allowCredentials` stays empty so the
 * authenticator offers every passkey for this relying party, and the credential
 * — and therefore the user — is resolved from the assertion response.
 */
export async function createAuthenticationOptions(): Promise<AuthenticationOptionsResult> {
  const { rpId } = getRelyingParty();

  const options = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: [],
    userVerification: 'preferred',
  });

  const challengeId = randomUUID();
  await db.insert(passkey_challenges).values({
    id: challengeId,
    challenge: options.challenge,
    kind: 'authentication',
    kilo_user_id: null,
    expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
  });

  return { challengeId, options };
}

/**
 * Verify a passkey assertion against the challenge stored on the row and mint
 * a one-time sign-in ticket for the credential's owner.
 *
 * Refuses a challenge that is missing, consumed or expired, refuses an unknown
 * credential, refuses an assertion that does not verify against the stored
 * public key with this configuration's origin/rpId, and refuses a signature
 * counter that did not advance once the authenticator started counting.
 */
export async function verifyAuthentication(
  challengeId: string,
  response: AuthenticationResponseJSON
): Promise<{ ticket: string }> {
  // The route hands the assertion over straight from an untrusted body, and the
  // credential id below is used as a query parameter before the WebAuthn
  // library ever validates the response. A non-string id is not a credential
  // this relying party stored, and the challenge must not be burned for it.
  const credentialId: unknown = response.id;
  if (typeof credentialId !== 'string' || credentialId.length === 0) {
    throw new PasskeyVerificationError('VERIFICATION_FAILED');
  }

  const { rpId, expectedOrigin } = getRelyingParty();

  const challenge = await consumeChallenge(challengeId, 'authentication');

  const presentedChallenge = readPresentedChallenge(response);
  if (presentedChallenge !== null && presentedChallenge !== challenge.challenge) {
    throw new PasskeyVerificationError('WRONG_CHALLENGE');
  }

  const [credential] = await db
    .select()
    .from(passkey_credentials)
    .where(eq(passkey_credentials.credential_id, credentialId))
    .limit(1);
  if (!credential) {
    throw new PasskeyVerificationError('UNKNOWN_CREDENTIAL');
  }

  let newCounter: number;
  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin,
      expectedRPID: rpId,
      credential: {
        id: credential.credential_id,
        publicKey: isoBase64URL.toBuffer(credential.public_key),
        counter: credential.sign_count,
        transports: credential.transports ?? undefined,
      },
      // Match the `userVerification: 'preferred'` request options.
      requireUserVerification: false,
    });
    if (!verification.verified) {
      throw new PasskeyVerificationError('VERIFICATION_FAILED');
    }
    newCounter = verification.authenticationInfo.newCounter;
  } catch (error) {
    if (error instanceof PasskeyVerificationError) {
      throw error;
    }
    throw new PasskeyVerificationError('VERIFICATION_FAILED');
  }

  if (credential.sign_count !== 0 && newCounter <= credential.sign_count) {
    // The counter only moves forward; a lower or equal value is a replayed
    // assertion from a cloned authenticator.
    throw new PasskeyVerificationError('VERIFICATION_FAILED');
  }

  // Advance the counter as a compare-and-set against the value that was
  // verified. A concurrent assertion for the same credential read the same
  // counter and reaches this write with a stale expectation, so it updates no
  // row: only the assertion that won the row is allowed to mint a ticket.
  const advanced = await db
    .update(passkey_credentials)
    .set({ sign_count: newCounter, last_used_at: sql`NOW()` })
    .where(
      and(
        eq(passkey_credentials.id, credential.id),
        eq(passkey_credentials.sign_count, credential.sign_count)
      )
    )
    .returning({ id: passkey_credentials.id });

  if (advanced.length !== 1) {
    throw new PasskeyVerificationError('VERIFICATION_FAILED');
  }

  const ticket = await createSignInTicket(credential.kilo_user_id);
  return { ticket };
}

/**
 * Mint a one-time sign-in ticket for a verified passkey assertion. Returns the
 * plaintext ticket and stores only its SHA-256 hash: the ticket is the proof
 * that a WebAuthn assertion verified, and the sign-in provider exchanges it for
 * a session.
 */
export async function createSignInTicket(kiloUserId: string): Promise<string> {
  const ticket = randomBytes(32).toString('hex');
  const ticket_hash = createHash('sha256').update(ticket).digest('hex');

  await db.insert(passkey_sign_in_tickets).values({
    ticket_hash,
    kilo_user_id: kiloUserId,
    expires_at: new Date(Date.now() + SIGN_IN_TICKET_TTL_MS).toISOString(),
  });

  return ticket;
}

/**
 * Redeem a sign-in ticket. The redemption is a single atomic UPDATE: a ticket
 * is usable exactly once, and never after its two-minute expiry.
 */
export async function consumeSignInTicket(ticket: string): Promise<PasskeySignInTicket | null> {
  const ticket_hash = createHash('sha256').update(ticket).digest('hex');

  const [row] = await db
    .update(passkey_sign_in_tickets)
    .set({ consumed_at: sql`NOW()` })
    .where(
      and(
        eq(passkey_sign_in_tickets.ticket_hash, ticket_hash),
        isNull(passkey_sign_in_tickets.consumed_at),
        sql`${passkey_sign_in_tickets.expires_at} > NOW()`
      )
    )
    .returning();

  return row ?? null;
}

/**
 * Delete passkey challenges that can no longer authorize anything. Both
 * ceremonies mint rows, and the usernameless ones carry no user id, so account
 * deletion cannot reach them; this is what keeps the table bounded. Only rows
 * past their five-minute expiry are removed, so a ceremony in flight is never
 * cut short.
 */
export async function cleanupExpiredPasskeyChallenges(): Promise<number> {
  const deleted = await db
    .delete(passkey_challenges)
    .where(lt(passkey_challenges.expires_at, new Date().toISOString()))
    .returning({ id: passkey_challenges.id });

  return deleted.length;
}

/**
 * Delete passkey sign-in tickets that can no longer authorize anything. A
 * ticket is single-use and expires two minutes after it is minted, and
 * redemption only marks it consumed, so without this every passkey sign-in
 * would retain a user-linked row forever. Only rows past their expiry are
 * removed, so a redemption in flight is never cut short.
 */
export async function cleanupExpiredPasskeySignInTickets(): Promise<number> {
  const deleted = await db
    .delete(passkey_sign_in_tickets)
    .where(lt(passkey_sign_in_tickets.expires_at, new Date().toISOString()))
    .returning({ id: passkey_sign_in_tickets.id });

  return deleted.length;
}

/** Passkeys registered by a user, newest first. */
export async function listPasskeysForUser(kiloUserId: string): Promise<PasskeyCredential[]> {
  return db
    .select()
    .from(passkey_credentials)
    .where(eq(passkey_credentials.kilo_user_id, kiloUserId))
    .orderBy(desc(passkey_credentials.created_at));
}

/**
 * Delete one of the user's passkeys. Scoped to the user so a caller can never
 * touch another user's credential, even with a known credential id.
 */
export async function deletePasskey(kiloUserId: string, credentialId: string): Promise<boolean> {
  const deleted = await db
    .delete(passkey_credentials)
    .where(
      and(
        eq(passkey_credentials.kilo_user_id, kiloUserId),
        eq(passkey_credentials.credential_id, credentialId)
      )
    )
    .returning({ id: passkey_credentials.id });

  return deleted.length > 0;
}

/**
 * Rename one of the user's passkeys. Scoped to the user; returns null when no
 * such credential belongs to them.
 */
export async function renamePasskey(
  kiloUserId: string,
  credentialId: string,
  name: string
): Promise<PasskeyCredential | null> {
  const [updated] = await db
    .update(passkey_credentials)
    .set({ name })
    .where(
      and(
        eq(passkey_credentials.kilo_user_id, kiloUserId),
        eq(passkey_credentials.credential_id, credentialId)
      )
    )
    .returning();

  return updated ?? null;
}
