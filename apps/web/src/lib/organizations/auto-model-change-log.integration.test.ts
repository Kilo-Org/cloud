import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { and, eq } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  modelsByProvider,
  organization_audit_logs,
  organization_group_policy_settings,
  organizations,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import { logAutoModelChangesForAllOrgs } from '@/lib/organizations/auto-model-change-log';
import { applySnapshotChangesAndAudit } from '@/lib/providers/openrouter/sync-providers';
import type {
  NormalizedOpenRouterResponse,
  NormalizedProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';

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

  test('does not write audit logs for enterprise orgs without model restrictions', async () => {
    const owner = await insertTestUser();
    const enterpriseOrg = await createTestOrganization('Unrestricted Enterprise Org', owner.id, 0);

    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    const newSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] }]);

    const result = await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    expect(result.orgCount).toBe(0);

    const logs = await fetchAutoChangeLogs(enterpriseOrg.id);
    expect(logs).toHaveLength(0);
  });

  test('does not write audit logs for soft-deleted enterprise orgs', async () => {
    const owner = await insertTestUser();
    const enterpriseOrg = await createTestOrganization('Deleted Enterprise Org', owner.id, 0, {
      provider_allow_list: ['z-ai'],
    });
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, enterpriseOrg.id));

    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    const newSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] }]);

    const result = await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    expect(result.orgCount).toBe(0);

    const logs = await fetchAutoChangeLogs(enterpriseOrg.id);
    expect(logs).toHaveLength(0);
  });

  test('does not write audit logs for hard-expired enterprise orgs without entitlement', async () => {
    const owner = await insertTestUser();
    const enterpriseOrg = await createTestOrganization('Expired Enterprise Org', owner.id, 0, {
      provider_allow_list: ['z-ai'],
    });
    await db
      .update(organizations)
      .set({
        free_trial_end_at: '2020-01-01T00:00:00.000Z',
        require_seats: true,
      })
      .where(eq(organizations.id, enterpriseOrg.id));

    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    const newSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] }]);

    const result = await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    expect(result.orgCount).toBe(0);

    const logs = await fetchAutoChangeLogs(enterpriseOrg.id);
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

describe('logAutoModelChangesForAllOrgs with disable_new_models', () => {
  const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
  const newSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] }]);

  async function policyRevision(organizationId: string) {
    const [row] = await db
      .select({ revision: organization_group_policy_settings.policy_revision })
      .from(organization_group_policy_settings)
      .where(eq(organization_group_policy_settings.organization_id, organizationId));
    return row?.revision ?? null;
  }

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

  test('adds new models to the deny list of an unrestricted org and logs them as disabled', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Disable New Models Org', owner.id, 0, {
      disable_new_models: true,
    });

    const result = await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    expect(result.orgCount).toBe(1);
    expect(result.logCount).toBe(1);

    const updated = await getOrganizationById(org.id);
    expect(updated?.settings.model_deny_list).toEqual(['z-ai/glm-5.1']);
    expect(updated?.settings.disable_new_models).toBe(true);

    const logs = await fetchAutoChangeLogs(org.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].actor_id).toBeNull();
    expect(logs[0].actor_email).toBeNull();
    expect(logs[0].actor_name).toBeNull();
    expect(logs[0].message).toBe('Disabled new models from provider z-ai: z-ai/glm-5.1');
    expect(logs[0].details).toEqual({ id: 'autoRouting.models', added: [], removed: [] });
    expect(await policyRevision(org.id)).toBe(1);
  });

  test('disables new models from every provider and bumps the policy revision each sync', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Multi Provider Org', owner.id, 0, {
      disable_new_models: true,
    });

    const before = buildSnapshot([
      { slug: 'anthropic', models: ['anthropic/claude-4.5'] },
      { slug: 'z-ai', models: ['z-ai/glm-5'] },
    ]);
    const mid = buildSnapshot([
      { slug: 'anthropic', models: ['anthropic/claude-4.5', 'anthropic/claude-4.6'] },
      { slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] },
    ]);
    const after = buildSnapshot([
      { slug: 'anthropic', models: ['anthropic/claude-4.5', 'anthropic/claude-4.6'] },
      { slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1', 'z-ai/glm-5.2'] },
    ]);

    await logAutoModelChangesForAllOrgs(before, mid);
    await logAutoModelChangesForAllOrgs(mid, after);

    const updated = await getOrganizationById(org.id);
    expect([...(updated?.settings.model_deny_list ?? [])].sort()).toEqual([
      'anthropic/claude-4.6',
      'z-ai/glm-5.1',
      'z-ai/glm-5.2',
    ]);
    expect(await policyRevision(org.id)).toBe(2);

    const logs = await fetchAutoChangeLogs(org.id);
    expect(logs.map(log => log.message).sort()).toEqual([
      'Disabled new models from provider anthropic: anthropic/claude-4.6; Disabled new models from provider z-ai: z-ai/glm-5.1',
      'Disabled new models from provider z-ai: z-ai/glm-5.2',
    ]);
  });

  test('keeps existing deny list entries and only adds models that are not denied yet', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Existing Deny List Org', owner.id, 0, {
      disable_new_models: true,
      model_deny_list: ['openai/gpt-4o', 'z-ai/glm-5.1'],
    });

    const after = buildSnapshot([
      { slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1', 'z-ai/glm-5.2'] },
    ]);
    await logAutoModelChangesForAllOrgs(oldSnapshot, after);

    const updated = await getOrganizationById(org.id);
    expect(updated?.settings.model_deny_list).toEqual([
      'openai/gpt-4o',
      'z-ai/glm-5.1',
      'z-ai/glm-5.2',
    ]);

    const logs = await fetchAutoChangeLogs(org.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('Disabled new models from provider z-ai: z-ai/glm-5.2');
  });

  test('leaves the deny list alone when the new model is already denied', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Already Denied Org', owner.id, 0, {
      disable_new_models: true,
      model_deny_list: ['z-ai/glm-5.1'],
    });

    const result = await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    expect(result.logCount).toBe(0);
    const updated = await getOrganizationById(org.id);
    expect(updated?.settings.model_deny_list).toEqual(['z-ai/glm-5.1']);
    expect(await fetchAutoChangeLogs(org.id)).toHaveLength(0);
  });

  test('preserves other settings', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Other Settings Org', owner.id, 0, {
      disable_new_models: true,
      disable_openrouter: true,
      provider_allow_list: ['z-ai'],
    });

    await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    const updated = await getOrganizationById(org.id);
    expect(updated?.settings).toMatchObject({
      disable_new_models: true,
      disable_openrouter: true,
      provider_allow_list: ['z-ai'],
      model_deny_list: ['z-ai/glm-5.1'],
    });
  });

  test('clears the default model when it becomes disabled', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Default Model Org', owner.id, 0, {
      disable_new_models: true,
      default_model: 'z-ai/glm-5.1',
    });

    await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    const updated = await getOrganizationById(org.id);
    expect(updated?.settings.model_deny_list).toEqual(['z-ai/glm-5.1']);
    expect(updated?.settings.default_model).toBeUndefined();
  });

  test('clears a default model written with a variant suffix when its base model is disabled', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Default Variant Org', owner.id, 0, {
      disable_new_models: true,
      default_model: 'z-ai/glm-5.1:free',
    });

    await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    const updated = await getOrganizationById(org.id);
    expect(updated?.settings.default_model).toBeUndefined();
  });

  test('keeps the default model when it is not one of the disabled models', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Other Default Model Org', owner.id, 0, {
      disable_new_models: true,
      default_model: 'z-ai/glm-5',
    });

    await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    const updated = await getOrganizationById(org.id);
    expect(updated?.settings.model_deny_list).toEqual(['z-ai/glm-5.1']);
    expect(updated?.settings.default_model).toBe('z-ai/glm-5');
  });

  test('includes an org with the policy even when its entitlement has expired', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Expired Policy Org', owner.id, 0, {
      disable_new_models: true,
    });
    await db
      .update(organizations)
      .set({ free_trial_end_at: '2020-01-01T00:00:00.000Z', require_seats: true })
      .where(eq(organizations.id, org.id));

    const result = await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    expect(result.orgCount).toBe(1);
    const updated = await getOrganizationById(org.id);
    expect(updated?.settings.model_deny_list).toEqual(['z-ai/glm-5.1']);
    expect(await fetchAutoChangeLogs(org.id)).toHaveLength(1);
  });

  test('does not touch soft-deleted orgs with the policy', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Deleted Policy Org', owner.id, 0, {
      disable_new_models: true,
    });
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, org.id));

    const result = await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    expect(result.orgCount).toBe(0);
    expect(await fetchAutoChangeLogs(org.id)).toHaveLength(0);
    const [row] = await db.select().from(organizations).where(eq(organizations.id, org.id));
    expect(row.settings.model_deny_list).toBeUndefined();
  });

  test('logs removals normally and leaves the deny list unchanged when nothing was added', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Removal Only Policy Org', owner.id, 0, {
      disable_new_models: true,
      model_deny_list: ['openai/gpt-4o'],
    });

    const before = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-4.0', 'z-ai/glm-5'] }]);
    const after = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    await logAutoModelChangesForAllOrgs(before, after);

    const updated = await getOrganizationById(org.id);
    expect(updated?.settings.model_deny_list).toEqual(['openai/gpt-4o']);
    expect(await policyRevision(org.id)).toBeNull();

    const logs = await fetchAutoChangeLogs(org.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('Removed models (no longer available): z-ai/glm-4.0');
    expect(logs[0].details).toEqual({
      id: 'autoRouting.models',
      added: [],
      removed: ['z-ai/glm-4.0'],
    });
  });

  test('disables additions while still logging removals in the same audit row', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Mixed Policy Org', owner.id, 0, {
      disable_new_models: true,
    });

    const before = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-4.0', 'z-ai/glm-5'] }]);
    const after = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] }]);
    await logAutoModelChangesForAllOrgs(before, after);

    const updated = await getOrganizationById(org.id);
    expect(updated?.settings.model_deny_list).toEqual(['z-ai/glm-5.1']);

    const logs = await fetchAutoChangeLogs(org.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe(
      'Disabled new models from provider z-ai: z-ai/glm-5.1; Removed models (no longer available): z-ai/glm-4.0'
    );
    expect(logs[0].details).toEqual({
      id: 'autoRouting.models',
      added: [],
      removed: ['z-ai/glm-4.0'],
    });
  });

  test('ignores the flag on non-enterprise orgs', async () => {
    const owner = await insertTestUser();
    const teamsOrg = await createTestOrganization(
      'Teams Policy Org',
      owner.id,
      0,
      { disable_new_models: true },
      true
    );

    const result = await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    expect(result.orgCount).toBe(0);
    expect(await fetchAutoChangeLogs(teamsOrg.id)).toHaveLength(0);
    const updated = await getOrganizationById(teamsOrg.id);
    expect(updated?.settings.model_deny_list).toBeUndefined();
  });

  test('keeps the existing behaviour when the flag is false', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Flag Off Org', owner.id, 0, {
      disable_new_models: false,
      provider_policy_mode: 'allow',
      provider_allow_list: ['z-ai'],
      model_deny_list: ['openai/gpt-4o'],
    });

    await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    const updated = await getOrganizationById(org.id);
    expect(updated?.settings.model_deny_list).toEqual(['openai/gpt-4o']);
    expect(await policyRevision(org.id)).toBeNull();

    const logs = await fetchAutoChangeLogs(org.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('Added models from provider z-ai: z-ai/glm-5.1');
    expect(logs[0].details).toEqual({
      id: 'autoRouting.models',
      added: [{ provider: 'z-ai', models: ['z-ai/glm-5.1'] }],
      removed: [],
    });
  });

  test('does not include unrestricted orgs when the flag is false', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Flag Off Unrestricted Org', owner.id, 0, {
      disable_new_models: false,
    });

    const result = await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    expect(result.orgCount).toBe(0);
    expect(await fetchAutoChangeLogs(org.id)).toHaveLength(0);
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

  test('reads the stored previous snapshot, replaces it with the new one, and emits audit logs based on the diff', async () => {
    const owner = await insertTestUser();
    const enterpriseOrg = await createTestOrganization('Wiring Org', owner.id, 0, {
      provider_policy_mode: 'allow',
      provider_allow_list: ['z-ai'],
    });

    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    await db.insert(modelsByProvider).values({ data: oldSnapshot });

    const newSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] }]);
    const result = await applySnapshotChangesAndAudit({ providers: newSnapshot });

    expect(result.previousSnapshot?.providers[0].models.map(m => m.slug)).toEqual(['z-ai/glm-5']);
    expect(result.data.providers[0].models.map(m => m.slug)).toEqual([
      'z-ai/glm-5',
      'z-ai/glm-5.1',
    ]);

    const remainingRows = await db
      .select({ id: modelsByProvider.id, data: modelsByProvider.data })
      .from(modelsByProvider);
    expect(remainingRows).toEqual([{ id: result.id, data: newSnapshot }]);

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
    const result = await applySnapshotChangesAndAudit({ providers: newSnapshot });

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
    await db.insert(modelsByProvider).values({ data: initialSnapshot });

    const nextSnapshotA = buildSnapshot([
      { slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1-a'] },
    ]);
    const nextSnapshotB = buildSnapshot([
      { slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1-a', 'z-ai/glm-5.1-b'] },
    ]);

    const [resultA, resultB] = await Promise.all([
      applySnapshotChangesAndAudit({ providers: nextSnapshotA }),
      applySnapshotChangesAndAudit({ providers: nextSnapshotB }),
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
