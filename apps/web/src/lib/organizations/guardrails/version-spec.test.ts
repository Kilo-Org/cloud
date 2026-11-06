import { lt } from 'semver';
import {
  checkVersion,
  classifyLegacyMinVersion,
  isValidVersionSpec,
  legacyMinVersionToSpec,
  MAX_SEMVER_LENGTH,
  minimumVersionForSpec,
  normalizeVersionSpec,
  resolvePackageVersion,
} from './version-spec';

describe('normalizeVersionSpec', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['   ', null],
    ['^1.2.0', '^1.2.0'],
    ['^1.2.0 || >=2.0.3', '^1.2.0 || >=2.0.3'],
    ['>= 2.0.3', '>= 2.0.3'],
    ['1.2.3', '1.2.3'],
    ['1.2.3 - 2.3.4', '1.2.3 - 2.3.4'],
    ['1.2.0rc1', '1.2.0rc1'],
    ['*', '*'],
    ['>=1.0.0-rc.1 <1.0.0', '>=1.0.0-rc.1 <1.0.0'],
  ])('accepts %j', (input, expected) => {
    expect(normalizeVersionSpec(input)).toEqual({ ok: true, value: expected });
  });

  it.each(['latest', 'next', 'beta', '^1.2.0 | >=2.0.3', '1.2.0.post1', 'not a version'])(
    'rejects the tag or malformed range %j',
    input => {
      expect(normalizeVersionSpec(input).ok).toBe(false);
    }
  );

  it.each(['>=5.0.0 ||', '|| >=5.0.0', '||', '^1.2.0 ||  || >=2.0.3'])(
    'rejects an empty || alternative in %j, which would match every version',
    input => {
      expect(normalizeVersionSpec(input)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('Each || alternative'),
      });
    }
  );

  it('rejects comma-separated comparators, which loose parsing would drop', () => {
    expect(normalizeVersionSpec('>=1.0.0, <2.0.0')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not commas'),
    });
  });

  it.each(['>=1.0.0 garbage', '>=1.0.0 and <2.0.0', '>=1.0.0 && <2.0.0'])(
    'rejects %j instead of silently dropping the unknown token',
    input => {
      expect(normalizeVersionSpec(input).ok).toBe(false);
    }
  );

  it.each(['x', '>=0.0.0'])('rejects %j, which allows every version', input => {
    expect(normalizeVersionSpec(input)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('allows every version'),
    });
  });

  it('rejects a valid range that is too long', () => {
    const longRange = Array.from({ length: 40 }, (_, index) => `>=1.0.${index}`).join(' || ');
    expect(longRange.length).toBeGreaterThan(MAX_SEMVER_LENGTH);
    expect(normalizeVersionSpec(longRange)).toMatchObject({ ok: false });
  });
});

describe('resolvePackageVersion', () => {
  it.each([
    ['npm', '1.2.3', '1.2.3'],
    ['npm', 'v1.2.3', '1.2.3'],
    ['npm', '1.2.0rc1', '1.2.0-rc1'],
    ['npm', '1.2.0-rc.1', '1.2.0-rc.1'],
    ['npm', '1.2.3-1', '1.2.3-1'],
    ['npm', '1.2.3+build.5', '1.2.3'],
    ['npm', '1.2', null],
    ['npm', '1.2.3.post1', null],
    ['pypi', '1.2', '1.2.0'],
    ['pypi', '2024.1', '2024.1.0'],
    ['pypi', '1.2.3.post1', '1.2.3'],
    ['pypi', '1.2.3.0', '1.2.3'],
    ['pypi', '1.2.3.4', '1.2.4-0.4'],
    ['pypi', '1.2.3.4rc1', null],
    ['pypi', '1.2.3.dev1', '1.2.3-0.dev.1'],
    ['pypi', '1.2.3.dev01', '1.2.3-0.dev.1'],
    ['pypi', '1.2.3rc1', '1.2.3-rc.1'],
    ['pypi', '1!2.0.0', null],
    ['pypi', 'latest', null],
    ['pypi', '^1.2.0', null],
  ] as const)('resolves %s %j', (ecosystem, input, expected) => {
    expect(resolvePackageVersion(input, ecosystem)).toBe(expected);
  });
});

it('orders a PyPI dev release before its pre-releases', () => {
  const dev = resolvePackageVersion('1.2.3.dev1', 'pypi');
  const alpha = resolvePackageVersion('1.2.3a1', 'pypi');
  expect(dev !== null && alpha !== null && lt(dev, alpha)).toBe(true);
});

it('orders a four-part PyPI release between its neighbours', () => {
  const fourPart = resolvePackageVersion('1.2.3.4', 'pypi');
  expect(fourPart !== null && lt('1.2.3', fourPart) && lt(fourPart, '1.2.4')).toBe(true);
});

describe('legacyMinVersionToSpec', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['   ', null],
    ['1.2.3', '>=1.2.3'],
    [' 2025.1.0 ', '>=2025.1.0'],
    ['1.2.0rc1', '>=1.2.0-rc.1'],
    ['1.2.0.post1', '>=1.2.0'],
    ['1.2.0.dev1', '>=1.2.0-0.dev.1'],
    ['1.2.3.4', '>=1.2.4-0.4'],
    ['1.2.3_4', '>=1.2.3'],
    ['1.2.3!', '>=1.2.3'],
    ['v1.2.3', '>=1.2.3'],
    ['latest', null],
  ])('converts %j', (input, expected) => {
    expect(legacyMinVersionToSpec(input)).toBe(expected);
  });
});

describe('classifyLegacyMinVersion', () => {
  it.each([
    [undefined, { kind: 'none' }],
    ['', { kind: 'none' }],
    ['0', { kind: 'any' }],
    ['0.0', { kind: 'any' }],
    ['0.0.0', { kind: 'any' }],
    ['0.0.0.0', { kind: 'any' }],
    ['1.2.3', { kind: 'range', value: '>=1.2.3' }],
    ['1.2.3.4', { kind: 'range', value: '>=1.2.4-0.4' }],
    ['0.0.0-rc.1', { kind: 'range', value: '>=0.0.0-rc.1' }],
    ['latest', { kind: 'invalid' }],
    ['99999999999999999999', { kind: 'invalid' }],
  ])('classifies %j', (input, expected) => {
    expect(classifyLegacyMinVersion(input)).toEqual(expected);
  });
});

describe('isValidVersionSpec', () => {
  it.each([
    ['>=1.2.3', true],
    ['^1.2.0 || >=2.0.3', true],
    ['>=0.0.0', false],
    ['>=5.0.0 ||', false],
    ['not a range', false],
  ])('%j -> %s', (spec, expected) => {
    expect(isValidVersionSpec(spec)).toBe(expected);
  });
});

describe('minimumVersionForSpec', () => {
  it.each([
    [null, null],
    ['', null],
    ['^1.2.0 || >=2.0.3', '1.2.0'],
    ['1.2.0', '1.2.0'],
    ['*', '0.0.0'],
    ['latest', null],
    ['>=5.0.0 ||', null],
  ])('finds a floor for %j', (spec, expected) => {
    expect(minimumVersionForSpec(spec)).toBe(expected);
  });
});

describe('checkVersion', () => {
  it.each([
    ['2.0.1', '^2.0.0', 'npm', 'match'],
    ['1.9.0', '^2.0.0', 'npm', 'version_not_allowed'],
    ['2.1.0', '^1.2.0 || >=2.0.3', 'npm', 'match'],
    ['1.5.0', '^1.2.0 || >=2.0.3', 'npm', 'match'],
    ['2.0.0', '^1.2.0 || >=2.0.3', 'npm', 'version_not_allowed'],
    ['1.2.0rc1', '>=1.0.0 <1.2.0', 'npm', 'version_not_allowed'],
    ['1.2.0rc1', '>=1.2.0-rc1 <1.2.0', 'npm', 'match'],
    ['1.2.0rc1', '^1.2.0', 'npm', 'version_not_allowed'],
    ['1.2.0', '^1.2.0', 'npm', 'match'],
    ['2.0.3rc1', '>=2.0.3', 'npm', 'version_not_allowed'],
    ['1.2.3-1', '>=1.2.3-1', 'npm', 'match'],
    ['1.2.3.post1', '>=1.2.3 <1.2.4', 'pypi', 'match'],
    ['1.2.3.dev1', '>=1.2.3', 'pypi', 'version_not_allowed'],
    ['1.2.3.dev1', '>=1.2.3-0.dev.1 <1.2.3', 'pypi', 'match'],
    ['1.2.3.4', '1.2.3', 'pypi', 'version_not_allowed'],
    ['1.2.3.4', '<=1.2.3', 'pypi', 'version_not_allowed'],
    ['1.2.3.4', '>=1.2.3 <1.2.4', 'pypi', 'match'],
    ['1.2.3.4', '>=1.2.4', 'pypi', 'version_not_allowed'],
    ['1.2.3.3', '>=1.2.4-0.4', 'pypi', 'version_not_allowed'],
    ['1.2.3.5', '>=1.2.4-0.4', 'pypi', 'match'],
    ['latest', '^2.0.0', 'npm', 'invalid_version'],
    ['latest', '*', 'npm', 'invalid_version'],
    ['2.0.1', 'not a range', 'npm', 'invalid_policy'],
    ['1.0.0', 'latest', 'npm', 'invalid_policy'],
    ['9.9.9', '>=5.0.0 ||', 'npm', 'invalid_policy'],
    ['0.0.1', '>=1.0.0, <2.0.0', 'npm', 'invalid_policy'],
    ['0.0.1', '>=1.0.0 garbage', 'npm', 'invalid_policy'],
  ] as const)('classifies %s against %s (%s) as %s', (version, spec, ecosystem, expected) => {
    expect(checkVersion(version, spec, ecosystem)).toBe(expected);
  });
});
