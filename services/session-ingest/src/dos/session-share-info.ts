import { z } from 'zod';

export const SHARE_INFO_KEY_PREFIX = 'shareInfo:';
export type ShareInfoMetaKey = `${typeof SHARE_INFO_KEY_PREFIX}${string}`;

export function shareInfoKey(publicId: string): ShareInfoMetaKey {
  return `${SHARE_INFO_KEY_PREFIX}${publicId}`;
}

const shareInfoSchema = z.object({
  capturedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().nullable().optional(),
  info: z.string(),
});

export function readShareInfo(value: string | null, now: number): string | null {
  if (value === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  const result = shareInfoSchema.safeParse(raw);
  if (!result.success) return null;
  const snapshot = result.data;
  // Older snapshots used a fixed retention window.
  const expiresAt =
    snapshot.expiresAt === undefined
      ? snapshot.capturedAt + 30 * 24 * 60 * 60 * 1000
      : snapshot.expiresAt;
  return expiresAt !== null && expiresAt <= now ? null : snapshot.info;
}

/** Keep import fields but omit the cumulative whole-session diff. */
export function projectSharedSessionInfo(value: Record<string, unknown>): string {
  const info = { ...value };
  if (typeof info.summary === 'object' && info.summary !== null && !Array.isArray(info.summary)) {
    const summary = { ...(info.summary as Record<string, unknown>) };
    delete summary.diffs;
    info.summary = summary;
  }
  return JSON.stringify(info);
}
