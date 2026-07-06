import { jest } from '@jest/globals';
import { cost_insight_events, cost_insight_owner_states } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import {
  hasCurrentCostInsightAccess,
  listCostInsightNotificationRecipientUserIds,
} from '@/lib/cost-insights/repository';
import { addUserToOrganization, createOrganization } from '@/lib/organizations/organizations';
import type { createCallerForUser as CreateCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';

jest.mock('@/lib/cost-insights/posthog-tracking', () => ({
  trackCostInsightsAlertAction: jest.fn(),
  trackCostInsightsSettingsSaved: jest.fn(),
  trackCostInsightsSuggestionAction: jest.fn(),
  trackCostInsightsUiInteraction: jest.fn(),
}));

const trackingMock: {
  trackCostInsightsAlertAction: jest.Mock;
  trackCostInsightsSuggestionAction: jest.Mock;
  trackCostInsightsUiInteraction: jest.Mock;
} = jest.requireMock('@/lib/cost-insights/posthog-tracking');

let createCallerForUser: typeof CreateCallerForUser;

beforeAll(async () => {
  ({ createCallerForUser } = await import('@/routers/test-utils'));
});

describe('Organization Cost Insights tracking', () => {
  beforeEach(() => {
    trackingMock.trackCostInsightsAlertAction.mockClear();
    trackingMock.trackCostInsightsSuggestionAction.mockClear();
    trackingMock.trackCostInsightsUiInteraction.mockClear();
  });

  it('attributes UI interactions to the acting admin organization owner', async () => {
    const owner = await insertTestUser({ is_admin: true });
    const organization = await createOrganization('Cost Insights Tracking Org', owner.id);
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.organizations.costInsights.trackUiInteraction({
        organizationId: organization.id,
        interaction: 'activity_filter_selected',
        filter: 'alerts',
      })
    ).resolves.toEqual({ success: true });
    expect(trackingMock.trackCostInsightsUiInteraction).toHaveBeenCalledWith(
      {
        distinctId: owner.id,
        userId: owner.id,
        ownerType: 'organization',
        organizationId: organization.id,
        authorizedRole: 'owner',
      },
      {
        organizationId: organization.id,
        interaction: 'activity_filter_selected',
        filter: 'alerts',
      }
    );
  });

  it('allows admin billing managers to track suggestion CTA engagement', async () => {
    const owner = await insertTestUser();
    const billingManager = await insertTestUser({ is_admin: true });
    const organization = await createOrganization('Cost Insights Billing Org', owner.id);
    await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');
    const caller = await createCallerForUser(billingManager.id);

    await expect(
      caller.organizations.costInsights.trackSuggestionCta({
        organizationId: organization.id,
        suggestionKind: 'kilo_pass',
      })
    ).resolves.toEqual({ success: true });
    expect(trackingMock.trackCostInsightsSuggestionAction).toHaveBeenCalledWith({
      distinctId: billingManager.id,
      userId: billingManager.id,
      ownerType: 'organization',
      organizationId: organization.id,
      authorizedRole: 'billing_manager',
      action: 'open_cta',
      suggestionKind: 'kilo_pass',
      phase: 'clicked',
    });
  });

  it('acknowledges only the displayed organization alert event', async () => {
    const owner = await insertTestUser({ is_admin: true });
    const organization = await createOrganization('Cost Insights Review Org', owner.id);
    const [alertEvent] = await db
      .insert(cost_insight_events)
      .values({
        owned_by_organization_id: organization.id,
        event_type: 'anomaly_alert',
        alert_kind: 'anomaly',
        title: 'Spend Anomaly Alert',
        description: 'Usage-based spend is high.',
      })
      .returning({ id: cost_insight_events.id });
    if (!alertEvent) throw new Error('Cost Insights alert fixture insert failed.');
    await db.insert(cost_insight_owner_states).values({
      owned_by_organization_id: organization.id,
      active_anomaly_event_id: alertEvent.id,
      active_anomaly_hour_start: '2026-06-25T19:00:00.000Z',
    });
    const caller = await createCallerForUser(owner.id);

    await caller.organizations.costInsights.acknowledgeAlert({
      organizationId: organization.id,
      alertKind: 'anomaly',
      eventId: crypto.randomUUID(),
    });
    let [state] = await db
      .select({ reviewedAt: cost_insight_owner_states.active_anomaly_reviewed_at })
      .from(cost_insight_owner_states)
      .where(eq(cost_insight_owner_states.owned_by_organization_id, organization.id));
    expect(state?.reviewedAt).toBeNull();
    expect(trackingMock.trackCostInsightsAlertAction).not.toHaveBeenCalled();

    await caller.organizations.costInsights.acknowledgeAlert({
      organizationId: organization.id,
      alertKind: 'anomaly',
      eventId: alertEvent.id,
    });
    [state] = await db
      .select({ reviewedAt: cost_insight_owner_states.active_anomaly_reviewed_at })
      .from(cost_insight_owner_states)
      .where(eq(cost_insight_owner_states.owned_by_organization_id, organization.id));
    expect(state?.reviewedAt).not.toBeNull();
    expect(trackingMock.trackCostInsightsAlertAction).toHaveBeenCalledTimes(1);
  });

  it('limits notification access to admin owners and billing managers', async () => {
    const owner = await insertTestUser();
    const adminBillingManager = await insertTestUser({ is_admin: true });
    const nonAdminBillingManager = await insertTestUser();
    const adminMember = await insertTestUser({ is_admin: true });
    const adminPersonalOwner = await insertTestUser({ is_admin: true });
    const organization = await createOrganization('Cost Insights Notification Org', owner.id);
    await addUserToOrganization(organization.id, adminBillingManager.id, 'billing_manager');
    await addUserToOrganization(organization.id, nonAdminBillingManager.id, 'billing_manager');
    await addUserToOrganization(organization.id, adminMember.id, 'member');

    await expect(
      listCostInsightNotificationRecipientUserIds(db, {
        type: 'organization',
        id: organization.id,
      })
    ).resolves.toEqual([adminBillingManager.id]);
    await expect(
      hasCurrentCostInsightAccess(
        db,
        { type: 'organization', id: organization.id },
        adminBillingManager.id
      )
    ).resolves.toBe(true);
    await expect(
      hasCurrentCostInsightAccess(db, { type: 'organization', id: organization.id }, owner.id)
    ).resolves.toBe(false);
    await expect(
      hasCurrentCostInsightAccess(db, { type: 'organization', id: organization.id }, adminMember.id)
    ).resolves.toBe(false);
    await expect(
      listCostInsightNotificationRecipientUserIds(db, { type: 'user', id: owner.id })
    ).resolves.toEqual([]);
    await expect(
      listCostInsightNotificationRecipientUserIds(db, {
        type: 'user',
        id: adminPersonalOwner.id,
      })
    ).resolves.toEqual([adminPersonalOwner.id]);
  });

  it('rejects every Cost Insights procedure for non-admin organization owners', async () => {
    const owner = await insertTestUser();
    const organization = await createOrganization('Cost Insights Non-Admin Org', owner.id);
    const caller = await createCallerForUser(owner.id);
    const organizationId = organization.id;
    const calls = [
      () =>
        caller.organizations.costInsights.trackUiInteraction({
          organizationId,
          interaction: 'activity_viewed' as const,
        }),
      () =>
        caller.organizations.costInsights.trackSuggestionCta({
          organizationId,
          suggestionKind: 'kilo_pass' as const,
        }),
      () => caller.organizations.costInsights.getDashboard({ organizationId }),
      () => caller.organizations.costInsights.getSettings({ organizationId }),
      () =>
        caller.organizations.costInsights.listEvents({
          organizationId,
          filter: 'all',
          page: 1,
          pageSize: 10,
        }),
      () => caller.organizations.costInsights.getAttentionState({ organizationId }),
      () =>
        caller.organizations.costInsights.updateSettings({
          organizationId,
          spendAlertsEnabled: false,
          anomalyAlertsEnabled: true,
          costSuggestionsEnabled: true,
          spendThresholdUsd: null,
          spend7DayThresholdUsd: null,
          spend30DayThresholdUsd: null,
        }),
      () =>
        caller.organizations.costInsights.acknowledgeAlert({
          organizationId,
          alertKind: 'anomaly',
          eventId: crypto.randomUUID(),
        }),
      () =>
        caller.organizations.costInsights.dismissSuggestion({
          organizationId,
          suggestionId: crypto.randomUUID(),
        }),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Admin access required',
      });
    }
    expect(trackingMock.trackCostInsightsUiInteraction).not.toHaveBeenCalled();
    expect(trackingMock.trackCostInsightsSuggestionAction).not.toHaveBeenCalled();
  });
});
