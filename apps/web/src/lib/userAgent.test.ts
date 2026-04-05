import { describe, test, expect } from '@jest/globals';
import { getKiloCodeVersionNumber, getXKiloCodeVersionNumber } from './userAgent';

describe('getKiloCodeVersionNumber', () => {
  test('returns undefined for non-Kilo-Code user agents', () => {
    expect(getKiloCodeVersionNumber(null)).toBeUndefined();
    expect(getKiloCodeVersionNumber(undefined)).toBeUndefined();
    expect(getKiloCodeVersionNumber('')).toBeUndefined();
    expect(getKiloCodeVersionNumber('Mozilla/5.0 Test Browser')).toBeUndefined();
    expect(getKiloCodeVersionNumber('Kilo-Code')).toBeUndefined(); // missing slash/version
    expect(getKiloCodeVersionNumber('Kilo-Code/')).toBeUndefined(); // empty version
    expect(getKiloCodeVersionNumber('Kilo-Code 4.82.0')).toBeUndefined(); // missing slash
    expect(getKiloCodeVersionNumber('kilo-code/4.82.0')).toBeUndefined(); // wrong casing
    expect(getKiloCodeVersionNumber('Kilo-Code/JS 4.60.0')).toBeUndefined(); // wrong format
  });

  test('parses full semver correctly (major.minor.patch)', () => {
    expect(getKiloCodeVersionNumber('Kilo-Code/4.82.0')).toBeCloseTo(4.082, 10);
    expect(getKiloCodeVersionNumber('Kilo-Code/4.65.3')).toBeCloseTo(4.065003, 10);
    expect(getXKiloCodeVersionNumber('4.65.3')).toBeCloseTo(4.065003, 10);
  });

  test('parses when patch is omitted (major.minor)', () => {
    // By definition we encode minor as thousandths and patch as millionths
    // So 4.1 becomes 4.001
    expect(getKiloCodeVersionNumber('Kilo-Code/4.1')).toBeCloseTo(4.001, 10);
  });

  test('allows suffix after version separated by space', () => {
    expect(getKiloCodeVersionNumber('Kilo-Code/4.65.3 (Mac OS X)')).toBeCloseTo(4.065003, 10);
    expect(getXKiloCodeVersionNumber('4.65.3 (Mac OS X)')).toBeCloseTo(4.065003, 10);
    expect(getKiloCodeVersionNumber('Kilo-Code/4.82.0 extra-info')).toBeCloseTo(4.082, 10);
  });

  test('rejects version with trailing non-space characters without hyphen', () => {
    expect(getKiloCodeVersionNumber('Kilo-Code/4.82.0beta')).toBeUndefined();
  });

  test('parses versions with pre-release tags (ignoring the tag)', () => {
    expect(getKiloCodeVersionNumber('Kilo-Code/4.82.0-beta')).toBeCloseTo(4.082, 10);
    expect(getKiloCodeVersionNumber('Kilo-Code/4.65.3-alpha')).toBeCloseTo(4.065003, 10);
    expect(getKiloCodeVersionNumber('Kilo-Code/4.65.3-alpha.1')).toBeCloseTo(4.065003, 10);
    expect(getKiloCodeVersionNumber('Kilo-Code/4.65.3-rc.2')).toBeCloseTo(4.065003, 10);
    expect(getKiloCodeVersionNumber('Kilo-Code/4.65.3-beta.10.20')).toBeCloseTo(4.065003, 10);
    expect(getXKiloCodeVersionNumber('4.65.3-beta')).toBeCloseTo(4.065003, 10);
    expect(getXKiloCodeVersionNumber('4.65.3-alpha.1')).toBeCloseTo(4.065003, 10);
  });

  test('parses versions with pre-release tags followed by suffix', () => {
    expect(getKiloCodeVersionNumber('Kilo-Code/4.82.0-beta (Mac OS X)')).toBeCloseTo(4.082, 10);
    expect(getXKiloCodeVersionNumber('4.65.3-alpha.1 extra-info')).toBeCloseTo(4.065003, 10);
  });
});
