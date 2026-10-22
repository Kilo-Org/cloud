import { isRecord, kiloEventSessionId } from '../../../src/shared/kilo-event.js';

export function eventKiloSessionId(properties: Record<string, unknown>): string | undefined {
  return kiloEventSessionId(properties);
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
