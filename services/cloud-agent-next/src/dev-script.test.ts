import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serviceDir = path.resolve(testDir, '..');
const repoRoot = path.resolve(serviceDir, '../..');
const scriptPath = path.join(serviceDir, 'scripts/dev.sh');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeExecutable(filePath: string, contents: string) {
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o755);
}

function isolatedScript(tempDir: string): string {
  const scriptsDir = path.join(tempDir, 'scripts');
  fs.mkdirSync(scriptsDir);
  const isolated = path.join(scriptsDir, 'dev.sh');
  fs.copyFileSync(scriptPath, isolated);
  fs.chmodSync(isolated, 0o755);
  return isolated;
}

describe('dev.sh', () => {
  it.each([
    { endpoint: 'socket', localConfig: false, explicitConfig: undefined },
    { endpoint: 'socket-url', localConfig: false, explicitConfig: undefined },
    { endpoint: 'host', localConfig: false, explicitConfig: undefined },
    { endpoint: 'context', localConfig: false, explicitConfig: undefined },
    { endpoint: 'socket', localConfig: true, explicitConfig: undefined },
    { endpoint: 'socket', localConfig: true, explicitConfig: '-c' },
    { endpoint: 'socket', localConfig: true, explicitConfig: '--config' },
  ])(
    'preserves Docker routing and ARM support: $endpoint/v2=$localConfig/config=$explicitConfig',
    ({ endpoint, localConfig, explicitConfig }) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-agent-dev-script-test-'));
      tempDirs.push(tempDir);
      const binDir = path.join(tempDir, 'bin');
      fs.mkdirSync(binDir);
      const script = isolatedScript(tempDir);
      const configPath = path.join(tempDir, 'wrangler.kilo2-local.json');
      if (localConfig)
        fs.writeFileSync(
          configPath,
          JSON.stringify({ env: { dev: { vars: { RUNTIME_KILO2_ORG_IDS: 'org-test' } } } })
        );
      const dockerSocket = path.join(tempDir, 'upstream.sock');
      const wranglerEnvLog = path.join(tempDir, 'wrangler-env.log');
      const dockerProbeLog = path.join(tempDir, 'docker-probe.log');
      const expectedDockerHost = endpoint === 'context' ? '' : `unix://${dockerSocket}`;

      writeExecutable(
        path.join(binDir, 'docker'),
        `#!/bin/sh
printf '%s\\n' "DOCKER_HOST=$DOCKER_HOST DOCKER_SOCKET=$DOCKER_SOCKET $*" >> "${dockerProbeLog}"
if [ "$1" = "info" ] && [ "$DOCKER_HOST" = "${expectedDockerHost}" ]; then
  printf '%s\\n' arm64
else
  printf '%s\\n' x86_64
fi
`
      );
      writeExecutable(path.join(binDir, 'pnpm'), '#!/bin/sh\nexit 0\n');
      writeExecutable(
        path.join(binDir, 'node'),
        `#!/bin/sh
if [ "$1" = "-e" ]; then exec "${process.execPath}" "$@"; fi
case "$*" in *KILO2*) printf '${'b'.repeat(64)}' ;; *) printf '${'a'.repeat(64)}' ;; esac
`
      );
      writeExecutable(
        path.join(binDir, 'wrangler'),
        `#!/bin/sh
printf '%s\\n' "MINIFLARE_CONTAINER_EGRESS_IMAGE=$MINIFLARE_CONTAINER_EGRESS_IMAGE" "DOCKER_HOST=$DOCKER_HOST" "$@" > "${wranglerEnvLog}"
`
      );

      const wranglerArgs = ['--env', 'dev', '--port', '11694', '--var', 'EXAMPLE:two words'];
      const explicitArgs =
        explicitConfig === undefined ? [] : [explicitConfig, path.join(tempDir, 'other.json')];
      execFileSync('sh', [script, ...explicitArgs, ...wranglerArgs], {
        cwd: repoRoot,
        timeout: 10_000,
        env: {
          ...process.env,
          MINIFLARE_CONTAINER_EGRESS_IMAGE: '',
          DOCKER_HOST: endpoint.startsWith('socket') ? 'unix:///unused.sock' : expectedDockerHost,
          DOCKER_SOCKET:
            endpoint === 'socket'
              ? dockerSocket
              : endpoint === 'socket-url'
                ? expectedDockerHost
                : '',
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        },
      });

      expect(fs.readFileSync(dockerProbeLog, 'utf8')).toContain(
        `DOCKER_HOST=${expectedDockerHost}`
      );
      const wranglerEnv = fs.readFileSync(wranglerEnvLog, 'utf8');
      expect(wranglerEnv).toContain(
        'MINIFLARE_CONTAINER_EGRESS_IMAGE=cloudflare/proxy-everything:3cb1195'
      );
      expect(wranglerEnv.trim().split('\n').slice(1)).toEqual([
        `DOCKER_HOST=${expectedDockerHost}`,
        'dev',
        ...explicitArgs,
        ...wranglerArgs,
        ...(localConfig && explicitConfig === undefined ? ['--config', configPath] : []),
        '--persist-to',
        path.join(tempDir, '.wrangler/state'),
        '--var',
        'RUNTIME_STARTUP_MODE:downloaded',
        '--var',
        'NATIVE_RUNTIME_IMAGE:runtime-free',
        '--var',
        `RUNTIME_RELEASE_DESCRIPTOR:${'a'.repeat(64)}`,
        '--var',
        `RUNTIME_RELEASE_DESCRIPTOR_KILO2:${'b'.repeat(64)}`,
      ]);
    }
  );
});
