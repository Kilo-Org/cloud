import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  addUserToOrganization,
  getOrganizationById,
  mutateOrganizationSettings,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { organization_audit_logs, type Organization, type User } from '@kilocode/db/schema';
import { createKiloDefaultEnkryptInputDetectors } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { desc, eq } from 'drizzle-orm';

jest.mock('@kilocode/web-shared/lib/posthog-feature-flags', () => ({
  isFeatureFlagEnabled: jest.fn(async () => true),
  isReleaseToggleEnabled: jest.fn(async () => true),
}));

import { isFeatureFlagEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';

const mockedIsFeatureFlagEnabled = jest.mocked(isFeatureFlagEnabled);

let owner: User;
let member: User;
let organization: Organization;

function savedConfig() {
  const detectors = createKiloDefaultEnkryptInputDetectors();
  detectors.keyword_detector = {
    enabled: true,
    action: 'block',
    banned_keywords: ['Project Phoenix', 'Acme'],
  };
  detectors.policy_violation = {
    enabled: true,
    format: 'policy_text',
    policy_text: 'Never share customer records.',
    rules: [],
  };
  return { enabled: true, scan_tool_results: false, detectors };
}

describe('organization guardrails router', () => {
  beforeAll(async () => {
    owner = await insertTestUser({
      google_user_email: 'owner-guardrails@example.com',
      google_user_name: 'Owner Guardrails',
      is_admin: false,
    });
    member = await insertTestUser({
      google_user_email: 'member-guardrails@example.com',
      google_user_name: 'Member Guardrails',
      is_admin: false,
    });
    organization = await createTestOrganization(
      'Guardrails Org',
      owner.id,
      0,
      { data_collection: 'deny' },
      false
    );
    await addUserToOrganization(organization.id, member.id, 'member');
  });

  beforeEach(() => {
    mockedIsFeatureFlagEnabled.mockResolvedValue(true);
  });

  it('returns Kilo Default, off, for an organization that never saved guardrails', async () => {
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.organizations.guardrails.get({ organizationId: organization.id })
    ).resolves.toEqual({
      enabled: false,
      scan_tool_results: false,
      detectors: createKiloDefaultEnkryptInputDetectors(),
    });
  });

  it('persists the configuration in organization settings and keeps unrelated settings', async () => {
    const caller = await createCallerForUser(owner.id);
    const config = savedConfig();

    const saved = await caller.organizations.guardrails.update({
      organizationId: organization.id,
      ...config,
    });

    expect(saved).toEqual(config);
    await expect(
      caller.organizations.guardrails.get({ organizationId: organization.id })
    ).resolves.toEqual(config);

    const updated = await getOrganizationById(organization.id);
    expect(updated?.settings).toEqual(
      expect.objectContaining({ data_collection: 'deny', enkrypt: { input_guardrail: config } })
    );
  });

  it('writes a content-free audit entry', async () => {
    const caller = await createCallerForUser(owner.id);
    const config = savedConfig();
    config.scan_tool_results = true;

    await caller.organizations.guardrails.update({ organizationId: organization.id, ...config });

    const [auditLog] = await db
      .select()
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organization.id))
      .orderBy(desc(organization_audit_logs.created_at))
      .limit(1);
    expect(auditLog.action).toBe('organization.settings.change');
    expect(auditLog.message).toBe(
      'Updated AI guardrails: enabled; checking every input; detectors: injection_attack, pii (log, secrets), keyword_detector (block, 2 keywords), policy_violation (policy text)'
    );
    expect(auditLog.message).not.toContain('Phoenix');
    expect(auditLog.message).not.toContain('customer records');
  });

  it('rejects enabling guardrails with no detector', async () => {
    const caller = await createCallerForUser(owner.id);
    const config = savedConfig();
    config.detectors.injection_attack.enabled = false;
    config.detectors.pii.enabled = false;
    config.detectors.keyword_detector.enabled = false;
    config.detectors.policy_violation.enabled = false;

    await expect(
      caller.organizations.guardrails.update({ organizationId: organization.id, ...config })
    ).rejects.toThrow('Turn on at least one detector.');
  });

  it('rejects an invalid detector configuration', async () => {
    const caller = await createCallerForUser(owner.id);
    const config = savedConfig();
    config.detectors.keyword_detector.banned_keywords = [];

    await expect(
      caller.organizations.guardrails.update({ organizationId: organization.id, ...config })
    ).rejects.toThrow('Add at least one keyword.');
  });

  it('forbids members from reading or changing guardrails', async () => {
    const caller = await createCallerForUser(member.id);

    await expect(
      caller.organizations.guardrails.get({ organizationId: organization.id })
    ).rejects.toThrow();
    await expect(
      caller.organizations.guardrails.update({ organizationId: organization.id, ...savedConfig() })
    ).rejects.toThrow();
  });

  it('is unavailable when the feature flag is off for the organization', async () => {
    mockedIsFeatureFlagEnabled.mockResolvedValue(false);
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.organizations.guardrails.get({ organizationId: organization.id })
    ).rejects.toThrow('AI Guardrails is not available for this organization.');
    expect(mockedIsFeatureFlagEnabled).toHaveBeenCalledWith('enkrypt-guardrails', organization.id);
  });

  it('contains invalid saved detectors to the guardrail', async () => {
    const invalidOrganization = await createTestOrganization(
      'Invalid Guardrails Org',
      owner.id,
      0,
      { enkrypt: { input_guardrail: { enabled: true, detectors: { injection_attack: true } } } },
      false
    );
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.organizations.guardrails.get({ organizationId: invalidOrganization.id })
    ).resolves.toEqual({
      enabled: true,
      scan_tool_results: true,
      detectors: createKiloDefaultEnkryptInputDetectors(),
    });
    await expect(
      mutateOrganizationSettings(invalidOrganization.id, current => ({
        ...current.settings,
        data_collection: 'deny',
      }))
    ).resolves.toMatchObject({ data_collection: 'deny' });
  });
});
