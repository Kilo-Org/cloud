/**
 * The few DER reads the App Attest verifier needs on raw bytes (ITU-T X.690): the exact signed
 * bytes of a certificate (`tbsCertificate` as sent, not as a library would encode it again), the
 * nonce extension's fixed shape, and an ECDSA signature value. Every read is strict: definite
 * minimal lengths, single-byte tags, and no bytes left over.
 */

export type Tlv = { tag: number; start: number; valueStart: number; end: number };

/** The element at `offset`, or null when the bytes there are not one strict DER element. */
export function readTlv(bytes: Uint8Array, offset: number): Tlv | null {
  if (offset + 2 > bytes.length) return null;
  const tag = bytes[offset];
  // High tag numbers (0x1f) never occur in the structures read here.
  if ((tag & 0x1f) === 0x1f) return null;
  const first = bytes[offset + 1];
  let length: number;
  let valueStart: number;
  if (first < 0x80) {
    length = first;
    valueStart = offset + 2;
  } else {
    const count = first & 0x7f;
    if (count === 0 || count > 3 || offset + 2 + count > bytes.length) return null;
    length = 0;
    for (let index = 0; index < count; index += 1) {
      length = length * 256 + bytes[offset + 2 + index];
    }
    // DER: the shortest length form, with no leading zero byte.
    if (length < 0x80 || bytes[offset + 2] === 0) return null;
    valueStart = offset + 2 + count;
  }
  const end = valueStart + length;
  if (end > bytes.length) return null;
  return { tag, start: offset, valueStart, end };
}

/** The elements inside `parent`, which must fill its value exactly; null otherwise. */
export function children(bytes: Uint8Array, parent: Tlv): Tlv[] | null {
  const items: Tlv[] = [];
  let offset = parent.valueStart;
  while (offset < parent.end) {
    const item = readTlv(bytes, offset);
    if (item === null || item.end > parent.end) return null;
    items.push(item);
    offset = item.end;
  }
  return items;
}

/** One element that covers all of `bytes`, with tag `tag`. */
export function whole(bytes: Uint8Array, tag: number): Tlv | null {
  const element = readTlv(bytes, 0);
  return element !== null && element.tag === tag && element.end === bytes.length ? element : null;
}

const SEQUENCE = 0x30;
const INTEGER = 0x02;
const OCTET_STRING = 0x04;
const CONTEXT_1_CONSTRUCTED = 0xa1;

/** The `tbsCertificate` bytes of a DER certificate, exactly as signed. */
export function signedPart(certificate: Uint8Array): Uint8Array | null {
  const outer = whole(certificate, SEQUENCE);
  if (outer === null) return null;
  const parts = children(certificate, outer);
  if (parts === null || parts.length !== 3 || parts[0].tag !== SEQUENCE) return null;
  return certificate.subarray(parts[0].start, parts[0].end);
}

/**
 * The App Attest nonce extension's value, `SEQUENCE { [1] EXPLICIT OCTET STRING }`; null for any
 * other shape.
 */
export function appAttestNonce(extensionValue: Uint8Array): Uint8Array | null {
  const sequence = whole(extensionValue, SEQUENCE);
  if (sequence === null) return null;
  const tagged = children(extensionValue, sequence);
  if (tagged === null || tagged.length !== 1 || tagged[0].tag !== CONTEXT_1_CONSTRUCTED) {
    return null;
  }
  const inner = children(extensionValue, tagged[0]);
  if (inner === null || inner.length !== 1 || inner[0].tag !== OCTET_STRING) return null;
  return extensionValue.subarray(inner[0].valueStart, inner[0].end);
}

/** One positive DER INTEGER as exactly `size` big-endian bytes, or null when it does not fit. */
function fixedInteger(bytes: Uint8Array, element: Tlv, size: number): Uint8Array | null {
  if (element.tag !== INTEGER) return null;
  let value = bytes.subarray(element.valueStart, element.end);
  if (value.length === 0 || (value[0] & 0x80) !== 0) return null;
  if (value[0] === 0) {
    // DER keeps a leading zero only before a byte with the top bit set; zero itself is no valid
    // signature half.
    if (value.length === 1 || (value[1] & 0x80) === 0) return null;
    value = value.subarray(1);
  }
  if (value.length > size) return null;
  const out = new Uint8Array(size);
  out.set(value, size - value.length);
  return out;
}

/**
 * A DER ECDSA signature (`SEQUENCE { r INTEGER, s INTEGER }`, RFC 3279) as the fixed `r || s`
 * form WebCrypto verifies, for a curve whose order is `size` bytes long.
 */
export function ecdsaSignatureToRaw(signature: Uint8Array, size: number): Uint8Array | null {
  const sequence = whole(signature, SEQUENCE);
  if (sequence === null) return null;
  const parts = children(signature, sequence);
  if (parts === null || parts.length !== 2) return null;
  const r = fixedInteger(signature, parts[0], size);
  const s = fixedInteger(signature, parts[1], size);
  if (r === null || s === null) return null;
  const raw = new Uint8Array(size * 2);
  raw.set(r, 0);
  raw.set(s, size);
  return raw;
}
