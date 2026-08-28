import { type CloudAgentEvent } from '@kilocode/cloud-agent-sdk';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { i18n } from '@/i18n';
import { dateTimeFormat } from '@/lib/intl-cache';
import { parseTimestamp } from '@/lib/utils';
import { type TFunction } from 'i18next';

type GetSessionMessagesResult =
  inferRouterOutputs<MobileRouter>['codeReviews']['getSessionMessages'];
type SessionMessageEntry = Extract<GetSessionMessagesResult, { success: true }>['entries'][number];

/**
 * A flat transcript row for the spectator view. Mirrors `CodeReviewDisplayEvent`
 * from apps/web's code-review-stream-events; mobile owns its own copy because
 * it cannot import apps/web.
 */
export type SpectatorRow = {
  key?: string;
  timestamp: string;
  message: string;
  content?: string;
  eventType: string;
};

/** Decode an untrusted wire value into a record, or undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the WebSocket payload is untrusted; typeof is the entry-boundary decode
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Decode an untrusted wire value into a string, or undefined. */
function asString(value: unknown): string | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the WebSocket payload is untrusted; typeof is the entry-boundary decode
  return typeof value === 'string' ? value : undefined;
}

function partStateStatus(state: unknown): string | undefined {
  const asStatus = asString(state);
  if (asStatus !== undefined) {
    return asStatus;
  }
  const record = asRecord(state);
  if (record !== undefined) {
    return asString(record.status);
  }
  return undefined;
}

function partStateInput(state: unknown): Record<string, unknown> | undefined {
  const record = asRecord(state);
  if (record === undefined) {
    return undefined;
  }
  return asRecord(record.input);
}

function toolDetail(input: Record<string, unknown> | undefined): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const filePath = input.filePath ?? input.file_path ?? input.path;
  const command = input.command;
  const query = input.query ?? input.pattern;
  const pathString = asString(filePath);
  if (pathString !== undefined) {
    return pathString;
  }
  const commandString = asString(command);
  if (commandString !== undefined) {
    return commandString;
  }
  const queryString = asString(query);
  if (queryString !== undefined) {
    return queryString;
  }
  return undefined;
}

function sessionStatusLabel(status: unknown): string | undefined {
  const asStatus = asString(status);
  if (asStatus !== undefined) {
    return asStatus;
  }
  const record = asRecord(status);
  if (record !== undefined) {
    return asString(record.type);
  }
  return undefined;
}

function partKey(part: Record<string, unknown>): string | undefined {
  const id = asString(part.id);
  return id === undefined || id === '' ? undefined : id;
}

function isCompletedStatus(status: string | undefined): boolean {
  return status === 'complete' || status === 'completed';
}

export function appendSpectatorRow(rows: SpectatorRow[], next: SpectatorRow): SpectatorRow[] {
  if (next.key === undefined) {
    return [...rows, next];
  }
  const index = rows.findIndex(row => row.key === next.key);
  if (index === -1) {
    return [...rows, next];
  }
  const updated = [...rows];
  updated[index] = next;
  return updated;
}

function toRowFromKilocode(
  timestamp: string,
  payload: Record<string, unknown>,
  t: TFunction
): SpectatorRow | null {
  const type = asString(payload.type);
  const properties = asRecord(payload.properties);
  if (type === undefined || properties === undefined) {
    return null;
  }

  if (type === 'message.part.updated') {
    const part = asRecord(properties.part);
    if (part === undefined) {
      return null;
    }
    const partType = asString(part.type);

    if (partType === 'tool') {
      const toolName = asString(part.tool) ?? asString(part.name);
      const status = partStateStatus(part.state);
      const key = partKey(part);
      if (toolName === undefined || status === undefined || status === 'pending') {
        return null;
      }
      const isRunning = status === 'running';
      const isTerminal = isCompletedStatus(status) || status === 'error';
      if (!isRunning && !isTerminal) {
        return null;
      }
      if (isRunning && key === undefined) {
        return null;
      }
      const detail = toolDetail(partStateInput(part.state) ?? asRecord(part.input));
      if (status === 'error') {
        return {
          timestamp,
          message: t('codeReviewer.reviewDetail.toolNameError', { name: toolName }),
          content: detail,
          eventType: 'error',
          key,
        };
      }
      return {
        timestamp,
        message: t('codeReviewer.reviewDetail.toolName', { name: toolName }),
        content: detail,
        eventType: 'tool',
        key,
      };
    }

    if (partType === 'text') {
      const status = partStateStatus(part.state);
      if (!isCompletedStatus(status)) {
        return null;
      }
      const text = asString(part.text);
      const trimmed = text?.trim();
      if (trimmed) {
        return { timestamp, message: trimmed, eventType: 'text', key: partKey(part) };
      }
      return null;
    }
    return null;
  }

  if (type === 'session.status') {
    const status = sessionStatusLabel(properties.status);
    if (status === 'idle') {
      return { timestamp, message: t('codeReviewer.reviewDetail.agentIdle'), eventType: 'status' };
    }
    if (status === 'busy') {
      return {
        timestamp,
        message: t('codeReviewer.reviewDetail.agentWorking'),
        eventType: 'status',
      };
    }
    return null;
  }

  if (type === 'session.error') {
    const error = asString(properties.error) ?? t('codeReviewer.reviewDetail.unknownError');
    return {
      timestamp,
      message: t('codeReviewer.reviewDetail.sessionError', { error }),
      eventType: 'error',
    };
  }

  return null;
}

/** Map a live cloud-agent stream event to a transcript row (field rules copied from apps/web's `toCodeReviewDisplayEvent`). */
export function toSpectatorRow(event: CloudAgentEvent, t: TFunction): SpectatorRow | null {
  const { streamEventType, timestamp, data } = event;
  const payload = asRecord(data);

  if (streamEventType === 'started') {
    return {
      timestamp,
      message: t('codeReviewer.reviewDetail.executionStarted'),
      eventType: streamEventType,
    };
  }
  if (streamEventType === 'complete') {
    return {
      timestamp,
      message: t('codeReviewer.reviewDetail.reviewCompleted'),
      eventType: streamEventType,
    };
  }
  if (streamEventType === 'interrupted') {
    return {
      timestamp,
      message: t('codeReviewer.reviewDetail.reviewInterrupted'),
      eventType: streamEventType,
    };
  }
  if (streamEventType === 'error') {
    const errorMsg = asString(payload?.message) ?? t('codeReviewer.reviewDetail.anErrorOccurred');
    return {
      timestamp,
      message: t('codeReviewer.reviewDetail.errorWithMessage', { message: errorMsg }),
      eventType: streamEventType,
    };
  }
  if (streamEventType === 'kilocode' && payload !== undefined) {
    return toRowFromKilocode(timestamp, payload, t);
  }
  if (streamEventType === 'status') {
    const status = asString(payload?.status);
    if (status) {
      return {
        timestamp,
        message: t('codeReviewer.reviewDetail.statusWithValue', { status }),
        eventType: streamEventType,
      };
    }
  }
  return null;
}

/**
 * Map `getSessionMessages` entries 1:1 to transcript rows, deriving a key from
 * timestamp + message + index (the entries carry no key of their own).
 */
export function spectatorRowsFromEntries(entries: readonly SessionMessageEntry[]): SpectatorRow[] {
  return entries.map((entry, index) => ({
    timestamp: entry.timestamp,
    message: entry.message,
    content: entry.content,
    eventType: entry.eventType,
    key: `${entry.timestamp}${entry.message}${index}`,
  }));
}

/**
 * Format a transcript timestamp as a localized clock time. The backend emits
 * PostgreSQL/ISO strings that Hermes cannot parse with `new Date`, so the value
 * goes through `parseTimestamp` first; an unusable value falls back to the raw
 * string rather than throwing.
 */
export function formatSpectatorTime(timestamp: string): string {
  const date = parseTimestamp(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return dateTimeFormat(i18n.language, { timeStyle: 'short' }).format(date);
}
