import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import type { Organization, User } from '@kilocode/db/schema';
import {
  organization_alert_deliveries,
  organization_alerts,
  organization_audit_logs,
  organizations,
} from '@kilocode/db/schema';
import { asc, eq, inArray } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import {
  CALENDAR_MONTH_UTC_V1,
  resolveOrganizationAlertPeriodOccurrence,
  type OrganizationAlertDefinition,
} from '@/lib/organizations/alerts/organization-alerts';
import { addUserToOrganization, createOrganization } from '@/lib/organizations/organizations';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';

function definition(
  overrides: Partial<OrganizationAlertDefinition['configuration']> = {}
): OrganizationAlertDefinition {
  return {
    type: 'monthly_spending',
    configuration: {
      thresholdMicrodollars: 500_000_000,
      period: CALENDAR_MONTH_UTC_V1,
      scope: { type: 'organization' },
      recipients: ['finance@example.com'],
      ...overrides,
    },
  };
}

const currentPeriodOccurrenceId = () =>
  resolveOrganizationAlertPeriodOccurrence(CALENDAR_MONTH_UTC_V1, new Date()).occurrenceId;

describe('organization alerts router', () => {
  let owner: User;
  let organizationAdmin: User;
  let billingManager: User;
  let member: User;
  let outsider: User;
  let parentOwner: User;
  let childOwner: User;
  let organization: Organization;
  let teamsOrganization: Organization;
  let parentOrganization: Organization;
  let childOrganization: Organization;
  let organizationIds: string[];

  const create = async (
    userId: string,
    input: {
      organizationId?: string;
      definition?: OrganizationAlertDefinition;
      enabled?: boolean;
      recipientDisclosureConfirmed?: boolean;
    } = {}
  ) => {
    const caller = await createCallerForUser(userId);
    return await caller.organizations.alerts.create({
      organizationId: input.organizationId ?? organization.id,
      definition: input.definition ?? definition(),
      enabled: input.enabled ?? true,
      recipientDisclosureConfirmed: input.recipientDisclosureConfirmed ?? true,
    });
  };

  const list = async (
    userId: string,
    input: {
      organizationId?: string;
      limit?: number;
      cursor?: string;
      includeArchived?: boolean;
    } = {}
  ) => {
    const caller = await createCallerForUser(userId);
    return await caller.organizations.alerts.list({
      organizationId: input.organizationId ?? organization.id,
      limit: input.limit,
      cursor: input.cursor,
      includeArchived: input.includeArchived ?? false,
    });
  };

  const setPlan = (organizationId: string, plan: 'teams' | 'enterprise') =>
    db.update(organizations).set({ plan }).where(eq(organizations.id, organizationId));

  const auditMessages = async (organizationId: string) => {
    const rows = await db
      .select({ action: organization_audit_logs.action, message: organization_audit_logs.message })
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organizationId))
      .orderBy(asc(organization_audit_logs.created_at), asc(organization_audit_logs.id));
    return rows;
  };

  beforeAll(async () => {
    const suffix = crypto.randomUUID();
    [owner, organizationAdmin, billingManager, member, outsider, parentOwner, childOwner] =
      await Promise.all([
        insertTestUser({ google_user_email: `alerts-owner-${suffix}@example.com` }),
        insertTestUser({ google_user_email: `alerts-admin-${suffix}@example.com` }),
        insertTestUser({ google_user_email: `alerts-billing-${suffix}@example.com` }),
        insertTestUser({ google_user_email: `alerts-member-${suffix}@example.com` }),
        insertTestUser({ google_user_email: `alerts-outsider-${suffix}@example.com` }),
        insertTestUser({ google_user_email: `alerts-parent-owner-${suffix}@example.com` }),
        insertTestUser({ google_user_email: `alerts-child-owner-${suffix}@example.com` }),
      ]);

    organization = await createOrganization('Alerts org', owner.id, true, undefined, 'enterprise');
    teamsOrganization = await createOrganization(
      'Alerts teams org',
      owner.id,
      true,
      undefined,
      'teams'
    );
    parentOrganization = await createOrganization('Alerts parent', parentOwner.id);
    childOrganization = await createOrganization(
      'Alerts child',
      childOwner.id,
      true,
      undefined,
      'enterprise'
    );
    await db
      .update(organizations)
      .set({ parent_organization_id: parentOrganization.id })
      .where(eq(organizations.id, childOrganization.id));

    await addUserToOrganization(organization.id, organizationAdmin.id, 'admin');
    await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');
    await addUserToOrganization(organization.id, member.id, 'member');

    organizationIds = [
      organization.id,
      teamsOrganization.id,
      parentOrganization.id,
      childOrganization.id,
    ];
  });

  afterAll(async () => {
    await db
      .delete(organization_audit_logs)
      .where(inArray(organization_audit_logs.organization_id, organizationIds));
    await db.delete(organizations).where(inArray(organizations.id, organizationIds));
  });

  beforeEach(async () => {
    await db
      .delete(organization_alerts)
      .where(inArray(organization_alerts.organization_id, organizationIds));
    await db
      .delete(organization_audit_logs)
      .where(inArray(organization_audit_logs.organization_id, organizationIds));
    await setPlan(organization.id, 'enterprise');
  });

  describe('authorization', () => {
    it('lets every billing-capable role manage alerts', async () => {
      // One test rather than one per role: the role set itself is covered by
      // `canManageOrganizationBilling`, so what matters here is that each role
      // reaches this router.
      for (const userId of [owner.id, organizationAdmin.id, billingManager.id]) {
        const alert = await create(userId);
        expect(alert.status).toBe('enabled');
        expect((await list(userId)).alerts.map(row => row.id)).toContain(alert.id);
      }
    });

    it('rejects ordinary members and non-members without revealing alerts', async () => {
      await create(owner.id);

      for (const userId of [member.id, outsider.id]) {
        await expect(list(userId)).rejects.toThrow(/do not have/);
        await expect(create(userId)).rejects.toThrow(/do not have/);
      }
    });

    it('applies parent-over-direct-child billing authority', async () => {
      const alert = await create(parentOwner.id, { organizationId: childOrganization.id });

      expect(alert.organizationId).toBe(childOrganization.id);
      expect(
        (await list(parentOwner.id, { organizationId: childOrganization.id })).alerts
      ).toHaveLength(1);
      // Inheritance is parent-to-child only.
      await expect(list(childOwner.id, { organizationId: parentOrganization.id })).rejects.toThrow(
        /do not have/
      );
    });

    it('cannot reach another organization\u2019s alert by ID', async () => {
      const alert = await create(owner.id);
      const caller = await createCallerForUser(childOwner.id);

      await expect(
        caller.organizations.alerts.archive({
          organizationId: childOrganization.id,
          alertId: alert.id,
        })
      ).rejects.toThrow('Alert not found');
    });
  });

  describe('entitlement', () => {
    it('requires Enterprise to create', async () => {
      await expect(create(owner.id, { organizationId: teamsOrganization.id })).rejects.toThrow(
        /Enterprise/
      );
    });

    it('permits disable, recipient removal, and archive after entitlement loss', async () => {
      const alert = await create(owner.id, {
        definition: definition({ recipients: ['finance@example.com', 'ops@example.com'] }),
      });
      await setPlan(organization.id, 'teams');
      const caller = await createCallerForUser(owner.id);

      const disabled = await caller.organizations.alerts.setEnabled({
        organizationId: organization.id,
        alertId: alert.id,
        enabled: false,
        expectedConfigurationVersion: alert.configurationVersion,
      });
      expect(disabled.status).toBe('disabled');

      const trimmed = await caller.organizations.alerts.update({
        organizationId: organization.id,
        alertId: alert.id,
        definition: definition({ recipients: [] }),
        expectedConfigurationVersion: disabled.configurationVersion,
      });
      expect(trimmed.configuration.recipients).toEqual([]);

      const archived = await caller.organizations.alerts.archive({
        organizationId: organization.id,
        alertId: alert.id,
      });
      expect(archived.status).toBe('archived');
    });

    it('refuses to enable or expand after entitlement loss', async () => {
      const alert = await create(owner.id, { enabled: false });
      await setPlan(organization.id, 'teams');
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.alerts.setEnabled({
          organizationId: organization.id,
          alertId: alert.id,
          enabled: true,
          expectedConfigurationVersion: alert.configurationVersion,
        })
      ).rejects.toThrow(/Enterprise/);
      await expect(
        caller.organizations.alerts.update({
          organizationId: organization.id,
          alertId: alert.id,
          definition: definition({ thresholdMicrodollars: 900_000_000 }),
          expectedConfigurationVersion: alert.configurationVersion,
        })
      ).rejects.toThrow(/Enterprise/);
      await expect(
        caller.organizations.alerts.update({
          organizationId: organization.id,
          alertId: alert.id,
          definition: definition({ recipients: ['finance@example.com', 'new@example.com'] }),
          expectedConfigurationVersion: alert.configurationVersion,
          recipientDisclosureConfirmed: true,
        })
      ).rejects.toThrow(/Enterprise/);
    });
  });

  describe('collection', () => {
    it('keeps independent identities for identical alerts and imposes no count limit', async () => {
      const first = await create(owner.id);
      const second = await create(owner.id);
      const third = await create(owner.id, {
        definition: definition({ thresholdMicrodollars: 1_000_000_000 }),
      });

      expect(new Set([first.id, second.id, third.id]).size).toBe(3);
      expect(first.configuration).toEqual(second.configuration);
      expect((await list(owner.id)).alerts).toHaveLength(3);
    });

    it('pages the list with a stable cursor', async () => {
      const created = [await create(owner.id), await create(owner.id), await create(owner.id)];

      const firstPage = await list(owner.id, { limit: 2 });
      expect(firstPage.alerts).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();

      const secondPage = await list(owner.id, { limit: 2, cursor: firstPage.nextCursor ?? '' });
      expect(secondPage.nextCursor).toBeNull();
      expect([...firstPage.alerts, ...secondPage.alerts].map(row => row.id)).toEqual(
        [...created].reverse().map(row => row.id)
      );
    });

    it('rejects an unusable cursor recoverably', async () => {
      await expect(list(owner.id, { cursor: 'not-a-cursor' })).rejects.toThrow(/Invalid/);
    });
  });

  describe('recipients', () => {
    it('persists recipients normalized and applies the lifecycle-specific rules', async () => {
      // The recipient rules themselves are unit-tested; this covers that the
      // write path applies them and picks the schema matching the saved state.
      const alert = await create(owner.id, {
        definition: definition({
          recipients: [' Finance@Example.COM ', 'finance@example.com', 'OPS@example.com'],
        }),
      });
      expect(alert.configuration.recipients).toEqual(['finance@example.com', 'ops@example.com']);

      await expect(
        create(owner.id, { definition: definition({ recipients: [] }) })
      ).rejects.toThrow(/at least one recipient/);

      const disabled = await create(owner.id, {
        enabled: false,
        definition: definition({ recipients: [] }),
      });
      expect(disabled).toMatchObject({ status: 'disabled' });
      expect(disabled.configuration.recipients).toEqual([]);
    });

    it('reports the per-alert-period admission cap independently per alert', async () => {
      const alert = await create(owner.id);
      const other = await create(owner.id);
      const periodOccurrenceId = currentPeriodOccurrenceId();
      await db.insert(organization_alert_deliveries).values(
        Array.from({ length: 10 }, (_, index) => ({
          alert_id: alert.id,
          period_occurrence_id: periodOccurrenceId,
          recipient_identity_hmac: `hmac-${index}`,
          channel: 'email' as const,
          claimed_configuration_version: 1,
          threshold_microdollars: 500_000_000,
          measured_value_microdollars: 500_000_000,
        }))
      );

      const rows = (await list(owner.id)).alerts;
      const admitted = rows.find(row => row.id === alert.id);
      const unaffected = rows.find(row => row.id === other.id);

      expect(admitted).toMatchObject({ periodOccurrenceId, admittedRecipientCount: 10 });
      expect(unaffected).toMatchObject({ periodOccurrenceId, admittedRecipientCount: 0 });
    });

    it('reports a low balance alert\u2019s most recent crossing occurrence, not a calendar period', async () => {
      const alert = await create(owner.id, {
        definition: {
          type: 'low_balance',
          configuration: { thresholdMicrodollars: 50_000_000, recipients: ['finance@example.com'] },
        },
      });
      const beforeAnyDelivery = (await list(owner.id)).alerts.find(row => row.id === alert.id);
      expect(beforeAnyDelivery).toMatchObject({ admittedRecipientCount: 0 });

      const crossingOccurrenceId = 'low_balance:crossing:v1:2026-08-27T10:00:00.000Z';
      await db.insert(organization_alert_deliveries).values({
        alert_id: alert.id,
        period_occurrence_id: crossingOccurrenceId,
        recipient_identity_hmac: 'hmac-0',
        channel: 'email',
        claimed_configuration_version: 1,
        threshold_microdollars: 50_000_000,
        measured_value_microdollars: 40_000_000,
      });

      const afterDelivery = (await list(owner.id)).alerts.find(row => row.id === alert.id);
      expect(afterDelivery).toMatchObject({
        periodOccurrenceId: crossingOccurrenceId,
        admittedRecipientCount: 1,
      });
    });

    it('requires disclosure confirmation to save an alert or add an address', async () => {
      await expect(create(owner.id, { recipientDisclosureConfirmed: false })).rejects.toThrow(
        /Confirm that every recipient/
      );

      const alert = await create(owner.id, {
        definition: definition({ recipients: ['finance@example.com', 'ops@example.com'] }),
      });
      const caller = await createCallerForUser(owner.id);
      const update = {
        organizationId: organization.id,
        alertId: alert.id,
        definition: definition({
          recipients: ['finance@example.com', 'ops@example.com', 'new@example.com'],
        }),
        expectedConfigurationVersion: alert.configurationVersion,
      };

      await expect(caller.organizations.alerts.update(update)).rejects.toThrow(
        /Confirm that every recipient/
      );
      // Removal never needs confirmation: it narrows the disclosure.
      const removed = await caller.organizations.alerts.update({
        ...update,
        definition: definition({ recipients: ['ops@example.com'] }),
      });
      expect(removed.configuration.recipients).toEqual(['ops@example.com']);
    });
  });

  describe('configuration version', () => {
    it('bumps the version on a material change and rejects a stale version', async () => {
      const alert = await create(owner.id);
      const caller = await createCallerForUser(owner.id);

      const updated = await caller.organizations.alerts.update({
        organizationId: organization.id,
        alertId: alert.id,
        definition: definition({ thresholdMicrodollars: 750_000_000 }),
        expectedConfigurationVersion: alert.configurationVersion,
      });
      expect(updated.configurationVersion).toBe(alert.configurationVersion + 1);
      expect(updated.configuration.thresholdMicrodollars).toBe(750_000_000);

      await expect(
        caller.organizations.alerts.update({
          organizationId: organization.id,
          alertId: alert.id,
          definition: definition({ thresholdMicrodollars: 800_000_000 }),
          expectedConfigurationVersion: alert.configurationVersion,
        })
      ).rejects.toThrow(/changed by someone else/);
    });

    it('leaves the version and audit trail untouched when nothing material changed', async () => {
      const alert = await create(owner.id);
      const caller = await createCallerForUser(owner.id);

      const unchanged = await caller.organizations.alerts.update({
        organizationId: organization.id,
        alertId: alert.id,
        definition: definition(),
        expectedConfigurationVersion: alert.configurationVersion,
      });

      expect(unchanged.configurationVersion).toBe(alert.configurationVersion);
      expect(await auditMessages(organization.id)).toHaveLength(1);
    });

    it('keeps the alert type immutable', async () => {
      const alert = await create(owner.id);
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.alerts.update({
          organizationId: organization.id,
          alertId: alert.id,
          // Not a registered alert type; changing type requires a new alert.
          definition: {
            ...definition(),
            type: 'daily_spending',
          } as unknown as OrganizationAlertDefinition,
          expectedConfigurationVersion: alert.configurationVersion,
        })
      ).rejects.toThrow();

      const [stored] = await db
        .select()
        .from(organization_alerts)
        .where(eq(organization_alerts.id, alert.id));
      expect(stored.type).toBe('monthly_spending');
      expect(stored.configuration_version).toBe(alert.configurationVersion);
    });
  });

  describe('archive', () => {
    it('hides the alert by default, exposes it on request, and is terminal', async () => {
      const alert = await create(owner.id);
      const caller = await createCallerForUser(owner.id);

      const archived = await caller.organizations.alerts.archive({
        organizationId: organization.id,
        alertId: alert.id,
      });
      expect(archived.status).toBe('archived');
      expect(archived.archivedAt).not.toBeNull();

      expect((await list(owner.id)).alerts).toHaveLength(0);
      expect((await list(owner.id, { includeArchived: true })).alerts.map(row => row.id)).toEqual([
        alert.id,
      ]);

      await expect(
        caller.organizations.alerts.update({
          organizationId: organization.id,
          alertId: alert.id,
          definition: definition({ thresholdMicrodollars: 900_000_000 }),
          expectedConfigurationVersion: archived.configurationVersion,
        })
      ).rejects.toThrow(/archived/);
      await expect(
        caller.organizations.alerts.setEnabled({
          organizationId: organization.id,
          alertId: alert.id,
          enabled: true,
          expectedConfigurationVersion: archived.configurationVersion,
        })
      ).rejects.toThrow(/archived/);
    });

    it('is idempotent under retries', async () => {
      const alert = await create(owner.id);
      const caller = await createCallerForUser(owner.id);
      const input = { organizationId: organization.id, alertId: alert.id };

      const archived = await caller.organizations.alerts.archive(input);
      const retried = await caller.organizations.alerts.archive(input);

      expect(retried.configurationVersion).toBe(archived.configurationVersion);
      expect(
        (await auditMessages(organization.id)).filter(
          row => row.action === 'organization.alert.archive'
        )
      ).toHaveLength(1);
    });
  });

  describe('audit trail', () => {
    it('records lifecycle actions with counts and no recipient addresses', async () => {
      const alert = await create(owner.id, {
        definition: definition({ recipients: ['finance@example.com', 'ops@example.com'] }),
      });
      const caller = await createCallerForUser(owner.id);
      const updated = await caller.organizations.alerts.update({
        organizationId: organization.id,
        alertId: alert.id,
        definition: definition({ recipients: ['finance@example.com'] }),
        expectedConfigurationVersion: alert.configurationVersion,
      });
      const disabled = await caller.organizations.alerts.setEnabled({
        organizationId: organization.id,
        alertId: alert.id,
        enabled: false,
        expectedConfigurationVersion: updated.configurationVersion,
      });
      await caller.organizations.alerts.setEnabled({
        organizationId: organization.id,
        alertId: alert.id,
        enabled: true,
        expectedConfigurationVersion: disabled.configurationVersion,
      });
      await caller.organizations.alerts.archive({
        organizationId: organization.id,
        alertId: alert.id,
      });

      const rows = await auditMessages(organization.id);
      expect(rows.map(row => row.action)).toEqual([
        'organization.alert.create',
        'organization.alert.update',
        'organization.alert.disable',
        'organization.alert.enable',
        'organization.alert.archive',
      ]);
      for (const row of rows) {
        expect(row.message).toContain(alert.id);
        expect(row.message).toMatch(/recipient/);
        expect(row.message).not.toContain('@');
      }
      expect(rows[0].message).toContain('2 recipients');
      expect(rows[0].message).toContain('disclosure confirmed');
      expect(rows[1].message).toContain('2 recipients -> 1 recipient');
    });
  });
});
