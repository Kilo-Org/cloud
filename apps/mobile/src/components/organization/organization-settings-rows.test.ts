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
  KeyRound: 'KeyRound',
  LineChart: 'LineChart',
  Lock: 'Lock',
  ScrollText: 'ScrollText',
  Server: 'Server',
  Shield: 'Shield',
  SlidersHorizontal: 'SlidersHorizontal',
  UsersRound: 'UsersRound',
}));

// The request-logs row mirrors its glyph with the screen that owns it, so the
// row table reads the direction-aware wrapper rather than the raw icon.
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalLogs: 'DirectionalLogs',
}));

// Every row is an absolute web URL, so the suite needs the base the app bakes
// in. The shared setup mocks this module with no value at all.
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.kilo.ai' }));

function gate(overrides: Partial<OrgSettingsGate> = {}): OrgSettingsGate {
  return {
    plan: 'enterprise',
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
  it('lists the shell card an enterprise organization shows', () => {
    expect(areas()).toEqual(['ssoAndDomain']);
  });

  it('shows the teams data collection card where enterprise shows providers and models', () => {
    // Data collection is the teams dashboard card the shell hosts, so it
    // replaces the enterprise card rather than joining it.
    expect(areas({ plan: 'teams' })).toEqual(['dataCollection']);
  });

  it('hands every remaining row off to the shell page that owns it', () => {
    // Providers and models, guardrails, request logs and the sub-organization
    // areas are in-app destinations or absent, so no web page row is left: the
    // two dashboard cards the app shell owns are the whole group.
    for (const plan of ['enterprise', 'teams'] as const) {
      for (const row of visibleOrgSettingsRows(gate({ plan }), 'org_1')) {
        expect(row.target.kind).toBe('app-shell');
      }
    }
    expect(visibleOrgSettingsRows(gate(), 'org_1')[0]?.target).toEqual({
      kind: 'app-shell',
      target: { page: 'organization-sso', organizationId: 'org_1' },
    });
    expect(visibleOrgSettingsRows(gate({ plan: 'teams' }), 'org_1')[0]?.target).toEqual({
      kind: 'app-shell',
      target: { page: 'organization-data-collection', organizationId: 'org_1' },
    });
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
        'requestLogs',
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
      'requestLogs',
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
      'requestLogs',
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
    expect(byArea.get('requestLogs')?.href).toBe(
      '/(app)/(tabs)/(3_profile)/organization/request-logs'
    );
    // The row and the screen's empty state draw one glyph, and it mirrors in
    // right-to-left, so neither reads as a different list from the other.
    expect(byArea.get('requestLogs')?.icon).toBe('DirectionalLogs');
    expect(byArea.get('auditLogs')?.icon).toBe('ScrollText');
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
