import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  addUserToOrganization,
  getOrganizationById,
  mutateOrganizationSettings,
} from '@kilocode/web-shared/lib/organizations/organizations';
import {
  admin_action_audit_logs,
  organization_audit_logs,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { createKiloDefaultEnkryptInputDetectors } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { desc, eq } from 'drizzle-orm';

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
      { data_collection: 'deny', kilo_encrypt: true },
      false
    );
    await addUserToOrganization(organization.id, member.id, 'member');
  });

  it('returns Kilo Default, off, for an organization that never saved guardrails', async () => {
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.organizations.guardrails.get({ organizationId: organization.id })
    ).resolves.toEqual({
      enabled: false,
      scan_tool_results: false,
      detectors: createKiloDefaultEnkryptInputDetectors(),
      invalid_saved_detectors: false,
    });
  });

  it('persists the configuration in organization settings and keeps unrelated settings', async () => {
    const caller = await createCallerForUser(owner.id);
    const config = savedConfig();

    const saved = await caller.organizations.guardrails.update({
      organizationId: organization.id,
      ...config,
    });

    expect(saved).toEqual({ ...config, invalid_saved_detectors: false });
    await expect(
      caller.organizations.guardrails.get({ organizationId: organization.id })
    ).resolves.toEqual(saved);

    const updated = await getOrganizationById(organization.id);
    expect(updated?.settings).toEqual(
      expect.objectContaining({ data_collection: 'deny', enkrypt: { input_guardrail: config } })
    );
  });

  it('returns trimmed policy text so the saved form matches what was stored', async () => {
    const caller = await createCallerForUser(owner.id);
    const config = savedConfig();
    config.detectors.policy_violation.policy_text = '  Never share customer records.  ';

    const saved = await caller.organizations.guardrails.update({
      organizationId: organization.id,
      ...config,
    });

    expect(saved.detectors.policy_violation.policy_text).toBe('Never share customer records.');
  });

  it.each([
    { scanToolResults: true, scope: 'every input' },
    { scanToolResults: false, scope: 'conversation without tool results' },
  ])(
    'writes a content-free audit entry with scan_tool_results=$scanToolResults',
    async ({ scanToolResults, scope }) => {
      const caller = await createCallerForUser(owner.id);
      const config = savedConfig();
      config.scan_tool_results = scanToolResults;

      await caller.organizations.guardrails.update({ organizationId: organization.id, ...config });

      const [auditLog] = await db
        .select()
        .from(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organization.id))
        .orderBy(desc(organization_audit_logs.created_at))
        .limit(1);
      expect(auditLog.action).toBe('organization.settings.change');
      expect(auditLog.message).toBe(
        `Updated AI guardrails: enabled; checking ${scope}; detectors: injection_attack, pii (log, secrets), keyword_detector (block, 2 keywords), policy_violation (policy text)`
      );
      expect(auditLog.message).not.toContain('Phoenix');
      expect(auditLog.message).not.toContain('customer records');
    }
  );

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

  it('is unavailable until a Kilo admin enables kilo_encrypt for the organization', async () => {
    const ungranted = await createTestOrganization(
      'Ungranted Guardrails Org',
      owner.id,
      0,
      {},
      false
    );
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.organizations.guardrails.get({ organizationId: ungranted.id })
    ).rejects.toThrow('AI Guardrails is not available for this organization.');
    await expect(
      caller.organizations.guardrails.update({ organizationId: ungranted.id, ...savedConfig() })
    ).rejects.toThrow('AI Guardrails is not available for this organization.');
  });

  it('lets only Kilo admins turn kilo_encrypt on and off, with an admin audit entry', async () => {
    const target = await createTestOrganization('Kilo Encrypt Org', owner.id, 0, {}, false);
    const kiloAdmin = await insertTestUser({
      google_user_email: 'kilo-admin-guardrails@admin.example.com',
      google_user_name: 'Kilo Admin',
      is_admin: true,
    });

    await expect(
      (await createCallerForUser(owner.id)).organizations.admin.updateKiloEncrypt({
        organizationId: target.id,
        kilo_encrypt: true,
      })
    ).rejects.toThrow();

    const adminCaller = await createCallerForUser(kiloAdmin.id);
    await adminCaller.organizations.admin.updateKiloEncrypt({
      organizationId: target.id,
      kilo_encrypt: true,
    });
    expect((await getOrganizationById(target.id))?.settings.kilo_encrypt).toBe(true);
    await expect(
      (await createCallerForUser(owner.id)).organizations.guardrails.get({
        organizationId: target.id,
      })
    ).resolves.toMatchObject({ enabled: false });

    await adminCaller.organizations.admin.updateKiloEncrypt({
      organizationId: target.id,
      kilo_encrypt: false,
    });
    expect((await getOrganizationById(target.id))?.settings.kilo_encrypt).toBe(false);

    const [auditEntry] = await db
      .select()
      .from(admin_action_audit_logs)
      .where(eq(admin_action_audit_logs.action, 'organization.kilo_encrypt.set'))
      .orderBy(desc(admin_action_audit_logs.created_at))
      .limit(1);
    expect(auditEntry?.message).toBe('Disabled AI Guardrails');
  });

  it('reports invalid saved detectors and keeps them from breaking other settings', async () => {
    const invalidOrganization = await createTestOrganization(
      'Invalid Guardrails Org',
      owner.id,
      0,
      {
        kilo_encrypt: true,
        enkrypt: { input_guardrail: { enabled: true, detectors: { injection_attack: true } } },
      },
      false
    );
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.organizations.guardrails.get({ organizationId: invalidOrganization.id })
    ).resolves.toEqual({
      enabled: true,
      scan_tool_results: true,
      detectors: createKiloDefaultEnkryptInputDetectors(),
      invalid_saved_detectors: true,
    });
    await expect(
      mutateOrganizationSettings(invalidOrganization.id, current => ({
        ...current.settings,
        data_collection: 'deny',
      }))
    ).resolves.toMatchObject({ data_collection: 'deny' });
  });
});
