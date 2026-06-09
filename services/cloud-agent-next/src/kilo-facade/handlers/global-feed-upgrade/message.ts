import { isPublicCloudAgentExtensionSourceType } from '../../cloud-agent-extension-events.js';
import { isRecord } from '../../http-contract.js';
import { publicCloudAgentDirectory } from '../../public-sdk-projection.js';
import { sessionStatusUpdateFromEvent } from '../session-status/tracking.js';
import type { GlobalFeedSource } from './handler.js';

export type KiloEventPayload = Record<string, unknown> & {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
};

export type KiloGlobalEventEnvelope = Record<string, unknown> & {
  directory?: string;
  project?: unknown;
  workspace?: unknown;
  payload?: KiloEventPayload;
};

export type GlobalFeedMessageResult =
  | { kind: 'send-error'; error: string }
  | { kind: 'close'; code: number; reason: string }
  | { kind: 'drop' }
  | {
      kind: 'broadcast';
      event: KiloGlobalEventEnvelope;
      kiloSessionId: string;
      nextSource?: GlobalFeedSource;
    };

function isKiloEventPayload(value: unknown): value is KiloEventPayload {
  return isRecord(value) && typeof value.type === 'string' && isRecord(value.properties);
}

function isKiloGlobalEventEnvelope(value: unknown): value is KiloGlobalEventEnvelope {
  return isRecord(value) && isKiloEventPayload(value.payload);
}

function isSubstantiveKiloGlobalEventEnvelope(
  value: unknown
): value is KiloGlobalEventEnvelope & { directory: string; payload: KiloEventPayload } {
  return (
    isKiloGlobalEventEnvelope(value) &&
    typeof value.directory === 'string' &&
    value.directory.length > 0
  );
}

export function isSyntheticGlobalEvent(event: KiloGlobalEventEnvelope): boolean {
  const type = event.payload?.type;
  return type === 'server.connected' || type === 'server.heartbeat';
}

export function rewriteGlobalEventDirectory(
  event: KiloGlobalEventEnvelope,
  kiloSessionId: string
): KiloGlobalEventEnvelope {
  return { ...event, directory: publicCloudAgentDirectory(kiloSessionId) };
}

export function interpretGlobalFeedMessage(
  source: GlobalFeedSource | null,
  message: string | ArrayBuffer
): GlobalFeedMessageResult {
  if (typeof message !== 'string') {
    return { kind: 'send-error', error: 'Binary global feed messages are not supported' };
  }
  if (!source) return { kind: 'close', code: 1011, reason: 'Missing global feed source' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return { kind: 'send-error', error: 'Invalid global feed JSON' };
  }
  if (!isKiloGlobalEventEnvelope(parsed)) {
    return { kind: 'send-error', error: 'Invalid global event envelope' };
  }
  if (isSyntheticGlobalEvent(parsed)) return { kind: 'drop' };
  if (!isSubstantiveKiloGlobalEventEnvelope(parsed)) {
    return { kind: 'send-error', error: 'Invalid global event envelope' };
  }
  if (isPublicCloudAgentExtensionSourceType(parsed.payload.type)) return { kind: 'drop' };
  if (parsed.payload.properties.sessionID !== source.kiloSessionId) return { kind: 'drop' };

  const statusUpdate = sessionStatusUpdateFromEvent(parsed.payload, source.kiloSessionId);
  if (
    (parsed.payload.type === 'session.status' || parsed.payload.type === 'session.idle') &&
    !statusUpdate
  ) {
    return { kind: 'drop' };
  }
  let nextSource: GlobalFeedSource | undefined;
  if (statusUpdate) {
    nextSource = { ...source };
    if (statusUpdate.kind === 'set') nextSource.sessionStatus = statusUpdate.status;
    else delete nextSource.sessionStatus;
  }
  return {
    kind: 'broadcast',
    event: rewriteGlobalEventDirectory(parsed, source.kiloSessionId),
    kiloSessionId: source.kiloSessionId,
    ...(nextSource ? { nextSource } : {}),
  };
}
