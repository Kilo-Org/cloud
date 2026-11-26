import type { StsCanaryReport } from '@kilocode/sts-contracts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unstable_readConfig, unstable_startWorker } from 'wrangler';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { serviceClaims, signToken, testSigner, type TestSigner } from './sts-canary.test-fixture';

// The canary in local workerd: the scheduled handler mints over a real service binding (a
// stand-in SecretsBroker), calls a node stand-in of the web route, which calls the Worker's verify
// route back with its own token and with the token it received; the Worker fetches the key set
// over HTTP from the same node server, as it fetches STS's in a deployment.

type Logged = { level: string; message: string };

let signer: TestSigner;
let server: Server;
let base: string;
let directory: string;
let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
let workerUrl: string;
const logs: Logged[] = [];
const webCalls: { authorization: string | undefined; run: string | undefined }[] = [];

async function verifyAtWorker(token: string): Promise<number> {
  const response = await fetch(`${workerUrl}/sts-canary/verify`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  await response.body?.cancel();
  return response.status;
}

/** The web route, reduced to what this test needs: it trusts the caller and checks usage-ingest. */
async function webRoute(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const authorization = request.headers.authorization;
  webCalls.push({ authorization, run: request.headers['x-sts-canary-run'] as string | undefined });
  const inbound = authorization?.replace(/^Bearer /, '') ?? '';
  const own = await signToken(
    signer,
    serviceClaims({
      issuer: base,
      workload: 'web',
      audience: 'usage-ingest',
      scope: 'usage-ingest:sts.canary',
    })
  );
  const outbound = await verifyAtWorker(own);
  const wrongAudience = await verifyAtWorker(inbound);
  const report: StsCanaryReport = {
    inbound: 'ok',
    outbound: { result: outbound === 204 ? 'ok' : 'failed', status: outbound },
    negatives: {
      wrongAudience: { result: wrongAudience === 403 ? 'ok' : 'failed', status: wrongAudience },
      forged: { result: 'ok', status: 401 },
      expired: 'skipped',
    },
  };
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(report));
}

beforeAll(async () => {
  signer = await testSigner('runtime-kid');
  server = createServer((request, response) => {
    if (request.url === '/.well-known/jwks.json') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(signer.jwks));
      return;
    }
    if (request.url === '/api/internal/sts-canary' && request.method === 'POST') {
      void webRoute(request, response);
      return;
    }
    response.writeHead(404).end();
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  directory = await mkdtemp(join(tmpdir(), 'usage-ingest-sts-canary-'));
  const service = unstable_readConfig({
    config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href),
  });
  const name = 'usage-ingest-sts-canary-runtime-test';
  const config = join(directory, 'wrangler.json');
  await writeFile(
    config,
    JSON.stringify({
      name,
      main: fileURLToPath(new URL('./sts-canary.runtime-fixture.ts', import.meta.url).href),
      compatibility_date: service.compatibility_date,
      compatibility_flags: service.compatibility_flags,
      vars: {
        STS_CANARY_ENABLED: 'true',
        STS_URL: base,
        STS_ENVIRONMENT: 'production',
        WEB_STS_CANARY_URL: `${base}/api/internal/sts-canary`,
        // Node exports `alg: "Ed25519"`, which workerd's importKey refuses for an Ed25519 key.
        TEST_SIGNING_JWK: JSON.stringify({
          ...(await crypto.subtle.exportKey('jwk', signer.privateKey)),
          alg: undefined,
        }),
        TEST_SIGNING_KID: signer.kid,
      },
      services: [{ binding: 'STS', service: name, entrypoint: 'SecretsBroker' }],
    })
  );
  worker = await unstable_startWorker({
    config,
    dev: {
      remote: false,
      persist: false,
      server: { hostname: '127.0.0.1', port: 0 },
      inspector: false,
      watch: false,
      // Serves GET /__scheduled, which runs the scheduled handler and answers once it is done.
      testScheduled: true,
      structuredLogsHandler: (log: Logged) => logs.push(log),
    },
  });
  workerUrl = (await worker.url).origin;
}, 60_000);

afterAll(async () => {
  await worker?.dispose();
  const closed = Promise.withResolvers<void>();
  server?.close(() => closed.resolve());
  await closed.promise;
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('runs the scheduled canary end to end and logs one succeeded event', async () => {
  const result = await worker.fetch('http://usage-ingest.test/__scheduled?cron=*/5+*+*+*+*');
  expect(result.status).toBe(200);
  await result.text();

  expect(webCalls, JSON.stringify(logs.map(log => log.message))).toHaveLength(1);
  expect(webCalls[0].authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  const events = logs
    .map(log => {
      try {
        return JSON.parse(log.message) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(event => event?.event_name === 'scheduled_job.completed');
  expect(events).toEqual([
    expect.objectContaining({
      job_name: 'usage_ingest.sts_canary',
      outcome: 'succeeded',
      run_id: webCalls[0].run,
      mint_result: 'issued',
      outbound_status: 204,
      negative_wrong_audience_status: 403,
    }),
  ]);
  expect(logs.filter(log => /different request/.test(log.message))).toEqual([]);
  const token = webCalls[0].authorization?.slice('Bearer '.length) ?? '';
  expect(logs.some(log => log.message.includes(token))).toBe(false);
}, 30_000);
