import { describe, expect, it } from 'vitest';

import { KILO_CLI_VERSION } from './kilo-cli-version.js';
import { RUNTIME_DISTRIBUTION } from './runtime-distribution.js';
import {
  RUNTIME_TOOLCHAIN,
  TOOLCHAIN_TOOLS,
  installPinnedArchiveScript,
  installPinnedNpmPackageScript,
  toolchainVerificationScript,
} from './runtime-toolchain.js';

const SHA256 = /^[a-f0-9]{64}$/;

describe('runtime toolchain pins', () => {
  it('pins every tool to an https distribution and a repository digest', () => {
    expect(TOOLCHAIN_TOOLS).toEqual(['bun', 'rg', 'gh', 'glab', 'pnpm', 'kilo']);
    for (const tool of TOOLCHAIN_TOOLS) {
      const pin = RUNTIME_TOOLCHAIN[tool];
      expect(new URL(pin.url).protocol).toBe('https:');
      expect(pin.sha256).toMatch(SHA256);
      expect(pin.installedSha256.length).toBeGreaterThan(0);
      for (const digest of pin.installedSha256) expect(digest).toMatch(SHA256);
      expect(pin.url).toContain(pin.version);
    }
  });

  it('keeps the pinned versions equal to the distribution owner', () => {
    expect(RUNTIME_TOOLCHAIN.bun.version).toBe(RUNTIME_DISTRIBUTION.bun);
    expect(RUNTIME_TOOLCHAIN.pnpm.version).toBe(RUNTIME_DISTRIBUTION.pnpm);
    expect(RUNTIME_TOOLCHAIN.gh.version).toBe(RUNTIME_DISTRIBUTION.gh);
    expect(RUNTIME_TOOLCHAIN.glab.version).toBe(RUNTIME_DISTRIBUTION.glab);
    expect(RUNTIME_TOOLCHAIN.kilo.version).toBe(KILO_CLI_VERSION);
  });

  it('installs the standalone binaries into the shared install directory', () => {
    for (const tool of ['bun', 'rg', 'gh', 'glab'] as const) {
      const pin = RUNTIME_TOOLCHAIN[tool];
      expect(pin.kind).toBe('archive');
      if (pin.kind !== 'archive') throw new Error('expected an archive pin');
      expect(pin.installPath).toBe(`/usr/local/bin/${tool}`);
      expect(pin.member.endsWith(`/${tool}`) || pin.member.endsWith(`/${tool}.exe`)).toBe(true);
    }
    for (const tool of ['pnpm', 'kilo'] as const) {
      const pin = RUNTIME_TOOLCHAIN[tool];
      expect(pin.kind).toBe('npm');
      if (pin.kind !== 'npm') throw new Error('expected an npm pin');
      expect(pin.url.startsWith('https://registry.npmjs.org/')).toBe(true);
    }
  });

  it('checks the downloaded archive and the installed binary before finishing', () => {
    const script = installPinnedArchiveScript('bun');
    const pin = RUNTIME_TOOLCHAIN.bun;
    expect(script).toContain(`fetch_verified '${pin.url}' '${pin.sha256}'`);
    expect(script).toContain(`check_sha256 '/usr/local/bin/bun' '${pin.installedSha256[0]}'`);
    expect(script).toContain("curl -fsSL --proto '=https'");
    expect(script).not.toContain('| bash');
    expect(script).not.toContain('bash -s');
  });

  it('installs an npm package from its verified tarball and checks what it left behind', () => {
    const script = installPinnedNpmPackageScript('kilo');
    const pin = RUNTIME_TOOLCHAIN.kilo;
    expect(script).toContain(`fetch_verified '${pin.url}' '${pin.sha256}'`);
    expect(script).toContain('sudo npm install -g --loglevel=error "$work/package.tgz"');
    expect(script).toContain(
      `check_sha256 "$npm_root/@kilocode/cli/bin/.kilo" '${pin.installedSha256[0]}'`
    );
  });

  it('rejects a tool that is not installed from the requested distribution', () => {
    expect(() => installPinnedArchiveScript('kilo')).toThrow(
      'not installed from a release archive'
    );
    expect(() => installPinnedNpmPackageScript('bun')).toThrow('not installed from an npm tarball');
  });

  it('verifies the exact version and the installed digest of each requested tool', () => {
    const script = toolchainVerificationScript(['bun', 'gh', 'pnpm']);
    for (const [command, version] of [
      ['bun', RUNTIME_DISTRIBUTION.bun],
      ['gh', RUNTIME_DISTRIBUTION.gh],
      ['pnpm', RUNTIME_DISTRIBUTION.pnpm],
    ] as const) {
      expect(script).toContain(`command -v ${command} >/dev/null`);
      expect(script).toContain(`= '${version}'`);
    }
    expect(script).toContain(
      `check_sha256 '/usr/local/bin/bun' '${RUNTIME_TOOLCHAIN.bun.installedSha256[0]}'`
    );
    expect(script).toContain('npm_root=$(sudo npm root -g)');
    expect(script).toContain(
      `check_sha256 "$npm_root/pnpm/pnpm" '${RUNTIME_TOOLCHAIN.pnpm.installedSha256[0]}'`
    );
    expect(script).not.toContain('rg --version');
  });
});
