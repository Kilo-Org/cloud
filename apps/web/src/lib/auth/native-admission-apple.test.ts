/**
 * Focused tests for the Apple App Attest verifier (`native-admission-apple.ts`).
 *
 * The chain fixtures are real Apple App Attest material:
 * - `REAL_LEAF_DER` is a credential certificate (credCert) and
 *   `REAL_INTERMEDIATE_DER` is its issuer "Apple App Attestation CA 1",
 *   captured from a real attestation. `X509Certificate.verify()` does not
 *   check validity windows, so the short fixture lifetimes do not matter.
 * - `REAL_ROOT_DER` is Apple's published "Apple App Attestation Root CA".
 * - `EVIL_ROOT_DER` / `EVIL_LEAF_DER` are a self-signed root and a leaf it
 *   signs; their signatures verify but they are not Apple's.
 */
import { describe, test, expect } from '@jest/globals';
import { createHash } from 'node:crypto';
import {
  appAttestClientDataHash,
  verifyAppleAttestation,
  extractAppleAttestNonce,
  parseAppleAttestNonceExtension,
} from './native-admission-apple';

jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/config.server', () => ({
  APPLE_TEAM_ID: 'WRPHYY66V6',
  APPLE_APP_BUNDLE_ID: 'com.reelreel.app.dev',
}));

// Real Apple App Attest credential certificate (dev-signed build, 2026-07).
const REAL_LEAF_DER = Buffer.from(
  'MIID3TCCA2KgAwIBAgIGAZ9IpNaMMAoGCCqGSM49BAMCME8xIzAhBgNVBAMMGkFwcGxlIEFwcCBBdHRlc3RhdGlvbiBDQSAxMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMB4XDTI2MDcwODIwNDk1MFoXDTI2MDcxMTIwNDk1MFowgZExSTBHBgNVBAMMQDFjODI3NDAwOTI5ZmZkOTRmMTg3YTcxZGFmNWY5Y2NlYTRlZDI4YmQ1NTk0YTRlZWNiMzEyY2E3N2M1OTA1YjYxGjAYBgNVBAsMEUFBQSBDZXJ0aWZpY2F0aW9uMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEp0c9CJJCNWYRhvcOBz0MldGUG+LQKk5dzNC1703zM0uZPHJ9ZSjyi/u5A8Xoc745s/2U8b4cfPrFKs+lF3C7wKOCAeUwggHhMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgTwMBQGA1UdJQQNMAsGCSqGSIb3Y2QEGDB9BgkqhkiG92NkCAUEcDBupAMCAQq/iTADAgEAv4kxAwIBAL+JMgMCAQC/iTMDAgEAv4k0IQQfN1JQSFlZNjZVNi5jb20ucmVhbHJlZWwuYXBwLmRldr+JNgMCAQS/iTcDAgEAv4k5AwIBAL+JOgMCAQC/iTsDAgEAqgMCAQAwgZwGCSqGSIb3Y2QIBwSBjjCBi7+KeAYEBDI2LjW/iFADAgEAv4p5CQQHMS4wLjIyM7+KewcEBTIzRjc3v4p8BgQEMjYuNb+KfQYEBDI2LjW/in4DAgEAv4sKDwQNMjMuNi43Ny4wLjAsML+LCw8EDTIzLjYuNzcuMC4wLDC/iwwPBA0yMy42Ljc3LjAuMCwwv4gCCgQIaXBob25lb3MwMwYJKoZIhvdjZAgCBCYwJKEiBCBcuc+AqQ9zUC7BfyqA5kdr0zQCVF1wd/JLoctSwifqOzBYBgkqhkiG92NkCAYESzBJo0cERTBDDAIxMTA9MAoMA29rZKEDAQH/MAkMAm9hoQMBAf8wCwwEb3NnbqEDAQH/MAsMBG9kZWyhAwEB/zAKDANvY2uhAwEB/zAKBggqhkjOPQQDAgNpADBmAjEA+im5HLrobxIOPTgeAebtPRJCEKYhd0bK2TPJ4+HieYLRJl7eKqq3GVz+3jAGlO2dAjEAuE52drtf8/eY+BwVmJ1LTayePv5Vv/3IjceVUSmGl1WhS76nsgFzlwHIi70JCnbS',
  'base64'
);

// Real Apple App Attest intermediate "Apple App Attestation CA 1".
const REAL_INTERMEDIATE_DER = Buffer.from(
  'MIICQzCCAcigAwIBAgIQCbrF4bxAGtnUU5W8OBoIVDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODM5NTVaFw0zMDAzMTMwMDAwMDBaME8xIzAhBgNVBAMMGkFwcGxlIEFwcCBBdHRlc3RhdGlvbiBDQSAxMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAErls3oHdNebI1j0Dn0fImJvHCX+8XgC3qs4JqWYdP+NKtFSV4mqJmBBkSSLY8uWcGnpjTY71eNw+/oI4ynoBzqYXndG6jWaL2bynbMq9FXiEWWNVnr54mfrJhTcIaZs6Zo2YwZDASBgNVHRMBAf8ECDAGAQH/AgEAMB8GA1UdIwQYMBaAFKyREFMzvb5oQf+nDKnl+url5YqhMB0GA1UdDgQWBBQ+410cBBmpybQx+IR01uHhV3LjmzAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaQAwZgIxALu+iI1zjQUCz7z9Zm0JV1A1vNaHLD+EMEkmKe3R+RToeZkcmui1rvjTqFQz97YNBgIxAKs47dDMge0ApFLDukT5k2NlU/7MKX8utN+fXr5aSsq2mVxLgg35BDhveAe7WJQ5tw==',
  'base64'
);

// Apple App Attestation Root CA (published by Apple).
const REAL_ROOT_DER = Buffer.from(
  'MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNaFw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlvbiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdhNbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9auYen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijVoyFraWVIyd/dganmrduC1bmTBGwD',
  'base64'
);

// The 32-byte nonce embedded in REAL_LEAF_DER's nonce extension.
const REAL_LEAF_NONCE = Buffer.from(
  '5cb9cf80a90f73502ec17f2a80e6476bd33402545d7077f24ba1cb52c227ea3b',
  'hex'
);

// A self-signed "evil" root CA and a leaf it signs. The signatures verify,
// but the chain does not terminate at Apple's pinned root.
const EVIL_ROOT_DER = Buffer.from(
  'MIIBvDCCAWGgAwIBAgIUIxhcSnRbntcgs+evcUEOTTktwp8wCgYIKoZIzj0EAwIwMzEdMBsGA1UEAwwURXZpbCBBcHAgQXR0ZXN0IFJvb3QxEjAQBgNVBAoMCUV2aWwgSW5jLjAeFw0yNjA4MDUwMzIxMzFaFw0zNjA4MDIwMzIxMzFaMDMxHTAbBgNVBAMMFEV2aWwgQXBwIEF0dGVzdCBSb290MRIwEAYDVQQKDAlFdmlsIEluYy4wWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATnRhkpT7LAa0PA1UNo9bfiGCMjI7RIG6DdfmfTk9J20LvwFTMQJR7uKUKUsScXumPTPFVCbtGgZoEP0g54oCZto1MwUTAdBgNVHQ4EFgQUFk31dBJCbk+jPpEAOcn9yBg5wW8wHwYDVR0jBBgwFoAUFk31dBJCbk+jPpEAOcn9yBg5wW8wDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEAkmxKmg21yRda1YyW+xPq7yS06t1t+Xj2g7xM0ciynaUCIQDe5KxJREZiI6vcTEPGI7Nu1MB1N6UhMjm0LoADJbMnaA==',
  'base64'
);

const EVIL_LEAF_DER = Buffer.from(
  'MIIBnzCCAUWgAwIBAgIUHFYSRgS0w/DiuO80iY+c7OnmhjwwCgYIKoZIzj0EAwIwMzEdMBsGA1UEAwwURXZpbCBBcHAgQXR0ZXN0IFJvb3QxEjAQBgNVBAoMCUV2aWwgSW5jLjAeFw0yNjA4MDUwMzIxMzFaFw0zNjA4MDIwMzIxMzFaMCgxEjAQBgNVBAMMCWV2aWwtbGVhZjESMBAGA1UECgwJRXZpbCBJbmMuMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEl6PL3kSmTAq1Q7R8gxaI83CBx3g11xxSGC5F/+yTlma4TMHfbWeZd4eFZpiWgKDmydYwkmY8QbadBBuT8GwaHKNCMEAwHQYDVR0OBBYEFNzed4Bs2iyp5DAB825XHV7hMdBXMB8GA1UdIwQYMBaAFBZN9XQSQm5Poz6RADnJ/cgYOcFvMAoGCCqGSM49BAMCA0gAMEUCIFWqf+29jpyO3XSz5XAn91Y03Z8K0f6eNjE50yYH80LIAiEAt6erE0yuB+3k0wWPKAuabJs4WWPrk2BVYpvmYzZ71kU=',
  'base64'
);

// ── CBOR encoding helpers (the verifier decodes CBOR, so the tests encode) ──

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  const out = Buffer.alloc(3);
  out[0] = (major << 5) | 25;
  out.writeUInt16BE(length, 1);
  return out;
}

function cborText(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([cborHead(3, bytes.length), bytes]);
}

function cborBytes(value: Buffer): Buffer {
  return Buffer.concat([cborHead(2, value.length), value]);
}

function cborInt(value: number): Buffer {
  if (value >= 0) return cborHead(0, value);
  return cborHead(1, -1 - value);
}

function cborArray(items: Buffer[]): Buffer {
  return Buffer.concat([cborHead(4, items.length), ...items]);
}

function cborMap(entries: Array<[Buffer, Buffer]>): Buffer {
  const body = Buffer.concat(entries.flatMap(([key, value]) => [key, value]));
  return Buffer.concat([cborHead(5, entries.length), body]);
}

/** Build a COSE EC2 P-256 key map with fixed-length coordinates. */
function buildCoseKey(): Buffer {
  return cborMap([
    [cborInt(1), cborInt(2)], // kty = EC2
    [cborInt(-1), cborInt(1)], // crv = P-256
    [cborInt(-2), cborBytes(Buffer.alloc(32, 0xaa))],
    [cborInt(-3), cborBytes(Buffer.alloc(32, 0xbb))],
  ]);
}

function buildAuthData(opts: { rpIdHash: Buffer; credentialId: Buffer; coseKey: Buffer }): Buffer {
  const credIdLen = Buffer.alloc(2);
  credIdLen.writeUInt16BE(opts.credentialId.length);
  return Buffer.concat([
    opts.rpIdHash,
    Buffer.from([0x40]), // AT flag set
    Buffer.from([0, 0, 0, 0]), // signCount
    Buffer.alloc(16), // aaguid
    credIdLen,
    opts.credentialId,
    opts.coseKey,
  ]);
}

function buildAttestation(x5c: Buffer[], authData: Buffer): string {
  const attStmt = cborMap([[cborText('x5c'), cborArray(x5c.map(cborBytes))]]);
  const object = cborMap([
    [cborText('fmt'), cborText('apple-appattest')],
    [cborText('attStmt'), attStmt],
    [cborText('authData'), cborBytes(authData)],
  ]);
  return object.toString('base64');
}

// ── clientDataHash convention ──────────────────────────────────────────────

describe('appAttestClientDataHash', () => {
  test('hashes the UTF-8 bytes of the challenge string', () => {
    // `@expo/app-integrity` computes SHA256(Data(challenge.utf8)) before calling
    // DCAppAttestService. Both sides must agree or every attestation and every
    // assertion fails with a nonce or signature mismatch.
    const challenge = 'c2VydmVyLWNoYWxsZW5nZQ';
    expect(appAttestClientDataHash(challenge)).toEqual(
      createHash('sha256').update(Buffer.from(challenge, 'utf8')).digest()
    );
  });

  test('does not base64url-decode the challenge first', () => {
    const challenge = 'c2VydmVyLWNoYWxsZW5nZQ';
    expect(appAttestClientDataHash(challenge)).not.toEqual(
      createHash('sha256').update(Buffer.from(challenge, 'base64url')).digest()
    );
  });
});

// ── Certificate chain verification ─────────────────────────────────────────

describe('verifyAppleAttestation certificate chain', () => {
  const teamId = 'WRPHYY66V6';
  const bundleId = 'com.reelreel.app.dev';
  const rpIdHash = createHash('sha256').update(`${teamId}.${bundleId}`).digest();
  // Apple's keyId is the SHA-256 of the public key in standard base64, so 32
  // bytes and a `=` pad. Build the fixture the way the device does; base64url
  // here would hide the padding mismatch that broke every real attestation.
  const credentialId = createHash('sha256').update('device-key').digest();
  const keyId = credentialId.toString('base64');
  const challenge = 'c2VydmVyLWNoYWxsZW5nZQ'; // arbitrary base64url bytes

  function attestationFor(x5c: Buffer[]): string {
    const authData = buildAuthData({ rpIdHash, credentialId, coseKey: buildCoseKey() });
    return buildAttestation(x5c, authData);
  }

  test('accepts the real Apple [leaf, intermediate] chain shape', async () => {
    const result = await verifyAppleAttestation(
      attestationFor([REAL_LEAF_DER, REAL_INTERMEDIATE_DER]),
      challenge,
      keyId,
      bundleId
    );

    // A real Apple chain must pass the certificate-chain, RP ID, flags, and
    // credential-ID checks. The fixture's nonce is fixed and cannot be
    // reproduced from new authData, so the verifier must stop at
    // NONCE_MISMATCH — never at CERT_CHAIN_INVALID.
    expect(result).toEqual({ ok: false, error: 'NONCE_MISMATCH' });
  });

  test('accepts the real Apple [leaf, intermediate, root] chain shape', async () => {
    const result = await verifyAppleAttestation(
      attestationFor([REAL_LEAF_DER, REAL_INTERMEDIATE_DER, REAL_ROOT_DER]),
      challenge,
      keyId,
      bundleId
    );
    expect(result).toEqual({ ok: false, error: 'NONCE_MISMATCH' });
  });

  test('rejects a chain that terminates at an unpinned root', async () => {
    const result = await verifyAppleAttestation(
      attestationFor([EVIL_LEAF_DER, EVIL_ROOT_DER]),
      challenge,
      keyId,
      bundleId
    );
    expect(result).toEqual({ ok: false, error: 'CERT_CHAIN_INVALID' });
  });

  test('accepts the standard-base64 keyId the device sends', async () => {
    // Regression: comparing `credentialId.toString('base64url')` against
    // Apple's padded standard-base64 keyId never matched, so every first-time
    // attestation was refused with ADMISSION_REQUIRED. Reaching NONCE_MISMATCH
    // proves the credential-ID check passed.
    expect(keyId).toMatch(/=$/);
    const result = await verifyAppleAttestation(
      attestationFor([REAL_LEAF_DER, REAL_INTERMEDIATE_DER]),
      challenge,
      keyId,
      bundleId
    );
    expect(result).toEqual({ ok: false, error: 'NONCE_MISMATCH' });
  });

  test('accepts the same key id in base64url form', async () => {
    const result = await verifyAppleAttestation(
      attestationFor([REAL_LEAF_DER, REAL_INTERMEDIATE_DER]),
      challenge,
      credentialId.toString('base64url'),
      bundleId
    );
    expect(result).toEqual({ ok: false, error: 'NONCE_MISMATCH' });
  });

  test('rejects a key id that is not the credential id', async () => {
    const result = await verifyAppleAttestation(
      attestationFor([REAL_LEAF_DER, REAL_INTERMEDIATE_DER]),
      challenge,
      createHash('sha256').update('other-key').digest('base64'),
      bundleId
    );
    expect(result).toEqual({ ok: false, error: 'KEY_ID_MISMATCH' });
  });

  test('rejects a chain whose signatures do not verify', async () => {
    // The real leaf is signed by the intermediate, not by the root.
    const result = await verifyAppleAttestation(
      attestationFor([REAL_LEAF_DER, REAL_ROOT_DER]),
      challenge,
      keyId,
      bundleId
    );
    expect(result).toEqual({ ok: false, error: 'CERT_CHAIN_INVALID' });
  });
});

// ── Nonce extension parsing ────────────────────────────────────────────────

describe('extractAppleAttestNonce', () => {
  test('extracts the nested nonce from the real Apple credential certificate', () => {
    expect(extractAppleAttestNonce(REAL_LEAF_DER)).toEqual(REAL_LEAF_NONCE);
  });

  test('returns null when the certificate carries no nonce extension', () => {
    // Apple's root CA is a real certificate without the App Attest extension.
    expect(extractAppleAttestNonce(REAL_ROOT_DER)).toBeNull();
  });

  test('returns null when the input is not a certificate', () => {
    expect(extractAppleAttestNonce(Buffer.from([0x30, 0x00]))).toBeNull();
    expect(extractAppleAttestNonce(Buffer.alloc(64, 0xab))).toBeNull();
  });

  test('returns null for a nonce-shaped byte run outside the extension', () => {
    // The OID bytes appear verbatim, but there is no X.509 structure around
    // them, so an OID-scanning parser would match and this one must not.
    const nonce = Buffer.alloc(32, 0xab);
    const oidBytes = Buffer.from([
      0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02,
    ]);
    expect(
      extractAppleAttestNonce(Buffer.concat([oidBytes, nonceExtensionValue(nonce)]))
    ).toBeNull();
  });
});

/** `SEQUENCE { [1] EXPLICIT OCTET STRING nonce }` — the value Apple emits. */
function nonceExtensionValue(nonce: Buffer): Buffer {
  const octet = Buffer.concat([Buffer.from([0x04, nonce.length]), nonce]);
  const tagged = Buffer.concat([Buffer.from([0xa1, octet.length]), octet]);
  return Buffer.concat([Buffer.from([0x30, tagged.length]), tagged]);
}

describe('parseAppleAttestNonceExtension', () => {
  test('extracts the nested nonce', () => {
    const nonce = Buffer.alloc(32, 0xab);
    expect(parseAppleAttestNonceExtension(nonceExtensionValue(nonce))).toEqual(nonce);
  });

  test('returns null when the [1] EXPLICIT context tag is missing', () => {
    // SEQUENCE { OCTET STRING nonce } without the [1] wrapper.
    const nonce = Buffer.alloc(32, 0xcd);
    const octet = Buffer.concat([Buffer.from([0x04, nonce.length]), nonce]);
    const seq = Buffer.concat([Buffer.from([0x30, octet.length]), octet]);
    expect(parseAppleAttestNonceExtension(seq)).toBeNull();
  });

  test('returns null when the [1] tag is primitive instead of constructed', () => {
    const nonce = Buffer.alloc(32, 0xab);
    const octet = Buffer.concat([Buffer.from([0x04, nonce.length]), nonce]);
    const seq = Buffer.concat([
      Buffer.from([0x30, octet.length + 2]),
      Buffer.from([0x81, octet.length]),
      octet,
    ]);
    expect(parseAppleAttestNonceExtension(seq)).toBeNull();
  });

  test('returns null when the outer sequence holds a second element', () => {
    const nonce = Buffer.alloc(32, 0xab);
    const octet = Buffer.concat([Buffer.from([0x04, nonce.length]), nonce]);
    const tagged = Buffer.concat([Buffer.from([0xa1, octet.length]), octet]);
    const seq = Buffer.concat([
      Buffer.from([0x30, tagged.length + 2]),
      tagged,
      Buffer.from([0x05, 0x00]),
    ]);
    expect(parseAppleAttestNonceExtension(seq)).toBeNull();
  });

  test('returns null when bytes trail the outer sequence', () => {
    const value = nonceExtensionValue(Buffer.alloc(32, 0xab));
    expect(
      parseAppleAttestNonceExtension(Buffer.concat([value, Buffer.from([0x05, 0x00])]))
    ).toBeNull();
  });

  test('returns null for a truncated length', () => {
    // The outer SEQUENCE claims more bytes than the buffer holds.
    expect(
      parseAppleAttestNonceExtension(Buffer.from([0x30, 0x1c, 0xa1, 0x1a, 0x04, 0x18]))
    ).toBeNull();
  });
});
