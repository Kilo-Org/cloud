import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { modelsByProvider, organization_audit_logs, organizations } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { logAutoModelChangesForAllOrgs } from '@/lib/organizations/auto-model-change-log';
import { applySnapshotChangesAndAudit } from '@/lib/ai-gateway/providers/openrouter/sync-providers';
import type {
  NormalizedOpenRouterResponse,
  NormalizedProvider,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';

function buildSnapshot(
  providers: Array<{ slug: string; models: string[] }>
): NormalizedOpenRouterResponse {
  const mapped: NormalizedProvider[] = providers.map(({ slug, models }) => ({
    name: slug,
    displayName: slug,
    slug,
    dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
    models: models.map(modelSlug => ({
      slug: modelSlug,
      name: modelSlug,
      author: slug,
      description: '',
      context_length: 0,
      input_modalities: [],
      output_modalities: [],
      group: 'other',
      updated_at: '',
      endpoint: {
        provider_display_name: slug,
        is_free: false,
        pricing: { prompt: '0', completion: '0' },
      },
    })),
  }));

  return {
    providers: mapped,
    total_providers: mapped.length,
    total_models: mapped.reduce((sum, p) => sum + p.models.length, 0),
    generated_at: '2026-01-01T00:00:00Z',
  };
}

async function fetchAutoChangeLogs(organizationId: string) {
  return db
    .select()
    .from(organization_audit_logs)
    .where(
      and(
        eq(organization_audit_logs.organization_id, organizationId),
        eq(organization_audit_logs.action, 'organization.settings.auto_change')
      )
    );
}

async function clearSnapshots() {
  // eslint-disable-next-line drizzle/enforce-delete-with-where
  await db.delete(modelsByProvider);
}

describe('logAutoModelChangesForAllOrgs', () => {
  beforeEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_audit_logs);
    await clearSnapshots();
  });

  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_audit_logs);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
    await clearSnapshots();
  });

  test('writes null-actor audit log per enterprise org when new model becomes available', async () => {
    const owner = await insertTestUser();
    const enterpriseOrg = await createTestOrganization('Enterprise GLM Org', owner.id, 0, {
      provider_policy_mode: 'allow',
      provider_allow_list: ['z-ai'],
    });

    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    const newSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] }]);

    const result = await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    expect(result.orgCount).toBe(1);
    expect(result.logCount).toBe(1);

    const logs = await fetchAutoChangeLogs(enterpriseOrg.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('organization.settings.auto_change');
    expect(logs[0].actor_id).toBeNull();
    expect(logs[0].actor_email).toBeNull();
    expect(logs[0].actor_name).toBeNull();
    expect(logs[0].message).toBe('Added models from provider z-ai: z-ai/glm-5.1');
  });

  test('writes catalog-removal audit log when upstream catalog drops a previously-allowed model', async () => {
    const owner = await insertTestUser();
    const enterpriseOrg = await createTestOrganization('Enterprise Removal Org', owner.id, 0, {
      provider_policy_mode: 'allow',
      provider_allow_list: ['z-ai'],
    });

    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-4.0', 'z-ai/glm-5'] }]);
    const newSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);

    await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    const logs = await fetchAutoChangeLogs(enterpriseOrg.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('Removed models (no longer available): z-ai/glm-4.0');
  });

  test('writes allowed-provider-removal audit log when model still in catalog but only via non-allowed providers', async () => {
    const owner = await insertTestUser();
    const enterpriseOrg = await createTestOrganization('Openai-only Org', owner.id, 0, {
      provider_policy_mode: 'allow',
      provider_allow_list: ['openai'],
    });

    const oldSnapshot = buildSnapshot([
      { slug: 'openai', models: ['openai/gpt-4o'] },
      { slug: 'baidu', models: ['openai/gpt-4o'] },
    ]);
    const newSnapshot = buildSnapshot([
      { slug: 'openai', models: [] },
      { slug: 'baidu', models: ['openai/gpt-4o'] },
    ]);

    await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    const logs = await fetchAutoChangeLogs(enterpriseOrg.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe(
      'Removed models (no longer offered by any allowed provider): openai/gpt-4o'
    );
  });

  test('does not write any audit log for teams-plan orgs', async () => {
    const owner = await insertTestUser();
    const teamsOrg = await createTestOrganization(
      'Teams Org',
      owner.id,
      0,
      undefined,
      true /* requireSeats → plan 'teams' */
    );

    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    const newSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] }]);

    const result = await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    expect(result.orgCount).toBe(0);

    const logs = await fetchAutoChangeLogs(teamsOrg.id);
    expect(logs).toHaveLength(0);
  });

  test('skips enterprise orgs whose effective availability did not change', async () => {
    const owner = await insertTestUser();
    const restrictedOrg = await createTestOrganization('Restricted to openai only', owner.id, 0, {
      provider_policy_mode: 'allow',
      provider_allow_list: ['openai'],
    });

    const oldSnapshot = buildSnapshot([
      { slug: 'openai', models: ['openai/gpt-4o'] },
      { slug: 'z-ai', models: ['z-ai/glm-5'] },
    ]);
    const newSnapshot = buildSnapshot([
      { slug: 'openai', models: ['openai/gpt-4o'] },
      { slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] },
    ]);

    await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    const logs = await fetchAutoChangeLogs(restrictedOrg.id);
    expect(logs).toHaveLength(0);
  });

  test('skips writing logs when snapshot has no diff', async () => {
    const owner = await insertTestUser();
    const enterpriseOrg = await createTestOrganization('No diff Org', owner.id, 0, {
      provider_policy_mode: 'allow',
      provider_allow_list: ['z-ai'],
    });

    const snapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    const result = await logAutoModelChangesForAllOrgs(snapshot, snapshot);

    expect(result.logCount).toBe(0);
    const logs = await fetchAutoChangeLogs(enterpriseOrg.id);
    expect(logs).toHaveLength(0);
  });

  test('skips writing logs on first run (no previous snapshot)', async () => {
    const owner = await insertTestUser();
    const enterpriseOrg = await createTestOrganization('First run Org', owner.id, 0, {
      provider_policy_mode: 'allow',
      provider_allow_list: ['z-ai'],
    });

    const snapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] }]);
    const result = await logAutoModelChangesForAllOrgs(null, snapshot);

    expect(result.logCount).toBe(0);
    const logs = await fetchAutoChangeLogs(enterpriseOrg.id);
    expect(logs).toHaveLength(0);
  });

  test('aggregates multiple changes into a single audit log entry per org', async () => {
    const owner = await insertTestUser();
    const enterpriseOrg = await createTestOrganization('Multi-change Org', owner.id, 0, {
      provider_policy_mode: 'allow',
      provider_allow_list: ['anthropic', 'z-ai'],
    });

    const oldSnapshot = buildSnapshot([
      { slug: 'anthropic', models: ['anthropic/claude-4.5'] },
      { slug: 'z-ai', models: ['z-ai/glm-4.0', 'z-ai/glm-5'] },
    ]);
    const newSnapshot = buildSnapshot([
      { slug: 'anthropic', models: ['anthropic/claude-4.5', 'anthropic/claude-4.6'] },
      { slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] },
    ]);

    await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    const logs = await fetchAutoChangeLogs(enterpriseOrg.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe(
      'Added models from provider anthropic: anthropic/claude-4.6; Added models from provider z-ai: z-ai/glm-5.1; Removed models (no longer available): z-ai/glm-4.0'
    );
  });
});

describe('applySnapshotChangesAndAudit (wiring)', () => {
  beforeEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_audit_logs);
    await clearSnapshots();
  });

  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_audit_logs);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
    await clearSnapshots();
  });

  test('reads the stored previous snapshot, writes the new one, and emits audit logs based on the diff', async () => {
    const owner = await insertTestUser();
    const enterpriseOrg = await createTestOrganization('Wiring Org', owner.id, 0, {
      provider_policy_mode: 'allow',
      provider_allow_list: ['z-ai'],
    });

    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    await db.insert(modelsByProvider).values({
      data: oldSnapshot,
      openrouter: {},
      vercel: {},
    });

    const newSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] }]);
    const result = await applySnapshotChangesAndAudit({
      providers: newSnapshot,
      openrouter_data: {},
      vercel_data: {},
    });

    expect(result.previousSnapshot?.providers[0].models.map(m => m.slug)).toEqual(['z-ai/glm-5']);
    expect(result.data.providers[0].models.map(m => m.slug)).toEqual([
      'z-ai/glm-5',
      'z-ai/glm-5.1',
    ]);

    const remainingRows = await db.select().from(modelsByProvider);
    expect(remainingRows).toHaveLength(1);
    expect(remainingRows[0].id).toBe(result.id);

    const logs = await fetchAutoChangeLogs(enterpriseOrg.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('Added models from provider z-ai: z-ai/glm-5.1');
  });

  test('no previous snapshot row → previousSnapshot null → no audit logs emitted', async () => {
    const owner = await insertTestUser();
    const enterpriseOrg = await createTestOrganization('First-run Wiring Org', owner.id, 0, {
      provider_policy_mode: 'allow',
      provider_allow_list: ['z-ai'],
    });

    const newSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] }]);
    const result = await applySnapshotChangesAndAudit({
      providers: newSnapshot,
      openrouter_data: {},
      vercel_data: {},
    });

    expect(result.previousSnapshot).toBeNull();

    const logs = await fetchAutoChangeLogs(enterpriseOrg.id);
    expect(logs).toHaveLength(0);
  });

  test('advisory lock serializes concurrent calls: second call sees first call’s commit as its previousSnapshot', async () => {
    const owner = await insertTestUser();
    const enterpriseOrg = await createTestOrganization('Concurrent Wiring Org', owner.id, 0, {
      provider_policy_mode: 'allow',
      provider_allow_list: ['z-ai'],
    });

    const initialSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    await db.insert(modelsByProvider).values({
      data: initialSnapshot,
      openrouter: {},
      vercel: {},
    });

    const nextSnapshotA = buildSnapshot([
      { slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1-a'] },
    ]);
    const nextSnapshotB = buildSnapshot([
      { slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1-a', 'z-ai/glm-5.1-b'] },
    ]);

    const [resultA, resultB] = await Promise.all([
      applySnapshotChangesAndAudit({
        providers: nextSnapshotA,
        openrouter_data: {},
        vercel_data: {},
      }),
      applySnapshotChangesAndAudit({
        providers: nextSnapshotB,
        openrouter_data: {},
        vercel_data: {},
      }),
    ]);

    const sortedById = [resultA, resultB].sort((a, b) => a.id - b.id);
    const [firstResult, secondResult] = sortedById;

    const firstPreviousModelIds =
      firstResult.previousSnapshot?.providers[0].models.map(m => m.slug) ?? [];
    const secondPreviousModelIds =
      secondResult.previousSnapshot?.providers[0].models.map(m => m.slug) ?? [];

    expect(firstPreviousModelIds).toEqual(['z-ai/glm-5']);
    expect(secondPreviousModelIds.length).toBeGreaterThan(firstPreviousModelIds.length);
    expect(secondPreviousModelIds).toContain(
      firstResult.data.providers[0].models[firstResult.data.providers[0].models.length - 1].slug
    );

    const logs = await fetchAutoChangeLogs(enterpriseOrg.id);
    expect(logs).toHaveLength(2);
    const messages = logs.map(log => log.message).sort();
    expect(messages).not.toEqual([messages[0], messages[0]]);
  });
});
