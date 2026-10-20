import { Cron } from 'croner';

export type BriefingSchedule = {
  timezone: string;
  night_start: string;
  morning_start: string;
  morning_end: string;
};
export type BriefingWindow = {
  nightStartAt: string;
  cutoffAt: string;
  morningEndAt: string;
  localDate: string;
};
export function validateBriefingSchedule(schedule: BriefingSchedule): void {
  new Intl.DateTimeFormat('en', { timeZone: schedule.timezone }).format();
  const minutes = (value: string) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Invalid schedule time');
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
  };
  const night = minutes(schedule.night_start);
  const morning = minutes(schedule.morning_start);
  const end = minutes(schedule.morning_end);
  const nightDuration = (morning - night + 1440) % 1440;
  const morningDuration = (end - morning + 1440) % 1440;
  if (nightDuration <= 0 || morningDuration <= 0 || nightDuration + morningDuration >= 1440)
    throw new Error('Night and morning windows must be nonempty and not overlap');
}
export function nextBriefingTime(time: string, timezone: string, after: Date): Date {
  const [hour, minute] = time.split(':').map(Number);
  const next = new Cron(`${minute} ${hour} * * *`, { timezone, paused: true }).nextRun(after);
  if (!next) throw new Error('No next briefing time');
  return next;
}
export function briefingWindow(schedule: BriefingSchedule, nightStart: Date): BriefingWindow {
  validateBriefingSchedule(schedule);
  const cutoff = nextBriefingTime(schedule.morning_start, schedule.timezone, nightStart);
  const end = nextBriefingTime(schedule.morning_end, schedule.timezone, cutoff);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: schedule.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(cutoff);
  const part = (type: string) => parts.find(value => value.type === type)?.value ?? '';
  return {
    nightStartAt: nightStart.toISOString(),
    cutoffAt: cutoff.toISOString(),
    morningEndAt: end.toISOString(),
    localDate: `${part('year')}-${part('month')}-${part('day')}`,
  };
}
