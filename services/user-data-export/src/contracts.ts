import * as z from 'zod';

/**
 * The queue and download message contract, not the export file's format.
 *
 * Pinned with `z.literal` below, so raising it makes every in-flight message fail
 * validation and dead-letter mid-deploy. It changes only when the message shape does.
 */
export const EXPORT_SCHEMA_VERSION = 1;

/**
 * The format of the export file itself, reported as `schemaVersion` in its header.
 *
 * Deliberately separate from the message contract above: the two version different
 * things and previously happened to agree at 1, which made it look as though one
 * constant governed both.
 *
 * 2 adds the warehouse profile columns to the identity section: location, historic and
 * current, plus the analytics copies of name, email and hosted domain. Additive for a
 * reader that ignores unknown fields, breaking for one that does not, and an export file
 * is the kind of artifact people write strict parsers against.
 */
export const EXPORT_FILE_SCHEMA_VERSION = 2;

export const ExportQueueMessageSchema = z
  .object({
    version: z.literal(EXPORT_SCHEMA_VERSION),
    operation: z.literal('generate'),
    exportId: z.string().uuid(),
    generation: z.number().int().nonnegative(),
  })
  .strict();

export type ExportQueueMessage = z.infer<typeof ExportQueueMessageSchema>;

export const AdmitExportSchema = ExportQueueMessageSchema;

export const DownloadRequestSchema = z
  .object({
    version: z.literal(EXPORT_SCHEMA_VERSION),
    exportId: z.string().uuid(),
  })
  .strict();

/**
 * Timestamp-keyed cursor, used by sources that carry `created_at`. Retained so a
 * job persisted before the warehouse sources landed still parses on resume.
 */
export type TimestampCursor = { createdAt: string; id: string };

/**
 * Ordinal cursor for the warehouse sources, which have no `created_at` column.
 * Values are the cursor columns in ORDER BY order, always as strings so bigint
 * journal positions survive JSON without losing precision.
 */
export type KeyCursor = { key: string[] };

export type ExportCursor = TimestampCursor | KeyCursor;

const TimestampCursorSchema = z
  .object({
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
    id: z.string().min(1),
  })
  .strict();

const KeyCursorSchema = z
  .object({
    key: z.array(z.string().min(1)).min(1).max(4),
  })
  .strict();

const ExportCursorSchema = z.union([TimestampCursorSchema, KeyCursorSchema]);

export function parseCursor(value: unknown): ExportCursor | null {
  const result = ExportCursorSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Cursor values for a warehouse query's bind parameters, or nulls for a first page.
 *
 * A cursor of the wrong arity or shape (a timestamp cursor persisted before this
 * source existed) restarts the source rather than paging from a position that
 * cannot be interpreted. That can repeat rows already written to the file, which is
 * acceptable; paging from a misread position could skip the user's data, which is not.
 */
export function keyCursorValues(cursor: ExportCursor | null, arity: number): (string | null)[] {
  if (!cursor || !('key' in cursor) || cursor.key.length !== arity) {
    return new Array<string | null>(arity).fill(null);
  }
  return cursor.key;
}
