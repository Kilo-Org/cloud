import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { handleRequest, type HandlerDeps } from './handlers';
import { createKmsApi } from './kms';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const PORT = Number(process.env.BYOK_KMS_SERVICE_PORT ?? 8901);
const HOST = '127.0.0.1';
const KMS_ENDPOINT = process.env.BYOK_KMS_ENDPOINT ?? 'http://127.0.0.1:8900';
const MAX_BODY_BYTES = 64 * 1024;

const deps: HandlerDeps = {
  kms: createKmsApi({
    endpoint: KMS_ENDPOINT,
    region: process.env.AWS_REGION ?? 'eu-west-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'local',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
  }),
  kmsKeyId: process.env.BYOK_KMS_KEY_ID ?? 'alias/byok-local',
  serviceToken: process.env.BYOK_KMS_SERVICE_TOKEN ?? 'dev-byok-kms-token',
  log: event => console.log(JSON.stringify({ event: 'byok_kms.data_key', ...event })),
};

async function handle(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      response.writeHead(413).end();
      request.destroy();
      return;
    }
    chunks.push(buffer);
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    body = undefined;
  }

  let url: URL;
  try {
    url = new URL(request.url ?? '/', `http://${HOST}`);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const result = await handleRequest(deps, {
    method: request.method ?? 'GET',
    path: url.pathname,
    authorization: request.headers.authorization,
    body,
  });
  const payload = JSON.stringify(result.body);
  response.writeHead(result.status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

const server = createServer(async (request, response) => {
  try {
    await handle(request, response);
  } catch (error) {
    console.error('byok-kms request failed:', error instanceof Error ? error.message : error);
    if (response.headersSent) response.destroy();
    else response.writeHead(500).end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`BYOK KMS dev service on http://${HOST}:${PORT} (KMS ${KMS_ENDPOINT})`);
  console.log(`Set BYOK_KMS_SERVICE_URL=http://${HOST}:${PORT}`);
  console.log('Set BYOK_KMS_SERVICE_TOKEN to the configured service token');
});
