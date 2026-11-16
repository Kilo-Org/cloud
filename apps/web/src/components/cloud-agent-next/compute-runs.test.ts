import { describe, expect, it } from '@jest/globals';
import { formatComputeDuration, formatComputeRunTime } from './compute-runs';

const now = new Date('2026-11-12T18:00:00.000Z');
const normalize = (text: string) => text.replace(/[\u2009\u202f]/g, ' ');

describe('formatComputeDuration', () => {
  it.each([
    [0, '0 min'],
    [20, '<1 min'],
    [89, '1 min'],
    [3120, '52 min'],
    [3600, '1 h'],
    [3900, '1 h 5 min'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(formatComputeDuration(seconds)).toBe(expected);
  });
});

describe('formatComputeRunTime', () => {
  it('omits the date for a run that started and stopped today', () => {
    const text = formatComputeRunTime(
      {
        startedAt: '2026-11-12T13:00:00.000Z',
        stoppedAt: '2026-11-12T13:52:00.000Z',
        running: false,
      },
      now,
      'UTC'
    );
    expect(normalize(text)).toBe('1:00 – 1:52 PM');
  });

  it('shows a running run as ending now', () => {
    const text = formatComputeRunTime(
      { startedAt: '2026-11-12T15:10:00.000Z', stoppedAt: null, running: true },
      now,
      'UTC'
    );
    expect(normalize(text)).toBe('3:10 PM – now');
  });

  it('includes the date for earlier days and for runs that cross midnight', () => {
    expect(
      normalize(
        formatComputeRunTime(
          {
            startedAt: '2026-11-10T13:00:00.000Z',
            stoppedAt: '2026-11-10T13:52:00.000Z',
            running: false,
          },
          now,
          'UTC'
        )
      )
    ).toBe('Nov 10, 1:00 – 1:52 PM');
    expect(
      normalize(
        formatComputeRunTime(
          {
            startedAt: '2026-11-11T23:30:00.000Z',
            stoppedAt: '2026-11-12T00:10:00.000Z',
            running: false,
          },
          now,
          'UTC'
        )
      )
    ).toBe('Nov 11, 11:30 PM – Nov 12, 12:10 AM');
  });

  it('uses the viewer time zone to decide which day a run belongs to', () => {
    const run = {
      startedAt: '2026-11-12T03:00:00.000Z',
      stoppedAt: '2026-11-12T03:30:00.000Z',
      running: false,
    };
    expect(normalize(formatComputeRunTime(run, now, 'UTC'))).toBe('3:00 – 3:30 AM');
    expect(normalize(formatComputeRunTime(run, now, 'America/Los_Angeles'))).toBe(
      'Nov 11, 7:00 – 7:30 PM'
    );
  });
});
