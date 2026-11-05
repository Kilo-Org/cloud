export function parseUsageQueueSfoExposure(value: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return 0;
  const exposure = Number(value);
  return Number.isFinite(exposure) && exposure >= 0 && exposure <= 1 ? exposure : 0;
}

export type UsageQueueSfoConfig = {
  enabled: boolean;
  exposure: number;
};

export type UsageQueueFraConfig = {
  enabled: boolean;
};
