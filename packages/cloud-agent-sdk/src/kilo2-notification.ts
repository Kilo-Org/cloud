import { z } from 'zod';
import type { Kilo2Message } from '@kilocode/session-ingest-contracts';
import { projectBackgroundResult } from './background-result';
import { projectKilo2ShellNotification } from './kilo2-shell-notification';
import { projectKilo2SubagentNotification } from './kilo2-subagent-notification';

const noticeSchema = z.object({
  type: z.literal('synthetic'),
  text: z.string(),
  description: z.string(),
  metadata: z.object({ source: z.string().min(1) }),
});

export function projectKilo2Notification(message: Kilo2Message): Kilo2Message {
  const shell = projectKilo2ShellNotification(message);
  if (shell !== message) return shell;
  const subagent = projectKilo2SubagentNotification(message);
  if (subagent !== message) return subagent;
  const notice = noticeSchema.safeParse(message);
  if (
    !notice.success ||
    ['callback', 'review', 'wakeup', 'queued', 'optimistic'].includes(notice.data.metadata.source)
  )
    return message;
  return projectBackgroundResult(message, {
    kind: 'notice',
    state: 'unknown',
    outcome: 'unknown',
    description: notice.data.description,
    output: notice.data.text,
  });
}
