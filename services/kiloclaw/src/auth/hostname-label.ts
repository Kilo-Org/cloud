/**
 * Hostname label <-> sandboxId translation for per-instance virtual hosting
 * on `*.kiloclaw.ai` (or a configured dev-suffix).
 *
 * Two instance shapes map to two label prefixes:
 *
 *   instance-keyed sandboxId  "ki_{32hex}"       <->  "i-{32hex}"
 *   legacy sandboxId          base64url(userId)   <->  "u-{base32hex(userId)}"
 *
 * Prefix disambiguates the two cases without a database lookup.
 *
 * The per-instance URL used to inject per-instance origins into
 * `OPENCLAW_ALLOWED_ORIGINS` and (post-PR2) to route incoming requests by
 * `Host` is built from two env-configurable pieces:
 *
 *   KILOCLAW_INSTANCE_HOST_SUFFIX  default ".kiloclaw.ai"
 *   KILOCLAW_INSTANCE_URL_SCHEME   default "https"
 *
 * Dev parity: set the suffix to `.kiloclaw.localhost:8795` and the scheme to
 * `http` and the worker will both inject `http://<label>.kiloclaw.localhost:8795`
 * into the container's origin allowlist and route requests matching that
 * host to the owning DO. `.kiloclaw.localhost` auto-resolves to 127.0.0.1 on
 * modern OSes + browsers per RFC 6761, so no `/etc/hosts` edit is required.
 */

import { isInstanceKeyedSandboxId } from '@kilocode/worker-utils/instance-id';

/** RFC 1035 max label length. */
export const MAX_HOSTNAME_LABEL_LENGTH = 63;

/** Narrow view of the env bindings consumed by `instanceUrl` / `parseInstanceHost`. */
export type HostSuffixEnv = {
  KILOCLAW_INSTANCE_HOST_SUFFIX?: string;
  KILOCLAW_INSTANCE_URL_SCHEME?: string;
};

/**
 * No silent fallback: a misconfigured worker should fail loudly rather than
 * inject `.kiloclaw.ai` / `https` into machine origins that were supposed to
 * use a preview-specific or dev suffix. The canonical production values live
 * in `services/kiloclaw/wrangler.jsonc` under `vars`, so this only throws
 * when the var was explicitly cleared (unit test fixtures, malformed
 * preview config, etc.). `validateRequiredEnv` on the catch-all middleware
 * chain rejects requests with a 503 before this path is reached in a
 * normal request flow.
 */
function requireEnv(env: HostSuffixEnv, key: keyof HostSuffixEnv): string {
  const value = env[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} is not set; refuse to fall back to a default host suffix/scheme`);
  }
  return value;
}

function hostSuffix(env: HostSuffixEnv): string {
  return requireEnv(env, 'KILOCLAW_INSTANCE_HOST_SUFFIX');
}

function urlScheme(env: HostSuffixEnv): string {
  return requireEnv(env, 'KILOCLAW_INSTANCE_URL_SCHEME');
}

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

/**
 * Build the per-instance URL (no path, no query) for the given label.
 *
 *   instanceUrl('i-abc', { KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai' })
 *     => 'https://i-abc.kiloclaw.ai'
 *   instanceUrl('i-abc', {
 *     KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.localhost:8795',
 *     KILOCLAW_INSTANCE_URL_SCHEME: 'http',
 *   })
 *     => 'http://i-abc.kiloclaw.localhost:8795'
 *
 * Used by the per-instance origin injector in `gateway/env.ts` and by any
 * code that needs to mint the canonical user-facing host for an instance.
 */
export function instanceUrl(label: string, env: HostSuffixEnv): string {
  return `${urlScheme(env)}://${label}${hostSuffix(env)}`;
}

/**
 * Does the given host fall within the per-instance virtual-host space?
 * True for anything ending in the configured suffix, including malformed
 * cases (bare suffix, multi-label, unparseable label). Callers use this
 * to decide whether the request should be handled by the host-based
 * branch (which may still return 404) or fall through to cookie-based
 * routing. Case-insensitive.
 */
export function hostMatchesInstanceSuffix(host: string, env: HostSuffixEnv): boolean {
  return host.toLowerCase().endsWith(hostSuffix(env).toLowerCase());
}

/**
 * Extract the hostname label from an incoming `Host` header if the host
 * matches the configured instance-host suffix. Returns `null` if:
 *
 *   - the host doesn't end with the configured suffix
 *   - the portion preceding the suffix is empty (e.g. ".kiloclaw.ai")
 *   - the portion preceding the suffix contains a dot, i.e. multi-label
 *     subdomain like `foo.bar.kiloclaw.ai`
 *
 * The suffix can legitimately contain a port in dev (`.kiloclaw.localhost:8795`),
 * so we use raw suffix comparison rather than DNS-only parsing. The input
 * host should be the full value of the `Host` header / `URL.host`, including
 * any `:port` component.
 *
 * Case-insensitive: DNS is case-insensitive and CDNs/proxies may rewrite
 * case. The returned label is lowercased so callers can run it through
 * `sandboxIdFromHostnameLabel` (which also lowercases, but doing it here
 * makes the behaviour explicit).
 */
export function parseInstanceHost(host: string, env: HostSuffixEnv): string | null {
  const suffix = hostSuffix(env).toLowerCase();
  const normalized = host.toLowerCase();
  if (!normalized.endsWith(suffix)) return null;
  const label = normalized.slice(0, -suffix.length);
  if (label.length === 0) return null;
  if (label.includes('.')) return null;
  return label;
}
