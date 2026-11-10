import { z } from 'zod';

export const sessionShareDurationSchema = z.enum(['1h', '1d', '7d', '30d', 'forever']);
export type SessionShareDuration = z.infer<typeof sessionShareDurationSchema>;

export const sessionShareOptionsSchema = z
  .object({
    duration: sessionShareDurationSchema.default('7d'),
    include_new_messages: z.boolean().default(false),
  })
  .strict();
export type SessionShareOptions = z.infer<typeof sessionShareOptionsSchema>;

const durationSeconds = {
  '1h': 60 * 60,
  '1d': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
  forever: null,
} satisfies Record<SessionShareDuration, number | null>;

export function getSessionShareExpiresAt(
  duration: SessionShareDuration,
  issuedAtSeconds: number
): number | null {
  const seconds = durationSeconds[duration];
  return seconds === null ? null : issuedAtSeconds + seconds;
}
