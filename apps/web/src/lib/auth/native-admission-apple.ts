import 'server-only';
import { createHash, createVerify, X509Certificate } from 'node:crypto';
import { APPLE_APP_BUNDLE_ID, APPLE_TEAM_ID } from '@/lib/config.server';
import { captureMessage } from '@sentry/nextjs';

/**
 * Apple App Attest attestation verifier.
 *
 * Verifies attestation objects (key registration) and assertions (per-request
 * authentication) produced by the DeviceCheck App Attest service.
 *
 * https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server
 */

type CBORValue = number | Buffer | string | CBORValue[] | Map<number | string, CBORValue>;

const CBOR_MAJOR_UINT = 0;
const CBOR_MAJOR_NEGINT = 1;
const CBOR_MAJOR_BYTES = 2;
const CBOR_MAJOR_TEXT = 3;
const CBOR_MAJOR_ARRAY = 4;
const CBOR_MAJOR_MAP = 5;
const CBOR_MAJOR_TAG = 6;
const CBOR_INFO_MASK = 0x1f;
const CBOR_ADDITIONAL_1BYTE = 24;

class CBORDecodeError extends Error {}

function decodeCBORLength(buf: Buffer, offset: number): [number, number] {
  const byte0 = buf[offset];
  if (byte0 === undefined) throw new CBORDecodeError('unexpected end of buffer');
  const additional = byte0 & CBOR_INFO_MASK;
  if (additional < CBOR_ADDITIONAL_1BYTE) return [additional, offset + 1];
  if (additional === CBOR_ADDITIONAL_1BYTE) {
    const byte1 = buf[offset + 1];
    if (byte1 === undefined) throw new CBORDecodeError('unexpected end of buffer');
    return [byte1, offset + 2];
  }
  if (additional === 25) return [buf.readUInt16BE(offset + 1), offset + 3];
  if (additional === 26) return [buf.readUInt32BE(offset + 1), offset + 5];
  if (additional === 27) {
    const hi = buf.readUInt32BE(offset + 1);
    const lo = buf.readUInt32BE(offset + 5);
    const val = hi * 0x1_0000_0000 + lo;
    if (!Number.isSafeInteger(val)) throw new CBORDecodeError('unsafe integer length');
    return [val, offset + 9];
  }
  throw new CBORDecodeError(`unsupported additional info: ${additional}`);
}

/**
 * Decode a CBOR value. Map keys can be integer or string (COSE uses integer labels).
 */
function decodeCBOR(buf: Buffer, offset: number): [CBORValue, number] {
  const initialByte = buf[offset];
  if (initialByte === undefined) throw new CBORDecodeError('unexpected end of buffer');
  const initial = initialByte;
  const major = initial >> 5;
  switch (major) {
    case CBOR_MAJOR_UINT:
    case CBOR_MAJOR_NEGINT: {
      const [val, next] = decodeCBORLength(buf, offset);
      return [major === CBOR_MAJOR_NEGINT ? -1 - val : val, next];
    }
    case CBOR_MAJOR_BYTES: {
      const [len, start] = decodeCBORLength(buf, offset);
      return [Buffer.from(buf.subarray(start, start + len)), start + len];
    }
    case CBOR_MAJOR_TEXT: {
      const [len, start] = decodeCBORLength(buf, offset);
      return [buf.subarray(start, start + len).toString('utf8'), start + len];
    }
    case CBOR_MAJOR_ARRAY: {
      const [len, pos] = decodeCBORLength(buf, offset);
      const arr: CBORValue[] = [];
      let cursor = pos;
      for (let i = 0; i < len; i++) {
        const [val, next] = decodeCBOR(buf, cursor);
        arr.push(val);
        cursor = next;
      }
      return [arr, cursor];
    }
    case CBOR_MAJOR_MAP: {
      const [len, pos] = decodeCBORLength(buf, offset);
      // Allow both string and number map keys (COSE uses integer labels)
      const map = new Map<number | string, CBORValue>();
      let cursor = pos;
      for (let i = 0; i < len; i++) {
        const [keyVal, keyEnd] = decodeCBOR(buf, cursor);
        const [val, valEnd] = decodeCBOR(buf, keyEnd);
        if (typeof keyVal === 'number') {
          map.set(keyVal, val);
        } else if (typeof keyVal === 'string') {
          map.set(keyVal, val);
        } else if (keyVal instanceof Buffer) {
          map.set(keyVal.toString('hex'), val);
        } else {
          throw new CBORDecodeError(`map key must be string or number, got ${typeof keyVal}`);
        }
        cursor = valEnd;
      }
      return [map, cursor];
    }
    case CBOR_MAJOR_TAG: {
      const [, afterTag] = decodeCBORLength(buf, offset);
      return decodeCBOR(buf, afterTag);
    }
    default:
      throw new CBORDecodeError(`unsupported major type: ${major}`);
  }
}

function parseCBOR(buf: Buffer): CBORValue {
  const [value, offset] = decodeCBOR(buf, 0);
  if (offset !== buf.length) throw new CBORDecodeError('trailing bytes');
  return value;
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

  let attestMap: CBORValue;
  try {
    attestMap = parseCBOR(buf);
  } catch {
    return { ok: false, error: 'INVALID_ATTEST_FORMAT' };
  }

  if (!(attestMap instanceof Map)) return { ok: false, error: 'INVALID_ATTEST_FORMAT' };
  if (attestMap.get('fmt') !== 'apple-appattest')
    return { ok: false, error: 'INVALID_ATTEST_FORMAT' };

  const authData = attestMap.get('authData');
  if (!(authData instanceof Buffer) || authData.length < 37)
    return { ok: false, error: 'INVALID_ATTEST_FORMAT' };

  const attStmt = attestMap.get('attStmt');
  if (!(attStmt instanceof Map)) return { ok: false, error: 'INVALID_ATTEST_FORMAT' };
  const x5c = attStmt.get('x5c');
  if (!Array.isArray(x5c) || x5c.length < 2) return { ok: false, error: 'INVALID_ATTEST_FORMAT' };
  const credCertBuf = x5c[0];
  if (!(credCertBuf instanceof Buffer) || !x5c.slice(1).every(entry => entry instanceof Buffer)) {
    return { ok: false, error: 'INVALID_ATTEST_FORMAT' };
  }
  const chainDer: Buffer[] = [credCertBuf, ...(x5c.slice(1) as Buffer[])];

  // Certificate chain verification. Every certificate must be signed by the
  // next one in the array (leaf → intermediate → … → root) and the chain must
  // terminate at Apple's pinned App Attest root. Apple emits x5c as either
  // [leaf, intermediate, root] or [leaf, intermediate], so the terminal
  // certificate must either be the pinned root itself or be signed by it.
  let chain: X509Certificate[];
  try {
    chain = chainDer.map(der => new X509Certificate(der));
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

  // Extract COSE public key and convert to SPKI DER
  const coseKeyBuf = authData.subarray(pos);
  let publicKeySpkiBase64: string;
  try {
    publicKeySpkiBase64 = coseKeyToDerSpki(coseKeyBuf).toString('base64');
  } catch {
    return { ok: false, error: 'INVALID_ATTEST_FORMAT' };
  }

  return { ok: true, credentialId, publicKeySpkiBase64 };
}

// Apple App Attest nonce extension OID 1.2.840.113635.100.8.2.
const APPLE_ATTEST_NONCE_OID = Buffer.from([
  0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02,
]);

class DERDecodeError extends Error {}

interface DERTLV {
  /** 0 = universal, 2 = context-specific. */
  tagClass: number;
  constructed: boolean;
  tagNumber: number;
  content: Buffer;
}

/**
 * Read one DER TLV from `buf` starting at `offset`.
 *
 * Returns `[tlv, endOffset]`. Throws `DERDecodeError` for a malformed tag or
 * length and for any declared length that runs past the end of the buffer, so
 * callers can fail closed instead of reading out-of-bounds bytes.
 */
function readDERTLV(buf: Buffer, offset: number): [DERTLV, number] {
  const tagByte = buf[offset];
  if (tagByte === undefined) throw new DERDecodeError('unexpected end of buffer');
  const tagClass = tagByte >> 6;
  const constructed = (tagByte & 0x20) !== 0;
  let tagNumber = tagByte & 0x1f;
  let pos = offset + 1;
  if (tagNumber === 0x1f) {
    tagNumber = 0;
    let b: number;
    do {
      b = buf[pos];
      if (b === undefined) throw new DERDecodeError('unexpected end of tag');
      if (tagNumber > 0x7fffff) throw new DERDecodeError('tag number too large');
      tagNumber = tagNumber * 128 + (b & 0x7f);
      pos++;
    } while ((b & 0x80) !== 0);
  }

  const lenByte = buf[pos];
  if (lenByte === undefined) throw new DERDecodeError('unexpected end of length');
  pos++;
  let length: number;
  if (lenByte < 0x80) {
    length = lenByte;
  } else {
    const numOctets = lenByte & 0x7f;
    if (numOctets === 0) throw new DERDecodeError('indefinite length not allowed in DER');
    if (numOctets > 4) throw new DERDecodeError('length field too long');
    length = 0;
    for (let i = 0; i < numOctets; i++) {
      const octet = buf[pos];
      if (octet === undefined) throw new DERDecodeError('unexpected end of length');
      length = length * 256 + octet;
      pos++;
    }
  }
  const contentEnd = pos + length;
  if (contentEnd > buf.length) throw new DERDecodeError('length exceeds buffer');
  return [
    {
      tagClass,
      constructed,
      tagNumber,
      content: buf.subarray(pos, contentEnd),
    },
    contentEnd,
  ];
}

/**
 * Extract the nonce from the Apple App Attest credential certificate.
 *
 * The nonce extension (OID 1.2.840.113635.100.8.2) holds the DER value
 * `SEQUENCE { [1] EXPLICIT OCTET STRING }`, where the nested OCTET STRING is
 * the 32-byte nonce. The X.509 `extnValue` field wraps that value in an OCTET
 * STRING, so the parser walks four DER levels and requires each element to be
 * exactly the structure Apple emits. Returns null when the extension is
 * missing or malformed.
 */
export function extractAppleAttestNonce(certDer: Buffer): Buffer | null {
  const oidIdx = certDer.indexOf(APPLE_ATTEST_NONCE_OID);
  if (oidIdx === -1) return null;
  try {
    // 1. X.509 extnValue OCTET STRING.
    const [extn] = readDERTLV(certDer, oidIdx + APPLE_ATTEST_NONCE_OID.length);
    if (extn.tagClass !== 0 || extn.tagNumber !== 4 || extn.constructed) return null;

    // 2. Outer SEQUENCE containing exactly one element.
    const [outerSeq, afterOuterSeq] = readDERTLV(extn.content, 0);
    if (outerSeq.tagClass !== 0 || outerSeq.tagNumber !== 16 || !outerSeq.constructed) return null;
    if (afterOuterSeq !== extn.content.length) return null;

    // 3. [1] EXPLICIT context-specific constructed tag.
    const [tagged, afterTagged] = readDERTLV(outerSeq.content, 0);
    if (tagged.tagClass !== 2 || tagged.tagNumber !== 1 || !tagged.constructed) return null;
    if (afterTagged !== outerSeq.content.length) return null;

    // 4. Nested nonce OCTET STRING.
    const [nonce, afterNonce] = readDERTLV(tagged.content, 0);
    if (nonce.tagClass !== 0 || nonce.tagNumber !== 4 || nonce.constructed) return null;
    if (afterNonce !== tagged.content.length) return null;

    return nonce.content;
  } catch {
    return null;
  }
}

/** Convert a COSE EC2 P-256 key (CBOR map with integer labels) to DER-encoded SPKI. */
function coseKeyToDerSpki(coseKeyBuf: Buffer): Buffer {
  const coseKey = parseCBOR(coseKeyBuf);
  if (!(coseKey instanceof Map)) throw new Error('not a map');

  // COSE labels: 1=kty, -1=crv, -2=x, -3=y (all integers)
  if (coseKey.get(1) !== 2) throw new Error('not EC2');
  if (coseKey.get(-1) !== 1) throw new Error('not P-256');
  const x = coseKey.get(-2);
  const y = coseKey.get(-3);
  if (!(x instanceof Buffer) || !(y instanceof Buffer)) throw new Error('missing coordinates');
  if (x.length !== 32 || y.length !== 32) throw new Error('invalid coordinate length');

  // Uncompressed point: 04 || x || y
  const point = Buffer.concat([Buffer.from([0x04]), x, y]);

  // Build DER SPKI for secp256r1 (P-256)
  const algoSeq = Buffer.from([
    0x30,
    0x13, // SEQUENCE
    0x06,
    0x07,
    0x2a,
    0x86,
    0x48,
    0xce,
    0x3d,
    0x02,
    0x01, // ecPublicKey OID 1.2.840.10045.2.1
    0x06,
    0x08,
    0x2a,
    0x86,
    0x48,
    0xce,
    0x3d,
    0x03,
    0x01,
    0x07, // secp256r1 OID 1.2.840.10045.3.1.7
  ]);

  const bitStrLen = point.length + 1;
  const bitStr = Buffer.concat([
    bitStrLen < 0x80 ? Buffer.from([0x03, bitStrLen]) : Buffer.from([0x03, 0x81, bitStrLen]),
    Buffer.from([0x00]), // unused bits
    point,
  ]);

  const inner = Buffer.concat([algoSeq, bitStr]);
  return Buffer.concat([Buffer.from([0x30]), Buffer.from([inner.length]), inner]);
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

  let assertionMap: CBORValue;
  try {
    assertionMap = parseCBOR(assertionBuf);
  } catch {
    return { ok: false, error: 'INVALID_ASSERTION' };
  }

  if (!(assertionMap instanceof Map)) return { ok: false, error: 'INVALID_ASSERTION' };

  const signature = assertionMap.get('signature');
  const authenticatorData = assertionMap.get('authenticatorData');
  if (!(signature instanceof Buffer) || !(authenticatorData instanceof Buffer)) {
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
