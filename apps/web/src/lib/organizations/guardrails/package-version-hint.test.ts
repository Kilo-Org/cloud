import { packageVersionSpecHint } from './package-version-hint';

describe('packageVersionSpecHint', () => {
  it.each([
    ['npm', '1.2.3', '>=1.2.3'],
    ['npm', '0.0.0', null],
    ['npm', '0.0.0+build.1', null],
    ['npm', '0.0.0-rc.1', '>=0.0.0-rc.1'],
    ['pypi', '0.0', null],
    ['pypi', '0.0.0.post1', null],
    ['pypi', '1.2.0rc1', '>=1.2.0-rc.1'],
    ['pypi', '1.2.3.dev1', '>=1.2.3-0.dev.1'],
    ['npm', 'latest', null],
    ['npm', null, null],
  ] as const)('hints %s %j', (ecosystem, version, expected) => {
    expect(packageVersionSpecHint(ecosystem, version)).toBe(expected);
  });
});
