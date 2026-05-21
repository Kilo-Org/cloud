import {
  cleanVersion,
  calverAtLeast,
  controllerCalverSupports,
  getRunningVersionBadge,
} from './version';

describe('cleanVersion', () => {
  // Null / undefined / empty
  it('returns null for null', () => expect(cleanVersion(null)).toBeNull());
  it('returns null for undefined', () => expect(cleanVersion(undefined)).toBeNull());
  it('returns null for empty string', () => expect(cleanVersion('')).toBeNull());

  // Plain calver (new controller output)
  it('passes through a bare calver', () => expect(cleanVersion('2026.3.8')).toBe('2026.3.8'));
  it('passes through a bare date+time calver', () =>
    expect(cleanVersion('2026.3.8.1430')).toBe('2026.3.8.1430'));

  // Surrounding quotes (bun build --define)
  it('strips double quotes', () => expect(cleanVersion('"2026.3.8"')).toBe('2026.3.8'));
  it('strips single quotes', () => expect(cleanVersion("'2026.3.8'")).toBe('2026.3.8'));
  it('strips quotes around date+time calver', () =>
    expect(cleanVersion('"2026.3.8.1430"')).toBe('2026.3.8.1430'));

  // Full openclaw --version output (older controllers)
  it('extracts calver from "OpenClaw 2026.3.8 (3caab92)"', () =>
    expect(cleanVersion('OpenClaw 2026.3.8 (3caab92)')).toBe('2026.3.8'));
  it('extracts calver from "OpenClaw 2026.3.8" without hash', () =>
    expect(cleanVersion('OpenClaw 2026.3.8')).toBe('2026.3.8'));
  it('extracts calver from quoted full string', () =>
    expect(cleanVersion('"OpenClaw 2026.3.8 (abc1234)"')).toBe('2026.3.8'));
  it('extracts date+time calver from prefixed strings', () =>
    expect(cleanVersion('Controller 2026.3.8.1430 (abc1234)')).toBe('2026.3.8.1430'));

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
  it('returns true when date+time calver is equal', () =>
    expect(calverAtLeast('2026.2.26.1430', '2026.2.26.1430')).toBe(true));
  it('returns true when greater (patch)', () =>
    expect(calverAtLeast('2026.2.27', '2026.2.26')).toBe(true));
  it('returns true when greater (time)', () =>
    expect(calverAtLeast('2026.2.26.1431', '2026.2.26.1430')).toBe(true));
  it('treats missing time segment as 0', () =>
    expect(calverAtLeast('2026.2.26.0001', '2026.2.26')).toBe(true));
  it('returns true when greater (minor)', () =>
    expect(calverAtLeast('2026.3.1', '2026.2.26')).toBe(true));
  it('returns true when greater (major)', () =>
    expect(calverAtLeast('2027.1.1', '2026.2.26')).toBe(true));

  it('returns false when less (patch)', () =>
    expect(calverAtLeast('2026.2.25', '2026.2.26')).toBe(false));
  it('returns false when less (time)', () =>
    expect(calverAtLeast('2026.2.26.1429', '2026.2.26.1430')).toBe(false));
  it('treats missing version time segment as 0', () =>
    expect(calverAtLeast('2026.2.26', '2026.2.26.0001')).toBe(false));
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

describe('controllerCalverSupports', () => {
  // Explicit `null` is the worker's positive old-controller signal — gate OFF.
  it('returns false for null (worker old-controller signal)', () =>
    expect(controllerCalverSupports(null, '2026.5.12')).toBe(false));

  // Fails OPEN — genuinely unknown / unparseable input is treated as supported.
  it('returns true for undefined', () =>
    expect(controllerCalverSupports(undefined, '2026.5.12')).toBe(true));
  it('returns true for empty string', () =>
    expect(controllerCalverSupports('', '2026.5.12')).toBe(true));
  it('returns true for a non-calver string (e.g. dev build)', () =>
    expect(controllerCalverSupports('dev', '2026.5.12')).toBe(true));
  it('returns true for a malformed version', () =>
    expect(controllerCalverSupports('abc.def.ghi', '2026.5.12')).toBe(true));

  // Parseable versions still gate normally.
  it('returns true when the version is newer', () =>
    expect(controllerCalverSupports('2026.5.20.0900', '2026.5.12')).toBe(true));
  it('returns true when the version equals the minimum', () =>
    expect(controllerCalverSupports('2026.5.12', '2026.5.12')).toBe(true));
  it('returns false only when the version is positively parsed as older', () =>
    expect(controllerCalverSupports('2026.5.11.2359', '2026.5.12')).toBe(false));
  it('handles quoted / prefixed version strings', () =>
    expect(controllerCalverSupports('"2026.5.20.0900"', '2026.5.12')).toBe(true));
});

describe('getRunningVersionBadge', () => {
  // No data
  it('returns null when running version is null', () =>
    expect(getRunningVersionBadge(null, '2026.3.8')).toBeNull());
  it('returns null when image version is null', () =>
    expect(getRunningVersionBadge('2026.3.8', null)).toBeNull());
  it('returns null when both are null', () =>
    expect(getRunningVersionBadge(null, null)).toBeNull());

  // Versions match — no badge needed
  it('returns null when running equals image', () =>
    expect(getRunningVersionBadge('2026.3.8', '2026.3.8')).toBeNull());

  // Any difference means user self-updated on-machine
  it('returns modified when running is newer (patch)', () =>
    expect(getRunningVersionBadge('2026.3.9', '2026.3.8')).toBe('modified'));
  it('returns modified when running is newer (minor)', () =>
    expect(getRunningVersionBadge('2026.4.1', '2026.3.8')).toBe('modified'));
  it('returns modified when running is older (patch)', () =>
    expect(getRunningVersionBadge('2026.3.7', '2026.3.8')).toBe('modified'));
  it('returns modified when running is older (minor)', () =>
    expect(getRunningVersionBadge('2026.2.1', '2026.3.8')).toBe('modified'));
  it('returns modified for non-calver strings that differ', () =>
    expect(getRunningVersionBadge('custom-build', 'release-build')).toBe('modified'));

  // Version string normalisation works end-to-end
  it('handles quoted version strings', () =>
    expect(getRunningVersionBadge('"2026.3.9"', '2026.3.8')).toBe('modified'));
  it('handles full openclaw --version output', () =>
    expect(getRunningVersionBadge('OpenClaw 2026.3.9 (abc1234)', '2026.3.8')).toBe('modified'));
});
