import { briefingWindow, nextBriefingTime, validateBriefingSchedule } from './schedule';

const defaults = {
  timezone: 'Europe/Berlin',
  night_start: '22:00',
  morning_start: '08:00',
  morning_end: '12:00',
};
describe('briefing schedule', () => {
  it('keeps the shared cutoff and morning end through a fall DST change', () => {
    expect(briefingWindow(defaults, new Date('2026-10-24T20:00:00Z'))).toEqual({
      nightStartAt: '2026-10-24T20:00:00.000Z',
      cutoffAt: '2026-10-25T07:00:00.000Z',
      morningEndAt: '2026-10-25T11:00:00.000Z',
      localDate: '2026-10-25',
    });
  });
  it('keeps local morning times through spring DST', () => {
    expect(briefingWindow(defaults, new Date('2026-03-28T21:00:00Z')).cutoffAt).toBe(
      '2026-03-29T06:00:00.000Z'
    );
  });
  it('supports midnight and shift-work windows without overlapping a whole day', () => {
    expect(() => validateBriefingSchedule({ ...defaults, night_start: '00:00' })).not.toThrow();
    expect(() =>
      validateBriefingSchedule({
        ...defaults,
        night_start: '08:00',
        morning_start: '16:00',
        morning_end: '20:00',
      })
    ).not.toThrow();
    expect(() =>
      validateBriefingSchedule({ ...defaults, night_start: '08:00', morning_start: '08:00' })
    ).toThrow();
    expect(() => validateBriefingSchedule({ ...defaults, morning_end: '23:00' })).toThrow();
  });
  it('runs a repeated local time only once and keeps the next day distinct', () => {
    const first = nextBriefingTime('01:30', 'America/New_York', new Date('2026-11-01T04:00:00Z'));
    const second = nextBriefingTime('01:30', 'America/New_York', first);
    expect(first.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(second.toISOString()).toBe('2026-11-02T06:30:00.000Z');
  });
  it('advances nonexistent spring times within the same local morning', () => {
    expect(
      nextBriefingTime('02:30', 'America/New_York', new Date('2026-03-08T05:00:00Z')).toISOString()
    ).toBe('2026-03-08T07:30:00.000Z');
  });
});
