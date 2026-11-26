// Local end-to-end check of Cloudflare deploy tokens (README "Tests"). Start this script first, then
// both test Workers:
//   ../../node_modules/.bin/tsx test/fixtures/e2e/deploy-token-check.ts
//   wrangler dev -c test/fixtures/e2e/wrangler.probe.jsonc -c test/fixtures/e2e/wrangler.sts.jsonc
// The script serves a fake GitHub issuer, a fake Infisical (JWT Auth login and the `/ci/minting`
// read) and a fake Cloudflare API (account tokens, the Worker script list and a zone's Workers
// routes) that records every request, on port 8830; the test build of STS sends its requests for
// all three there. It checks that a production-shaped deploy job gets a 1-hour token with the
// policy's permission groups, that another workflow, a pull_request job and a job of another GitHub
// environment are refused, that only the owner job's run can revoke a token, that the reaper
// deletes a token past its expiry, that a creation whose answer was lost is audited and its token
// swept, that the window check runs about 2 minutes after each window closes and audits once a
// Worker and a route changed while tokens were live that no token intended, and that no audit row
// carries a token value or the minting credential. It waits about eight minutes for a 5-minute
// token to expire and the sweep to follow. Every key, id and credential is synthetic. Exits 1 on
// the first failure.
import {
  CloudflareDeployTokenResultSchema,
  type CloudflareDeployTokenResult,
} from '@kilocode/sts-contracts';
import { createServer, type IncomingMessage } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

const BASE = 'http://localhost:8827';
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const WORKFLOW = 'kilo-e2e/ci-fixture/.github/workflows/cf-deploy.yml@refs/heads/main';
const SHORT_WORKFLOW = 'kilo-e2e/other-fixture/.github/workflows/cf-deploy.yml@refs/heads/main';
const ACCOUNT = 'e2e0000000000000000000000000acc1';
const MINTING_CREDENTIAL = 'e2e-synthetic-minting-credential';
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

type CloudflareCall = {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown> | null;
  at: number;
};
const cloudflareCalls: CloudflareCall[] = [];
const tokens = new Map<string, { name: string; expiresOn: string; value: string }>();
/** The account's Worker scripts, as `GET .../workers/scripts` lists them. */
const scripts: { id: string; modified_on: string }[] = [];
const ZONE = 'e2e0000000000000000000000000c001';
/** The zone's Workers routes, as `GET /zones/<zone>/workers/routes` lists them. */
const routes: { id: string; pattern: string; script?: string }[] = [
  { id: 'e2e-route-own', pattern: 'e2e.example.invalid/*', script: 'e2e-worker' },
];
/** Cloudflare's names of the policies' permission groups (test/fixtures/e2e/sts.ts). */
const GROUP_NAMES: Record<string, string> = {
  e2e0000000000000000000000000a001: 'Workers Scripts Write',
  e2e0000000000000000000000000a002: 'Containers Write',
  e2e0000000000000000000000000a003: 'Workers Routes Write',
};
let serial = 0;
/** The next creation makes its token but answers 502, as a lost answer would. */
let loseNextCreate = false;
let lost: { id: string; name: string } | null = null;

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
    if (url.pathname === '/manager/api/v4/secrets') {
      if (url.searchParams.get('secretPath') !== '/ci/minting') {
        return json({ secrets: [], imports: [] });
      }
      return json({
        secrets: [
          {
            id: 'e2e-minting',
            secretKey: 'CLOUDFLARE_MINTING_TOKEN',
            secretValue: MINTING_CREDENTIAL,
            version: 1,
            type: 'shared',
            secretPath: '/ci/minting',
            secretValueHidden: false,
          },
        ],
        imports: [],
      });
    }
    if (!url.pathname.startsWith('/cloudflare/client/v4/'))
      return json({ error: 'not found' }, 404);
    const path = url.pathname.replace('/cloudflare/client/v4', '');
    const body = text === '' ? null : (JSON.parse(text) as Record<string, unknown>);
    cloudflareCalls.push({
      method: request.method ?? '',
      path,
      authorization: request.headers.authorization,
      body,
      at: Date.now(),
    });
    if (request.headers.authorization !== `Bearer ${MINTING_CREDENTIAL}`) {
      return json(
        { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
        403
      );
    }
    const tokensPath = `/accounts/${ACCOUNT}/tokens`;
    if (request.method === 'POST' && path === tokensPath && body !== null) {
      serial += 1;
      const id = `e2e${String(serial).padStart(29, '0')}`;
      const value = `cfat_e2e-synthetic-deploy-token-${serial}`;
      // The fake answers what STS sent; the check below compares it with the policy.
      const policies = body.policies as {
        permission_groups: { id: string }[];
        resources: Record<string, string>;
      }[];
      tokens.set(id, { name: String(body.name), expiresOn: String(body.expires_on), value });
      if (loseNextCreate) {
        loseNextCreate = false;
        lost = { id, name: String(body.name) };
        return json({ success: false, errors: [{ code: 10000, message: 'Bad gateway' }] }, 502);
      }
      return json({
        success: true,
        errors: [],
        messages: [],
        result: {
          id,
          name: body.name,
          status: 'active',
          issued_on: new Date().toISOString(),
          not_before: body.not_before,
          expires_on: body.expires_on,
          policies: policies.map((policy, index) => ({
            id: `e2e${String(index).padStart(29, 'f')}`,
            effect: 'allow',
            permission_groups: policy.permission_groups.map(group => ({
              id: group.id,
              name: GROUP_NAMES[group.id],
            })),
            resources: policy.resources,
          })),
          value,
        },
      });
    }
    if (request.method === 'DELETE' && path.startsWith(`${tokensPath}/`)) {
      const id = path.split('/').pop() ?? '';
      if (!tokens.delete(id)) return json({ success: false }, 404);
      return json({ success: true, result: { id } });
    }
    if (request.method === 'GET' && path === tokensPath) {
      return json({
        success: true,
        result: [...tokens].map(([id, token]) => ({
          id,
          name: token.name,
          status: 'active',
          expires_on: token.expiresOn,
        })),
      });
    }
    if (request.method === 'GET' && path === `/accounts/${ACCOUNT}/workers/scripts`) {
      return json({ success: true, errors: [], messages: [], result: scripts });
    }
    if (request.method === 'GET' && path === `/zones/${ZONE}/workers/routes`) {
      return json({ success: true, errors: [], messages: [], result: routes });
    }
    json({ success: false }, 404);
  })();
});
const listening = Promise.withResolvers<void>();
server.listen(8830, '127.0.0.1', listening.resolve);
await listening.promise;
console.log(
  'fake GitHub issuer, manager and Cloudflare on 127.0.0.1:8830; waiting for STS on',
  BASE
);

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
  sub: 'repo:kilo-e2e@2002/ci-fixture@1001:environment:production',
  repository: 'kilo-e2e/ci-fixture',
  repository_id: '1001',
  repository_owner: 'kilo-e2e',
  repository_owner_id: '2002',
  environment: 'production',
  ref: 'refs/heads/main',
  ref_type: 'branch',
  event_name: 'push',
  workflow_ref: WORKFLOW,
  job_workflow_ref: WORKFLOW,
  run_id: '616161',
  run_attempt: '1',
  runner_environment: 'github-hosted',
};

const SHORT_CLAIMS: JWTPayload = {
  ...JOB_CLAIMS,
  sub: 'repo:kilo-e2e@2002/other-fixture@1003:environment:production',
  repository: 'kilo-e2e/other-fixture',
  repository_id: '1003',
  workflow_ref: SHORT_WORKFLOW,
  job_workflow_ref: SHORT_WORKFLOW,
  run_id: '717171',
};

async function jobToken(claims: JWTPayload): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
    .setIssuer(GITHUB_ISSUER)
    .setAudience(BASE)
    .setIssuedAt()
    .setNotBefore('0s')
    .setExpirationTime('5m')
    .sign(privateKey);
}

/** The bouncer deploy job's exchange: a POST with the OIDC token as the bearer and no body. */
async function exchange(
  claims: JWTPayload
): Promise<{ status: number; result: CloudflareDeployTokenResult }> {
  const response = await fetch(`${BASE}/v1/ci/cloudflare-deploy-token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await jobToken(claims)}` },
  });
  return {
    status: response.status,
    result: CloudflareDeployTokenResultSchema.parse(await response.json()),
  };
}

async function revoke(tokenId: string, claims: JWTPayload): Promise<number> {
  const response = await fetch(`${BASE}/v1/ci/cloudflare-deploy-token/revoke`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await jobToken(claims)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tokenId }),
  });
  await response.body?.cancel();
  return response.status;
}

// 1. A production-shaped deploy job gets a 1-hour token with its permission set.
const minted = await exchange(JOB_CLAIMS);
check(
  minted.status === 200 && minted.result.status === 'ok' && minted.result.ttlSeconds === 3600,
  'a production deploy job gets a 1-hour Cloudflare token',
  minted.result.status === 'ok' ? { ...minted.result, token: '<synthetic>' } : minted.result
);
if (minted.result.status !== 'ok') process.exit(1);
const token = minted.result;
check(
  token.token === tokens.get(token.tokenId)?.value,
  'the token is the value Cloudflare returned for that id'
);
const create = cloudflareCalls.find(call => call.method === 'POST');
const body = create?.body as {
  name: string;
  not_before: string;
  expires_on: string;
  policies: { permission_groups: { id: string }[]; resources: Record<string, string> }[];
};
check(
  create?.path === `/accounts/${ACCOUNT}/tokens` &&
    create.authorization === `Bearer ${MINTING_CREDENTIAL}`,
  'STS created an account token with the minting credential from /ci/minting'
);
check(
  Date.parse(body.expires_on) - Date.parse(body.not_before) === 3600_000,
  'expires_on is not_before plus 1 hour',
  { not_before: body.not_before, expires_on: body.expires_on }
);
check(
  JSON.stringify(body.policies) ===
    JSON.stringify([
      {
        effect: 'allow',
        permission_groups: [
          { id: 'e2e0000000000000000000000000a001' },
          { id: 'e2e0000000000000000000000000a002' },
        ],
        resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: '*' },
      },
      {
        effect: 'allow',
        permission_groups: [{ id: 'e2e0000000000000000000000000a003' }],
        resources: { 'com.cloudflare.api.account.zone.e2e0000000000000000000000000c001': '*' },
      },
    ]),
  'the token carries exactly the configured permission groups on the account and the zone',
  body.policies
);
check(
  /^sts-development-ci-e2e-deploy-616161-\d+$/.test(body.name),
  'the token is named after the environment, workload and run',
  body.name
);

// 2. Another workflow, a pull_request job and another GitHub environment are refused.
const creationsBefore = cloudflareCalls.filter(call => call.method === 'POST').length;
for (const [what, claims] of [
  [
    'a job of another workflow file',
    {
      ...JOB_CLAIMS,
      workflow_ref: 'kilo-e2e/ci-fixture/.github/workflows/other.yml@refs/heads/main',
      job_workflow_ref: 'kilo-e2e/ci-fixture/.github/workflows/other.yml@refs/heads/main',
    },
  ],
  ['a pull_request job', { ...JOB_CLAIMS, event_name: 'pull_request' }],
  [
    'a job of the staging GitHub environment',
    {
      ...JOB_CLAIMS,
      environment: 'staging',
      sub: 'repo:kilo-e2e@2002/ci-fixture@1001:environment:staging',
    },
  ],
] as const) {
  const refused = await exchange(claims);
  check(
    refused.status === 401 &&
      refused.result.status === 'denied' &&
      refused.result.reason === 'identity_rejected',
    `${what} is refused (401 identity_rejected)`,
    refused
  );
}
check(
  cloudflareCalls.filter(call => call.method === 'POST').length === creationsBefore,
  'no refused request reached Cloudflare'
);

// 3. A creation whose answer is lost is audited; then only the owner job's run revokes a token.
loseNextCreate = true;
const lostAnswer = await exchange(SHORT_CLAIMS);
check(
  lostAnswer.status === 503 && lostAnswer.result.status === 'unavailable' && lost !== null,
  'a creation whose answer was lost answers unavailable, and Cloudflare holds its token',
  lostAnswer.result
);
const lostToken: { id: string; name: string } = lost ?? { id: '', name: '' };
const short = await exchange(SHORT_CLAIMS);
check(
  short.result.status === 'ok' && short.result.ttlSeconds === 300,
  'the other workload gets a 5-minute token',
  short.result.status
);
if (short.result.status !== 'ok') process.exit(1);
// Changed while both tokens are live: each job's own Worker, and one neither job deploys.
const changedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
scripts.push(
  { id: 'e2e-worker', modified_on: changedAt },
  { id: 'e2e-other-worker', modified_on: changedAt },
  { id: 'e2e-rogue-worker', modified_on: changedAt },
  { id: 'e2e-untouched-worker', modified_on: '2020-01-01T00:00:00Z' }
);
// A route of the deploy job's zone repointed at a Worker no live token deploys.
routes.push({
  id: 'e2e-route-rogue',
  pattern: 'e2e.example.invalid/admin/*',
  script: 'e2e-rogue-worker',
});
check(
  (await revoke(token.tokenId, SHORT_CLAIMS)) === 404,
  "another workload cannot revoke the deploy job's token (404)"
);
check(
  (await revoke(token.tokenId, { ...JOB_CLAIMS, run_id: '616162' })) === 404,
  "another run of the same workflow cannot revoke the deploy job's token (404)"
);
check(
  cloudflareCalls.filter(call => call.method === 'DELETE').length === 0,
  'no refused revoke reached Cloudflare'
);
check((await revoke(token.tokenId, JOB_CLAIMS)) === 200, 'the owner job revokes its own token');
const revokedAt = Date.now();
check(
  !tokens.has(token.tokenId) &&
    cloudflareCalls.some(
      call =>
        call.method === 'DELETE' && call.path === `/accounts/${ACCOUNT}/tokens/${token.tokenId}`
    ),
  'Cloudflare deleted the revoked token'
);

// 4. The reaper deletes the 5-minute token after it expired, with no revoke.
const shortId = short.result.tokenId;
console.log('waiting for the 5-minute token to expire and be reaped');
for (let attempt = 0; attempt < 90 && tokens.has(shortId); attempt += 1) await sleep(5_000);
check(!tokens.has(shortId), 'the reaper deleted the expired token');

// 5. The sweep brought forward by the lost answer deletes that token once it expired. The window
// check ran about 2 minutes after the revoke, and again after the 5-minute token expired.
console.log('waiting for the sweep (about 7 minutes after the lost creation)');
for (let attempt = 0; attempt < 48 && tokens.has(lostToken.id); attempt += 1) await sleep(5_000);
check(!tokens.has(lostToken.id), 'the sweep deleted the token whose creation answer was lost');
const scriptLists = () =>
  cloudflareCalls.filter(
    call => call.method === 'GET' && call.path === `/accounts/${ACCOUNT}/workers/scripts`
  );
for (let attempt = 0; attempt < 36 && scriptLists().length < 2; attempt += 1) await sleep(5_000);
check(
  scriptLists().length === 2 &&
    scriptLists().every(call => call.authorization === `Bearer ${MINTING_CREDENTIAL}`),
  'the window check listed the Worker scripts once per closed window, with the minting credential',
  scriptLists().length
);
const firstList = scriptLists()[0]?.at ?? 0;
check(
  firstList >= revokedAt + 110_000 && firstList <= revokedAt + 180_000,
  'the first window check ran about 2 minutes after the revoke, not at a daily sweep',
  { secondsAfterRevoke: (firstList - revokedAt) / 1000 }
);
check(
  cloudflareCalls.some(
    call =>
      call.method === 'GET' &&
      call.path === `/zones/${ZONE}/workers/routes` &&
      call.authorization === `Bearer ${MINTING_CREDENTIAL}`
  ),
  "the window check listed the deploy job's zone routes with the minting credential"
);

// 6. The audit rows reach the queue, with no token value and no minting credential.
type SeenEvent = { stream: string; type: string; attributes: Record<string, unknown> };
let events: SeenEvent[] = [];
const denied = (reason: string) =>
  events.some(
    event => event.type === 'ai.kilo.sts.deploy_token.denied' && event.attributes.reason === reason
  );
for (let attempt = 0; attempt < 40; attempt += 1) {
  events = (await (await fetch(`${BASE}/probe/audit`)).json()) as SeenEvent[];
  if (
    denied('identity_rejected') &&
    denied('not_owner') &&
    denied('other_run') &&
    events.filter(event => event.type === 'ai.kilo.sts.deploy_token.reaped').length >= 2 &&
    events.some(event => event.type === 'ai.kilo.sts.deploy_token.mint_failed') &&
    events.some(event => event.type === 'ai.kilo.sts.deploy_token.unexpected_script') &&
    events.some(event => event.type === 'ai.kilo.sts.deploy_token.unexpected_route') &&
    events.filter(event => event.type === 'ai.kilo.sts.deploy_token.minted').length >= 2 &&
    events.some(event => event.type === 'ai.kilo.sts.deploy_token.revoked')
  ) {
    break;
  }
  await sleep(5_000);
}
const deployEvents = events.filter(event => event.type.startsWith('ai.kilo.sts.deploy_token.'));
const mintedRow = deployEvents.find(
  event =>
    event.type === 'ai.kilo.sts.deploy_token.minted' && event.attributes.tokenId === token.tokenId
);
check(
  mintedRow?.stream === 'sts:development:deploy-tokens' &&
    mintedRow.attributes.workload === 'ci-e2e-deploy' &&
    mintedRow.attributes.runId === '616161' &&
    mintedRow.attributes.permissionSet === 'e2e-deploy' &&
    mintedRow.attributes.expiresAt === token.expiresAt,
  'deploy_token.minted names the workload, run, permission set, token id and expiry',
  mintedRow?.attributes
);
check(
  deployEvents.some(
    event =>
      event.type === 'ai.kilo.sts.deploy_token.revoked' &&
      event.attributes.cause === 'caller' &&
      event.attributes.tokenId === token.tokenId
  ),
  'deploy_token.revoked records the owner revoke'
);
check(
  deployEvents.some(
    event =>
      event.type === 'ai.kilo.sts.deploy_token.reaped' &&
      event.attributes.tokenId === shortId &&
      event.attributes.result === 'deleted'
  ),
  'deploy_token.reaped records the expired token'
);
check(
  deployEvents.some(
    event =>
      event.type === 'ai.kilo.sts.deploy_token.mint_failed' &&
      event.attributes.outcome === 'unknown' &&
      event.attributes.workload === 'ci-e2e-deploy-short' &&
      event.attributes.tokenName === lostToken.name
  ),
  'deploy_token.mint_failed (unknown) names the token whose creation answer was lost',
  lostToken.name
);
check(
  deployEvents.some(
    event =>
      event.type === 'ai.kilo.sts.deploy_token.reaped' &&
      event.attributes.source === 'sweep' &&
      event.attributes.tokenId === lostToken.id
  ),
  'deploy_token.reaped (source sweep) records the lost token'
);
const unexpected = deployEvents.filter(
  event => event.type === 'ai.kilo.sts.deploy_token.unexpected_script'
);
check(
  unexpected.length === 1 &&
    unexpected[0].attributes.script === 'e2e-rogue-worker' &&
    JSON.stringify([...(unexpected[0].attributes.tokenIds as string[])].sort()) ===
      JSON.stringify([token.tokenId, shortId].sort()),
  'deploy_token.unexpected_script names the one Worker no live token intended, and both tokens, once over two checks',
  unexpected.map(event => event.attributes)
);
const unexpectedRoutes = deployEvents.filter(
  event => event.type === 'ai.kilo.sts.deploy_token.unexpected_route'
);
check(
  unexpectedRoutes.length === 1 &&
    unexpectedRoutes[0].attributes.routeId === 'e2e-route-rogue' &&
    unexpectedRoutes[0].attributes.script === 'e2e-rogue-worker' &&
    unexpectedRoutes[0].attributes.zone === ZONE &&
    JSON.stringify(unexpectedRoutes[0].attributes.tokenIds) === JSON.stringify([token.tokenId]),
  'deploy_token.unexpected_route names the one route no token of its zone intended, and that token',
  unexpectedRoutes.map(event => event.attributes)
);
check(
  denied('identity_rejected') && denied('not_owner') && denied('other_run'),
  'deploy_token.denied rows carry the refusal reasons'
);
const text = JSON.stringify(events);
check(
  !text.includes('cfat_') && !text.includes(MINTING_CREDENTIAL),
  'no audit row carries a token value or the minting credential'
);
server.close();
console.log('deploy-token end-to-end check passed');
