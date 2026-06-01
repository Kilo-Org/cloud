export type HealthBucket = 'hour' | 'day';

type HealthRange = {
  durationMs: number;
  bucket: HealthBucket;
};

type HealthInterval = {
  startDate: string;
  endDate: string;
  bucket: HealthBucket;
};

export function rollingHealthInterval(range: HealthRange, now = new Date()): HealthInterval {
  return {
    startDate: new Date(now.getTime() - range.durationMs).toISOString(),
    endDate: now.toISOString(),
    bucket: range.bucket,
  };
}
