import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runtimeDistributionSourceFiles } from '../scripts/runtime-manifest.js';
import { DEFAULT_SLASH_COMMANDS_SOURCE } from './shared/default-slash-commands.generated.js';
import { KILO_CLI_VERSION } from './shared/kilo-cli-version.js';
import {
  CONTROL_PLANE_SUPERVISOR,
  GIT_CREDENTIAL_HELPER,
  RUNTIME_DISTRIBUTION,
  RUNTIME_INSTALL_DIR,
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
    const e2eWorkflow = readServiceFile('../../../.github/workflows/cloud-agent-e2e-deploy.yml');
    const bunSetup = 'uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6';
    expect(e2eWorkflow).toContain(bunSetup);
    expect(e2eWorkflow).toContain(`bun-version: ${RUNTIME_DISTRIBUTION.bun}`);
    expect(e2eWorkflow.indexOf(bunSetup)).toBeLessThan(
      e2eWorkflow.indexOf('name: Deploy Cloud Agent e2e Worker')
    );
  });

  it('copies the prebuilt shared runtime inventory without rebuilding wrappers in any image', () => {
    const inventory = runtimeDistributionSourceFiles('/package');
    expect(inventory.map(artifact => artifact.installName)).toEqual([
      ...WRAPPER_BUNDLES.map(bundle => bundle.installName),
      CONTROL_PLANE_SUPERVISOR.installName,
      GIT_CREDENTIAL_HELPER.installName,
    ]);
    for (const bundle of WRAPPER_BUNDLES) {
      expect(inventory).toContainEqual({
        installName: bundle.installName,
        installPath: runtimeInstallPath(bundle.installName),
        executable: bundle.executable,
        localPath: `/package/wrapper/dist/${bundle.distName}`,
      });
    }
    expect(inventory).toContainEqual({
      installName: CONTROL_PLANE_SUPERVISOR.installName,
      installPath: runtimeInstallPath(CONTROL_PLANE_SUPERVISOR.installName),
      executable: true,
      localPath: `/package/wrapper/${CONTROL_PLANE_SUPERVISOR.wrapperPath}`,
    });
    const builder = readServiceFile('../wrapper/build.ts');
    expect(builder).toContain("const runtimeDir = resolve('dist/runtime')");
    expect(builder).toContain(
      'copyFile(resolve(artifactDir, bundle.installName), resolve(runtimeDir, bundle.installName))'
    );
    expect(builder).toContain('resolve(runtimeDir, CONTROL_PLANE_SUPERVISOR.installName)');
    for (const file of dockerfiles) {
      const dockerfile = readServiceFile(`../${file}`);
      const installDir = file === 'Dockerfile.dind' ? '/opt/kilo-cloud' : RUNTIME_INSTALL_DIR;
      expect(dockerfile.match(/^COPY wrapper\S* .*$/gm)).toEqual([
        `COPY wrapper/dist/runtime/ ${installDir}/`,
      ]);
      expect(dockerfile).not.toMatch(/\bbun (?:build|install|run build\.ts)\b/);
      expect(dockerfile).not.toContain('COPY src/shared');
      expect(dockerfile).not.toContain('SENTRY_AUTH_TOKEN');
    }
  });

  it('keeps Docker bootstrap ARG pins aligned with the contract', () => {
    for (const file of dockerfiles) {
      const dockerfile = readServiceFile(`../${file}`);
      expect(dockerfile).toContain(`ARG BUN_VERSION="${RUNTIME_DISTRIBUTION.bun}"`);
      expect(dockerfile).toContain(`ARG PNPM_VERSION="${RUNTIME_DISTRIBUTION.pnpm}"`);
      expect(dockerfile).toContain(`ARG GLAB_VERSION="${RUNTIME_DISTRIBUTION.glab}"`);
    }
    const containers = readServiceFile('../Dockerfile.containers');
    expect(containers).toContain(`ARG GH_VERSION="${RUNTIME_DISTRIBUTION.gh}"`);

    const dind = readServiceFile('../Dockerfile.dind');
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

  it('links the copied shared runtime inventory in DinD without rebuilding it', () => {
    const dind = readServiceFile('../Dockerfile.dind');
    expect(dind).toContain('COPY wrapper/dist/runtime/ /opt/kilo-cloud/');
    expect(dind).toContain('for artifact in /opt/kilo-cloud/*; do ln -sf "$artifact"');
    expect(dind).toContain(`"${RUNTIME_INSTALL_DIR}/$(basename "$artifact")"; done`);
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
