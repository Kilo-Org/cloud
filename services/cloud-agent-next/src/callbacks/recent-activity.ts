import type { LatestAssistantMessage } from '../session/types.js';

export const CALLBACK_ACTIVITY_MESSAGE_LIMIT = 5;

type ActivityMessage = {
  text?: string;
  tools: { name: string; status: string }[];
};

function excerpt(text: string, limit: number): string {
  const end = Math.min(text.length, limit);
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

export function renderRecentActivity(
  messages: readonly LatestAssistantMessage[]
): string | undefined {
  const activity: ActivityMessage[] = [];
  for (const message of messages.slice(-CALLBACK_ACTIVITY_MESSAGE_LIMIT)) {
    const entry: ActivityMessage = { tools: [] };
    let text = '';
    for (const part of message.parts) {
      if (part.type === 'text' && typeof part.text === 'string') {
        text += excerpt(part.text, Math.max(0, 1_500 - text.length));
      } else if (part.type === 'tool' && typeof part.tool === 'string') {
        const state = part.state;
        if (typeof state !== 'object' || state === null || !('status' in state)) continue;
        const status = state.status;
        if (
          status !== 'pending' &&
          status !== 'running' &&
          status !== 'completed' &&
          status !== 'error'
        )
          continue;
        const name = excerpt(part.tool, 80).trim();
        if (name) {
          entry.tools.push({ name, status });
          if (entry.tools.length > 5) entry.tools.shift();
        }
      }
    }
    while (JSON.stringify(entry.tools).length > 1_000) entry.tools.shift();
    entry.text = text.trim() || undefined;
    while (JSON.stringify(entry).length > 2_300) {
      if (entry.text)
        entry.text = excerpt(entry.text, Math.floor(entry.text.length / 2)) || undefined;
      else entry.tools.pop();
    }
    if (entry.text || entry.tools.length) activity.push(entry);
  }
  return activity.length ? JSON.stringify({ partial: true, messages: activity }) : undefined;
}
