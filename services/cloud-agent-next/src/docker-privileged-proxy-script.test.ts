import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net, { type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serviceDir = path.resolve(testDir, '..');
const scriptPath = path.join(serviceDir, 'scripts/docker-privileged-proxy.mjs');
const childProcesses: ChildProcess[] = [];
const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    child.kill('SIGTERM');
  }
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.close(() => resolve());
        })
    )
  );
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function waitForSocket(socketPath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(socketPath)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Socket was not created: ${socketPath}`);
}

function readRequestBody(request: Buffer): unknown {
  const headerEnd = request.indexOf('\r\n\r\n');
  if (headerEnd === -1) throw new Error('Request headers were incomplete');
  return JSON.parse(request.subarray(headerEnd + 4).toString('utf8'));
}

async function startProxy(): Promise<{ proxySocket: string; request: Promise<Buffer> }> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-agent-privileged-proxy-test-'));
  tempDirs.push(tempDir);
  const upstreamSocket = path.join(tempDir, 'upstream.sock');
  const proxySocket = path.join(tempDir, 'proxy.sock');

  let resolveRequest: (request: Buffer) => void = () => {};
  const request = new Promise<Buffer>(resolve => {
    resolveRequest = resolve;
  });
  const upstream = net.createServer(socket => {
    let received = Buffer.alloc(0);
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      const headerEnd = received.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = received.subarray(0, headerEnd).toString('utf8');
      const contentLength = header.match(/\r\nContent-Length:\s*(\d+)/i);
      if (!contentLength) return;
      const requestLength = headerEnd + 4 + Number(contentLength[1]);
      if (received.length < requestLength) return;

      resolveRequest(received.subarray(0, requestLength));
      socket.end('HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\n{}');
    });
  });
  servers.push(upstream);
  await listen(upstream, upstreamSocket);

  const child = spawn(process.execPath, [scriptPath], {
    cwd: serviceDir,
    env: { ...process.env, DOCKER_PROXY_SOCKET: proxySocket, DOCKER_SOCKET: upstreamSocket },
    stdio: 'ignore',
  });
  childProcesses.push(child);
  await waitForSocket(proxySocket);

  return { proxySocket, request };
}

function sendCreateRequest(proxySocket: string, name: string, image: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ Image: image, HostConfig: { PidMode: 'host' } });
    const socket = net.createConnection(proxySocket, () => {
      socket.write(
        `POST /v1.48/containers/create?name=${encodeURIComponent(name)} HTTP/1.1\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
      );
    });
    socket.once('error', reject);
    socket.once('end', resolve);
    socket.resume();
  });
}

describe('docker-privileged-proxy.mjs', () => {
  it('leaves ordinary sandbox creates unprivileged', async () => {
    const proxy = await startProxy();

    await sendCreateRequest(
      proxy.proxySocket,
      'workerd-cloud-agent-next-dev-SandboxSmall-session',
      'cloudflare-dev/sandboxsmall:test'
    );

    expect(readRequestBody(await proxy.request)).toEqual({
      Image: 'cloudflare-dev/sandboxsmall:test',
      HostConfig: { PidMode: 'host' },
    });
  });

  it('makes SandboxDIND creates privileged', async () => {
    const proxy = await startProxy();

    await sendCreateRequest(
      proxy.proxySocket,
      'workerd-cloud-agent-next-dev-SandboxDIND-session',
      'cloudflare-dev/sandboxdind:test'
    );

    expect(readRequestBody(await proxy.request)).toEqual({
      Image: 'cloudflare-dev/sandboxdind:test',
      HostConfig: { PidMode: 'host', Privileged: true },
    });
  });

  it('leaves SandboxDIND proxy sidecars unprivileged', async () => {
    const proxy = await startProxy();

    await sendCreateRequest(
      proxy.proxySocket,
      'workerd-cloud-agent-next-dev-SandboxDIND-session-proxy',
      'cloudflare/proxy-everything:test'
    );

    expect(readRequestBody(await proxy.request)).toEqual({
      Image: 'cloudflare/proxy-everything:test',
      HostConfig: { PidMode: 'host' },
    });
  });

  it('requires the SandboxDIND container name before granting privilege', async () => {
    const proxy = await startProxy();

    await sendCreateRequest(
      proxy.proxySocket,
      'workerd-cloud-agent-next-dev-SandboxSmall-session',
      'cloudflare-dev/sandboxdind:test'
    );

    expect(readRequestBody(await proxy.request)).toEqual({
      Image: 'cloudflare-dev/sandboxdind:test',
      HostConfig: { PidMode: 'host' },
    });
  });
});
