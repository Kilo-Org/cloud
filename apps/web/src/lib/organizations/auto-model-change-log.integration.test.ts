import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  modelsByProvider,
  organization_audit_logs,
  organization_group_policy_settings,
  organization_new_models_baselines,
  organizations,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  getOrganizationById,
  mutateOrganizationSettings,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { getOrganizationGroupPolicyContext } from '@kilocode/web-shared/lib/organizations/organization-group-policy-context.server';
import {
  evaluateEffectiveModelAccessPolicy,
  getEffectiveModelDecision,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import { validateOrganizationAutoTarget } from '@kilocode/web-shared/lib/organizations/organization-auto-model';
import { createModelsByProviderIndexLoader } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import { logAutoModelChangesForAllOrgs } from '@/lib/organizations/auto-model-change-log';
import { applySnapshotChangesAndAudit } from '@/lib/providers/openrouter/sync-providers';
import type { OrganizationSettings } from '@kilocode/db/schema-types';
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

  test('does not select an unrestricted org just because it has the policy', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Policy Only Org', owner.id, 0, {
      disable_new_models: true,
    });

    const result = await logAutoModelChangesForAllOrgs(oldSnapshot, newSnapshot);

    expect(result.orgCount).toBe(0);
    expect(await fetchAutoChangeLogs(org.id)).toHaveLength(0);
    const updated = await getOrganizationById(org.id);
    expect(updated?.settings.model_deny_list).toBeUndefined();
  });

  test('skips the organizations that were already handled at publication', async () => {
    const owner = await insertTestUser();
    const handledOrg = await createTestOrganization('Handled Org', owner.id, 0, {
      provider_policy_mode: 'allow',
      provider_allow_list: ['z-ai'],
    });
    const otherOrg = await createTestOrganization('Other Org', owner.id, 0, {
      provider_policy_mode: 'allow',
      provider_allow_list: ['z-ai'],
    });

    const result = await logAutoModelChangesForAllOrgs(
      oldSnapshot,
      newSnapshot,
      new Set([handledOrg.id])
    );

    expect(result.orgCount).toBe(1);
    expect(result.logCount).toBe(1);
    expect(await fetchAutoChangeLogs(handledOrg.id)).toHaveLength(0);
    expect(await fetchAutoChangeLogs(otherOrg.id)).toHaveLength(1);
  });
});

describe('applySnapshotChangesAndAudit with disable_new_models', () => {
  const glm5 = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
  const glm51 = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] }]);
  const glm52 = buildSnapshot([
    { slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1', 'z-ai/glm-5.2'] },
  ]);

  async function seedSnapshot(snapshot: NormalizedOpenRouterResponse) {
    const [row] = await db
      .insert(modelsByProvider)
      .values({ data: snapshot })
      .returning({ id: modelsByProvider.id });
    return row.id;
  }

  async function seedBaseline(organizationId: string, snapshotId: number) {
    await db
      .insert(organization_new_models_baselines)
      .values({ organization_id: organizationId, snapshot_id: snapshotId });
  }

  async function baselineOf(organizationId: string) {
    const [row] = await db
      .select({ snapshotId: organization_new_models_baselines.snapshot_id })
      .from(organization_new_models_baselines)
      .where(eq(organization_new_models_baselines.organization_id, organizationId));
    return row?.snapshotId ?? null;
  }

  async function snapshotIds() {
    const rows = await db.select({ id: modelsByProvider.id }).from(modelsByProvider);
    return rows.map(row => row.id).sort((a, b) => a - b);
  }

  async function policyRevision(organizationId: string) {
    const [row] = await db
      .select({ revision: organization_group_policy_settings.policy_revision })
      .from(organization_group_policy_settings)
      .where(eq(organization_group_policy_settings.organization_id, organizationId));
    return row?.revision ?? null;
  }

  async function denyList(organizationId: string) {
    return (await getOrganizationById(organizationId))?.settings.model_deny_list;
  }

  async function createPolicyOrg(name: string, settings: object = {}) {
    const owner = await insertTestUser();
    return createTestOrganization(name, owner.id, 0, { disable_new_models: true, ...settings });
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

  test('commits the deny list, the audit row and the baseline with the snapshot', async () => {
    const org = await createPolicyOrg('Disable New Models Org');
    const previousId = await seedSnapshot(glm5);
    await seedBaseline(org.id, previousId);

    const result = await applySnapshotChangesAndAudit({ providers: glm51 });

    expect(await denyList(org.id)).toEqual(['z-ai/glm-5.1']);
    expect((await getOrganizationById(org.id))?.settings.disable_new_models).toBe(true);
    expect(await policyRevision(org.id)).toBe(1);
    expect(await baselineOf(org.id)).toBe(result.id);

    const logs = await fetchAutoChangeLogs(org.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].actor_id).toBeNull();
    expect(logs[0].actor_email).toBeNull();
    expect(logs[0].actor_name).toBeNull();
    expect(logs[0].message).toBe('Disabled new models from provider z-ai: z-ai/glm-5.1');
    expect(logs[0].details).toEqual({
      id: 'autoRouting.models',
      added: [],
      removed: [],
      disabled: [{ provider: 'z-ai', models: ['z-ai/glm-5.1'] }],
    });
  });

  test('reconciles an org without a baseline from the snapshot being replaced', async () => {
    const org = await createPolicyOrg('No Baseline Org');
    await seedSnapshot(glm5);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const result = await applySnapshotChangesAndAudit({ providers: glm51 });

      expect(await denyList(org.id)).toEqual(['z-ai/glm-5.1']);
      expect(await baselineOf(org.id)).toBe(result.id);
      expect(await fetchAutoChangeLogs(org.id)).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`org ${org.id} has no usable baseline`)
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('falls back to the replaced snapshot when the baseline snapshot no longer exists', async () => {
    const org = await createPolicyOrg('Dangling Baseline Org');
    const missingId = (await seedSnapshot(glm5)) + 1000;
    await seedBaseline(org.id, missingId);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const result = await applySnapshotChangesAndAudit({ providers: glm51 });

      expect(await denyList(org.id)).toEqual(['z-ai/glm-5.1']);
      expect(await baselineOf(org.id)).toBe(result.id);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('disables new models from every provider in one audit row', async () => {
    const org = await createPolicyOrg('Multi Provider Org');
    const before = buildSnapshot([
      { slug: 'anthropic', models: ['anthropic/claude-4.5'] },
      { slug: 'z-ai', models: ['z-ai/glm-5'] },
    ]);
    await seedBaseline(org.id, await seedSnapshot(before));

    await applySnapshotChangesAndAudit({
      providers: buildSnapshot([
        { slug: 'anthropic', models: ['anthropic/claude-4.5', 'anthropic/claude-4.6'] },
        { slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] },
      ]),
    });

    expect([...((await denyList(org.id)) ?? [])].sort()).toEqual([
      'anthropic/claude-4.6',
      'z-ai/glm-5.1',
    ]);
    const logs = await fetchAutoChangeLogs(org.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe(
      'Disabled new models from provider anthropic: anthropic/claude-4.6; Disabled new models from provider z-ai: z-ai/glm-5.1'
    );
  });

  test('keeps existing deny list entries and the other settings', async () => {
    const org = await createPolicyOrg('Existing Deny List Org', {
      model_deny_list: ['openai/gpt-4o', 'z-ai/glm-5.1'],
      disable_openrouter: true,
      provider_allow_list: ['z-ai'],
    });
    await seedBaseline(org.id, await seedSnapshot(glm51));

    await applySnapshotChangesAndAudit({ providers: glm52 });

    const updated = await getOrganizationById(org.id);
    expect(updated?.settings).toMatchObject({
      disable_new_models: true,
      disable_openrouter: true,
      provider_allow_list: ['z-ai'],
      model_deny_list: ['openai/gpt-4o', 'z-ai/glm-5.1', 'z-ai/glm-5.2'],
    });
    const logs = await fetchAutoChangeLogs(org.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('Disabled new models from provider z-ai: z-ai/glm-5.2');
  });

  test('writes nothing for a model that is already denied, but still advances the baseline', async () => {
    const org = await createPolicyOrg('Already Denied Org', { model_deny_list: ['z-ai/glm-5.1'] });
    await seedBaseline(org.id, await seedSnapshot(glm5));

    const result = await applySnapshotChangesAndAudit({ providers: glm51 });

    expect(await denyList(org.id)).toEqual(['z-ai/glm-5.1']);
    expect(await policyRevision(org.id)).toBeNull();
    expect(await fetchAutoChangeLogs(org.id)).toHaveLength(0);
    expect(await baselineOf(org.id)).toBe(result.id);
  });

  test('bumps the group policy revision only when the deny list changed', async () => {
    const org = await createPolicyOrg('Revision Org');
    await seedBaseline(org.id, await seedSnapshot(glm5));

    await applySnapshotChangesAndAudit({ providers: glm51 });
    expect(await policyRevision(org.id)).toBe(1);

    await applySnapshotChangesAndAudit({ providers: glm51 });
    expect(await policyRevision(org.id)).toBe(1);

    await applySnapshotChangesAndAudit({ providers: glm5 });
    expect(await policyRevision(org.id)).toBe(1);

    await applySnapshotChangesAndAudit({ providers: glm52 });
    expect(await policyRevision(org.id)).toBe(2);
    expect([...((await denyList(org.id)) ?? [])].sort()).toEqual(['z-ai/glm-5.1', 'z-ai/glm-5.2']);
  });

  test('publishing an unchanged snapshot writes nothing', async () => {
    const org = await createPolicyOrg('Unchanged Org');
    await seedBaseline(org.id, await seedSnapshot(glm5));
    await applySnapshotChangesAndAudit({ providers: glm51 });

    const second = await applySnapshotChangesAndAudit({ providers: glm51 });

    expect(await denyList(org.id)).toEqual(['z-ai/glm-5.1']);
    expect(await fetchAutoChangeLogs(org.id)).toHaveLength(1);
    expect(await baselineOf(org.id)).toBe(second.id);
  });

  test('does nothing for an org whose baseline already is the published snapshot', async () => {
    const owner = await insertTestUser();
    // Restricted, so the post-commit logger would write an "Added models" row if it did not skip the org.
    const org = await createTestOrganization('Current Baseline Org', owner.id, 0, {
      disable_new_models: true,
      provider_policy_mode: 'allow',
      provider_allow_list: ['z-ai'],
    });
    const previousId = await seedSnapshot(glm5);
    await seedBaseline(org.id, previousId + 1);

    const result = await applySnapshotChangesAndAudit({ providers: glm51 });

    expect(result.id).toBe(previousId + 1);
    expect(await denyList(org.id)).toBeUndefined();
    expect(await policyRevision(org.id)).toBeNull();
    expect(await fetchAutoChangeLogs(org.id)).toHaveLength(0);
    expect(await baselineOf(org.id)).toBe(result.id);
  });

  test('catches up from an older retained baseline', async () => {
    const org = await createPolicyOrg('Catch Up Org');
    const baselineId = await seedSnapshot(glm5);
    const previousId = await seedSnapshot(glm51);
    await seedBaseline(org.id, baselineId);
    expect(await snapshotIds()).toEqual([baselineId, previousId]);

    const result = await applySnapshotChangesAndAudit({ providers: glm52 });

    expect([...((await denyList(org.id)) ?? [])].sort()).toEqual(['z-ai/glm-5.1', 'z-ai/glm-5.2']);
    expect(await baselineOf(org.id)).toBe(result.id);
    expect(await snapshotIds()).toEqual([previousId, result.id]);
    const logs = await fetchAutoChangeLogs(org.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe(
      'Disabled new models from provider z-ai: z-ai/glm-5.1, z-ai/glm-5.2'
    );
  });

  test('keeps the default model and Organization Auto models enabled', async () => {
    const org = await createPolicyOrg('Configured Models Org', {
      default_model: 'z-ai/glm-5.1',
      org_auto_model: {
        routes: { balanced: 'z-ai/glm-5.2' },
        fallback_model: 'z-ai/glm-5.3',
      },
    });
    await seedBaseline(org.id, await seedSnapshot(glm5));

    await applySnapshotChangesAndAudit({
      providers: buildSnapshot([
        {
          slug: 'z-ai',
          models: ['z-ai/glm-5', 'z-ai/glm-5.1', 'z-ai/glm-5.2', 'z-ai/glm-5.3', 'z-ai/glm-5.4'],
        },
      ]),
    });

    const updated = await getOrganizationById(org.id);
    expect(updated?.settings.model_deny_list).toEqual(['z-ai/glm-5.4']);
    expect(updated?.settings.default_model).toBe('z-ai/glm-5.1');
    expect(updated?.settings.org_auto_model).toEqual({
      routes: { balanced: 'z-ai/glm-5.2' },
      fallback_model: 'z-ai/glm-5.3',
    });
    const logs = await fetchAutoChangeLogs(org.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe(
      'Added models from provider z-ai: z-ai/glm-5.1, z-ai/glm-5.2, z-ai/glm-5.3; Disabled new models from provider z-ai: z-ai/glm-5.4'
    );
    expect(logs[0].details).toEqual({
      id: 'autoRouting.models',
      added: [{ provider: 'z-ai', models: ['z-ai/glm-5.1', 'z-ai/glm-5.2', 'z-ai/glm-5.3'] }],
      removed: [],
      disabled: [{ provider: 'z-ai', models: ['z-ai/glm-5.4'] }],
    });
  });

  test('logs removals and disables additions in the same audit row', async () => {
    const org = await createPolicyOrg('Mixed Policy Org');
    await seedBaseline(
      org.id,
      await seedSnapshot(buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-4.0', 'z-ai/glm-5'] }]))
    );

    await applySnapshotChangesAndAudit({ providers: glm51 });

    expect(await denyList(org.id)).toEqual(['z-ai/glm-5.1']);
    const logs = await fetchAutoChangeLogs(org.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe(
      'Disabled new models from provider z-ai: z-ai/glm-5.1; Removed models (no longer available): z-ai/glm-4.0'
    );
    expect(logs[0].details).toEqual({
      id: 'autoRouting.models',
      added: [],
      removed: ['z-ai/glm-4.0'],
      disabled: [{ provider: 'z-ai', models: ['z-ai/glm-5.1'] }],
    });
  });

  test('logs removals without touching the deny list or the revision', async () => {
    const org = await createPolicyOrg('Removal Only Org', { model_deny_list: ['openai/gpt-4o'] });
    await seedBaseline(
      org.id,
      await seedSnapshot(buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-4.0', 'z-ai/glm-5'] }]))
    );

    await applySnapshotChangesAndAudit({ providers: glm5 });

    expect(await denyList(org.id)).toEqual(['openai/gpt-4o']);
    expect(await policyRevision(org.id)).toBeNull();
    const logs = await fetchAutoChangeLogs(org.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].details).toEqual({
      id: 'autoRouting.models',
      added: [],
      removed: ['z-ai/glm-4.0'],
    });
  });

  test('still handles an org with an expired entitlement', async () => {
    const org = await createPolicyOrg('Expired Policy Org');
    await db
      .update(organizations)
      .set({ free_trial_end_at: '2020-01-01T00:00:00.000Z', require_seats: true })
      .where(eq(organizations.id, org.id));
    await seedBaseline(org.id, await seedSnapshot(glm5));

    await applySnapshotChangesAndAudit({ providers: glm51 });

    expect(await denyList(org.id)).toEqual(['z-ai/glm-5.1']);
    expect(await fetchAutoChangeLogs(org.id)).toHaveLength(1);
  });

  test('does not touch soft-deleted orgs with the policy and drops their baseline', async () => {
    const org = await createPolicyOrg('Deleted Policy Org');
    await seedBaseline(org.id, await seedSnapshot(glm5));
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, org.id));

    await applySnapshotChangesAndAudit({ providers: glm51 });

    expect(await denyList(org.id)).toBeUndefined();
    expect(await fetchAutoChangeLogs(org.id)).toHaveLength(0);
    expect(await baselineOf(org.id)).toBeNull();
  });

  test('only advances the baseline of a non-enterprise org with the policy', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization(
      'Teams Policy Org',
      owner.id,
      0,
      { disable_new_models: true },
      true
    );
    await seedBaseline(org.id, await seedSnapshot(glm5));

    const result = await applySnapshotChangesAndAudit({ providers: glm51 });

    expect(await denyList(org.id)).toBeUndefined();
    expect(await policyRevision(org.id)).toBeNull();
    expect(await fetchAutoChangeLogs(org.id)).toHaveLength(0);
    expect(await baselineOf(org.id)).toBe(result.id);
  });

  test('without the policy, logs added models normally, does not deny them and drops the baseline', async () => {
    const owner = await insertTestUser();
    const restricted = await createTestOrganization('Flag Off Org', owner.id, 0, {
      disable_new_models: false,
      provider_policy_mode: 'allow',
      provider_allow_list: ['z-ai'],
      model_deny_list: ['openai/gpt-4o'],
    });
    const unrestricted = await createTestOrganization('Flag Off Unrestricted Org', owner.id, 0);
    const previousId = await seedSnapshot(glm5);
    await seedBaseline(restricted.id, previousId);
    await seedBaseline(unrestricted.id, previousId);

    await applySnapshotChangesAndAudit({ providers: glm51 });

    expect(await denyList(restricted.id)).toEqual(['openai/gpt-4o']);
    expect(await policyRevision(restricted.id)).toBeNull();
    expect(await baselineOf(restricted.id)).toBeNull();
    expect(await baselineOf(unrestricted.id)).toBeNull();
    const logs = await fetchAutoChangeLogs(restricted.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('Added models from provider z-ai: z-ai/glm-5.1');
    expect(logs[0].details).toEqual({
      id: 'autoRouting.models',
      added: [{ provider: 'z-ai', models: ['z-ai/glm-5.1'] }],
      removed: [],
    });
    expect(await fetchAutoChangeLogs(unrestricted.id)).toHaveLength(0);
  });

  test('writes one audit row for a restricted org with the policy, not a second one after the commit', async () => {
    const org = await createPolicyOrg('Restricted Policy Org', {
      provider_policy_mode: 'allow',
      provider_allow_list: ['z-ai'],
    });
    await seedBaseline(org.id, await seedSnapshot(glm5));

    await applySnapshotChangesAndAudit({ providers: glm51 });

    const logs = await fetchAutoChangeLogs(org.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('Disabled new models from provider z-ai: z-ai/glm-5.1');
  });

  test('one org failing does not block the others or the publication, and its baseline stays', async () => {
    // Its settings pass `getEffectiveModelRestrictions` but fail `OrganizationSettingsSchema.parse`
    // when the deny list is written.
    const failing = await createPolicyOrg('Failing Org', {
      minimum_balance_alert_email: ['not-an-email'],
    });
    const healthy = await createPolicyOrg('Healthy Org');
    const baselineId = await seedSnapshot(glm5);
    const previousId = await seedSnapshot(glm51);
    await seedBaseline(failing.id, baselineId);
    await seedBaseline(healthy.id, previousId);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await applySnapshotChangesAndAudit({ providers: glm52 });

      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(await denyList(healthy.id)).toEqual(['z-ai/glm-5.2']);
      expect(await baselineOf(healthy.id)).toBe(result.id);
      expect(await fetchAutoChangeLogs(healthy.id)).toHaveLength(1);

      expect(await denyList(failing.id)).toBeUndefined();
      expect(await policyRevision(failing.id)).toBeNull();
      expect(await baselineOf(failing.id)).toBe(baselineId);
      expect(await fetchAutoChangeLogs(failing.id)).toHaveLength(0);

      expect(await snapshotIds()).toEqual([baselineId, previousId, result.id]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test('retries a failed org on the next sync from its retained baseline', async () => {
    const org = await createPolicyOrg('Retry Org', {
      minimum_balance_alert_email: ['not-an-email'],
    });
    const baselineId = await seedSnapshot(glm5);
    await seedBaseline(org.id, baselineId);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await applySnapshotChangesAndAudit({ providers: glm51 });
      expect(await baselineOf(org.id)).toBe(baselineId);

      const settings = (await getOrganizationById(org.id))?.settings ?? {};
      await db
        .update(organizations)
        .set({ settings: { ...settings, minimum_balance_alert_email: [] } })
        .where(eq(organizations.id, org.id));

      const result = await applySnapshotChangesAndAudit({ providers: glm52 });

      expect([...((await denyList(org.id)) ?? [])].sort()).toEqual([
        'z-ai/glm-5.1',
        'z-ai/glm-5.2',
      ]);
      expect(await baselineOf(org.id)).toBe(result.id);
      expect(await snapshotIds()).toHaveLength(2);
      expect(await snapshotIds()).toContain(result.id);
      expect(await snapshotIds()).not.toContain(baselineId);
    } finally {
      consoleError.mockRestore();
    }
  });

  test('keeps the previous snapshot for one more cycle and deletes older ones', async () => {
    const firstId = await seedSnapshot(glm5);

    const second = await applySnapshotChangesAndAudit({ providers: glm51 });
    expect(await snapshotIds()).toEqual([firstId, second.id]);

    const third = await applySnapshotChangesAndAudit({ providers: glm52 });
    expect(await snapshotIds()).toEqual([second.id, third.id]);
  });

  test('keeps a snapshot an org baseline points at, even when it is older than the previous one', async () => {
    const org = await createPolicyOrg('Retained Baseline Org', {
      minimum_balance_alert_email: ['not-an-email'],
    });
    const baselineId = await seedSnapshot(glm5);
    await seedSnapshot(glm51);
    await seedBaseline(org.id, baselineId);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await applySnapshotChangesAndAudit({ providers: glm52 });

      expect(await snapshotIds()).toContain(baselineId);
      expect(await snapshotIds()).toContain(result.id);
      expect(await baselineOf(org.id)).toBe(baselineId);
    } finally {
      consoleError.mockRestore();
    }
  });

  test('reconciles orgs whose baselines are the previous snapshot and an older one in one publication', async () => {
    const current = await createPolicyOrg('Previous Baseline Org');
    const behind = await createPolicyOrg('Behind Baseline Org');
    const olderId = await seedSnapshot(glm5);
    const previousId = await seedSnapshot(glm51);
    await seedBaseline(current.id, previousId);
    await seedBaseline(behind.id, olderId);

    const result = await applySnapshotChangesAndAudit({ providers: glm52 });

    expect(await denyList(current.id)).toEqual(['z-ai/glm-5.2']);
    expect([...((await denyList(behind.id)) ?? [])].sort()).toEqual([
      'z-ai/glm-5.1',
      'z-ai/glm-5.2',
    ]);
    expect(await baselineOf(current.id)).toBe(result.id);
    expect(await baselineOf(behind.id)).toBe(result.id);
  });

  test('drops the baseline of an org that no longer has the policy', async () => {
    const org = await createPolicyOrg('Policy Turned Off Org');
    const previousId = await seedSnapshot(glm5);
    await seedBaseline(org.id, previousId);
    await db.update(organizations).set({ settings: {} }).where(eq(organizations.id, org.id));

    await applySnapshotChangesAndAudit({ providers: glm51 });

    expect(await baselineOf(org.id)).toBeNull();
    expect(await denyList(org.id)).toBeUndefined();
  });

  /**
   * Publishes `providers` while another transaction holds the org row, then commits that
   * transaction once the publication waits for the row. The publication has read the org by then.
   */
  async function publishWhileHoldingOrganization(
    organizationId: string,
    mutate: (settings: OrganizationSettings) => OrganizationSettings,
    providers: NormalizedOpenRouterResponse
  ) {
    let publication: ReturnType<typeof applySnapshotChangesAndAudit> | undefined;
    let publicationWaited = false;
    await db.transaction(async tx => {
      await mutateOrganizationSettings(
        organizationId,
        organization => mutate(organization.settings),
        tx
      );
      publication = applySnapshotChangesAndAudit({ providers });
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await db.execute<{ waiting: number }>(
          sql`SELECT count(*)::int AS waiting FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`
        );
        if (result.rows[0].waiting > 0) {
          publicationWaited = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    });
    const published = await publication;
    expect(publicationWaited).toBe(true);
    if (!published) throw new Error('the publication did not start');
    return published;
  }

  test('applies a deny list change made while the publication waited for the org lock', async () => {
    const org = await createPolicyOrg('Concurrent Deny List Org');
    await seedBaseline(org.id, await seedSnapshot(glm5));

    const result = await publishWhileHoldingOrganization(
      org.id,
      settings => ({ ...settings, model_deny_list: ['openai/gpt-4o'] }),
      glm51
    );

    expect(await denyList(org.id)).toEqual(['openai/gpt-4o', 'z-ai/glm-5.1']);
    expect(await baselineOf(org.id)).toBe(result.id);
    expect(await policyRevision(org.id)).toBe(1);
    expect(await fetchAutoChangeLogs(org.id)).toHaveLength(1);
  });

  test('takes a provider allow list change made while the publication waited into account', async () => {
    const org = await createPolicyOrg('Concurrent Allow List Org', {
      provider_allow_list: ['anthropic'],
    });
    const before = buildSnapshot([
      { slug: 'anthropic', models: ['anthropic/claude-4.5'] },
      { slug: 'z-ai', models: ['z-ai/glm-5'] },
    ]);
    const after = buildSnapshot([
      { slug: 'anthropic', models: ['anthropic/claude-4.5'] },
      { slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] },
    ]);
    await seedBaseline(org.id, await seedSnapshot(before));

    const result = await publishWhileHoldingOrganization(
      org.id,
      settings => ({ ...settings, provider_allow_list: ['anthropic', 'z-ai'] }),
      after
    );

    // The model z-ai lists for the first time is reachable through the provider the admin just
    // allowed, so it has to be disabled even though the unlocked read did not admit it.
    expect(await denyList(org.id)).toEqual(['z-ai/glm-5.1']);
    expect(await baselineOf(org.id)).toBe(result.id);
    const logs = await fetchAutoChangeLogs(org.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('Disabled new models from provider z-ai: z-ai/glm-5.1');
  });

  test.each([
    ['has no baseline', async () => undefined],
    ['has a dangling baseline', async (orgId: string) => seedBaseline(orgId, 987_654)],
  ])(
    'an org that %s keeps a starting baseline when its first reconciliation fails',
    async (_label, seedBaselineFor) => {
      const org = await createPolicyOrg('Starting Baseline Org', {
        minimum_balance_alert_email: ['not-an-email'],
      });
      await seedBaselineFor(org.id);
      const startId = await seedSnapshot(glm5);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        const first = await applySnapshotChangesAndAudit({ providers: glm51 });

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no usable baseline'));
        expect(consoleError).toHaveBeenCalledTimes(1);
        expect(await denyList(org.id)).toBeUndefined();
        expect(await baselineOf(org.id)).toBe(startId);
        expect(await snapshotIds()).toEqual([startId, first.id]);

        await db
          .update(organizations)
          .set({ settings: { disable_new_models: true } })
          .where(eq(organizations.id, org.id));
        const second = await applySnapshotChangesAndAudit({ providers: glm52 });

        expect([...((await denyList(org.id)) ?? [])].sort()).toEqual([
          'z-ai/glm-5.1',
          'z-ai/glm-5.2',
        ]);
        expect(await baselineOf(org.id)).toBe(second.id);
        expect(await snapshotIds()).toEqual([first.id, second.id]);
      } finally {
        warn.mockRestore();
        consoleError.mockRestore();
      }
    }
  );

  test('leaves an org without a baseline alone when there is no previous snapshot', async () => {
    const org = await createPolicyOrg('First Publication Org');

    await applySnapshotChangesAndAudit({ providers: glm5 });

    expect(await baselineOf(org.id)).not.toBeNull();
    expect(await denyList(org.id)).toBeUndefined();
  });

  test('keeps Organization Auto auto tiers valid after a sync denies a new model', async () => {
    const org = await createPolicyOrg('Auto Tier Org', {
      default_model: 'kilo-auto/org',
      org_auto_model: { routes: {}, fallback_model: 'kilo-auto/balanced' },
    });
    await seedBaseline(org.id, await seedSnapshot(glm5));

    await applySnapshotChangesAndAudit({ providers: glm51 });

    const updated = await getOrganizationById(org.id);
    expect(updated?.settings.model_deny_list).toEqual(['z-ai/glm-5.1']);
    await expect(
      validateOrganizationAutoTarget(
        { id: org.id, plan: 'enterprise', settings: updated?.settings ?? {} },
        'kilo-auto/balanced'
      )
    ).resolves.toEqual({ kind: 'ok', modelId: 'kilo-auto/balanced' });
  });
});

describe('the baseline check after a publication', () => {
  const glm5 = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
  const glm51 = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] }]);
  const glm52 = buildSnapshot([
    { slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1', 'z-ai/glm-5.2'] },
  ]);

  async function createPolicyOrg(name: string, settings: object = {}) {
    const owner = await insertTestUser();
    return createTestOrganization(name, owner.id, 0, { disable_new_models: true, ...settings });
  }

  /** The gateway's decision, with the snapshot reads served by the test database. */
  async function decide(organizationId: string, modelId: string) {
    const loader = createModelsByProviderIndexLoader({
      fetchSnapshot: async () => {
        const [row] = await db
          .select({ id: modelsByProvider.id, data: modelsByProvider.data })
          .from(modelsByProvider)
          .orderBy(sql`${modelsByProvider.id} desc`)
          .limit(1);
        return row;
      },
      fetchSnapshotById: async id => {
        const [row] = await db
          .select({ id: modelsByProvider.id, data: modelsByProvider.data })
          .from(modelsByProvider)
          .where(eq(modelsByProvider.id, id));
        return row;
      },
      fetchOpenRouterModels: async () => ({}),
      fetchVercelModels: async () => ({}),
      ttlMs: 60_000,
      nowMs: () => Date.now(),
    });
    const policyContext = await getOrganizationGroupPolicyContext({
      organizationId,
      subject: { type: 'defaultAccess' },
    });
    const policy = evaluateEffectiveModelAccessPolicy(policyContext);
    return {
      baselineSnapshotId: policy.newModelsBaselineSnapshotId,
      decision: await getEffectiveModelDecision(
        policy,
        modelId,
        loader.getProviderSlugsForModel,
        loader.isModelListedAtOrBefore
      ),
    };
  }

  const denied = { allowed: false, denialSource: 'organization_model' };

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

  test('a reconciled org reads its new baseline and is denied the disabled model', async () => {
    const org = await createPolicyOrg('Reconciled Org');
    const [{ id: baselineId }] = await db
      .insert(modelsByProvider)
      .values({ data: glm5 })
      .returning({ id: modelsByProvider.id });
    await db
      .insert(organization_new_models_baselines)
      .values({ organization_id: org.id, snapshot_id: baselineId });

    const published = await applySnapshotChangesAndAudit({ providers: glm51 });

    expect(await decide(org.id, 'z-ai/glm-5.1')).toEqual({
      baselineSnapshotId: published.id,
      decision: denied,
    });
    expect((await decide(org.id, 'z-ai/glm-5')).decision).toEqual({ allowed: true });
  });

  test('an org whose reconciliation failed is denied every model listed after its baseline', async () => {
    const failing = await createPolicyOrg('Failing Org', {
      minimum_balance_alert_email: ['not-an-email'],
    });
    const [{ id: baselineId }] = await db
      .insert(modelsByProvider)
      .values({ data: glm5 })
      .returning({ id: modelsByProvider.id });
    await db
      .insert(organization_new_models_baselines)
      .values({ organization_id: failing.id, snapshot_id: baselineId });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await applySnapshotChangesAndAudit({ providers: glm51 });
      await applySnapshotChangesAndAudit({ providers: glm52 });

      // The failed org never got a deny list entry, yet it still cannot use the new models.
      expect((await getOrganizationById(failing.id))?.settings.model_deny_list).toBeUndefined();
      expect(await decide(failing.id, 'z-ai/glm-5.1')).toEqual({
        baselineSnapshotId: baselineId,
        decision: denied,
      });
      expect((await decide(failing.id, 'z-ai/glm-5.2')).decision).toEqual(denied);
      expect((await decide(failing.id, 'z-ai/glm-5')).decision).toEqual({ allowed: true });
    } finally {
      consoleError.mockRestore();
    }
  });

  test('a failed org is admitted to the models once the next sync reconciles it', async () => {
    const org = await createPolicyOrg('Recovering Org', {
      minimum_balance_alert_email: ['not-an-email'],
    });
    const [{ id: baselineId }] = await db
      .insert(modelsByProvider)
      .values({ data: glm5 })
      .returning({ id: modelsByProvider.id });
    await db
      .insert(organization_new_models_baselines)
      .values({ organization_id: org.id, snapshot_id: baselineId });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await applySnapshotChangesAndAudit({ providers: glm51 });
      await mutateOrganizationSettings(org.id, organization => ({
        ...organization.settings,
        minimum_balance_alert_email: [],
      }));
      const published = await applySnapshotChangesAndAudit({ providers: glm52 });

      expect(await decide(org.id, 'z-ai/glm-5.1')).toEqual({
        baselineSnapshotId: published.id,
        decision: denied,
      });
      expect((await getOrganizationById(org.id))?.settings.model_deny_list).toEqual([
        'z-ai/glm-5.1',
        'z-ai/glm-5.2',
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test.each([
    ['no baseline', undefined],
    ['a dangling baseline', 987_654],
  ])(
    'an org with %s whose first reconciliation failed is denied the models published since',
    async (_label, danglingSnapshotId) => {
      const org = await createPolicyOrg('Starting Baseline Org', {
        minimum_balance_alert_email: ['not-an-email'],
      });
      if (danglingSnapshotId !== undefined) {
        await db
          .insert(organization_new_models_baselines)
          .values({ organization_id: org.id, snapshot_id: danglingSnapshotId });
      }
      const [{ id: startId }] = await db
        .insert(modelsByProvider)
        .values({ data: glm5 })
        .returning({ id: modelsByProvider.id });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        await applySnapshotChangesAndAudit({ providers: glm51 });

        expect(await decide(org.id, 'z-ai/glm-5.1')).toEqual({
          baselineSnapshotId: startId,
          decision: denied,
        });
        expect((await decide(org.id, 'z-ai/glm-5')).decision).toEqual({ allowed: true });
      } finally {
        warn.mockRestore();
        consoleError.mockRestore();
      }
    }
  );

  test('an org without the policy has no baseline check', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('No Policy Org', owner.id, 0);
    await db.insert(modelsByProvider).values({ data: glm5 });
    await applySnapshotChangesAndAudit({ providers: glm51 });

    expect(await decide(org.id, 'z-ai/glm-5.1')).toEqual({
      baselineSnapshotId: undefined,
      decision: { allowed: true },
    });
  });
});

describe('the baseline backfill in the migration', () => {
  const migrationsDir = path.resolve(__dirname, '../../../../../packages/db/src/migrations');
  const migrationFile = fs
    .readdirSync(migrationsDir)
    .find(file => file.endsWith('_organization_new_models_baselines.sql'));
  const backfill = fs
    .readFileSync(path.join(migrationsDir, migrationFile ?? 'missing.sql'), 'utf-8')
    .split('--> statement-breakpoint')
    .map(statement => statement.trim())
    .find(statement => statement.startsWith('INSERT INTO "organization_new_models_baselines"'));

  async function runBackfill() {
    if (!backfill) throw new Error('the migration has no baseline backfill');
    await db.execute(sql.raw(backfill));
  }

  async function allBaselines() {
    const rows = await db.select().from(organization_new_models_baselines);
    return new Map(rows.map(row => [row.organization_id, row.snapshot_id]));
  }

  beforeEach(async () => {
    await clearSnapshots();
  });

  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
    await clearSnapshots();
  });

  test('gives every live org with the policy the latest snapshot', async () => {
    const owner = await insertTestUser();
    const withPolicy = await createTestOrganization('Backfill Policy Org', owner.id, 0, {
      disable_new_models: true,
    });
    const policyOff = await createTestOrganization('Backfill Off Org', owner.id, 0, {
      disable_new_models: false,
    });
    const noSettings = await createTestOrganization('Backfill Plain Org', owner.id, 0);
    const deleted = await createTestOrganization('Backfill Deleted Org', owner.id, 0, {
      disable_new_models: true,
    });
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, deleted.id));
    await db.insert(modelsByProvider).values({ data: buildSnapshot([]) });
    const [{ id: latestId }] = await db
      .insert(modelsByProvider)
      .values({ data: buildSnapshot([]) })
      .returning({ id: modelsByProvider.id });

    await runBackfill();

    const baselines = await allBaselines();
    expect(baselines.get(withPolicy.id)).toBe(latestId);
    expect(baselines.has(policyOff.id)).toBe(false);
    expect(baselines.has(noSettings.id)).toBe(false);
    expect(baselines.has(deleted.id)).toBe(false);
  });

  test('keeps a baseline an org already has', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Backfill Existing Org', owner.id, 0, {
      disable_new_models: true,
    });
    await db.insert(modelsByProvider).values({ data: buildSnapshot([]) });
    await db
      .insert(organization_new_models_baselines)
      .values({ organization_id: org.id, snapshot_id: 1 });

    await runBackfill();

    expect((await allBaselines()).get(org.id)).toBe(1);
  });

  test('writes nothing when there is no snapshot', async () => {
    const owner = await insertTestUser();
    await createTestOrganization('Backfill Empty Org', owner.id, 0, { disable_new_models: true });

    await runBackfill();

    expect((await allBaselines()).size).toBe(0);
  });
});

describe('getOrganizationGroupPolicyContext new models baseline', () => {
  beforeEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_audit_logs);
    await clearSnapshots();
  });

  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
    await clearSnapshots();
  });

  async function baselineFor(options: { settings: object; teams?: boolean; baseline?: boolean }) {
    const owner = await insertTestUser();
    const org = await createTestOrganization(
      'Baseline Context Org',
      owner.id,
      0,
      options.settings,
      options.teams ? true : undefined
    );
    if (options.baseline !== false) {
      await db
        .insert(organization_new_models_baselines)
        .values({ organization_id: org.id, snapshot_id: 4242 });
    }
    const context = await getOrganizationGroupPolicyContext({
      organizationId: org.id,
      subject: { type: 'defaultAccess' },
    });
    return context.newModelsBaselineSnapshotId;
  }

  test('returns the baseline for an enterprise org with the policy', async () => {
    expect(await baselineFor({ settings: { disable_new_models: true } })).toBe(4242);
  });

  test('is undefined for an enterprise org with the policy but no baseline', async () => {
    expect(
      await baselineFor({ settings: { disable_new_models: true }, baseline: false })
    ).toBeUndefined();
  });

  test('ignores a leftover baseline of an org without the policy', async () => {
    expect(await baselineFor({ settings: {} })).toBeUndefined();
    expect(await baselineFor({ settings: { disable_new_models: false } })).toBeUndefined();
  });

  test('ignores a baseline outside Enterprise', async () => {
    expect(
      await baselineFor({ settings: { disable_new_models: true }, teams: true })
    ).toBeUndefined();
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

  test('reads the stored previous snapshot, keeps it next to the new one, and emits audit logs based on the diff', async () => {
    const owner = await insertTestUser();
    const enterpriseOrg = await createTestOrganization('Wiring Org', owner.id, 0, {
      provider_policy_mode: 'allow',
      provider_allow_list: ['z-ai'],
    });

    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    const [{ id: previousId }] = await db
      .insert(modelsByProvider)
      .values({ data: oldSnapshot })
      .returning({ id: modelsByProvider.id });

    const newSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] }]);
    const result = await applySnapshotChangesAndAudit({ providers: newSnapshot });

    expect(result.previousSnapshot?.providers[0].models.map(m => m.slug)).toEqual(['z-ai/glm-5']);
    expect(result.data.providers[0].models.map(m => m.slug)).toEqual([
      'z-ai/glm-5',
      'z-ai/glm-5.1',
    ]);

    const remainingRows = await db
      .select({ id: modelsByProvider.id, data: modelsByProvider.data })
      .from(modelsByProvider)
      .orderBy(modelsByProvider.id);
    expect(remainingRows).toEqual([
      { id: previousId, data: oldSnapshot },
      { id: result.id, data: newSnapshot },
    ]);

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
