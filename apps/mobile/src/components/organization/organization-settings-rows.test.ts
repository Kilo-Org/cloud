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
    guardrailsEnabled: true,
    ...overrides,
  };
}

function areas(overrides: Partial<OrgSettingsGate> = {}) {
  return visibleOrgSettingsRows(gate(overrides), 'org_1').map(row => row.area);
}

function inAppAreas(overrides: Partial<OrgInAppSettingsGate> = {}) {
  return visibleInAppSettingsRows({ role: 'owner', plan: 'enterprise', ...overrides }).map(
    row => row.area
  );
}

describe('visibleOrgSettingsRows', () => {
  it('lists every area for an owner of an enterprise organization', () => {
    expect(areas()).toEqual([
      'providersAndModels',
      'customModes',
      'groups',
      'guardrails',
      'byok',
      'requestLogs',
      'integrations',
      'subOrganizations',
      'distributeFunds',
    ]);
  });

  it('keeps only the member-readable rows for a member on enterprise', () => {
    expect(areas({ role: 'member' })).toEqual(['customModes', 'groups', 'integrations']);
  });

  it('drops the enterprise-only rows for a member on teams', () => {
    expect(areas({ role: 'member', plan: 'teams' })).toEqual(['customModes', 'integrations']);
  });

  it('keeps billing, management and admin rows for an admin on teams', () => {
    expect(areas({ role: 'admin', plan: 'teams' })).toEqual([
      'customModes',
      'guardrails',
      'byok',
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
    expect(rows).toContain('providersAndModels');
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
        expect(areas({ role, plan })).not.toContain('auditLogs');
        expect(areas({ role, plan })).not.toContain('usageDetails');
      }
    }
  });
});

describe('visibleInAppSettingsRows', () => {
  it('returns usage to every role and plan, and the audit log to billing roles on enterprise', () => {
    for (const role of ['owner', 'admin', 'billing_manager'] as const) {
      expect(inAppAreas({ role })).toEqual(['usageDetails', 'auditLogs']);
    }
  });

  it('keeps usage for a member, an unknown role and a teams plan', () => {
    expect(inAppAreas({ role: 'member' })).toEqual(['usageDetails']);
    expect(inAppAreas({ role: undefined })).toEqual(['usageDetails']);
    expect(inAppAreas({ plan: 'teams' })).toEqual(['usageDetails']);
  });

  it('opens the app screens, not pages', () => {
    const rows = visibleInAppSettingsRows({ role: 'owner', plan: 'enterprise' });
    const byArea = new Map(rows.map(row => [row.area, row]));
    expect(byArea.get('usageDetails')?.href).toBe('/(app)/(tabs)/(3_profile)/organization/usage');
    expect(byArea.get('auditLogs')?.href).toBe('/(app)/(tabs)/(3_profile)/organization/audit-log');
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
