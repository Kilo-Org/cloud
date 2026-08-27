import type { HandlerSessionSnapshot } from './sandbox-control-handlers';
import { directoryForSession, rootForSession } from './session-directories';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function eventKiloSessionId(properties: Record<string, unknown>): string | undefined {
  if (typeof properties.sessionID === 'string') return properties.sessionID;
  if (typeof properties.sessionId === 'string') return properties.sessionId;
  if (isRecord(properties.info)) {
    if (typeof properties.info.sessionID === 'string') return properties.info.sessionID;
    if (typeof properties.info.id === 'string') return properties.info.id;
  }
  if (isRecord(properties.part) && typeof properties.part.sessionID === 'string') {
    return properties.part.sessionID;
  }
  return undefined;
}

export function childFromSessionCreated(
  properties: Record<string, unknown>
): { childId: string; parentId?: string; directory?: string } | undefined {
  if (!isRecord(properties.info) || typeof properties.info.id !== 'string') return undefined;
  return {
    childId: properties.info.id,
    ...(typeof properties.info.parentID === 'string' ? { parentId: properties.info.parentID } : {}),
    ...(typeof properties.info.directory === 'string'
      ? { directory: properties.info.directory }
      : {}),
  };
}

export function sessionEventIdentity(input: {
  sessionId?: string;
  directory?: string;
}): { directory: string; kiloSessionId?: string; rootKiloSessionId?: string } | undefined {
  const directory = input.directory ?? directoryForSession(input.sessionId);
  const root = rootForSession(input.sessionId, directory);
  if (!directory) return undefined;
  return {
    directory,
    ...(input.sessionId ? { kiloSessionId: input.sessionId } : {}),
    ...(root ? { rootKiloSessionId: root } : {}),
  };
}

export function updateSessionSnapshots(
  event: { type: string; properties: Record<string, unknown>; directory?: string },
  sessions: HandlerSessionSnapshot[]
): void {
  if (event.type !== 'session.status') return;
  const kiloSessionId = eventKiloSessionId(event.properties);
  if (!kiloSessionId || rootForSession(kiloSessionId, event.directory) !== kiloSessionId) return;
  const status = event.properties.status;
  if (!isRecord(status)) return;
  const state =
    status.type === 'idle'
      ? 'idle'
      : status.type === 'busy' || status.type === 'retry' || status.type === 'offline'
        ? 'active'
        : undefined;
  if (!state) return;
  const existing = sessions.find(session => session.kiloSessionId === kiloSessionId);
  if (existing) {
    existing.state = state;
    existing.idleForMs = 0;
    return;
  }
  sessions.push({ kiloSessionId, state, idleForMs: 0 });
}

export function permissionAskId(event: {
  type: string;
  properties: Record<string, unknown>;
}): string | undefined {
  if (event.type !== 'permission.asked') return undefined;
  return typeof event.properties.id === 'string' ? event.properties.id : undefined;
}

export async function* unfilteredKiloEvents(
  stream: AsyncIterable<unknown> | Iterable<unknown>
): AsyncGenerator<{ type: string; properties: Record<string, unknown>; directory?: string }> {
  for await (const envelope of stream) {
    if (!isRecord(envelope)) continue;
    const payload = envelope.payload;
    if (!isRecord(payload) || typeof payload.type !== 'string') continue;
    yield {
      type: payload.type,
      properties: isRecord(payload.properties) ? payload.properties : {},
      ...(typeof envelope.directory === 'string' ? { directory: envelope.directory } : {}),
    };
  }
}
