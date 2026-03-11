import { cleanVersion, calverAtLeast } from './version';

describe('cleanVersion', () => {
  // Null / undefined / empty
  it('returns null for null', () => expect(cleanVersion(null)).toBeNull());
  it('returns null for undefined', () => expect(cleanVersion(undefined)).toBeNull());
  it('returns null for empty string', () => expect(cleanVersion('')).toBeNull());

  // Plain calver (new controller output)
  it('passes through a bare calver', () => expect(cleanVersion('2026.3.8')).toBe('2026.3.8'));

  // Surrounding quotes (bun build --define)
  it('strips double quotes', () => expect(cleanVersion('"2026.3.8"')).toBe('2026.3.8'));
  it('strips single quotes', () => expect(cleanVersion("'2026.3.8'")).toBe('2026.3.8'));

  // Full openclaw --version output (older controllers)
  it('extracts calver from "OpenClaw 2026.3.8 (3caab92)"', () =>
    expect(cleanVersion('OpenClaw 2026.3.8 (3caab92)')).toBe('2026.3.8'));
  it('extracts calver from "OpenClaw 2026.3.8" without hash', () =>
    expect(cleanVersion('OpenClaw 2026.3.8')).toBe('2026.3.8'));
  it('extracts calver from quoted full string', () =>
    expect(cleanVersion('"OpenClaw 2026.3.8 (abc1234)"')).toBe('2026.3.8'));

  // No calver found — returns raw string as fallback
  it('returns raw string when no calver pattern matches', () =>
    expect(cleanVersion('unknown')).toBe('unknown'));
  it('returns null for whitespace-only after quote stripping', () =>
    expect(cleanVersion('""')).toBeNull());

  // :latest sentinel (used by hasVersionInfo check)
  it('passes through :latest unchanged', () => expect(cleanVersion(':latest')).toBe(':latest'));
});

describe('calverAtLeast', () => {
  it('returns false for null', () => expect(calverAtLeast(null, '2026.1.1')).toBe(false));
  it('returns false for undefined', () => expect(calverAtLeast(undefined, '2026.1.1')).toBe(false));
  it('returns false for empty string', () => expect(calverAtLeast('', '2026.1.1')).toBe(false));

  it('returns true when equal', () => expect(calverAtLeast('2026.2.26', '2026.2.26')).toBe(true));
  it('returns true when greater (patch)', () =>
    expect(calverAtLeast('2026.2.27', '2026.2.26')).toBe(true));
  it('returns true when greater (minor)', () =>
    expect(calverAtLeast('2026.3.1', '2026.2.26')).toBe(true));
  it('returns true when greater (major)', () =>
    expect(calverAtLeast('2027.1.1', '2026.2.26')).toBe(true));

  it('returns false when less (patch)', () =>
    expect(calverAtLeast('2026.2.25', '2026.2.26')).toBe(false));
  it('returns false when less (minor)', () =>
    expect(calverAtLeast('2026.1.30', '2026.2.26')).toBe(false));
  it('returns false when less (major)', () =>
    expect(calverAtLeast('2025.12.31', '2026.2.26')).toBe(false));

  // Malformed input — fails closed
  it('returns false for non-numeric version', () =>
    expect(calverAtLeast('abc.def.ghi', '2026.1.1')).toBe(false));
  it('returns false for non-numeric minVersion segment', () =>
    expect(calverAtLeast('2026.1.1', 'abc.1.1')).toBe(false));
});
