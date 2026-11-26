/**
 * Canonical JSON: object keys sorted with no insignificant whitespace. The audit chain hash and
 * the checkpoint signature are stable only while every writer and verifier serialises alike, so
 * this function is the single definition and must not change without a chain migration.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, item]) => item !== undefined
    );
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const fields = entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${fields.join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
}
