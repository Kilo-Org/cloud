import { z } from 'zod';
import type { Kilo2Message } from '@kilocode/session-ingest-contracts';

const notificationSchema = z.object({
  type: z.literal('synthetic'),
  text: z.string(),
  description: z.string(),
  metadata: z
    .object({
      source: z.literal('shell'),
      shellID: z.string(),
      state: z.string(),
      exit: z.number().int().optional(),
    })
    .passthrough(),
});

/** Adapt native shell notifications for display without changing native history. */
export function projectKilo2ShellNotification(message: Kilo2Message): Kilo2Message {
  if (message.type !== 'synthetic') return message;
  const parsed = notificationSchema.safeParse(message);
  if (!parsed.success) return message;
  const { text, description, metadata } = parsed.data;
  const opening = `<shell id="${metadata.shellID}" state="${metadata.state}" command="${description}">\n`;
  const closing = '\n</shell>';
  if (!text.startsWith(opening) || !text.endsWith(closing)) return message;
  const output = text.slice(opening.length, -closing.length);
  const failed =
    metadata.state !== 'completed' || (metadata.exit !== undefined && metadata.exit !== 0);
  const outcome =
    metadata.exit === undefined
      ? `Background command ${metadata.state}`
      : `Command exited with code ${metadata.exit}`;
  return {
    ...message,
    type: 'assistant',
    time: { ...message.time, completed: message.time.created },
    content: [
      {
        type: 'tool',
        id: message.id,
        name: 'shell',
        time: { created: message.time.created, completed: message.time.created },
        state: failed
          ? {
              status: 'error',
              input: { command: description, description: 'Background command result' },
              metadata,
              error: { type: 'shell.error', message: output ? `${output}\n\n${outcome}` : outcome },
            }
          : {
              status: 'completed',
              input: { command: description, description: 'Background command completed' },
              metadata,
              content: [{ type: 'text', text: output }],
            },
      },
    ],
  };
}
