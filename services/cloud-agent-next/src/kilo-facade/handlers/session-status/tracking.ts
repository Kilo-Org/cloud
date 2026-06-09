import { z } from 'zod';
import type { SessionStatus } from '../../../shared/protocol.js';

const nonNegativeInteger = z.number().int().nonnegative();
const sessionStatusSchema: z.ZodType<SessionStatus> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('idle') }),
  z.object({ type: z.literal('busy') }),
  z.object({
    type: z.literal('retry'),
    attempt: z.number(),
    message: z.string(),
    action: z
      .object({
        reason: z.string(),
        provider: z.string(),
        title: z.string(),
        message: z.string(),
        label: z.string(),
        link: z.string().optional(),
      })
      .optional(),
    next: z.number(),
  }),
  z.object({
    type: z.literal('offline'),
    requestID: z.string(),
    message: z.string(),
  }),
]);

const sessionStatusEventSchema = z.object({
  type: z.literal('session.status'),
  properties: z.object({ sessionID: z.string(), status: sessionStatusSchema }),
});

const sessionIdleEventSchema = z.object({
  type: z.literal('session.idle'),
  properties: z.object({ sessionID: z.string() }),
});

const statusAttachmentSchema = z.object({
  kiloSessionId: z.string(),
  wrapperGeneration: nonNegativeInteger,
  sessionStatus: sessionStatusSchema.optional(),
});

export type SessionStatusUpdate = { kind: 'clear' } | { kind: 'set'; status: SessionStatus };

export function sessionStatusUpdateFromEvent(
  payload: unknown,
  kiloSessionId: string
): SessionStatusUpdate | null {
  const idle = sessionIdleEventSchema.safeParse(payload);
  if (idle.success) {
    return idle.data.properties.sessionID === kiloSessionId ? { kind: 'clear' } : null;
  }
  const parsed = sessionStatusEventSchema.safeParse(payload);
  if (!parsed.success || parsed.data.properties.sessionID !== kiloSessionId) return null;
  const status = parsed.data.properties.status;
  return status.type === 'idle' ? { kind: 'clear' } : { kind: 'set', status };
}

export function publicSessionStatusesFromAttachments(
  attachments: Iterable<unknown>,
  selectedKiloSessionId?: string
): Record<string, SessionStatus> {
  const latestBySession = new Map<
    string,
    { wrapperGeneration: number; sessionStatus?: SessionStatus }
  >();

  for (const attachment of attachments) {
    const parsed = statusAttachmentSchema.safeParse(attachment);
    if (!parsed.success) continue;
    const source = parsed.data;
    if (selectedKiloSessionId && source.kiloSessionId !== selectedKiloSessionId) continue;
    const current = latestBySession.get(source.kiloSessionId);
    if (current && current.wrapperGeneration > source.wrapperGeneration) continue;
    latestBySession.set(source.kiloSessionId, source);
  }

  const statuses: Record<string, SessionStatus> = {};
  for (const [kiloSessionId, source] of latestBySession) {
    if (source.sessionStatus && source.sessionStatus.type !== 'idle') {
      statuses[kiloSessionId] = source.sessionStatus;
    }
  }
  return statuses;
}
