import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { formatSnapshotTime } from './snapshot-display';

const DateTimeFormat = Intl.DateTimeFormat;

afterEach(() => {
  jest.restoreAllMocks();
});

describe('formatSnapshotTime', () => {
  it.each([
    ['America/Los_Angeles', '24 Oct, 14:32'],
    ['Asia/Tokyo', '25 Oct, 06:32'],
  ])('uses the viewer timezone %s without year or seconds', (timeZone, expected) => {
    const formatter = jest
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation(
        (_locales, options) => new DateTimeFormat('en-GB', { ...options, timeZone })
      );
    expect(formatSnapshotTime(Date.parse('2026-10-24T21:32:19Z'))).toBe(expected);
    expect(formatter).toHaveBeenCalledWith(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  });
});
