import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { NEXTAUTH_URL } from '@kilocode/web-shared/lib/config.server';

type CborMap = Map<string | number, unknown>;

/** A `Uint8Array` over a plain `ArrayBuffer`, which is what the WebAuthn helpers take. */
type Bytes = Uint8Array<ArrayBuffer>;

export type TestAuthenticator = {
  credentialId: string;
  cosePublicKey: Bytes;
  privateKey: KeyObject;
  rpIdHash: Uint8Array;
};

function toBytes(value: Uint8Array): Bytes {
  return new Uint8Array(value);
}

function encodeCbor(value: CborMap): Bytes {
  return new Uint8Array(isoCBOR.encode(value as Parameters<typeof isoCBOR.encode>[0]));
}

/**
 * A software authenticator: a real P-256 key pair plus the COSE public key a
 * registration ceremony would return, so signatures built here verify against
 * the stored public key exactly like a platform authenticator's would.
 */
export function createTestAuthenticator(
  authenticatorRpId: string = new URL(NEXTAUTH_URL).hostname
): TestAuthenticator {
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

export function buildRegistrationResponse(
  authenticator: TestAuthenticator,
  opts: {
    challenge: string;
    origin?: string;
    rpIdHash?: Uint8Array;
    counter?: number;
    /** Defaults to UP | UV | AT (0x45). */
    flags?: number;
  }
): RegistrationResponseJSON {
  const authData = buildAuthenticatorData({
    rpIdHash: opts.rpIdHash ?? authenticator.rpIdHash,
    flags: opts.flags ?? 0x45,
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
        opts.origin ?? new URL(NEXTAUTH_URL).origin
      ),
      attestationObject: isoBase64URL.fromBuffer(attestationObject),
      transports: ['internal'],
    },
  };
}

export function buildAuthenticationResponse(
  authenticator: TestAuthenticator,
  opts: {
    challenge: string;
    counter: number;
    origin?: string;
    rpIdHash?: Uint8Array;
    userHandle?: Uint8Array;
    /** Defaults to UP | UV (0x05). Pass 0x01 for UP without UV. */
    flags?: number;
  }
): AuthenticationResponseJSON {
  const clientDataJSON = buildClientDataJSON(
    'webauthn.get',
    opts.challenge,
    opts.origin ?? new URL(NEXTAUTH_URL).origin
  );
  const authData = buildAuthenticatorData({
    rpIdHash: opts.rpIdHash ?? authenticator.rpIdHash,
    flags: opts.flags ?? 0x05,
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
