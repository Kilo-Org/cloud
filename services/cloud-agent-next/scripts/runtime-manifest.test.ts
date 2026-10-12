import { describe, expect, it } from 'vitest';

import {
  GIT_CREDENTIAL_HELPER,
  RUNTIME_DISTRIBUTION,
  RUNTIME_REQUIRED_BINARIES,
  WRAPPER_BUNDLES,
  runtimeInstallPath,
} from '../src/shared/runtime-distribution.js';
import {
  hashRuntimeArtifacts,
  runtimeDistributionSourceFiles,
  runtimeVerificationScript,
} from './runtime-manifest.js';

describe('runtime distribution contract', () => {
  it('pins the shared toolchain versions', () => {
    expect(RUNTIME_DISTRIBUTION).toEqual({
      nodeMajor: '24',
      bun: '1.3.14',
      pnpm: '11.1.2',
      glab: '1.93.0',
      gh: '2.82.1',
    });
  });

  it('lists every wrapper build entrypoint with a unique install name', () => {
    expect(WRAPPER_BUNDLES.map(bundle => bundle.entry)).toEqual([
      'src/main.ts',
      'src/restore-session.ts',
      'src/bitbucket-review-cli.ts',
      'src/github-review-publish-mcp.ts',
      'src/control-plane/main.ts',
    ]);
    expect(new Set(WRAPPER_BUNDLES.map(bundle => bundle.installName)).size).toBe(
      WRAPPER_BUNDLES.length
    );
  });

  it('resolves the installed inventory under the shared install directory', () => {
    const files = runtimeDistributionSourceFiles('/pkg');
    expect(files.map(file => file.installName)).toEqual([
      'kilocode-wrapper.js',
      'kilo-restore-session.js',
      'bb',
      'github-review-publish-mcp',
      'kilocode-control-plane-wrapper.js',
      'kilocode-control-plane-supervisor.sh',
      'kilo-git-credential',
    ]);
    for (const file of files) {
      if (file.installName === GIT_CREDENTIAL_HELPER.installName) continue;
      expect(file.installPath).toBe(runtimeInstallPath(file.installName));
    }
    const helper = files.find(file => file.installName === GIT_CREDENTIAL_HELPER.installName);
    expect(helper?.installPath).toBe(GIT_CREDENTIAL_HELPER.realPath);
    expect(helper?.linkPath).toBe(GIT_CREDENTIAL_HELPER.linkPath);
    expect(helper?.executable).toBe(true);
    expect(
      files.find(file => file.installName === 'kilocode-control-plane-supervisor.sh')?.localPath
    ).toBe('/pkg/wrapper/control-plane-supervisor.sh');
    expect(files.find(file => file.installName === 'kilo-git-credential')?.localPath).toBe(
      '/pkg/scripts/kilo-git-credential'
    );
  });

  it('verifies installed pins, required binaries, and artifact hashes', () => {
    const artifacts = hashRuntimeArtifacts(
      runtimeDistributionSourceFiles('/pkg').map(file => ({
        ...file,
        bytes: new TextEncoder().encode(file.installName),
      }))
    );
    const script = runtimeVerificationScript(artifacts);
    expect(script).toContain(`test "$(bun --version)" = '1.3.14'`);
    expect(script).toContain(`test "$(pnpm --version)" = '11.1.2'`);
    expect(script).toContain('grep -oE');
    expect(script).not.toContain('grep -qF');
    expect(script).toContain(`= '1.93.0'`);
    expect(script).toContain(`= '2.82.1'`);
    for (const binary of RUNTIME_REQUIRED_BINARIES) {
      expect(script).toContain(`command -v ${binary} >/dev/null`);
    }
    for (const artifact of artifacts) {
      expect(script).toContain(`sha256sum '${artifact.installPath}'`);
    }
    expect(script).toContain(`test -x '${runtimeInstallPath('bb')}'`);
    expect(script).toContain(
      `test -x '${runtimeInstallPath('kilocode-control-plane-supervisor.sh')}'`
    );
    expect(script).toContain(`test -L '${GIT_CREDENTIAL_HELPER.linkPath}'`);
    expect(script).not.toContain(`test -x '${runtimeInstallPath('kilocode-wrapper.js')}'`);
  });
});
