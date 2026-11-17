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
  Lock: 'Lock',
  Plug: 'Plug',
  ScrollText: 'ScrollText',
  Server: 'Server',
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
    expect(areas()).toEqual(['providersAndModels', 'guardrails', 'ssoAndDomain']);
  });

  it('keeps the shell card a member may open on enterprise', () => {
    // The SSO card is the shell's own page, so it carries no billing gate.
    expect(areas({ role: 'member' })).toEqual(['ssoAndDomain']);
  });

  it('shows the teams data collection card where enterprise shows providers and models', () => {
    // Data collection is the teams dashboard card the shell hosts, so a member
    // sees it where an enterprise member sees providers and models.
    expect(areas({ role: 'member', plan: 'teams' })).toEqual(['dataCollection']);
  });

  it('keeps billing, management and admin rows for an admin on teams', () => {
    expect(areas({ role: 'admin', plan: 'teams' })).toEqual(['guardrails', 'dataCollection']);
  });

  it('hides guardrails when the organization has not enabled Kilo Encrypt', () => {
    expect(areas({ guardrailsEnabled: false })).not.toContain('guardrails');
  });

  it('drops the owner-only rows for a billing manager', () => {
    const rows = areas({ role: 'billing_manager' });
    expect(rows).not.toContain('guardrails');
    expect(rows).toContain('providersAndModels');
  });

  it('offers no row for the removed sub-organization and integration destinations', () => {
    for (const role of ['owner', 'admin', 'billing_manager', 'member'] as const) {
      for (const plan of ['enterprise', 'teams'] as const) {
        const webUrls = visibleOrgSettingsRows(gate({ role, plan }), 'org_1').flatMap(row =>
          row.target.kind === 'web' ? [row.target.url] : []
        );
        for (const url of webUrls) {
          // The hub names none of these areas and links nowhere for them:
          // sub-organizations and distribute funds are a parent-only area this
          // app does not reimplement, integrations open the app's own screen
          // from the members card, and request logs are a native screen.
          expect(url).not.toContain('sub-organizations');
          expect(url).not.toContain('distribute-funds');
          expect(url).not.toContain('/request-logs');
          expect(url).not.toContain('/integrations');
        }
      }
    }
  });

  it('opens a page of its own for every web row, never the dashboard', () => {
    for (const role of ['owner', 'admin', 'billing_manager', 'member'] as const) {
      for (const plan of ['enterprise', 'teams'] as const) {
        const webUrls = visibleOrgSettingsRows(gate({ role, plan }), 'org_1').flatMap(row =>
          row.target.kind === 'web' ? [row.target.url] : []
        );
        for (const url of webUrls) {
          // A suffix-less row lands on the organization dashboard, which links
          // to the seats purchase; the hub lists no such row.
          expect(new URL(url).pathname).not.toBe('/organizations/org_1');
          expect(new URL(url).pathname.startsWith('/organizations/org_1/')).toBe(true);
        }
      }
    }
  });

  it('opens the page that owns each row, and the shell page for a dashboard card', () => {
    const byArea = new Map(
      visibleOrgSettingsRows(gate(), 'org_1').map(row => [row.area, row.target])
    );
    expect(byArea.get('providersAndModels')).toEqual({
      kind: 'web',
      url: 'https://app.kilo.ai/organizations/org_1/providers-and-models',
    });
    expect(byArea.get('guardrails')).toEqual({
      kind: 'web',
      url: 'https://app.kilo.ai/organizations/org_1/guardrails',
    });
    // The two dashboard cards the app shell owns hand off to their shell pages.
    expect(byArea.get('ssoAndDomain')).toEqual({
      kind: 'app-shell',
      target: { page: 'organization-sso', organizationId: 'org_1' },
    });
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
