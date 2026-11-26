import 'server-only';
import { createHmac, hkdfSync } from 'node:crypto';
import { isIP } from 'node:net';
import { eq, sql, type SQL } from 'drizzle-orm';
import * as z from 'zod';
import { kilocode_users } from '@kilocode/db/schema';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { callerAddressOrNull } from '@/lib/auth/caller-address';

/**
 * Sign-in context detection: has this user signed in from this device, or
 * from this network, before? A notice is due only when both are new (design
 * 5.13: a new address alone is a carrier or VPN change, not a posture change).
 *
 * A client without a per-install key (the Android app, or an iOS app whose
 * admission proof names no attested key) has no device signal: such a device
 * is never recorded and never counts as known, so the decision rests on the
 * network alone. A sign-in from a known network is not new; one from a new
 * network is, subject to the same bootstrap and hourly cap as any other.
 *
 * Every stored key is an HMAC-SHA-256 digest under a key derived from the
 * server's session secret, which the database does not hold. Each row names
 * the key it was made under (`key_id`, a fingerprint of the key). Only rows
 * under the current key are read, so after a secret rotation every user is
 * recorded silently again, and the scheduled prune deletes the old rows.
 *
 * Residual risk:
 * - A VPN or residential proxy that exits in the victim's country and IPv4
 *   /16 makes the network known, so the sign-in is silent.
 * - A stolen device cookie makes the device known. Stealing it takes the same
 *   access to the browser that already gives the session.
 * - The hourly cap lets the first new sign-in notify, but hides a second one
 *   within the hour.
 * - The network key trusts the platform's forwarded-for header.
 * - Someone holding both a database export and the session secret can
 *   recover the networks by enumerating countries and prefixes.
 * - A secret rotation resets every user to the silent first sign-in.
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
   * A native client whose admission proof carries no per-install key (Android
   * Play Integrity). Its user agent names only the platform and the app
   * version, the same for every install, so it is no device signal at all.
   */
  | { kind: 'no_install_key' };

export type SignInContextDecision =
  /** The account is deleted, blocked, or gone: nothing is recorded or decided. */
  | { kind: 'account_inactive' }
  /** The request carried no usable client address: the device is recorded, nothing is decided. */
  | { kind: 'no_network' }
  /** The user has no history under the current key, so this sign-in is recorded without a notice. */
  | { kind: 'bootstrap' }
  /** The device or the network was seen within the retention window. */
  | { kind: 'known' }
  /** Both are new, but a new-sign-in notice already went out within the interval. */
  | { kind: 'notice_capped' }
  /** Both are new: this sign-in owns the notice. */
  | { kind: 'new_device_new_network' };

function deviceKeyMaterial(device: SignInDevice): string | null {
  switch (device.kind) {
    case 'browser_cookie':
      return `browser_cookie:${device.secret}`;
    case 'ios_attested_key':
      return `ios_attested_key:${device.keyId}`;
    case 'no_install_key':
      return null;
  }
}

/** The device of a native sign-in, from its verified admission proof. */
export function nativeSignInDevice(admission: {
  platform: 'ios' | 'android';
  keyId?: string;
}): SignInDevice {
  return admission.platform === 'ios' && admission.keyId
    ? { kind: 'ios_attested_key', keyId: admission.keyId }
    : { kind: 'no_install_key' };
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

/** The HMAC key the stored digests are made under, and its public fingerprint. */
export type SignInContextKey = {
  /** A fingerprint of the key, stored with each row; reveals nothing about the key. */
  readonly id: string;
  readonly secret: Buffer;
};

const SIGN_IN_CONTEXT_KEY_LABEL = 'kilo sign-in context v1';

/** Derives the digest key from a server secret with HKDF-SHA-256 and a fixed label. */
export function deriveSignInContextKey(serverSecret: string): SignInContextKey {
  const secret = Buffer.from(
    hkdfSync('sha256', serverSecret, Buffer.alloc(0), SIGN_IN_CONTEXT_KEY_LABEL, 32)
  );
  const id = createHmac('sha256', secret).update('fingerprint').digest('hex').slice(0, 16);
  return { id, secret };
}

let currentKey: SignInContextKey | undefined;

/** The digest key under the current session secret. */
export function currentSignInContextKey(): SignInContextKey {
  currentKey ??= deriveSignInContextKey(NEXTAUTH_SECRET);
  return currentKey;
}

/**
 * HMAC-SHA-256 hex of one key for one user. The user id and the kind are in
 * the input, so the same network digests differently per user and per kind,
 * and rows cannot be joined across users.
 */
export function hashSignInKey(
  key: SignInContextKey,
  userId: string,
  kind: 'device' | 'network',
  value: string
): string {
  return createHmac('sha256', key.secret)
    .update(`${userId}\u0000${kind}\u0000${value}`)
    .digest('hex');
}

/** The device key of a sign-in; null for a device without a per-install key. */
export function hashSignInDevice(
  key: SignInContextKey,
  userId: string,
  device: SignInDevice
): string | null {
  const material = deviceKeyMaterial(device);
  return material === null ? null : hashSignInKey(key, userId, 'device', material);
}

const decisionRowSchema = z.object({
  has_history: z.boolean(),
  device_known: z.boolean(),
  network_known: z.boolean(),
  notified: z.boolean(),
});

/**
 * Records one sign-in's device and network for the user and decides whether
 * it is a new device on a new network, in one short transaction:
 *
 * 1. Locks the user row, the first lock account deletion takes too
 *    (`anonymizeCloudUserData`), and stops when the account is deleted,
 *    blocked, or gone. Sign-ins of one user therefore run one at a time, and
 *    a check never writes after a deletion or holds a context row that a
 *    deletion waits for.
 * 2. One statement, which takes its snapshot after the lock, so it sees every
 *    earlier sign-in of the user:
 *    - reads whether the user has the history marker under the current key
 *      (bootstrap is the first recorded sign-in, not the first after a gap),
 *      and whether this device and this network were seen in the retention
 *      window;
 *    - when both are new and the user has history, claims the per-user
 *      notice row only if the last notice is older than the interval;
 *    - upserts the device and network rows (refreshing `last_seen_at`),
 *      except when the notice is capped: a silenced context stays unknown, so
 *      a later sign-in from it can still notify;
 *    - on the first recorded sign-in, writes the history marker. It holds no
 *      device or network data, and the retention prune keeps it, so expiry
 *      never makes a user new to detection again.
 *
 * Rows past the retention window, and rows under an older key, are deleted
 * by the scheduled prune (`pruneSignInContexts`); they are never read here.
 */
export async function recordSignInContext(params: {
  userId: string;
  device: SignInDevice;
  /** The network key from `networkKey`; null without a usable client address. */
  network: string | null;
  now?: Date;
  key?: SignInContextKey;
}): Promise<SignInContextDecision> {
  const { userId, device, network } = params;
  const key = params.key ?? currentSignInContextKey();
  const deviceKeyHash = hashSignInDevice(key, userId, device);
  const networkKeyHash = network === null ? null : hashSignInKey(key, userId, 'network', network);
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const retentionCutoff = new Date(now.getTime() - SIGN_IN_CONTEXT_RETENTION_MS).toISOString();
  const noticeCutoff = new Date(now.getTime() - NEW_SIGN_IN_NOTICE_INTERVAL_MS).toISOString();

  return db.transaction(async (tx): Promise<SignInContextDecision> => {
    const [account] = await tx
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId))
      .for('no key update');
    // A soft-deleted account keeps its row with a soft-delete blocked reason.
    if (!account || account.blocked_reason !== null) return { kind: 'account_inactive' };

    const { rows } = await tx.execute(sql`
      WITH recent AS (
        SELECT
          coalesce(bool_or(kind = 'history'), false) AS has_history,
          coalesce(bool_or(
            kind = 'device'
            AND key_hash = ${deviceKeyHash}::text
            AND last_seen_at > ${retentionCutoff}::timestamptz
          ), false) AS device_known,
          coalesce(bool_or(
            kind = 'network'
            AND key_hash = ${networkKeyHash}::text
            AND last_seen_at > ${retentionCutoff}::timestamptz
          ), false) AS network_known
        FROM user_sign_in_contexts
        WHERE user_id = ${userId}
          AND key_id = ${key.id}
          AND kind IN ('history', 'device', 'network')
      ),
      candidate AS (
        SELECT (
          ${networkKeyHash}::text IS NOT NULL
          AND has_history
          AND NOT device_known
          AND NOT network_known
        ) AS is_candidate
        FROM recent
      ),
      notice AS (
        INSERT INTO user_sign_in_contexts (user_id, kind, key_hash, key_id, first_seen_at, last_seen_at)
        SELECT ${userId}, 'notice', 'new_sign_in', ${key.id}, ${nowIso}::timestamptz, ${nowIso}::timestamptz
        FROM candidate
        WHERE is_candidate
        ON CONFLICT (user_id, kind, key_hash) DO UPDATE
          SET last_seen_at = excluded.last_seen_at, key_id = excluded.key_id
          WHERE user_sign_in_contexts.last_seen_at <= ${noticeCutoff}::timestamptz
        RETURNING 1
      ),
      seen AS (
        INSERT INTO user_sign_in_contexts (user_id, kind, key_hash, key_id, first_seen_at, last_seen_at)
        SELECT ${userId}, v.kind, v.key_hash, ${key.id}, ${nowIso}::timestamptz, ${nowIso}::timestamptz
        FROM (VALUES ('device', ${deviceKeyHash}::text), ('network', ${networkKeyHash}::text))
          AS v(kind, key_hash)
        WHERE v.key_hash IS NOT NULL
          AND (NOT (SELECT is_candidate FROM candidate) OR EXISTS (SELECT 1 FROM notice))
        ON CONFLICT (user_id, kind, key_hash) DO UPDATE
          SET last_seen_at = greatest(user_sign_in_contexts.last_seen_at, excluded.last_seen_at),
            key_id = excluded.key_id
      ),
      history AS (
        INSERT INTO user_sign_in_contexts (user_id, kind, key_hash, key_id, first_seen_at, last_seen_at)
        SELECT ${userId}, 'history', ${key.id}, ${key.id}, ${nowIso}::timestamptz, ${nowIso}::timestamptz
        FROM recent
        WHERE NOT has_history
          AND (${deviceKeyHash}::text IS NOT NULL OR ${networkKeyHash}::text IS NOT NULL)
        ON CONFLICT (user_id, kind, key_hash) DO NOTHING
      )
      SELECT
        recent.has_history,
        recent.device_known,
        recent.network_known,
        EXISTS (SELECT 1 FROM notice) AS notified
      FROM recent
    `);

    const row = decisionRowSchema.parse(rows[0]);
    if (networkKeyHash === null) return { kind: 'no_network' };
    if (!row.has_history) return { kind: 'bootstrap' };
    if (row.device_known || row.network_known) return { kind: 'known' };
    if (!row.notified) return { kind: 'notice_capped' };
    return { kind: 'new_device_new_network' };
  });
}

/** Rows one prune statement deletes at most. */
export const SIGN_IN_CONTEXT_PRUNE_BATCH_SIZE = 5_000;
/** Prune statements one run issues at most, per kind of prune. */
export const SIGN_IN_CONTEXT_PRUNE_MAX_BATCHES = 10;

const pruneConditions = {
  /** Device, network, and notice rows past retention. The history marker stays. */
  expired: (keyId: string, cutoff: string) => sql`
    key_id = ${keyId}
    AND kind IN ('device', 'network', 'notice')
    AND last_seen_at <= ${cutoff}::timestamptz
  `,
  /** Every row under another key: no read matches it any more. */
  // Spelled as two ranges, not `<>`, so the key_id index serves it.
  other_key: (keyId: string) => sql`(key_id < ${keyId} OR key_id > ${keyId})`,
};

async function deleteSignInContextBatch(condition: SQL): Promise<number> {
  // SKIP LOCKED: a row a sign-in is upserting is left for the next run, so
  // the prune never waits on a sign-in and cannot deadlock with one.
  const result = await db.execute(sql`
    DELETE FROM user_sign_in_contexts
    WHERE ctid IN (
      SELECT ctid FROM user_sign_in_contexts
      WHERE ${condition}
      LIMIT ${SIGN_IN_CONTEXT_PRUNE_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
  `);
  return result.rowCount ?? 0;
}

async function deleteSignInContextBatches(
  condition: SQL
): Promise<{ deleted: number; hasMore: boolean }> {
  let deleted = 0;
  for (let batch = 0; batch < SIGN_IN_CONTEXT_PRUNE_MAX_BATCHES; batch++) {
    const count = await deleteSignInContextBatch(condition);
    deleted += count;
    if (count < SIGN_IN_CONTEXT_PRUNE_BATCH_SIZE) return { deleted, hasMore: false };
  }
  return { deleted, hasMore: true };
}

export type SignInContextPruneResult = {
  expiredDeleted: number;
  otherKeyDeleted: number;
  /** A batch limit was reached: rows may remain for the next run. */
  hasMore: boolean;
};

/**
 * Deletes, in bounded batches, the device, network, and notice rows not seen
 * within the retention window, and every row under another key. Keeps the
 * history marker under the current key, so a user whose contexts expire is
 * not recorded silently again on the next sign-in.
 */
export async function pruneSignInContexts(params?: {
  now?: Date;
  key?: SignInContextKey;
}): Promise<SignInContextPruneResult> {
  const key = params?.key ?? currentSignInContextKey();
  const now = params?.now ?? new Date();
  const cutoff = new Date(now.getTime() - SIGN_IN_CONTEXT_RETENTION_MS).toISOString();

  const expired = await deleteSignInContextBatches(pruneConditions.expired(key.id, cutoff));
  const otherKey = await deleteSignInContextBatches(pruneConditions.other_key(key.id));
  return {
    expiredDeleted: expired.deleted,
    otherKeyDeleted: otherKey.deleted,
    hasMore: expired.hasMore || otherKey.hasMore,
  };
}
