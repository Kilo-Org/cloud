import { z } from 'zod';
import type { Kilo2Message } from '@kilocode/session-ingest-contracts';
import { backgroundOutcome, projectBackgroundResult } from './background-result';

const notificationSchema = z.object({
  type: z.literal('synthetic'),
  text: z.string(),
  description: z.string(),
  metadata: z.object({
    source: z.literal('subagent'),
    childID: z.string().regex(/^ses_[\w-]+$/),
    agent: z.string().min(1),
    state: z.string().regex(/^[\w-]+$/),
  }),
});

export function projectKilo2SubagentNotification(message: Kilo2Message): Kilo2Message {
  const parsed = notificationSchema.safeParse(message);
  if (!parsed.success) return message;
  const { text, description, metadata } = parsed.data;
  const opening = `<subagent sessionID="${metadata.childID}" state="${metadata.state}" description="${description}">\n`;
  const closing = '\n</subagent>';
  if (!text.startsWith(opening) || !text.endsWith(closing)) return message;
  return projectBackgroundResult(message, {
    kind: 'subagent',
    childID: metadata.childID,
    agent: metadata.agent,
    state: metadata.state,
    outcome: backgroundOutcome({ kind: 'subagent', ...metadata }),
    description,
    output: text.slice(opening.length, -closing.length),
  });
}
