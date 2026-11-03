export function parseUsageQueueSfoExposure(value: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return 0;
  const exposure = Number(value);
  return Number.isFinite(exposure) && exposure >= 0 && exposure <= 1 ? exposure : 0;
}

export const parseUsageQueueFraExposure = parseUsageQueueSfoExposure;

export function parseUsageQueueSfoUserIds(value: string): ReadonlySet<string> | null {
  if (!value) return null;
  try {
    const ids: unknown = JSON.parse(value);
    if (Array.isArray(ids) && ids.every(id => typeof id === 'string' && id.length > 0)) {
      return new Set<string>(ids);
    }
  } catch {
    // Invalid cohort configuration selects nobody.
  }
  return new Set();
}

export type UsageQueueSfoConfig = {
  enabled: boolean;
  exposure: number;
  userIds: ReadonlySet<string> | null;
};

export type UsageQueueFraConfig = {
  enabled: boolean;
  exposure: number;
};
