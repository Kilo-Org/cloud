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
    guardrailsEnabled: true,
    ...overrides,
  };
}

function areas(overrides: Partial<OrgSettingsGate> = {}) {
  return visibleOrgSettingsRows(gate(overrides), 'org_1').map(row => row.area);
}

function inAppAreas(overrides: Partial<OrgInAppSettingsGate> = {}) {
  return visibleInAppSettingsRows({ role: 'owner', plan: 'enterprise', ...overrides }, 'org_1').map(
    row => row.area
  );
}

describe('visibleOrgSettingsRows', () => {
  it('lists every web area for an owner of an enterprise organization', () => {
    expect(areas()).toEqual([
      'providersAndModels',
      'customModes',
      'groups',
      'guardrails',
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
      'customModes',
      'groups',
      'ssoAndDomain',
      'integrations',
    ]);
  });

  it('drops the enterprise-only rows for a member on teams', () => {
    expect(areas({ role: 'member', plan: 'teams' })).toEqual([
      'customModes',
      'dataCollection',
      'integrations',
    ]);
  });

  it('keeps billing, management and admin rows for an admin on teams', () => {
    expect(areas({ role: 'admin', plan: 'teams' })).toEqual([
      'customModes',
      'guardrails',
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
    expect(rows).toContain('providersAndModels');
  });

  it('hides guardrails when the organization has not enabled Kilo Encrypt', () => {
    expect(areas({ guardrailsEnabled: false })).not.toContain('guardrails');
  });

  it('drops the owner-only rows for a billing manager', () => {
    const rows = areas({ role: 'billing_manager' });
    expect(rows).not.toContain('guardrails');
    expect(rows).not.toContain('emailPreferences');
    expect(rows).toContain('providersAndModels');
  });

  it('opens the web page that owns each setting', () => {
    const rows = visibleOrgSettingsRows(gate(), 'org_1');
    const byArea = new Map(rows.map(row => [row.area, row]));
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
        expect(areas({ role, plan })).not.toContain('auditLogs');
        expect(areas({ role, plan })).not.toContain('usageDetails');
        expect(areas({ role, plan })).not.toContain('byok');
      }
    }
  });
});

describe('visibleInAppSettingsRows', () => {
  it('returns usage to every role and plan, and the audit log and keys to billing roles', () => {
    for (const role of ['owner', 'admin', 'billing_manager'] as const) {
      expect(inAppAreas({ role })).toEqual(['usageDetails', 'auditLogs', 'byok']);
    }
  });

  it('keeps usage for a member, an unknown role and a teams plan', () => {
    expect(inAppAreas({ role: 'member' })).toEqual(['usageDetails']);
    expect(inAppAreas({ role: undefined })).toEqual(['usageDetails']);
    expect(inAppAreas({ plan: 'teams', role: 'member' })).toEqual(['usageDetails']);
  });

  it('keeps the keys for a billing role on the teams plan, where the audit log is refused', () => {
    expect(inAppAreas({ plan: 'teams' })).toEqual(['usageDetails', 'byok']);
  });

  it('opens the app screens, not pages', () => {
    const rows = visibleInAppSettingsRows({ role: 'owner', plan: 'enterprise' }, 'org_1');
    const byArea = new Map(rows.map(row => [row.area, row]));
    expect(byArea.get('usageDetails')?.href).toBe('/(app)/(tabs)/(3_profile)/organization/usage');
    expect(byArea.get('auditLogs')?.href).toBe('/(app)/(tabs)/(3_profile)/organization/audit-log');
    expect(byArea.get('byok')?.href).toEqual({
      pathname: '/(app)/(tabs)/(3_profile)/provider-keys',
      params: { org: 'org_1' },
    });
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
