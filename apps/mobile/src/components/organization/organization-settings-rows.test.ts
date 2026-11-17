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
  Cpu: 'Cpu',
  FileText: 'FileText',
  KeyRound: 'KeyRound',
  LineChart: 'LineChart',
  Plug: 'Plug',
  ScrollText: 'ScrollText',
  Shield: 'Shield',
  SlidersHorizontal: 'SlidersHorizontal',
  Users: 'Users',
}));

// Every row is an absolute web URL, so the suite needs the base the app bakes
// in. The shared setup mocks this module with no value at all.
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.kilo.ai' }));

function gate(overrides: Partial<OrgSettingsGate> = {}): OrgSettingsGate {
  return {
    role: 'owner',
    plan: 'enterprise',
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
    expect(areas()).toEqual(['providersAndModels', 'guardrails']);
  });

  it('lists no web area for a member, who reads every destination in the app', () => {
    expect(areas({ role: 'member' })).toEqual([]);
    expect(areas({ role: 'member', plan: 'teams' })).toEqual([]);
  });

  it('keeps billing, management and admin rows for an admin on teams', () => {
    expect(areas({ role: 'admin', plan: 'teams' })).toEqual(['guardrails']);
  });

  it('hides guardrails when the organization has not enabled Kilo Encrypt', () => {
    expect(areas({ guardrailsEnabled: false })).not.toContain('guardrails');
  });

  it('drops the owner-only rows for a billing manager', () => {
    const rows = areas({ role: 'billing_manager' });
    expect(rows).not.toContain('guardrails');
    expect(rows).toContain('providersAndModels');
  });

  it('offers no row for the removed sub-organization destinations', () => {
    for (const role of ['owner', 'admin', 'billing_manager', 'member'] as const) {
      for (const plan of ['enterprise', 'teams'] as const) {
        for (const row of visibleOrgSettingsRows(gate({ role, plan }), 'org_1')) {
          // The hub names neither area and links nowhere for them.
          expect(row.url).not.toContain('sub-organizations');
          expect(row.url).not.toContain('distribute-funds');
          expect(row.url).not.toContain('request-logs');
        }
      }
    }
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
    expect(byArea.get('providersAndModels')?.endsWith('/organizations/org_1/providers-and-models')).toBe(
      true
    );
    expect(byArea.get('guardrails')?.endsWith('/organizations/org_1/guardrails')).toBe(true);
  });

  it('keeps every in-app area out of the web group', () => {
    for (const role of ['owner', 'admin', 'billing_manager', 'member', undefined] as const) {
      for (const plan of ['enterprise', 'teams'] as const) {
        const rows = areas({ role, plan });
        expect(rows).not.toContain('auditLogs');
        expect(rows).not.toContain('usageDetails');
        expect(rows).not.toContain('customModes');
        expect(rows).not.toContain('groups');
        expect(rows).not.toContain('byok');
        expect(rows).not.toContain('requestLogs');
      }
    }
  });
});

describe('visibleInAppSettingsRows', () => {
  it('returns every in-app area to a billing role on enterprise', () => {
    for (const role of ['owner', 'admin', 'billing_manager'] as const) {
      expect(inAppAreas({ role })).toEqual([
        'customModes',
        'groups',
        'usageDetails',
        'auditLogs',
        'requestLogs',
        'byok',
      ]);
    }
  });

  it('keeps custom modes, groups and usage for a member of an enterprise organization', () => {
    expect(inAppAreas({ role: 'member' })).toEqual(['customModes', 'groups', 'usageDetails']);
    expect(inAppAreas({ role: undefined })).toEqual(['customModes', 'groups', 'usageDetails']);
    expect(inAppAreas({ plan: 'teams', role: 'member' })).toEqual(['customModes', 'usageDetails']);
  });

  it('keeps the billing rows for a billing role on the teams plan, where the audit log is refused', () => {
    expect(inAppAreas({ plan: 'teams' })).toEqual([
      'customModes',
      'usageDetails',
      'requestLogs',
      'byok',
    ]);
  });

  it('opens the native screen that owns each setting', () => {
    const rows = visibleInAppSettingsRows({ role: 'owner', plan: 'enterprise' }, 'org_1');
    const byArea = new Map(rows.map(row => [row.area, row]));
    expect(byArea.get('customModes')?.href).toBe('/(app)/(tabs)/(3_profile)/organization/modes');
    expect(byArea.get('groups')?.href).toBe('/(app)/(tabs)/(3_profile)/organization/groups');
    expect(byArea.get('usageDetails')?.href).toBe('/(app)/(tabs)/(3_profile)/organization/usage');
    expect(byArea.get('auditLogs')?.href).toBe('/(app)/(tabs)/(3_profile)/organization/audit-log');
    expect(byArea.get('requestLogs')?.href).toBe(
      '/(app)/(tabs)/(3_profile)/organization/request-logs'
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
