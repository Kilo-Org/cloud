import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { redactBriefingExcerpt } from '@kilocode/app-shared/agent-briefing';
import { agent_briefing_context_preferences, cli_sessions_v2 } from '@kilocode/db/schema';

export type BriefingExcerpt = NonNullable<typeof cli_sessions_v2.$inferSelect.briefing_excerpt>;

export const BRIEFING_MAX_INLINE_BYTES = 8 * 1024;
export const BRIEFING_MAX_EXCERPT_SOURCE_ROWS = 32;

const completedResponseSchema = z.object({
  id: z.string().min(1),
  role: z.literal('assistant'),
  finish: z.literal('stop'),
  summary: z.boolean().optional(),
  error: z.unknown().optional(),
  text: z.string().optional(),
  time: z.object({ completed: z.number().finite().positive() }),
});

const textPartSchema = z.object({
  messageID: z.string(),
  type: z.literal('text'),
  text: z.string(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
  time: z.object({ end: z.number().finite().positive().optional() }).optional(),
});

export function completedBriefingResponse(data: unknown) {
  const parsed = completedResponseSchema.safeParse(data);
  if (!parsed.success || parsed.data.summary || parsed.data.error != null) return undefined;
  if (!Number.isFinite(new Date(parsed.data.time.completed).getTime())) return undefined;
  return parsed.data;
}

export function isFinalizedBriefingText(data: unknown): boolean {
  const parsed = textPartSchema.safeParse(data);
  return (
    parsed.success &&
    !parsed.data.synthetic &&
    !parsed.data.ignored &&
    (parsed.data.time === undefined || parsed.data.time.end !== undefined)
  );
}

export function buildBriefingExcerpt(
  data: unknown,
  parts: Iterable<unknown>
): BriefingExcerpt | undefined {
  const message = completedBriefingResponse(data);
  if (!message) return undefined;
  const text: string[] = [];
  const encoder = new TextEncoder();
  let rawBytes = 0;
  let sourceRows = 0;
  for (const partData of parts) {
    if (++sourceRows > BRIEFING_MAX_EXCERPT_SOURCE_ROWS) return undefined;
    const parsed = textPartSchema.safeParse(partData);
    if (!parsed.success || parsed.data.messageID !== message.id) continue;
    const part = parsed.data;
    if (part.synthetic || part.ignored) continue;
    if (part.time !== undefined && part.time.end === undefined) return undefined;
    if (part.time?.end !== undefined && part.time.end > message.time.completed) return undefined;
    if (part.text.length > BRIEFING_MAX_INLINE_BYTES) return undefined;
    rawBytes += encoder.encode(part.text).byteLength;
    if (rawBytes > BRIEFING_MAX_INLINE_BYTES) return undefined;
    text.push(part.text);
  }
  const rawText = text.length > 0 ? text.join('') : (message.text ?? '');
  if (
    text.length === 0 &&
    (rawText.length > BRIEFING_MAX_INLINE_BYTES ||
      encoder.encode(rawText).byteLength > BRIEFING_MAX_INLINE_BYTES)
  )
    return undefined;
  const excerpt = redactBriefingExcerpt(rawText).trim();
  if (!excerpt) return undefined;
  return {
    messageId: message.id,
    completedAt: new Date(message.time.completed).toISOString(),
    text: excerpt,
  };
}

export function briefingExcerptUpdate(excerpt: BriefingExcerpt) {
  return sql`CASE
    WHEN EXISTS (
      SELECT 1 FROM ${agent_briefing_context_preferences}
      WHERE ${agent_briefing_context_preferences.kilo_user_id} = ${cli_sessions_v2.kilo_user_id}
        AND ${agent_briefing_context_preferences.enabled} = true
        AND ${agent_briefing_context_preferences.organization_id} IS NOT DISTINCT FROM ${cli_sessions_v2.organization_id}
        AND ${agent_briefing_context_preferences.context_key} = coalesce(${cli_sessions_v2.organization_id}::text, 'personal')
    )
      AND (${cli_sessions_v2.briefing_excerpt_scope_changed_at} IS NULL
        OR ${cli_sessions_v2.briefing_excerpt_scope_changed_at} < ${excerpt.completedAt}::timestamptz)
      AND (${cli_sessions_v2.briefing_excerpt} IS NULL
        OR (${cli_sessions_v2.briefing_excerpt}->>'completedAt')::timestamptz < ${excerpt.completedAt}::timestamptz
        OR ((${cli_sessions_v2.briefing_excerpt}->>'completedAt')::timestamptz = ${excerpt.completedAt}::timestamptz
          AND (${cli_sessions_v2.briefing_excerpt}->>'messageId') COLLATE "C" < ${excerpt.messageId}::text COLLATE "C"))
    THEN ${JSON.stringify(excerpt)}::jsonb
    ELSE ${cli_sessions_v2.briefing_excerpt}
  END`;
}
