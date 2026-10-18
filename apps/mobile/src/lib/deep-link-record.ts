import * as z from 'zod';

const pendingDeepLinkRecordSchema = z.object({
  href: z.string(),
  source: z.enum(['universal-link', 'notification', 'system-search']),
  storedAt: z.number(),
  userId: z.string().nullable(),
  // Records predating session binding can only carry account-independent links.
  sessionBound: z.boolean().default(false),
  // Older records leave the current organization selection unchanged.
  organizationId: z.string().nullable().default(null),
});

export type PendingDeepLinkRecord = z.infer<typeof pendingDeepLinkRecordSchema>;

export function parsePendingDeepLinkRecord(raw: string): PendingDeepLinkRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = pendingDeepLinkRecordSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
