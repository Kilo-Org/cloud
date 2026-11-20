import { z } from 'zod';

export const CLOUD_WAKEUP_MIN_SLEEP_MS = 10 * 60_000;
export const CLOUD_WAKEUP_MIN_DELAY_MS = 10_000;
export const CLOUD_WAKEUP_HOLD_MARGIN_MS = 30_000;
export const CLOUD_WAKEUP_RETRY_MS = 5_000;
export const CLOUD_WAKEUP_RETRY_LIMIT_MS = 2 * 60_000;
export const CLOUD_WAKEUP_HEADER = 'x-kilo-cloud-wakeup';
export const CLOUD_WAKEUP_CAPABILITY = '1';

export const cloudWakeupCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('schedule'),
      callId: z.string().min(1).max(512),
      delay: z.string().min(1).max(32),
      prompt: z.string().trim().min(1).max(8000),
    })
    .strict(),
  z.object({ action: z.literal('cancel'), id: z.string().min(1).max(128) }).strict(),
]);
export type CloudWakeupCommand = z.infer<typeof cloudWakeupCommandSchema>;

export const cloudWakeupSchema = z.object({
  id: z.string(),
  dueAt: z.number().int(),
  prompt: z.string(),
  mode: z.enum(['stay-awake', 'sleep']),
  state: z.enum(['pending', 'fired', 'cancelled', 'failed']),
  failure: z.string().nullable(),
});
export type CloudWakeup = z.infer<typeof cloudWakeupSchema>;

export const cloudWakeupReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), wakeup: cloudWakeupSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type CloudWakeupReply = z.infer<typeof cloudWakeupReplySchema>;

export const CLOUD_WAKEUP_EXPIRED = 'Runtime authorization expired. Send a message to continue.';

export function cloudWakeupInstruction(wakeup: CloudWakeup): string {
  const mode =
    wakeup.mode === 'sleep'
      ? 'Sleep. A snapshot preserves files and chat state, not running processes, terminals, or memory.'
      : 'Stay awake.';
  return `${wakeup.id}: due ${new Date(wakeup.dueAt).toISOString()}. Mode: ${mode}\nWhen it fires this session resumes with: ${wakeup.prompt}`;
}
