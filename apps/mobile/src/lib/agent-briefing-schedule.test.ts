import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  briefingPickerDate,
  briefingPickerTime,
  briefingScheduleProblems,
} from './agent-briefing-schedule';

afterEach(() => vi.unstubAllEnvs());

describe('briefingPickerDate and briefingPickerTime', () => {
  it('round-trips every hour of the day in a time zone behind UTC', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    for (let hour = 0; hour < 24; hour += 1) {
      const time = `${String(hour).padStart(2, '0')}:30`;
      const pickerValue = briefingPickerDate(time);
      // The picker opens on the hour the row shows, not on its UTC equivalent.
      expect(pickerValue.getHours()).toBe(hour);
      expect(pickerValue.getMinutes()).toBe(30);
      expect(briefingPickerTime(pickerValue)).toBe(time);
    }
  });

  it('keeps the hour in a time zone ahead of UTC with a half-hour offset', () => {
    vi.stubEnv('TZ', 'Asia/Kolkata');
    expect(briefingPickerDate('23:00').getHours()).toBe(23);
    expect(briefingPickerTime(new Date(2000, 0, 1, 22, 5))).toBe('22:05');
  });

  it('keeps the chosen hour across a device time zone change at the same instant', () => {
    vi.stubEnv('TZ', 'Europe/Berlin');
    const picked = briefingPickerTime(briefingPickerDate('07:45'));
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(picked).toBe('07:45');
  });
});

describe('briefingScheduleProblems', () => {
  const valid = {
    timezone: 'America/Los_Angeles',
    nightStart: '23:00',
    morningStart: '08:00',
    morningEnd: '12:00',
  };

  it('accepts a schedule the server accepts', () => {
    expect(briefingScheduleProblems(valid)).toEqual({ timezone: false, times: false });
  });

  it('flags an unknown time zone and keeps the periods valid', () => {
    expect(briefingScheduleProblems({ ...valid, timezone: 'Mitteleuropa/Berlin' })).toEqual({
      timezone: true,
      times: false,
    });
  });

  it('flags a malformed wall clock', () => {
    expect(briefingScheduleProblems({ ...valid, nightStart: '7:00' }).times).toBe(true);
  });

  it('flags empty periods', () => {
    expect(
      briefingScheduleProblems({ ...valid, nightStart: '23:00', morningStart: '23:00' })
    ).toEqual({ timezone: false, times: true });
  });

  it('flags periods that overlap into a full day or more', () => {
    expect(
      briefingScheduleProblems({
        ...valid,
        nightStart: '08:00',
        morningStart: '06:00',
        morningEnd: '09:00',
      }).times
    ).toBe(true);
  });
});
