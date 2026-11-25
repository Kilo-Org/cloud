import 'server-only';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import * as z from 'zod';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { callerAddressOrNull } from '@/lib/auth/caller-address';

/**
 * Sign-in context detection: has this user signed in from this device, or
 * from this network, before? A notice is due only when both are new (design
 * 5.13: a new address alone is a carrier or VPN change, not a posture change).
 */

/** A context not seen for this long is forgotten, and counts as new again. */
export const SIGN_IN_CONTEXT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** At most one new-sign-in notice per user in this window. */
export const NEW_SIGN_IN_NOTICE_INTERVAL_MS = 60 * 60 * 1000;

/** What identifies the signing-in device, by how the client can prove it. */
export type SignInDevice =
  /** The random device cookie a browser holds (see `web-sign-in-device.ts`). */
  | { kind: 'browser_cookie'; secret: string }
  /** The App Attest key of one iOS install, which the admission proof names. */
  | { kind: 'ios_attested_key'; keyId: string }
  /**
   * The app's user agent, for a native client whose admission proof carries no
   * per-install key (Android Play Integrity). It names only the platform and
   * the app version, so it is a weak device signal; the network must be new as
   * well before a notice fires.
   */
  | { kind: 'user_agent'; userAgent: string | null };

export type SignInContextDecision =
  /** The request carried no usable client address: the device is recorded, nothing is decided. */
  | { kind: 'no_network' }
  /** The user had no recent context, so this one is recorded without a notice. */
  | { kind: 'bootstrap' }
  /** The device or the network was seen before. */
  | { kind: 'known' }
  /** Both are new, but a new-sign-in notice already went out within the interval. */
  | { kind: 'notice_capped' }
  /** Both are new: this sign-in owns the notice. */
  | { kind: 'new_device_new_network'; deviceKeyHash: string; networkKeyHash: string };

function deviceKeyMaterial(device: SignInDevice): string {
  switch (device.kind) {
    case 'browser_cookie':
      return `browser_cookie:${device.secret}`;
    case 'ios_attested_key':
      return `ios_attested_key:${device.keyId}`;
    case 'user_agent':
      return `user_agent:${device.userAgent ?? ''}`;
  }
}

/** The device of a native sign-in, from its verified admission proof. */
export function nativeSignInDevice(
  admission: { platform: 'ios' | 'android'; keyId?: string },
  userAgent: string | null
): SignInDevice {
  return admission.platform === 'ios' && admission.keyId
    ? { kind: 'ios_attested_key', keyId: admission.keyId }
    : { kind: 'user_agent', userAgent };
}

function ipv6Hextets(address: string): string[] {
  const [head = '', tail] = address.split('::');
  const leading = head === '' ? [] : head.split(':');
  // Without `::` the address spells every group; with it, the groups after the
  // leading ones up to the tail are zero, so a short head is padded with zeros.
  if (tail === undefined || leading.length >= 2) return leading;
  return [...leading, '0', '0'].slice(0, 2);
}

/**
 * The provider-sized network of a client address: the IPv4 /16 or the IPv6
 * /32. No ASN source exists, and these prefixes approximate a provider's
 * allocation. Null for a missing or unparseable address.
 */
export function networkPrefix(address: string | null): string | null {
  if (!address) return null;
  const withoutZone = address.split('%')[0] ?? '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(withoutZone)?.[1];
  const candidate = mapped ?? withoutZone;
  const version = isIP(candidate);
  if (version === 4) {
    const [a, b] = candidate.split('.');
    return `${Number(a)}.${Number(b)}.0.0/16`;
  }
  if (version === 6) {
    const [a = '0', b = '0'] = ipv6Hextets(candidate.toLowerCase());
    return `${parseInt(a, 16).toString(16)}:${parseInt(b, 16).toString(16)}::/32`;
  }
  return null;
}

const countrySchema = z.string().regex(/^[A-Z]{2}$/);

/**
 * The network key of a request: the platform's country code with the
 * client's provider-sized prefix. Null when the request has no usable client
 * address (local development, a request outside the platform).
 */
export function networkKey(headers: Headers): string | null {
  const prefix = networkPrefix(callerAddressOrNull(headers));
  if (!prefix) return null;
  const country = countrySchema.safeParse(headers.get('x-vercel-ip-country')?.trim());
  return `${country.success ? country.data : 'unknown'} ${prefix}`;
}

/**
 * SHA-256 hex of one key, salted with the user id so the same network or user
 * agent hashes differently per user and rows cannot be joined across users.
 */
export function hashSignInKey(userId: string, kind: 'device' | 'network', value: string): string {
  return createHash('sha256').update(`${userId}\u0000${kind}\u0000${value}`).digest('hex');
}

export function hashSignInDevice(userId: string, device: SignInDevice): string {
  return hashSignInKey(userId, 'device', deviceKeyMaterial(device));
}

const decisionRowSchema = z.object({
  has_context: z.boolean(),
  device_known: z.boolean(),
  network_known: z.boolean(),
  notified: z.boolean(),
});

/**
 * Records one sign-in's device and network for the user and decides whether
 * it is a new device on a new network, in one statement:
 *
 * - reads whether the user has any context seen in the retention window, and
 *   whether this device and this network are among them;
 * - when both are new and the user has history, claims the per-user notice
 *   row only if the last notice is older than the interval. The claim is an
 *   upsert whose condition is checked against the latest committed row, so two
 *   concurrent sign-ins cannot both claim it;
 * - upserts the device and network rows (refreshing `last_seen_at`);
 * - deletes the user's rows not seen within the retention window, except the
 *   rows this statement writes.
 */
export async function recordSignInContext(params: {
  userId: string;
  deviceKeyHash: string;
  networkKeyHash: string | null;
  now?: Date;
}): Promise<SignInContextDecision> {
  const { userId, deviceKeyHash, networkKeyHash } = params;
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const retentionCutoff = new Date(now.getTime() - SIGN_IN_CONTEXT_RETENTION_MS).toISOString();
  const noticeCutoff = new Date(now.getTime() - NEW_SIGN_IN_NOTICE_INTERVAL_MS).toISOString();

  const { rows } = await db.execute(sql`
    WITH recent AS (
      SELECT
        count(*) > 0 AS has_context,
        coalesce(bool_or(kind = 'device' AND key_hash = ${deviceKeyHash}), false) AS device_known,
        coalesce(bool_or(kind = 'network' AND key_hash = ${networkKeyHash}::text), false) AS network_known
      FROM user_sign_in_contexts
      WHERE user_id = ${userId}
        AND kind IN ('device', 'network')
        AND last_seen_at > ${retentionCutoff}::timestamptz
    ),
    candidate AS (
      SELECT (
        ${networkKeyHash}::text IS NOT NULL
        AND has_context
        AND NOT device_known
        AND NOT network_known
      ) AS is_candidate
      FROM recent
    ),
    notice AS (
      INSERT INTO user_sign_in_contexts (user_id, kind, key_hash, first_seen_at, last_seen_at)
      SELECT ${userId}, 'notice', 'new_sign_in', ${nowIso}::timestamptz, ${nowIso}::timestamptz
      FROM candidate
      WHERE is_candidate
      ON CONFLICT (user_id, kind, key_hash) DO UPDATE
        SET last_seen_at = excluded.last_seen_at
        WHERE user_sign_in_contexts.last_seen_at <= ${noticeCutoff}::timestamptz
      RETURNING 1
    ),
    seen AS (
      INSERT INTO user_sign_in_contexts (user_id, kind, key_hash, first_seen_at, last_seen_at)
      SELECT ${userId}, v.kind, v.key_hash, ${nowIso}::timestamptz, ${nowIso}::timestamptz
      FROM (VALUES ('device', ${deviceKeyHash}::text), ('network', ${networkKeyHash}::text))
        AS v(kind, key_hash)
      WHERE v.key_hash IS NOT NULL
      ON CONFLICT (user_id, kind, key_hash) DO UPDATE
        SET last_seen_at = greatest(user_sign_in_contexts.last_seen_at, excluded.last_seen_at)
    ),
    pruned AS (
      DELETE FROM user_sign_in_contexts
      WHERE user_id = ${userId}
        AND last_seen_at <= ${retentionCutoff}::timestamptz
        AND NOT (kind = 'device' AND key_hash = ${deviceKeyHash})
        AND NOT (kind = 'network' AND key_hash IS NOT DISTINCT FROM ${networkKeyHash}::text)
        AND NOT (kind = 'notice' AND (SELECT is_candidate FROM candidate))
    )
    SELECT
      recent.has_context,
      recent.device_known,
      recent.network_known,
      EXISTS (SELECT 1 FROM notice) AS notified
    FROM recent
  `);

  const row = decisionRowSchema.parse(rows[0]);
  if (networkKeyHash === null) return { kind: 'no_network' };
  if (!row.has_context) return { kind: 'bootstrap' };
  if (row.device_known || row.network_known) return { kind: 'known' };
  if (!row.notified) return { kind: 'notice_capped' };
  return { kind: 'new_device_new_network', deviceKeyHash, networkKeyHash };
}
