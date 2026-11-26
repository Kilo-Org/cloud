// Local end-to-end check of a CI job's bundle over GitHub OIDC (README "Tests"). Start this script
// first, then both test Workers:
//   ../../node_modules/.bin/tsx test/fixtures/e2e/ci-bundle-check.ts
//   wrangler dev -c test/fixtures/e2e/wrangler.probe.jsonc -c test/fixtures/e2e/wrangler.sts.jsonc
// The script serves a fake GitHub issuer (a fresh RS256 key, its discovery document and key set)
// and a fake manager on port 8830; the test build of STS sends its requests for both there. It
// signs CI-shaped job tokens the way GitHub does, checks that the listed workflow's job gets its
// bundle from /ci/<workload> and /shared, that another workflow file, a pull_request event and a
// name-only subject are refused, and waits for the delivery and denial rows on the audit queue.
// Every key, id and value is synthetic. Exits 1 on the first failure.
import { BundleResultSchema, type BundleResult } from '@kilocode/sts-contracts';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

const BASE = 'http://localhost:8827';
const STS_ISSUER = BASE;
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const WORKFLOW = 'kilo-e2e/ci-fixture/.github/workflows/publish.yml@refs/heads/main';
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

type FakeSecret = { path: string; name: string; value: string };
const managerSecrets: FakeSecret[] = [
  { path: '/ci/ci-e2e-release', name: 'E2E_RELEASE_KEY', value: 'release-key-synthetic' },
  { path: '/workloads/ci-e2e-release', name: 'E2E_RELEASE_KEY', value: 'wrong-folder-synthetic' },
  { path: '/ci/minting', name: 'E2E_SHARED_WEBHOOK', value: 'minting-synthetic' },
  { path: '/shared', name: 'E2E_SHARED_WEBHOOK', value: 'https://hooks.example/e2e-synthetic' },
];
const folderReads: string[] = [];

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1:8830');
  const json = (body: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === '/github/.well-known/openid-configuration') {
    return json({ issuer: GITHUB_ISSUER, jwks_uri: `${GITHUB_ISSUER}/.well-known/jwks` });
  }
  if (url.pathname === '/github/.well-known/jwks') return json(jwks);
  if (url.pathname === '/manager/api/v1/auth/jwt-auth/login' && request.method === 'POST') {
    request.resume();
    return json({ accessToken: 'e2e-manager-token', expiresIn: 600, tokenType: 'Bearer' });
  }
  if (url.pathname === '/manager/api/v4/secrets') {
    const folder = url.searchParams.get('secretPath') ?? '/';
    folderReads.push(folder);
    const secrets = managerSecrets
      .filter(entry => entry.path === folder || entry.path.startsWith(`${folder}/`))
      .map((entry, index) => ({
        id: `e2e-${folder}-${index}`,
        secretKey: entry.name,
        secretValue: entry.value,
        version: 1,
        type: 'shared',
        secretPath: entry.path,
        secretValueHidden: false,
      }));
    return json({ secrets, imports: [] });
  }
  json({ error: 'not found' }, 404);
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

/** A GitHub Actions job token: the claims GitHub sets for a `publish.yml` job in `release`. */
const JOB_CLAIMS: JWTPayload = {
  sub: 'repo:kilo-e2e@2002/ci-fixture@1001:environment:release',
  repository: 'kilo-e2e/ci-fixture',
  repository_id: '1001',
  repository_owner: 'kilo-e2e',
  repository_owner_id: '2002',
  environment: 'release',
  ref: 'refs/heads/main',
  ref_type: 'branch',
  event_name: 'workflow_dispatch',
  workflow_ref: WORKFLOW,
  job_workflow_ref: WORKFLOW,
  run_id: '424242',
  run_attempt: '1',
  runner_environment: 'github-hosted',
};

async function jobToken(claims: JWTPayload): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
    .setIssuer(GITHUB_ISSUER)
    .setAudience(STS_ISSUER)
    .setIssuedAt()
    .setNotBefore('0s')
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function bundle(claims: JWTPayload): Promise<{ status: number; result: BundleResult }> {
  const response = await fetch(`${BASE}/v1/bundle`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await jobToken(claims)}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  return { status: response.status, result: BundleResultSchema.parse(await response.json()) };
}

const delivered = await bundle(JOB_CLAIMS);
check(
  delivered.status === 200 && delivered.result.status === 'ok',
  'the publish.yml job gets its bundle',
  { status: delivered.status, bundleStatus: delivered.result.status }
);
if (delivered.result.status !== 'ok') process.exit(1);
const { secrets, missing } = delivered.result;
check(
  Object.keys(secrets).length === 2 &&
    secrets.E2E_RELEASE_KEY?.value === 'release-key-synthetic' &&
    secrets.E2E_SHARED_WEBHOOK?.value === 'https://hooks.example/e2e-synthetic' &&
    missing.length === 0,
  'the bundle holds the /ci/ci-e2e-release value and the /shared value, nothing else',
  Object.keys(secrets)
);
check(
  ['/workloads', '/shared', '/ci'].every(folder => folderReads.includes(folder)),
  'the refresher read /workloads, /shared and /ci',
  [...new Set(folderReads)]
);

const refusals: Array<[string, JWTPayload]> = [
  [
    'a job of another workflow file',
    {
      ...JOB_CLAIMS,
      job_workflow_ref: 'kilo-e2e/ci-fixture/.github/workflows/other.yml@refs/heads/main',
    },
  ],
  ['a pull_request job', { ...JOB_CLAIMS, event_name: 'pull_request' }],
  [
    'a token with the name-only subject',
    { ...JOB_CLAIMS, sub: 'repo:kilo-e2e/ci-fixture:environment:release' },
  ],
];
for (const [what, claims] of refusals) {
  const refused = await bundle(claims);
  check(
    refused.status === 401 &&
      refused.result.status === 'denied' &&
      refused.result.reason === 'identity_rejected',
    `${what} is refused 401 identity_rejected`,
    refused
  );
}

type SeenEvent = { stream: string; type: string; attributes: Record<string, unknown> };
let events: SeenEvent[] = [];
const deniedClaims = (event: SeenEvent): string[] => {
  const claims = event.attributes.claims;
  return Array.isArray(claims) ? claims.filter(claim => typeof claim === 'string') : [];
};
const sawDenial = (fragment: string) =>
  events.some(
    event =>
      event.type === 'ai.kilo.sts.bundle.denied' &&
      deniedClaims(event).some(claim => claim.includes(fragment))
  );
// Denials are written once their minute closes, so this waits up to about two minutes. The
// delivery row is relayed 5 seconds after its append, and a minute can close before that, so it
// also waits for the delivery row.
for (let attempt = 0; attempt < 40; attempt += 1) {
  events = (await (await fetch(`${BASE}/probe/audit`)).json()) as SeenEvent[];
  if (
    events.some(
      event =>
        event.type === 'ai.kilo.sts.bundle.delivered' &&
        event.attributes.workload === 'ci-e2e-release'
    ) &&
    sawDenial('other.yml') &&
    sawDenial('event_name=pull_request') &&
    sawDenial('sub=repo:kilo-e2e/')
  ) {
    break;
  }
  await sleep(5_000);
}
const deliveries = events.filter(
  event =>
    event.type === 'ai.kilo.sts.bundle.delivered' && event.attributes.workload === 'ci-e2e-release'
);
check(deliveries.length === 1, 'one bundle.delivered row for ci-e2e-release', deliveries);
check(
  deliveries[0]?.attributes.runId === '424242' &&
    deliveries[0]?.attributes.runAttempt === '1' &&
    deliveries[0]?.attributes.jobWorkflowRef === WORKFLOW,
  'the delivery row names the workflow file, run id and attempt',
  deliveries[0]?.attributes
);
check(
  !JSON.stringify(events.filter(event => event.type === 'ai.kilo.sts.bundle.denied')).includes(
    '424242'
  ),
  'no denial row carries the run id'
);
check(
  sawDenial('job_workflow_ref=kilo-e2e/ci-fixture/.github/workflows/other.yml'),
  'the other workflow file is audited with its job_workflow_ref'
);
check(sawDenial('event_name=pull_request'), 'the pull_request job is audited with its event');
check(
  sawDenial('sub=repo:kilo-e2e/ci-fixture:environment:release'),
  'the name-only subject is audited'
);
check(!JSON.stringify(events).includes('synthetic'), 'no audit row carries a secret value');
console.log(
  'denial rows',
  JSON.stringify(
    events
      .filter(event => event.type === 'ai.kilo.sts.bundle.denied')
      .map(event => ({ reason: event.attributes.reason, claims: deniedClaims(event) }))
  )
);
server.close();
process.exit(0);
