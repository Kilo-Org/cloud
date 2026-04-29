/**
 * Hostname label <-> sandboxId translation for per-instance virtual hosting
 * on `*.kiloclaw.ai`.
 *
 * Two instance shapes map to two label prefixes:
 *
 *   instance-keyed sandboxId  "ki_{32hex}"         <->  "i-{32hex}"
 *   legacy sandboxId          "{base64url-body}"   <->  "u-{body}"
 *
 * Prefix disambiguates the two cases without a database lookup.
 *
 * DNS (RFC 1035) labels are `[A-Za-z0-9-]` with max length 63. base64url
 * theoretically uses `_` and `-`, but for realistic (ASCII) userIds the
 * output is alnum-only because `-` and `_` only appear in base64url when
 * the input byte stream contains bytes >= 0x3E in specific positions, and
 * no userId shape in production (UUIDs, `oauth/{provider}:{sub}`, emails,
 * Google numeric subs) contains those characters. We enforce the alnum
 * property with SAFE_LABEL_BODY_RE and fall back to "no label" for any
 * pathological outlier rather than trying to escape.
 */

import { isInstanceKeyedSandboxId } from '@kilocode/worker-utils/instance-id';

/** RFC 1035 max label length. */
export const MAX_HOSTNAME_LABEL_LENGTH = 63;

/**
 * Characters permitted in the label body (after the `i-` or `u-` prefix).
 * Alnum-only keeps us strictly RFC 1035 compliant without worrying about
 * adjacent hyphens or leading/trailing hyphens that would break some
 * resolvers and TLS stacks.
 */
const SAFE_LABEL_BODY_RE = /^[A-Za-z0-9]+$/;

const INSTANCE_KEYED_BODY_RE = /^[0-9a-f]{32}$/;

const INSTANCE_LABEL_RE = /^i-([0-9a-f]{32})$/;
const USER_LABEL_RE = /^u-([A-Za-z0-9]+)$/;

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

  if (!SAFE_LABEL_BODY_RE.test(sandboxId)) return null;
  const label = `u-${sandboxId}`;
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
  const instanceMatch = INSTANCE_LABEL_RE.exec(label);
  if (instanceMatch) return `ki_${instanceMatch[1]}`;

  const userMatch = USER_LABEL_RE.exec(label);
  if (userMatch) {
    const body = userMatch[1];
    if (body.length + 2 > MAX_HOSTNAME_LABEL_LENGTH) return null;
    return body;
  }

  return null;
}
