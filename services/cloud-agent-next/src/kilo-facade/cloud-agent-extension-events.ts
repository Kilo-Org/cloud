import type { StoredEvent } from '../websocket/types.js';

export type PublicCloudAgentStatusStep =
  | 'disk_check'
  | 'workspace_setup'
  | 'cloning'
  | 'branch'
  | 'devcontainer_setup'
  | 'setup_commands'
  | 'kilo_server'
  | 'kilo_session'
  | 'ready'
  | 'failed';

export type PublicCloudAgentExtensionEvent =
  | {
      type: 'cloud.message.queued';
      properties: { sessionID: string; messageId: string; delivery: 'queued' };
    }
  | {
      type: 'cloud.message.sent';
      properties: { sessionID: string; messageId: string; delivery: 'sent' };
    }
  | {
      type: 'cloud.message.completed';
      properties: {
        sessionID: string;
        messageId: string;
        status: 'completed';
        delivery: 'sent';
        accepted: true;
      };
    }
  | {
      type: 'cloud.message.failed';
      properties: {
        sessionID: string;
        messageId: string;
        status: 'failed' | 'interrupted';
        delivery: 'queued' | 'sent';
        accepted: boolean;
      };
    }
  | {
      type: 'cloud.status';
      properties: {
        sessionID: string;
        cloudStatus: {
          type: 'preparing' | 'ready' | 'finalizing' | 'error';
          step?: PublicCloudAgentStatusStep;
        };
      };
    };

const FORWARDED_SOURCE_EVENT_TYPES = new Set([
  'cloud.message.queued',
  'cloud.message.sent',
  'cloud.message.completed',
  'cloud.message.failed',
  'cloud.status',
]);

export function isPublicCloudAgentExtensionSourceType(streamEventType: string): boolean {
  return FORWARDED_SOURCE_EVENT_TYPES.has(streamEventType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePayload(payload: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(payload);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function messageIdFromPayload(payload: Record<string, unknown>): string | undefined {
  return typeof payload.messageId === 'string' && payload.messageId.length > 0
    ? payload.messageId
    : undefined;
}

function isCloudStatusType(
  value: unknown
): value is 'preparing' | 'ready' | 'finalizing' | 'error' {
  return value === 'preparing' || value === 'ready' || value === 'finalizing' || value === 'error';
}

function isCloudStatusStep(value: unknown): value is PublicCloudAgentStatusStep {
  return (
    value === 'disk_check' ||
    value === 'workspace_setup' ||
    value === 'cloning' ||
    value === 'branch' ||
    value === 'devcontainer_setup' ||
    value === 'setup_commands' ||
    value === 'kilo_server' ||
    value === 'kilo_session' ||
    value === 'ready' ||
    value === 'failed'
  );
}

export function projectPublicCloudAgentExtensionEvent(
  event: Pick<StoredEvent, 'stream_event_type' | 'payload'>,
  kiloSessionId: string
): PublicCloudAgentExtensionEvent | null {
  const payload = parsePayload(event.payload);
  if (!payload) return null;

  if (event.stream_event_type === 'cloud.status') {
    const cloudStatus = payload.cloudStatus;
    if (!isRecord(cloudStatus) || !isCloudStatusType(cloudStatus.type)) return null;
    return {
      type: 'cloud.status',
      properties: {
        sessionID: kiloSessionId,
        cloudStatus: {
          type: cloudStatus.type,
          ...(isCloudStatusStep(cloudStatus.step) ? { step: cloudStatus.step } : {}),
        },
      },
    };
  }

  const messageId = messageIdFromPayload(payload);
  if (!messageId) return null;

  switch (event.stream_event_type) {
    case 'cloud.message.queued':
      return {
        type: 'cloud.message.queued',
        properties: { sessionID: kiloSessionId, messageId, delivery: 'queued' },
      };
    case 'cloud.message.sent':
      return {
        type: 'cloud.message.sent',
        properties: { sessionID: kiloSessionId, messageId, delivery: 'sent' },
      };
    case 'cloud.message.completed':
      if (payload.status !== 'completed') return null;
      return {
        type: 'cloud.message.completed',
        properties: {
          sessionID: kiloSessionId,
          messageId,
          status: 'completed',
          delivery: 'sent',
          accepted: true,
        },
      };
    case 'cloud.message.failed': {
      const status = payload.status;
      const delivery = payload.delivery;
      if (
        (status !== 'failed' && status !== 'interrupted') ||
        (delivery !== 'queued' && delivery !== 'sent') ||
        typeof payload.accepted !== 'boolean'
      ) {
        return null;
      }
      return {
        type: 'cloud.message.failed',
        properties: {
          sessionID: kiloSessionId,
          messageId,
          status,
          delivery,
          accepted: payload.accepted,
        },
      };
    }
    default:
      return null;
  }
}
