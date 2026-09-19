import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import { eq } from 'drizzle-orm';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

import {
  passkey_challenges,
  passkey_credentials,
  passkey_sign_in_tickets,
} from '@kilocode/db/schema';
import { NEXTAUTH_URL } from '@/lib/config.server';
import { db } from '@/lib/drizzle';

import {
  cleanupExpiredPasskeySignInTickets,
  consumeSignInTicket,
  createAuthenticationOptions,
  createRegistrationOptions,
  createSignInTicket,
  deletePasskey,
  listPasskeysForUser,
  renamePasskey,
  verifyAuthentication,
  verifyRegistration,
  PasskeyVerificationError,
} from './passkey';

// The relying party the module reads from configuration. The fixtures must be
// signed for the same values or the library rejects them.
const rpId = new URL(NEXTAUTH_URL).hostname;
const rpOrigin = new URL(NEXTAUTH_URL).origin;

const userId = 'oauth/passkey-test-user';
const otherUserId = 'oauth/passkey-test-other-user';
const userEmail = 'passkey-test@example.com';

type CborMap = Map<string | number, unknown>;

/** A `Uint8Array` over a plain `ArrayBuffer`, which is what the WebAuthn helpers take. */
type Bytes = Uint8Array<ArrayBuffer>;

function toBytes(value: Uint8Array): Bytes {
  return new Uint8Array(value);
}

function encodeCbor(value: CborMap): Bytes {
  return new Uint8Array(isoCBOR.encode(value as Parameters<typeof isoCBOR.encode>[0]));
}

type TestAuthenticator = {
  credentialId: string;
  cosePublicKey: Bytes;
  privateKey: KeyObject;
  rpIdHash: Uint8Array;
};

/**
 * A software authenticator: a real P-256 key pair plus the COSE public key a
 * registration ceremony would return, so signatures built here verify against
 * the stored public key exactly like a platform authenticator's would.
 */
function createTestAuthenticator(authenticatorRpId: string = rpId): TestAuthenticator {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };

  return {
    credentialId: isoBase64URL.fromBuffer(randomBytes(32)),
    cosePublicKey: encodeCbor(
      new Map<string | number, unknown>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, isoBase64URL.toBuffer(jwk.x)],
        [-3, isoBase64URL.toBuffer(jwk.y)],
      ])
    ),
    privateKey,
    rpIdHash: createHash('sha256').update(authenticatorRpId).digest(),
  };
}

function buildAuthenticatorData(opts: {
  rpIdHash: Uint8Array;
  flags: number;
  counter: number;
  credentialId?: Uint8Array;
  cosePublicKey?: Uint8Array;
}): Buffer {
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(opts.counter);

  const parts: Buffer[] = [Buffer.from(opts.rpIdHash), Buffer.from([opts.flags]), counterBytes];
  if (opts.credentialId && opts.cosePublicKey) {
    const credentialIdLength = Buffer.alloc(2);
    credentialIdLength.writeUInt16BE(opts.credentialId.byteLength);
    parts.push(
      Buffer.alloc(16), // zeroed AAGUID
      credentialIdLength,
      Buffer.from(opts.credentialId),
      Buffer.from(opts.cosePublicKey)
    );
  }
  return Buffer.concat(parts);
}

function buildClientDataJSON(
  type: 'webauthn.create' | 'webauthn.get',
  challenge: string,
  origin: string
) {
  return isoBase64URL.fromUTF8String(JSON.stringify({ type, challenge, origin }));
}

function buildRegistrationResponse(
  authenticator: TestAuthenticator,
  opts: {
    challenge: string;
    origin?: string;
    rpIdHash?: Uint8Array;
    counter?: number;
  }
): RegistrationResponseJSON {
  const authData = buildAuthenticatorData({
    rpIdHash: opts.rpIdHash ?? authenticator.rpIdHash,
    // UP | UV | AT
    flags: 0x45,
    counter: opts.counter ?? 0,
    credentialId: isoBase64URL.toBuffer(authenticator.credentialId),
    cosePublicKey: authenticator.cosePublicKey,
  });
  const attestationObject = encodeCbor(
    new Map<string | number, unknown>([
      ['fmt', 'none'],
      ['attStmt', new Map<string | number, unknown>()],
      ['authData', authData],
    ])
  );

  return {
    id: authenticator.credentialId,
    rawId: authenticator.credentialId,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: buildClientDataJSON(
        'webauthn.create',
        opts.challenge,
        opts.origin ?? rpOrigin
      ),
      attestationObject: isoBase64URL.fromBuffer(attestationObject),
      transports: ['internal'],
    },
  };
}

function buildAuthenticationResponse(
  authenticator: TestAuthenticator,
  opts: {
    challenge: string;
    counter: number;
    origin?: string;
    rpIdHash?: Uint8Array;
    userHandle?: Uint8Array;
  }
): AuthenticationResponseJSON {
  const clientDataJSON = buildClientDataJSON(
    'webauthn.get',
    opts.challenge,
    opts.origin ?? rpOrigin
  );
  const authData = buildAuthenticatorData({
    rpIdHash: opts.rpIdHash ?? authenticator.rpIdHash,
    // UP | UV
    flags: 0x05,
    counter: opts.counter,
  });
  const clientDataHash = createHash('sha256')
    .update(Buffer.from(isoBase64URL.toBuffer(clientDataJSON)))
    .digest();
  const signature = cryptoSign(
    'sha256',
    Buffer.concat([authData, clientDataHash]),
    // WebAuthn ES256 signatures are DER-encoded ECDSA values, which is what
    // the library unwraps before handing them to WebCrypto.
    { key: authenticator.privateKey }
  );

  return {
    id: authenticator.credentialId,
    rawId: authenticator.credentialId,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON,
      authenticatorData: isoBase64URL.fromBuffer(toBytes(authData)),
      signature: isoBase64URL.fromBuffer(toBytes(signature)),
      userHandle: opts.userHandle ? isoBase64URL.fromBuffer(toBytes(opts.userHandle)) : undefined,
    },
  };
}

async function expectRefusal(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (rejection: unknown) => rejection
  );
  expect(error).toBeInstanceOf(PasskeyVerificationError);
  expect((error as PasskeyVerificationError).code).toBe(code);
}

async function insertCredential(
  authenticator: TestAuthenticator,
  opts: { kiloUserId?: string; signCount?: number } = {}
): Promise<void> {
  await db.insert(passkey_credentials).values({
    kilo_user_id: opts.kiloUserId ?? userId,
    credential_id: authenticator.credentialId,
    public_key: isoBase64URL.fromBuffer(authenticator.cosePublicKey),
    sign_count: opts.signCount ?? 0,
  });
}

describe('passkey', () => {
  beforeEach(async () => {
    await db
      .delete(passkey_sign_in_tickets)
      .where(eq(passkey_sign_in_tickets.kilo_user_id, userId));
    await db
      .delete(passkey_sign_in_tickets)
      .where(eq(passkey_sign_in_tickets.kilo_user_id, otherUserId));
    await db.delete(passkey_credentials).where(eq(passkey_credentials.kilo_user_id, userId));
    await db.delete(passkey_credentials).where(eq(passkey_credentials.kilo_user_id, otherUserId));
    await db.delete(passkey_challenges).where(eq(passkey_challenges.kilo_user_id, userId));
    await db.delete(passkey_challenges).where(eq(passkey_challenges.kilo_user_id, otherUserId));
  });

  describe('createRegistrationOptions', () => {
    it('stores the challenge server-side and returns relying-party config', async () => {
      const { challengeId, options } = await createRegistrationOptions(userId, userEmail);

      expect(options.challenge).toHaveLength(43);
      expect(options.rp).toEqual({ id: rpId, name: 'Kilo Code' });
      expect(options.user.name).toBe(userEmail);
      expect(options.user.id).toBe(
        isoBase64URL.fromBuffer(createHash('sha256').update(userId).digest())
      );
      // The library mirrors `residentKey: 'required'` into the deprecated
      // `requireResidentKey` flag.
      expect(options.authenticatorSelection).toEqual({
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'preferred',
      });

      const [stored] = await db
        .select()
        .from(passkey_challenges)
        .where(eq(passkey_challenges.id, challengeId));
      expect(stored).toBeDefined();
      expect(stored.challenge).toBe(options.challenge);
      expect(stored.kind).toBe('registration');
      expect(stored.kilo_user_id).toBe(userId);
      expect(stored.consumed_at).toBeNull();
      const ttlMinutes = (new Date(stored.expires_at).getTime() - Date.now()) / 60000;
      expect(ttlMinutes).toBeGreaterThan(4.9);
      expect(ttlMinutes).toBeLessThan(5.1);
    });

    it('excludes the credentials the user already registered', async () => {
      const authenticator = createTestAuthenticator();
      const first = await createRegistrationOptions(userId, userEmail);
      const credential = await verifyRegistration(
        userId,
        first.challengeId,
        buildRegistrationResponse(authenticator, { challenge: first.options.challenge })
      );

      const second = await createRegistrationOptions(userId, userEmail);
      expect(second.options.excludeCredentials).toEqual([
        { id: credential.credential_id, transports: ['internal'], type: 'public-key' },
      ]);
    });
  });

  describe('verifyRegistration', () => {
    it('binds the credential to the authenticated user and stores the public key', async () => {
      const authenticator = createTestAuthenticator();
      const { challengeId, options } = await createRegistrationOptions(userId, userEmail);

      const credential = await verifyRegistration(
        userId,
        challengeId,
        buildRegistrationResponse(authenticator, { challenge: options.challenge })
      );

      expect(credential.kilo_user_id).toBe(userId);
      expect(credential.credential_id).toBe(authenticator.credentialId);
      expect(credential.public_key).toBe(isoBase64URL.fromBuffer(authenticator.cosePublicKey));
      expect(credential.sign_count).toBe(0);
      expect(credential.transports).toEqual(['internal']);
      expect(credential.device_type).toBe('singleDevice');
      expect(credential.backed_up).toBe(false);
    });

    it('refuses a response signed for a different challenge', async () => {
      const authenticator = createTestAuthenticator();
      const { challengeId } = await createRegistrationOptions(userId, userEmail);

      await expectRefusal(
        verifyRegistration(
          userId,
          challengeId,
          buildRegistrationResponse(authenticator, { challenge: 'not-the-stored-challenge' })
        ),
        'WRONG_CHALLENGE'
      );
    });

    it('refuses a replay after a successful registration', async () => {
      const authenticator = createTestAuthenticator();
      const { challengeId, options } = await createRegistrationOptions(userId, userEmail);
      const response = buildRegistrationResponse(authenticator, {
        challenge: options.challenge,
      });

      await expect(verifyRegistration(userId, challengeId, response)).resolves.toBeDefined();

      await expectRefusal(
        verifyRegistration(userId, challengeId, response),
        'CHALLENGE_ALREADY_USED'
      );
    });

    it('refuses an expired challenge', async () => {
      const authenticator = createTestAuthenticator();
      const challengeId = randomUUID();
      const challenge = isoBase64URL.fromBuffer(randomBytes(32));
      await db.insert(passkey_challenges).values({
        id: challengeId,
        challenge,
        kind: 'registration',
        kilo_user_id: userId,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      });

      await expectRefusal(
        verifyRegistration(
          userId,
          challengeId,
          buildRegistrationResponse(authenticator, { challenge })
        ),
        'CHALLENGE_EXPIRED'
      );
    });

    it('refuses an unknown challenge id', async () => {
      const authenticator = createTestAuthenticator();

      await expectRefusal(
        verifyRegistration(
          userId,
          randomUUID(),
          buildRegistrationResponse(authenticator, { challenge: 'anything' })
        ),
        'CHALLENGE_EXPIRED'
      );
    });

    it('refuses a response from another origin', async () => {
      const authenticator = createTestAuthenticator();
      const { challengeId, options } = await createRegistrationOptions(userId, userEmail);

      await expectRefusal(
        verifyRegistration(
          userId,
          challengeId,
          buildRegistrationResponse(authenticator, {
            challenge: options.challenge,
            origin: 'https://evil.example',
          })
        ),
        'VERIFICATION_FAILED'
      );
    });

    it('refuses a response for another rpId', async () => {
      const authenticator = createTestAuthenticator();
      const { challengeId, options } = await createRegistrationOptions(userId, userEmail);

      await expectRefusal(
        verifyRegistration(
          userId,
          challengeId,
          buildRegistrationResponse(authenticator, {
            challenge: options.challenge,
            rpIdHash: createHash('sha256').update('api.kilo.ai').digest(),
          })
        ),
        'VERIFICATION_FAILED'
      );
    });

    it('refuses a challenge minted for another user', async () => {
      const authenticator = createTestAuthenticator();
      const { challengeId, options } = await createRegistrationOptions(otherUserId, userEmail);

      await expectRefusal(
        verifyRegistration(
          userId,
          challengeId,
          buildRegistrationResponse(authenticator, { challenge: options.challenge })
        ),
        'VERIFICATION_FAILED'
      );
    });

    it('refuses a credential id already bound to another user', async () => {
      const authenticator = createTestAuthenticator();
      await insertCredential(authenticator, { kiloUserId: userId });

      const { challengeId, options } = await createRegistrationOptions(otherUserId, userEmail);
      await expectRefusal(
        verifyRegistration(
          otherUserId,
          challengeId,
          buildRegistrationResponse(authenticator, { challenge: options.challenge })
        ),
        'VERIFICATION_FAILED'
      );

      const bound = await db
        .select({ kilo_user_id: passkey_credentials.kilo_user_id })
        .from(passkey_credentials)
        .where(eq(passkey_credentials.credential_id, authenticator.credentialId));
      expect(bound).toEqual([{ kilo_user_id: userId }]);
    });
  });

  describe('createAuthenticationOptions', () => {
    it('stores an usernameless challenge with empty allowCredentials', async () => {
      const { challengeId, options } = await createAuthenticationOptions();

      expect(options.allowCredentials).toEqual([]);
      expect(options.userVerification).toBe('preferred');
      expect(options.rpId).toBe(rpId);
      expect(options.challenge).toHaveLength(43);

      const [stored] = await db
        .select()
        .from(passkey_challenges)
        .where(eq(passkey_challenges.id, challengeId));
      expect(stored).toBeDefined();
      expect(stored.challenge).toBe(options.challenge);
      expect(stored.kind).toBe('authentication');
      expect(stored.kilo_user_id).toBeNull();
    });
  });

  describe('verifyAuthentication', () => {
    it('returns a ticket and advances the stored counter', async () => {
      const authenticator = createTestAuthenticator();
      await insertCredential(authenticator, { signCount: 1 });

      const { challengeId, options } = await createAuthenticationOptions();
      const { ticket } = await verifyAuthentication(
        challengeId,
        buildAuthenticationResponse(authenticator, {
          challenge: options.challenge,
          counter: 2,
          userHandle: createHash('sha256').update(userId).digest(),
        })
      );

      expect(ticket).toHaveLength(64);

      const [credential] = await db
        .select()
        .from(passkey_credentials)
        .where(eq(passkey_credentials.credential_id, authenticator.credentialId));
      expect(credential.sign_count).toBe(2);
      expect(credential.last_used_at).not.toBeNull();

      const [ticketRow] = await db
        .select()
        .from(passkey_sign_in_tickets)
        .where(eq(passkey_sign_in_tickets.ticket_hash, sha256Hex(ticket)));
      expect(ticketRow).toBeDefined();
      expect(ticketRow.kilo_user_id).toBe(userId);
      expect(ticketRow.consumed_at).toBeNull();
    });

    it('mints only one ticket when concurrent assertions race with a nonzero counter', async () => {
      const authenticator = createTestAuthenticator();
      await insertCredential(authenticator, { signCount: 1 });

      const ceremonies = await Promise.all(
        Array.from({ length: 5 }, () => createAuthenticationOptions())
      );

      // Every assertion verifies against the stored counter of 1, so all of
      // them pass the "counter advanced" check before any write lands. Only the
      // compare-and-set that still matches the verified counter may mint.
      const attempts = await Promise.allSettled(
        ceremonies.map(ceremony =>
          verifyAuthentication(
            ceremony.challengeId,
            buildAuthenticationResponse(authenticator, {
              challenge: ceremony.options.challenge,
              counter: 2,
            })
          )
        )
      );

      expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);

      const tickets = await db
        .select()
        .from(passkey_sign_in_tickets)
        .where(eq(passkey_sign_in_tickets.kilo_user_id, userId));
      expect(tickets).toHaveLength(1);

      const [credential] = await db
        .select()
        .from(passkey_credentials)
        .where(eq(passkey_credentials.credential_id, authenticator.credentialId));
      expect(credential.sign_count).toBe(2);
    });

    it('refuses an unknown credential', async () => {
      const authenticator = createTestAuthenticator();
      const { challengeId, options } = await createAuthenticationOptions();

      await expectRefusal(
        verifyAuthentication(
          challengeId,
          buildAuthenticationResponse(authenticator, {
            challenge: options.challenge,
            counter: 1,
          })
        ),
        'UNKNOWN_CREDENTIAL'
      );
    });

    it('refuses a response signed for a different challenge', async () => {
      const authenticator = createTestAuthenticator();
      await insertCredential(authenticator);

      const { challengeId } = await createAuthenticationOptions();

      await expectRefusal(
        verifyAuthentication(
          challengeId,
          buildAuthenticationResponse(authenticator, {
            challenge: 'not-the-stored-challenge',
            counter: 1,
          })
        ),
        'WRONG_CHALLENGE'
      );
    });

    it('refuses a replay of a challenge that already succeeded', async () => {
      const authenticator = createTestAuthenticator();
      await insertCredential(authenticator);

      const { challengeId, options } = await createAuthenticationOptions();
      const response = buildAuthenticationResponse(authenticator, {
        challenge: options.challenge,
        counter: 1,
      });

      await expect(verifyAuthentication(challengeId, response)).resolves.toEqual({
        ticket: expect.any(String),
      });

      await expectRefusal(verifyAuthentication(challengeId, response), 'CHALLENGE_ALREADY_USED');
    });

    it('refuses a signature counter that did not advance', async () => {
      const authenticator = createTestAuthenticator();
      await insertCredential(authenticator, { signCount: 5 });

      const { challengeId, options } = await createAuthenticationOptions();

      await expectRefusal(
        verifyAuthentication(
          challengeId,
          buildAuthenticationResponse(authenticator, {
            challenge: options.challenge,
            counter: 5,
          })
        ),
        'VERIFICATION_FAILED'
      );
    });

    it('refuses an assertion from another origin', async () => {
      const authenticator = createTestAuthenticator();
      await insertCredential(authenticator);

      const { challengeId, options } = await createAuthenticationOptions();

      await expectRefusal(
        verifyAuthentication(
          challengeId,
          buildAuthenticationResponse(authenticator, {
            challenge: options.challenge,
            counter: 1,
            origin: 'https://evil.example',
          })
        ),
        'VERIFICATION_FAILED'
      );
    });
  });

  describe('passkey management', () => {
    it('lists only the credentials of the requested user', async () => {
      const mine = createTestAuthenticator();
      const theirs = createTestAuthenticator();
      await insertCredential(mine, { kiloUserId: userId });
      await insertCredential(theirs, { kiloUserId: otherUserId });

      const list = await listPasskeysForUser(userId);
      expect(list.map(credential => credential.credential_id)).toEqual([mine.credentialId]);
    });

    it('deletes only a credential that belongs to the user', async () => {
      const mine = createTestAuthenticator();
      const theirs = createTestAuthenticator();
      await insertCredential(mine, { kiloUserId: userId });
      await insertCredential(theirs, { kiloUserId: otherUserId });

      expect(await deletePasskey(userId, theirs.credentialId)).toBe(false);
      expect(await deletePasskey(userId, mine.credentialId)).toBe(true);

      const remaining = await db
        .select()
        .from(passkey_credentials)
        .where(eq(passkey_credentials.credential_id, theirs.credentialId));
      expect(remaining).toHaveLength(1);
    });

    it('renames only a credential that belongs to the user', async () => {
      const mine = createTestAuthenticator();
      const theirs = createTestAuthenticator();
      await insertCredential(mine, { kiloUserId: userId });
      await insertCredential(theirs, { kiloUserId: otherUserId });

      expect(await renamePasskey(userId, theirs.credentialId, 'not mine')).toBeNull();

      const renamed = await renamePasskey(userId, mine.credentialId, 'YubiKey 5C');
      expect(renamed?.name).toBe('YubiKey 5C');
    });
  });

  describe('sign-in tickets', () => {
    it('stores only a hash and is single-use', async () => {
      const ticket = await createSignInTicket(userId);

      const rows = await db
        .select()
        .from(passkey_sign_in_tickets)
        .where(eq(passkey_sign_in_tickets.kilo_user_id, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0].ticket_hash).toBe(sha256Hex(ticket));
      expect(rows[0].ticket_hash).not.toBe(ticket);

      const ttlMinutes = (new Date(rows[0].expires_at).getTime() - Date.now()) / 60000;
      expect(ttlMinutes).toBeGreaterThan(1.9);
      expect(ttlMinutes).toBeLessThan(2.1);

      const consumed = await consumeSignInTicket(ticket);
      expect(consumed?.kilo_user_id).toBe(userId);
      expect(await consumeSignInTicket(ticket)).toBeNull();
    });

    it('refuses an expired ticket', async () => {
      const ticket = await createSignInTicket(userId);
      await db
        .update(passkey_sign_in_tickets)
        .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
        .where(eq(passkey_sign_in_tickets.ticket_hash, sha256Hex(ticket)));

      expect(await consumeSignInTicket(ticket)).toBeNull();
    });

    it('refuses an unknown ticket', async () => {
      expect(await consumeSignInTicket('a'.repeat(64))).toBeNull();
    });

    it('deletes expired tickets and keeps still-valid ones', async () => {
      const live = await createSignInTicket(userId);
      const expired = await createSignInTicket(otherUserId);
      await db
        .update(passkey_sign_in_tickets)
        .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
        .where(eq(passkey_sign_in_tickets.ticket_hash, sha256Hex(expired)));

      // The cleanup deletes every expired ticket in the table; other tickets
      // this worker left behind must not make the count exact.
      expect(await cleanupExpiredPasskeySignInTickets()).toBeGreaterThanOrEqual(1);

      const expiredRows = await db
        .select()
        .from(passkey_sign_in_tickets)
        .where(eq(passkey_sign_in_tickets.ticket_hash, sha256Hex(expired)));
      expect(expiredRows).toHaveLength(0);

      const liveRows = await db
        .select()
        .from(passkey_sign_in_tickets)
        .where(eq(passkey_sign_in_tickets.ticket_hash, sha256Hex(live)));
      expect(liveRows).toHaveLength(1);
    });
  });
});

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
