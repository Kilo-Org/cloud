import { describe, expect, it, vi } from 'vitest';

import {
  canViewOrgAuditLog,
  type OrgInAppSettingsGate,
  type OrgSettingsGate,
  visibleInAppSettingsRows,
  visibleOrgSettingsRows,
} from '@/components/organization/organization-settings-rows';

// The row table carries icon components; the pure node project cannot load the
// native icon package, and the icons are not what this suite asserts.
vi.mock('@/components/ui/icons', () => ({
  Building2: 'Building2',
  Cpu: 'Cpu',
  FileText: 'FileText',
  KeyRound: 'KeyRound',
  LineChart: 'LineChart',
  Lock: 'Lock',
  Mail: 'Mail',
  Plug: 'Plug',
  ScrollText: 'ScrollText',
  Server: 'Server',
  Shield: 'Shield',
  SlidersHorizontal: 'SlidersHorizontal',
  Users: 'Users',
  Wallet: 'Wallet',
}));

function gate(overrides: Partial<OrgSettingsGate> = {}): OrgSettingsGate {
  return {
    role: 'owner',
    plan: 'enterprise',
    isTopLevel: true,
    ...overrides,
  };
}

function areas(overrides: Partial<OrgSettingsGate> = {}) {
  return visibleOrgSettingsRows(gate(overrides), 'org_1').map(row => row.area);
}

function inAppAreas(overrides: Partial<OrgInAppSettingsGate> = {}) {
  return visibleInAppSettingsRows({
    role: 'owner',
    plan: 'enterprise',
    guardrailsEnabled: true,
    ...overrides,
  }).map(row => row.area);
}

describe('visibleOrgSettingsRows', () => {
  it('lists every area for an owner of an enterprise organization', () => {
    expect(areas()).toEqual([
      'usageDetails',
      'customModes',
      'groups',
      'byok',
      'ssoAndDomain',
      'emailPreferences',
      'requestLogs',
      'integrations',
      'subOrganizations',
      'distributeFunds',
    ]);
  });

  it('keeps only the member-readable rows for a member on enterprise', () => {
    expect(areas({ role: 'member' })).toEqual([
      'usageDetails',
      'customModes',
      'groups',
      'ssoAndDomain',
      'integrations',
    ]);
  });

  it('drops the enterprise-only rows for a member on teams', () => {
    expect(areas({ role: 'member', plan: 'teams' })).toEqual([
      'usageDetails',
      'customModes',
      'dataCollection',
      'integrations',
    ]);
  });

  it('keeps billing, management and admin rows for an admin on teams', () => {
    expect(areas({ role: 'admin', plan: 'teams' })).toEqual([
      'usageDetails',
      'customModes',
      'byok',
      'emailPreferences',
      'dataCollection',
      'requestLogs',
      'integrations',
      'subOrganizations',
      'distributeFunds',
    ]);
  });

  it('hides the sub-organization rows for a child organization', () => {
    const rows = areas({ role: 'billing_manager', isTopLevel: false });
    expect(rows).not.toContain('subOrganizations');
    expect(rows).not.toContain('distributeFunds');
    expect(rows).toContain('byok');
  });

  it('drops the owner-only rows for a billing manager', () => {
    const rows = areas({ role: 'billing_manager' });
    expect(rows).not.toContain('emailPreferences');
    expect(rows).toContain('byok');
  });

  it('opens the web page that owns each setting', () => {
    const rows = visibleOrgSettingsRows(gate(), 'org_1');
    const byArea = new Map(rows.map(row => [row.area, row]));
    expect(
      byArea.get('usageDetails')?.url.endsWith('/organizations/org_1/usage-details?view=ai-usage')
    ).toBe(true);
    expect(
      byArea.get('subOrganizations')?.url.endsWith('/organizations/org_1/sub-organizations')
    ).toBe(true);
    expect(
      byArea
        .get('distributeFunds')
        ?.url.endsWith('/organizations/org_1/sub-organizations/distribute-funds')
    ).toBe(true);
    // A dashboard card rather than a page of its own.
    expect(byArea.get('ssoAndDomain')?.url.endsWith('/organizations/org_1')).toBe(true);
    // Data collection is the teams dashboard's card, in place of providers and
    // models, so it appears on that plan only.
    const teams = visibleOrgSettingsRows(gate({ plan: 'teams' }), 'org_1');
    expect(
      teams.find(row => row.area === 'dataCollection')?.url.endsWith('/organizations/org_1')
    ).toBe(true);
  });

  it('keeps every in-app area out of the web group', () => {
    for (const role of ['owner', 'admin', 'billing_manager', 'member', undefined] as const) {
      for (const plan of ['enterprise', 'teams'] as const) {
        const rows = areas({ role, plan });
        expect(rows).not.toContain('auditLogs');
        expect(rows).not.toContain('providersAndModels');
        expect(rows).not.toContain('guardrails');
      }
    }
  });
});

describe('visibleInAppSettingsRows', () => {
  it('returns the audit log and Model Access to every billing role on the enterprise plan', () => {
    for (const role of ['owner', 'admin', 'billing_manager'] as const) {
      expect(inAppAreas({ role, guardrailsEnabled: false })).toEqual([
        'auditLogs',
        'providersAndModels',
      ]);
    }
  });

  it('adds guardrails for the roles that manage the organization', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(inAppAreas({ role })).toEqual(['auditLogs', 'providersAndModels', 'guardrails']);
    }
  });

  it('hides guardrails until the organization enables Kilo Encrypt', () => {
    expect(inAppAreas({ guardrailsEnabled: false })).not.toContain('guardrails');
    expect(inAppAreas({ guardrailsEnabled: undefined })).not.toContain('guardrails');
  });

  it('returns the member-readable area less to a member, an unknown role or a teams plan', () => {
    expect(inAppAreas({ role: 'member' })).toEqual([]);
    expect(inAppAreas({ role: undefined })).toEqual([]);
    expect(inAppAreas({ plan: 'teams' })).toEqual(['guardrails']);
  });

  it('opens each in-app screen at its own route', () => {
    const byArea = new Map(
      visibleInAppSettingsRows({
        role: 'owner',
        plan: 'enterprise',
        guardrailsEnabled: true,
      }).map(row => [row.area, row])
    );
    expect(byArea.get('auditLogs')?.href).toBe('/(app)/(tabs)/(3_profile)/organization/audit-log');
    expect(byArea.get('providersAndModels')?.href).toBe(
      '/(app)/(tabs)/(3_profile)/organization/providers-and-models'
    );
    expect(byArea.get('guardrails')?.href).toBe(
      '/(app)/(tabs)/(3_profile)/organization/guardrails'
    );
  });
});

describe('canViewOrgAuditLog', () => {
  it('admits every billing role on the enterprise plan', () => {
    for (const role of ['owner', 'admin', 'billing_manager'] as const) {
      expect(canViewOrgAuditLog(role, 'enterprise')).toBe(true);
    }
  });

  it('refuses a member, an unknown role and every role on teams', () => {
    expect(canViewOrgAuditLog('member', 'enterprise')).toBe(false);
    expect(canViewOrgAuditLog(undefined, 'enterprise')).toBe(false);
    expect(canViewOrgAuditLog('owner', 'teams')).toBe(false);
  });
});
