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
  kilocode_users,
  passkey_challenges,
  passkey_credentials,
  passkey_sign_in_tickets,
  type PasskeyChallenge,
  type PasskeyCredential,
  type PasskeySignInTicket,
} from '@kilocode/db/schema';

import assetLinks from '../../../public/.well-known/assetlinks.json';
import { NEXTAUTH_URL } from '@kilocode/web-shared/lib/config.server';
import {
  db,
  type DrizzleConnection,
  type DrizzleTransaction,
} from '@kilocode/web-shared/lib/drizzle';
import { isWebSessionCurrent } from '@kilocode/web-shared/lib/web-session-revocation';
import { deleteExpiredPasskeyManagementAuthorizations } from './passkey-management';

/**
 * WebAuthn ceremonies for passkey registration and sign-in.
 *
 * The relying party is fixed by configuration, never by the request: `rpId` is
 * the host of `NEXTAUTH_URL` without the port, and the accepted origins are
 * that URL's origin plus the origins of the Kilo mobile app. A request-derived
 * rpId would be `api.kilo.ai` for the mobile app (which reaches these routes
 * through `API_BASE_URL`), and neither that host nor a request-derived origin
 * can satisfy the associated-domain/credential binding the browser or platform
 * authenticator created against `app.kilo.ai`.
 *
 * Resolved per ceremony rather than at module load: `@kilocode/web-shared/lib/user/server` imports
 * this module for the sign-in provider, so importing it must not require a
 * WebAuthn configuration. A process without a relying party still loads the
 * route graph and only fails when a ceremony actually runs.
 */
const ANDROID_PACKAGE_NAME = 'com.kilocode.kiloapp';

/**
 * The certificate the CI dev client is signed with. It is a debug key, so its
 * origin is accepted only outside production: a debug-signed build must never
 * be able to register or use a production credential.
 */
const ANDROID_DEBUG_CERT_FINGERPRINT =
  'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C';

/**
 * Android platform authenticators report their origin as
 * `android:apk-key-hash:<hash>`, where `<hash>` is the unpadded base64url
 * SHA-256 of the calling app's signing certificate. The authenticator binds
 * the credential to that certificate, so a native app's response can only
 * verify when the certificate it was signed with is among the accepted
 * origins. These are derived from the release fingerprints Digital Asset Links
 * publishes in `public/.well-known/assetlinks.json`; the two must not drift.
 */
function fingerprintToAndroidOrigin(fingerprint: string): string {
  const bytes = Buffer.from(fingerprint.replace(/:/g, ''), 'hex');
  return `android:apk-key-hash:${bytes.toString('base64url')}`;
}

function getReleaseAndroidOrigins(): string[] {
  const origins: string[] = [];
  for (const entry of assetLinks) {
    if (entry.target.namespace !== 'android_app') continue;
    if (entry.target.package_name !== ANDROID_PACKAGE_NAME) continue;
    for (const fingerprint of entry.target.sha256_cert_fingerprints) {
      origins.push(fingerprintToAndroidOrigin(fingerprint));
    }
  }
  return origins;
}

/**
 * Resolve the configured relying party. `rpId` is the host of `NEXTAUTH_URL`
 * without the port, and `origin` is that URL's origin. Both relying-party
 * helpers read it through here, so a credential registered by an ordinary
 * ceremony always verifies for a privileged step-up: WebAuthn binds the
 * credential and challenge to this `rpId`.
 */
function nextAuthRelyingParty(): { rpId: string; origin: string } {
  const url = new URL(NEXTAUTH_URL);
  return { rpId: url.hostname, origin: url.origin };
}

function getRelyingParty(): { rpId: string; expectedOrigins: string[] } {
  const { rpId, origin } = nextAuthRelyingParty();
  const expectedOrigins = [origin, ...getReleaseAndroidOrigins()];
  if (process.env.NODE_ENV !== 'production') {
    expectedOrigins.push(fingerprintToAndroidOrigin(ANDROID_DEBUG_CERT_FINGERPRINT));
  }
  return { rpId, expectedOrigins };
}

/**
 * The web-only relying party used by privileged MFA step-up. The native app
 * must never complete a step-up: accepting an `android:apk-key-hash` origin
 * there would let a mobile client borrow a browser session's proof.
 */
export function getWebRelyingParty(): { rpId: string; expectedOrigin: string } {
  const { rpId, origin } = nextAuthRelyingParty();
  return { rpId, expectedOrigin: origin };
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
  | 'VERIFICATION_FAILED'
  | 'PASSKEY_MANAGEMENT_AUTHORIZATION_INVALID';

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
 * Refuse a ceremony whose client data names another challenge. A response can
 * omit the client data challenge or carry one that cannot be parsed, so only a
 * readable mismatch is refused here; verification still runs against the
 * stored challenge.
 */
function assertPresentedChallenge(
  response: { response?: { clientDataJSON?: unknown } },
  storedChallenge: string
): void {
  const presentedChallenge = readPresentedChallenge(response);
  if (presentedChallenge !== null && presentedChallenge !== storedChallenge) {
    throw new PasskeyVerificationError('WRONG_CHALLENGE');
  }
}

/**
 * Normalize a failed WebAuthn call: our own refusal keeps its code, and every
 * library throw becomes `VERIFICATION_FAILED`, so library detail never reaches
 * the client.
 */
function normalizeVerificationFailure(error: unknown): never {
  if (error instanceof PasskeyVerificationError) {
    throw error;
  }
  throw new PasskeyVerificationError('VERIFICATION_FAILED');
}

/**
 * Run one WebAuthn verifier and return its verified result. A verifier that
 * reports `verified: false` is refused with the same code as a throw, and every
 * throw is normalized, so library detail never reaches the client.
 */
async function verifyOrRefuse<T extends { verified: boolean }>(
  call: () => Promise<T>
): Promise<T & { verified: true }> {
  function isVerified(result: T): result is T & { verified: true } {
    return result.verified;
  }

  try {
    const result = await call();
    if (!isVerified(result)) {
      throw new PasskeyVerificationError('VERIFICATION_FAILED');
    }
    return result;
  } catch (error) {
    normalizeVerificationFailure(error);
  }
}

/**
 * Store a freshly minted challenge and return the opaque id the client echoes
 * back. The row carries the ceremony it authorizes and, for registration, the
 * owner it was minted for; authentication is usernameless, so its owner is
 * null.
 */
async function storeChallenge(
  challenge: string,
  ceremony: PasskeyCeremony,
  kiloUserId: string | null
): Promise<string> {
  const challengeId = randomUUID();
  await db.insert(passkey_challenges).values({
    id: challengeId,
    challenge,
    kind: ceremony,
    kilo_user_id: kiloUserId,
    expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
  });
  return challengeId;
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

  const challengeId = await storeChallenge(options.challenge, 'registration', kiloUserId);

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
 *
 * `authorize` runs inside the transaction that locks the user row and inserts
 * the credential, before the insert. A refused authorization throws and rolls
 * the whole enrollment back, so a credential and the authority that allowed it
 * commit or fail together.
 */
async function verifyRegistrationWithAuthorization(
  kiloUserId: string,
  challengeId: string,
  response: RegistrationResponseJSON,
  authorize: (
    tx: DrizzleTransaction,
    owner: { web_session_pepper: string | null } | undefined
  ) => Promise<void>
): Promise<PasskeyCredential> {
  const { rpId, expectedOrigins } = getRelyingParty();

  const challenge = await consumeChallenge(challengeId, 'registration');

  if (challenge.kilo_user_id !== kiloUserId) {
    // The options were minted for another user; the stored credential must
    // come from this user's ceremony only.
    throw new PasskeyVerificationError('VERIFICATION_FAILED');
  }

  assertPresentedChallenge(response, challenge.challenge);

  const { registrationInfo } = await verifyOrRefuse(() =>
    verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: expectedOrigins,
      expectedRPID: rpId,
      // The options ask for `userVerification: 'preferred'`, so an
      // authenticator that skipped verification is still a legitimate user.
      requireUserVerification: false,
    })
  );

  const { credential, credentialDeviceType, credentialBackedUp, aaguid } = registrationInfo;

  return db.transaction(async tx => {
    const [owner] = await tx
      .select({ web_session_pepper: kilocode_users.web_session_pepper })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, kiloUserId))
      .for('update');

    await authorize(tx, owner);

    const [bound] = await tx
      .select({ kilo_user_id: passkey_credentials.kilo_user_id })
      .from(passkey_credentials)
      .where(eq(passkey_credentials.credential_id, credential.id))
      .limit(1);
    if (bound) {
      // A credential id is unique per user and is never re-bound.
      throw new PasskeyVerificationError('VERIFICATION_FAILED');
    }

    const [inserted] = await tx
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
  });
}

/**
 * Verify a browser enrollment. `sessionPepper` is the pepper of the browser
 * session that started this request. Account recovery rotates the pepper on
 * the same row before it deletes passkeys. It therefore either commits first,
 * and this registration is refused, or waits for this insert and then deletes
 * the new credential.
 */
export async function verifyRegistration(
  kiloUserId: string,
  challengeId: string,
  response: RegistrationResponseJSON,
  sessionPepper: string | null | undefined
): Promise<PasskeyCredential> {
  return verifyRegistrationWithAuthorization(
    kiloUserId,
    challengeId,
    response,
    async (_tx, owner) => {
      if (!owner || !isWebSessionCurrent(sessionPepper, owner)) {
        throw new PasskeyVerificationError('VERIFICATION_FAILED');
      }
    }
  );
}

/**
 * Verify a native app enrollment. `consumeAuthorization` redeems the
 * single-use management grant inside the insertion transaction, so a grant is
 * spent only by an enrollment that commits, and a failed attribution, a
 * cancelled ceremony, or a rolled-back insert leaves it usable until it
 * expires.
 *
 * There is no browser session pepper on this path: the native session and the
 * fresh primary proof behind the grant are the authority.
 */
export async function verifyNativeRegistration(
  kiloUserId: string,
  challengeId: string,
  response: RegistrationResponseJSON,
  consumeAuthorization: (tx: DrizzleTransaction) => Promise<boolean>
): Promise<PasskeyCredential> {
  return verifyRegistrationWithAuthorization(kiloUserId, challengeId, response, async tx => {
    if (!(await consumeAuthorization(tx))) {
      throw new PasskeyVerificationError('PASSKEY_MANAGEMENT_AUTHORIZATION_INVALID');
    }
  });
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

  const challengeId = await storeChallenge(options.challenge, 'authentication', null);

  return { challengeId, options };
}

/**
 * Advance a credential's signature counter as a compare-and-set against the
 * value that was just verified. A concurrent assertion read the same counter
 * and reaches this write with a stale expectation, so it updates no row.
 */
export async function advancePasskeyCounter(
  credential: Pick<PasskeyCredential, 'id' | 'sign_count'>,
  newCounter: number,
  fromDb: DrizzleConnection = db
): Promise<boolean> {
  const advanced = await fromDb
    .update(passkey_credentials)
    .set({ sign_count: newCounter, last_used_at: sql`NOW()` })
    .where(
      and(
        eq(passkey_credentials.id, credential.id),
        eq(passkey_credentials.sign_count, credential.sign_count)
      )
    )
    .returning({ id: passkey_credentials.id });

  return advanced.length === 1;
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

  const { rpId, expectedOrigins } = getRelyingParty();

  const challenge = await consumeChallenge(challengeId, 'authentication');

  assertPresentedChallenge(response, challenge.challenge);

  const [credential] = await db
    .select()
    .from(passkey_credentials)
    .where(eq(passkey_credentials.credential_id, credentialId))
    .limit(1);
  if (!credential) {
    throw new PasskeyVerificationError('UNKNOWN_CREDENTIAL');
  }

  const { authenticationInfo } = await verifyOrRefuse(() =>
    verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: expectedOrigins,
      expectedRPID: rpId,
      credential: {
        id: credential.credential_id,
        publicKey: isoBase64URL.toBuffer(credential.public_key),
        counter: credential.sign_count,
        transports: credential.transports ?? undefined,
      },
      // Match the `userVerification: 'preferred'` request options.
      requireUserVerification: false,
    })
  );

  if (credential.sign_count !== 0 && authenticationInfo.newCounter <= credential.sign_count) {
    // The counter only moves forward; a lower or equal value is a replayed
    // assertion from a cloned authenticator.
    throw new PasskeyVerificationError('VERIFICATION_FAILED');
  }

  // Advance the counter as a compare-and-set against the value that was
  // verified, and mint the ticket in the same transaction. A concurrent
  // assertion for the same credential read the same counter and reaches this
  // write with a stale expectation, so it updates no row: only the assertion
  // that won the row is allowed to mint a ticket.
  //
  // The update also holds the credential's row lock until the ticket commits.
  // Account recovery and account deletion delete the credential and then the
  // user's tickets, so they either commit first, and this update matches no
  // row, or wait for this commit and then delete the ticket minted here.
  // Neither can leave a ticket that outlives the removed credential.
  const ticket = await db.transaction(async tx => {
    if (!(await advancePasskeyCounter(credential, authenticationInfo.newCounter, tx))) {
      throw new PasskeyVerificationError('VERIFICATION_FAILED');
    }
    return createSignInTicket(credential.kilo_user_id, tx);
  });
  return { ticket };
}

/**
 * Derive the stored digest of a sign-in ticket. The ticket itself is never
 * stored: issuance writes this digest and redemption looks the row up by it,
 * so both read the one derivation and cannot disagree.
 */
function hashSignInTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

/**
 * Mint a one-time sign-in ticket for a verified passkey assertion. Returns the
 * plaintext ticket and stores only its SHA-256 hash: the ticket is the proof
 * that a WebAuthn assertion verified, and the sign-in provider exchanges it for
 * a session.
 */
export async function createSignInTicket(
  kiloUserId: string,
  fromDb: DrizzleConnection = db
): Promise<string> {
  const ticket = randomBytes(32).toString('hex');
  const ticket_hash = hashSignInTicket(ticket);

  await fromDb.insert(passkey_sign_in_tickets).values({
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
  const ticket_hash = hashSignInTicket(ticket);

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
 * Delete passkey rows that can no longer authorize anything, under one cutoff.
 *
 * Challenges: both ceremonies mint rows, and the usernameless ones carry no
 * user id, so account deletion cannot reach them; this is what keeps the table
 * bounded. Only rows past their five-minute expiry are removed, so a ceremony
 * in flight is never cut short.
 *
 * Sign-in tickets: a ticket is single-use and expires two minutes after it is
 * minted, and redemption only marks it consumed, so without this every passkey
 * sign-in would retain a user-linked row forever. Only rows past their expiry
 * are removed, so a redemption in flight is never cut short.
 *
 * Management authorizations: the same single-use, five-minute shape. Rows past
 * expiry can authorize nothing, so they are removed under the same cutoff.
 */
export async function cleanupExpiredPasskeyRows(): Promise<{
  challenges: number;
  tickets: number;
  managementAuthorizations: number;
}> {
  const cutoff = new Date().toISOString();

  const challenges = await db
    .delete(passkey_challenges)
    .where(lt(passkey_challenges.expires_at, cutoff))
    .returning({ id: passkey_challenges.id });

  const tickets = await db
    .delete(passkey_sign_in_tickets)
    .where(lt(passkey_sign_in_tickets.expires_at, cutoff))
    .returning({ id: passkey_sign_in_tickets.id });

  const managementAuthorizations = await deleteExpiredPasskeyManagementAuthorizations(cutoff);

  return {
    challenges: challenges.length,
    tickets: tickets.length,
    managementAuthorizations,
  };
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
export async function deletePasskey(
  kiloUserId: string,
  credentialId: string,
  fromDb: DrizzleConnection = db
): Promise<boolean> {
  const deleted = await fromDb
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
  name: string,
  fromDb: DrizzleConnection = db
): Promise<PasskeyCredential | null> {
  const [updated] = await fromDb
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
