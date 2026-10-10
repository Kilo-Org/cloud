import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_SLASH_COMMANDS_SOURCE } from './shared/default-slash-commands.generated.js';
import { KILO_CLI_VERSION } from './shared/kilo-cli-version.js';

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
