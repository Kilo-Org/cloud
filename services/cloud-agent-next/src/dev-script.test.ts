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

describe('dev.sh', () => {
  it.each([
    { endpoint: 'socket' },
    { endpoint: 'socket-url' },
    { endpoint: 'host' },
    { endpoint: 'context' },
  ])('preserves Docker routing and ARM support: $endpoint', ({ endpoint }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-agent-dev-script-test-'));
    tempDirs.push(tempDir);
    const binDir = path.join(tempDir, 'bin');
    fs.mkdirSync(binDir);
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
    writeExecutable(
      path.join(binDir, 'wrangler'),
      `#!/bin/sh
printf '%s\\n' "MINIFLARE_CONTAINER_EGRESS_IMAGE=$MINIFLARE_CONTAINER_EGRESS_IMAGE" "DOCKER_HOST=$DOCKER_HOST" "$@" > "${wranglerEnvLog}"
`
    );

    const wranglerArgs = ['--env', 'dev', '--port', '11694', '--var', 'EXAMPLE:two words'];
    execFileSync('sh', [scriptPath, ...wranglerArgs], {
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

    expect(fs.readFileSync(dockerProbeLog, 'utf8')).toContain(`DOCKER_HOST=${expectedDockerHost}`);
    const wranglerEnv = fs.readFileSync(wranglerEnvLog, 'utf8');
    expect(wranglerEnv).toContain(
      'MINIFLARE_CONTAINER_EGRESS_IMAGE=cloudflare/proxy-everything:3cb1195'
    );
    expect(wranglerEnv.trim().split('\n').slice(1)).toEqual([
      `DOCKER_HOST=${expectedDockerHost}`,
      'dev',
      ...wranglerArgs,
    ]);
  });
});
