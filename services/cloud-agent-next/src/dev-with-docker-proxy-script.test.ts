import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serviceDir = path.resolve(testDir, '..');
const repoRoot = path.resolve(serviceDir, '../..');
const scriptPath = path.join(serviceDir, 'scripts/dev-with-docker-proxy.sh');
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

describe('dev-with-docker-proxy.sh', () => {
  it('probes Docker architecture through DOCKER_SOCKET when provided', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-agent-docker-proxy-test-'));
    tempDirs.push(tempDir);
    const binDir = path.join(tempDir, 'bin');
    fs.mkdirSync(binDir);
    const dockerSocket = path.join(tempDir, 'upstream.sock');
    const proxySocket = path.join(tempDir, 'proxy.sock');
    const wranglerEnvLog = path.join(tempDir, 'wrangler-env.log');
    const dockerProbeLog = path.join(tempDir, 'docker-probe.log');

    writeExecutable(
      path.join(binDir, 'docker'),
      `#!/bin/sh
printf '%s\\n' "DOCKER_HOST=$DOCKER_HOST DOCKER_SOCKET=$DOCKER_SOCKET $*" >> "${dockerProbeLog}"
if [ "$1" = "info" ] && [ "$DOCKER_HOST" = "unix://${dockerSocket}" ]; then
  printf '%s\\n' arm64
else
  printf '%s\\n' x86_64
fi
`
    );
    writeExecutable(
      path.join(binDir, 'node'),
      `#!/bin/sh
exec "${process.execPath}" -e '
const net = require("node:net");
const socket = process.env.DOCKER_PROXY_SOCKET;
const server = net.createServer(() => {});
server.listen(socket);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
setTimeout(() => process.exit(0), 5000);
' >/dev/null 2>&1
`
    );
    writeExecutable(
      path.join(binDir, 'wrangler'),
      `#!/bin/sh
printf '%s\\n' "MINIFLARE_CONTAINER_EGRESS_IMAGE=$MINIFLARE_CONTAINER_EGRESS_IMAGE" > "${wranglerEnvLog}"
`
    );

    execFileSync('sh', [scriptPath, '--env', 'dev'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DOCKER_PROXY_SOCKET: proxySocket,
        DOCKER_SOCKET: dockerSocket,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });

    expect(fs.readFileSync(dockerProbeLog, 'utf8')).toContain(`DOCKER_HOST=unix://${dockerSocket}`);
    expect(fs.readFileSync(wranglerEnvLog, 'utf8')).toContain(
      'MINIFLARE_CONTAINER_EGRESS_IMAGE=cloudflare/proxy-everything:3cb1195'
    );
  });
});
