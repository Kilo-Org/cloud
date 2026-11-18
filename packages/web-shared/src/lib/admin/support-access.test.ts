import { afterEach, describe, expect, test } from '@jest/globals';
import {
  SUPPORT_NEVER_KEYS,
  SUPPORT_READ_ALLOWLIST,
  SUPPORT_WRITE_ALLOWLIST,
  findSupportAllowEntry,
  isSupportAccessEnabled,
  supportEntrySatisfiesRoles,
  supportStandInRole,
} from '@kilocode/web-shared/lib/admin/support-access';

describe('support access switch', () => {
  afterEach(() => {
    delete process.env.SUPPORT_ACCESS_ENABLED;
  });

  test('only the exact string true enables support access', () => {
    delete process.env.SUPPORT_ACCESS_ENABLED;
    expect(isSupportAccessEnabled()).toBe(false);
    process.env.SUPPORT_ACCESS_ENABLED = '';
    expect(isSupportAccessEnabled()).toBe(false);
    process.env.SUPPORT_ACCESS_ENABLED = 'false';
    expect(isSupportAccessEnabled()).toBe(false);
    process.env.SUPPORT_ACCESS_ENABLED = '1';
    expect(isSupportAccessEnabled()).toBe(false);
    process.env.SUPPORT_ACCESS_ENABLED = 'true';
    expect(isSupportAccessEnabled()).toBe(true);
  });
});

describe('support access allowlists', () => {
  test('never list is disjoint from both allowlists', () => {
    const keys = new Set(
      [...SUPPORT_READ_ALLOWLIST, ...SUPPORT_WRITE_ALLOWLIST].map(entry => entry.key)
    );
    expect(SUPPORT_NEVER_KEYS.filter(key => keys.has(key))).toEqual([]);
  });

  test('no allowlist entry stands in for owner and writes require fresh step-up', () => {
    for (const entry of [...SUPPORT_READ_ALLOWLIST, ...SUPPORT_WRITE_ALLOWLIST]) {
      expect(supportStandInRole(entry)).not.toBe('owner');
    }
    for (const entry of SUPPORT_WRITE_ALLOWLIST) {
      expect(entry.stepUp).toBe('fresh');
      expect(entry.actionClass).toBe('support_write');
    }
    for (const entry of SUPPORT_READ_ALLOWLIST) {
      expect(entry.actionClass).toBe('support_read');
    }
  });

  test('lookup is exact and action-class aware', () => {
    expect(
      findSupportAllowEntry({
        surface: 'trpc',
        key: 'organizations.usageStats',
        actionClass: 'support_read',
      })?.key
    ).toBe('organizations.usageStats');
    expect(
      findSupportAllowEntry({
        surface: 'trpc',
        key: 'organizations.usageStats',
        actionClass: 'support_write',
      })
    ).toBeUndefined();
    expect(
      findSupportAllowEntry({
        surface: 'rest',
        key: '/api/organizations/00000000-0000-0000-0000-000000000000/defaults',
        actionClass: 'support_read',
      })?.key
    ).toBe('/api/organizations/[id]/defaults');
    expect(
      findSupportAllowEntry({
        surface: 'rest',
        key: '/api/organizations/x/defaults/extra',
        actionClass: 'support_read',
      })
    ).toBeUndefined();
  });

  test('stand-in entries satisfy only the roles they represent', () => {
    const read = findSupportAllowEntry({
      surface: 'trpc',
      key: 'organizations.usageStats',
      actionClass: 'support_read',
    });
    const billing = findSupportAllowEntry({
      surface: 'trpc',
      key: 'organizations.subscription.get',
      actionClass: 'support_read',
    });
    expect(read && supportEntrySatisfiesRoles(read, undefined)).toBe(true);
    expect(read && supportEntrySatisfiesRoles(read, ['owner'])).toBe(false);
    expect(billing && supportEntrySatisfiesRoles(billing, ['billing_manager'])).toBe(true);
    expect(billing && supportEntrySatisfiesRoles(billing, ['member'])).toBe(false);
    const manage = findSupportAllowEntry({
      surface: 'trpc',
      key: 'organizations.guardrails.get',
      actionClass: 'support_read',
    });
    // A manage stand-in is `admin`; it must not satisfy an owner-only set.
    expect(manage && supportEntrySatisfiesRoles(manage, ['owner'])).toBe(false);
    expect(manage && supportEntrySatisfiesRoles(manage, ['admin'])).toBe(true);
  });
});

describe('credential issuers stay off the allowlist', () => {
  test.each([
    ['/api/organizations/[id]/user-tokens', 'support_write'],
    ['/api/cloud-agent/sessions/stream-ticket', 'support_write'],
    ['/api/claw/openclaw-export', 'support_read'],
  ] as const)('%s is never allowlisted', (key, actionClass) => {
    expect(findSupportAllowEntry({ surface: 'rest', key, actionClass })).toBeUndefined();
    expect(SUPPORT_NEVER_KEYS).toContain(key);
  });
});
