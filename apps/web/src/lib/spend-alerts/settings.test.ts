import { afterAll, describe, expect, it } from '@jest/globals';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  spend_alert_hourly,
  organizations,
  user_notification_preferences,
} from '@kilocode/db/schema';
import { addUserToOrganization, createOrganization } from '@/lib/organizations/organizations';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  authorizedBillingContacts,
  derivePushCategoryEnabled,
  effectivePushFor,
  organizationScopeKey,
  parseSpendAlertScopeKey,
  personalScopeKey,
  pushCategoryChanges,
  readSpendAlertSettings,
  saveSpendAlertSettings,
  type SpendAlertRuleConfig,
} from './settings';

function ruleConfig(
  overrides: Partial<SpendAlertRuleConfig> & { kind: SpendAlertRuleConfig['kind'] }
): SpendAlertRuleConfig {
  return {
    enabled: true,
    thresholdMicrodollars: null,
    windowHours: null,
    multiplierBasisPoints: null,
    emailEnabled: true,
    pushEnabled: false,
    ...overrides,
  };
}

/** Start of the hour `hoursAgo` hours before now, in the storage timestamp shape. */
function hourBucket(hoursAgo: number): string {
  const instant = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  instant.setUTCMinutes(0, 0, 0);
  return instant.toISOString();
}

describe('spend alert scope keys', () => {
  it('round-trips each scope through its key', () => {
    expect(personalScopeKey('user-1')).toBe('user:user-1');
    expect(organizationScopeKey('org-1')).toBe('org:org-1');
    expect(parseSpendAlertScopeKey('user:user-1')).toEqual({ type: 'personal', userId: 'user-1' });
    expect(parseSpendAlertScopeKey('org:org-1')).toEqual({
      type: 'organization',
      organizationId: 'org-1',
    });
  });

  it('rejects a key that names neither scope', () => {
    expect(parseSpendAlertScopeKey('team:1')).toBeNull();
    expect(parseSpendAlertScopeKey('user:')).toBeNull();
    expect(parseSpendAlertScopeKey('')).toBeNull();
  });
});

describe('spend alert push derivation', () => {
  it('enables the category when any enabled rule asks for push', () => {
    expect(
      derivePushCategoryEnabled([
        ruleConfig({ kind: 'threshold', pushEnabled: false }),
        ruleConfig({ kind: 'anomaly', pushEnabled: true }),
      ])
    ).toBe(true);
  });

  it('leaves the category off when no enabled rule asks for push', () => {
    expect(
      derivePushCategoryEnabled([
        ruleConfig({ kind: 'threshold', pushEnabled: false }),
        ruleConfig({ kind: 'anomaly', pushEnabled: false }),
      ])
    ).toBe(false);
    expect(
      derivePushCategoryEnabled([
        ruleConfig({ kind: 'threshold', enabled: false, pushEnabled: true }),
        ruleConfig({ kind: 'anomaly', pushEnabled: false }),
      ])
    ).toBe(false);
  });

  it('reports effective push false for a viewer whose category is off, even though the rule asks for push', () => {
    const rule = ruleConfig({ kind: 'anomaly', pushEnabled: true });
    expect(effectivePushFor(true, rule)).toBe(true);
    expect(effectivePushFor(false, rule)).toBe(false);
    expect(effectivePushFor(true, ruleConfig({ kind: 'threshold', pushEnabled: false }))).toBe(
      false
    );
  });
});

describe('spend alert push category agreement', () => {
  const pushOn = ruleConfig({ kind: 'threshold', pushEnabled: true });
  const pushOff = ruleConfig({ kind: 'threshold', pushEnabled: false });
  const other = ruleConfig({ kind: 'anomaly' });

  it('reports a change only for the save that moves the channel choice', () => {
    // Turning a push channel on, or the last one off, moves the agreement.
    expect(pushCategoryChanges([], [pushOn, other])).toBe(true);
    expect(pushCategoryChanges([pushOn, other], [pushOff, other])).toBe(true);
    // Re-sending the stored channel choices does not.
    expect(pushCategoryChanges([pushOn, other], [pushOn, other])).toBe(false);
    expect(pushCategoryChanges([pushOff, other], [pushOff, other])).toBe(false);
    // A push rule that is switched off was not a push channel either way.
    expect(pushCategoryChanges([{ ...pushOn, enabled: false }, other], [pushOn, other])).toBe(true);
  });
});

describe('readSpendAlertSettings', () => {
  it('returns the feature off with schema defaults for a scope that has never been saved', async () => {
    const user = await insertTestUser();

    const settings = await readSpendAlertSettings(db, { type: 'personal', userId: user.id });

    expect(settings.scopeKey).toBe(personalScopeKey(user.id));
    expect(settings.enabled).toBe(false);
    expect(settings.rules.map(rule => rule.kind)).toEqual(['threshold', 'anomaly']);
    for (const rule of settings.rules) {
      expect(rule.enabled).toBe(true);
      expect(rule.emailEnabled).toBe(true);
      expect(rule.pushEnabled).toBe(false);
      expect(rule.firing).toBe(false);
      expect(rule.thresholdMicrodollars).toBeNull();
      expect(rule.windowHours).toBeNull();
      expect(rule.multiplierBasisPoints).toBeNull();
    }
    expect(settings.spend).toEqual({
      spend24hMicrodollars: 0,
      spend7dMicrodollars: 0,
      baselineHourlyMicrodollars: null,
    });
  });

  it('sums rolling spend over the trailing windows', async () => {
    const user = await insertTestUser();
    const scopeKey = personalScopeKey(user.id);
    await db.insert(spend_alert_hourly).values([
      { scope_key: scopeKey, hour_start: hourBucket(0), cost_microdollars: 5 },
      { scope_key: scopeKey, hour_start: hourBucket(48), cost_microdollars: 7 },
    ]);

    const settings = await readSpendAlertSettings(db, { type: 'personal', userId: user.id });

    expect(settings.spend.spend24hMicrodollars).toBe(5);
    expect(settings.spend.spend7dMicrodollars).toBe(12);
  });

  it('withholds the p95 baseline until the 24-bucket floor, excluding the current partial hour', async () => {
    const fewBucketsUser = await insertTestUser();
    const enoughBucketsUser = await insertTestUser();
    const fewScopeKey = personalScopeKey(fewBucketsUser.id);
    const enoughScopeKey = personalScopeKey(enoughBucketsUser.id);

    const buckets = (scopeKey: string, count: number) =>
      Array.from({ length: count }, (_unused, index) => ({
        scope_key: scopeKey,
        hour_start: hourBucket(index + 1),
        cost_microdollars: 100,
      }));

    await db.insert(spend_alert_hourly).values([
      ...buckets(fewScopeKey, 23),
      ...buckets(enoughScopeKey, 24),
      // The current partial hour is filling and must not drag the baseline down.
      { scope_key: fewScopeKey, hour_start: hourBucket(0), cost_microdollars: 9_999_999 },
      { scope_key: enoughScopeKey, hour_start: hourBucket(0), cost_microdollars: 9_999_999 },
      // Older than the 14-day baseline window.
      { scope_key: enoughScopeKey, hour_start: hourBucket(20 * 24), cost_microdollars: 5_000_000 },
    ]);

    const few = await readSpendAlertSettings(db, { type: 'personal', userId: fewBucketsUser.id });
    const enough = await readSpendAlertSettings(db, {
      type: 'personal',
      userId: enoughBucketsUser.id,
    });

    expect(few.spend.baselineHourlyMicrodollars).toBeNull();
    expect(enough.spend.baselineHourlyMicrodollars).toBe(100);
  });
});

describe('saveSpendAlertSettings', () => {
  it('persists the settings and both rules, and agrees the caller category with the push choice', async () => {
    const user = await insertTestUser();
    const scope = { type: 'personal', userId: user.id } as const;
    const pushRules = [
      ruleConfig({
        kind: 'threshold',
        thresholdMicrodollars: 5_000_000,
        windowHours: 24,
        pushEnabled: true,
      }),
      ruleConfig({ kind: 'anomaly', multiplierBasisPoints: 300 }),
    ];

    await saveSpendAlertSettings(db, scope, {
      enabled: true,
      rules: pushRules,
      viewerUserId: user.id,
    });

    const stored = await readSpendAlertSettings(db, scope);
    expect(stored.enabled).toBe(true);
    expect(stored.rules).toEqual([
      { ...pushRules[0], firing: false, conditionStartedAt: null, lastValueMicrodollars: null },
      { ...pushRules[1], firing: false, conditionStartedAt: null, lastValueMicrodollars: null },
    ]);

    const [preference] = await db
      .select({ enabled: user_notification_preferences.spend_alerts_enabled })
      .from(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, user.id));
    expect(preference?.enabled).toBe(true);

    // Turning push off everywhere turns the caller's own category back off.
    await saveSpendAlertSettings(db, scope, {
      enabled: true,
      rules: [
        ruleConfig({ kind: 'threshold', thresholdMicrodollars: 5_000_000, windowHours: 24 }),
        ruleConfig({ kind: 'anomaly', multiplierBasisPoints: 300 }),
      ],
      viewerUserId: user.id,
    });

    const [afterPushOff] = await db
      .select({ enabled: user_notification_preferences.spend_alerts_enabled })
      .from(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, user.id));
    expect(afterPushOff?.enabled).toBe(false);
  });

  it('leaves the caller’s own category alone when a save does not change the push choice', async () => {
    const user = await insertTestUser();
    const scope = { type: 'personal', userId: user.id } as const;
    const pushRules = [
      ruleConfig({
        kind: 'threshold',
        thresholdMicrodollars: 5_000_000,
        windowHours: 24,
        pushEnabled: true,
      }),
      ruleConfig({ kind: 'anomaly', multiplierBasisPoints: 300 }),
    ];

    await saveSpendAlertSettings(db, scope, {
      enabled: true,
      rules: pushRules,
      viewerUserId: user.id,
    });

    // The exact control the owner request adds: the mobile Notifications screen
    // turns this viewer's spend-alert category off.
    await db
      .update(user_notification_preferences)
      .set({ spend_alerts_enabled: false })
      .where(eq(user_notification_preferences.user_id, user.id));

    // An unrelated spend-view save — editing the threshold — re-sends the
    // stored rule, push included, without changing any channel choice.
    await saveSpendAlertSettings(db, scope, {
      enabled: true,
      rules: [
        ruleConfig({
          kind: 'threshold',
          thresholdMicrodollars: 9_000_000,
          windowHours: 24,
          pushEnabled: true,
        }),
        ruleConfig({ kind: 'anomaly', multiplierBasisPoints: 300 }),
      ],
      viewerUserId: user.id,
    });

    const [preference] = await db
      .select({ enabled: user_notification_preferences.spend_alerts_enabled })
      .from(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, user.id));
    expect(preference?.enabled).toBe(false);
  });

  it('enables the caller’s category when the save turns a push channel on', async () => {
    const user = await insertTestUser();
    const scope = { type: 'personal', userId: user.id } as const;

    await db
      .insert(user_notification_preferences)
      .values({ user_id: user.id, spend_alerts_enabled: false })
      .onConflictDoUpdate({
        target: user_notification_preferences.user_id,
        set: { spend_alerts_enabled: false },
      });

    await saveSpendAlertSettings(db, scope, {
      enabled: true,
      rules: [
        ruleConfig({
          kind: 'threshold',
          thresholdMicrodollars: 5_000_000,
          windowHours: 24,
          pushEnabled: true,
        }),
        ruleConfig({ kind: 'anomaly', multiplierBasisPoints: 300 }),
      ],
      viewerUserId: user.id,
    });

    const [preference] = await db
      .select({ enabled: user_notification_preferences.spend_alerts_enabled })
      .from(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, user.id));
    expect(preference?.enabled).toBe(true);
  });

  it('is idempotent when replayed', async () => {
    const user = await insertTestUser();
    const scope = { type: 'personal', userId: user.id } as const;
    const rules = [
      ruleConfig({ kind: 'threshold', thresholdMicrodollars: 2_000_000, windowHours: 168 }),
      ruleConfig({ kind: 'anomaly', multiplierBasisPoints: 150 }),
    ];

    await saveSpendAlertSettings(db, scope, { enabled: true, rules, viewerUserId: user.id });
    await saveSpendAlertSettings(db, scope, { enabled: true, rules, viewerUserId: user.id });

    const stored = await readSpendAlertSettings(db, scope);
    expect(stored.rules.filter(rule => rule.kind === 'threshold')).toHaveLength(1);
    expect(stored.rules.filter(rule => rule.kind === 'anomaly')).toHaveLength(1);
  });
});

describe('authorizedBillingContacts', () => {
  const createdOrganizationIds: string[] = [];

  afterAll(async () => {
    if (createdOrganizationIds.length > 0) {
      // spend_alert_settings.organization_id cascades from the organization.
      await db.delete(organizations).where(inArray(organizations.id, createdOrganizationIds));
    }
  });

  it('resolves the owner and billing managers of the one scope, excluding an admin and a member', async () => {
    const owner = await insertTestUser({ google_user_email: `sa-owner-${Date.now()}@example.com` });
    const billingManager = await insertTestUser({
      google_user_email: `sa-billing-${Date.now()}@example.com`,
    });
    const admin = await insertTestUser({
      google_user_email: `sa-admin-${Date.now()}@example.com`,
    });
    const member = await insertTestUser({
      google_user_email: `sa-member-${Date.now()}@example.com`,
    });
    const otherOwner = await insertTestUser({
      google_user_email: `sa-other-owner-${Date.now()}@example.com`,
    });

    const organization = await createOrganization('Spend alert recipients', owner.id);
    createdOrganizationIds.push(organization.id);
    await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');
    await addUserToOrganization(organization.id, admin.id, 'admin');
    await addUserToOrganization(organization.id, member.id, 'member');
    const otherOrganization = await createOrganization('Spend alert other org', otherOwner.id);
    createdOrganizationIds.push(otherOrganization.id);

    const contacts = await authorizedBillingContacts(db, {
      type: 'organization',
      organizationId: organization.id,
    });

    // The owner is the organization's creator (membership role `owner`); the
    // billing_manager is a recipient by role. An admin holds billing authority
    // but has no billing duty, so it does not receive the alert.
    expect(new Set(contacts.userIds)).toEqual(new Set([owner.id, billingManager.id]));
    expect(new Set(contacts.emails)).toEqual(
      new Set([owner.google_user_email, billingManager.google_user_email])
    );
    expect(contacts.userIds).not.toContain(admin.id);
    expect(contacts.userIds).not.toContain(member.id);
    expect(contacts.userIds).not.toContain(otherOwner.id);
  });

  it('includes the owner whose membership role is member', async () => {
    const owner = await insertTestUser({
      google_user_email: `sa-owner-member-${Date.now()}@example.com`,
    });

    // The organization's creator without an owner membership row, added later
    // as a plain member: the owner is resolved from created_by_kilo_user_id.
    const organization = await createOrganization('Spend alert member owner', owner.id, false);
    createdOrganizationIds.push(organization.id);
    await addUserToOrganization(organization.id, owner.id, 'member');

    const contacts = await authorizedBillingContacts(db, {
      type: 'organization',
      organizationId: organization.id,
    });

    expect(contacts).toEqual({ userIds: [owner.id], emails: [owner.google_user_email] });
  });

  it('includes the owner with no membership row at all', async () => {
    const owner = await insertTestUser({
      google_user_email: `sa-owner-absent-${Date.now()}@example.com`,
    });

    const organization = await createOrganization('Spend alert absent owner', owner.id, false);
    createdOrganizationIds.push(organization.id);

    const contacts = await authorizedBillingContacts(db, {
      type: 'organization',
      organizationId: organization.id,
    });

    expect(contacts).toEqual({ userIds: [owner.id], emails: [owner.google_user_email] });
  });

  it('includes a co-owner whose membership role is owner, not only the creator', async () => {
    const creator = await insertTestUser({
      google_user_email: `sa-creator-${Date.now()}@example.com`,
    });
    const coOwner = await insertTestUser({
      google_user_email: `sa-co-owner-${Date.now()}@example.com`,
    });

    // The creator holds no membership row; the co-owner holds the `owner` role.
    const organization = await createOrganization('Spend alert co-owner', creator.id, false);
    createdOrganizationIds.push(organization.id);
    await addUserToOrganization(organization.id, coOwner.id, 'owner');

    const contacts = await authorizedBillingContacts(db, {
      type: 'organization',
      organizationId: organization.id,
    });

    expect(new Set(contacts.userIds)).toEqual(new Set([creator.id, coOwner.id]));
  });

  it('includes the owner membership role of an organization with no creator', async () => {
    const owner = await insertTestUser({
      google_user_email: `sa-sponsored-owner-${Date.now()}@example.com`,
    });

    // An OSS-sponsored organization: created_by_kilo_user_id is null and the
    // sponsor is added with the `owner` membership role
    // (routers/admin/oss-sponsorship-router.ts).
    const organization = await createOrganization('Spend alert sponsored owner');
    createdOrganizationIds.push(organization.id);
    await addUserToOrganization(organization.id, owner.id, 'owner');

    const contacts = await authorizedBillingContacts(db, {
      type: 'organization',
      organizationId: organization.id,
    });

    expect(contacts).toEqual({ userIds: [owner.id], emails: [owner.google_user_email] });
  });

  it('never duplicates the owner who is also a billing_manager', async () => {
    const owner = await insertTestUser({
      google_user_email: `sa-owner-billing-${Date.now()}@example.com`,
    });

    const organization = await createOrganization('Spend alert owner billing', owner.id, false);
    createdOrganizationIds.push(organization.id);
    await addUserToOrganization(organization.id, owner.id, 'billing_manager');

    const contacts = await authorizedBillingContacts(db, {
      type: 'organization',
      organizationId: organization.id,
    });

    expect(contacts.userIds).toEqual([owner.id]);
    expect(contacts.emails).toEqual([owner.google_user_email]);
  });

  it('resolves the owner alone for a personal scope', async () => {
    const owner = await insertTestUser({
      google_user_email: `sa-personal-${Date.now()}@example.com`,
    });

    const contacts = await authorizedBillingContacts(db, { type: 'personal', userId: owner.id });

    expect(contacts).toEqual({ userIds: [owner.id], emails: [owner.google_user_email] });
  });
});
