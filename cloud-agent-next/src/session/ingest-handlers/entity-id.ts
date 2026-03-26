/**
 * Extract an entity ID for upsert from a kilocode event.
 *
 * - `message.updated` → `message/{info.id}`
 * - `message.part.updated` → `part/{part.messageID}/{part.id}`
 * - Everything else → `null` (plain insert, no upsert)
 */
export function extractEntityId(eventName: string, data: Record<string, unknown>): string | null {
  const props = data.properties as Record<string, unknown> | undefined;
  if (!props) return null;

  if (eventName === 'message.updated') {
    const info = props.info as Record<string, unknown> | undefined;
    const id = info?.id;
    if (typeof id === 'string') return `message/${id}`;
    return null;
  }

  if (eventName === 'message.part.updated') {
    const part = props.part as Record<string, unknown> | undefined;
    const messageID = part?.messageID;
    const partId = part?.id;
    if (typeof messageID === 'string' && typeof partId === 'string') {
      return `part/${messageID}/${partId}`;
    }
    return null;
  }

  return null;
}
