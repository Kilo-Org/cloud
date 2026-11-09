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
import type { EnkryptPolicyRule } from '@kilocode/db/schema-types';
import {
  createEmptyEnkryptOutputDetectors,
  createKiloDefaultEnkryptInputDetectors,
  storableEnkryptInputDetectors,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import { DEFAULT_ORGANIZATION_FEATURES } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { readOrganizationFeatures } from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { desc, eq } from 'drizzle-orm';

jest.mock('@kilocode/web-shared/lib/ai-gateway/organization-features', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/ai-gateway/organization-features'),
  readOrganizationFeatures: jest.fn(),
}));

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
    action: 'block',
    format: 'policy_text',
    policy_text: 'Never share customer records.',
    rules: [],
  };
  return {
    enabled: true,
    detectors,
    output: { enabled: false, detectors: createEmptyEnkryptOutputDetectors() },
  };
}

function policyRules(count: number) {
  return Array.from({ length: count }, (_, index): EnkryptPolicyRule => ({
    id: `rule-${index}`,
    display_text: '',
    text: 'Do not share customer records.',
    risk_category: 'privacy_data_protection',
    applicability: 'user',
    severity: 'high',
    frameworks: [],
  }));
}

function savedOutputConfig() {
  const detectors = createEmptyEnkryptOutputDetectors();
  detectors.pii = { enabled: true, action: 'block', entities: ['secrets'] };
  detectors.topic_detector = { enabled: true, action: 'log', topic: ['weapons'] };
  return { enabled: true, detectors };
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

  beforeEach(() => {
    jest.mocked(readOrganizationFeatures).mockResolvedValue({
      ...DEFAULT_ORGANIZATION_FEATURES,
      enkrypt_output_guardrail: [organization.id],
    });
  });

  it('returns Kilo Default, off, and no output detector for an organization that never saved guardrails', async () => {
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.organizations.guardrails.get({ organizationId: organization.id })
    ).resolves.toEqual({
      enabled: false,
      detectors: createKiloDefaultEnkryptInputDetectors(),
      output: { enabled: false, detectors: createEmptyEnkryptOutputDetectors() },
      output_available: true,
      invalid_saved_detectors: false,
      invalid_saved_output_detectors: false,
    });
  });

  it('persists the configuration in organization settings and keeps unrelated settings', async () => {
    const caller = await createCallerForUser(owner.id);
    const config = savedConfig();

    const saved = await caller.organizations.guardrails.update({
      organizationId: organization.id,
      ...config,
    });

    expect(saved).toEqual({
      ...config,
      output_available: true,
      invalid_saved_detectors: false,
      invalid_saved_output_detectors: false,
    });
    await expect(
      caller.organizations.guardrails.get({ organizationId: organization.id })
    ).resolves.toEqual(saved);

    const { output, ...inputGuardrail } = config;
    const updated = await getOrganizationById(organization.id);
    expect(updated?.settings).toEqual(
      expect.objectContaining({
        data_collection: 'deny',
        enkrypt: {
          input_guardrail: {
            ...inputGuardrail,
            detectors: storableEnkryptInputDetectors(inputGuardrail.detectors),
            scan_tool_results: true,
          },
          output_guardrail: output,
        },
      })
    );
    const storedDetectors = updated?.settings.enkrypt?.input_guardrail?.detectors;
    expect(storedDetectors).toMatchObject({ injection_attack: { enabled: true } });
    expect(storedDetectors).not.toHaveProperty('injection_attack.action');
    expect(storedDetectors).not.toHaveProperty('policy_violation.action');
  });

  it('saves and reads log only input detectors and counts them as turned on', async () => {
    const caller = await createCallerForUser(owner.id);
    const config = savedConfig();
    config.detectors.injection_attack.action = 'log';
    config.detectors.policy_violation.enabled = false;

    const saved = await caller.organizations.guardrails.update({
      organizationId: organization.id,
      ...config,
    });

    expect(saved.detectors.injection_attack).toEqual({ enabled: true, action: 'log' });
    await expect(
      caller.organizations.guardrails.get({ organizationId: organization.id })
    ).resolves.toMatchObject({
      detectors: { injection_attack: { enabled: true, action: 'log' } },
      invalid_saved_detectors: false,
    });
    const updated = await getOrganizationById(organization.id);
    expect(updated?.settings.enkrypt?.input_guardrail?.detectors).toMatchObject({
      injection_attack: { enabled: true, action: 'log' },
    });
    const [auditLog] = await db
      .select()
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organization.id))
      .orderBy(desc(organization_audit_logs.created_at))
      .limit(1);
    expect(auditLog.message).toContain(
      'detectors: injection_attack (log), pii (log, secrets), nsfw;'
    );
  });

  it('reads input detectors saved before they had an action as blocking', async () => {
    const { injection_attack, policy_violation, ...others } =
      createKiloDefaultEnkryptInputDetectors();
    const legacyOrganization = await createTestOrganization(
      'Legacy Action Guardrails Org',
      owner.id,
      0,
      {
        kilo_encrypt: true,
        enkrypt: {
          input_guardrail: {
            enabled: true,
            detectors: {
              ...others,
              injection_attack: { enabled: injection_attack.enabled },
              policy_violation: {
                enabled: policy_violation.enabled,
                format: policy_violation.format,
                policy_text: policy_violation.policy_text,
                rules: policy_violation.rules,
              },
            },
          },
        },
      },
      false
    );
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.organizations.guardrails.get({ organizationId: legacyOrganization.id })
    ).resolves.toMatchObject({
      detectors: createKiloDefaultEnkryptInputDetectors(),
      invalid_saved_detectors: false,
    });
  });

  it('saves the output guardrail separately from the input guardrail', async () => {
    const caller = await createCallerForUser(owner.id);
    const config = { ...savedConfig(), enabled: false, output: savedOutputConfig() };

    const saved = await caller.organizations.guardrails.update({
      organizationId: organization.id,
      ...config,
    });

    expect(saved.output).toEqual(savedOutputConfig());
    expect(saved.enabled).toBe(false);
    const updated = await getOrganizationById(organization.id);
    expect(updated?.settings.enkrypt?.output_guardrail).toEqual(savedOutputConfig());
    expect(updated?.settings.enkrypt?.input_guardrail).toMatchObject({ enabled: false });

    const [auditLog] = await db
      .select()
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organization.id))
      .orderBy(desc(organization_audit_logs.created_at))
      .limit(1);
    expect(auditLog.message).toContain(
      'output guardrails: enabled; output detectors: pii (block, secrets), topic_detector (log, 1 topics)'
    );
    expect(auditLog.message).not.toContain('weapons');
  });

  it('keeps the saved output guardrail when an input-only save follows feature revocation', async () => {
    const caller = await createCallerForUser(owner.id);
    await caller.organizations.guardrails.update({
      organizationId: organization.id,
      ...savedConfig(),
      output: savedOutputConfig(),
    });
    jest.mocked(readOrganizationFeatures).mockResolvedValue(DEFAULT_ORGANIZATION_FEATURES);
    const { output: _output, ...inputOnly } = savedConfig();

    const saved = await caller.organizations.guardrails.update({
      organizationId: organization.id,
      ...inputOnly,
    });

    expect(saved.output).toEqual(savedOutputConfig());
    expect(saved.output_available).toBe(false);
    const updated = await getOrganizationById(organization.id);
    expect(updated?.settings.enkrypt?.output_guardrail).toEqual(savedOutputConfig());
  });

  it('hides output configuration for an organization not granted the feature', async () => {
    jest.mocked(readOrganizationFeatures).mockResolvedValue({
      ...DEFAULT_ORGANIZATION_FEATURES,
      enkrypt_output_guardrail: [crypto.randomUUID()],
    });
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.organizations.guardrails.get({ organizationId: organization.id })
    ).resolves.toMatchObject({ output_available: false });
  });

  it('rejects direct output updates without the feature, including disabling output checks', async () => {
    jest.mocked(readOrganizationFeatures).mockResolvedValue(DEFAULT_ORGANIZATION_FEATURES);
    const caller = await createCallerForUser(owner.id);
    const previous = await getOrganizationById(organization.id);

    for (const output of [savedOutputConfig(), savedConfig().output]) {
      await expect(
        caller.organizations.guardrails.update({
          organizationId: organization.id,
          ...savedConfig(),
          output,
        })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Enkrypt output guardrails are not available for this organization.',
      });
    }

    expect((await getOrganizationById(organization.id))?.settings).toEqual(previous?.settings);
  });

  it('saves input guardrails without creating output settings when the feature was never granted', async () => {
    const ungranted = await createTestOrganization(
      'Input Only Guardrails Org',
      owner.id,
      0,
      { kilo_encrypt: true },
      false
    );
    const caller = await createCallerForUser(owner.id);
    const { output: _output, ...inputOnly } = savedConfig();

    await expect(
      caller.organizations.guardrails.update({ organizationId: ungranted.id, ...inputOnly })
    ).resolves.toMatchObject({ ...inputOnly, output_available: false });

    expect((await getOrganizationById(ungranted.id))?.settings.enkrypt).toEqual({
      input_guardrail: {
        ...inputOnly,
        detectors: storableEnkryptInputDetectors(inputOnly.detectors),
        scan_tool_results: true,
      },
    });
  });

  it('rejects enabling the output guardrail with no detector', async () => {
    const caller = await createCallerForUser(owner.id);
    const config = {
      ...savedConfig(),
      output: { enabled: true, detectors: createEmptyEnkryptOutputDetectors() },
    };

    await expect(
      caller.organizations.guardrails.update({ organizationId: organization.id, ...config })
    ).rejects.toThrow('Turn on at least one output detector.');
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

  it('writes a content-free audit entry', async () => {
    const caller = await createCallerForUser(owner.id);

    await caller.organizations.guardrails.update({
      organizationId: organization.id,
      ...savedConfig(),
    });

    const [auditLog] = await db
      .select()
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organization.id))
      .orderBy(desc(organization_audit_logs.created_at))
      .limit(1);
    expect(auditLog.action).toBe('organization.settings.change');
    expect(auditLog.message).toBe(
      'Updated AI guardrails: enabled; detectors: injection_attack (block), pii (log, secrets), policy_violation (block, policy text), nsfw; output guardrails: disabled; output detectors: none'
    );
    expect(auditLog.message).not.toContain('Phoenix');
    expect(auditLog.message).not.toContain('customer records');
  });

  it('always saves tool result scanning on, even when an older page sends it off', async () => {
    const caller = await createCallerForUser(owner.id);

    const saved = await caller.organizations.guardrails.update({
      organizationId: organization.id,
      ...savedConfig(),
      ...{ scan_tool_results: false },
    });

    expect(saved).not.toHaveProperty('scan_tool_results');
    const updated = await getOrganizationById(organization.id);
    expect(updated?.settings.enkrypt?.input_guardrail?.scan_tool_results).toBe(true);
  });

  it('rejects enabling guardrails with no configurable detector', async () => {
    const caller = await createCallerForUser(owner.id);
    const config = savedConfig();
    config.detectors.injection_attack.enabled = false;
    config.detectors.pii.enabled = false;
    config.detectors.policy_violation.enabled = false;
    expect(config.detectors.keyword_detector.enabled).toBe(true);

    await expect(
      caller.organizations.guardrails.update({ organizationId: organization.id, ...config })
    ).rejects.toThrow('Turn on at least one input detector.');
  });

  it('rejects saving more than five policy rules', async () => {
    const caller = await createCallerForUser(owner.id);
    const config = savedConfig();
    config.detectors.policy_violation = {
      enabled: true,
      action: 'block',
      format: 'rules',
      policy_text: '',
      rules: policyRules(6),
    };

    await expect(
      caller.organizations.guardrails.update({ organizationId: organization.id, ...config })
    ).rejects.toThrow('Add up to 5 rules.');

    const output = savedOutputConfig();
    output.detectors.policy_violation = {
      enabled: true,
      action: 'block',
      format: 'rules',
      policy_text: '',
      rules: policyRules(6),
    };
    await expect(
      caller.organizations.guardrails.update({
        organizationId: organization.id,
        ...savedConfig(),
        output,
      })
    ).rejects.toThrow('Add up to 5 rules.');
  });

  it('still reads a policy saved with more than five rules before the cap', async () => {
    const detectors = createKiloDefaultEnkryptInputDetectors();
    detectors.policy_violation = {
      enabled: true,
      action: 'block',
      format: 'rules',
      policy_text: '',
      rules: policyRules(8),
    };
    const legacyOrganization = await createTestOrganization(
      'Legacy Rules Guardrails Org',
      owner.id,
      0,
      { kilo_encrypt: true, enkrypt: { input_guardrail: { enabled: true, detectors } } },
      false
    );
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.organizations.guardrails.get({ organizationId: legacyOrganization.id })
    ).resolves.toMatchObject({ detectors, invalid_saved_detectors: false });
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
      detectors: createKiloDefaultEnkryptInputDetectors(),
      output: { enabled: false, detectors: createEmptyEnkryptOutputDetectors() },
      output_available: false,
      invalid_saved_detectors: true,
      invalid_saved_output_detectors: false,
    });
    await expect(
      mutateOrganizationSettings(invalidOrganization.id, current => ({
        ...current.settings,
        data_collection: 'deny',
      }))
    ).resolves.toMatchObject({ data_collection: 'deny' });
  });

  it('preserves invalid saved output detectors during input-only saves without the feature', async () => {
    const invalidOrganization = await createTestOrganization(
      'Invalid Response Guardrails Org',
      owner.id,
      0,
      {
        kilo_encrypt: true,
        enkrypt: { output_guardrail: { enabled: true, detectors: { pii: true } } },
      },
      false
    );
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.organizations.guardrails.get({ organizationId: invalidOrganization.id })
    ).resolves.toMatchObject({
      output: { enabled: true, detectors: createEmptyEnkryptOutputDetectors() },
      output_available: false,
      invalid_saved_detectors: false,
      invalid_saved_output_detectors: true,
    });

    const { output: _output, ...inputOnly } = savedConfig();
    await expect(
      caller.organizations.guardrails.update({
        organizationId: invalidOrganization.id,
        ...inputOnly,
      })
    ).resolves.toMatchObject({ output_available: false, invalid_saved_output_detectors: true });
    expect(
      (await getOrganizationById(invalidOrganization.id))?.settings.enkrypt?.output_guardrail
    ).toEqual({ enabled: true, detectors: { pii: true } });
  });
});
