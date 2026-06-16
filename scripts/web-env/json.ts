export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonObject(json: string, operation: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${operation} returned invalid JSON. Provider output was redacted.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${operation} returned an unexpected response. Provider output was redacted.`);
  }
  return parsed;
}

export function parseJsonRecords(json: string, operation: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${operation} returned invalid JSON. Provider output was redacted.`);
  }
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
    throw new Error(`${operation} returned an unexpected response. Provider output was redacted.`);
  }
  return parsed;
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function readRecords(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown>[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}
