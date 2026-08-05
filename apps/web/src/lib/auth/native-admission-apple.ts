import 'server-only';
import { createHash, createPublicKey, createVerify, X509Certificate } from 'node:crypto';
import { decode as decodeCbor } from 'cbor2';
import { AsnParser } from '@peculiar/asn1-schema';
import { Certificate } from '@peculiar/asn1-x509';
import * as asn1js from 'asn1js';
import { APPLE_APP_BUNDLE_ID, APPLE_TEAM_ID } from '@/lib/config.server';
import { captureMessage } from '@sentry/nextjs';

/**
 * Apple App Attest attestation verifier.
 *
 * Verifies attestation objects (key registration) and assertions (per-request
 * authentication) produced by the DeviceCheck App Attest service.
 *
 * https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server
 *
 * CBOR, X.509, and ASN.1 decoding are delegated to `cbor2`, `@peculiar/asn1-x509`,
 * and `asn1js`. Only the App Attest rules live here.
 */

/**
 * Decode CBOR into a Map. `preferMap` keeps string-keyed maps as Maps, matching
 * the integer-keyed COSE maps, so one accessor shape covers both. `decode`
 * throws on truncated input and on trailing bytes, so every malformed payload
 * fails closed.
 */
function decodeCborMap(buf: Buffer): Map<unknown, unknown> | null {
  try {
    const value: unknown = decodeCbor(buf, { preferMap: true });
    return value instanceof Map ? (value as Map<unknown, unknown>) : null;
  } catch {
    return null;
  }
}

/** CBOR byte strings decode to Uint8Array; normalize to Buffer without copying. */
function asBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.length);
  return null;
}

// Apple App Attestation Root CA, published at
// https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
// The chain must terminate at this certificate; it is pinned by SHA-256
// fingerprint of the DER body.
const APPLE_APP_ATTEST_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

const ROOT_CA_SHA256 = '1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932';

// Parse the pinned root once. Fail loudly if the embedded PEM drifts from the
// pinned fingerprint, otherwise a corrupted pin silently rejects all
// attestations.
const APPLE_APP_ATTEST_ROOT_CERT = (() => {
  const cert = new X509Certificate(APPLE_APP_ATTEST_ROOT_PEM);
  const fingerprint = createHash('sha256').update(cert.raw).digest('hex');
  if (fingerprint !== ROOT_CA_SHA256) {
    throw new Error('Embedded Apple App Attest root CA fingerprint mismatch');
  }
  return cert;
})();

export type AppleAttestError =
  | 'INVALID_ATTEST_FORMAT'
  | 'CERT_CHAIN_INVALID'
  | 'RP_ID_MISMATCH'
  | 'NONCE_MISMATCH'
  | 'KEY_ID_MISMATCH';

export type AppleAssertionError = 'INVALID_ASSERTION' | 'KEY_NOT_FOUND';

/**
 * Verify an Apple App Attest attestation object and return the extracted
 * credential ID and DER-encoded SPKI public key.
 *
 * Attestation bytes are base64-encoded, as received from the mobile client.
 */
export async function verifyAppleAttestation(
  attestationBase64: string,
  challenge: string,
  expectedKeyId: string,
  bundleId: string = APPLE_APP_BUNDLE_ID
): Promise<
  | { ok: true; credentialId: Buffer; publicKeySpkiBase64: string }
  | { ok: false; error: AppleAttestError }
> {
  let buf: Buffer;
  try {
    buf = Buffer.from(attestationBase64, 'base64');
  } catch {
    return { ok: false, error: 'INVALID_ATTEST_FORMAT' };
  }

  const attestMap = decodeCborMap(buf);
  if (!attestMap) return { ok: false, error: 'INVALID_ATTEST_FORMAT' };
  if (attestMap.get('fmt') !== 'apple-appattest')
    return { ok: false, error: 'INVALID_ATTEST_FORMAT' };

  const authData = asBuffer(attestMap.get('authData'));
  if (!authData || authData.length < 37) return { ok: false, error: 'INVALID_ATTEST_FORMAT' };

  const attStmt = attestMap.get('attStmt');
  if (!(attStmt instanceof Map)) return { ok: false, error: 'INVALID_ATTEST_FORMAT' };
  const x5c = attStmt.get('x5c');
  if (!Array.isArray(x5c) || x5c.length < 2) return { ok: false, error: 'INVALID_ATTEST_FORMAT' };
  const chainDer = x5c.map(entry => asBuffer(entry));
  if (chainDer.some(entry => entry === null)) {
    return { ok: false, error: 'INVALID_ATTEST_FORMAT' };
  }
  const chainBuffers = chainDer as Buffer[];
  const credCertBuf = chainBuffers[0];

  // Certificate chain verification. Every certificate must be signed by the
  // next one in the array (leaf → intermediate → … → root) and the chain must
  // terminate at Apple's pinned App Attest root. Apple emits x5c as either
  // [leaf, intermediate, root] or [leaf, intermediate], so the terminal
  // certificate must either be the pinned root itself or be signed by it.
  let chain: X509Certificate[];
  try {
    chain = chainBuffers.map(der => new X509Certificate(der));
  } catch {
    return { ok: false, error: 'CERT_CHAIN_INVALID' };
  }

  try {
    for (let i = 0; i < chain.length - 1; i++) {
      if (!chain[i].verify(chain[i + 1].publicKey)) {
        return { ok: false, error: 'CERT_CHAIN_INVALID' };
      }
    }
  } catch {
    return { ok: false, error: 'CERT_CHAIN_INVALID' };
  }

  const terminalCert = chain[chain.length - 1];
  const terminalFingerprint = createHash('sha256').update(terminalCert.raw).digest('hex');
  if (terminalFingerprint !== ROOT_CA_SHA256) {
    try {
      if (!terminalCert.verify(APPLE_APP_ATTEST_ROOT_CERT.publicKey)) {
        captureMessage(`apple_attest_unknown_ca: ${terminalFingerprint}`);
        return { ok: false, error: 'CERT_CHAIN_INVALID' };
      }
    } catch {
      captureMessage(`apple_attest_unknown_ca: ${terminalFingerprint}`);
      return { ok: false, error: 'CERT_CHAIN_INVALID' };
    }
  }

  // RP ID hash check — authData bytes 0-31
  // The RP ID is the full Apple App ID: TeamID.BundleID.
  const appId = `${APPLE_TEAM_ID}.${bundleId}`;
  const expectedRpIdHash = createHash('sha256').update(appId).digest();
  if (!authData.subarray(0, 32).equals(expectedRpIdHash)) {
    return { ok: false, error: 'RP_ID_MISMATCH' };
  }

  // Nonce check.
  // Apple's nonce is SHA256(authData || clientDataHash).
  // App Attest: clientDataHash = SHA256(challenge).
  // The server challenge is base64url-encoded random bytes. The mobile client
  // hashes the raw challenge bytes to produce clientDataHash.
  const clientDataHash = createHash('sha256').update(Buffer.from(challenge, 'base64url')).digest();

  // Apple nonce = SHA256(authData || clientDataHash)
  const expectedNonce = createHash('sha256')
    .update(Buffer.concat([authData, clientDataHash]))
    .digest('hex');

  const nonceExt = extractAppleAttestNonce(credCertBuf);
  if (!nonceExt || nonceExt.toString('hex') !== expectedNonce) {
    captureMessage(
      `apple_attest_nonce_mismatch: expected=${expectedNonce.substring(0, 16)}... got=${nonceExt?.toString('hex').substring(0, 16) ?? 'null'}...`
    );
    return { ok: false, error: 'NONCE_MISMATCH' };
  }

  // Extract credential ID from authData
  const flagsByte = authData[32];
  if (flagsByte === undefined) return { ok: false, error: 'INVALID_ATTEST_FORMAT' };
  const flags = flagsByte;
  if (!(flags & 0x40)) return { ok: false, error: 'INVALID_ATTEST_FORMAT' }; // AT flag

  let pos = 37; // rpIdHash(32) + flags(1) + signCount(4)
  pos += 16; // aaguid
  const credIdLen = authData.readUInt16BE(pos);
  pos += 2;
  const credentialId = authData.subarray(pos, pos + credIdLen);
  pos += credIdLen;

  // Verify keyId matches credential ID
  if (credentialId.toString('base64url') !== expectedKeyId) {
    return { ok: false, error: 'KEY_ID_MISMATCH' };
  }

  // Extract COSE public key and export it as SPKI DER
  const coseKeyBuf = authData.subarray(pos);
  let publicKeySpkiBase64: string;
  try {
    publicKeySpkiBase64 = coseKeyToPublicKey(coseKeyBuf)
      .export({ type: 'spki', format: 'der' })
      .toString('base64');
  } catch {
    return { ok: false, error: 'INVALID_ATTEST_FORMAT' };
  }

  return { ok: true, credentialId, publicKeySpkiBase64 };
}

/** Apple App Attest nonce extension. */
const APPLE_ATTEST_NONCE_OID = '1.2.840.113635.100.8.2';

/** asn1js tag classes are 1-indexed: 1 = universal, 3 = context-specific. */
const ASN1_CLASS_CONTEXT = 3;

/**
 * Decode the Apple nonce extension's value: `SEQUENCE { [1] EXPLICIT OCTET STRING }`.
 *
 * Exported so the grammar can be unit tested without re-signing a certificate.
 * Every level must be exactly the structure Apple emits, and no trailing bytes
 * are tolerated, so a malformed value returns null instead of a partial read.
 */
export function parseAppleAttestNonceExtension(extnValue: Buffer): Buffer | null {
  const { result, offset } = asn1js.fromBER(extnValue);
  if (offset === -1 || offset !== extnValue.length) return null;

  if (!(result instanceof asn1js.Sequence)) return null;
  const sequenceItems = result.valueBlock.value;
  if (sequenceItems.length !== 1) return null;

  const tagged = sequenceItems[0];
  if (!(tagged instanceof asn1js.Constructed)) return null;
  if (tagged.idBlock.tagClass !== ASN1_CLASS_CONTEXT || tagged.idBlock.tagNumber !== 1) return null;

  const taggedItems = tagged.valueBlock.value;
  if (taggedItems.length !== 1) return null;

  const nonce = taggedItems[0];
  if (!(nonce instanceof asn1js.OctetString)) return null;

  return Buffer.from(nonce.valueBlock.valueHexView);
}

/**
 * Extract the nonce from the Apple App Attest credential certificate.
 *
 * The certificate is parsed as X.509 and the extension is located by OID, so a
 * nonce-shaped byte run elsewhere in the certificate cannot be mistaken for the
 * extension. Returns null when the certificate, the extension, or the nested
 * value is missing or malformed.
 */
export function extractAppleAttestNonce(certDer: Buffer): Buffer | null {
  try {
    const certificate = AsnParser.parse(certDer, Certificate);
    const extension = certificate.tbsCertificate.extensions?.find(
      candidate => candidate.extnID === APPLE_ATTEST_NONCE_OID
    );
    if (!extension) return null;
    return parseAppleAttestNonceExtension(Buffer.from(extension.extnValue.buffer));
  } catch {
    return null;
  }
}

/**
 * Convert a COSE EC2 P-256 key (CBOR map with integer labels) to a public key.
 *
 * The COSE coordinates go through a JWK, so Node builds the SPKI encoding and
 * validates the point instead of this module hand-writing DER.
 */
function coseKeyToPublicKey(coseKeyBuf: Buffer) {
  const coseKey = decodeCborMap(coseKeyBuf);
  if (!coseKey) throw new Error('not a map');

  // COSE labels: 1=kty, -1=crv, -2=x, -3=y (all integers)
  if (coseKey.get(1) !== 2) throw new Error('not EC2');
  if (coseKey.get(-1) !== 1) throw new Error('not P-256');
  const x = asBuffer(coseKey.get(-2));
  const y = asBuffer(coseKey.get(-3));
  if (!x || !y) throw new Error('missing coordinates');
  if (x.length !== 32 || y.length !== 32) throw new Error('invalid coordinate length');

  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: x.toString('base64url'),
      y: y.toString('base64url'),
    },
    format: 'jwk',
  });
}

// ── Assertion verification ────────────────────────────────────────────────

/**
 * Verify an Apple App Attest assertion using a previously stored public key.
 *
 * Returns the sign count from the authenticator data so the caller can
 * enforce a strictly increasing counter.
 */
export async function verifyAppleAssertion(
  keyId: string,
  clientDataHash: Buffer,
  assertionBase64: string,
  publicKeySpkiBase64: string
): Promise<{ ok: true; signCount: number } | { ok: false; error: AppleAssertionError }> {
  let assertionBuf: Buffer;
  try {
    assertionBuf = Buffer.from(assertionBase64, 'base64');
  } catch {
    return { ok: false, error: 'INVALID_ASSERTION' };
  }

  const assertionMap = decodeCborMap(assertionBuf);
  if (!assertionMap) return { ok: false, error: 'INVALID_ASSERTION' };

  const signature = asBuffer(assertionMap.get('signature'));
  const authenticatorData = asBuffer(assertionMap.get('authenticatorData'));
  if (!signature || !authenticatorData) {
    return { ok: false, error: 'INVALID_ASSERTION' };
  }

  // Extract sign count from authenticatorData (bytes 33-36, big-endian uint32)
  if (authenticatorData.length < 37) {
    return { ok: false, error: 'INVALID_ASSERTION' };
  }
  const signCount = authenticatorData.readUInt32BE(33);

  // Verify: signature over (authenticatorData || clientDataHash)
  try {
    const publicKeyDer = Buffer.from(publicKeySpkiBase64, 'base64');
    const verify = createVerify('sha256');
    verify.update(Buffer.concat([authenticatorData, clientDataHash]));
    verify.end();
    if (!verify.verify({ key: publicKeyDer, format: 'der', type: 'spki' }, signature)) {
      return { ok: false, error: 'INVALID_ASSERTION' };
    }
  } catch {
    return { ok: false, error: 'INVALID_ASSERTION' };
  }

  return { ok: true, signCount };
}
