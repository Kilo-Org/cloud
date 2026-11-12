export type ComputeRunTime = {
  startedAt: string;
  stoppedAt: string | null;
  running: boolean;
};

export function computeInstanceLabel(instance: 'standard-3' | 'standard-4'): string {
  return instance === 'standard-3' ? 'Medium' : 'Large';
}

export function formatComputeDuration(seconds: number): string {
  if (seconds > 0 && seconds < 60) return '<1 min';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Omits the date for runs that happened entirely on the current day. */
export function formatComputeRunTime(run: ComputeRunTime, now: Date, timeZone?: string): string {
  const start = new Date(run.startedAt);
  const end = run.running || run.stoppedAt === null ? null : new Date(run.stoppedAt);
  const day = new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeZone });
  const today = day.format(now);
  const onlyToday = day.format(start) === today && (end === null || day.format(end) === today);
  const format = new Intl.DateTimeFormat('en-US', {
    ...(onlyToday ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
  return end === null ? `${format.format(start)} – now` : format.formatRange(start, end);
}
