// Local end-to-end check of database leases (README "Tests"). Start this script first, then both
// test Workers:
//   ../../node_modules/.bin/tsx test/fixtures/e2e/lease-check.ts
//   wrangler dev -c test/fixtures/e2e/wrangler.probe.jsonc -c test/fixtures/e2e/wrangler.sts.jsonc
// The script serves a fake GitHub issuer and a fake Infisical (JWT Auth login and the lease API)
// on port 8830; the test build of STS sends its requests for both there. It checks that the probe
// Worker gets a replica-read lease over its binding with the lifetime it asked for, that a lifetime
// above the policy maximum is shortened, that a third concurrent lease is refused, that a GitHub
// job gets a ci-migration lease with the primary target, that each caller can revoke only its own
// lease (a GitHub lease only from its own run), and that the lease rows reach the audit queue with
// no username or password. Every key, id and credential is synthetic. Exits 1 on the first failure.
import {
  LeaseResultSchema,
  LeaseRevokeResultSchema,
  type LeaseResult,
  type LeaseRevokeResult,
} from '@kilocode/sts-contracts';
import { createServer, type IncomingMessage } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

const BASE = 'http://localhost:8827';
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const WORKFLOW = 'kilo-e2e/ci-fixture/.github/workflows/deploy.yml@refs/heads/main';
const KID = 'e2e-github-key';

function check(condition: boolean, what: string, detail: unknown = ''): void {
  console.log(
    `${condition ? 'PASS' : 'FAIL'} ${what}`,
    detail === '' ? '' : JSON.stringify(detail)
  );
  if (!condition) process.exit(1);
}

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' }] };

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
    if (url.pathname === '/github/.well-known/openid-configuration') {
      return json({ issuer: GITHUB_ISSUER, jwks_uri: `${GITHUB_ISSUER}/.well-known/jwks` });
    }
    if (url.pathname === '/github/.well-known/jwks') return json(jwks);
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
console.log('fake GitHub issuer and manager on 127.0.0.1:8830; waiting for STS on', BASE);

for (let attempt = 0; ; attempt += 1) {
  try {
    if ((await fetch(`${BASE}/.well-known/jwks.json`)).status === 200) break;
  } catch {
    // Not up yet.
  }
  if (attempt === 120) check(false, 'STS answers within 4 minutes');
  await sleep(2_000);
}

const JOB_CLAIMS: JWTPayload = {
  sub: 'repo:kilo-e2e@2002/ci-fixture@1001:environment:migrations',
  repository: 'kilo-e2e/ci-fixture',
  repository_id: '1001',
  repository_owner: 'kilo-e2e',
  repository_owner_id: '2002',
  environment: 'migrations',
  ref: 'refs/heads/main',
  ref_type: 'branch',
  event_name: 'push',
  workflow_ref: WORKFLOW,
  job_workflow_ref: WORKFLOW,
  run_id: '515151',
  run_attempt: '1',
  runner_environment: 'github-hosted',
};

async function jobToken(claims: JWTPayload = JOB_CLAIMS): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
    .setIssuer(GITHUB_ISSUER)
    .setAudience(BASE)
    .setIssuedAt()
    .setNotBefore('0s')
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function probeLease(query: string): Promise<LeaseResult> {
  return LeaseResultSchema.parse(await (await fetch(`${BASE}/probe/lease?${query}`)).json());
}

async function probeRevoke(leaseId: string): Promise<LeaseRevokeResult> {
  const response = await fetch(`${BASE}/probe/revoke?leaseId=${encodeURIComponent(leaseId)}`);
  return LeaseRevokeResultSchema.parse(await response.json());
}

async function githubPost(
  path: string,
  body: unknown,
  claims: JWTPayload = JOB_CLAIMS
): Promise<{ status: number; result: unknown }> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await jobToken(claims)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, result: await response.json() };
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

// 4. A GitHub job gets ci-migration with the primary target.
const migration = await githubPost('/v1/lease', { grant: 'ci-migration' });
const migrationLease = LeaseResultSchema.parse(migration.result);
check(
  migration.status === 200 &&
    migrationLease.status === 'ok' &&
    migrationLease.grant === 'ci-migration' &&
    migrationLease.ttlSeconds === 3600 &&
    migrationLease.host === 'db.e2e-primary.invalid' &&
    migrationLease.port === 5432 &&
    migrationLease.database === 'postgres',
  'the GitHub job gets a 1-hour ci-migration lease with the primary target',
  { status: migration.status, leaseStatus: migrationLease.status }
);
if (migrationLease.status !== 'ok') process.exit(1);

// 5. Each caller revokes only its own lease.
const stolen = await githubPost('/v1/lease/revoke', { leaseId: hourly.leaseId });
check(
  stolen.status === 404 && JSON.stringify(stolen.result) === '{"status":"not_found"}',
  "the GitHub job cannot revoke the probe's lease (404 not_found)",
  stolen
);
const crossed = await probeRevoke(migrationLease.leaseId);
check(crossed.status === 'not_found', "the probe cannot revoke the GitHub job's lease", crossed);
const otherRun = await githubPost(
  '/v1/lease/revoke',
  { leaseId: migrationLease.leaseId },
  { ...JOB_CLAIMS, run_id: '515152' }
);
check(
  otherRun.status === 404,
  "another run of the same workflow cannot revoke the job's lease",
  otherRun
);
check(
  managerCalls.filter(call => call.method === 'DELETE').length === 0,
  'no refused revoke reached Infisical'
);
const own = await probeRevoke(hourly.leaseId);
check(own.status === 'revoked', 'the probe revokes its own lease', own);
const ownMigration = await githubPost('/v1/lease/revoke', { leaseId: migrationLease.leaseId });
check(ownMigration.status === 200, 'the GitHub job revokes its own lease', ownMigration);
check(
  managerCalls
    .filter(call => call.method === 'DELETE')
    .map(call => call.path.split('/').pop())
    .sort()
    .join() === [hourly.leaseId, migrationLease.leaseId].sort().join(),
  'Infisical got exactly the two owner revocations'
);
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
    denied('not_owner') &&
    denied('other_run') &&
    events.filter(event => event.type === 'ai.kilo.sts.lease.created').length >= 4 &&
    events.filter(event => event.type === 'ai.kilo.sts.lease.revoked').length >= 4
  ) {
    break;
  }
  await sleep(5_000);
}
const created = events.filter(event => event.type === 'ai.kilo.sts.lease.created');
const revoked = events.filter(event => event.type === 'ai.kilo.sts.lease.revoked');
check(
  created.length === 4,
  'four lease.created rows',
  created.map(event => event.attributes)
);
check(
  revoked.length === 4,
  'four lease.revoked rows',
  revoked.map(event => event.attributes)
);
check(
  created.every(event => event.stream === 'sts:development:leases'),
  'the lease rows come from the sts:development:leases stream'
);
const ciCreated = created.find(event => event.attributes.workload === 'ci-e2e-migrate');
check(
  ciCreated?.attributes.grant === 'ci-migration' &&
    ciCreated.attributes.runId === '515151' &&
    ciCreated.attributes.jobWorkflowRef === WORKFLOW,
  'the ci-migration row names the workflow file and run',
  ciCreated?.attributes
);
check(denied('too_many_active'), 'the refused third lease is audited as lease.denied');
check(denied('not_owner'), 'both cross revokes are audited as lease.denied not_owner');
check(denied('other_run'), 'the other run is audited as lease.denied other_run');
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
