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
  sessions: HandlerSessionSnapshot[],
  now = Date.now()
): void {
  const sessionId = eventKiloSessionId(event.properties);
  const kiloSessionId = rootForSession(sessionId, event.directory);
  if (!kiloSessionId || !sessionId) return;
  const snapshot = sessions.find(session => session.kiloSessionId === kiloSessionId);
  if (!snapshot) return;
  snapshot.lastActivityAt = now;
  if (event.type === 'question.asked' || event.type === 'permission.asked') {
    const id = event.properties.id;
    if (typeof id !== 'string') return;
    snapshot.pendingInputs ??= new Set();
    snapshot.pendingInputs.add(id);
  } else if (
    event.type === 'question.replied' ||
    event.type === 'question.rejected' ||
    event.type === 'permission.replied'
  ) {
    const id = event.properties.requestID;
    if (typeof id !== 'string') return;
    snapshot.pendingInputs?.delete(id);
    if (!snapshot.pendingInputs?.size) delete snapshot.pendingInputs;
  }
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
