import { z } from 'zod';
import type { Kilo2Message } from '@kilocode/session-ingest-contracts';
import { backgroundOutcome, projectBackgroundResult } from './background-result';

const notificationSchema = z.object({
  type: z.literal('synthetic'),
  text: z.string(),
  description: z.string(),
  metadata: z.object({
    source: z.literal('shell'),
    shellID: z.string().regex(/^sh_[\w-]+$/),
    state: z.string().regex(/^[\w-]+$/),
    exit: z.number().int().optional(),
    truncated: z.boolean().optional(),
  }),
});

export function projectKilo2ShellNotification(message: Kilo2Message): Kilo2Message {
  const parsed = notificationSchema.safeParse(message);
  if (!parsed.success) return message;
  const { text, description, metadata } = parsed.data;
  const opening = `<shell id="${metadata.shellID}" state="${metadata.state}" command="`;
  const closing = '\n</shell>';
  // Native attributes contain unescaped commands, including quotes and newlines.
  const boundary = text.indexOf('">\n', opening.length);
  if (!text.startsWith(opening) || boundary < 0 || !text.endsWith(closing)) return message;
  return projectBackgroundResult(message, {
    kind: 'shell',
    shellID: metadata.shellID,
    state: metadata.state,
    outcome: backgroundOutcome({ kind: 'shell', ...metadata }),
    description,
    command: text.slice(opening.length, boundary),
    output: text.slice(boundary + 3, -closing.length),
    truncated: metadata.truncated ?? false,
    ...(metadata.exit === undefined ? {} : { exit: metadata.exit }),
  });
}
