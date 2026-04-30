/**
 * Hostname label <-> sandboxId translation for per-instance virtual hosting
 * on `*.kiloclaw.ai`.
 *
 * Two instance shapes map to two label prefixes:
 *
 *   instance-keyed sandboxId  "ki_{32hex}"       <->  "i-{32hex}"
 *   legacy sandboxId          base64url(userId)   <->  "u-{base32hex(userId)}"
 *
 * Prefix disambiguates the two cases without a database lookup.
 */

import { isInstanceKeyedSandboxId } from '@kilocode/worker-utils/instance-id';

/** RFC 1035 max label length. */
export const MAX_HOSTNAME_LABEL_LENGTH = 63;

const BASE32_HEX_ALPHABET = '0123456789abcdefghijklmnopqrstuv';
const INSTANCE_KEYED_BODY_RE = /^[0-9a-f]{32}$/;

const INSTANCE_LABEL_RE = /^i-([0-9a-f]{32})$/;
const USER_LABEL_RE = /^u-([0-9a-v]+)$/;

function bytesToBase64url(bytes: Uint8Array): string {
  const binString = Array.from(bytes, b => String.fromCodePoint(b)).join('');
  return btoa(binString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(encoded: string): Uint8Array | null {
  try {
    let b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) {
      b64 += '=';
    }
    const binString = atob(b64);
    const bytes = Uint8Array.from(binString, c => c.codePointAt(0) ?? 0);
    return bytesToBase64url(bytes) === encoded ? bytes : null;
  } catch {
    return null;
  }
}

function bytesToBase32Hex(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      output += BASE32_HEX_ALPHABET[(buffer >> bits) & 31];
    }
  }

  if (bits > 0) {
    output += BASE32_HEX_ALPHABET[(buffer << (5 - bits)) & 31];
  }

  return output;
}

function base32HexToBytes(encoded: string): Uint8Array | null {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of encoded) {
    const value = BASE32_HEX_ALPHABET.indexOf(char);
    if (value === -1) return null;

    buffer = (buffer << 5) | value;
    bits += 5;

    while (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }

  const decoded = Uint8Array.from(bytes);
  return bytesToBase32Hex(decoded) === encoded ? decoded : null;
}

/**
 * Produce a DNS-safe hostname label for `<label>.kiloclaw.ai` from a
 * sandboxId, or `null` if the sandboxId can't be represented as a safe
 * label (e.g. pathological Unicode userId whose base64url encoding
 * contains non-alnum chars, or a label that would exceed 63 chars).
 *
 * Callers should treat `null` as "no per-instance origin available for
 * this sandbox" and fall back to the shared origin list.
 */
export function hostnameLabelFromSandboxId(sandboxId: string): string | null {
  if (isInstanceKeyedSandboxId(sandboxId)) {
    const body = sandboxId.slice(3);
    if (!INSTANCE_KEYED_BODY_RE.test(body)) return null;
    const label = `i-${body}`;
    if (label.length > MAX_HOSTNAME_LABEL_LENGTH) return null;
    return label;
  }

  const legacyUserIdBytes = base64urlToBytes(sandboxId);
  if (!legacyUserIdBytes || legacyUserIdBytes.length === 0) return null;

  const label = `u-${bytesToBase32Hex(legacyUserIdBytes)}`;
  if (label.length > MAX_HOSTNAME_LABEL_LENGTH) return null;
  return label;
}

/**
 * Reverse of `hostnameLabelFromSandboxId`: parse a hostname label back
 * into its sandboxId, returning `null` if the label doesn't match either
 * scheme.
 *
 * Used by the host-based router in a follow-up PR to resolve
 * `<label>.kiloclaw.ai` to the owning Instance DO.
 */
export function sandboxIdFromHostnameLabel(label: string): string | null {
  const normalized = label.toLowerCase();
  const instanceMatch = INSTANCE_LABEL_RE.exec(normalized);
  if (instanceMatch) return `ki_${instanceMatch[1]}`;

  const userMatch = USER_LABEL_RE.exec(normalized);
  if (userMatch) {
    const body = userMatch[1];
    if (body.length + 2 > MAX_HOSTNAME_LABEL_LENGTH) return null;
    const bytes = base32HexToBytes(body);
    if (!bytes) return null;
    return bytesToBase64url(bytes);
  }

  return null;
}
