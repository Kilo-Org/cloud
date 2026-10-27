import { existsSync } from 'node:fs';
import { createServer } from 'node:http';

import { handleRequest } from './handlers';
import { createKmsApi } from './kms';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const PORT = Number(process.env.BYOK_KMS_SERVICE_PORT ?? 8901);
const HOST = '127.0.0.1';
const KMS_ENDPOINT = process.env.BYOK_KMS_ENDPOINT ?? 'http://127.0.0.1:8900';
const MAX_BODY_BYTES = 64 * 1024;

const transportKeyBase64 =
  process.env.BYOK_KMS_TRANSPORT_ENCRYPTION_KEY?.trim() || process.env.BYOK_ENCRYPTION_KEY?.trim();
if (!transportKeyBase64) {
  throw new Error('Set BYOK_KMS_TRANSPORT_ENCRYPTION_KEY or BYOK_ENCRYPTION_KEY in .env.local');
}
const transportKey = Buffer.from(transportKeyBase64, 'base64');
if (transportKey.length !== 32) {
  throw new Error('The BYOK transport key must be a base64 32-byte value');
}

const deps = {
  kms: createKmsApi({
    endpoint: KMS_ENDPOINT,
    region: process.env.AWS_REGION ?? 'eu-west-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'local',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
  }),
  kmsKeyId: process.env.BYOK_KMS_KEY_ID ?? 'alias/byok-local',
  serviceToken: process.env.BYOK_KMS_SERVICE_TOKEN ?? 'dev-byok-kms-token',
  transportKey,
};

const server = createServer(async (request, response) => {
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

  const result = await handleRequest(deps, {
    method: request.method ?? 'GET',
    path: new URL(request.url ?? '/', `http://${HOST}`).pathname,
    authorization: request.headers.authorization,
    body,
  });
  const payload = JSON.stringify(result.body);
  response.writeHead(result.status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
});

server.listen(PORT, HOST, () => {
  console.log(`BYOK KMS dev service on http://${HOST}:${PORT} (KMS ${KMS_ENDPOINT})`);
  console.log(`Set BYOK_KMS_SERVICE_URL=http://${HOST}:${PORT}`);
  console.log(`Set BYOK_KMS_SERVICE_TOKEN=${deps.serviceToken}`);
});
