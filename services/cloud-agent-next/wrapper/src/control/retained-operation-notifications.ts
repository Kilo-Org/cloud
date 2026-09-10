import {
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  sessionPreparingPayloadSchema,
  type SessionEventPayload,
  type SessionPreparingPayload,
} from '../../../src/shared/sandbox-control-protocol.js';
import type { PreparingEventDataV2 } from '../../../src/shared/protocol.js';

const MAX_RETAINED_DELIVERY_EVENTS = 8;
const MAX_RETAINED_PREPARING_EVENTS = 64;
const MAX_RETAINED_DELIVERY_BYTES = Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES / 2);
const RESERVED_TERMINAL_EVENTS = 1;
const RESERVED_TERMINAL_PREPARING_EVENTS = 8;
const RESERVED_ATTEMPT_TERMINALS = 1;
const MAX_EVENT_MESSAGE_LENGTH = 4_096;
const MAX_COMMIT_HASH_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 128;

type Entry =
  | { kind: 'event'; payload: SessionEventPayload; terminal: boolean; bytes: number }
  | {
      kind: 'preparing';
      payload: SessionPreparingPayload;
      terminal: boolean;
      attemptTerminal: boolean;
      bytes: number;
    };

const preparingActions = new Set([
  'attempt_started',
  'attempt_completed',
  'attempt_failed',
  'step_started',
  'step_completed',
  'step_failed',
]);

const terminalPreparingActions = new Set([
  'attempt_completed',
  'attempt_failed',
  'step_completed',
  'step_failed',
]);

function boundedString(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function boundedTimestamp(timestamp: string | undefined): string | undefined {
  return timestamp === undefined ? undefined : boundedString(timestamp, MAX_TIMESTAMP_LENGTH);
}

function projectFinalizationEvent(payload: SessionEventPayload):
  | {
      payload: SessionEventPayload;
      terminal: boolean;
    }
  | undefined {
  if (payload.type === 'autocommit_completed') {
    const { properties } = payload;
    if (typeof properties.success !== 'boolean' || typeof properties.messageId !== 'string')
      return undefined;
    const projected: Record<string, unknown> = {
      success: properties.success,
      messageId: properties.messageId,
    };
    if (typeof properties.skipped === 'boolean') projected.skipped = properties.skipped;
    if (typeof properties.commitHash === 'string')
      projected.commitHash = boundedString(properties.commitHash, MAX_COMMIT_HASH_LENGTH);
    if (typeof properties.message === 'string')
      projected.message = boundedString(properties.message, MAX_EVENT_MESSAGE_LENGTH);
    if (typeof properties.commitMessage === 'string')
      projected.commitMessage = boundedString(properties.commitMessage, MAX_EVENT_MESSAGE_LENGTH);
    return {
      payload: {
        type: payload.type,
        properties: projected,
        ...(boundedTimestamp(payload.timestamp)
          ? { timestamp: boundedTimestamp(payload.timestamp) }
          : {}),
      },
      terminal: true,
    };
  }
  if (payload.type === 'status') {
    const { properties } = payload;
    if (typeof properties.message !== 'string' || typeof properties.messageId !== 'string')
      return undefined;
    return {
      payload: {
        type: payload.type,
        properties: {
          message: boundedString(properties.message, MAX_EVENT_MESSAGE_LENGTH),
          messageId: properties.messageId,
        },
        ...(boundedTimestamp(payload.timestamp)
          ? { timestamp: boundedTimestamp(payload.timestamp) }
          : {}),
      },
      terminal: false,
    };
  }
  return undefined;
}

function projectPreparing(payload: PreparingEventDataV2):
  | {
      payload: PreparingEventDataV2;
      terminal: boolean;
      attemptTerminal: boolean;
    }
  | undefined {
  if (!preparingActions.has(payload.action)) return undefined;
  const common = {
    version: payload.version,
    attemptId: payload.attemptId,
    triggerMessageId: payload.triggerMessageId,
    revision: payload.revision,
    timestamp: payload.timestamp,
    step: payload.step,
    message: boundedString(payload.message, MAX_EVENT_MESSAGE_LENGTH),
  };
  let projected: PreparingEventDataV2;
  switch (payload.action) {
    case 'attempt_started':
    case 'attempt_completed':
      projected = { ...common, action: payload.action };
      break;
    case 'attempt_failed':
      projected = {
        ...common,
        action: payload.action,
        safeError: boundedString(payload.safeError, MAX_EVENT_MESSAGE_LENGTH),
      };
      break;
    case 'step_started':
      projected = {
        ...common,
        action: payload.action,
        stepId: payload.stepId,
        kind: payload.kind,
        label: boundedString(payload.label, MAX_EVENT_MESSAGE_LENGTH),
        ...(payload.command === undefined
          ? {}
          : { command: boundedString(payload.command, MAX_EVENT_MESSAGE_LENGTH) }),
        ...(payload.commandIndex === undefined ? {} : { commandIndex: payload.commandIndex }),
        ...(payload.commandCount === undefined ? {} : { commandCount: payload.commandCount }),
      };
      break;
    case 'step_completed':
      projected = {
        ...common,
        action: payload.action,
        stepId: payload.stepId,
        ...(payload.exitCode === undefined ? {} : { exitCode: payload.exitCode }),
      };
      break;
    case 'step_failed':
      projected = {
        ...common,
        action: payload.action,
        stepId: payload.stepId,
        safeError: boundedString(payload.safeError, MAX_EVENT_MESSAGE_LENGTH),
        ...(payload.exitCode === undefined ? {} : { exitCode: payload.exitCode }),
      };
      break;
    default:
      return undefined;
  }
  if (!sessionPreparingPayloadSchema.safeParse(projected).success) return undefined;
  return {
    payload: projected,
    terminal: terminalPreparingActions.has(projected.action),
    attemptTerminal:
      projected.action === 'attempt_completed' || projected.action === 'attempt_failed',
  };
}

function serializedBytes(
  payload: SessionEventPayload | SessionPreparingPayload
): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(payload));
  } catch {
    return undefined;
  }
}

export function isRetainedOperationPreparing(payload: PreparingEventDataV2): boolean {
  return preparingActions.has(payload.action);
}

export function createRetainedOperationNotifications() {
  const entries: Entry[] = [];
  let bytes = 0;

  function count(kind: Entry['kind']): number {
    return entries.filter(entry => entry.kind === kind).length;
  }

  function terminalCount(kind: Entry['kind']): number {
    return entries.filter(entry => entry.kind === kind && entry.terminal).length;
  }

  function removeOldestOptional(kind?: Entry['kind']): boolean {
    const index = entries.findIndex(
      entry => !entry.terminal && (kind === undefined || entry.kind === kind)
    );
    if (index === -1) return false;
    const [removed] = entries.splice(index, 1);
    if (removed) bytes -= removed.bytes;
    return true;
  }

  function removeOldestStepTerminal(): boolean {
    const index = entries.findIndex(
      entry => entry.kind === 'preparing' && entry.terminal && !entry.attemptTerminal
    );
    if (index === -1) return false;
    const [removed] = entries.splice(index, 1);
    if (removed) bytes -= removed.bytes;
    return true;
  }

  function attemptTerminalCount(): number {
    return entries.filter(entry => entry.kind === 'preparing' && entry.attemptTerminal).length;
  }

  function retain<EntryKind extends Entry['kind']>(
    kind: EntryKind,
    payload: Extract<Entry, { kind: EntryKind }>['payload'],
    terminal: boolean,
    attemptTerminal = false
  ): boolean {
    const size = serializedBytes(payload);
    if (size === undefined || size > MAX_RETAINED_DELIVERY_BYTES) return false;
    const limit = kind === 'event' ? MAX_RETAINED_DELIVERY_EVENTS : MAX_RETAINED_PREPARING_EVENTS;
    const reserved =
      kind === 'event' ? RESERVED_TERMINAL_EVENTS : RESERVED_TERMINAL_PREPARING_EVENTS;
    if (terminal) {
      const terminalLimit =
        kind === 'preparing' && !attemptTerminal
          ? limit - Math.max(0, RESERVED_ATTEMPT_TERMINALS - attemptTerminalCount())
          : limit;
      while (count(kind) >= terminalLimit) {
        if (!removeOldestOptional(kind) && !(attemptTerminal && removeOldestStepTerminal()))
          return false;
      }
      while (bytes + size > MAX_RETAINED_DELIVERY_BYTES) {
        if (!removeOldestOptional() && !(attemptTerminal && removeOldestStepTerminal()))
          return false;
      }
    } else {
      const optionalLimit = limit - Math.max(0, reserved - terminalCount(kind));
      if (count(kind) >= optionalLimit || bytes + size > MAX_RETAINED_DELIVERY_BYTES) return false;
    }
    bytes += size;
    entries.push({
      kind,
      payload: structuredClone(payload),
      terminal,
      ...(kind === 'preparing' ? { attemptTerminal } : {}),
      bytes: size,
    } as Entry);
    return true;
  }

  return {
    retainFinalization(payload: SessionEventPayload): SessionEventPayload | undefined {
      const projected = projectFinalizationEvent(payload);
      if (!projected || !retain('event', projected.payload, projected.terminal)) return undefined;
      return structuredClone(projected.payload);
    },
    retainPreparing(payload: PreparingEventDataV2): PreparingEventDataV2 | undefined {
      const projected = projectPreparing(payload);
      if (
        !projected ||
        !retain('preparing', projected.payload, projected.terminal, projected.attemptTerminal)
      )
        return undefined;
      return structuredClone(projected.payload);
    },
    snapshot(): { events: SessionEventPayload[]; preparing: SessionPreparingPayload[] } {
      return {
        events: entries
          .filter((entry): entry is Extract<Entry, { kind: 'event' }> => entry.kind === 'event')
          .map(entry => structuredClone(entry.payload)),
        preparing: entries
          .filter(
            (entry): entry is Extract<Entry, { kind: 'preparing' }> => entry.kind === 'preparing'
          )
          .map(entry => structuredClone(entry.payload)),
      };
    },
  };
}
