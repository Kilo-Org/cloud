import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// Mock the db module so the helpers run for real but the underlying
// queries don't need a Postgres connection. Pattern matches the existing
// kiloclaw-instance.test.ts setup (`vi.mock('../db', ...)`).
vi.mock('../../db', () => ({
  getWorkerDb: vi.fn(() => ({})),
  getInstanceBySandboxId: vi.fn(),
  getMorningBriefingConfig: vi.fn(),
  upsertMorningBriefingConfig: vi.fn(),
}));

import { fallbackAppNameForRestore } from './postgres';
import {
  readMorningBriefingConfigFromPostgresHelper,
  syncMorningBriefingConfigToPostgresHelper,
} from './postgres';
import { sandboxIdFromUserId } from '../../auth/sandbox-id';
import { appNameFromUserId, appNameFromInstanceId } from '../../fly/apps';
import { createMutableState } from './state';
import type { KiloClawEnv } from '../../types';

describe('fallbackAppNameForRestore', () => {
  it('keeps migrated legacy sandboxes on the acct-* naming path', async () => {
    const legacyUserId = 'oauth/google:117453785559478190551';
    const migratedUserId = '199e2b19-aa40-488d-9442-9a18a620ba68';

    await expect(
      fallbackAppNameForRestore(migratedUserId, sandboxIdFromUserId(legacyUserId))
    ).resolves.toBe(await appNameFromUserId(legacyUserId));
  });

  it('keeps ki_ sandboxes on the inst-* naming path', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';

    await expect(
      fallbackAppNameForRestore(
        '199e2b19-aa40-488d-9442-9a18a620ba68',
        'ki_11111111111141118111111111111111'
      )
    ).resolves.toBe(await appNameFromInstanceId(instanceId));
  });
});

describe('syncMorningBriefingConfigToPostgresHelper', () => {
  const envWithHyperdrive = {
    HYPERDRIVE: { connectionString: 'postgres://test' },
  } as unknown as KiloClawEnv;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('upserts the row using the resolved instance id', async () => {
    const db = await import('../../db');
    (db.getInstanceBySandboxId as Mock).mockResolvedValue({
      id: 'instance-uuid-1',
      sandboxId: 'sandbox-1',
      userId: 'user-1',
      orgId: null,
      provider: 'fly',
      instanceType: null,
    });

    const state = createMutableState();
    state.userId = 'user-1';
    state.sandboxId = 'sandbox-1';

    await syncMorningBriefingConfigToPostgresHelper(envWithHyperdrive, state, {
      enabled: true,
      cron: '0 7 * * *',
      timezone: 'America/Los_Angeles',
    });

    expect(db.upsertMorningBriefingConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        instanceId: 'instance-uuid-1',
        enabled: true,
        cron: '0 7 * * *',
        timezone: 'America/Los_Angeles',
      })
    );
    // interestTopics not provided → preserved on update
    const call = (db.upsertMorningBriefingConfig as Mock).mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(call.interestTopics).toBeUndefined();
    // Owner/org are NOT forwarded — the table doesn't store them.
    expect(call.userId).toBeUndefined();
    expect(call.orgId).toBeUndefined();
  });

  it('skips getInstanceBySandboxId when a resolvedInstanceId is provided (backfill path)', async () => {
    const db = await import('../../db');
    const state = createMutableState();
    state.userId = 'user-7';
    state.sandboxId = 'sandbox-7';

    await syncMorningBriefingConfigToPostgresHelper(
      envWithHyperdrive,
      state,
      {
        enabled: true,
        cron: '0 7 * * *',
        timezone: 'UTC',
      },
      'pre-resolved-instance-uuid'
    );

    expect(db.getInstanceBySandboxId).not.toHaveBeenCalled();
    expect(db.upsertMorningBriefingConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        instanceId: 'pre-resolved-instance-uuid',
        enabled: true,
        cron: '0 7 * * *',
        timezone: 'UTC',
      })
    );
  });

  it('forwards only the enable flag when cron/timezone are omitted (disable path)', async () => {
    const db = await import('../../db');
    (db.getInstanceBySandboxId as Mock).mockResolvedValue({
      id: 'instance-uuid-2',
      sandboxId: 'sandbox-2',
      userId: 'user-2',
      orgId: 'org-uuid-2',
      provider: 'fly',
      instanceType: null,
    });

    const state = createMutableState();
    state.userId = 'user-2';
    state.sandboxId = 'sandbox-2';

    await syncMorningBriefingConfigToPostgresHelper(envWithHyperdrive, state, {
      enabled: false,
    });

    const call = (db.upsertMorningBriefingConfig as Mock).mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(call.instanceId).toBe('instance-uuid-2');
    expect(call.enabled).toBe(false);
    expect(call.cron).toBeUndefined();
    expect(call.timezone).toBeUndefined();
    expect(call.interestTopics).toBeUndefined();
  });

  it('no-ops when HYPERDRIVE is not configured', async () => {
    const db = await import('../../db');
    const state = createMutableState();
    state.userId = 'user-1';
    state.sandboxId = 'sandbox-1';

    await syncMorningBriefingConfigToPostgresHelper({} as KiloClawEnv, state, {
      enabled: true,
      cron: '0 7 * * *',
    });

    expect(db.getInstanceBySandboxId).not.toHaveBeenCalled();
    expect(db.upsertMorningBriefingConfig).not.toHaveBeenCalled();
  });

  it('no-ops when DO state has no sandboxId yet', async () => {
    const db = await import('../../db');
    const state = createMutableState();
    state.userId = 'user-1';
    state.sandboxId = null;

    await syncMorningBriefingConfigToPostgresHelper(envWithHyperdrive, state, {
      enabled: true,
      cron: '0 7 * * *',
    });

    expect(db.getInstanceBySandboxId).not.toHaveBeenCalled();
    expect(db.upsertMorningBriefingConfig).not.toHaveBeenCalled();
  });

  it('does not throw when the instance row is missing (warn + swallow)', async () => {
    const db = await import('../../db');
    (db.getInstanceBySandboxId as Mock).mockResolvedValue(null);

    const state = createMutableState();
    state.userId = 'user-x';
    state.sandboxId = 'sandbox-x';

    await expect(
      syncMorningBriefingConfigToPostgresHelper(envWithHyperdrive, state, {
        enabled: true,
        cron: '0 7 * * *',
      })
    ).resolves.toBeUndefined();
    expect(db.upsertMorningBriefingConfig).not.toHaveBeenCalled();
  });

  it('swallows db errors so the caller is not gated on Postgres availability', async () => {
    const db = await import('../../db');
    (db.getInstanceBySandboxId as Mock).mockRejectedValue(new Error('postgres down'));

    const state = createMutableState();
    state.userId = 'user-1';
    state.sandboxId = 'sandbox-1';

    await expect(
      syncMorningBriefingConfigToPostgresHelper(envWithHyperdrive, state, {
        enabled: true,
        cron: '0 7 * * *',
      })
    ).resolves.toBeUndefined();
    expect(db.upsertMorningBriefingConfig).not.toHaveBeenCalled();
  });
});

describe('readMorningBriefingConfigFromPostgresHelper', () => {
  const envWithHyperdrive = {
    HYPERDRIVE: { connectionString: 'postgres://test' },
  } as unknown as KiloClawEnv;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the merged instanceId + config row when present', async () => {
    const db = await import('../../db');
    (db.getInstanceBySandboxId as Mock).mockResolvedValue({
      id: 'instance-uuid-1',
      sandboxId: 'sandbox-1',
      userId: 'user-1',
      orgId: null,
      provider: 'fly',
      instanceType: null,
    });
    (db.getMorningBriefingConfig as Mock).mockResolvedValue({
      instance_id: 'instance-uuid-1',
      enabled: true,
      cron: '0 7 * * *',
      timezone: 'America/Los_Angeles',
      interest_topics: ['Tech', 'AI'],
    });

    const state = createMutableState();
    state.userId = 'user-1';
    state.sandboxId = 'sandbox-1';

    const result = await readMorningBriefingConfigFromPostgresHelper(envWithHyperdrive, state);
    expect(result).toEqual({
      instanceId: 'instance-uuid-1',
      row: {
        instance_id: 'instance-uuid-1',
        enabled: true,
        cron: '0 7 * * *',
        timezone: 'America/Los_Angeles',
        interest_topics: ['Tech', 'AI'],
      },
    });
  });

  it('returns the row with column-default cron/timezone for a freshly inserted row', async () => {
    const db = await import('../../db');
    (db.getInstanceBySandboxId as Mock).mockResolvedValue({
      id: 'instance-uuid-3',
      sandboxId: 'sandbox-3',
      userId: 'user-3',
      orgId: null,
      provider: 'fly',
      instanceType: null,
    });
    (db.getMorningBriefingConfig as Mock).mockResolvedValue({
      instance_id: 'instance-uuid-3',
      enabled: false,
      cron: '0 7 * * *', // column default
      timezone: 'UTC', // column default
      interest_topics: [], // column default
    });

    const state = createMutableState();
    state.userId = 'user-3';
    state.sandboxId = 'sandbox-3';

    const result = await readMorningBriefingConfigFromPostgresHelper(envWithHyperdrive, state);
    expect(result?.row).toEqual({
      instance_id: 'instance-uuid-3',
      enabled: false,
      cron: '0 7 * * *',
      timezone: 'UTC',
      interest_topics: [],
    });
  });

  it('returns instanceId with row=null when the instance exists but has no config row yet', async () => {
    const db = await import('../../db');
    (db.getInstanceBySandboxId as Mock).mockResolvedValue({
      id: 'instance-uuid-1',
      sandboxId: 'sandbox-1',
      userId: 'user-1',
      orgId: null,
      provider: 'fly',
      instanceType: null,
    });
    (db.getMorningBriefingConfig as Mock).mockResolvedValue(null);

    const state = createMutableState();
    state.userId = 'user-1';
    state.sandboxId = 'sandbox-1';

    const result = await readMorningBriefingConfigFromPostgresHelper(envWithHyperdrive, state);
    expect(result).toEqual({ instanceId: 'instance-uuid-1', row: null });
  });

  it('returns null when no instance row exists', async () => {
    const db = await import('../../db');
    (db.getInstanceBySandboxId as Mock).mockResolvedValue(null);

    const state = createMutableState();
    state.userId = 'user-x';
    state.sandboxId = 'sandbox-x';

    const result = await readMorningBriefingConfigFromPostgresHelper(envWithHyperdrive, state);
    expect(result).toBeNull();
    expect(db.getMorningBriefingConfig).not.toHaveBeenCalled();
  });

  it('returns null when HYPERDRIVE is not configured', async () => {
    const db = await import('../../db');
    const state = createMutableState();
    state.userId = 'user-1';
    state.sandboxId = 'sandbox-1';

    const result = await readMorningBriefingConfigFromPostgresHelper({} as KiloClawEnv, state);
    expect(result).toBeNull();
    expect(db.getInstanceBySandboxId).not.toHaveBeenCalled();
  });

  it('returns null and does not throw on db errors', async () => {
    const db = await import('../../db');
    (db.getInstanceBySandboxId as Mock).mockRejectedValue(new Error('postgres down'));

    const state = createMutableState();
    state.userId = 'user-1';
    state.sandboxId = 'sandbox-1';

    const result = await readMorningBriefingConfigFromPostgresHelper(envWithHyperdrive, state);
    expect(result).toBeNull();
  });
});
