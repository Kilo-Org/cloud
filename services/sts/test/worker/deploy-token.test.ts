import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import {
  CloudflareDeployTokenResultSchema,
  CloudflareDeployTokenRevokeResultSchema,
  type CloudflareDeployTokenResult,
} from '@kilocode/sts-contracts';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { clearDenialBuffers } from '../../src/audit/denials';
import {
  CLOUDFLARE_MINTING_TOKEN_SECRET,
  DEPLOY_TOKEN_DELETES_PER_ALARM,
  DEPLOY_TOKEN_MINT_BUDGET_MS,
  DEPLOY_TOKEN_RETRY_AFTER_SECONDS,
  MINTING_FOLDER,
} from '../../src/constants';
import { DeployTokenDO } from '../../src/dos/DeployTokenDO';
import { getDenialStub, getDeployTokenStub, getSignerStub } from '../../src/dos/stubs';
import { handleRequest } from '../../src/http';
import { InfisicalClient } from '../../src/infisical/client';
import { loadPolicies } from '../../src/policy/load';
import type { MintAuthority } from '../../src/tokens/mint';
import { stubOfflineNetwork } from './manager';
import { resetDenialObject, resetDeployTokenObject } from './reset';
import { createProvider, providerFetch, signToken, type TestProvider } from './support';
import { config, env } from './test-env';

const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const DEPLOY_WORKFLOW = 'acme/bouncer/.github/workflows/deploy.yml@refs/heads/main';
const OTHER_WORKFLOW = 'acme/other/.github/workflows/deploy.yml@refs/heads/main';
const PLAIN_WORKFLOW = 'acme/bouncer/.github/workflows/lint.yml@refs/heads/main';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const SCRIPTS_GROUP = 'a'.repeat(32);
const CONTAINERS_GROUP = 'b'.repeat(32);
const ROUTES_GROUP = 'c'.repeat(32);
const ZONE_ID = 'd'.repeat(32);
const MINTING_CREDENTIAL = 'synthetic-minting-credential-0001';

const GROUP_NAMES: Record<string, string> = {
  [SCRIPTS_GROUP]: 'Workers Scripts Write',
  [CONTAINERS_GROUP]: 'Containers Write',
  [ROUTES_GROUP]: 'Workers Routes Write',
};

function deployPolicy(workload: string, repository: string, workflow: string, ids: string[]) {
  return `
workload: ${workload}
environments: [development]
identity:
  kind: github-oidc
  repository: ${repository}
  repositoryId: '${ids[0]}'
  repositoryOwnerId: '${ids[1]}'
  environment: production
  jobWorkflowRefs: [${workflow}]
  events: [push]
secrets: []
dynamic:
  - grant: cloudflare-deploy
    permissionSet: bouncer-deploy
    permissionGroups:
      - { id: '${SCRIPTS_GROUP}', name: Workers Scripts Write, scope: account }
      - { id: '${CONTAINERS_GROUP}', name: Containers Write, scope: account }
      - { id: '${ROUTES_GROUP}', name: Workers Routes Write, scope: zone }
    zones: ['${ZONE_ID}']
    intendedScripts: [bouncer, bouncer-watch]
    maxActive: 2
    maxPerHour: 4
`;
}

const authority: MintAuthority = {
  scopes: {},
  policies: loadPolicies({
    'ci-deploy-bouncer.yaml': deployPolicy('ci-deploy-bouncer', 'acme/bouncer', DEPLOY_WORKFLOW, [
      '321',
      '654',
    ]),
    'ci-deploy-other.yaml': deployPolicy('ci-deploy-other', 'acme/other', OTHER_WORKFLOW, [
      '322',
      '654',
    ]),
    'ci-bouncer-lint.yaml': `
workload: ci-bouncer-lint
environments: [development]
identity:
  kind: github-oidc
  repository: acme/bouncer
  repositoryId: '321'
  repositoryOwnerId: '654'
  environment: production
  jobWorkflowRefs: [${PLAIN_WORKFLOW}]
  events: [push]
secrets: []
`,
  }),
};

type Recorded = { method: string; path: string; authorization: string | null; body: unknown };

type FakeCloudflare = {
  calls: Recorded[];
  creates: () => Recorded[];
  deletes: () => Recorded[];
  /** Tokens that exist at the fake, by id. */
  tokens: Map<string, { name: string; expiresOn: string }>;
  setCreateStatus: (status: number) => void;
  setDeleteStatus: (status: number) => void;
  setListStatus: (status: number) => void;
  /** Adds this permission group (named) to every token the fake makes. */
  addGroup: (group: { id: string; name: string } | null) => void;
  setExpirySkewMs: (ms: number) => void;
  manager: { reads: URL[]; removeCredential: () => void };
};

/**
 * Stands in for Cloudflare's account token API, Infisical's login and `/ci/minting` read, and the
 * GitHub issuer. Records every Cloudflare request with its authorization header. All values are
 * synthetic.
 */
function installFakes(github: TestProvider): FakeCloudflare {
  const calls: Recorded[] = [];
  const tokens = new Map<string, { name: string; expiresOn: string }>();
  const reads: URL[] = [];
  let createStatus = 200;
  let deleteStatus = 200;
  let listStatus = 200;
  let extraGroup: { id: string; name: string } | null = null;
  let expirySkewMs = 0;
  let credentialPresent = true;
  let serial = 0;
  const issuer = providerFetch([github]).fetch;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    if (url.origin === 'https://manager.sts-test.invalid') {
      if (url.pathname === '/api/v1/auth/jwt-auth/login') {
        return Response.json({ accessToken: 'manager-access-token', expiresIn: 600 });
      }
      if (url.pathname === '/api/v4/secrets') {
        reads.push(url);
        const folder = url.searchParams.get('secretPath');
        const secrets =
          folder === MINTING_FOLDER && credentialPresent
            ? [
                {
                  id: 'minting-id',
                  secretKey: CLOUDFLARE_MINTING_TOKEN_SECRET,
                  secretValue: MINTING_CREDENTIAL,
                  version: 3,
                  type: 'shared',
                  secretPath: MINTING_FOLDER,
                  secretValueHidden: false,
                },
              ]
            : [];
        return Response.json({ secrets, imports: [] });
      }
      return new Response('not found', { status: 404 });
    }
    if (url.origin !== 'https://api.cloudflare.com') return await issuer(input, init);
    const method = init?.method ?? 'GET';
    const raw = init?.body;
    const body: unknown = typeof raw === 'string' ? JSON.parse(raw) : null;
    const authorization = new Headers(init?.headers).get('authorization');
    const path = url.pathname.replace('/client/v4', '');
    calls.push({ method, path: `${path}${url.search}`, authorization, body });
    if (authorization !== `Bearer ${MINTING_CREDENTIAL}`) {
      return Response.json({ success: false }, { status: 403 });
    }
    const tokensPath = `/accounts/${ACCOUNT_ID}/tokens`;
    if (method === 'POST' && path === tokensPath) {
      if (createStatus !== 200) {
        const headers: Record<string, string> = createStatus === 429 ? { 'retry-after': '90' } : {};
        return new Response('refused', { status: createStatus, headers });
      }
      serial += 1;
      const request = body as {
        name: string;
        expires_on: string;
        policies: { permission_groups: { id: string }[] }[];
      };
      const id = serial.toString(16).padStart(32, 'e');
      const expiresOn = new Date(Date.parse(request.expires_on) + expirySkewMs)
        .toISOString()
        .replace('.000Z', 'Z');
      tokens.set(id, { name: request.name, expiresOn });
      const policies = request.policies.map(policy => ({
        id: 'f'.repeat(32),
        effect: 'allow',
        permission_groups: policy.permission_groups.map(group => ({
          id: group.id,
          name: GROUP_NAMES[group.id],
        })),
      }));
      if (extraGroup !== null) policies[0].permission_groups.push(extraGroup);
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: {
          id,
          name: request.name,
          status: 'active',
          expires_on: expiresOn,
          policies,
          value: `cfat_synthetic-deploy-token-${serial}`,
        },
      });
    }
    if (method === 'DELETE' && path.startsWith(`${tokensPath}/`)) {
      if (deleteStatus !== 200) {
        const headers: Record<string, string> =
          deleteStatus === 429 ? { 'retry-after': '120' } : {};
        return new Response('refused', { status: deleteStatus, headers });
      }
      const id = path.split('/').pop() ?? '';
      if (!tokens.delete(id)) return Response.json({ success: false }, { status: 404 });
      return Response.json({ success: true, result: { id } });
    }
    if (method === 'GET' && path === tokensPath) {
      if (listStatus !== 200) return new Response('refused', { status: listStatus });
      const page = Number(url.searchParams.get('page'));
      const perPage = Number(url.searchParams.get('per_page'));
      const all = [...tokens].map(([id, token]) => ({
        id,
        name: token.name,
        status: 'active',
        expires_on: token.expiresOn,
      }));
      return Response.json({
        success: true,
        result: all.slice((page - 1) * perPage, page * perPage),
        result_info: { page, per_page: perPage, count: all.length, total_count: all.length },
      });
    }
    return new Response('not found', { status: 404 });
  };
  vi.stubGlobal('fetch', fetchImpl);
  return {
    calls,
    creates: () => calls.filter(call => call.method === 'POST'),
    deletes: () => calls.filter(call => call.method === 'DELETE'),
    tokens,
    setCreateStatus: status => {
      createStatus = status;
    },
    setDeleteStatus: status => {
      deleteStatus = status;
    },
    setListStatus: status => {
      listStatus = status;
    },
    addGroup: group => {
      extraGroup = group;
    },
    setExpirySkewMs: ms => {
      expirySkewMs = ms;
    },
    manager: {
      reads,
      removeCredential: () => {
        credentialPresent = false;
      },
    },
  };
}

let pending: Promise<unknown>[] = [];
let github: TestProvider;

const JOB_CLAIMS = {
  sub: 'repo:acme@654/bouncer@321:environment:production',
  repository: 'acme/bouncer',
  repository_id: '321',
  repository_owner_id: '654',
  environment: 'production',
  ref: 'refs/heads/main',
  event_name: 'push',
  job_workflow_ref: DEPLOY_WORKFLOW,
  run_id: '9001',
  run_attempt: '1',
};

const OTHER_CLAIMS = {
  ...JOB_CLAIMS,
  sub: 'repo:acme@654/other@322:environment:production',
  repository: 'acme/other',
  repository_id: '322',
  job_workflow_ref: OTHER_WORKFLOW,
  run_id: '7001',
};

async function post(path: string, body: string, token?: string): Promise<Response> {
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: () => undefined,
    props: {},
  };
  return await handleRequest(
    new Request(`${config.issuer}${path}`, {
      method: 'POST',
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      body,
    }),
    env,
    ctx as unknown as ExecutionContext,
    authority
  );
}

async function mint(
  claims: Record<string, string> = JOB_CLAIMS,
  body = ''
): Promise<{ status: number; result: CloudflareDeployTokenResult; response: Response }> {
  const response = await post(
    '/v1/ci/cloudflare-deploy-token',
    body,
    await signToken(github, claims)
  );
  const result = CloudflareDeployTokenResultSchema.parse(await response.clone().json());
  return { status: response.status, result, response };
}

function issued(
  result: CloudflareDeployTokenResult
): Extract<CloudflareDeployTokenResult, { status: 'ok' }> {
  if (result.status !== 'ok') throw new Error(`expected a token, got ${JSON.stringify(result)}`);
  return result;
}

async function revoke(
  tokenId: string,
  claims: Record<string, string> = JOB_CLAIMS
): Promise<{ status: number; body: unknown }> {
  const response = await post(
    '/v1/ci/cloudflare-deploy-token/revoke',
    JSON.stringify({ tokenId }),
    await signToken(github, claims)
  );
  const body: unknown = await response.json();
  CloudflareDeployTokenRevokeResultSchema.parse(body);
  return { status: response.status, body };
}

type Event = {
  type: string;
  data: { outcome: string; outcomeDetail?: string; attributes: Record<string, unknown> };
};

async function tokenEvents(): Promise<Event[]> {
  return await runInDurableObject(getDeployTokenStub(env, config), (_instance, state) =>
    state.storage.sql
      .exec<{ event: string }>('SELECT event FROM audit_event ORDER BY seq')
      .toArray()
      .map(row => JSON.parse(row.event) as Event)
  );
}

/** Every value in every table of the deploy-token object, as one string. */
async function storedText(): Promise<string> {
  return await runInDurableObject(getDeployTokenStub(env, config), (_instance, state) => {
    const tables = state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
      )
      .toArray()
      .map(row => row.name);
    return JSON.stringify(
      tables.map(table => state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray())
    );
  });
}

async function flushedDenials(): Promise<Event[]> {
  await Promise.all(pending);
  const stub = getDenialStub(env, config);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(`UPDATE denial_window SET minute = '2020-01-01T00:00'`);
  });
  await runDurableObjectAlarm(stub);
  return await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ event: string }>('SELECT event FROM audit_event ORDER BY seq')
      .toArray()
      .map(row => JSON.parse(row.event) as Event)
  );
}

/** Runs SQL in the deploy-token object (test code only), such as moving a token past its expiry. */
async function sqlInObject(statement: string): Promise<void> {
  await runInDurableObject(getDeployTokenStub(env, config), (_instance, state) => {
    state.storage.sql.exec(statement);
  });
}

/** Everything the console received, as one string, for the no-credential-in-logs checks. */
function consoleText(spies: MockInstance[]): string {
  return JSON.stringify(spies.flatMap(spy => spy.mock.calls));
}

beforeAll(async () => {
  github = await createProvider(GITHUB_ISSUER, config.issuer);
});

beforeEach(async () => {
  pending = [];
  clearDenialBuffers();
  stubOfflineNetwork();
  await resetDeployTokenObject(getDeployTokenStub(env, config));
  await resetDenialObject(getDenialStub(env, config));
});

afterEach(() => {
  stubOfflineNetwork();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('mint', () => {
  it('gives a deploy job a 1-hour token with its permission set and audits it without the value', async () => {
    const cloudflare = installFakes(github);
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const before = Date.now();
    const { status, result, response } = await mint();
    expect(status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const token = issued(result);
    expect(token).toMatchObject({
      token: 'cfat_synthetic-deploy-token-1',
      ttlSeconds: 3600,
      permissionSet: 'bouncer-deploy',
    });

    const [create] = cloudflare.creates();
    expect(cloudflare.creates()).toHaveLength(1);
    expect(create.path).toBe(`/accounts/${ACCOUNT_ID}/tokens`);
    expect(create.authorization).toBe(`Bearer ${MINTING_CREDENTIAL}`);
    const body = create.body as {
      name: string;
      not_before: string;
      expires_on: string;
      policies: unknown;
    };
    expect(body.name).toMatch(/^sts-development-ci-deploy-bouncer-9001-\d+$/);
    expect(body.policies).toEqual([
      {
        effect: 'allow',
        permission_groups: [{ id: SCRIPTS_GROUP }, { id: CONTAINERS_GROUP }],
        resources: { [`com.cloudflare.api.account.${ACCOUNT_ID}`]: '*' },
      },
      {
        effect: 'allow',
        permission_groups: [{ id: ROUTES_GROUP }],
        resources: { [`com.cloudflare.api.account.zone.${ZONE_ID}`]: '*' },
      },
    ]);
    const notBefore = Date.parse(body.not_before);
    const expiresOn = Date.parse(body.expires_on);
    expect(notBefore).toBeGreaterThanOrEqual(before - 1000);
    expect(notBefore).toBeLessThanOrEqual(Date.now());
    expect(expiresOn - notBefore).toBeGreaterThan(3600_000 - 1000);
    expect(expiresOn - notBefore).toBeLessThanOrEqual(3600_000);
    expect(Date.parse(token.expiresAt)).toBe(expiresOn);

    // The minting credential is read from /ci/minting itself, nothing below it.
    expect(cloudflare.manager.reads).toHaveLength(1);
    expect(cloudflare.manager.reads[0].searchParams.get('secretPath')).toBe(MINTING_FOLDER);
    expect(cloudflare.manager.reads[0].searchParams.get('recursive')).toBe('false');

    const events = await tokenEvents();
    expect(events.map(event => event.type)).toEqual(['ai.kilo.sts.deploy_token.minted']);
    expect(events[0].data.attributes).toEqual({
      workload: 'ci-deploy-bouncer',
      environment: 'development',
      identity: 'github',
      channel: 'http',
      provider: 'cloudflare',
      permissionSet: 'bouncer-deploy',
      tokenId: token.tokenId,
      tokenName: body.name,
      ttlSeconds: 3600,
      expiresAt: token.expiresAt,
      permissionGroups: [SCRIPTS_GROUP, CONTAINERS_GROUP, ROUTES_GROUP],
      zones: [ZONE_ID],
      intendedScripts: ['bouncer', 'bouncer-watch'],
      jobWorkflowRef: DEPLOY_WORKFLOW,
      runId: '9001',
      runAttempt: '1',
    });
    const stored = await storedText();
    expect(stored).not.toContain('cfat_synthetic');
    expect(stored).not.toContain(MINTING_CREDENTIAL);
    const logged = consoleText(spies);
    expect(logged).not.toContain('cfat_synthetic');
    expect(logged).not.toContain(MINTING_CREDENTIAL);
  });

  it('accepts an empty body or {}, and refuses any field', async () => {
    const cloudflare = installFakes(github);
    expect((await mint(JOB_CLAIMS, '{}')).status).toBe(200);
    expect((await mint(JOB_CLAIMS, '{"ttlSeconds":86400}')).result).toEqual({
      status: 'invalid_request',
    });
    expect(cloudflare.creates()).toHaveLength(1);
  });

  it('refuses another workflow, a pull_request job and another GitHub environment, with no Cloudflare call', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refusals = [
      {
        ...JOB_CLAIMS,
        job_workflow_ref: 'acme/bouncer/.github/workflows/evil.yml@refs/heads/main',
      },
      { ...JOB_CLAIMS, event_name: 'pull_request' },
      {
        ...JOB_CLAIMS,
        environment: 'staging',
        sub: 'repo:acme@654/bouncer@321:environment:staging',
      },
      { ...JOB_CLAIMS, ref: 'refs/heads/feature' },
    ];
    for (const claims of refusals) {
      const { status, result } = await mint(claims);
      expect(status, JSON.stringify(claims)).toBe(401);
      expect(result).toEqual({ status: 'denied', reason: 'identity_rejected' });
    }
    expect(cloudflare.calls).toEqual([]);
    const denials = (await flushedDenials()).map(event => event.data);
    expect(denials.every(denial => denial.outcomeDetail === 'identity_rejected')).toBe(true);
    expect(denials.map(denial => denial.attributes.provider)).toContain('cloudflare');
  });

  it('denies a GitHub policy without the grant, and audits the reason', async () => {
    const cloudflare = installFakes(github);
    const { status, result } = await mint({
      ...JOB_CLAIMS,
      job_workflow_ref: PLAIN_WORKFLOW,
    });
    expect(status).toBe(403);
    expect(result).toEqual({ status: 'denied', reason: 'grant_not_allowed' });
    expect(cloudflare.calls).toEqual([]);
    const [denial] = await flushedDenials();
    expect(denial.type).toBe('ai.kilo.sts.deploy_token.denied');
    expect(denial.data.attributes).toMatchObject({
      reason: 'grant_not_allowed',
      workload: 'ci-bouncer-lint',
      channel: 'http',
    });
  });

  it('refuses a token beyond maxActive and beyond the hourly cap, with no Cloudflare call', async () => {
    const cloudflare = installFakes(github);
    const first = issued((await mint()).result);
    issued((await mint()).result);
    const third = await mint();
    expect(third.status).toBe(429);
    expect(third.result).toMatchObject({ status: 'limited', reason: 'too_many_active' });
    expect(Number(third.response.headers.get('retry-after'))).toBeGreaterThan(3000);
    expect(cloudflare.creates()).toHaveLength(2);

    // A revoked token frees its slot, but every creation counts against the hour (4 here).
    expect((await revoke(first.tokenId)).status).toBe(200);
    const third2 = issued((await mint()).result);
    expect((await revoke(third2.tokenId)).status).toBe(200);
    const fourth = issued((await mint()).result);
    expect((await revoke(fourth.tokenId)).status).toBe(200);
    const capped = await mint();
    expect(capped.result).toMatchObject({ status: 'limited', reason: 'rate_limited' });
    expect(cloudflare.creates()).toHaveLength(4);
    const reasons = (await flushedDenials()).map(event => event.data.attributes.reason);
    expect(reasons).toEqual(expect.arrayContaining(['too_many_active', 'rate_limited']));
  });

  it('answers unavailable without the minting credential, and makes no Cloudflare call', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    cloudflare.manager.removeCredential();
    expect((await mint()).result).toEqual({
      status: 'unavailable',
      retryAfterSeconds: DEPLOY_TOKEN_RETRY_AFTER_SECONDS,
    });
    expect(cloudflare.calls).toEqual([]);
  });

  it('mints nothing in an environment without CF_DEPLOY_ACCOUNT_ID', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runInDurableObject(
      getDeployTokenStub(env, config),
      async (_instance, state) =>
        new DeployTokenDO(state, { ...env, CF_DEPLOY_ACCOUNT_ID: '' }).mint({
          environment: 'development',
          caller: {
            workload: 'ci-deploy-bouncer',
            identity: 'github',
            channel: 'http',
            run: { jobWorkflowRef: DEPLOY_WORKFLOW, runId: '1' },
          },
          grant: {
            grant: 'cloudflare-deploy',
            permissionSet: 'x',
            permissionGroups: [
              { id: SCRIPTS_GROUP, name: 'Workers Scripts Write', scope: 'account' },
            ],
            zones: [],
            intendedScripts: ['bouncer'],
            ttlSeconds: 3600,
            maxActive: 1,
            maxPerHour: 1,
          },
          requestedAt: Date.now(),
        })
    );
    expect(result).toEqual({
      status: 'unavailable',
      retryAfterSeconds: DEPLOY_TOKEN_RETRY_AFTER_SECONDS,
    });
    expect(cloudflare.calls).toEqual([]);
  });

  it('makes no token for a request that reached the object after its budget', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const policy = authority.policies.get('development', 'ci-deploy-bouncer');
    const grant = policy?.dynamic[0];
    if (grant === undefined || grant.grant !== 'cloudflare-deploy') throw new Error('no grant');
    const result = await getDeployTokenStub(env, config).mint({
      environment: 'development',
      caller: {
        workload: 'ci-deploy-bouncer',
        identity: 'github',
        channel: 'http',
        run: { jobWorkflowRef: DEPLOY_WORKFLOW, runId: '1' },
      },
      grant,
      requestedAt: Date.now() - DEPLOY_TOKEN_MINT_BUDGET_MS - 1000,
    });
    expect(result).toMatchObject({ status: 'unavailable' });
    expect(cloudflare.calls).toEqual([]);
  });

  it('deletes a token Cloudflare made with a group it was not asked for, or one that administers tokens', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    cloudflare.addGroup({ id: '9'.repeat(32), name: 'Account API Tokens Write' });
    expect((await mint()).result).toMatchObject({ status: 'unavailable' });
    expect(cloudflare.deletes()).toHaveLength(1);
    expect(cloudflare.tokens.size).toBe(0);
    const events = await tokenEvents();
    expect(events.map(event => [event.type, event.data.attributes.cause])).toEqual([
      ['ai.kilo.sts.deploy_token.revoked', 'grant_mismatch'],
    ]);
    expect(events[0].data.attributes.result).toBe('deleted');
  });

  it('deletes a token whose expiry is not the one asked for', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    cloudflare.setExpirySkewMs(24 * 60 * 60 * 1000);
    expect((await mint()).result).toMatchObject({ status: 'unavailable' });
    expect(cloudflare.deletes()).toHaveLength(1);
    expect((await tokenEvents()).map(event => event.data.attributes.cause)).toEqual([
      'expiry_mismatch',
    ]);
  });

  it('drops a credential Cloudflare refused, and reads the manager again on the next mint', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    cloudflare.setCreateStatus(403);
    expect((await mint()).result).toMatchObject({ status: 'unavailable' });
    cloudflare.setCreateStatus(200);
    issued((await mint()).result);
    expect(cloudflare.manager.reads).toHaveLength(2);
  });

  it('waits out a 429 from Cloudflare without another call', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    cloudflare.setCreateStatus(429);
    expect((await mint()).result).toEqual({ status: 'unavailable', retryAfterSeconds: 90 });
    cloudflare.setCreateStatus(200);
    const held = await mint();
    expect(held.result).toMatchObject({ status: 'unavailable' });
    expect(cloudflare.creates()).toHaveLength(1);
  });

  it('brings the sweep forward after a creation whose outcome is unknown', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    cloudflare.setCreateStatus(502);
    const before = Date.now();
    expect((await mint()).result).toMatchObject({ status: 'unavailable' });
    const next = await runInDurableObject(getDeployTokenStub(env, config), (_instance, state) =>
      state.storage.sql
        .exec<{ next_sweep_at: number }>('SELECT next_sweep_at FROM deploy_token_sweep')
        .one()
    );
    expect(next.next_sweep_at).toBeLessThan(before + 2 * 3600_000);
  });
});

describe('revoke', () => {
  it('lets the owner job revoke, and refuses another workload and another run', async () => {
    const cloudflare = installFakes(github);
    const token = issued((await mint()).result);

    const crossed = await revoke(token.tokenId, OTHER_CLAIMS);
    expect(crossed).toEqual({ status: 404, body: { status: 'not_found' } });
    const otherRun = await revoke(token.tokenId, { ...JOB_CLAIMS, run_id: '9002' });
    expect(otherRun.status).toBe(404);
    const unknown = await revoke('1'.repeat(32));
    expect(unknown.status).toBe(404);
    expect(cloudflare.deletes()).toEqual([]);

    // A re-run attempt of the same run may revoke it.
    const own = await revoke(token.tokenId, { ...JOB_CLAIMS, run_attempt: '2' });
    expect(own).toEqual({ status: 200, body: { status: 'revoked', tokenId: token.tokenId } });
    expect(cloudflare.deletes().map(call => call.path)).toEqual([
      `/accounts/${ACCOUNT_ID}/tokens/${token.tokenId}`,
    ]);
    expect(cloudflare.deletes()[0].authorization).toBe(`Bearer ${MINTING_CREDENTIAL}`);
    // Already deleted: no second Cloudflare call.
    expect((await revoke(token.tokenId)).status).toBe(200);
    expect(cloudflare.deletes()).toHaveLength(1);

    const revoked = (await tokenEvents()).filter(
      event => event.type === 'ai.kilo.sts.deploy_token.revoked'
    );
    expect(revoked.map(event => event.data.attributes)).toEqual([
      expect.objectContaining({ cause: 'caller', result: 'deleted', runId: '9001' }),
    ]);
    const denials = (await flushedDenials()).map(event => [
      event.data.attributes.workload,
      event.data.attributes.reason,
      event.data.attributes.tokenId,
    ]);
    expect(denials).toEqual(
      expect.arrayContaining([
        ['ci-deploy-other', 'not_owner', token.tokenId],
        ['ci-deploy-bouncer', 'other_run', token.tokenId],
        ['ci-deploy-bouncer', 'unknown_token', '1'.repeat(32)],
      ])
    );
  });

  it('audits a failed revoke once, retries it from the alarm, and audits the success', async () => {
    const cloudflare = installFakes(github);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = issued((await mint()).result);
    cloudflare.setDeleteStatus(503);
    expect((await revoke(token.tokenId)).body).toEqual({
      status: 'unavailable',
      retryAfterSeconds: DEPLOY_TOKEN_RETRY_AFTER_SECONDS,
    });
    expect((await revoke(token.tokenId)).status).toBe(503);
    const failures = (await tokenEvents()).filter(
      event => event.type === 'ai.kilo.sts.deploy_token.revoked'
    );
    expect(failures.map(event => [event.data.outcome, event.data.attributes.result])).toEqual([
      ['failure', 'delete_failed'],
    ]);

    cloudflare.setDeleteStatus(200);
    await sqlInObject('UPDATE deploy_token SET delete_retry_at = 0');
    await runDurableObjectAlarm(getDeployTokenStub(env, config));
    expect(cloudflare.tokens.size).toBe(0);
    const results = (await tokenEvents())
      .filter(event => event.type === 'ai.kilo.sts.deploy_token.revoked')
      .map(event => event.data.attributes.result);
    expect(results).toEqual(['delete_failed', 'deleted']);
    expect(consoleText([errors])).not.toContain(MINTING_CREDENTIAL);
  });
});

describe('reaper', () => {
  it('deletes a token past its expiry and audits it as reaped', async () => {
    const cloudflare = installFakes(github);
    const token = issued((await mint()).result);
    await sqlInObject(`UPDATE deploy_token SET expires_at = ${Date.now() - 1000}`);
    await runDurableObjectAlarm(getDeployTokenStub(env, config));
    expect(cloudflare.deletes().map(call => call.path)).toEqual([
      `/accounts/${ACCOUNT_ID}/tokens/${token.tokenId}`,
    ]);
    const reaped = (await tokenEvents()).filter(
      event => event.type === 'ai.kilo.sts.deploy_token.reaped'
    );
    expect(reaped.map(event => event.data.attributes)).toEqual([
      expect.objectContaining({
        source: 'ledger',
        tokenId: token.tokenId,
        workload: 'ci-deploy-bouncer',
        result: 'deleted',
        runId: '9001',
      }),
    ]);
    // The reaped token no longer counts against maxActive.
    issued((await mint()).result);
    issued((await mint()).result);
  });

  it('keeps retrying an expired token Cloudflare will not delete, at most a bounded number per alarm', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    issued((await mint()).result);
    issued((await mint()).result);
    await sqlInObject(`UPDATE deploy_token SET expires_at = ${Date.now() - 1000}`);
    cloudflare.setDeleteStatus(500);
    await runDurableObjectAlarm(getDeployTokenStub(env, config));
    expect(cloudflare.deletes().length).toBeLessThanOrEqual(DEPLOY_TOKEN_DELETES_PER_ALARM);
    expect(cloudflare.deletes()).toHaveLength(2);
    // Expired, but still owed: an expired Cloudflare token counts against the account cap.
    cloudflare.setDeleteStatus(200);
    await sqlInObject('UPDATE deploy_token SET delete_retry_at = 0');
    await runDurableObjectAlarm(getDeployTokenStub(env, config));
    expect(cloudflare.tokens.size).toBe(0);
    const reaped = (await tokenEvents())
      .filter(event => event.type === 'ai.kilo.sts.deploy_token.reaped')
      .map(event => event.data.attributes.result);
    expect(reaped).toEqual(['delete_failed', 'delete_failed', 'deleted', 'deleted']);
  });

  it('sweeps expired tokens of this environment that STS holds no row for, and nothing else', async () => {
    const cloudflare = installFakes(github);
    const live = issued((await mint()).result);
    const past = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const future = new Date(Date.now() + 600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    cloudflare.tokens.set('1'.repeat(32), {
      name: 'sts-development-ci-deploy-bouncer-1-9',
      expiresOn: past,
    });
    cloudflare.tokens.set('2'.repeat(32), {
      name: 'sts-production-ci-deploy-bouncer-1-9',
      expiresOn: past,
    });
    cloudflare.tokens.set('3'.repeat(32), {
      name: 'sts-development-ci-deploy-bouncer-2-9',
      expiresOn: future,
    });
    cloudflare.tokens.set('4'.repeat(32), { name: 'someone-elses-token', expiresOn: past });
    await sqlInObject('UPDATE deploy_token_sweep SET next_sweep_at = 0');
    await runDurableObjectAlarm(getDeployTokenStub(env, config));
    expect(cloudflare.deletes().map(call => call.path.split('/').pop())).toEqual(['1'.repeat(32)]);
    expect([...cloudflare.tokens.keys()].sort()).toEqual(
      [live.tokenId, '2'.repeat(32), '3'.repeat(32), '4'.repeat(32)].sort()
    );
    const swept = (await tokenEvents()).filter(
      event => event.type === 'ai.kilo.sts.deploy_token.reaped'
    );
    expect(swept.map(event => event.data.attributes)).toEqual([
      expect.objectContaining({
        source: 'sweep',
        tokenId: '1'.repeat(32),
        tokenName: 'sts-development-ci-deploy-bouncer-1-9',
        result: 'deleted',
      }),
    ]);
    const next = await runInDurableObject(getDeployTokenStub(env, config), (_instance, state) =>
      state.storage.sql
        .exec<{ next_sweep_at: number; page: number | null }>(
          'SELECT next_sweep_at, page FROM deploy_token_sweep'
        )
        .one()
    );
    expect(next.page).toBeNull();
    expect(next.next_sweep_at).toBeGreaterThan(Date.now() + 23 * 3600_000);
  });

  it('retries the sweep later when Cloudflare cannot list tokens', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    issued((await mint()).result);
    cloudflare.setListStatus(503);
    await sqlInObject('UPDATE deploy_token_sweep SET next_sweep_at = 0');
    await runDurableObjectAlarm(getDeployTokenStub(env, config));
    const next = await runInDurableObject(getDeployTokenStub(env, config), (_instance, state) =>
      state.storage.sql
        .exec<{ next_sweep_at: number }>('SELECT next_sweep_at FROM deploy_token_sweep')
        .one()
    );
    expect(next.next_sweep_at).toBeGreaterThan(Date.now());
    expect(next.next_sweep_at).toBeLessThan(Date.now() + 5 * 60_000);
  });
});

describe('policy', () => {
  const base = {
    workload: 'ci-deploy-x',
    environments: ['production'],
    identity: `
  kind: github-oidc
  repository: acme/x
  repositoryId: '1'
  repositoryOwnerId: '2'
  environment: production
  jobWorkflowRefs: [acme/x/.github/workflows/deploy.yml@refs/heads/main]
  events: [push]`,
    grant: `
  - grant: cloudflare-deploy
    permissionSet: x-deploy
    permissionGroups:
      - { id: '${SCRIPTS_GROUP}', name: Workers Scripts Write, scope: account }
    intendedScripts: [x]
    maxActive: 1
    maxPerHour: 2`,
  };

  function policyFile(overrides: Partial<typeof base> & { secrets?: string } = {}): string {
    const value = { ...base, ...overrides };
    return `
workload: ${value.workload}
environments: [${value.environments.join(', ')}]
identity:${value.identity}
secrets: ${overrides.secrets ?? '[]'}
dynamic:${value.grant}
`;
  }

  function load(source: string) {
    return loadPolicies({ 'ci-deploy-x.yaml': source });
  }

  it('loads a grant, defaults the lifetime to 1 hour, and snapshots it', () => {
    const index = load(policyFile());
    const grant = index.get('production', 'ci-deploy-x')?.dynamic[0];
    expect(grant).toMatchObject({ grant: 'cloudflare-deploy', ttlSeconds: 3600, zones: [] });
    expect(index.snapshot()[0].dynamic).toEqual(['cloudflare-deploy:x-deploy:3600:1:2:aaaaaaaa:']);
  });

  it.each([
    [
      'a worker-binding policy',
      { identity: '\n  kind: worker-binding' },
      'only for a github-oidc policy',
    ],
    [
      // A development-only policy, so the production rule cannot be the one that refuses it.
      'a GitHub policy without an environment',
      {
        environments: ['development'],
        identity: base.identity.replace('  environment: production\n', ''),
      },
      'with dynamic cloudflare-deploy must bind identity.environment',
    ],
    [
      'a production policy on another ref',
      {
        identity: base.identity
          .replace('refs/heads/main]', 'refs/heads/release]')
          .replace('events: [push]', 'events: [push]\n  refs: [refs/heads/release]'),
      },
      'accepts only refs/heads/main',
    ],
    ['a lifetime above 1 hour', { grant: `${base.grant}\n    ttlSeconds: 7200` }, 'ttlSeconds'],
    [
      'maxActive above 3',
      { grant: base.grant.replace('maxActive: 1', 'maxActive: 4') },
      'maxActive is above 3',
    ],
    [
      'maxPerHour above 12',
      { grant: base.grant.replace('maxPerHour: 2', 'maxPerHour: 13') },
      'maxPerHour is above 12',
    ],
    [
      'a group that creates API tokens',
      { grant: base.grant.replace('Workers Scripts Write', 'Account API Tokens Write') },
      'administers tokens or members',
    ],
    [
      'a group that manages members',
      { grant: base.grant.replace('Workers Scripts Write', 'Memberships Write') },
      'administers tokens or members',
    ],
    [
      'a zone group without zones',
      { grant: base.grant.replace('scope: account', 'scope: zone') },
      'needs zones',
    ],
    [
      'zones without a zone group',
      { grant: `${base.grant}\n    zones: ['${ZONE_ID}']` },
      'zones without a zone-scoped permission group',
    ],
    [
      'a group listed twice',
      {
        grant: base.grant.replace(
          'scope: account }',
          `scope: account }\n      - { id: '${SCRIPTS_GROUP}', name: Again, scope: account }`
        ),
      },
      'lists a group twice',
    ],
    ['the grant listed twice', { grant: `${base.grant}${base.grant}` }, 'lists a grant twice'],
    [
      'a permission group by name only',
      { grant: base.grant.replace(`id: '${SCRIPTS_GROUP}', `, '') },
      'does not match',
    ],
  ])('refuses %s', (_name, overrides, message) => {
    expect(() => load(policyFile(overrides))).toThrow(message);
  });

  it('refuses any policy that names a minting credential, whatever its identity', () => {
    expect(() => load(policyFile({ secrets: `[${CLOUDFLARE_MINTING_TOKEN_SECRET}]` }))).toThrow(
      'is a minting credential'
    );
    expect(() =>
      loadPolicies({
        'web.yaml': `
workload: web
environments: [production]
identity:
  kind: worker-binding
secrets: [${CLOUDFLARE_MINTING_TOKEN_SECRET}]
`,
      })
    ).toThrow('is a minting credential');
  });
});

describe('minting folder', () => {
  it('never returns a /ci/minting secret from the /ci read, and reads it alone non-recursively', async () => {
    const reads: URL[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      );
      if (url.pathname === '/api/v1/auth/jwt-auth/login') {
        return Response.json({ accessToken: 'manager-access-token', expiresIn: 600 });
      }
      reads.push(url);
      const entry = (path: string, name: string, value: string, hidden = false) => ({
        id: `${path}/${name}`,
        secretKey: name,
        secretValue: value,
        version: 1,
        type: 'shared',
        secretPath: path,
        secretValueHidden: hidden,
      });
      return Response.json({
        secrets: [
          entry('/ci/ci-deploy-bouncer', 'BOUNCER_KEY', 'synthetic-bundle-value'),
          entry(MINTING_FOLDER, CLOUDFLARE_MINTING_TOKEN_SECRET, MINTING_CREDENTIAL),
          entry(`${MINTING_FOLDER}/old`, 'OLD', 'synthetic-old-minting-value'),
          entry(MINTING_FOLDER, 'HIDDEN', '', true),
        ],
      });
    });
    const client = new InfisicalClient(config.manager, async () => {
      return await getSignerStub(env, config).signManagerToken();
    });
    const folder = await client.readFolder('/ci', null);
    expect(folder).toMatchObject({ status: 'fresh', hidden: 0 });
    if (folder.status !== 'fresh') throw new Error('expected a read');
    expect(folder.entries.map(entry => `${entry.path}/${entry.name}`)).toEqual([
      '/ci/ci-deploy-bouncer/BOUNCER_KEY',
    ]);
    expect(JSON.stringify(folder)).not.toContain('minting');

    expect(await client.readMintingSecret(CLOUDFLARE_MINTING_TOKEN_SECRET)).toEqual({
      status: 'ok',
      value: MINTING_CREDENTIAL,
    });
    expect(reads[1].searchParams.get('secretPath')).toBe(MINTING_FOLDER);
    expect(reads[1].searchParams.get('recursive')).toBe('false');
    expect(await client.readMintingSecret('OLD')).toEqual({ status: 'missing' });
  });
});
