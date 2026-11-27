// Local end-to-end check of database leases (README "Tests"). Start this script first, then both
// test Workers:
//   ../../node_modules/.bin/tsx test/fixtures/e2e/lease-check.ts
//   wrangler dev -c test/fixtures/e2e/wrangler.probe.jsonc -c test/fixtures/e2e/wrangler.sts.jsonc
// The script serves a fake Infisical (JWT Auth login and the lease API) on port 8830; the test
// build of STS sends its requests there. It checks that the probe Worker gets a replica-read lease
// over its binding with the lifetime it asked for, that a lifetime above the policy maximum is
// shortened, that a third concurrent lease is refused, that a lease id STS never issued cannot be
// revoked, that STS serves no lease over HTTP, and that the lease rows reach the audit queue with
// no username or password. Every key, id and credential is synthetic. Exits 1 on the first failure.
import {
  LeaseResultSchema,
  LeaseRevokeResultSchema,
  type LeaseResult,
  type LeaseRevokeResult,
} from '@kilocode/sts-contracts';
import { createServer, type IncomingMessage } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://localhost:8827';

function check(condition: boolean, what: string, detail: unknown = ''): void {
  console.log(
    `${condition ? 'PASS' : 'FAIL'} ${what}`,
    detail === '' ? '' : JSON.stringify(detail)
  );
  if (!condition) process.exit(1);
}

type ManagerCall = { method: string; path: string; body: Record<string, unknown> };
const managerCalls: ManagerCall[] = [];
let serial = 0;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1:8830');
    const json = (body: unknown, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const text = await readBody(request);
    if (url.pathname === '/manager/api/v1/auth/jwt-auth/login') {
      return json({ accessToken: 'e2e-manager-token', expiresIn: 600, tokenType: 'Bearer' });
    }
    if (url.pathname === '/manager/api/v4/secrets') return json({ secrets: [], imports: [] });
    const body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
    const path = url.pathname.replace(/^\/manager/, '');
    managerCalls.push({ method: request.method ?? '', path, body });
    if (request.method === 'POST' && path === '/api/v1/dynamic-secrets/leases') {
      serial += 1;
      const ttlSeconds = Number(String(body.ttl).replace(/s$/, ''));
      return json({
        lease: {
          id: crypto.randomUUID(),
          version: 1,
          externalEntityId: `e2e_lease_user_${serial}`,
          expireAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
          dynamicSecretId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        dynamicSecret: { name: body.dynamicSecretName, defaultTTL: '1h', maxTTL: '8h' },
        data: { DB_USERNAME: `e2e_lease_user_${serial}`, DB_PASSWORD: `e2e-password-${serial}` },
      });
    }
    if (request.method === 'DELETE' && path.startsWith('/api/v1/dynamic-secrets/leases/')) {
      // Infisical answers with the lease row it deleted; `status` is set only when it kept the row.
      return json({ lease: { id: path.split('/').pop(), status: null } });
    }
    json({ error: 'not found' }, 404);
  })();
});
const listening = Promise.withResolvers<void>();
server.listen(8830, '127.0.0.1', listening.resolve);
await listening.promise;
console.log('fake manager on 127.0.0.1:8830; waiting for STS on', BASE);

for (let attempt = 0; ; attempt += 1) {
  try {
    if ((await fetch(`${BASE}/.well-known/jwks.json`)).status === 200) break;
  } catch {
    // Not up yet.
  }
  if (attempt === 120) check(false, 'STS answers within 4 minutes');
  await sleep(2_000);
}

async function probeLease(query: string): Promise<LeaseResult> {
  return LeaseResultSchema.parse(await (await fetch(`${BASE}/probe/lease?${query}`)).json());
}

async function probeRevoke(leaseId: string): Promise<LeaseRevokeResult> {
  const response = await fetch(`${BASE}/probe/revoke?leaseId=${encodeURIComponent(leaseId)}`);
  return LeaseRevokeResultSchema.parse(await response.json());
}

// 1. A worker-binding caller gets replica-read with the lifetime it asked for.
const hourly = await probeLease('grant=replica-read&ttl=3600');
check(
  hourly.status === 'ok' &&
    hourly.ttlSeconds === 3600 &&
    !hourly.clamped &&
    hourly.username.startsWith('e2e_lease_user_') &&
    !('host' in hourly),
  'the probe gets a 60-minute replica-read lease, with no host',
  hourly.status === 'ok' ? { ...hourly, password: '<synthetic>' } : hourly
);
if (hourly.status !== 'ok') process.exit(1);
const firstCreate = managerCalls.find(call => call.method === 'POST');
check(
  firstCreate?.body.ttl === '3600s' &&
    firstCreate.body.path === '/dynamic/replica-read' &&
    firstCreate.body.dynamicSecretName === 'replica-read' &&
    firstCreate.body.projectSlug === 'e2e-project',
  'STS asked Infisical for 3600s of /dynamic/replica-read',
  firstCreate?.body
);

// 2. A lifetime above the policy maximum is shortened to it.
const daily = await probeLease('grant=replica-read&ttl=28800');
check(
  daily.status === 'ok' && daily.ttlSeconds === 9000 && daily.clamped,
  'an 8-hour request is clamped to the policy maximum of 9000 seconds',
  daily.status === 'ok' ? { ttlSeconds: daily.ttlSeconds, clamped: daily.clamped } : daily
);
if (daily.status !== 'ok') process.exit(1);

// 3. A third concurrent lease is refused.
const creationsBefore = managerCalls.filter(call => call.method === 'POST').length;
const third = await probeLease('grant=replica-read');
check(
  third.status === 'limited' && third.reason === 'too_many_active',
  'a third concurrent replica-read lease is refused too_many_active',
  third
);
check(
  managerCalls.filter(call => call.method === 'POST').length === creationsBefore,
  'the refused lease made no Infisical call'
);

// 4. STS serves no lease over HTTP.
for (const path of ['/v1/lease', '/v1/lease/revoke']) {
  const response = await fetch(`${BASE}${path}`, { method: 'POST', body: '{}' });
  check(response.status === 404, `POST ${path} is not served`, response.status);
}

// 5. A lease id STS never issued cannot be revoked; the caller's own lease can.
const unknown = await probeRevoke(crypto.randomUUID());
check(unknown.status === 'not_found', 'an unknown lease id answers not_found', unknown);
check(
  managerCalls.filter(call => call.method === 'DELETE').length === 0,
  'the refused revoke never reached Infisical'
);
const own = await probeRevoke(hourly.leaseId);
check(own.status === 'revoked', 'the probe revokes its own lease', own);
const refill = await probeLease('grant=replica-read');
check(refill.status === 'ok', 'the revoked lease freed its slot', refill.status);
if (refill.status === 'ok') await probeRevoke(refill.leaseId);
await probeRevoke(daily.leaseId);

// 6. The audit rows reach the queue, with no credential.
type SeenEvent = { stream: string; type: string; attributes: Record<string, unknown> };
let events: SeenEvent[] = [];
const denied = (reason: string) =>
  events.some(
    event => event.type === 'ai.kilo.sts.lease.denied' && event.attributes.reason === reason
  );
// Denials are written once their minute closes, so this waits up to about two minutes. Lease rows
// are relayed on their own schedule, so it also waits for every one of them.
for (let attempt = 0; attempt < 40; attempt += 1) {
  events = (await (await fetch(`${BASE}/probe/audit`)).json()) as SeenEvent[];
  if (
    denied('too_many_active') &&
    denied('unknown_lease') &&
    events.filter(event => event.type === 'ai.kilo.sts.lease.created').length >= 3 &&
    events.filter(event => event.type === 'ai.kilo.sts.lease.revoked').length >= 3
  ) {
    break;
  }
  await sleep(5_000);
}
const created = events.filter(event => event.type === 'ai.kilo.sts.lease.created');
const revoked = events.filter(event => event.type === 'ai.kilo.sts.lease.revoked');
check(
  created.length === 3,
  'three lease.created rows',
  created.map(event => event.attributes)
);
check(
  revoked.length === 3,
  'three lease.revoked rows',
  revoked.map(event => event.attributes)
);
check(
  created.every(event => event.stream === 'sts:development:leases'),
  'the lease rows come from the sts:development:leases stream'
);
check(denied('too_many_active'), 'the refused third lease is audited as lease.denied');
check(denied('unknown_lease'), 'the unknown revoke is audited as lease.denied unknown_lease');
const all = JSON.stringify(events);
check(
  !all.includes('e2e-password-') && !all.includes('e2e_lease_user_'),
  'no audit row carries a lease username or password'
);
console.log(
  'lease rows',
  JSON.stringify(
    [
      ...created,
      ...revoked,
      ...events.filter(event => event.type === 'ai.kilo.sts.lease.denied'),
    ].map(event => ({ type: event.type, ...event.attributes }))
  )
);
server.close();
process.exit(0);
