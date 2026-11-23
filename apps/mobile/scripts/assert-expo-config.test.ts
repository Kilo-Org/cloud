// Pins the profile-dependent branches of scripts/assert-expo-config.mjs on fixed
// input: the release-only File Provider and Play Integrity checks must fail on a
// production profile and pass on any other, from the same evaluated config. The
// live guard stays in `pnpm assert:config`, which evaluates app.config.ts; these
// cases run the CLI against a committed fixture so neither branch depends on the
// local environment.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(scriptsDir, 'assert-expo-config.mjs');
const appDir = join(scriptsDir, '..');
const fixturePath = join(scriptsDir, 'fixtures', 'expo-config.json');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The parts of the fixture the cases mutate; the rest passes through untouched. */
type AppExtension = { targetName: string; entitlements: Record<string, unknown> };
type MutableFixture = {
  ios: { entitlements: Record<string, unknown> };
  extra: {
    [key: string]: unknown;
    eas: { build: { experimental: { ios: { appExtensions: AppExtension[] } } } };
  };
  /** Replaced with a value no check can read, to prove the exit-2 classification. */
  plugins: unknown;
};

/** Writes a mutated fixture into a fresh temp dir and returns its path. */
function writeVariant(mutate: (config: MutableFixture) => void): string {
  const config = JSON.parse(readFileSync(fixturePath, 'utf8')) as MutableFixture;
  mutate(config);
  const dir = mkdtempSync(join(tmpdir(), 'expo-config-'));
  tempDirs.push(dir);
  const path = join(dir, 'expo-config.json');
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

function run(argv: string[], env: Record<string, string | undefined> = {}, cwd = appDir) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.EAS_BUILD_PROFILE;
  Object.assign(childEnv, env);
  const result = spawnSync(process.execPath, [scriptPath, ...argv], {
    cwd,
    encoding: 'utf8',
    env: childEnv,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** The fixture's sole File Provider extension; the cases mutate it in place. */
function fileProviderExtension(config: MutableFixture): AppExtension {
  const [extension] = config.extra.eas.build.experimental.ios.appExtensions;
  if (extension === undefined) {
    throw new Error('the fixture must carry the ArtifactsFileProvider extension');
  }
  return extension;
}

const withTestingMode = () =>
  writeVariant(config => {
    config.ios.entitlements['com.apple.developer.fileprovider.testing-mode'] = true;
  });

const withExtensionTestingMode = () =>
  writeVariant(config => {
    fileProviderExtension(config).entitlements['com.apple.developer.fileprovider.testing-mode'] =
      true;
  });

describe('assert-expo-config', () => {
  it('passes the committed fixture under the production profile', () => {
    const { status, output } = run(['--config', fixturePath, '--profile', 'production']);
    expect(status).toBe(0);
    expect(output).toContain('profile: production');
  });

  it('passes the committed fixture under the development profile', () => {
    const { status, output } = run(['--config', fixturePath, '--profile', 'development']);
    expect(status).toBe(0);
    expect(output).toContain('profile: development');
  });

  it('fails the File Provider testing-mode entitlement under production', () => {
    const { status, output } = run(['--config', withTestingMode(), '--profile', 'production']);
    expect(status).toBe(1);
    expect(output).toContain('com.apple.developer.fileprovider.testing-mode');
  });

  it('allows the File Provider testing-mode entitlement under development', () => {
    const { status } = run(['--config', withTestingMode(), '--profile', 'development']);
    expect(status).toBe(0);
  });

  it('fails the File Provider testing-mode extension entitlement under production', () => {
    const { status, output } = run([
      '--config',
      withExtensionTestingMode(),
      '--profile',
      'production',
    ]);
    expect(status).toBe(1);
    expect(output).toContain('extension entitlement');
  });

  it('allows the File Provider testing-mode extension entitlement under development', () => {
    const { status } = run(['--config', withExtensionTestingMode(), '--profile', 'development']);
    expect(status).toBe(0);
  });

  it('fails a renamed File Provider extension target under production', () => {
    const path = writeVariant(config => {
      fileProviderExtension(config).targetName = 'ArtifactsFileProviderRenamed';
    });
    const { status, output } = run(['--config', path, '--profile', 'production']);
    expect(status).toBe(1);
    expect(output).toContain('must carry the ArtifactsFileProvider target');
  });

  it('fails a missing playIntegrityProjectNumber under production', () => {
    const path = writeVariant(config => {
      delete config.extra.playIntegrityProjectNumber;
    });
    const { status, output } = run(['--config', path, '--profile', 'production']);
    expect(status).toBe(1);
    expect(output).toContain('playIntegrityProjectNumber');
  });

  it('allows a missing playIntegrityProjectNumber under development', () => {
    const path = writeVariant(config => {
      delete config.extra.playIntegrityProjectNumber;
    });
    const { status } = run(['--config', path, '--profile', 'development']);
    expect(status).toBe(0);
  });

  it('falls back to EAS_BUILD_PROFILE when no profile flag is given', () => {
    const { status, output } = run(['--config', withTestingMode()], {
      EAS_BUILD_PROFILE: 'production',
    });
    expect(status).toBe(1);
    expect(output).toContain('com.apple.developer.fileprovider.testing-mode');
  });

  it('lets the profile flag override EAS_BUILD_PROFILE', () => {
    const { status, output } = run(['--config', withTestingMode(), '--profile', 'development'], {
      EAS_BUILD_PROFILE: 'production',
    });
    expect(status).toBe(0);
    expect(output).toContain('profile: development');
  });

  it('reports no profile when neither the flag nor the environment names one', () => {
    const { status, output } = run(['--config', withTestingMode()]);
    expect(status).toBe(0);
    expect(output).toContain('profile: none');
  });

  it('exits 2 for a missing config file', () => {
    const { status } = run(['--config', join(tmpdir(), 'expo-config-does-not-exist.json')]);
    expect(status).toBe(2);
  });

  it('exits 2 for a config that is not JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'expo-config-'));
    tempDirs.push(dir);
    const path = join(dir, 'not-json.json');
    writeFileSync(path, 'not json');
    const { status, output } = run(['--config', path]);
    expect(status).toBe(2);
    expect(output).toContain(path);
  });

  it('exits 2 for a config file that holds no object', () => {
    for (const contents of ['null', '[]', '42']) {
      const dir = mkdtempSync(join(tmpdir(), 'expo-config-'));
      tempDirs.push(dir);
      const path = join(dir, 'not-an-object.json');
      writeFileSync(path, contents);
      const { status, output } = run(['--config', path]);
      expect(status).toBe(2);
      expect(output).toContain('holds no config object');
    }
  });

  it('resolves a relative --config from the app directory, not the caller cwd', () => {
    const { status, output } = run(
      ['--config', 'scripts/fixtures/expo-config.json', '--profile', 'production'],
      {},
      join(appDir, '..')
    );
    expect(status).toBe(0);
    expect(output).toContain('profile: production');
  });

  it('exits 2 for a profile eas.json does not define', () => {
    const { status, output } = run(['--config', fixturePath, '--profile', 'productionn']);
    expect(status).toBe(2);
    expect(output).toContain('productionn');
  });

  it('exits 2 for a config whose nested member throws a check', () => {
    const path = writeVariant(config => {
      config.plugins = {};
    });
    const { status, output } = run(['--config', path, '--profile', 'production']);
    expect(status).toBe(2);
    expect(output).toContain('could not be checked');
  });

  it('exits 2 for an unknown flag', () => {
    const { status, output } = run(['--config', fixturePath, '--unknown-flag', 'x']);
    expect(status).toBe(2);
    expect(output).toContain('--config');
    expect(output).toContain('--profile');
  });

  it('exits 2 when --profile has no value', () => {
    expect(run(['--config', fixturePath, '--profile']).status).toBe(2);
  });

  it('exits 2 when --config has no value', () => {
    expect(run(['--config']).status).toBe(2);
  });
});
