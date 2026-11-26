import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import {
  CloudflareDeployTokenResultSchema,
  CloudflareDeployTokenRevokeResultSchema,
  type CloudflareDeployTokenResult,
} from '@kilocode/sts-contracts';
import {
  afterAll,
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
  CLOUDFLARE_FORBIDDEN_PERMISSION_GROUP_IDS,
  CLOUDFLARE_MINTING_TOKEN_SECRET,
  DEPLOY_TOKEN_CREDENTIAL_REFUSED_HOLD_MS,
  DEPLOY_TOKEN_DELETES_PER_ALARM,
  DEPLOY_TOKEN_MINT_BUDGET_MS,
  DEPLOY_TOKEN_RETRY_AFTER_SECONDS,
  DEPLOY_TOKEN_ROUTES_PER_ZONE_MAX,
  DEPLOY_TOKEN_ROUTE_ZONES_PER_CHECK,
  DEPLOY_TOKEN_ROW_RETENTION_MS,
  DEPLOY_TOKEN_UNEXPECTED_ROUTE_EVENTS_PER_CHECK,
  DEPLOY_TOKEN_UNEXPECTED_SCRIPT_EVENTS_PER_CHECK,
  DEPLOY_TOKEN_WINDOW_CHECK_RETRY_MS,
  MINTING_FOLDER,
} from '../../src/constants';
import {
  DeployTokenDO,
  deployTokenPolicies,
  returnedGrantProblem,
} from '../../src/dos/DeployTokenDO';
import { getDenialStub, getDeployTokenStub, getSignerStub } from '../../src/dos/stubs';
import { handleRequest } from '../../src/http';
import { InfisicalClient } from '../../src/infisical/client';
import { loadPolicies } from '../../src/policy/load';
import type { CloudflareDeployGrant } from '../../src/policy/schema';
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
const MINTING_CREDENTIAL = '[REDACTED by s1-secret-redact]';
/** The forbidden permission group these tests pin, as setup step 3 pins the real ones. */
const PINNED_GROUP = '7'.repeat(32);

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

/** The caller STS passes the object for a run of the bouncer deploy job, for direct calls. */
const CALLER = {
  workload: 'ci-deploy-bouncer',
  identity: 'github',
  channel: 'http',
  run: { jobWorkflowRef: DEPLOY_WORKFLOW, runId: '1' },
} as const;

function bouncerGrant(): CloudflareDeployGrant {
  const grant = authority.policies.get('development', 'ci-deploy-bouncer')?.dynamic[0];
  if (grant === undefined || grant.grant !== 'cloudflare-deploy') throw new Error('no grant');
  return grant;
}

type Recorded = { method: string; path: string; authorization: string | null; body: unknown };

/** One policy of a created token as the fake returns it; tests may change it before it goes out. */
type FakePolicy = {
  id: string;
  effect: string;
  permission_groups: { id: string; name?: string }[];
  resources: Record<string, string>;
};

/** A listed script; Cloudflare may leave out a field, which the check counts as dropped. */
type FakeScript = { id?: string; modified_on?: string };

type FakeRoute = { id: string; pattern: string; script?: string };

type FakeCloudflare = {
  calls: Recorded[];
  creates: () => Recorded[];
  deletes: () => Recorded[];
  scriptLists: () => Recorded[];
  routeLists: () => Recorded[];
  /** Tokens that exist at the fake, by id. */
  tokens: Map<string, { name: string; expiresOn: string }>;
  /** The account's Worker scripts, as `GET .../workers/scripts` lists them. */
  scripts: FakeScript[];
  /** Each zone's Workers routes, as `GET /zones/<zone>/workers/routes` lists them (none: empty). */
  routes: Map<string, FakeRoute[]>;
  setCreateStatus: (status: number) => void;
  setDeleteStatus: (status: number) => void;
  setListStatus: (status: number) => void;
  setScriptsStatus: (status: number) => void;
  /** Adds this permission group (named) to every token the fake makes. */
  addGroup: (group: { id: string; name: string } | null) => void;
  /** Changes the policies of every token the fake makes, as Cloudflare would return them. */
  editPolicies: (edit: ((policies: FakePolicy[]) => void) | null) => void;
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
  const scripts: FakeScript[] = [];
  const routes = new Map<string, FakeRoute[]>();
  const reads: URL[] = [];
  let createStatus = 200;
  let deleteStatus = 200;
  let listStatus = 200;
  let scriptsStatus = 200;
  let extraGroup: { id: string; name: string } | null = null;
  let editPolicies: ((policies: FakePolicy[]) => void) | null = null;
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
        policies: {
          effect: string;
          permission_groups: { id: string }[];
          resources: Record<string, string>;
        }[];
      };
      const id = serial.toString(16).padStart(32, 'e');
      const expiresOn = new Date(Date.parse(request.expires_on) + expirySkewMs)
        .toISOString()
        .replace('.000Z', 'Z');
      tokens.set(id, { name: request.name, expiresOn });
      const policies: FakePolicy[] = request.policies.map(policy => ({
        id: 'f'.repeat(32),
        effect: policy.effect,
        permission_groups: policy.permission_groups.map(group => ({
          id: group.id,
          name: GROUP_NAMES[group.id],
        })),
        resources: { ...policy.resources },
      }));
      if (extraGroup !== null) policies[0].permission_groups.push(extraGroup);
      editPolicies?.(policies);
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
    if (method === 'GET' && path === `/accounts/${ACCOUNT_ID}/workers/scripts`) {
      if (scriptsStatus !== 200) return new Response('refused', { status: scriptsStatus });
      return Response.json({ success: true, errors: [], messages: [], result: scripts });
    }
    const routesPath = /^\/zones\/([0-9a-f]{32})\/workers\/routes$/.exec(path);
    if (method === 'GET' && routesPath !== null) {
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: routes.get(routesPath[1]) ?? [],
      });
    }
    return new Response('not found', { status: 404 });
  };
  vi.stubGlobal('fetch', fetchImpl);
  return {
    calls,
    creates: () => calls.filter(call => call.method === 'POST'),
    deletes: () => calls.filter(call => call.method === 'DELETE'),
    scriptLists: () => calls.filter(call => call.path.endsWith('/workers/scripts')),
    routeLists: () => calls.filter(call => call.path.endsWith('/workers/routes')),
    tokens,
    scripts,
    routes,
    setCreateStatus: status => {
      createStatus = status;
    },
    setDeleteStatus: status => {
      deleteStatus = status;
    },
    setListStatus: status => {
      listStatus = status;
    },
    setScriptsStatus: status => {
      scriptsStatus = status;
    },
    addGroup: group => {
      extraGroup = group;
    },
    editPolicies: edit => {
      editPolicies = edit;
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

/**
 * Runs the deploy-token object's alarm now. It is set an hour ahead first, so the runtime does not
 * fire it on its own while the test runs it.
 */
async function alarmNow(): Promise<void> {
  const stub = getDeployTokenStub(env, config);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.setAlarm(Date.now() + 3600_000);
  });
  await runDurableObjectAlarm(stub);
}

/** When the deploy-token object's alarm is set to run next. */
async function currentAlarm(): Promise<number | null> {
  return await runInDurableObject(getDeployTokenStub(env, config), (_instance, state) =>
    state.storage.getAlarm()
  );
}

/** Moves this isolate's clock, which the deploy-token object reads too, `ms` ahead. */
function advanceClock(ms: number): void {
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + ms);
}

/** The deploy-token object's window-check state of one token's row. */
async function windowCheckOf(
  tokenId: string
): Promise<{ window_check: string | null; window_check_attempts: number } | undefined> {
  return await runInDurableObject(getDeployTokenStub(env, config), (_instance, state) =>
    state.storage.sql
      .exec<{ window_check: string | null; window_check_attempts: number }>(
        `SELECT window_check, window_check_attempts FROM deploy_token WHERE token_id = '${tokenId}'`
      )
      .toArray()
      .at(0)
  );
}

/** The deploy-token object's stored credential hold, or undefined when none runs. */
async function credentialHold(): Promise<{ until: number; hold_ms: number } | undefined> {
  return await runInDurableObject(getDeployTokenStub(env, config), (_instance, state) =>
    state.storage.sql
      .exec<{ until: number; hold_ms: number }>(
        'SELECT until, hold_ms FROM deploy_token_credential_hold'
      )
      .toArray()
      .at(0)
  );
}

async function deployTokenEvents(type: string): Promise<Event[]> {
  return (await tokenEvents()).filter(event => event.type === `ai.kilo.sts.deploy_token.${type}`);
}

function cloudflareIso(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Everything the console received, as one string, for the no-credential-in-logs checks. */
function consoleText(spies: MockInstance[]): string {
  return JSON.stringify(spies.flatMap(spy => spy.mock.calls));
}

beforeAll(async () => {
  github = await createProvider(GITHUB_ISSUER, config.issuer);
  DeployTokenDO.forbiddenPermissionGroupIds = [PINNED_GROUP];
});

afterAll(() => {
  DeployTokenDO.forbiddenPermissionGroupIds = CLOUDFLARE_FORBIDDEN_PERMISSION_GROUP_IDS;
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

  it('refuses every mint, not retryable, while CF_DEPLOY_ACCOUNT_ID is set and the forbidden-id pin is empty', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    DeployTokenDO.forbiddenPermissionGroupIds = [];
    try {
      const { status, result, response } = await mint();
      expect(status).toBe(403);
      expect(result).toEqual({ status: 'denied', reason: 'not_configured' });
      expect(response.headers.get('retry-after')).toBeNull();
    } finally {
      DeployTokenDO.forbiddenPermissionGroupIds = [PINNED_GROUP];
    }
    expect(cloudflare.calls).toEqual([]);
    expect(cloudflare.manager.reads).toEqual([]);
    const [denial] = await flushedDenials();
    expect(denial.data.attributes).toMatchObject({
      reason: 'not_configured',
      workload: 'ci-deploy-bouncer',
    });
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

  it.each<[string, (policies: FakePolicy[]) => void]>([
    [
      'leaves out a group name',
      policies => {
        delete policies[0].permission_groups[0].name;
      },
    ],
    [
      'names a group otherwise than the policy declares its id',
      policies => {
        policies[0].permission_groups[0].name = 'Workers KV Storage Write';
      },
    ],
    [
      // A policy listing the id of a token-administering group under a harmless name.
      'names a declared id as a token-administering group',
      policies => {
        policies[0].permission_groups[0].name = 'Account API Tokens Write';
      },
    ],
    [
      'returns another account',
      policies => {
        policies[0].resources = { [`com.cloudflare.api.account.${'9'.repeat(32)}`]: '*' };
      },
    ],
    [
      'returns another zone',
      policies => {
        policies[1].resources = { [`com.cloudflare.api.account.zone.${'8'.repeat(32)}`]: '*' };
      },
    ],
    [
      'returns a deny policy',
      policies => {
        policies[0].effect = 'deny';
      },
    ],
    [
      'moves a group onto the zone policy',
      policies => {
        const [moved] = policies[0].permission_groups.splice(1, 1);
        policies[1].permission_groups.push(moved);
      },
    ],
  ])('deletes a token whose returned grant %s', async (_name, edit) => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    cloudflare.editPolicies(edit);
    expect((await mint()).result).toMatchObject({ status: 'unavailable' });
    expect(cloudflare.deletes()).toHaveLength(1);
    expect(cloudflare.tokens.size).toBe(0);
    expect((await tokenEvents()).map(event => [event.type, event.data.attributes.cause])).toEqual([
      ['ai.kilo.sts.deploy_token.revoked', 'grant_mismatch'],
    ]);
  });

  it('refuses to mint a grant that lists a pinned forbidden permission group, with no Cloudflare call', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    class PinnedDeployTokenDO extends DeployTokenDO {
      static override forbiddenPermissionGroupIds = [CONTAINERS_GROUP];
    }
    const result = await runInDurableObject(
      getDeployTokenStub(env, config),
      async (_instance, state) =>
        await new PinnedDeployTokenDO(state, env).mint({
          environment: 'development',
          caller: CALLER,
          grant: bouncerGrant(),
          requestedAt: Date.now(),
        })
    );
    expect(result).toEqual({
      status: 'unavailable',
      retryAfterSeconds: DEPLOY_TOKEN_RETRY_AFTER_SECONDS,
    });
    expect(cloudflare.calls).toEqual([]);
  });

  it('advertises when a slot opens under an hourly cap lowered below the creations in the hour', async () => {
    installFakes(github);
    const now = Date.now();
    for (const minutesAgo of [50, 40, 30, 20]) {
      const createdAt = now - minutesAgo * 60_000;
      await sqlInObject(
        `INSERT INTO deploy_token (workload, caller, run_id, permission_set, state, created_at, expires_at, ended_at, intended_scripts, zones) VALUES ('ci-deploy-bouncer', '${JSON.stringify(CALLER)}', '1', 'bouncer-deploy', 'failed', ${createdAt}, ${createdAt + 30_000}, ${createdAt + 30_000}, '[]', '[]')`
      );
    }
    const result = await getDeployTokenStub(env, config).mint({
      environment: 'development',
      caller: CALLER,
      grant: { ...bouncerGrant(), maxActive: 1, maxPerHour: 2 },
      requestedAt: Date.now(),
    });
    // Two of the four must leave the hour: the one made 30 minutes ago is the second to leave.
    if (result.status !== 'limited') throw new Error(`expected a refusal, got ${result.status}`);
    expect(result.reason).toBe('rate_limited');
    expect(result.retryAfterSeconds).toBeGreaterThan(29 * 60);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(30 * 60);
  });

  it('drops a credential Cloudflare refused with 401, holds the alarm, audits the refusal, and reads the manager again on the next mint', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    cloudflare.setCreateStatus(401);
    expect((await mint()).result).toMatchObject({ status: 'unavailable' });
    const [failed] = await tokenEvents();
    expect(failed.type).toBe('ai.kilo.sts.deploy_token.mint_failed');
    expect(failed.data.outcomeDetail).toBe('refused');
    expect(failed.data.attributes).toMatchObject({
      workload: 'ci-deploy-bouncer',
      outcome: 'refused',
      httpStatus: 401,
      runId: '9001',
    });
    expect(failed.data.attributes.tokenName).toMatch(
      /^sts-development-ci-deploy-bouncer-9001-\d+$/
    );
    expect((await credentialHold())?.hold_ms).toBe(DEPLOY_TOKEN_CREDENTIAL_REFUSED_HOLD_MS);
    cloudflare.setCreateStatus(200);
    issued((await mint()).result);
    expect(cloudflare.manager.reads).toHaveLength(2);
    // Cloudflare took the credential again: the hold ended.
    expect(await credentialHold()).toBeUndefined();
  });

  it('keeps the credential and starts no hold after a 403 on token creation', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    cloudflare.setCreateStatus(403);
    expect((await mint()).result).toMatchObject({ status: 'unavailable' });
    expect((await deployTokenEvents('mint_failed'))[0].data.attributes.httpStatus).toBe(403);
    expect(await credentialHold()).toBeUndefined();
    cloudflare.setCreateStatus(200);
    issued((await mint()).result);
    expect(cloudflare.manager.reads).toHaveLength(1);
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

  it('audits a creation whose outcome is unknown and brings the sweep forward', async () => {
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
    const events = await tokenEvents();
    expect(events.map(event => [event.type, event.data.attributes.outcome])).toEqual([
      ['ai.kilo.sts.deploy_token.mint_failed', 'unknown'],
    ]);
    expect(events[0].data.attributes.slot).toEqual(expect.any(Number));
    expect(events[0].data.attributes).not.toHaveProperty('httpStatus');
    expect(JSON.stringify(events)).not.toContain('cfat_');
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

  it('holds every Cloudflare call of the alarm after a refused credential, the sweep included, doubling the hold', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    issued((await mint()).result);
    issued((await mint()).result);
    await sqlInObject(`UPDATE deploy_token SET expires_at = ${Date.now() - 1000}`);
    await sqlInObject('UPDATE deploy_token_sweep SET next_sweep_at = 0');
    cloudflare.setDeleteStatus(403);
    const readsBefore = cloudflare.manager.reads.length;
    const holdState = async () =>
      await runInDurableObject(getDeployTokenStub(env, config), (_instance, state) => ({
        sweep: state.storage.sql
          .exec<{ next_sweep_at: number }>('SELECT next_sweep_at FROM deploy_token_sweep')
          .one(),
        hold: state.storage.sql
          .exec<{ until: number; hold_ms: number }>(
            'SELECT until, hold_ms FROM deploy_token_credential_hold'
          )
          .toArray()
          .at(0),
      }));
    await alarmNow();
    // One delete with the cached credential; after its 403 no second delete, no new read, no sweep.
    expect(cloudflare.deletes()).toHaveLength(1);
    expect(cloudflare.manager.reads.length - readsBefore).toBe(0);
    expect(cloudflare.calls.filter(call => call.method === 'GET')).toEqual([]);
    const first = await holdState();
    expect(first.hold?.hold_ms).toBe(DEPLOY_TOKEN_CREDENTIAL_REFUSED_HOLD_MS);
    // The skipped sweep waits for the hold, not one second.
    expect(first.sweep.next_sweep_at).toBeGreaterThanOrEqual(
      Date.now() + DEPLOY_TOKEN_CREDENTIAL_REFUSED_HOLD_MS - 1000
    );
    // The relay alarm a few seconds later reads nothing and calls nothing either.
    await alarmNow();
    expect(cloudflare.deletes()).toHaveLength(1);
    expect(cloudflare.manager.reads.length - readsBefore).toBe(0);

    // After the hold, one fresh read and one call; refused again, the hold doubles.
    advanceClock(DEPLOY_TOKEN_CREDENTIAL_REFUSED_HOLD_MS + 1000);
    await alarmNow();
    expect(cloudflare.deletes()).toHaveLength(2);
    expect(cloudflare.manager.reads.length - readsBefore).toBe(1);
    expect(cloudflare.calls.filter(call => call.method === 'GET')).toEqual([]);
    const second = await holdState();
    expect(second.hold?.hold_ms).toBe(2 * DEPLOY_TOKEN_CREDENTIAL_REFUSED_HOLD_MS);
    expect(second.sweep.next_sweep_at).toBeGreaterThanOrEqual(
      Date.now() + 2 * DEPLOY_TOKEN_CREDENTIAL_REFUSED_HOLD_MS - 1000
    );

    // Cloudflare takes the credential again: the hold ends and the deletes and the sweep resume.
    cloudflare.setDeleteStatus(200);
    advanceClock(2 * DEPLOY_TOKEN_CREDENTIAL_REFUSED_HOLD_MS + 1000);
    await alarmNow();
    expect(cloudflare.tokens.size).toBe(0);
    expect((await holdState()).hold).toBeUndefined();
    expect(
      cloudflare.calls.filter(call => call.method === 'GET' && call.path.includes('/tokens?'))
    ).toHaveLength(1);
  });

  it('ends a creation an earlier instance left pending, audits it, and brings the sweep forward', async () => {
    installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deadline = Date.now() - 1000;
    await sqlInObject(
      `INSERT INTO deploy_token (slot, workload, caller, run_id, permission_set, state, created_at, expires_at, intended_scripts, zones) VALUES (41, 'ci-deploy-bouncer', '${JSON.stringify(CALLER)}', '1', 'bouncer-deploy', 'pending', ${deadline - 30_000}, ${deadline}, '["bouncer"]', '[]')`
    );
    await alarmNow();
    const state = await runInDurableObject(
      getDeployTokenStub(env, config),
      (_instance, storage) => ({
        row: storage.storage.sql
          .exec<{ state: string }>('SELECT state FROM deploy_token WHERE slot = 41')
          .one(),
        sweep: storage.storage.sql
          .exec<{ next_sweep_at: number }>('SELECT next_sweep_at FROM deploy_token_sweep')
          .one(),
      })
    );
    expect(state.row.state).toBe('failed');
    // Such a token expires at most 1 hour after the budget ended; the sweep comes 2 minutes later.
    expect(state.sweep.next_sweep_at).toBe(deadline + 3600_000 + 120_000);
    const failed = await deployTokenEvents('mint_failed');
    expect(failed.map(event => event.data.attributes)).toEqual([
      expect.objectContaining({
        outcome: 'unknown',
        slot: 41,
        tokenName: 'sts-development-ci-deploy-bouncer-1-41',
        workload: 'ci-deploy-bouncer',
      }),
    ]);
  });
});

describe('window check', () => {
  it('runs about 2 minutes after a revoke and audits a Worker its intendedScripts does not name, once', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = Date.now();
    const token = issued((await mint()).result);
    expect((await revoke(token.tokenId)).status).toBe(200);
    const revokedAt = Date.now();
    cloudflare.scripts.push(
      { id: 'bouncer', modified_on: cloudflareIso(revokedAt) },
      { id: 'evil-worker', modified_on: cloudflareIso(revokedAt) },
      { id: 'old-worker', modified_on: cloudflareIso(before - 10 * 60_000) }
    );
    // The window has not closed yet; the alarm comes back when it has, not a day later.
    await alarmNow();
    expect(cloudflare.scriptLists()).toEqual([]);
    expect(await currentAlarm()).toBeLessThanOrEqual(revokedAt + 2 * 60_000 + 1000);

    advanceClock(3 * 60_000);
    await alarmNow();
    expect(cloudflare.scriptLists()).toHaveLength(1);
    expect(cloudflare.scriptLists()[0].authorization).toBe(`Bearer ${MINTING_CREDENTIAL}`);
    expect(cloudflare.routeLists().map(call => [call.path, call.authorization])).toEqual([
      [`/zones/${ZONE_ID}/workers/routes`, `Bearer ${MINTING_CREDENTIAL}`],
    ]);
    const flagged = await deployTokenEvents('unexpected_script');
    expect(flagged.map(event => event.data.attributes)).toEqual([
      {
        environment: 'development',
        provider: 'cloudflare',
        script: 'evil-worker',
        modifiedAt: expect.any(String),
        tokenIds: [token.tokenId],
        workloads: ['ci-deploy-bouncer'],
        runIds: ['9001'],
        intendedScripts: ['bouncer', 'bouncer-watch'],
        unexpectedInCheck: 1,
      },
    ]);
    // The window is checked: later alarms list nothing and write no second row.
    advanceClock(60 * 60_000);
    await alarmNow();
    expect(cloudflare.scriptLists()).toHaveLength(1);
    expect(await deployTokenEvents('unexpected_script')).toHaveLength(1);
  });

  it('checks no window still open, and writes a bounded number of rows per check', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = issued((await mint()).result);
    for (let index = 0; index < 25; index += 1) {
      cloudflare.scripts.push({ id: `stray-${index}`, modified_on: cloudflareIso(Date.now()) });
    }
    advanceClock(3 * 60_000);
    await alarmNow();
    expect(cloudflare.scriptLists()).toEqual([]);

    expect((await revoke(token.tokenId)).status).toBe(200);
    advanceClock(3 * 60_000);
    await alarmNow();
    const flagged = await deployTokenEvents('unexpected_script');
    expect(flagged).toHaveLength(DEPLOY_TOKEN_UNEXPECTED_SCRIPT_EVENTS_PER_CHECK);
    expect(flagged.every(event => event.data.attributes.unexpectedInCheck === 25)).toBe(true);
  });

  it('reports a change inside two windows once, at the check of the first window to close', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = issued((await mint()).result);
    const second = issued((await mint()).result);
    cloudflare.scripts.push({ id: 'evil-worker', modified_on: cloudflareIso(Date.now()) });
    expect((await revoke(first.tokenId)).status).toBe(200);
    advanceClock(3 * 60_000);
    await alarmNow();
    const flagged = await deployTokenEvents('unexpected_script');
    expect(flagged.map(event => [...(event.data.attributes.tokenIds as string[])].sort())).toEqual([
      [first.tokenId, second.tokenId].sort(),
    ]);

    expect((await revoke(second.tokenId)).status).toBe(200);
    advanceClock(3 * 60_000);
    await alarmNow();
    expect(cloudflare.scriptLists()).toHaveLength(2);
    expect(await deployTokenEvents('unexpected_script')).toHaveLength(1);
  });

  it('logs how many listed scripts it dropped for a missing name or time', async () => {
    const cloudflare = installFakes(github);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = issued((await mint()).result);
    expect((await revoke(token.tokenId)).status).toBe(200);
    cloudflare.scripts.push(
      { id: 'no-time' },
      { modified_on: cloudflareIso(Date.now()) },
      { id: 'bouncer', modified_on: cloudflareIso(Date.now()) }
    );
    advanceClock(3 * 60_000);
    await alarmNow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped'), { dropped: 2 });
  });

  it('audits a route that points at a script no token of its zone intended, against the previous list', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    cloudflare.routes.set(ZONE_ID, [
      { id: 'route-own', pattern: 'bouncer.example.invalid/*', script: 'bouncer' },
      { id: 'route-site', pattern: 'www.example.invalid/*', script: 'site-worker' },
      { id: 'route-off', pattern: 'off.example.invalid/*' },
    ]);
    const first = issued((await mint()).result);
    expect((await revoke(first.tokenId)).status).toBe(200);
    advanceClock(3 * 60_000);
    await alarmNow();
    // No earlier list of the zone: every route outside the intended scripts counts, once.
    expect(
      (await deployTokenEvents('unexpected_route')).map(event => event.data.attributes)
    ).toEqual([
      expect.objectContaining({
        routeId: 'route-site',
        script: 'site-worker',
        firstListOfZone: true,
        tokenIds: [first.tokenId],
      }),
    ]);

    // The next deploy repoints a route it does not own and adds one it intends.
    const second = issued((await mint()).result);
    cloudflare.routes.set(ZONE_ID, [
      { id: 'route-own', pattern: 'bouncer.example.invalid/*', script: 'evil-worker' },
      { id: 'route-site', pattern: 'www.example.invalid/*', script: 'site-worker' },
      { id: 'route-watch', pattern: 'watch.example.invalid/*', script: 'bouncer-watch' },
    ]);
    expect((await revoke(second.tokenId)).status).toBe(200);
    advanceClock(3 * 60_000);
    await alarmNow();
    const flagged = (await deployTokenEvents('unexpected_route')).map(
      event => event.data.attributes
    );
    expect(flagged).toHaveLength(2);
    expect(flagged[1]).toEqual({
      environment: 'development',
      provider: 'cloudflare',
      zone: ZONE_ID,
      routeId: 'route-own',
      pattern: 'bouncer.example.invalid/*',
      script: 'evil-worker',
      previousScript: 'bouncer',
      firstListOfZone: false,
      tokenIds: [second.tokenId],
      workloads: ['ci-deploy-bouncer'],
      runIds: ['9001'],
      intendedScripts: ['bouncer', 'bouncer-watch'],
      unexpectedInCheck: 1,
    });
  });

  it('writes a bounded number of route rows per check, and fails a check on a zone with too many routes', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const strays = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `stray-${index}`,
        pattern: `stray-${index}.example.invalid/*`,
        script: `stray-${index}`,
      }));
    cloudflare.routes.set(ZONE_ID, strays(25));
    const first = issued((await mint()).result);
    expect((await revoke(first.tokenId)).status).toBe(200);
    advanceClock(3 * 60_000);
    await alarmNow();
    const flagged = await deployTokenEvents('unexpected_route');
    expect(flagged).toHaveLength(DEPLOY_TOKEN_UNEXPECTED_ROUTE_EVENTS_PER_CHECK);
    expect(flagged.every(event => event.data.attributes.unexpectedInCheck === 25)).toBe(true);

    cloudflare.routes.set(ZONE_ID, strays(DEPLOY_TOKEN_ROUTES_PER_ZONE_MAX + 1));
    const second = issued((await mint()).result);
    expect((await revoke(second.tokenId)).status).toBe(200);
    advanceClock(3 * 60_000);
    await alarmNow();
    expect(await windowCheckOf(second.tokenId)).toEqual({
      window_check: null,
      window_check_attempts: 1,
    });
    expect(await deployTokenEvents('unexpected_route')).toHaveLength(
      DEPLOY_TOKEN_UNEXPECTED_ROUTE_EVENTS_PER_CHECK
    );
  });

  it('lists at most 8 zones per check and leaves the windows with further zones for the next alarm', async () => {
    const cloudflare = installFakes(github);
    const zoneIds = Array.from({ length: 9 }, (_, index) =>
      (index + 1).toString(16).padStart(32, '0')
    );
    const stub = getDeployTokenStub(env, config);
    const tokenIds: string[] = [];
    for (const zones of [zoneIds.slice(0, 4), zoneIds.slice(4, 8), zoneIds.slice(8)]) {
      const minted = await stub.mint({
        environment: 'development',
        caller: CALLER,
        grant: { ...bouncerGrant(), zones, maxActive: 3, maxPerHour: 12 },
        requestedAt: Date.now(),
      });
      if (minted.status !== 'minted') throw new Error(`expected a token, got ${minted.status}`);
      tokenIds.push(minted.tokenId);
    }
    for (const tokenId of tokenIds) {
      expect(await stub.revoke({ environment: 'development', caller: CALLER, tokenId })).toEqual({
        status: 'revoked',
      });
    }
    advanceClock(3 * 60_000);
    await alarmNow();
    expect(cloudflare.routeLists()).toHaveLength(DEPLOY_TOKEN_ROUTE_ZONES_PER_CHECK);
    expect(await windowCheckOf(tokenIds[2])).toEqual({
      window_check: null,
      window_check_attempts: 0,
    });
    await alarmNow();
    expect(cloudflare.routeLists()).toHaveLength(9);
    expect(cloudflare.scriptLists()).toHaveLength(2);
    expect(await windowCheckOf(tokenIds[2])).toMatchObject({ window_check: 'checked' });
  });

  it('tries a failed check again later, gives up after 3 failures with script_check_failed, and stops holding the row', async () => {
    const cloudflare = installFakes(github);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = issued((await mint()).result);
    expect((await revoke(token.tokenId)).status).toBe(200);
    cloudflare.setScriptsStatus(503);
    advanceClock(3 * 60_000);
    await alarmNow();
    expect(cloudflare.scriptLists()).toHaveLength(1);
    // Not again before its retry time.
    await alarmNow();
    expect(cloudflare.scriptLists()).toHaveLength(1);

    // A day later the row is past retention, but an owed check keeps it.
    advanceClock(DEPLOY_TOKEN_ROW_RETENTION_MS);
    await alarmNow();
    expect(cloudflare.scriptLists()).toHaveLength(2);
    expect(await windowCheckOf(token.tokenId)).toEqual({
      window_check: null,
      window_check_attempts: 2,
    });
    expect(await deployTokenEvents('script_check_failed')).toEqual([]);

    advanceClock(2 * DEPLOY_TOKEN_WINDOW_CHECK_RETRY_MS);
    await alarmNow();
    expect(cloudflare.scriptLists()).toHaveLength(3);
    const failed = await deployTokenEvents('script_check_failed');
    expect(failed.map(event => event.data.attributes)).toEqual([
      expect.objectContaining({
        workload: 'ci-deploy-bouncer',
        provider: 'cloudflare',
        permissionSet: 'bouncer-deploy',
        tokenId: token.tokenId,
        attempts: 3,
        reason: 'cloudflare script list failed with status 503',
        runId: '9001',
      }),
    ]);
    // Given up: the prune of that alarm removed the row, and no further list follows.
    expect(await windowCheckOf(token.tokenId)).toBeUndefined();
    advanceClock(4 * DEPLOY_TOKEN_WINDOW_CHECK_RETRY_MS);
    await alarmNow();
    expect(cloudflare.scriptLists()).toHaveLength(3);
  });
});

describe('returned grant check', () => {
  const grant = bouncerGrant();
  const sent = deployTokenPolicies(ACCOUNT_ID, grant);
  const returned = () =>
    sent.map(policy => ({
      effect: policy.effect,
      permissionGroups: policy.permission_groups.map(group => ({
        id: group.id,
        name: GROUP_NAMES[group.id],
      })),
      resources: { ...policy.resources },
    }));

  it('accepts exactly the grant sent, and refuses an unreadable list', () => {
    expect(returnedGrantProblem(returned(), sent, grant)).toBeNull();
    expect(returnedGrantProblem(null, sent, grant)).toMatch('unreadable');
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
    [
      // Development only, so the production rule cannot be the one that refuses it.
      'a non-production policy that accepts another ref, while the account is shared',
      {
        environments: ['development'],
        identity: base.identity.replace(
          'events: [push]',
          'events: [push]\n  refs: [refs/heads/main, refs/heads/feature-x]'
        ),
      },
      'staging and production share one Cloudflare account',
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

  it('refuses a group whose id is pinned as forbidden, whatever its name, and loads with an empty pin', () => {
    expect(() =>
      loadPolicies(
        { 'ci-deploy-x.yaml': policyFile() },
        { forbiddenPermissionGroupIds: [SCRIPTS_GROUP] }
      )
    ).toThrow('is a forbidden group');
    expect(() =>
      loadPolicies({ 'ci-deploy-x.yaml': policyFile() }, { forbiddenPermissionGroupIds: [] })
    ).not.toThrow();
    // Empty until setup step 3; every pinned value is a permission-group id.
    expect(CLOUDFLARE_FORBIDDEN_PERMISSION_GROUP_IDS.every(id => /^[0-9a-f]{32}$/.test(id))).toBe(
      true
    );
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
