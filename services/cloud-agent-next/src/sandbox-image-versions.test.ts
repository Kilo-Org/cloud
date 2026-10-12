import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_SLASH_COMMANDS_SOURCE } from './shared/default-slash-commands.generated.js';
import { KILO_CLI_VERSION } from './shared/kilo-cli-version.js';
import {
  GIT_CREDENTIAL_HELPER,
  RUNTIME_DISTRIBUTION,
  WRAPPER_BUNDLES,
  runtimeInstallPath,
} from './shared/runtime-distribution.js';
import { SYSTEM_GIT_CONFIG_ENV } from './shared/runtime-environment.js';
import {
  CONTROL_SUPERVISOR_PATH,
  CONTROL_WRAPPER_PATH,
} from './sandbox-control/container-paths.js';

function readServiceFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url).href), 'utf8');
}

describe('sandbox image version parity', () => {
  it('keeps every sandbox image aligned with the Cloudflare sandbox SDK', () => {
    const packageJson = JSON.parse(readServiceFile('../package.json')) as {
      dependencies: Record<string, string>;
    };
    const sandboxVersion = packageJson.dependencies['@cloudflare/sandbox'];
    const dockerfile = readServiceFile('../Dockerfile');
    const devDockerfile = readServiceFile('../Dockerfile.dev');
    const dindDockerfile = readServiceFile('../Dockerfile.dind');

    expect(dockerfile).toContain(`FROM docker.io/cloudflare/sandbox:${sandboxVersion}`);
    expect(devDockerfile).toContain(`FROM docker.io/cloudflare/sandbox:${sandboxVersion}`);
    expect(devDockerfile).toMatch(/apt-get install[^;]+\bgh\b/s);
    expect(dindDockerfile).toContain(`ARG SANDBOX_VERSION="${sandboxVersion}"`);
  });

  it('keeps the Kilo SDK pins, CLI runtime pins, and slash-command source aligned', () => {
    const packageJson = JSON.parse(readServiceFile('../package.json')) as {
      devDependencies: Record<string, string>;
    };
    const wrapperPackageJson = JSON.parse(readServiceFile('../wrapper/package.json')) as {
      dependencies: Record<string, string>;
    };
    const dockerfile = readServiceFile('../Dockerfile');
    const devDockerfile = readServiceFile('../Dockerfile.dev');
    const dindDockerfile = readServiceFile('../Dockerfile.dind');
    const containersDockerfile = readServiceFile('../Dockerfile.containers');
    const wranglerConfig = readServiceFile('../wrangler.jsonc');
    const imageVar = `"KILOCODE_CLI_VERSION": "${KILO_CLI_VERSION}"`;

    expect(wrapperPackageJson.dependencies['@kilocode/sdk']).toBe(
      packageJson.devDependencies['@kilocode/sdk']
    );
    expect(wrapperPackageJson.dependencies['@kilocode/sdk']).toBe(KILO_CLI_VERSION);
    expect(dockerfile).toContain(`ARG KILOCODE_CLI_VERSION="${KILO_CLI_VERSION}"`);
    expect(devDockerfile).toContain(`ARG KILOCODE_CLI_VERSION="${KILO_CLI_VERSION}"`);
    expect(dindDockerfile).toContain(`ARG KILOCODE_CLI_VERSION="${KILO_CLI_VERSION}"`);
    expect(containersDockerfile).toContain(`ARG KILOCODE_CLI_VERSION="${KILO_CLI_VERSION}"`);
    expect(wranglerConfig.split(imageVar)).toHaveLength(17);
    expect(DEFAULT_SLASH_COMMANDS_SOURCE).toBe(`kilo@${KILO_CLI_VERSION}`);
  });
});

describe('runtime distribution packaging', () => {
  const dockerfiles = ['Dockerfile', 'Dockerfile.dev', 'Dockerfile.containers', 'Dockerfile.dind'];

  it('pins the shared toolchain versions', () => {
    expect(RUNTIME_DISTRIBUTION.bun).toBe('1.3.14');
    expect(RUNTIME_DISTRIBUTION.pnpm).toBe('11.1.2');
    expect(RUNTIME_DISTRIBUTION.glab).toBe('1.93.0');
    expect(RUNTIME_DISTRIBUTION.gh).toBe('2.82.1');
    expect(RUNTIME_DISTRIBUTION.nodeMajor).toBe('24');
  });

  it('builds wrapper bundles from the shared entrypoint list instead of duplicate commands', () => {
    for (const file of dockerfiles) {
      const dockerfile = readServiceFile(`../${file}`);
      expect(dockerfile).toContain('bun run build.ts --install-dir');
      expect(dockerfile).not.toContain('bun build');
      for (const bundle of WRAPPER_BUNDLES) {
        expect(dockerfile).not.toContain(`outfile=/usr/local/bin/${bundle.installName}`);
      }
    }
  });

  it('keeps Docker bootstrap ARG pins aligned with the contract', () => {
    const containers = readServiceFile('../Dockerfile.containers');
    expect(containers).toContain(`ARG BUN_VERSION="${RUNTIME_DISTRIBUTION.bun}"`);
    expect(containers).toContain(`ARG PNPM_VERSION="${RUNTIME_DISTRIBUTION.pnpm}"`);
    expect(containers).toContain(`ARG GLAB_VERSION="${RUNTIME_DISTRIBUTION.glab}"`);
    expect(containers).toContain(`ARG GH_VERSION="${RUNTIME_DISTRIBUTION.gh}"`);

    const dind = readServiceFile('../Dockerfile.dind');
    expect(dind).toContain(`ARG BUN_VERSION="${RUNTIME_DISTRIBUTION.bun}"`);
    expect(dind).toContain(`ARG PNPM_VERSION="${RUNTIME_DISTRIBUTION.pnpm}"`);
    expect(dind).toContain(`ARG GLAB_VERSION="${RUNTIME_DISTRIBUTION.glab}"`);
    expect(dind).toContain(`ARG GH_VERSION="${RUNTIME_DISTRIBUTION.gh}"`);
  });

  it('does not install gh from a legacy apt/dnf package in the pinned images', () => {
    const containers = readServiceFile('../Dockerfile.containers');
    expect(containers).not.toMatch(/apt-get install[^;]*\bgh\b/s);
    expect(containers).toContain(
      `https://github.com/cli/cli/releases/download/v\${GH_VERSION}/gh_\${GH_VERSION}_linux_amd64.tar.gz`
    );
  });

  it('keeps the supervisor pointed at the contract control-plane install path', () => {
    expect(readServiceFile('../wrapper/control-plane-supervisor.sh')).toContain(
      runtimeInstallPath('kilocode-control-plane-wrapper.js')
    );
  });

  it('derives container control paths from the shared install contract', () => {
    expect(CONTROL_SUPERVISOR_PATH).toBe(
      runtimeInstallPath('kilocode-control-plane-supervisor.sh')
    );
    expect(CONTROL_WRAPPER_PATH).toBe(runtimeInstallPath('kilocode-control-plane-wrapper.js'));
  });

  it('copies and links the shared credential helper layout in every image', () => {
    const realPath = SYSTEM_GIT_CONFIG_ENV.GIT_CONFIG_VALUE_0;
    expect(realPath).toBe(GIT_CREDENTIAL_HELPER.realPath);
    expect(GIT_CREDENTIAL_HELPER.linkPath).toBe(
      runtimeInstallPath(GIT_CREDENTIAL_HELPER.installName)
    );
    for (const file of dockerfiles) {
      const dockerfile = readServiceFile(`../${file}`);
      expect(dockerfile).toContain(`COPY ${GIT_CREDENTIAL_HELPER.packagePath} ${realPath}`);
      expect(dockerfile).toContain(`ln -sf ${realPath} ${GIT_CREDENTIAL_HELPER.linkPath}`);
    }
  });

  it('links the shared install inventory through the builder in DinD', () => {
    const dind = readServiceFile('../Dockerfile.dind');
    expect(dind).toContain(
      'bun run build.ts --install-dir /opt/kilo-cloud --link-dir /usr/local/bin'
    );
    for (const bundle of WRAPPER_BUNDLES) {
      expect(dind).not.toContain(`ln -sf /opt/kilo-cloud/${bundle.installName}`);
    }
    expect(dind).not.toContain('ln -sf /opt/kilo-cloud/kilocode-control-plane-supervisor.sh');
  });

  it('ships a self-contained control-plane smoke harness', () => {
    const harness = readServiceFile('../wrapper/src/control-plane-smoke.ts');
    expect(harness).toContain("type: 'welcome'");
    expect(harness).toContain("type: 'shutdown'");
    expect(harness).not.toContain("from './");
    expect(harness).not.toContain("from '../");
    expect(harness).toContain('CONTROL_PLANE_WRAPPER_COMMAND');
  });
});
