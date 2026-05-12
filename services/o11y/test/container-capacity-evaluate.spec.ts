import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateContainerCapacity } from '../src/alerting/container-capacity-evaluate';
import type { ContainerApplication } from '../src/alerting/container-capacity';
import type { AlertPayload } from '../src/alerting/notify';

// ── KV mock ──────────────────────────────────────────────────────────────────

function makeKv() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null, cacheStatus: null })),
    store,
  } as unknown as KVNamespace & { store: Map<string, string> };
}

// ── Env builder ───────────────────────────────────────────────────────────────

function makeSecret(value: string): SecretsStoreSecret {
  return { get: async () => value } as unknown as SecretsStoreSecret;
}

function makeEnv(kv: KVNamespace) {
  return {
    O11Y_ALERT_STATE: kv,
    O11Y_CF_ACCOUNT_ID: 'test-account',
    O11Y_CF_CONTAINERS_API_TOKEN: makeSecret('test-token'),
    O11Y_SLACK_WEBHOOK_PAGE: makeSecret('https://hooks.slack.com/page'),
    O11Y_SLACK_WEBHOOK_TICKET: makeSecret('https://hooks.slack.com/ticket'),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('evaluateContainerCapacity', () => {
  let kv: ReturnType<typeof makeKv>;
  let sentAlerts: AlertPayload[];
  let notifyFn: (alert: AlertPayload, env: unknown) => Promise<void>;

  beforeEach(() => {
    kv = makeKv();
    sentAlerts = [];
    notifyFn = vi.fn(async (alert: AlertPayload) => {
      sentAlerts.push(alert);
    });
  });

  it('fires no alert when capacity is below all thresholds', async () => {
    const queryFn = vi.fn(
      async (): Promise<ContainerApplication[]> => [
        { id: 'id1', name: 'cloud-agent-next-sandbox', instances: 50, maxInstances: 100 },
      ]
    );
    await evaluateContainerCapacity(makeEnv(kv), queryFn, notifyFn);
    expect(sentAlerts).toHaveLength(0);
    expect(kv.store.size).toBe(0);
  });

  it('fires a ticket alert at 81% utilization and records dedup marker', async () => {
    const queryFn = vi.fn(
      async (): Promise<ContainerApplication[]> => [
        { id: 'id1', name: 'cloud-agent-next-sandbox', instances: 81, maxInstances: 100 },
      ]
    );
    await evaluateContainerCapacity(makeEnv(kv), queryFn, notifyFn);
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0].severity).toBe('ticket');
    const [key] = [...kv.store.keys()];
    expect(key).toContain('ticket');
    expect(key).toContain('container_capacity');
    expect(key).toContain('cloud-agent-next-sandbox');
  });

  it('fires a page alert at 96% utilization', async () => {
    const queryFn = vi.fn(
      async (): Promise<ContainerApplication[]> => [
        { id: 'id1', name: 'cloud-agent-next-sandbox', instances: 96, maxInstances: 100 },
      ]
    );
    await evaluateContainerCapacity(makeEnv(kv), queryFn, notifyFn);
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0].severity).toBe('page');
    const [key] = [...kv.store.keys()];
    expect(key).toContain('page');
  });

  it('suppresses ticket alert when page marker exists for the same dimension', async () => {
    kv.store.set(
      'o11y:alert:page:container_capacity:cloudflare:cloud-agent-next-sandbox:containers',
      new Date().toISOString()
    );
    const queryFn = vi.fn(
      async (): Promise<ContainerApplication[]> => [
        { id: 'id1', name: 'cloud-agent-next-sandbox', instances: 81, maxInstances: 100 },
      ]
    );
    await evaluateContainerCapacity(makeEnv(kv), queryFn, notifyFn);
    expect(sentAlerts).toHaveLength(0);
  });

  it('suppresses page alert when page cooldown marker already exists', async () => {
    kv.store.set(
      'o11y:alert:page:container_capacity:cloudflare:cloud-agent-next-sandbox:containers',
      new Date().toISOString()
    );
    const queryFn = vi.fn(
      async (): Promise<ContainerApplication[]> => [
        { id: 'id1', name: 'cloud-agent-next-sandbox', instances: 96, maxInstances: 100 },
      ]
    );
    await evaluateContainerCapacity(makeEnv(kv), queryFn, notifyFn);
    expect(sentAlerts).toHaveLength(0);
  });

  it('records page dedup marker in KV when page alert fires', async () => {
    const queryFn = vi.fn(
      async (): Promise<ContainerApplication[]> => [
        { id: 'id1', name: 'cloud-agent-next-sandbox', instances: 96, maxInstances: 100 },
      ]
    );
    await evaluateContainerCapacity(makeEnv(kv), queryFn, notifyFn);
    const pageKey =
      'o11y:alert:page:container_capacity:cloudflare:cloud-agent-next-sandbox:containers';
    expect(kv.store.has(pageKey)).toBe(true);
  });

  it('propagates API query failure as thrown error', async () => {
    const failingQuery = vi.fn(async (): Promise<ContainerApplication[]> => {
      throw new Error('API unreachable');
    });
    await expect(evaluateContainerCapacity(makeEnv(kv), failingQuery, notifyFn)).rejects.toThrow(
      'API unreachable'
    );
  });
});
