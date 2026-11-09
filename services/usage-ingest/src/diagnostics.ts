// Keep formatting, optional runtime metadata and log sinks outside delivery semantics.
export function logSafely(level: 'info' | 'warn', fields: () => object): void {
  try {
    console[level](JSON.stringify({ level, ...fields() }));
  } catch {
    // A diagnostic failure must not cause a second publication or change disposition.
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function queueMetrics(value: unknown): object {
  try {
    const metrics = record(record(record(value)?.metadata)?.metrics);
    if (!metrics) return {};
    const count = nonNegativeInteger(metrics.backlogCount);
    const bytes = nonNegativeInteger(metrics.backlogBytes);
    const oldest = metrics.oldestMessageTimestamp;
    return {
      ...(count === undefined ? {} : { queue_backlog_count: count }),
      ...(bytes === undefined ? {} : { queue_backlog_bytes: bytes }),
      ...(oldest instanceof Date && Number.isFinite(oldest.getTime())
        ? { queue_oldest_message_at_ms: oldest.getTime() }
        : {}),
    };
  } catch {
    return {};
  }
}
