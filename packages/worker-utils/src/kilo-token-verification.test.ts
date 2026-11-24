import { describe, it, expect } from 'vitest';
import { SignJWT, UnsecuredJWT, exportJWK, generateKeyPair } from 'jose';
import {
  assertKiloTokenIssuedAt,
  verifyKiloTokenSignature,
  type KiloTokenVerificationEvent,
  type KiloTokenVerifier,
} from './kilo-token-verification.js';
import { createLegacyHs256KiloTokenSigner } from './kilo-token-signer.js';

const SECRET = 'test-secret-at-least-32-characters-long';

function recordingVerifier(): {
  verifier: KiloTokenVerifier;
  events: KiloTokenVerificationEvent[];
} {
  const events: KiloTokenVerificationEvent[] = [];
  return {
    verifier: {
      keys: { legacyHs256Secret: SECRET },
      acceptedIssuers: ['kilo-web'],
      onVerification: event => events.push(event),
    },
    events,
  };
}

async function signHs256(payload: Record<string, unknown>, secret = SECRET, expiresIn = '1h') {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));
}

describe('verifyKiloTokenSignature', () => {
  it('verifies an HS256 token signed with the legacy secret and reports it', async () => {
    const { verifier, events } = recordingVerifier();
    const token = await signHs256(
      { kiloUserId: 'user-1', botId: 'bot-1', aud: 'kilo-api' },
      SECRET,
      '5m'
    );

    const { payload } = await verifyKiloTokenSignature(token, verifier, { audience: 'kilo-api' });

    expect(payload).toMatchObject({ kiloUserId: 'user-1', botId: 'bot-1', aud: 'kilo-api' });
    expect(events).toEqual([
      {
        outcome: 'verified',
        alg: 'HS256',
        issuer: 'legacy',
        expectedAudience: 'kilo-api',
        audienceForm: 'string',
        lifetimeBucket: 'up-to-5m',
        hasTokenPurpose: false,
        hasBotId: true,
        hasInternalApiUse: false,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('user-1');
  });

  it('accepts a token from the legacy HS256 signer', async () => {
    const signer = createLegacyHs256KiloTokenSigner('kilo-web', SECRET);
    const now = Math.floor(Date.now() / 1000);
    const token = await signer.sign({ kiloUserId: 'user-1', iat: now, exp: now + 60 });

    await expect(
      verifyKiloTokenSignature(token, recordingVerifier().verifier)
    ).resolves.toMatchObject({ payload: { kiloUserId: 'user-1' } });
    expect(signer.issuer).toBe('kilo-web');
  });

  it('keeps the jose audience, issuer and clock checks', async () => {
    const { verifier } = recordingVerifier();
    const token = await signHs256({ aud: 'kilo-api', iss: 'kilocode-runtime-proxy' });

    await expect(
      verifyKiloTokenSignature(token, verifier, { audience: 'kilo-gateway' })
    ).rejects.toThrow();
    await expect(verifyKiloTokenSignature(token, verifier, { issuer: 'other' })).rejects.toThrow();
    await expect(
      verifyKiloTokenSignature(token, verifier, {
        currentDate: new Date(Date.now() + 2 * 3600_000),
      })
    ).rejects.toThrow();
  });

  it('rejects an HS256 token signed with another secret', async () => {
    const { verifier, events } = recordingVerifier();
    const token = await signHs256(
      { kiloUserId: 'user-1' },
      'another-secret-at-least-32-characters'
    );

    await expect(verifyKiloTokenSignature(token, verifier)).rejects.toThrow();
    expect(events).toEqual([
      { outcome: 'rejected', reason: 'invalid-signature', alg: 'HS256', expectedAudience: null },
    ]);
  });

  it('reports an expired HS256 token', async () => {
    const { verifier, events } = recordingVerifier();
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ kiloUserId: 'user-1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now - 120)
      .setExpirationTime(now - 60)
      .sign(new TextEncoder().encode(SECRET));

    await expect(verifyKiloTokenSignature(token, verifier)).rejects.toThrow();
    expect(events).toMatchObject([{ outcome: 'rejected', reason: 'expired', alg: 'HS256' }]);
  });

  it('rejects ES256 tokens while the JWKS path is not active', async () => {
    const { verifier, events } = recordingVerifier();
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const publicJwk = { ...(await exportJWK(publicKey)), kid: 'kilo-web:1', alg: 'ES256' };
    const token = await new SignJWT({ kiloUserId: 'user-1' })
      .setProtectedHeader({ alg: 'ES256', kid: 'kilo-web:1' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    await expect(
      verifyKiloTokenSignature(token, {
        ...verifier,
        keys: { ...verifier.keys, publicJwks: { keys: [publicJwk] } },
      })
    ).rejects.toThrow();
    expect(events).toEqual([
      {
        outcome: 'rejected',
        reason: 'unsupported-algorithm',
        alg: 'ES256',
        expectedAudience: null,
      },
    ]);
  });

  it('rejects other HMAC algorithms even with the legacy secret', async () => {
    const { verifier, events } = recordingVerifier();
    const token = await new SignJWT({ kiloUserId: 'user-1' })
      .setProtectedHeader({ alg: 'HS512' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET.repeat(2)));

    await expect(verifyKiloTokenSignature(token, verifier)).rejects.toThrow();
    expect(events).toMatchObject([
      { outcome: 'rejected', reason: 'unsupported-algorithm', alg: 'other' },
    ]);
  });

  it('rejects alg none', async () => {
    const { verifier, events } = recordingVerifier();
    const token = new UnsecuredJWT({ kiloUserId: 'user-1' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .encode();

    await expect(verifyKiloTokenSignature(token, verifier)).rejects.toThrow();
    expect(events).toMatchObject([
      { outcome: 'rejected', reason: 'unsupported-algorithm', alg: 'none' },
    ]);
  });

  it('rejects a malformed token', async () => {
    const { verifier, events } = recordingVerifier();

    await expect(verifyKiloTokenSignature('not-a-jwt', verifier)).rejects.toThrow();
    expect(events).toMatchObject([{ outcome: 'rejected', reason: 'malformed', alg: 'malformed' }]);
  });

  it('does not let a throwing callback change the outcome', async () => {
    const token = await signHs256({ kiloUserId: 'user-1' });
    const verifier: KiloTokenVerifier = {
      keys: { legacyHs256Secret: SECRET },
      acceptedIssuers: ['kilo-web'],
      onVerification: () => {
        throw new Error('sink failed');
      },
    };

    await expect(verifyKiloTokenSignature(token, verifier)).resolves.toMatchObject({
      payload: { kiloUserId: 'user-1' },
    });
  });

  it('requires an accepted issuer list', () => {
    const keys = { legacyHs256Secret: SECRET };
    // @ts-expect-error acceptedIssuers is required
    const missing: KiloTokenVerifier = { keys };
    // @ts-expect-error acceptedIssuers cannot be empty
    const empty: KiloTokenVerifier = { keys, acceptedIssuers: [] };
    // @ts-expect-error acceptedIssuers holds registered issuer IDs only
    const unknown: KiloTokenVerifier = { keys, acceptedIssuers: ['deploy-builder'] };
    expect([missing, empty, unknown]).toHaveLength(3);
  });
});

describe('assertKiloTokenIssuedAt', () => {
  it('rejects a missing iat', () => {
    expect(() => assertKiloTokenIssuedAt(undefined, 1_000)).toThrow(
      'Missing or invalid token issued-at'
    );
  });

  it('rejects an iat in the future', () => {
    expect(() => assertKiloTokenIssuedAt(1_001, 1_000)).toThrow('Token issued in the future');
  });

  it('accepts an iat in the past', () => {
    expect(() => assertKiloTokenIssuedAt(999, 1_000)).not.toThrow();
  });
});
