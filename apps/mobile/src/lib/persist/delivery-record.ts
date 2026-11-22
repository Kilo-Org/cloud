import { z } from 'zod';

import * as encryptedKv from '@/lib/persist/encrypted-kv';

/**
 * Shared envelope for the account-scoped delivery records: the memory of
 * sends whose outcome the server did not confirm, and the memory of delivery
 * failures the user already resolved. Both guard something that outlives the
 * read cache — a composer draft that survives sign-out, and a failure event
 * the Durable Object replays on every open — so both live in `delivery:<userId>`
 * (see `cache-scope.ts`) and carry their own completeness.
 *
 * One entry per session holds `{ items, complete }`. `complete: false` says
 * "this record was cut short", which is a different answer from "nothing was
 * ever recorded": the readers treat an unreadable or cut-short record as the
 * conservative case (a restored draft may be a duplicate, a dismissed footer
 * may return), but a *known* record must never decay into a miss while the
 * session it names can still be reopened. That is why the session cap retires
 * the oldest record into a tombstone ({@link DELIVERY_TOMBSTONE_JSON}: no
 * items, incomplete) instead of deleting it, and only a tombstone that is
 * itself out of the window is deleted.
 *
 * A session with nothing stored anywhere is a complete, empty record: that is
 * the ordinary state of a healthy session, and reporting it as incomplete
 * would withhold a footer or resurrect a draft for no reason.
 *
 * Every helper here is pure storage plumbing: no native import beyond the
 * encrypted KV, so the modules that own a record stay testable in node.
 */

/**
 * The stored form of a record whose contents are gone but whose session is
 * still within (or just left) the window: an empty, explicitly incomplete
 * record. A parsed miss and this value are the same to a reader, but a stored
 * tombstone keeps the key present so the older, unread record is never
 * recreated from a stale legacy blob.
 */
const DELIVERY_TOMBSTONE_JSON = '{"items":[],"complete":false}';

/** What one record holds, plus whether it still holds everything it once did. */
export type DeliveryRecordRead<T> = {
  readonly items: readonly T[];
  readonly complete: boolean;
};

/** The conservative answer for an unreadable record or an unknown account. */
export function incompleteDeliveryRecord<T>(): DeliveryRecordRead<T> {
  return { items: [], complete: false };
}

/**
 * The answer for a session nothing was ever recorded for. It is *complete*:
 * reporting it as incomplete would make every healthy session look cut short
 * to the readers, which then withhold a footer or a draft for no reason.
 */
export function emptyDeliveryRecord<T>(): DeliveryRecordRead<T> {
  return { items: [], complete: true };
}

/**
 * What a pre-migration record at the legacy read-cache location says. `absent`
 * (nothing stored) and `unreadable` (something this build cannot parse) are
 * different answers: only the second is a reason to distrust the read.
 */
export type LegacyDeliveryRecord<T> =
  | { readonly state: 'absent' }
  | { readonly state: 'unreadable' }
  | { readonly state: 'found'; readonly items: readonly T[] };

/**
 * The record a family would hold with `legacy` as its only source: the adopted
 * items capped, a complete empty record when nothing was ever stored, and an
 * incomplete one when the legacy value cannot be read.
 */
export function seedDeliveryRecord<T>(
  legacy: LegacyDeliveryRecord<T>,
  max: number
): DeliveryRecordRead<T> {
  if (legacy.state === 'found') {
    return capDeliveryItems(legacy.items, max, true);
  }
  return legacy.state === 'absent' ? emptyDeliveryRecord() : incompleteDeliveryRecord();
}

/** Serializes the envelope. Field order matches {@link DELIVERY_TOMBSTONE_JSON}. */
export function encodeDeliveryRecord<T>(record: DeliveryRecordRead<T>): string {
  return JSON.stringify({ items: record.items, complete: record.complete });
}

/**
 * The value a write must store for `record`, or `null` when the key has to be
 * removed: an emptied complete record is retired, while an emptied incomplete
 * one is written as a tombstone so its session keeps reading as incomplete
 * instead of as never recorded.
 */
function encodeDeliveryRecordForWrite<T>(record: DeliveryRecordRead<T>): string | null {
  if (record.items.length > 0) {
    return encodeDeliveryRecord(record);
  }
  return record.complete ? null : DELIVERY_TOMBSTONE_JSON;
}

/**
 * Drops the pre-migration copy once `delivery:<userId>` is authoritative for the
 * session. Leaving it behind re-opens the loop this record exists to close: an
 * emptied complete record removes its delivery key, and the next read would
 * adopt the stale array again — restoring the id that was just retired.
 *
 * Best effort: the caller already has its answer, and a failed removal only
 * means the next write or migration tries again.
 */
export async function removeLegacyDeliveryRecord(scope: string, key: string): Promise<void> {
  try {
    await encryptedKv.removeItem(scope, key);
  } catch {
    // The record's answer never depends on this delete succeeding.
  }
}

/** Stores one record, or removes its key when {@link encodeDeliveryRecordForWrite} says so. */
export async function writeDeliveryRecord<T>(
  scope: string,
  key: string,
  record: DeliveryRecordRead<T>
): Promise<void> {
  const value = encodeDeliveryRecordForWrite(record);
  await (value === null
    ? encryptedKv.removeItem(scope, key)
    : encryptedKv.setItem(scope, key, value));
}

/**
 * Keeps the newest `max` items. The items are ordered oldest-first by the
 * writers, so the list is cut from the front; a cut is always reported as
 * `complete: false`, because the dropped entries are exactly the ones a later
 * read would otherwise answer as never recorded.
 */
export function capDeliveryItems<T>(
  items: readonly T[],
  max: number,
  complete: boolean
): DeliveryRecordRead<T> {
  // A non-positive cap must never fall through to `slice(-0)`, which returns
  // the whole list.
  if (max <= 0) {
    return { items: [], complete: false };
  }
  if (items.length <= max) {
    return { items, complete };
  }
  return { items: items.slice(-max), complete: false };
}

const storedEnvelopeSchema = z.object({ items: z.array(z.unknown()), complete: z.boolean() });

// A tombstone is recognized by content, not by a marker field: the envelope is
// already the whole record, and the writers emit exactly this shape.
const tombstoneSchema = z.object({
  items: z.array(z.unknown()).max(0),
  complete: z.literal(false),
});

function isTombstone(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return tombstoneSchema.safeParse(parsed).success;
  } catch {
    return false;
  }
}

/**
 * Reads and validates one stored envelope.
 *
 * Returns `null` only when the key is absent, which is the caller's signal to
 * consult a legacy location; an unreadable value (`getItem` threw, invalid
 * JSON, or a shape this build does not understand) is reported as an
 * incomplete record instead, so a read that cannot see its data never claims
 * the session has nothing recorded — and never triggers a migration write over
 * a record it merely failed to parse.
 */
export async function readStoredDeliveryRecord<T>(
  scope: string,
  key: string,
  itemSchema: z.ZodType<T>
): Promise<DeliveryRecordRead<T> | null> {
  try {
    const raw = await encryptedKv.getItem(scope, key);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    const envelope = storedEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      return incompleteDeliveryRecord<T>();
    }
    const items: T[] = [];
    for (const item of envelope.data.items) {
      const result = itemSchema.safeParse(item);
      if (!result.success) {
        return incompleteDeliveryRecord<T>();
      }
      items.push(result.data);
    }
    return { items, complete: envelope.data.complete };
  } catch {
    return incompleteDeliveryRecord<T>();
  }
}

export type TombstoneOldSessionsInput = {
  /** The scope holding the family, e.g. `delivery:<userId>`. */
  scope: string;
  /** Item-key prefix of this one module's records; other families are left alone. */
  prefix: string;
  /** How many records of this family may stay in the scope. */
  max: number;
  /** The key just written: always the newest, and never retired. */
  keepKey: string;
};

/**
 * Retires this module's oldest records once the family outgrows `max`, keeping
 * the family bounded without turning a known record into "nothing recorded".
 *
 * `listEntries` is ascending by `updatedAt`, so the walk starts at the records
 * that are furthest outside the window. A record that still holds items is
 * rewritten as {@link DELIVERY_TOMBSTONE_JSON} — the session keeps reading as
 * incomplete rather than absent — and a record that is already a tombstone is
 * deleted, since its session has now fallen out of the window a second time.
 *
 * A tombstone write cannot preserve `updated_at` (the KV records the write
 * time), so a freshly written tombstone moves to the newest end of the list.
 * That is why removal runs first over the whole family: it frees the slots the
 * surplus needs, and only the surplus that is genuinely live data is rewritten.
 * Counting the two passes separately keeps the retired set to the oldest
 * records actually outside the window instead of re-retiring whatever the
 * previous write moved to the front.
 */
export async function tombstoneOldSessions({
  scope,
  prefix,
  max,
  keepKey,
}: TombstoneOldSessionsInput): Promise<void> {
  const entries = await encryptedKv.listEntries(scope);
  const family = entries.filter(entry => entry.k.startsWith(prefix));
  if (family.length <= max) {
    return;
  }

  // One read per entry, oldest-first, so both passes classify a value exactly
  // once. A key that vanished while this walked it is not part of the family
  // any more and is left out of the count.
  const raws = await Promise.all(family.map(entry => encryptedKv.getItem(scope, entry.k)));
  const present = family.flatMap((entry, index) => {
    const raw = raws[index];
    return raw === null || raw === undefined
      ? []
      : [{ k: entry.k, tombstone: isTombstone(raw), keep: entry.k === keepKey }];
  });

  // Pass one: delete the tombstones among the oldest records. Each deletion
  // shrinks the family, so the surplus it covers needs no retirement at all.
  const over = present.length - max;
  const removals = present
    .filter(record => !record.keep && record.tombstone)
    .slice(0, over)
    .map(record => record.k);
  await Promise.all(removals.map(k => encryptedKv.removeItem(scope, k)));
  const retired = over - removals.length;
  if (retired <= 0) {
    return;
  }

  // Pass two: the tombstones freed fewer slots than the surplus, so the records
  // left over are live and the oldest of them become tombstones. Only the
  // surplus is retired, which keeps a record inside the newest `max` untouched.
  const removalsSet = new Set(removals);
  await Promise.all(
    present
      .filter(record => !record.tombstone && !record.keep && !removalsSet.has(record.k))
      .slice(0, retired)
      .map(record => encryptedKv.setItem(scope, record.k, DELIVERY_TOMBSTONE_JSON))
  );
}
