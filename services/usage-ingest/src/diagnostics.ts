// Keep formatting, optional runtime metadata and log sinks outside delivery semantics.
export function logSafely(level: 'info' | 'warn', fields: () => object): void {
  try {
    console[level](JSON.stringify({ level, ...fields() }));
  } catch {
    // A diagnostic failure must not cause a second publication or change disposition.
  }
}

export function queueMetrics(value: unknown): object {
  try {
    if (!value || typeof value !== 'object' || !('metadata' in value)) return {};
    const metadata = value.metadata;
    if (!metadata || typeof metadata !== 'object' || !('metrics' in metadata)) return {};
    const metrics = metadata.metrics;
    if (!metrics || typeof metrics !== 'object') return {};
    const count = 'backlogCount' in metrics ? metrics.backlogCount : undefined;
    const bytes = 'backlogBytes' in metrics ? metrics.backlogBytes : undefined;
    const oldest = 'oldestMessageTimestamp' in metrics ? metrics.oldestMessageTimestamp : undefined;
    return {
      ...(typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
        ? { queue_backlog_count: count }
        : {}),
      ...(typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0
        ? { queue_backlog_bytes: bytes }
        : {}),
      ...(oldest instanceof Date && Number.isFinite(oldest.getTime())
        ? { queue_oldest_message_at_ms: oldest.getTime() }
        : {}),
    };
  } catch {
    return {};
  }
}
