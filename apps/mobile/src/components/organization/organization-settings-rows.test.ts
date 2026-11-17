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
  Plug: 'Plug',
  ScrollText: 'ScrollText',
  Server: 'Server',
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
  return visibleInAppSettingsRows({ role: 'owner', plan: 'enterprise', ...overrides }, 'org_1').map(
    row => row.area
  );
}

describe('visibleOrgSettingsRows', () => {
  it('lists every web area for an owner of an enterprise organization', () => {
    expect(areas()).toEqual([
      'providersAndModels',
      'guardrails',
      'ssoAndDomain',
      'requestLogs',
      'integrations',
      'subOrganizations',
      'distributeFunds',
    ]);
  });

  it('keeps only the member-readable rows for a member on enterprise', () => {
    // The SSO card is the shell's own page, so it carries no billing gate.
    expect(areas({ role: 'member' })).toEqual(['ssoAndDomain', 'integrations']);
  });

  it('drops the enterprise-only rows for a member on teams', () => {
    // Data collection is the teams dashboard card the shell hosts, so a member
    // sees it where an enterprise member sees providers and models.
    expect(areas({ role: 'member', plan: 'teams' })).toEqual(['dataCollection', 'integrations']);
  });

  it('keeps billing, management and admin rows for an admin on teams', () => {
    expect(areas({ role: 'admin', plan: 'teams' })).toEqual([
      'guardrails',
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
    expect(rows).toContain('providersAndModels');
  });

  it('opens the web page that owns each setting', () => {
    const rows = visibleOrgSettingsRows(gate(), 'org_1');
    const byArea = new Map(rows.map(row => [row.area, row]));
    const webUrl = (area: 'subOrganizations' | 'distributeFunds') => {
      const target = byArea.get(area)?.target;
      return target?.kind === 'web' ? target.url : undefined;
    };
    expect(webUrl('subOrganizations')?.endsWith('/organizations/org_1/sub-organizations')).toBe(
      true
    );
    expect(
      webUrl('distributeFunds')?.endsWith('/organizations/org_1/sub-organizations/distribute-funds')
    ).toBe(true);
    // The two dashboard cards the app shell owns hand off to their shell pages.
    expect(byArea.get('ssoAndDomain')?.target).toEqual({
      kind: 'app-shell',
      target: { page: 'organization-sso', organizationId: 'org_1' },
    });
    // Data collection is the teams dashboard's card, in place of providers and
    // models, so it appears on that plan only.
    const teams = visibleOrgSettingsRows(gate({ plan: 'teams' }), 'org_1');
    expect(teams.find(row => row.area === 'dataCollection')?.target).toEqual({
      kind: 'app-shell',
      target: { page: 'organization-data-collection', organizationId: 'org_1' },
    });
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
        'byok',
      ]);
    }
  });

  it('keeps custom modes, groups and usage for a member of an enterprise organization', () => {
    expect(inAppAreas({ role: 'member' })).toEqual(['customModes', 'groups', 'usageDetails']);
    expect(inAppAreas({ role: undefined })).toEqual(['customModes', 'groups', 'usageDetails']);
    expect(inAppAreas({ plan: 'teams', role: 'member' })).toEqual(['customModes', 'usageDetails']);
  });

  it('keeps the keys for a billing role on the teams plan, where the audit log is refused', () => {
    expect(inAppAreas({ plan: 'teams' })).toEqual(['customModes', 'usageDetails', 'byok']);
  });

  it('opens the native screen that owns each setting', () => {
    const rows = visibleInAppSettingsRows({ role: 'owner', plan: 'enterprise' }, 'org_1');
    const byArea = new Map(rows.map(row => [row.area, row]));
    expect(byArea.get('customModes')?.href).toBe('/(app)/(tabs)/(3_profile)/organization/modes');
    expect(byArea.get('groups')?.href).toBe('/(app)/(tabs)/(3_profile)/organization/groups');
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
