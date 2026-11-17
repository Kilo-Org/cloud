import { parseDbTimestamp } from './timestamps';

describe('parseDbTimestamp', () => {
  it('parses ISO timestamps with a Z offset', () => {
    expect(parseDbTimestamp('2026-02-01T12:00:00.000Z')?.toISOString()).toBe(
      '2026-02-01T12:00:00.000Z'
    );
  });

  it('parses Postgres timestamptz text with an hour offset', () => {
    expect(parseDbTimestamp('2026-02-01 12:00:00.000+00')?.toISOString()).toBe(
      '2026-02-01T12:00:00.000Z'
    );
    expect(parseDbTimestamp('2026-02-01 12:00:00.000+05')?.toISOString()).toBe(
      '2026-02-01T07:00:00.000Z'
    );
  });

  it('parses compact offsets', () => {
    expect(parseDbTimestamp('2026-02-01T12:00:00.000+0530')?.toISOString()).toBe(
      '2026-02-01T06:30:00.000Z'
    );
    expect(parseDbTimestamp('2026-02-01 12:00:00.000-0700')?.toISOString()).toBe(
      '2026-02-01T19:00:00.000Z'
    );
  });

  it('parses explicit colon offsets', () => {
    expect(parseDbTimestamp('2026-02-01T12:00:00.000+05:30')?.toISOString()).toBe(
      '2026-02-01T06:30:00.000Z'
    );
  });

  it('rejects timestamps without an offset', () => {
    expect(parseDbTimestamp('2026-02-01T12:00:00')).toBeNull();
    expect(parseDbTimestamp('2026-02-01 12:00:00')).toBeNull();
    expect(parseDbTimestamp('2026-02-01')).toBeNull();
  });

  it('returns null for missing or invalid input', () => {
    expect(parseDbTimestamp(null)).toBeNull();
    expect(parseDbTimestamp(undefined)).toBeNull();
    expect(parseDbTimestamp('')).toBeNull();
    expect(parseDbTimestamp('not-a-date')).toBeNull();
  });
});
