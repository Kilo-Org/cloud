import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { promisify } from 'node:util';

import { runtimeArtifactHttpPathPattern } from '../src/shared/runtime-release.js';

const exec = promisify(execFile);

export type ForwarderCertificate = { keyPath: string; certPath: string };

/** The generated local certificate is valid for one day; refresh before an hour remains. */
const CERT_DAYS = 1;
const CERT_MIN_REMAINING_SECONDS = 3_600;

/**
 * Generate the self-signed certificate the local HTTPS artifact forwarder
 * terminates TLS with. The certificate's subject alternative names cover
 * `host.docker.internal`, the host name a sandbox container uses to reach the
 * host, plus loopback. It is a leaf that also acts as its own trust root, which
 * is what makes it usable directly as `NODE_EXTRA_CA_CERTS`.
 */
export async function generateForwarderCertificate(
  dir: string,
  options: { days?: number } = {}
): Promise<ForwarderCertificate> {
  await fs.mkdir(dir, { recursive: true });
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  await exec('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    String(options.days ?? CERT_DAYS),
    '-subj',
    '/CN=host.docker.internal',
    '-addext',
    'subjectAltName=DNS:host.docker.internal,IP:127.0.0.1',
  ]);
  return { keyPath, certPath };
}

/**
 * The managed pair is only reused when it is present, the key matches the
 * certificate, and the certificate outlives `minRemainingSeconds`. A one-day
 * certificate would otherwise silently break a stack left running past its
 * expiry (TLS failure inside the container).
 */
async function forwarderCertificateIsUsable(
  dir: string,
  minRemainingSeconds: number
): Promise<boolean> {
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  if (!fsSync.existsSync(keyPath) || !fsSync.existsSync(certPath)) return false;
  try {
    await exec('openssl', [
      'x509',
      '-checkend',
      String(minRemainingSeconds),
      '-noout',
      '-in',
      certPath,
    ]);
    const [certModulus, keyModulus] = await Promise.all([
      exec('openssl', ['x509', '-noout', '-modulus', '-in', certPath]),
      exec('openssl', ['rsa', '-noout', '-modulus', '-in', keyPath]),
    ]);
    return certModulus.stdout === keyModulus.stdout;
  } catch {
    return false;
  }
}

/**
 * Return the tool-owned forwarder certificate/key paths, regenerating them when
 * either file is missing, the key does not match the certificate, or the
 * certificate expires within `minRemainingSeconds`. It writes only the directory
 * it is given (the cold-local tooling passes its own private `.wrangler`
 * directory).
 */
export async function ensureValidForwarderCertificate(
  dir: string,
  options: { days?: number; minRemainingSeconds?: number } = {}
): Promise<ForwarderCertificate> {
  if (
    await forwarderCertificateIsUsable(
      dir,
      options.minRemainingSeconds ?? CERT_MIN_REMAINING_SECONDS
    )
  ) {
    return { keyPath: path.join(dir, 'key.pem'), certPath: path.join(dir, 'cert.pem') };
  }
  return generateForwarderCertificate(dir, { days: options.days });
}

export type Forwarder = {
  origin: string;
  port: number;
  requests: string[];
  close: () => Promise<void>;
};

/**
 * HTTPS forwarder to the live Worker route. It terminates TLS with the local
 * certificate and proxies each object request upstream with the caller's grant;
 * it never holds or serves artifact bytes of its own, so the trust decision
 * (which origin the launch may fetch from) stays in the provider.
 *
 * Shared by the runtime-upgrade driver and the cold-local tooling.
 */
export async function startHttpsForwarder(
  workerUrl: string,
  keyPath: string,
  certPath: string,
  listenPort = 0
): Promise<Forwarder> {
  const requests: string[] = [];
  const server = https.createServer(
    { key: fsSync.readFileSync(keyPath), cert: fsSync.readFileSync(certPath) },
    (request, response) => {
      const pathname = request.url ?? '/';
      const match = runtimeArtifactHttpPathPattern().exec(pathname);
      if (!match) {
        response.writeHead(404);
        response.end();
        return;
      }
      requests.push(match[1]);
      fetch(`${workerUrl.replace(/\/$/, '')}${pathname}`, {
        headers: { Authorization: request.headers.authorization ?? '' },
      })
        .then(async upstream => {
          const body = Buffer.from(await upstream.arrayBuffer());
          response.writeHead(upstream.status, {
            'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
            'Content-Length': String(body.byteLength),
          });
          response.end(body);
        })
        .catch(() => {
          response.writeHead(502);
          response.end();
        });
    }
  );
  await new Promise<void>(resolve => server.listen(listenPort, '0.0.0.0', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `https://host.docker.internal:${port}`,
    port,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
