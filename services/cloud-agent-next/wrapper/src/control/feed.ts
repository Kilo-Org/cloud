import type { SessionEventIdentity } from '../../../src/shared/sandbox-control-protocol.js';
import type { HandlerSessionSnapshot } from './sandbox-control-handlers';
import { directoryForSession, rememberChildSession, rootForSession } from './session-directories';

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
): { childId: string; parentId: string; directory?: string } | undefined {
  if (
    !isRecord(properties.info) ||
    typeof properties.info.id !== 'string' ||
    typeof properties.info.parentID !== 'string'
  )
    return undefined;
  return {
    childId: properties.info.id,
    parentId: properties.info.parentID,
    ...(typeof properties.info.directory === 'string'
      ? { directory: properties.info.directory }
      : {}),
  };
}

export function sessionEventIdentity(input: {
  sessionId?: string;
  directory?: string;
  runtimeDirectory?: string;
  nativeRuntimeId?: string;
  type?: string;
  properties?: Record<string, unknown>;
}): SessionEventIdentity | undefined {
  let directory = input.directory;
  if ((input.type === 'session.created' || input.type === 'session.updated') && input.properties) {
    const info = input.properties.info;
    if (isRecord(info) && typeof info.directory === 'string') {
      if (directory !== undefined && directory !== info.directory) return undefined;
      directory = info.directory;
    }
    const child = childFromSessionCreated(input.properties);
    if (child) {
      if (child.childId !== input.sessionId) return undefined;
      const parentRoot = rootForSession(child.parentId);
      if (!parentRoot) return undefined;
      if (
        input.runtimeDirectory !== undefined &&
        directoryForSession(parentRoot) !== input.runtimeDirectory
      )
        return undefined;
      rememberChildSession({ ...child, directory });
      if (rootForSession(child.childId) !== parentRoot) return undefined;
    }
  }
  directory ??= directoryForSession(input.sessionId);
  const root = rootForSession(input.sessionId, directory);
  if (!directory || !root) return undefined;
  if (input.runtimeDirectory !== undefined && directoryForSession(root) !== input.runtimeDirectory)
    return undefined;
  return {
    directory,
    ...(input.sessionId ? { kiloSessionId: input.sessionId } : {}),
    rootKiloSessionId: root,
    ...(input.nativeRuntimeId !== undefined ? { nativeRuntimeId: input.nativeRuntimeId } : {}),
  };
}

export function updateSessionSnapshots(
  event: { type: string; properties: Record<string, unknown>; directory?: string },
  sessions: HandlerSessionSnapshot[],
  now = Date.now()
): void {
  const sessionId = eventKiloSessionId(event.properties);
  if (!sessionId) return;
  const kiloSessionId = sessionEventIdentity({ ...event, sessionId })?.rootKiloSessionId;
  if (!kiloSessionId) return;
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
