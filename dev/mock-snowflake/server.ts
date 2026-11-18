// A dev-only stand-in for the Snowflake SQL API v2 that the usage dashboard
// reads. Nothing here is imported by `apps/web`: this is test tooling that
// answers the router's statements from the fixture rows
// `pnpm dev:seed usage:usage-rows` writes, so `/usage` and the mobile usage
// screen can be exercised without warehouse credentials.

import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { HOST, PORT, caBundlePath, fixturesDir, loadTls, writeEnvSnippet } from './tls-env';
import { answerStatement, loadFixtureRows, type SnowflakeBinding } from './warehouse';

const BASE_URL = `https://${HOST}:${PORT}`;

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

/**
 * Standalone entry (`pnpm dev:mock-snowflake`) and the local-stack service
 * entry (`stack-service.ts`) share this: prepare the TLS key pair and the
 * fixture env block for the port the server listens on, then listen.
 */
export async function startMockSnowflake(): Promise<Server> {
  const tls = loadTls();
  const envPath = writeEnvSnippet(PORT);

  const server = createServer(tls, (request, response) => {
    handleRequest(request, response).catch(error => {
      console.error(`${request.method} ${request.url} failed`, error);
      if (!response.headersSent) {
        send(response, 500, { code: '000000', message: String(error) });
      }
    });
  });

  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(PORT, HOST, () => {
    console.log(`mock Snowflake listening on ${BASE_URL}`);
    console.log(`fixture rows: ${join(fixturesDir, '*.json')}`);
    console.log(`environment block: ${envPath}`);
    console.log('The local stack wires these into .env.local and exports the CA bundle:');
    console.log(`NODE_EXTRA_CA_CERTS=${caBundlePath()}`);
    console.log('to next dev. By hand, name the certificate (dev/mock-snowflake/README.md):');
    console.log(`NODE_EXTRA_CA_CERTS=${join(fixturesDir, 'tls', 'cert.pem')}`);
    resolve();
  });
  await promise;
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startMockSnowflake().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
