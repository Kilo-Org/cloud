import { isInstallSource } from './install-sources';

describe('isInstallSource', () => {
  it('accepts registered source keys', () => {
    expect(isInstallSource('byte')).toBe(true);
  });

  it('rejects unknown sources', () => {
    expect(isInstallSource('skill')).toBe(false);
    expect(isInstallSource('')).toBe(false);
  });

  it('rejects inherited Object prototype names (own-property check)', () => {
    // Naive `value in INSTALL_SOURCES` would pass these through and then
    // crash downstream lookup. Object.hasOwn keeps them out.
    expect(isInstallSource('toString')).toBe(false);
    expect(isInstallSource('hasOwnProperty')).toBe(false);
    expect(isInstallSource('constructor')).toBe(false);
    expect(isInstallSource('__proto__')).toBe(false);
  });
});
