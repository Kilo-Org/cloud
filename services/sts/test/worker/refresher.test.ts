import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelayMs } from '../../src/dos/RefresherDO';
import { getBundleStub, getRefresherStub, getSignerStub } from '../../src/dos/stubs';
import { installManager, secret, stubOfflineNetwork, type MockSecret } from './manager';
import { resetBundleObject, resetRefresherObject } from './reset';
import { config, env } from './test-env';

beforeEach(async () => {
  stubOfflineNetwork();
  await resetRefresherObject(getRefresherStub(env, config));
  for (const workload of ['o11y', 'audit-relay']) {
    await resetBundleObject(getBundleStub(env, config, workload));
  }
});

afterEach(() => {
  stubOfflineNetwork();
  vi.restoreAllMocks();
});

const MANAGER: MockSecret[] = [
  secret('/workloads/o11y', 'O11Y_CF_AE_API_TOKEN', 'ae-token'),
  secret('/workloads/o11y', 'O11Y_KILO_GATEWAY_CLIENT_SECRET', 'gateway-secret'),
  secret('/workloads/o11y', 'O11Y_SLACK_WEBHOOK_PAGE', 'https://hooks.example/o11y-page'),
  secret('/shared', 'O11Y_SLACK_WEBHOOK_PAGE', 'https://hooks.example/shared-page'),
  secret('/shared', 'O11Y_SLACK_WEBHOOK_TICKET', 'https://hooks.example/ticket'),
  secret('/workloads/o11y/nested', 'O11Y_CF_CONTAINERS_API_TOKEN', 'nested-token'),
  secret('/workloads/audit-relay', 'AUDIT_RELAY_AXIOM_TOKEN', 'axiom-token'),
  secret('/workloads/audit-relay', 'O11Y_CF_AE_API_TOKEN', 'another-workloads-value'),
  secret('/shared', 'AUDIT_RELAY_SLACK_WEBHOOK_PAGE', 'https://hooks.example/audit'),
  secret('/shared', 'UNRELATED_SECRET', 'must-never-ship'),
];

type StateRow = {
  next_refresh_at: number;
  failures: number;
  webhook_refresh_at: number | null;
  last_refresh_at: number | null;
};

function refresherState(): Promise<StateRow> {
  return runInDurableObject(getRefresherStub(env, config), (_instance, state) =>
    state.storage.sql.exec<StateRow>('SELECT * FROM refresher_state').one()
  );
}

function refresherEvents(): Promise<string[]> {
  return runInDurableObject(getRefresherStub(env, config), (_instance, state) =>
    state.storage.sql
      .exec<{ event: string }>('SELECT event FROM audit_event ORDER BY seq')
      .toArray()
      .map(row => row.event)
  );
}

async function o11yBundle() {
  const result = await getBundleStub(env, config, 'o11y').getBundle('o11y', 'development', {});
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
  return result;
}

describe('manager login', () => {
  it('logs in through JWT Auth with an ES256 JWT carrying the exact issuer, audience and subject', async () => {
    const manager = installManager({ secrets: MANAGER });
    await getRefresherStub(env, config).refreshAll();

    expect(manager.loginBodies).toHaveLength(1);
    const login = manager.loginBodies[0];
    expect(login).toMatchObject({ identityId: 'test-identity-id' });
    if (typeof login !== 'object' || login === null || !('jwt' in login)) {
      throw new Error('login body did not carry a JWT');
    }
    const jwks = await getSignerStub(env, config).getJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(jwks.keys[0]).not.toHaveProperty('d');
    const { payload, protectedHeader } = await jwtVerify(
      String(login.jwt),
      createLocalJWKSet({ keys: jwks.keys }),
      {
        issuer: `${config.issuer}/manager-auth`,
        audience: 'https://manager.sts-test.invalid/identities/test-identity-id',
        subject: 'sts:development:refresher',
        algorithms: ['ES256'],
      }
    );
    expect(protectedHeader.kid).toBe(jwks.keys[0].kid);
    if (payload.exp === undefined || payload.iat === undefined) {
      throw new Error('login JWT has no issued-at or expiry');
    }
    expect(payload.exp - payload.iat).toBe(120);
    expect(payload.jti).toBeTypeOf('string');
  });

  it('reuses the access token until a minute before it expires', async () => {
    const manager = installManager({ secrets: MANAGER, expiresIn: 600 });
    const refresher = getRefresherStub(env, config);
    await refresher.refreshAll();
    await refresher.refreshAll();
    expect(manager.loginBodies).toHaveLength(1);
    expect(manager.reads).toHaveLength(4);
  });

  it('logs in again when the token has less than a minute left', async () => {
    const manager = installManager({ secrets: MANAGER, expiresIn: 59 });
    const refresher = getRefresherStub(env, config);
    await refresher.refreshAll();
    await refresher.refreshAll();
    expect(manager.loginBodies).toHaveLength(2);
  });
});

describe('manager reads', () => {
  it('reads /workloads and /shared recursively with references and imports off', async () => {
    const manager = installManager({ secrets: MANAGER });
    await getRefresherStub(env, config).refreshAll();

    expect(manager.reads.map(read => read.folder).sort()).toEqual(['/shared', '/workloads']);
    for (const read of manager.reads) {
      expect(read.url.searchParams.get('projectId')).toBe('test-project-id');
      expect(read.url.searchParams.get('environment')).toBe('development');
      expect(read.url.searchParams.get('recursive')).toBe('true');
      expect(read.url.searchParams.get('expandSecretReferences')).toBe('false');
      expect(read.url.searchParams.get('includeImports')).toBe('false');
      expect(read.authorization).toBe(['Bearer', 'manager-access-token'].join(' '));
      expect(read.ifNoneMatch).toBeNull();
    }
  });

  it('resolves each grant from the workload folder first, then /shared, never deeper', async () => {
    installManager({ secrets: MANAGER });
    await getRefresherStub(env, config).refreshAll();

    const o11y = await o11yBundle();
    expect(o11y.stale).toBe(false);
    expect(o11y.secrets).toEqual({
      O11Y_CF_AE_API_TOKEN: { value: 'ae-token', version: 1 },
      O11Y_KILO_GATEWAY_CLIENT_SECRET: { value: 'gateway-secret', version: 1 },
      O11Y_SLACK_WEBHOOK_PAGE: { value: 'https://hooks.example/o11y-page', version: 1 },
      O11Y_SLACK_WEBHOOK_TICKET: { value: 'https://hooks.example/ticket', version: 1 },
    });
    expect(o11y.missing).toEqual(['O11Y_CF_CONTAINERS_API_TOKEN']);

    const auditRelay = await getBundleStub(env, config, 'audit-relay').getBundle(
      'audit-relay',
      'development',
      {}
    );
    if (auditRelay.status !== 'ok') throw new Error('expected ok');
    expect(auditRelay.secrets).toEqual({
      AUDIT_RELAY_AXIOM_TOKEN: { value: 'axiom-token', version: 1 },
      AUDIT_RELAY_SLACK_WEBHOOK_PAGE: { value: 'https://hooks.example/audit', version: 1 },
    });
  });

  it('revalidates each folder with its ETag and builds from the stored copy on 304', async () => {
    const manager = installManager({ secrets: MANAGER });
    const refresher = getRefresherStub(env, config);
    await refresher.refreshAll();
    await refresher.refreshAll();

    const revalidations = manager.reads.slice(2);
    expect(revalidations.map(read => read.ifNoneMatch).sort()).toEqual([
      '"shared-1"',
      '"workloads-1"',
    ]);
    const built = await refresher.buildBundle('o11y');
    if (built.status !== 'built') throw new Error('expected a built bundle');
    expect(built.bundle.secrets.O11Y_CF_AE_API_TOKEN?.value).toBe('ae-token');
    expect(built.bundle.stale).toBe(false);
  });

  it('treats a folder the manager does not have as empty, not unreachable', async () => {
    const manager = installManager({ secrets: MANAGER });
    manager.removeFolder('/shared');
    await getRefresherStub(env, config).refreshAll();

    const o11y = await o11yBundle();
    expect(o11y.stale).toBe(false);
    expect(o11y.secrets.O11Y_SLACK_WEBHOOK_PAGE?.value).toBe('https://hooks.example/o11y-page');
    expect(o11y.missing).toEqual(['O11Y_SLACK_WEBHOOK_TICKET', 'O11Y_CF_CONTAINERS_API_TOKEN']);
    expect((await refresherState()).failures).toBe(0);
  });

  it('treats any other 404 as unreachable and keeps the last copy', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = installManager({ secrets: MANAGER });
    const refresher = getRefresherStub(env, config);
    await refresher.refreshAll();
    manager.setReadStatus(404);
    await refresher.refreshAll();

    expect((await refresherState()).failures).toBe(1);
    const o11y = await o11yBundle();
    expect(o11y.stale).toBe(true);
    expect(o11y.secrets.O11Y_CF_AE_API_TOKEN?.value).toBe('ae-token');
  });

  it('refuses a value in reference syntax, keeps its last good copy, and alerts once', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const manager = installManager({ secrets: MANAGER });
    const refresher = getRefresherStub(env, config);
    await refresher.refreshAll();

    const changed = MANAGER.map(entry => {
      if (entry.name === 'O11Y_CF_AE_API_TOKEN' && entry.path === '/workloads/o11y') {
        return { ...entry, value: '${shared.OTHER_TOKEN}', version: 2 };
      }
      if (entry.name === 'O11Y_KILO_GATEWAY_CLIENT_SECRET') {
        return { ...entry, value: 'gateway-secret-2', version: 2 };
      }
      return entry;
    });
    manager.setSecrets(changed);
    await refresher.refreshAll();
    manager.setSecrets([...changed]);
    await refresher.refreshAll();

    const o11y = await o11yBundle();
    expect(o11y.secrets.O11Y_CF_AE_API_TOKEN).toEqual({ value: 'ae-token', version: 1 });
    expect(o11y.secrets.O11Y_KILO_GATEWAY_CLIENT_SECRET).toEqual({
      value: 'gateway-secret-2',
      version: 2,
    });

    const refusals = (await refresherEvents()).filter(event =>
      event.includes('ai.kilo.sts.manager.reference_refused')
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('O11Y_CF_AE_API_TOKEN');
    expect(refusals[0]).not.toContain('OTHER_TOKEN');
    const logged = errors.mock.calls.filter(call =>
      String(call[0]).includes('secret reference syntax')
    );
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain('OTHER_TOKEN');
  });
});

describe('manager failures', () => {
  it('backs off after a 429, honours Retry-After, and marks every bundle stale', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = installManager({ secrets: MANAGER });
    const refresher = getRefresherStub(env, config);
    await refresher.refreshAll();

    manager.setReadStatus(429, { 'retry-after': '90' });
    await refresher.refreshAll();
    const state = await refresherState();
    expect(state.failures).toBe(1);
    if (state.last_refresh_at === null) throw new Error('expected a refresh time');
    const delay = state.next_refresh_at - state.last_refresh_at;
    expect(delay).toBeGreaterThanOrEqual(90_000);
    expect(delay).toBeLessThanOrEqual(240_000);

    const o11y = await o11yBundle();
    expect(o11y.stale).toBe(true);
    expect(o11y.secrets.O11Y_CF_AE_API_TOKEN?.value).toBe('ae-token');

    manager.setReadStatus(503);
    await refresher.refreshAll();
    expect((await refresherState()).failures).toBe(2);

    manager.setReadStatus(200);
    await refresher.refreshAll();
    expect((await refresherState()).failures).toBe(0);
    expect((await o11yBundle()).stale).toBe(false);
  });

  it('grows the backoff exponentially with jitter up to four minutes', () => {
    for (let run = 0; run < 50; run += 1) {
      const first = backoffDelayMs(1, null);
      expect(first).toBeGreaterThanOrEqual(7_500);
      expect(first).toBeLessThanOrEqual(15_000);
      const fourth = backoffDelayMs(4, null);
      expect(fourth).toBeGreaterThanOrEqual(60_000);
      expect(fourth).toBeLessThanOrEqual(120_000);
      expect(backoffDelayMs(12, null)).toBeLessThanOrEqual(240_000);
      expect(backoffDelayMs(12, null)).toBeGreaterThanOrEqual(120_000);
    }
    expect(backoffDelayMs(1, 100_000)).toBe(100_000);
    expect(backoffDelayMs(1, 3_600_000)).toBe(240_000);
  });
});

describe('manager webhooks', () => {
  it('merges verified webhook refresh requests into one refresh 30 seconds after the first', async () => {
    installManager({ secrets: MANAGER });
    const refresher = getRefresherStub(env, config);
    await refresher.refreshAll();

    await refresher.requestWebhookRefresh();
    const opened = await refresherState();
    if (opened.webhook_refresh_at === null || opened.last_refresh_at === null) {
      throw new Error('expected an open merge window');
    }
    expect(opened.webhook_refresh_at).toBeGreaterThanOrEqual(opened.last_refresh_at + 30_000);
    expect(opened.webhook_refresh_at).toBeLessThan(opened.next_refresh_at);

    await refresher.requestWebhookRefresh();
    expect((await refresherState()).webhook_refresh_at).toBe(opened.webhook_refresh_at);

    const alarm = await runInDurableObject(refresher, (_instance, state) =>
      state.storage.getAlarm()
    );
    expect(alarm).not.toBeNull();
    expect(alarm).toBeLessThanOrEqual(opened.webhook_refresh_at);
  });

  it('does not shorten a running backoff', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = installManager({ secrets: MANAGER });
    const refresher = getRefresherStub(env, config);
    manager.setReadStatus(500);
    await refresher.refreshAll();

    await refresher.requestWebhookRefresh();
    expect((await refresherState()).webhook_refresh_at).toBeNull();
  });

  it('hands out one stable webhook secret', async () => {
    const refresher = getRefresherStub(env, config);
    const first = await refresher.webhookSecret();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await refresher.webhookSecret()).toBe(first);
  });
});

describe('policy audit stream', () => {
  it('writes one policy-change event naming the workloads, and none when nothing changed', async () => {
    const refresher = getRefresherStub(env, config);
    await refresher.ensureStarted();
    await refresher.ensureStarted();

    const rows = await refresherEvents();
    expect(rows).toHaveLength(1);
    const event = JSON.parse(rows[0]);
    expect(event.type).toBe('ai.kilo.sts.policy.changed');
    expect([...event.data.attributes.addedWorkloads].sort()).toEqual([
      'audit-relay',
      'o11y',
      'usage-ingest',
      'web',
    ]);
    expect(event.data.attributes.removedWorkloads).toEqual([]);
  });

  it('relays the refresher stream and advances its own watermark', async () => {
    const manager = installManager({ secrets: MANAGER });
    manager.setLoginStatus(500);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refresher = getRefresherStub(env, config);
    await refresher.ensureStarted();
    await runInDurableObject(refresher, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(refresher)).toBe(true);

    await runInDurableObject(refresher, (_instance, state) => {
      const watermark = state.storage.sql
        .exec<{ relayed_seq: number }>('SELECT relayed_seq FROM audit_watermark')
        .one().relayed_seq;
      expect(watermark).toBe(1);
    });
  });
});
