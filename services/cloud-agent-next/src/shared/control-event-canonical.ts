export function canonicalizeControlEvent(value: unknown): unknown {
  const ancestors = new Set<object>();

  const normalize = (current: unknown, arrayItem = false): unknown => {
    if (current === undefined) return arrayItem ? null : undefined;
    if (current === null || typeof current === 'string' || typeof current === 'boolean')
      return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('Control event contains an invalid number');
      return current;
    }
    if (Array.isArray(current)) return current.map(item => normalize(item, true));
    if (typeof current !== 'object') throw new Error('Control event contains an unsupported value');
    if (ancestors.has(current)) throw new Error('Control event contains a cycle');
    ancestors.add(current);
    try {
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(current).sort()) {
        const item = normalize((current as Record<string, unknown>)[key]);
        if (item !== undefined) normalized[key] = item;
      }
      return normalized;
    } finally {
      ancestors.delete(current);
    }
  };

  const normalized = normalize(value);
  if (normalized === undefined) throw new Error('Control event contains an unsupported value');
  return normalized;
}

export function canonicalControlEventJson(value: unknown): string {
  return JSON.stringify(canonicalizeControlEvent(value));
}
