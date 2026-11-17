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
  Plug: 'Plug',
  ScrollText: 'ScrollText',
  Shield: 'Shield',
  SlidersHorizontal: 'SlidersHorizontal',
  Users: 'Users',
  Wallet: 'Wallet',
}));

// Every row is an absolute web URL, so the suite needs the base the app bakes
// in. The shared setup mocks this module with no value at all.
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.kilo.ai' }));

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
  return visibleInAppSettingsRows(
    {
      role: 'owner',
      plan: 'enterprise',
      guardrailsEnabled: true,
      ...overrides,
    },
    'org_1'
  ).map(row => row.area);
}

describe('visibleOrgSettingsRows', () => {
  it('lists every web area for an owner of an enterprise organization', () => {
    expect(areas()).toEqual(['requestLogs', 'integrations', 'subOrganizations', 'distributeFunds']);
  });

  it('keeps only the member-readable rows for a member on enterprise', () => {
    expect(areas({ role: 'member' })).toEqual(['integrations']);
  });

  it('drops the enterprise-only rows for a member on teams', () => {
    expect(areas({ role: 'member', plan: 'teams' })).toEqual(['integrations']);
  });

  it('keeps billing, management and admin rows for an admin on teams', () => {
    expect(areas({ role: 'admin', plan: 'teams' })).toEqual([
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
    expect(rows).toContain('requestLogs');
  });

  it('drops the owner-only rows for a billing manager', () => {
    const rows = areas({ role: 'billing_manager' });
    expect(rows).toContain('requestLogs');
  });

  it('opens a page of its own for every row, never the dashboard', () => {
    for (const role of ['owner', 'admin', 'billing_manager', 'member'] as const) {
      for (const plan of ['enterprise', 'teams'] as const) {
        const rows = visibleOrgSettingsRows(gate({ role, plan }), 'org_1');
        for (const row of rows) {
          // A suffix-less row lands on the organization dashboard, which links
          // to the seats purchase; the hub lists no such row.
          expect(new URL(row.url).pathname).not.toBe('/organizations/org_1');
          expect(
            new URL(row.url, 'http://localhost').pathname.startsWith('/organizations/org_1/')
          ).toBe(true);
        }
      }
    }
    const byArea = new Map(visibleOrgSettingsRows(gate(), 'org_1').map(row => [row.area, row.url]));
    expect(byArea.get('subOrganizations')?.endsWith('/organizations/org_1/sub-organizations')).toBe(
      true
    );
    expect(
      byArea
        .get('distributeFunds')
        ?.endsWith('/organizations/org_1/sub-organizations/distribute-funds')
    ).toBe(true);
  });

  it('keeps every in-app area out of the web group', () => {
    for (const role of ['owner', 'admin', 'billing_manager', 'member', undefined] as const) {
      for (const plan of ['enterprise', 'teams'] as const) {
        const rows = areas({ role, plan });
        expect(rows).not.toContain('auditLogs');
        expect(rows).not.toContain('usageDetails');
        expect(rows).not.toContain('customModes');
        expect(rows).not.toContain('groups');
        expect(rows).not.toContain('providersAndModels');
        expect(rows).not.toContain('guardrails');
        expect(rows).not.toContain('byok');
      }
    }
  });
});

describe('visibleInAppSettingsRows', () => {
  it('returns every in-app area to a billing role on enterprise', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(inAppAreas({ role })).toEqual([
        'customModes',
        'groups',
        'usageDetails',
        'auditLogs',
        'providersAndModels',
        'guardrails',
        'byok',
      ]);
    }
    // A billing manager reaches Model Access, but guardrails stays with the
    // roles that manage the organization.
    expect(inAppAreas({ role: 'billing_manager' })).toEqual([
      'customModes',
      'groups',
      'usageDetails',
      'auditLogs',
      'providersAndModels',
      'byok',
    ]);
  });

  it('hides guardrails until the organization enables Kilo Encrypt', () => {
    expect(inAppAreas({ guardrailsEnabled: false })).not.toContain('guardrails');
    expect(inAppAreas({ guardrailsEnabled: undefined })).not.toContain('guardrails');
  });

  it('keeps custom modes, groups and usage for a member of an enterprise organization', () => {
    expect(inAppAreas({ role: 'member' })).toEqual(['customModes', 'groups', 'usageDetails']);
    expect(inAppAreas({ role: undefined })).toEqual(['customModes', 'groups', 'usageDetails']);
    expect(inAppAreas({ plan: 'teams', role: 'member' })).toEqual(['customModes', 'usageDetails']);
  });

  it('keeps the keys for a billing role on the teams plan, where the audit log is refused', () => {
    expect(inAppAreas({ plan: 'teams', guardrailsEnabled: false })).toEqual([
      'customModes',
      'usageDetails',
      'byok',
    ]);
  });

  it('opens the native screen that owns each setting', () => {
    const rows = visibleInAppSettingsRows(
      {
        role: 'owner',
        plan: 'enterprise',
        guardrailsEnabled: true,
      },
      'org_1'
    );
    const byArea = new Map(rows.map(row => [row.area, row]));
    expect(byArea.get('customModes')?.href).toBe('/(app)/(tabs)/(3_profile)/organization/modes');
    expect(byArea.get('groups')?.href).toBe('/(app)/(tabs)/(3_profile)/organization/groups');
    expect(byArea.get('usageDetails')?.href).toBe('/(app)/(tabs)/(3_profile)/organization/usage');
    expect(byArea.get('auditLogs')?.href).toBe('/(app)/(tabs)/(3_profile)/organization/audit-log');
    expect(byArea.get('providersAndModels')?.href).toBe(
      '/(app)/(tabs)/(3_profile)/organization/providers-and-models'
    );
    expect(byArea.get('guardrails')?.href).toBe(
      '/(app)/(tabs)/(3_profile)/organization/guardrails'
    );
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
