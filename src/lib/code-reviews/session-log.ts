import 'server-only';

import type { SessionSnapshot } from '@/lib/session-ingest-client';
import type { CloudMessage } from '@/components/cloud-agent-next/legacy-session-types';
import { convertToCloudMessages } from '@/components/cloud-agent-next/legacy-session-types';

// ---------------------------------------------------------------------------
// Shared log entry type (matches DisplayEvent in CodeReviewStreamView)
// ---------------------------------------------------------------------------

export type SessionLogEntry = {
  timestamp: string;
  eventType: string;
  message: string;
  content?: string;
};

// ---------------------------------------------------------------------------
// V2 (cloud-agent-next / session-ingest) conversion
// ---------------------------------------------------------------------------

/**
 * Convert a v2 session snapshot into flat log entries for the terminal view.
 *
 * Walks each StoredMessage's parts array and extracts tool calls, text output,
 * and errors into timestamped log lines. Skips reasoning, compaction, and file
 * parts — those add noise without actionable context for end users.
 */
export function v2SnapshotToLogEntries(snapshot: SessionSnapshot): SessionLogEntry[] {
  const entries: SessionLogEntry[] = [];

  for (const msg of snapshot.messages) {
    const info = msg.info as Record<string, unknown>;
    const role = info.role as string | undefined;
    const time = info.time as { created?: number } | undefined;
    const baseTs = time?.created ? new Date(time.created).toISOString() : '';

    // Show the initial user prompt as a single log line (truncated)
    if (role === 'user') {
      const textContent = (msg.parts ?? [])
        .filter(p => (p as Record<string, unknown>).type === 'text')
        .map(p => ((p as Record<string, unknown>).text as string) ?? '')
        .join('')
        .trim();
      if (textContent) {
        const truncated = textContent.length > 300 ? textContent.slice(0, 300) + '…' : textContent;
        entries.push({ timestamp: baseTs, eventType: 'info', message: truncated });
      }
      continue;
    }

    // Assistant messages: walk parts
    if (role !== 'assistant') continue;

    const error = info.error as Record<string, unknown> | undefined;

    for (const part of msg.parts ?? []) {
      const p = part as Record<string, unknown>;
      const partType = p.type as string | undefined;

      if (partType === 'tool') {
        const toolName = (p.tool as string | undefined) ?? (p.name as string | undefined);
        const state = p.state as Record<string, unknown> | undefined;
        const status = state?.status as string | undefined;
        const input = state?.input as Record<string, unknown> | undefined;

        // Extract a short detail from tool input
        let detail: string | undefined;
        if (input) {
          const filePath = input.filePath ?? input.file_path ?? input.path;
          const command = input.command;
          const query = input.query ?? input.pattern;
          if (typeof filePath === 'string') detail = filePath;
          else if (typeof command === 'string')
            detail = command.length > 120 ? command.slice(0, 120) + '…' : command;
          else if (typeof query === 'string') detail = query;
        }

        if (status === 'error') {
          const errorStr = typeof state?.error === 'string' ? state.error : undefined;
          entries.push({
            timestamp: baseTs,
            eventType: 'error',
            message: `Tool: ${toolName ?? 'unknown'} — error`,
            content: errorStr ?? detail,
          });
        } else {
          entries.push({
            timestamp: baseTs,
            eventType: 'tool',
            message: `Tool: ${toolName ?? 'unknown'}`,
            content: detail,
          });
        }
        continue;
      }

      if (partType === 'text') {
        const text = (p.text as string | undefined)?.trim();
        if (!text) continue;
        const truncated = text.length > 200 ? text.slice(0, 200) + '…' : text;
        entries.push({ timestamp: baseTs, eventType: 'text', message: truncated });
        continue;
      }

      // Skip reasoning, compaction, file, step-start, step-finish, patch, subtask
    }

    // Show message-level error if present and no parts captured it
    if (error) {
      const data = error.data as Record<string, unknown> | undefined;
      const errorMsg = typeof data?.message === 'string' ? data.message : 'An error occurred';
      entries.push({ timestamp: baseTs, eventType: 'error', message: `Error: ${errorMsg}` });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// V1 (cloud-agent / R2 blob) conversion
// ---------------------------------------------------------------------------

/**
 * Convert v1 blob messages into flat log entries.
 *
 * The blob contains raw CLI event objects. We use the existing
 * `convertToCloudMessages` utility to normalise them, then extract
 * the interesting bits (tool calls, text, errors) into log lines.
 */
export function v1BlobToLogEntries(rawMessages: unknown): SessionLogEntry[] {
  if (!Array.isArray(rawMessages)) return [];

  const validMessages = rawMessages.filter(
    (m): m is Record<string, unknown> => m !== null && typeof m === 'object'
  );
  const cloudMessages = convertToCloudMessages(validMessages);
  const entries: SessionLogEntry[] = [];

  for (const msg of cloudMessages) {
    const ts = new Date(msg.ts).toISOString();

    if (msg.type === 'user') {
      const text = (msg.text || msg.content || '').trim();
      if (text) {
        const truncated = text.length > 300 ? text.slice(0, 300) + '…' : text;
        entries.push({ timestamp: ts, eventType: 'info', message: truncated });
      }
      continue;
    }

    if (msg.type !== 'assistant') continue;

    const logEntry = cloudMessageToLogEntry(msg, ts);
    if (logEntry) entries.push(logEntry);
  }

  return entries;
}

function cloudMessageToLogEntry(msg: CloudMessage, ts: string): SessionLogEntry | null {
  // Tool calls
  if (msg.say === 'tool' || msg.ask === 'tool' || msg.ask === 'command') {
    const meta = msg.metadata;
    const toolName = (meta?.tool as string) ?? (msg.ask === 'command' ? 'command' : 'tool');
    let detail: string | undefined;
    if (meta) {
      const filePath = meta.path ?? meta.filePath;
      const command = meta.command;
      if (typeof filePath === 'string') detail = filePath;
      else if (typeof command === 'string')
        detail = command.length > 120 ? command.slice(0, 120) + '…' : command;
    }
    return { timestamp: ts, eventType: 'tool', message: `Tool: ${toolName}`, content: detail };
  }

  // API request
  if (msg.say === 'api_req_started') {
    return { timestamp: ts, eventType: 'status', message: 'API request started' };
  }

  // Completion result (the review output)
  if (msg.say === 'completion_result') {
    const text = (msg.text || msg.content || '').trim();
    if (!text) return null;
    const truncated = text.length > 200 ? text.slice(0, 200) + '…' : text;
    return { timestamp: ts, eventType: 'text', message: truncated };
  }

  // General text output
  if (msg.say === 'text') {
    const text = (msg.text || msg.content || '').trim();
    if (!text) return null;
    const truncated = text.length > 200 ? text.slice(0, 200) + '…' : text;
    return { timestamp: ts, eventType: 'text', message: truncated };
  }

  // Error messages
  if (msg.say === 'error') {
    const text = (msg.text || msg.content || '').trim();
    return {
      timestamp: ts,
      eventType: 'error',
      message: `Error: ${text.length > 200 ? text.slice(0, 200) + '…' : text}`,
    };
  }

  return null;
}
