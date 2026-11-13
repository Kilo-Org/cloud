// A dev-only stand-in for the Snowflake SQL API v2 that the usage dashboard
// reads. Nothing here is imported by `apps/web`: this is test tooling that
// answers the router's statements from the fixture rows
// `pnpm dev:seed usage:usage-rows` writes, so `/usage` and the mobile usage
// screen can be exercised without warehouse credentials.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';

import { answerStatement, loadFixtureRows, type SnowflakeBinding } from './warehouse';

const PORT = Number(process.env.MOCK_SNOWFLAKE_PORT ?? 4792);
const HOST = '127.0.0.1';
const BASE_URL = `https://${HOST}:${PORT}`;

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');
const tlsDir = join(fixturesDir, 'tls');

/**
 * A self-signed certificate that Node can also trust as a CA, so the web app
 * can reach this server with `NODE_EXTRA_CA_CERTS` instead of disabling
 * verification for every host it talks to.
 */
function loadTls(): { key: Buffer; cert: Buffer } {
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
 * with this generated key; the mock never verifies it.
 */
function writeEnvSnippet(): string {
  const envPath = join(fixturesDir, 'snowflake-env.txt');
  if (existsSync(envPath)) {
    return envPath;
  }
  mkdirSync(fixturesDir, { recursive: true });
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  // dotenv keeps a multi-line value on one line, so the newlines are escaped.
  const pem = privateKey.replaceAll('\n', '\\n');
  const block = [
    `SNOWFLAKE_ACCOUNT_HOST=${HOST}:${PORT}`,
    'SNOWFLAKE_JWT_ACCOUNT_IDENTIFIER=localtest',
    'SNOWFLAKE_USERNAME=local',
    'SNOWFLAKE_ROLE=ACCOUNTADMIN',
    'SNOWFLAKE_WAREHOUSE=local',
    'SNOWFLAKE_DATABASE=local',
    'SNOWFLAKE_SCHEMA=PUBLIC',
    `SNOWFLAKE_PRIVATE_KEY_PEM=${pem}`,
    'SNOWFLAKE_PUBLIC_KEY_FINGERPRINT=local',
    '',
  ].join('\n');
  writeFileSync(envPath, block, { mode: 0o600 });
  return envPath;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

type StatementRequest = {
  statement?: string;
  bindings?: Record<string, SnowflakeBinding>;
};

function handleStatement(body: StatementRequest, response: ServerResponse): void {
  if (!body.statement) {
    send(response, 400, { code: '390100', message: 'A statement is required.' });
    return;
  }
  const rows = answerStatement(body.statement, body.bindings ?? {}, loadFixtureRows(fixturesDir));
  // One partition and no polling: the client returns these rows directly.
  send(response, 200, {
    code: '090001',
    resultSetMetaData: { format: 'jsonv2', numRows: rows.length, partitionInfo: [{}] },
    data: rows,
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', BASE_URL);

  if (request.method === 'GET' && url.pathname === '/health') {
    send(response, 200, { status: 'ok' });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/v2/statements') {
    handleStatement(JSON.parse(await readBody(request)) as StatementRequest, response);
    return;
  }

  send(response, 404, { code: '000000', message: `No mock route for ${url.pathname}.` });
}

const server = createServer(loadTls(), (request, response) => {
  handleRequest(request, response).catch(error => {
    console.error(`${request.method} ${request.url} failed`, error);
    if (!response.headersSent) {
      send(response, 500, { code: '000000', message: String(error) });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`mock Snowflake listening on ${BASE_URL}`);
  console.log(`fixture rows: ${join(fixturesDir, '*.json')}`);
  console.log(`environment block: ${writeEnvSnippet()}`);
  console.log('Append that file, then this line, to the repo-root .env.local:');
  console.log(`NODE_EXTRA_CA_CERTS=${join(tlsDir, 'cert.pem')}`);
  console.log('Then start the web app with `pnpm dev:start app`. The web dev script');
  console.log('exports that CA before next dev, so the app trusts this server alone.');
});
