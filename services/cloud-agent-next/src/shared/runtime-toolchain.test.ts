import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BASE_REQUIRED_BINARIES,
  GH_STACK_INSTALL_PATH,
  RUNTIME_DISTRIBUTION,
  RUNTIME_PROCESS_PATH,
} from './runtime-distribution.js';
import {
  RUNTIME_TOOLCHAIN,
  TOOLCHAIN_TOOLS,
  baseBinaryCheckScript,
  installPinnedArchiveScript,
  installPinnedNpmPackageScript,
  toolchainVerificationScript,
} from './runtime-toolchain.js';

const SHA256 = /^[a-f0-9]{64}$/;

describe('runtime toolchain pins', () => {
  it('pins every tool to an https distribution and a repository digest', () => {
    expect(TOOLCHAIN_TOOLS).toEqual(['bun', 'rg', 'gh', 'glab', 'pnpm']);
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
  });

  it('installs the standalone binaries into the shared install directory', () => {
    for (const tool of ['bun', 'rg', 'gh', 'glab'] as const) {
      const pin = RUNTIME_TOOLCHAIN[tool];
      expect(pin.kind).toBe('archive');
      if (pin.kind !== 'archive') throw new Error('expected an archive pin');
      expect(pin.installPath).toBe(`/usr/local/bin/${tool}`);
      expect(pin.member.endsWith(`/${tool}`) || pin.member.endsWith(`/${tool}.exe`)).toBe(true);
    }
    expect(RUNTIME_TOOLCHAIN.pnpm.kind).toBe('npm');
    expect(RUNTIME_TOOLCHAIN.pnpm.url.startsWith('https://registry.npmjs.org/')).toBe(true);
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
    const script = installPinnedNpmPackageScript('pnpm');
    const pin = RUNTIME_TOOLCHAIN.pnpm;
    expect(script).toContain(`fetch_verified '${pin.url}' '${pin.sha256}'`);
    expect(script).toContain('sudo npm install -g --loglevel=error "$work/package.tgz"');
    expect(script).toContain(`check_sha256 "$npm_root/pnpm/pnpm" '${pin.installedSha256[0]}'`);
    expect(script).not.toContain(`pnpm@${pin.version}`);
  });

  it('rejects a tool that is not installed from the requested distribution', () => {
    expect(() => installPinnedArchiveScript('pnpm')).toThrow(
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

describe('base binary check', () => {
  it('requires every pinned tool and no release-owned command', () => {
    for (const tool of TOOLCHAIN_TOOLS) expect(BASE_REQUIRED_BINARIES).toContain(tool);
    expect(BASE_REQUIRED_BINARIES).not.toContain('kilo');
  });

  it('resolves each required command on the process PATH without changing the caller PATH', () => {
    const script = baseBinaryCheckScript();
    expect(script.startsWith('(\n')).toBe(true);
    expect(script.endsWith('\n)')).toBe(true);
    expect(script).toContain(`PATH='${RUNTIME_PROCESS_PATH}'`);
    expect(script).toContain(`for binary in ${BASE_REQUIRED_BINARIES.join(' ')}; do`);
    expect(script).toContain('command -v "$binary" >/dev/null');
    expect(script).toContain(`test -x '${GH_STACK_INSTALL_PATH}'`);
  });

  it('is valid POSIX sh, because the runtime-free image runs it with /bin/sh', () => {
    const script = baseBinaryCheckScript();
    for (const bashOnly of ['[[', 'pipefail', 'function ', 'local ']) {
      expect(script).not.toContain(bashOnly);
    }
    const parsed = spawnSync('sh', ['-n', '-c', script], { encoding: 'utf8' });
    expect(parsed.status).toBe(0);
  });

  // The script owns its PATH, so the test points that PATH and the gh-stack path at stubs.
  function runWithStubs(missing?: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'base-binary-check-'));
    try {
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      for (const binary of [...BASE_REQUIRED_BINARIES, 'gh-stack']) {
        if (binary === missing) continue;
        fs.writeFileSync(path.join(bin, binary), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      }
      const original = baseBinaryCheckScript();
      const script = original
        .replace(`PATH='${RUNTIME_PROCESS_PATH}'`, `PATH='${bin}'`)
        .replace(`test -x '${GH_STACK_INSTALL_PATH}'`, `test -x '${path.join(bin, 'gh-stack')}'`);
      expect(script).not.toContain(RUNTIME_PROCESS_PATH);
      expect(script).not.toContain(GH_STACK_INSTALL_PATH);
      return spawnSync('sh', ['-c', script], { encoding: 'utf8' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('exits 0 when every required command and the gh-stack extension are present', () => {
    const result = runWithStubs();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it.each(BASE_REQUIRED_BINARIES)('exits 1 when %s is missing', binary => {
    const result = runWithStubs(binary);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`base binary missing: ${binary}`);
  });

  it('exits 1 when the gh-stack extension is missing', () => {
    const result = runWithStubs('gh-stack');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gh-stack extension missing');
  });
});
