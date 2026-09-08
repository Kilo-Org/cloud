export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function kiloEventSessionId(properties: Record<string, unknown>): string | undefined {
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
