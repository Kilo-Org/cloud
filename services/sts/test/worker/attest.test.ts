import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import {
  GithubRunAttestationResultSchema,
  type GithubRunAttestationResult,
} from '@kilocode/sts-contracts';
import type { JWTPayload } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDenialBuffers } from '../../src/audit/denials';
import { SecretsBroker } from '../../src/broker';
import { getDenialStub } from '../../src/dos/stubs';
import { handleRequest } from '../../src/http';
import { loadPolicies } from '../../src/policy/load';
import type { MintAuthority } from '../../src/tokens/mint';
import { resetDenialObject } from './reset';
import { createProvider, providerFetch, signToken, type TestProvider } from './support';
import { config, env } from './test-env';

const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const PROXY_AUDIENCE = 'https://migration-proxy.sts-test.invalid';
const DEPLOY_WORKFLOW = 'acme/repo/.github/workflows/deploy.yml@refs/heads/main';
const OTHER_WORKFLOW = 'acme/repo/.github/workflows/other.yml@refs/heads/main';
const STAGING_WORKFLOW = 'acme/repo/.github/workflows/staging.yml@refs/heads/main';
const SHA = '0123456789abcdef0123456789abcdef01234567';

const githubPolicy = (workload: string, fields: string) => `
workload: ${workload}
identity:
  kind: github-oidc
  repository: acme/repo
  repositoryId: '123'
  repositoryOwnerId: '456'
  refs: [refs/heads/main]
${fields}`;

const authority: MintAuthority = {
  scopes: {},
  policies: loadPolicies({
    'ci-db-migrate.yaml': githubPolicy(
      'ci-db-migrate',
      `  environment: production
  jobWorkflowRefs: [${DEPLOY_WORKFLOW}]
  events: [workflow_run, schedule, workflow_dispatch]
environments: [development]
secrets: []
dynamic:
  - grant: migration-run
`
    ),
    'ci-other.yaml': githubPolicy(
      'ci-other',
      `  environment: production
  jobWorkflowRefs: [${OTHER_WORKFLOW}]
  events: [workflow_dispatch]
environments: [development]
secrets: []
`
    ),
    'ci-staging-migrate.yaml': githubPolicy(
      'ci-staging-migrate',
      `  environment: staging
  jobWorkflowRefs: [${STAGING_WORKFLOW}]
  events: [workflow_dispatch]
environments: [staging]
secrets: []
dynamic:
  - grant: migration-run
`
    ),
  }),
};

class TestBroker extends SecretsBroker {
  static override readonly mintAuthority = authority;
}

let pending: Promise<unknown>[] = [];
let github: TestProvider;

const waitUntil = (promise: Promise<unknown>) => {
  pending.push(promise);
};

function broker(caller: string): TestBroker {
  const ctx = { props: { caller }, waitUntil, passThroughOnException: () => undefined };
  return new TestBroker(ctx as unknown as ExecutionContext, env);
}

const jobClaims = {
  sub: 'repo:acme@456/repo@123:environment:production',
  repository: 'acme/repo',
  repository_id: '123',
  repository_owner_id: '456',
  environment: 'production',
  ref: 'refs/heads/main',
  sha: SHA,
  event_name: 'workflow_run',
  job_workflow_ref: DEPLOY_WORKFLOW,
  run_id: '777',
  run_attempt: '2',
};

async function proxyToken(
  claims: JWTPayload = {},
  options: Parameters<typeof signToken>[2] = {}
): Promise<string> {
  return await signToken(
    github,
    { ...jobClaims, ...claims },
    { audience: PROXY_AUDIENCE, ...options }
  );
}

async function attest(
  token: string,
  caller = 'migration-proxy'
): Promise<GithubRunAttestationResult> {
  return GithubRunAttestationResultSchema.parse(await broker(caller).attestGithubRun({ token }));
}

type Event = { type: string; data: { actor: { id: string }; attributes: Record<string, unknown> } };

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

beforeAll(async () => {
  github = await createProvider(GITHUB_ISSUER, config.issuer);
});

beforeEach(async () => {
  pending = [];
  clearDenialBuffers();
  await resetDenialObject(getDenialStub(env, config));
  vi.stubGlobal('fetch', providerFetch([github]).fetch);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('attestGithubRun', () => {
  it('attests a matching job token with the proxy audience and writes no row', async () => {
    const result = await attest(await proxyToken());
    expect(result).toEqual({
      status: 'ok',
      workload: 'ci-db-migrate',
      github: {
        repositoryId: '123',
        repositoryOwnerId: '456',
        environment: 'production',
        ref: 'refs/heads/main',
        sha: SHA,
        eventName: 'workflow_run',
        jobWorkflowRef: DEPLOY_WORKFLOW,
        runId: '777',
        runAttempt: '2',
      },
      expiresAt: expect.any(String),
    });
    expect(await flushedDenials()).toEqual([]);
  });

  it('accepts every listed event of the trigger-only policy', async () => {
    for (const event of ['schedule', 'workflow_dispatch']) {
      expect(await attest(await proxyToken({ event_name: event }))).toMatchObject({
        status: 'ok',
        github: { eventName: event },
      });
    }
  });

  it('refuses a token with the STS issuer audience', async () => {
    const token = await signToken(github, jobClaims);
    expect(await attest(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });

  it('refuses every props caller but the migration proxy, and audits it', async () => {
    expect(await attest(await proxyToken(), 'web')).toEqual({
      status: 'denied',
      reason: 'caller_not_allowed',
    });
    const [event] = await flushedDenials();
    expect(event.type).toBe('ai.kilo.sts.migration_attest.denied');
    expect(event.data.actor.id).toBe('web');
    expect(event.data.attributes).toMatchObject({
      channel: 'migration-attest',
      reason: 'caller_not_allowed',
    });
  });

  it('refuses a branch ref', async () => {
    const token = await proxyToken({
      ref: 'refs/heads/feature',
      job_workflow_ref: 'acme/repo/.github/workflows/deploy.yml@refs/heads/feature',
    });
    expect(await attest(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });

  it('refuses a workflow no policy names', async () => {
    const token = await proxyToken({
      job_workflow_ref: 'acme/repo/.github/workflows/unknown.yml@refs/heads/main',
    });
    expect(await attest(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });

  it('refuses the wrong GitHub environment and a policy of another STS environment', async () => {
    expect(
      await attest(
        await proxyToken({
          environment: 'staging',
          sub: 'repo:acme@456/repo@123:environment:staging',
        })
      )
    ).toEqual({ status: 'denied', reason: 'identity_rejected' });
    expect(
      await attest(
        await proxyToken({
          environment: 'staging',
          sub: 'repo:acme@456/repo@123:environment:staging',
          event_name: 'workflow_dispatch',
          job_workflow_ref: STAGING_WORKFLOW,
        })
      )
    ).toEqual({ status: 'denied', reason: 'environment_mismatch' });
  });

  it('refuses a policy without the migration-run grant, and audits it', async () => {
    const token = await proxyToken({
      event_name: 'workflow_dispatch',
      job_workflow_ref: OTHER_WORKFLOW,
    });
    expect(await attest(token)).toEqual({ status: 'denied', reason: 'grant_not_allowed' });
    const event = (await flushedDenials()).find(
      denial => denial.data.attributes.reason === 'grant_not_allowed'
    );
    expect(event?.data.actor.id).toBe('ci-other');
  });

  it('refuses an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await proxyToken({}, { issuedAt: now - 3600, expiresAt: now - 600 });
    expect(await attest(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });

  it('refuses a token without a sha claim', async () => {
    const { sha: _sha, ...withoutSha } = jobClaims;
    const token = await signToken(github, withoutSha, { audience: PROXY_AUDIENCE });
    expect(await attest(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });

  it('refuses a malformed request', async () => {
    expect(await broker('migration-proxy').attestGithubRun({ token: 'x'.repeat(8193) })).toEqual({
      status: 'denied',
      reason: 'identity_rejected',
    });
  });
});

describe('the migration proxy audience on other routes', () => {
  async function bundle(token: string): Promise<Response> {
    return await handleRequest(
      new Request(`${config.issuer}/v1/bundle`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
      { waitUntil, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext,
      authority
    );
  }

  it('/v1/bundle refuses a token with the proxy audience', async () => {
    const response = await bundle(
      await proxyToken({ event_name: 'workflow_dispatch', job_workflow_ref: OTHER_WORKFLOW })
    );
    expect(response.status).toBe(401);
  });

  it('/v1/bundle refuses a trigger-only job token even with the STS audience', async () => {
    const response = await bundle(await signToken(github, jobClaims));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });
});
