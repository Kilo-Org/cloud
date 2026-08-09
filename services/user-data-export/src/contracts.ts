import * as z from 'zod';

export const EXPORT_SCHEMA_VERSION = 1;

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
    kiloUserId: z.string().min(1),
  })
  .strict();

export type ExportCursor = { createdAt: string; id: string };

export function parseCursor(value: unknown): ExportCursor | null {
  if (!value || typeof value !== 'object') return null;
  const cursor = value as Record<string, unknown>;
  return typeof cursor.createdAt === 'string' && typeof cursor.id === 'string'
    ? { createdAt: cursor.createdAt, id: cursor.id }
    : null;
}
