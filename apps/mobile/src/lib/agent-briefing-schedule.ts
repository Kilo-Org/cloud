import { dateTimeFormat } from '@/lib/intl-cache';

/** A schedule the briefing settings screen can save. */
export type BriefingScheduleDraft = {
  timezone: string;
  nightStart: string;
  morningStart: string;
  morningEnd: string;
};

/** Which parts of a draft the server would refuse. */
export type BriefingScheduleProblems = { timezone: boolean; times: boolean };

const WALL_CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Whether the runtime can format an instant in this zone. The server validates
 * the same IANA name, so a zone the device's own `Intl` data does not know is a
 * zone the schedule cannot promise to follow.
 */
function briefingTimezoneValid(timezone: string): boolean {
  try {
    dateTimeFormat('en', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * The night runs from `nightStart` to `morningStart` and the morning from
 * `morningStart` to `morningEnd`, so the two periods must both be non-empty and
 * together cover less than a full day.
 */
function briefingTimesValid({
  nightStart,
  morningStart,
  morningEnd,
}: BriefingScheduleDraft): boolean {
  if (![nightStart, morningStart, morningEnd].every(time => WALL_CLOCK_RE.test(time))) {
    return false;
  }
  if (nightStart === morningStart || morningStart === morningEnd) {
    return false;
  }
  const [night, morning, end] = [nightStart, morningStart, morningEnd].map(
    time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
  );
  return (
    night !== undefined &&
    morning !== undefined &&
    end !== undefined &&
    ((morning - night + 1440) % 1440) + ((end - morning + 1440) % 1440) < 1440
  );
}

export function briefingScheduleProblems(draft: BriefingScheduleDraft): BriefingScheduleProblems {
  return {
    timezone: !briefingTimezoneValid(draft.timezone),
    times: !briefingTimesValid(draft),
  };
}

/**
 * The value the time picker opens on for a stored `HH:mm`.
 *
 * The picker reports and reads the wall clock of the device's own time zone, so
 * the date is built from local components and read back with the local getters.
 * Encoding either side in UTC would shift every hour by the device's offset.
 */
export function briefingPickerDate(time: string): Date {
  return new Date(2000, 0, 1, Number(time.slice(0, 2)), Number(time.slice(3)));
}

/** The `HH:mm` the picker chose, read in the same local frame as `briefingPickerDate`. */
export function briefingPickerTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
