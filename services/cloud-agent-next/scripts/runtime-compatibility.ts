import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { renderRuntimeBootstrap } from '../src/sandbox-control/runtime-bootstrap.js';
import { serializeRuntimeRelease } from '../src/sandbox-control/runtime-release.js';
import { CONTROL_PLANE_PROTOCOL_VERSION } from '../src/shared/control-plane-protocol.js';
import type { PackagedRuntime } from './publish-runtime.js';
import type { RuntimeBase } from './runtime-base.js';

/** Bound the Docker client even when it ignores normal termination. */
export function runCompatibilityProcess(
  args: string[],
  cwd: string,
  deadlineAt: number
): Promise<number | null> {
  return new Promise(resolve => {
    const child = spawn('docker', args, { cwd, stdio: 'ignore' });
    const timeout = setTimeout(
      () => {
        child.kill('SIGKILL');
        child.unref();
        resolve(null);
      },
      Math.max(1, deadlineAt - Date.now())
    );
    child.once('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
    child.once('close', code => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

/** Run the selected CLI probe and real wrapper handshake on the exact base digest. */
export async function verifyRuntimeCompatibility(
  base: RuntimeBase,
  packaged: PackagedRuntime,
  packageRoot: string
): Promise<void> {
  if (packaged.descriptor.protocol !== String(CONTROL_PLANE_PROTOCOL_VERSION))
    throw new Error('Runtime descriptor protocol differs from this source');
  const grant = randomUUID();
  const credential = randomUUID();
  const allocationId = randomUUID();
  let hello = false;
  let failed = false;
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://local.test').pathname;
    // The bootstrap reports with the launch credential; other reports fall through to 401.
    if (
      pathname === '/startup-failure' &&
      request.headers.authorization === 'Bearer ' + credential
    ) {
      failed = true;
      response.writeHead(204).end();
      return;
    }
    const payload = [packaged.cli, packaged.control].find(
      value => pathname === '/objects/' + value.sha256
    );
    if (request.headers.authorization !== 'Bearer ' + grant || !payload) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/zstd',
      'Content-Length': payload.bytes.byteLength,
    });
    response.end(payload.bytes);
  });
  const sockets = new WebSocketServer({ noServer: true });
  const helloSchema = z.object({
    type: z.literal('hello'),
    allocationId: z.literal(allocationId),
    protocolVersion: z.literal(CONTROL_PLANE_PROTOCOL_VERSION),
  });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/control' || request.headers.authorization !== 'Bearer ' + credential) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, connection => {
      connection.on('error', () => {
        failed = true;
      });
      connection.on('message', bytes => {
        try {
          const data = Array.isArray(bytes)
            ? Buffer.concat(bytes)
            : bytes instanceof ArrayBuffer
              ? Buffer.from(bytes)
              : bytes;
          const frame: unknown = JSON.parse(data.toString('utf8'));
          if (!helloSchema.safeParse(frame).success) {
            failed = true;
            connection.close();
            return;
          }
          hello = true;
          connection.send(
            JSON.stringify({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION })
          );
          connection.send(
            JSON.stringify({ type: 'shutdown', reason: 'runtime compatibility verified' })
          );
        } catch {
          failed = true;
          connection.close();
        }
      });
    });
  });
  const name = 'kilo-runtime-verify-' + randomUUID();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Runtime verifier did not bind');
    const origin = 'http://host.docker.internal:' + address.port;
    const command = renderRuntimeBootstrap({
      descriptor: new TextDecoder().decode(serializeRuntimeRelease(packaged.descriptor)),
      artifactBaseUrl: origin + '/objects/',
      reportUrl: origin + '/startup-failure',
      allocationId,
      grant,
      deadlineAt: Date.now() + 180_000,
    });
    const args = [
      'run',
      '--rm',
      '--name',
      name,
      '--platform',
      base.platform,
      '--add-host',
      'host.docker.internal:host-gateway',
      '--env',
      'SANDBOX_CONTROL_URL=ws://host.docker.internal:' + address.port + '/control',
      '--env',
      'SANDBOX_CONTROL_CREDENTIAL=' + credential,
      '--env',
      'CONTROL_PLANE_ALLOCATION_ID=' + allocationId,
      '--entrypoint',
      command.argv[0],
      base.image,
      ...command.argv.slice(1),
    ];
    const code = await runCompatibilityProcess(args, packageRoot, Date.now() + 200_000);
    if (code !== 0 || !hello || failed)
      throw new Error('Runtime payloads are incompatible with the selected base');
  } finally {
    spawnSync('docker', ['rm', '-f', name], {
      stdio: 'ignore',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    for (const connection of sockets.clients) connection.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
