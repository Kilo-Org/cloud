import { dateTimeFormat } from '@/lib/intl-cache';

export type BriefingPeriodPreset = 'last24Hours' | 'today' | 'yesterday' | 'last7Days' | 'custom';
export type BriefingPeriod = { startAt: string; endAt: string };
export type BriefingWallTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function briefingWallTime(instant: number, timezone: string): BriefingWallTime {
  const parts = dateTimeFormat('en-US', {
    timeZone: timezone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find(item => item.type === type)?.value);
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
  };
}

function wallTimestamp(value: BriefingWallTime): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
}

export function briefingWallTimeToInstant(
  value: BriefingWallTime,
  timezone: string
): number | null {
  const wall = wallTimestamp(value);
  const offsets = new Set<number>();
  for (const delta of [-DAY_MS, 0, DAY_MS]) {
    const sample = wall + delta;
    offsets.add(wallTimestamp(briefingWallTime(sample, timezone)) - sample);
  }
  const matches = [...offsets]
    .map(offset => wall - offset)
    .filter(instant => wallTimestamp(briefingWallTime(instant, timezone)) === wall);
  return matches.length > 0 ? Math.min(...matches) : null;
}

function briefingDayStart(day: BriefingWallTime, timezone: string): number | null {
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const instant = briefingWallTimeToInstant(
      {
        ...day,
        hour: Math.floor(minute / 60),
        minute: minute % 60,
      },
      timezone
    );
    if (instant !== null) {
      return instant;
    }
  }
  return null;
}

export function briefingPeriodError(period: BriefingPeriod, now: number): string | null {
  const start = Date.parse(period.startAt);
  const end = Date.parse(period.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    return 'agentBriefing.invalidPeriod';
  }
  if (end > now) {
    return 'agentBriefing.futurePeriod';
  }
  return end - start > 31 * DAY_MS ? 'agentBriefing.periodTooLong' : null;
}

export function resolveBriefingPeriod({
  preset,
  timezone,
  custom,
  now,
}: {
  preset: BriefingPeriodPreset;
  timezone: string;
  custom: BriefingPeriod;
  now: number;
}): BriefingPeriod | null {
  if (preset === 'custom') {
    return custom;
  }
  if (preset === 'last24Hours' || preset === 'last7Days') {
    return {
      startAt: new Date(now - (preset === 'last24Hours' ? 1 : 7) * DAY_MS).toISOString(),
      endAt: new Date(now).toISOString(),
    };
  }
  const today = { ...briefingWallTime(now, timezone), hour: 0, minute: 0 };
  const midnight = briefingDayStart(today, timezone);
  if (midnight === null) {
    return null;
  }
  if (preset === 'today') {
    return { startAt: new Date(midnight).toISOString(), endAt: new Date(now).toISOString() };
  }
  const previous = new Date(Date.UTC(today.year, today.month - 1, today.day - 1));
  const yesterday = briefingDayStart(
    {
      year: previous.getUTCFullYear(),
      month: previous.getUTCMonth() + 1,
      day: previous.getUTCDate(),
      hour: 0,
      minute: 0,
    },
    timezone
  );
  return yesterday === null
    ? null
    : {
        startAt: new Date(yesterday).toISOString(),
        endAt: new Date(midnight).toISOString(),
      };
}
