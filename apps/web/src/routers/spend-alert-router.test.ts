import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  organizations,
  user_notification_preferences,
  user_push_tokens,
} from '@kilocode/db/schema';
import type { Organization, User } from '@kilocode/db/schema';
import { addUserToOrganization, createOrganization } from '@/lib/organizations/organizations';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';

const VALID_RULES = [
  {
    kind: 'threshold' as const,
    enabled: true,
    threshold: 250,
    windowHours: 24 as const,
    multiplierBasisPoints: null,
    emailEnabled: true,
    pushEnabled: true,
  },
  {
    kind: 'anomaly' as const,
    enabled: true,
    threshold: null,
    windowHours: null,
    multiplierBasisPoints: 300,
    emailEnabled: true,
    pushEnabled: false,
  },
];

describe('spendAlertRouter', () => {
  let owner: User;
  let billingManager: User;
  let member: User;
  let outsider: User;
  let organization: Organization;

  beforeAll(async () => {
    const suffix = Date.now();
    owner = await insertTestUser({ google_user_email: `sa-rtr-owner-${suffix}@example.com` });
    billingManager = await insertTestUser({
      google_user_email: `sa-rtr-billing-${suffix}@example.com`,
    });
    member = await insertTestUser({ google_user_email: `sa-rtr-member-${suffix}@example.com` });
    outsider = await insertTestUser({ google_user_email: `sa-rtr-outsider-${suffix}@example.com` });

    organization = await createOrganization('Spend alert router org', owner.id);
    await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');
    await addUserToOrganization(organization.id, member.id, 'member');
  });

  afterAll(async () => {
    const userIds = [owner.id, billingManager.id, member.id, outsider.id];
    await db
      .delete(user_notification_preferences)
      .where(inArray(user_notification_preferences.user_id, userIds));
    await db.delete(user_push_tokens).where(inArray(user_push_tokens.user_id, userIds));
    // spend_alert_settings.organization_id cascades from the organization.
    await db.delete(organizations).where(eq(organizations.id, organization.id));
  });

  it('rejects save from a member with FORBIDDEN', async () => {
    const caller = await createCallerForUser(member.id);

    await expect(
      caller.spendAlerts.save({
        organizationId: organization.id,
        enabled: true,
        rules: VALID_RULES,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects save from a caller with no organization access', async () => {
    const caller = await createCallerForUser(outsider.id);

    await expect(
      caller.spendAlerts.save({
        organizationId: organization.id,
        enabled: true,
        rules: VALID_RULES,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('lets a billing_manager save and read the organization settings back', async () => {
    const caller = await createCallerForUser(billingManager.id);

    const saved = await caller.spendAlerts.save({
      organizationId: organization.id,
      enabled: true,
      rules: VALID_RULES,
    });

    expect(saved).toMatchObject({
      scope: 'organization',
      scopeName: 'Spend alert router org',
      canManage: true,
      enabled: true,
    });
    expect(saved.rules?.find(rule => rule.kind === 'threshold')).toMatchObject({
      threshold: 250,
      windowHours: 24,
      pushEnabled: true,
      firing: false,
    });
    expect(saved.rules?.find(rule => rule.kind === 'anomaly')).toMatchObject({
      multiplierBasisPoints: 300,
      pushEnabled: false,
    });

    const fetched = await caller.spendAlerts.get({ organizationId: organization.id });
    expect(fetched).toMatchObject({ enabled: true, canManage: true, scope: 'organization' });
    expect(fetched.spend).toBeDefined();

    // The caller's own category agrees with the push choice they just saved.
    const [preference] = await db
      .select({ enabled: user_notification_preferences.spend_alerts_enabled })
      .from(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, billingManager.id));
    expect(preference?.enabled).toBe(true);
  });

  it('does not reverse a viewer’s notification opt-out on an unrelated spend-view save', async () => {
    const caller = await createCallerForUser(billingManager.id);
    const save = (threshold: number) =>
      caller.spendAlerts.save({
        organizationId: organization.id,
        enabled: true,
        rules: [{ ...VALID_RULES[0], threshold }, VALID_RULES[1]],
      });

    await save(250);
    // The Notifications screen owns the per-viewer category; turning Spend
    // alerts off there writes the same column the spend view used to re-derive.
    await caller.user.setNotificationPreferences({ spendAlerts: false });

    // An unrelated save (an edited limit, the same channel choices) must leave
    // the caller's own category where the Notifications screen put it.
    const saved = await save(300);
    expect(saved.pushCategoryEnabled).toBe(false);

    const [preference] = await db
      .select({ enabled: user_notification_preferences.spend_alerts_enabled })
      .from(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, billingManager.id));
    expect(preference?.enabled).toBe(false);
  });

  it('gives a member who may see the scope no settings payload and canManage false', async () => {
    const caller = await createCallerForUser(member.id);

    const result = await caller.spendAlerts.get({ organizationId: organization.id });

    expect(result).toMatchObject({ scope: 'organization', canManage: false });
    expect(result.enabled).toBeUndefined();
    expect(result.rules).toBeUndefined();
    expect(result.spend).toBeUndefined();
  });

  it('saves and reads the personal scope for the caller alone', async () => {
    const caller = await createCallerForUser(owner.id);

    const saved = await caller.spendAlerts.save({ enabled: true, rules: VALID_RULES });

    expect(saved).toMatchObject({
      scope: 'personal',
      scopeName: owner.google_user_name,
      canManage: true,
      enabled: true,
    });

    const fetched = await caller.spendAlerts.get({});
    expect(fetched).toMatchObject({ scope: 'personal', enabled: true });
    expect(fetched.rules?.map(rule => rule.kind)).toEqual(['threshold', 'anomaly']);
  });

  it('rejects out-of-range thresholds and windows', async () => {
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.spendAlerts.save({
        enabled: true,
        rules: [{ ...VALID_RULES[0], threshold: 1_000_001 }, VALID_RULES[1]],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await expect(
      caller.spendAlerts.save({
        enabled: true,
        rules: [{ ...VALID_RULES[0], windowHours: 12 as unknown as 24 }, VALID_RULES[1]],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await expect(
      caller.spendAlerts.save({
        enabled: true,
        rules: [{ ...VALID_RULES[0], threshold: 0 }, VALID_RULES[1]],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('reports the push channel blocked until the viewer registers a device', async () => {
    const viewer = await insertTestUser({
      google_user_email: `sa-rtr-viewer-${Date.now()}@example.com`,
    });
    const caller = await createCallerForUser(viewer.id);

    const before = await caller.spendAlerts.get({});
    expect(before.pushChannelBlocked).toBe(true);

    await db
      .insert(user_push_tokens)
      .values({ user_id: viewer.id, token: `sa-rtr-token-${Date.now()}`, platform: 'ios' });

    const after = await caller.spendAlerts.get({});
    expect(after.pushChannelBlocked).toBe(false);

    await db.delete(user_push_tokens).where(eq(user_push_tokens.user_id, viewer.id));
  });
});
