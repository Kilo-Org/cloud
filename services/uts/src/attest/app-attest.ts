import { AsnConvert, AsnParser } from '@peculiar/asn1-schema';
import { BasicConstraints, Certificate, id_ce_basicConstraints } from '@peculiar/asn1-x509';
import { Buffer } from 'node:buffer';
import { decode, decodeSequence, getEncoded } from 'cbor2';
import { appAttestNonce, ecdsaSignatureToRaw, signedPart } from './der';

/**
 * Apple App Attest (design 5.5): the attestation of a new key and the assertions it signs later.
 * The checks follow Apple's "Validating apps that connect to your server": the certificate chain to
 * the pinned App Attest root, the nonce over the authenticator data and the client data hash, the
 * key id as the SHA-256 of the credential certificate's key, the App ID hash, a zero counter, the
 * App Attest environment, and the credential id. Nothing here calls Apple. Each refusal names the
 * rule that failed, never a value the client sent.
 */

/**
 * Apple App Attestation Root CA, as Apple publishes it at
 * https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem. Its SHA-256 is
 * `APPLE_APP_ATTEST_ROOT_SHA256` (`test/unit/app-attest.test.ts` checks both).
 */
export const APPLE_APP_ATTEST_ROOT: Uint8Array = Buffer.from(
  'MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0' +
    'YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa' +
    'Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlvbiBSb290IENBMRMwEQYDVQQKDApBcHBs' +
    'ZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh' +
    'NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9auYen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9T' +
    'gS41o0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw' +
    'CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4' +
    'xDgEgllF7En3VcE3iexZZtKeYnpqtijVoyFraWVIyd/dganmrduC1bmTBGwD',
  'base64'
);
export const APPLE_APP_ATTEST_ROOT_SHA256 =
  '1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932';

/** The App Attest environment an attestation names in its AAGUID. */
export type AppAttestEnvironment = 'production' | 'development';

const AAGUIDS: Readonly<Record<AppAttestEnvironment, Uint8Array>> = {
  // `appattest` followed by seven zero bytes.
  production: new Uint8Array([...new TextEncoder().encode('appattest'), 0, 0, 0, 0, 0, 0, 0]),
  development: new TextEncoder().encode('appattestdevelop'),
};

export type AppAttestSettings = {
  /** `<team id>.<bundle id>`, whose SHA-256 is the RP ID hash of the authenticator data. */
  appId: string;
  /** The trust anchor: `APPLE_APP_ATTEST_ROOT` in every deployed environment. */
  rootCertificate: Uint8Array;
  /** The App Attest environments accepted: production only, except in UTS development. */
  environments: readonly AppAttestEnvironment[];
};

export type AppAttestRefusal =
  | 'malformed'
  | 'certificate_chain'
  | 'certificate_validity'
  | 'app_id_mismatch'
  | 'environment_mismatch'
  | 'counter_not_zero'
  | 'key_id_mismatch'
  | 'nonce_mismatch'
  | 'signature_invalid';

export type KeyAttestationResult =
  | { status: 'verified'; publicKey: Uint8Array }
  | { status: 'refused'; reason: AppAttestRefusal };

export type AssertionResult =
  | { status: 'verified'; signCount: number }
  | { status: 'refused'; reason: AppAttestRefusal };

const NONCE_EXTENSION = '1.2.840.113635.100.8.2';
const EC_PUBLIC_KEY = '1.2.840.10045.2.1';
const ECDSA_HASHES: Readonly<Record<string, 'SHA-256' | 'SHA-384'>> = {
  '1.2.840.10045.4.3.2': 'SHA-256',
  '1.2.840.10045.4.3.3': 'SHA-384',
};
/** The DER `namedCurve` parameters of the two curves in the chain. */
const CURVES = [
  { name: 'P-256', size: 32, oid: [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07] },
  { name: 'P-384', size: 48, oid: [0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22] },
] as const;
type Curve = (typeof CURVES)[number];

const AUTH_DATA_FIXED = 32 + 1 + 4;
const ATTESTED_CREDENTIAL_FLAG = 0x40;
const KEY_ID_BYTES = 32;

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function sha256(bytes: Uint8Array | string): Promise<Uint8Array> {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** A CBOR map; byte strings decode to `Uint8Array`, and a repeated key is refused. */
function cborMap(bytes: Uint8Array): Map<unknown, unknown> | null {
  try {
    const value: unknown = decode(bytes, { preferMap: true, rejectDuplicateKeys: true });
    return value instanceof Map ? value : null;
  } catch {
    return null;
  }
}

function bytesOf(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

type ParsedCertificate = {
  certificate: Certificate;
  signed: Uint8Array;
  curve: Curve;
  /** The SubjectPublicKeyInfo DER, for WebCrypto. */
  spki: Uint8Array;
  /** The uncompressed EC point. */
  point: Uint8Array;
};

function parseCertificate(der: Uint8Array): ParsedCertificate | null {
  const signed = signedPart(der);
  if (signed === null) return null;
  let certificate: Certificate;
  try {
    certificate = AsnParser.parse(der, Certificate);
  } catch {
    return null;
  }
  const info = certificate.tbsCertificate.subjectPublicKeyInfo;
  if (info.algorithm.algorithm !== EC_PUBLIC_KEY || !info.algorithm.parameters) return null;
  const parameters = new Uint8Array(info.algorithm.parameters);
  const curve = CURVES.find(candidate => equalBytes(new Uint8Array(candidate.oid), parameters));
  const point = new Uint8Array(info.subjectPublicKey);
  if (curve === undefined || point.length !== 1 + 2 * curve.size || point[0] !== 4) return null;
  return {
    certificate,
    signed,
    curve,
    spki: new Uint8Array(AsnConvert.serialize(info)),
    point,
  };
}

/** True when `issuer`'s key signed `subject`. */
async function signedBy(subject: ParsedCertificate, issuer: ParsedCertificate): Promise<boolean> {
  const algorithm = subject.certificate.signatureAlgorithm.algorithm;
  const hash = ECDSA_HASHES[algorithm];
  if (hash === undefined || subject.certificate.tbsCertificate.signature.algorithm !== algorithm) {
    return false;
  }
  const signature = ecdsaSignatureToRaw(
    new Uint8Array(subject.certificate.signatureValue),
    issuer.curve.size
  );
  if (signature === null) return false;
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      issuer.spki,
      { name: 'ECDSA', namedCurve: issuer.curve.name },
      false,
      ['verify']
    );
    return await crypto.subtle.verify({ name: 'ECDSA', hash }, key, signature, subject.signed);
  } catch {
    return false;
  }
}

function validAt(subject: ParsedCertificate, now: Date): boolean {
  const { notBefore, notAfter } = subject.certificate.tbsCertificate.validity;
  return (
    notBefore.getTime().getTime() <= now.getTime() && now.getTime() <= notAfter.getTime().getTime()
  );
}

function isCertificateAuthority(subject: ParsedCertificate): boolean {
  const extension = subject.certificate.tbsCertificate.extensions?.find(
    candidate => candidate.extnID === id_ce_basicConstraints
  );
  if (extension === undefined) return false;
  try {
    return AsnParser.parse(extension.extnValue, BasicConstraints).cA;
  } catch {
    return false;
  }
}

function extensionValue(subject: ParsedCertificate, oid: string): Uint8Array | null {
  const found = subject.certificate.tbsCertificate.extensions?.filter(
    candidate => candidate.extnID === oid
  );
  if (found === undefined || found.length !== 1) return null;
  return new Uint8Array(found[0].extnValue.buffer);
}

/**
 * The chain `x5c`: the credential certificate, the App Attest intermediate and, when sent, the
 * root, which must then be the pinned root itself. Each certificate is valid now and signed by the
 * next; the intermediate is a CA signed by the pinned root.
 */
async function verifyChain(
  x5c: Uint8Array[],
  root: Uint8Array,
  now: Date
): Promise<
  { status: 'verified'; leaf: ParsedCertificate } | { status: 'refused'; reason: AppAttestRefusal }
> {
  if (x5c.length === 3 && !equalBytes(x5c[2], root)) {
    return { status: 'refused', reason: 'certificate_chain' };
  }
  const leaf = parseCertificate(x5c[0]);
  const intermediate = parseCertificate(x5c[1]);
  const anchor = parseCertificate(root);
  if (leaf === null || intermediate === null || anchor === null) {
    return { status: 'refused', reason: 'malformed' };
  }
  if (
    !isCertificateAuthority(intermediate) ||
    !(await signedBy(intermediate, anchor)) ||
    !(await signedBy(leaf, intermediate))
  ) {
    return { status: 'refused', reason: 'certificate_chain' };
  }
  if (!validAt(leaf, now) || !validAt(intermediate, now) || !validAt(anchor, now)) {
    return { status: 'refused', reason: 'certificate_validity' };
  }
  return { status: 'verified', leaf };
}

/** Apple's `extensions` map after the COSE key: string keys, documented value shapes only. */
function isAppleExtensions(value: unknown): boolean {
  if (!(value instanceof Map)) return false;
  for (const [key, entry] of value) {
    if (typeof key !== 'string') return false;
    if (key === 'apple_bundle_version_01' && typeof entry !== 'string') return false;
    if (key === 'apple_validation_category_01') {
      const fourBytes = entry instanceof Uint8Array && entry.length === 4;
      const uint32 = typeof entry === 'number' && Number.isInteger(entry) && entry >= 0;
      if (!fourBytes && !uint32) return false;
    }
  }
  return true;
}

/**
 * The authenticator data after the credential id: one COSE key, then Apple's optional extensions
 * map, every byte accounted for. Returns the COSE key's x and y.
 */
function coseKeyOf(tail: Uint8Array): { x: Uint8Array; y: Uint8Array } | null {
  let items: unknown[];
  try {
    items = [
      ...decodeSequence(tail, { preferMap: true, saveOriginal: true, rejectDuplicateKeys: true }),
    ];
  } catch {
    return null;
  }
  if (items.length < 1 || items.length > 2) return null;
  let covered = 0;
  for (const item of items) {
    // Only maps keep their encoding; any other item fails here.
    const encoded = item instanceof Map ? getEncoded(item) : undefined;
    if (encoded === undefined) return null;
    covered += encoded.length;
  }
  const [key, extensions] = items;
  if (covered !== tail.length || !(key instanceof Map)) return null;
  if (extensions !== undefined && !isAppleExtensions(extensions)) return null;
  // COSE labels: 1 kty (2 = EC2), 3 alg (-7 = ES256), -1 crv (1 = P-256), -2 x, -3 y.
  const x = bytesOf(key.get(-2));
  const y = bytesOf(key.get(-3));
  if (key.get(1) !== 2 || key.get(-1) !== 1 || x?.length !== 32 || y?.length !== 32) return null;
  return { x, y };
}

/**
 * Verifies the attestation of a new App Attest key (`attestKey`) over `clientDataHash`, and
 * returns the key's uncompressed P-256 point to store under `keyId`.
 */
export type KeyAttestationInput = {
  attestation: Uint8Array;
  keyId: Uint8Array;
  clientDataHash: Uint8Array;
  now: Date;
};

export async function verifyKeyAttestation(
  input: KeyAttestationInput,
  settings: AppAttestSettings
): Promise<KeyAttestationResult> {
  const refused = (reason: AppAttestRefusal): KeyAttestationResult => ({
    status: 'refused',
    reason,
  });
  const object = cborMap(input.attestation);
  const statement = object?.get('attStmt');
  const authData = bytesOf(object?.get('authData'));
  if (object?.get('fmt') !== 'apple-appattest' || !(statement instanceof Map) || !authData) {
    return refused('malformed');
  }
  const x5cValue: unknown = statement.get('x5c');
  if (!Array.isArray(x5cValue) || x5cValue.length < 2 || x5cValue.length > 3) {
    return refused('malformed');
  }
  const x5c: Uint8Array[] = [];
  for (const entry of x5cValue) {
    const der = bytesOf(entry);
    if (der === null) return refused('malformed');
    x5c.push(der);
  }
  if (input.keyId.length !== KEY_ID_BYTES) return refused('malformed');

  const chain = await verifyChain(x5c, settings.rootCertificate, input.now);
  if (chain.status === 'refused') return chain;
  const leaf = chain.leaf;
  if (leaf.curve.name !== 'P-256') return refused('malformed');

  const nonce = await sha256(concat(authData, input.clientDataHash));
  const nonceValue = extensionValue(leaf, NONCE_EXTENSION);
  const certified = nonceValue === null ? null : appAttestNonce(nonceValue);
  if (certified === null || !equalBytes(certified, nonce)) return refused('nonce_mismatch');

  if (!equalBytes(await sha256(leaf.point), input.keyId)) return refused('key_id_mismatch');

  // rpIdHash(32) flags(1) counter(4) aaguid(16) credentialIdLength(2) credentialId key [extensions]
  if (authData.length < AUTH_DATA_FIXED + 16 + 2) return refused('malformed');
  if (!equalBytes(authData.subarray(0, 32), await sha256(settings.appId))) {
    return refused('app_id_mismatch');
  }
  if ((authData[32] & ATTESTED_CREDENTIAL_FLAG) === 0) return refused('malformed');
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  if (view.getUint32(33) !== 0) return refused('counter_not_zero');
  const aaguid = authData.subarray(AUTH_DATA_FIXED, AUTH_DATA_FIXED + 16);
  if (!settings.environments.some(environment => equalBytes(AAGUIDS[environment], aaguid))) {
    return refused('environment_mismatch');
  }
  const idLength = view.getUint16(AUTH_DATA_FIXED + 16);
  const idStart = AUTH_DATA_FIXED + 16 + 2;
  if (idLength !== KEY_ID_BYTES || idStart + idLength > authData.length) {
    return refused('malformed');
  }
  if (!equalBytes(authData.subarray(idStart, idStart + idLength), input.keyId)) {
    return refused('key_id_mismatch');
  }
  const cose = coseKeyOf(authData.subarray(idStart + idLength));
  if (cose === null) return refused('malformed');
  if (!equalBytes(concat(new Uint8Array([4]), cose.x, cose.y), leaf.point)) {
    return refused('key_id_mismatch');
  }
  return { status: 'verified', publicKey: leaf.point };
}

/**
 * Verifies an assertion (`generateAssertion`) of a stored key over `clientDataHash`: the App ID
 * hash and the signature over `SHA-256(authenticatorData || clientDataHash)`. The caller stores the
 * returned counter only when it is above the stored one.
 */
export async function verifyAssertion(
  input: { assertion: Uint8Array; publicKey: Uint8Array; clientDataHash: Uint8Array },
  settings: Pick<AppAttestSettings, 'appId'>
): Promise<AssertionResult> {
  const object = cborMap(input.assertion);
  const signature = bytesOf(object?.get('signature'));
  const authData = bytesOf(object?.get('authenticatorData'));
  if (!signature || !authData || authData.length < AUTH_DATA_FIXED) {
    return { status: 'refused', reason: 'malformed' };
  }
  if (!equalBytes(authData.subarray(0, 32), await sha256(settings.appId))) {
    return { status: 'refused', reason: 'app_id_mismatch' };
  }
  const raw = ecdsaSignatureToRaw(signature, 32);
  if (raw === null) return { status: 'refused', reason: 'malformed' };
  const nonce = await sha256(concat(authData, input.clientDataHash));
  let valid: boolean;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      input.publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    // The Secure Enclave signs the nonce with ECDSA over SHA-256, so the nonce is hashed again.
    valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, nonce);
  } catch {
    valid = false;
  }
  if (!valid) return { status: 'refused', reason: 'signature_invalid' };
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  return { status: 'verified', signCount: view.getUint32(33) };
}
