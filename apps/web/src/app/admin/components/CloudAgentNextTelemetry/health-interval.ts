type HealthRange = {
  durationMs: number;
};

type HealthInterval = {
  startDate: string;
  endDate: string;
};

export function rollingHealthInterval(range: HealthRange, now = new Date()): HealthInterval {
  return {
    startDate: new Date(now.getTime() - range.durationMs).toISOString(),
    endDate: now.toISOString(),
  };
}
