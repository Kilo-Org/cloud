import type { CloudAgentEvent } from '@/lib/cloud-agent-next/event-types';

export type CodeReviewDisplayEvent = {
  timestamp: string;
  message: string;
  content?: string;
  eventType: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function partStateStatus(state: unknown): string | undefined {
  if (typeof state === 'string') return state;
  if (isRecord(state) && typeof state.status === 'string') return state.status;
  return undefined;
}

function partStateInput(state: unknown): Record<string, unknown> | undefined {
  if (!isRecord(state) || !isRecord(state.input)) return undefined;
  return state.input;
}

function toolDetail(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const filePath = input.filePath ?? input.file_path ?? input.path;
  const command = input.command;
  const query = input.query ?? input.pattern;
  if (typeof filePath === 'string') return filePath;
  if (typeof command === 'string') {
    return command.length > 100 ? `${command.slice(0, 100)}...` : command;
  }
  if (typeof query === 'string') return query;
  return undefined;
}

function sessionStatusLabel(status: unknown): string | undefined {
  if (typeof status === 'string') return status;
  if (isRecord(status) && typeof status.type === 'string') return status.type;
  return undefined;
}

function toDisplayEventFromKilocode(
  timestamp: string,
  payload: Record<string, unknown>
): CodeReviewDisplayEvent | null {
  const type = payload.type;
  const properties = isRecord(payload.properties) ? payload.properties : undefined;
  if (typeof type !== 'string' || !properties) return null;

  if (type === 'message.part.updated') {
    const part = isRecord(properties.part) ? properties.part : undefined;
    if (!part) return null;
    const partType = part.type;

    if (partType === 'tool') {
      const toolName =
        (typeof part.tool === 'string' && part.tool) ||
        (typeof part.name === 'string' && part.name) ||
        undefined;
      const status = partStateStatus(part.state);
      if (!toolName || !status || status === 'pending') return null;
      const detail = toolDetail(
        partStateInput(part.state) ?? (isRecord(part.input) ? part.input : undefined)
      );
      if (status === 'error') {
        return {
          timestamp,
          message: `Tool: ${toolName} — error`,
          content: detail,
          eventType: 'error',
        };
      }
      return { timestamp, message: `Tool: ${toolName}`, content: detail, eventType: 'tool' };
    }

    if (partType === 'text') {
      const status = partStateStatus(part.state);
      if (status && status !== 'complete' && status !== 'completed') return null;
      const text = typeof part.text === 'string' ? part.text : undefined;
      if (text && text.trim()) {
        const truncated = text.length > 200 ? `${text.slice(0, 200)}...` : text;
        return { timestamp, message: truncated, eventType: 'text' };
      }
      return null;
    }
    return null;
  }

  if (type === 'session.status') {
    const status = sessionStatusLabel(properties.status);
    if (status === 'idle') return { timestamp, message: 'Agent idle', eventType: 'status' };
    if (status === 'busy') return { timestamp, message: 'Agent working...', eventType: 'status' };
    return null;
  }

  if (type === 'session.error') {
    const error = typeof properties.error === 'string' ? properties.error : undefined;
    return { timestamp, message: `Session error: ${error ?? 'Unknown error'}`, eventType: 'error' };
  }

  return null;
}

export function toCodeReviewDisplayEvent(event: CloudAgentEvent): CodeReviewDisplayEvent | null {
  const { streamEventType, timestamp, data } = event;
  const payload = isRecord(data) ? data : undefined;

  if (streamEventType === 'started') {
    return { timestamp, message: 'Execution started', eventType: streamEventType };
  }
  if (streamEventType === 'complete') {
    return { timestamp, message: 'Review completed', eventType: streamEventType };
  }
  if (streamEventType === 'interrupted') {
    return { timestamp, message: 'Review interrupted', eventType: streamEventType };
  }
  if (streamEventType === 'error') {
    const errorMsg = typeof payload?.message === 'string' ? payload.message : 'An error occurred';
    return { timestamp, message: `Error: ${errorMsg}`, eventType: streamEventType };
  }
  if (streamEventType === 'kilocode' && payload) {
    return toDisplayEventFromKilocode(timestamp, payload);
  }
  if (streamEventType === 'status') {
    const status = typeof payload?.status === 'string' ? payload.status : '';
    if (status) {
      return { timestamp, message: `Status: ${status}`, eventType: streamEventType };
    }
  }
  return null;
}
