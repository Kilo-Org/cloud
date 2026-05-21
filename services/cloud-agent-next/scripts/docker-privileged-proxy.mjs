// Docker socket proxy that injects HostConfig.Privileged=true into
// `POST /containers/create` requests.
//
// Why this exists
// ---------------
// Cloudflare Containers run our `SandboxSmall` image (Docker-in-Docker)
// privileged in production, but local `wrangler dev` has no supported way
// to set Docker container create options like `HostConfig.Privileged=true`.
// Without that, rootless dockerd inside the Sandbox container fails to set
// up its mounts and `/var/run/docker.sock` never appears.
//
// Workaround: run a small Unix-socket proxy on the developer machine that
// forwards Docker API calls to the host's real Docker socket and rewrites
// `POST /containers/create` bodies to set `HostConfig.Privileged=true`.
// `pnpm dev` then runs Wrangler with `DOCKER_HOST` pointed at this proxy.
//
// This matches the workaround documented in cloudflare/sandbox-sdk#662 and
// the `sandbox-dind-repro` reference repository.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function normalizeSocket(socket) {
  return socket?.startsWith('unix://') ? socket.slice('unix://'.length) : socket;
}

function getDockerContextSocket() {
  try {
    const socket = execFileSync(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    ).trim();

    return normalizeSocket(socket);
  } catch {
    return undefined;
  }
}

const listenPath =
  process.env.DOCKER_PROXY_SOCKET ?? path.join(process.cwd(), '.wrangler/docker-privileged.sock');
const targetPath =
  normalizeSocket(process.env.DOCKER_SOCKET) ?? getDockerContextSocket() ?? '/var/run/docker.sock';

fs.mkdirSync(path.dirname(listenPath), { recursive: true });
try {
  fs.unlinkSync(listenPath);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const server = net.createServer(client => {
  let buffered = Buffer.alloc(0);
  let patched = false;
  const upstream = net.createConnection(targetPath);

  upstream.on('data', chunk => client.write(chunk));
  upstream.on('error', error => {
    console.error(`Docker upstream error: ${error.message}`);
    client.destroy();
  });
  client.on('error', () => upstream.destroy());
  client.on('end', () => upstream.end());
  upstream.on('end', () => client.end());

  client.on('data', chunk => {
    if (patched) {
      upstream.write(chunk);
      return;
    }

    buffered = Buffer.concat([buffered, chunk]);
    const headerEnd = buffered.indexOf('\r\n\r\n');

    if (headerEnd === -1) return;

    const header = buffered.slice(0, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const match = header.match(/^POST\s+\S*\/containers\/create(?:\?|\s)/);
    const contentLength = header.match(/\r\nContent-Length:\s*(\d+)/i);

    if (!match || !contentLength) {
      patched = true;
      upstream.write(buffered);
      return;
    }

    const length = Number(contentLength[1]);
    if (buffered.length < bodyStart + length) return;

    const body = buffered.slice(bodyStart, bodyStart + length).toString('utf8');
    const rest = buffered.slice(bodyStart + length);

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      patched = true;
      upstream.write(buffered);
      return;
    }

    payload.HostConfig = { ...payload.HostConfig, Privileged: true };
    const nextBody = Buffer.from(JSON.stringify(payload));
    const nextHeader = header.replace(/(\r\nContent-Length:\s*)\d+/i, `$1${nextBody.length}`);

    patched = true;
    upstream.write(Buffer.concat([Buffer.from(`${nextHeader}\r\n\r\n`), nextBody, rest]));
  });
});

server.listen(listenPath, () => {
  if (os.platform() !== 'win32') fs.chmodSync(listenPath, 0o600);
  console.log(`Docker privileged proxy listening on ${listenPath}`);
  console.log(`Forwarding to ${targetPath}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
