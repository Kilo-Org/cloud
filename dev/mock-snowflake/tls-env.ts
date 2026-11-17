// TLS key pair and fixture env block shared by the standalone mock server
// (`server.ts`) and the local-stack service entry (`stack-service.ts`).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEnvEntries } from './env-file';

export const MOCK_SNOWFLAKE_PORT = 4792;
export const PORT = Number(process.env.MOCK_SNOWFLAKE_PORT ?? MOCK_SNOWFLAKE_PORT);
export const HOST = '127.0.0.1';

const here = dirname(fileURLToPath(import.meta.url));
export const fixturesDir = join(here, 'fixtures');
export const tlsDir = join(fixturesDir, 'tls');

/**
 * A self-signed certificate that Node can also trust as a CA, so the web app
 * can reach this server with `NODE_EXTRA_CA_CERTS` instead of disabling
 * verification for every host it talks to.
 */
export function loadTls(): { key: Buffer; cert: Buffer } {
  const keyPath = join(tlsDir, 'key.pem');
  const certPath = join(tlsDir, 'cert.pem');
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    mkdirSync(tlsDir, { recursive: true });
    execFileSync(
      'openssl',
      [
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
        '365',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
        '-addext',
        'extendedKeyUsage=serverAuth',
      ],
      { stdio: 'ignore' }
    );
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

/**
 * The environment block a local web server needs. The JWT is signed locally
 * with this key; the mock never verifies it. An existing block's key is reused,
 * so a restart with the same port rewrites the file with identical text and the
 * `.env.local` section that quotes it needs no change. The block always names
 * the port the server actually listens on, so changing `MOCK_SNOWFLAKE_PORT`
 * rewrites it instead of leaving a stale host behind.
 */
export function writeEnvSnippet(port: number): string {
  const envPath = join(fixturesDir, 'snowflake-env.txt');
  let pem = existsSync(envPath)
    ? parseEnvEntries(readFileSync(envPath, 'utf8')).find(
        entry => entry.key === 'SNOWFLAKE_PRIVATE_KEY_PEM'
      )?.value
    : undefined;
  if (pem === undefined) {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    pem = privateKey;
  }
  // dotenv keeps a multi-line value on one line, so the newlines are escaped.
  const escapedPem = pem.replaceAll('\n', '\\n');
  const block = [
    `SNOWFLAKE_ACCOUNT_HOST=${HOST}:${port}`,
    'SNOWFLAKE_JWT_ACCOUNT_IDENTIFIER=localtest',
    'SNOWFLAKE_USERNAME=local',
    'SNOWFLAKE_ROLE=ACCOUNTADMIN',
    'SNOWFLAKE_WAREHOUSE=local',
    'SNOWFLAKE_DATABASE=local',
    'SNOWFLAKE_SCHEMA=PUBLIC',
    `SNOWFLAKE_PRIVATE_KEY_PEM=${escapedPem}`,
    'SNOWFLAKE_PUBLIC_KEY_FINGERPRINT=local',
    '',
  ].join('\n');
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(envPath, block, { mode: 0o600 });
  return envPath;
}

/** Absolute path of the CA certificate the web dev script must trust. */
export function caCertPath(): string {
  return join(tlsDir, 'cert.pem');
}

/**
 * Absolute path of the CA bundle the stack entry writes and wires into
 * `.env.local`. It holds `cert.pem` first and then every CA file the developer's
 * environment already trusted, because that one variable can only name one file.
 */
export function caBundlePath(): string {
  return join(tlsDir, 'ca-bundle.pem');
}
