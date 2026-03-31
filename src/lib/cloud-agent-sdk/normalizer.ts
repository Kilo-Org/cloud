/**
 * Event normalizer — the single validation boundary between untyped WebSocket
 * wire data and typed internal code. Validates shape via Zod schemas then uses
 * boundary `as` casts so downstream code receives properly typed NormalizedEvents.
 */
import type { Part, SessionStatus, QuestionInfo, Message } from '@/types/opencode.gen';
import type { SessionInfo, CloudStatus } from './types';
import {
  cloudAgentEventSchema,
  kilocodePayloadSchema,
  messageUpdatedDataSchema,
  messagePartUpdatedDataSchema,
  messagePartDeltaDataSchema,
  messagePartRemovedDataSchema,
  sessionStatusDataSchema,
  sessionCreatedDataSchema,
  sessionUpdatedDataSchema,
  sessionErrorDataSchema,
  sessionIdleDataSchema,
  sessionTurnCloseDataSchema,
  questionAskedDataSchema,
  questionRepliedDataSchema,
  questionRejectedDataSchema,
  permissionAskedDataSchema,
  permissionRepliedDataSchema,
  completeDataSchema,
  errorDataSchema,
  preparingDataSchema,
  autocommitStartedDataSchema,
  autocommitCompletedDataSchema,
  cloudStatusDataSchema,
  connectedDataSchema,
  type CloudAgentEvent,
} from './schemas';

/** Chat events — data mutations for messages and parts. */
export type ChatEvent =
  | { type: 'message.updated'; info: Message }
  | { type: 'message.part.updated'; part: Part }
  | {
      type: 'message.part.delta';
      sessionId: string;
      messageId: string;
      partId: string;
      field: string;
      delta: string;
    }
  | {
      type: 'message.part.removed';
      sessionId: string;
      messageId: string;
      partId: string;
    };

/** Service events — lifecycle, status, questions, autocommit, preparation. */
export type ServiceEvent =
  | { type: 'session.status'; sessionId: string; status: SessionStatus }
  | { type: 'session.created'; info: SessionInfo }
  | { type: 'session.updated'; info: SessionInfo }
  | { type: 'session.error'; error: string; sessionId?: string }
  | { type: 'session.idle'; sessionId: string }
  | { type: 'session.turn.close'; sessionId?: string; reason?: string }
  | {
      type: 'question.asked';
      requestId: string;
      questions?: QuestionInfo[];
    }
  | { type: 'question.replied'; requestId: string }
  | { type: 'question.rejected'; requestId: string }
  | {
      type: 'permission.asked';
      requestId: string;
      permission: string;
      patterns: string[];
      metadata: Record<string, unknown>;
      always: string[];
    }
  | { type: 'permission.replied'; requestId: string }
  | {
      type: 'stopped';
      reason: 'complete' | 'interrupted' | 'disconnected' | 'error';
      branch?: string;
    }
  | { type: 'warning' }
  | { type: 'preparing'; step: string; message: string; branch?: string }
  | { type: 'autocommit_started'; messageId: string; message?: string }
  | {
      type: 'autocommit_completed';
      messageId: string;
      success: boolean;
      message?: string;
      skipped?: boolean;
      commitHash?: string;
      commitMessage?: string;
    }
  | { type: 'cloud.status'; cloudStatus: CloudStatus }
  | {
      type: 'connected';
      sessionStatus?: SessionStatus;
      cloudStatus?: CloudStatus;
    };

export type NormalizedEvent = ChatEvent | ServiceEvent;

const CHAT_EVENT_TYPES = new Set([
  'message.updated',
  'message.part.updated',
  'message.part.delta',
  'message.part.removed',
]);

export function isChatEvent(event: NormalizedEvent): event is ChatEvent {
  return CHAT_EVENT_TYPES.has(event.type);
}

export function isServiceEvent(event: NormalizedEvent): event is ServiceEvent {
  return !CHAT_EVENT_TYPES.has(event.type);
}

/** Best-effort error message extraction from a loosely-typed error field. */
function extractErrorMessage(rawError: unknown): string {
  if (typeof rawError === 'string') return rawError;
  if (typeof rawError !== 'object' || rawError === null) return 'Unknown error';
  if (
    'data' in rawError &&
    typeof rawError.data === 'object' &&
    rawError.data !== null &&
    'message' in rawError.data &&
    typeof rawError.data.message === 'string'
  ) {
    return rawError.data.message;
  }
  if ('message' in rawError && typeof rawError.message === 'string') return rawError.message;
  return 'Unknown error';
}

function normalizeInnerEvent(eventType: string, data: unknown): NormalizedEvent | null {
  switch (eventType) {
    case 'message.updated': {
      const r = messageUpdatedDataSchema.safeParse(data);
      if (!r.success) return null;
      return { type: 'message.updated', info: r.data.info as Message };
    }

    case 'message.part.updated': {
      const r = messagePartUpdatedDataSchema.safeParse(data);
      if (!r.success) return null;
      return { type: 'message.part.updated', part: r.data.part as Part };
    }

    case 'message.part.delta': {
      const r = messagePartDeltaDataSchema.safeParse(data);
      if (!r.success) return null;
      return {
        type: 'message.part.delta',
        sessionId: r.data.sessionID,
        messageId: r.data.messageID,
        partId: r.data.partID,
        field: r.data.field,
        delta: r.data.delta,
      };
    }

    case 'message.part.removed': {
      const r = messagePartRemovedDataSchema.safeParse(data);
      if (!r.success) return null;
      return {
        type: 'message.part.removed',
        sessionId: r.data.sessionID,
        messageId: r.data.messageID,
        partId: r.data.partID,
      };
    }

    case 'session.status': {
      const r = sessionStatusDataSchema.safeParse(data);
      if (!r.success) return null;
      return {
        type: 'session.status',
        sessionId: r.data.sessionID,
        status: r.data.status,
      };
    }

    case 'session.created': {
      const r = sessionCreatedDataSchema.safeParse(data);
      if (!r.success) return null;
      const rawCreated = r.data.info;
      return {
        type: 'session.created',
        info: {
          id: rawCreated.id,
          parentID: rawCreated.parentID != null ? String(rawCreated.parentID) : undefined,
        },
      };
    }

    case 'session.updated': {
      const r = sessionUpdatedDataSchema.safeParse(data);
      if (!r.success) return null;
      const rawUpdated = r.data.info;
      return {
        type: 'session.updated',
        info: {
          id: rawUpdated.id,
          parentID: rawUpdated.parentID != null ? String(rawUpdated.parentID) : undefined,
        },
      };
    }

    case 'session.error': {
      const r = sessionErrorDataSchema.safeParse(data);
      const d = r.success ? r.data : { error: undefined, sessionID: undefined };
      const sessionId = typeof d.sessionID === 'string' ? d.sessionID : undefined;
      return { type: 'session.error', error: extractErrorMessage(d.error), sessionId };
    }

    case 'session.idle': {
      const r = sessionIdleDataSchema.safeParse(data);
      if (!r.success || r.data.sessionID === undefined) return null;
      return { type: 'session.idle', sessionId: String(r.data.sessionID) };
    }

    case 'session.turn.close': {
      const r = sessionTurnCloseDataSchema.safeParse(data);
      if (!r.success) return null;
      return { type: 'session.turn.close', sessionId: r.data.sessionID, reason: r.data.reason };
    }

    case 'question.asked': {
      const r = questionAskedDataSchema.safeParse(data);
      if (!r.success) return null;
      return {
        type: 'question.asked',
        requestId: r.data.id,
        questions: r.data.questions as QuestionInfo[] | undefined,
      };
    }

    case 'question.replied': {
      const r = questionRepliedDataSchema.safeParse(data);
      if (!r.success) return null;
      return { type: 'question.replied', requestId: r.data.requestID };
    }

    case 'question.rejected': {
      const r = questionRejectedDataSchema.safeParse(data);
      if (!r.success) return null;
      return { type: 'question.rejected', requestId: r.data.requestID };
    }

    case 'permission.asked': {
      const r = permissionAskedDataSchema.safeParse(data);
      if (!r.success) return null;
      return {
        type: 'permission.asked',
        requestId: r.data.id,
        permission: r.data.permission,
        patterns: r.data.patterns,
        metadata: r.data.metadata as Record<string, unknown>,
        always: r.data.always,
      };
    }

    case 'permission.replied': {
      const r = permissionRepliedDataSchema.safeParse(data);
      if (!r.success) return null;
      return { type: 'permission.replied', requestId: r.data.requestID };
    }

    case 'complete': {
      const r = completeDataSchema.safeParse(data);
      return {
        type: 'stopped',
        reason: 'complete',
        branch: r.success ? r.data.currentBranch : undefined,
      };
    }

    case 'interrupted':
      return { type: 'stopped', reason: 'interrupted' };

    case 'error': {
      const r = errorDataSchema.safeParse(data);
      if (r.success && r.data.fatal) return { type: 'stopped', reason: 'error' };
      return { type: 'warning' };
    }

    case 'wrapper_disconnected':
      return { type: 'stopped', reason: 'disconnected' };

    case 'preparing': {
      const r = preparingDataSchema.safeParse(data);
      if (!r.success) return null;
      return {
        type: 'preparing',
        step: r.data.step,
        message: r.data.message,
        branch: r.data.branch,
      };
    }

    case 'autocommit_started': {
      const r = autocommitStartedDataSchema.safeParse(data);
      if (!r.success) return null;
      return { type: 'autocommit_started', messageId: r.data.messageId, message: r.data.message };
    }

    case 'autocommit_completed': {
      const r = autocommitCompletedDataSchema.safeParse(data);
      if (!r.success) return null;
      return {
        type: 'autocommit_completed',
        messageId: r.data.messageId,
        success: r.data.success,
        message: r.data.message,
        skipped: r.data.skipped,
        commitHash: r.data.commitHash,
        commitMessage: r.data.commitMessage,
      };
    }

    case 'cloud.status': {
      const r = cloudStatusDataSchema.safeParse(data);
      if (!r.success) return null;
      return { type: 'cloud.status', cloudStatus: r.data.cloudStatus };
    }

    case 'connected': {
      const r = connectedDataSchema.safeParse(data);
      if (!r.success) return null;
      return {
        type: 'connected',
        ...(r.data.sessionStatus !== undefined && { sessionStatus: r.data.sessionStatus }),
        ...(r.data.cloudStatus !== undefined && { cloudStatus: r.data.cloudStatus }),
      };
    }

    default:
      return null;
  }
}

/**
 * Normalize a raw CloudAgentEvent into a typed discriminated union.
 * Returns null for invalid or unrecognized events.
 */
export function normalize(raw: CloudAgentEvent): NormalizedEvent | null {
  if (!cloudAgentEventSchema.safeParse(raw).success) return null;

  let eventType = raw.streamEventType;
  let data: unknown = raw.data;

  const kilo = kilocodePayloadSchema.safeParse(data);
  if (eventType === 'kilocode' && kilo.success) {
    eventType = kilo.data.type;
    data = kilo.data.properties;
  }

  return normalizeInnerEvent(eventType, data);
}

/**
 * Normalize a CLI event (no CloudAgentEvent envelope).
 * CLI events arrive as {event: string, data: unknown} from UserConnectionDO.
 */
export function normalizeCliEvent(eventType: string, data: unknown): NormalizedEvent | null {
  return normalizeInnerEvent(eventType, data);
}
