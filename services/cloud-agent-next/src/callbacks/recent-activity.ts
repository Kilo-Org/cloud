import type { AssistantAnswer } from './assistant-answer.js';

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

export function renderRecentActivity(messages: readonly AssistantAnswer[]): string | undefined {
  const activity: ActivityMessage[] = [];
  for (const message of messages.slice(-CALLBACK_ACTIVITY_MESSAGE_LIMIT)) {
    const entry: ActivityMessage = { tools: [] };
    const text = excerpt(message.text, 1_500);
    for (const tool of message.tools) {
      const name = excerpt(tool.name, 80).trim();
      if (name) {
        entry.tools.push({ name, status: tool.status });
        if (entry.tools.length > 5) entry.tools.shift();
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
