import { z } from 'zod';
import type { Kilo2Message } from '@kilocode/session-ingest-contracts';
import { projectBackgroundResult } from './background-result';
import { projectKilo2ShellNotification } from './kilo2-shell-notification';
import { projectKilo2SubagentNotification } from './kilo2-subagent-notification';

const noticeSchema = z.object({
  type: z.literal('synthetic'),
  text: z.string(),
  description: z.string(),
  metadata: z.union([
    z.object({ source: z.string().min(1) }),
    z.object({ instruction: z.object({ paths: z.array(z.string().min(1)).min(1) }) }),
  ]),
});

const preservedPromptSources = ['callback', 'review', 'wakeup', 'queued', 'optimistic'];

function hasPreservedPromptSource(metadata: unknown): boolean {
  if (typeof metadata !== 'object' || metadata === null || !('source' in metadata)) return false;
  const source = metadata.source;
  return typeof source === 'string' && preservedPromptSources.includes(source);
}

const reminderBlock = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;

function readSystemReminder(
  message: Kilo2Message
): { description: string; output: string } | undefined {
  if (message.type !== 'synthetic' || typeof message.text !== 'string') return undefined;
  const blocks = [...message.text.matchAll(reminderBlock)];
  if (blocks.length === 0) return undefined;
  // Only a whole-message reminder is system context; a prompt with an appended reminder stays user content.
  if (message.text.replace(reminderBlock, '').trim() !== '') return undefined;
  const output = blocks
    .map(block => (block[1] ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
  if (output === '') return undefined;
  const description =
    output
      .split('\n')
      .find(line => line.trim() !== '')
      ?.trim() ?? 'System reminder';
  return { description, output };
}

export function projectKilo2Notification(message: Kilo2Message): Kilo2Message {
  const shell = projectKilo2ShellNotification(message);
  if (shell !== message) return shell;
  const subagent = projectKilo2SubagentNotification(message);
  if (subagent !== message) return subagent;
  const notice = noticeSchema.safeParse(message);
  if (notice.success) {
    if (hasPreservedPromptSource(notice.data.metadata)) return message;
    return projectBackgroundResult(message, {
      kind: 'notice',
      state: 'unknown',
      outcome: 'unknown',
      description: notice.data.description,
      output: notice.data.text,
    });
  }
  if (hasPreservedPromptSource(message['metadata'])) return message;
  const reminder = readSystemReminder(message);
  if (reminder)
    return projectBackgroundResult(message, {
      kind: 'notice',
      state: 'unknown',
      outcome: 'unknown',
      description: reminder.description,
      output: reminder.output,
    });
  return message;
}
