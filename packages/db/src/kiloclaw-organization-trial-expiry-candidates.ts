import { and, asc, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import type { WorkerDb } from './client';
import {
  kiloclaw_instances,
  kiloclaw_subscriptions,
  kilocode_users,
  organization_seats_purchases,
  organizations,
  type Organization,
  type OrganizationSeatsPurchase,
} from './schema';
import type { KiloClawPlan } from './schema-types';

export type OrganizationTrialExpiryCandidateRow = {
  id: string;
  user_id: string;
  instance_id: string | null;
  sandbox_id: string | null;
  instance_destroyed_at: string | null;
  instance_name: string | null;
  plan: KiloClawPlan;
  organization_id: string | null;
  organization_name: string;
  organization_created_at: string;
  organization_free_trial_end_at: string | null;
  organization_require_seats: boolean;
  organization_settings: Organization['settings'];
  latest_seat_purchase_status: OrganizationSeatsPurchase['subscription_status'] | null;
  hard_expiry_boundary: string;
  email: string;
};

export type OrganizationTrialExpiryCandidateRepository = Pick<WorkerDb, 'select'>;

export type ListOrganizationTrialExpiryEnforcementCandidatesOptions = {
  cutoffTime: string;
  cursorSubscriptionId?: string;
  cursorHardExpiryBoundary?: string;
  limit: number;
};

function organizationHardExpiryBoundaryExpression() {
  return sql<string>`coalesce(${organizations.free_trial_end_at}, ${organizations.created_at} + interval '14 days') + interval '3 days'`;
}

function latestOrganizationSeatPurchaseStatusExpression() {
  return sql<OrganizationSeatsPurchase['subscription_status'] | null>`(
    select ${organization_seats_purchases.subscription_status}
    from ${organization_seats_purchases}
    where ${organization_seats_purchases.organization_id} = ${organizations.id}
    order by ${organization_seats_purchases.created_at} desc
    limit 1
  )`;
}

function activeLiveOrganizationManagedRowFilter() {
  return and(
    eq(kiloclaw_subscriptions.status, 'active'),
    isNull(kiloclaw_subscriptions.transferred_to_subscription_id),
    isNull(kiloclaw_subscriptions.suspended_at),
    isNotNull(kiloclaw_subscriptions.instance_id),
    isNotNull(kiloclaw_instances.sandbox_id),
    isNull(kiloclaw_instances.destroyed_at),
    isNotNull(kiloclaw_instances.organization_id)
  );
}

function organizationTrialExpiryCursorFilter(
  cursorSubscriptionId: string | undefined,
  cursorHardExpiryBoundary: string | undefined
) {
  if (!cursorSubscriptionId || !cursorHardExpiryBoundary) {
    return undefined;
  }

  const hardExpiryBoundary = organizationHardExpiryBoundaryExpression();
  return or(
    gt(hardExpiryBoundary, cursorHardExpiryBoundary),
    and(
      eq(hardExpiryBoundary, cursorHardExpiryBoundary),
      gt(kiloclaw_subscriptions.id, cursorSubscriptionId)
    )
  );
}

function selectOrganizationTrialExpiryCandidateFields() {
  return {
    id: kiloclaw_subscriptions.id,
    user_id: kiloclaw_subscriptions.user_id,
    instance_id: kiloclaw_subscriptions.instance_id,
    sandbox_id: kiloclaw_instances.sandbox_id,
    instance_destroyed_at: kiloclaw_instances.destroyed_at,
    instance_name: kiloclaw_instances.name,
    plan: kiloclaw_subscriptions.plan,
    organization_id: kiloclaw_instances.organization_id,
    organization_name: organizations.name,
    organization_created_at: organizations.created_at,
    organization_free_trial_end_at: organizations.free_trial_end_at,
    organization_require_seats: organizations.require_seats,
    organization_settings: organizations.settings,
    latest_seat_purchase_status: latestOrganizationSeatPurchaseStatusExpression().as(
      'latest_seat_purchase_status'
    ),
    hard_expiry_boundary: organizationHardExpiryBoundaryExpression().as('hard_expiry_boundary'),
    email: kilocode_users.google_user_email,
  };
}

function selectOrganizationTrialExpiryCandidateQuery(
  database: OrganizationTrialExpiryCandidateRepository
) {
  return database
    .select(selectOrganizationTrialExpiryCandidateFields())
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .innerJoin(kiloclaw_instances, eq(kiloclaw_subscriptions.instance_id, kiloclaw_instances.id))
    .innerJoin(organizations, eq(kiloclaw_instances.organization_id, organizations.id));
}

export async function listOrganizationTrialExpiryEnforcementCandidates(
  database: OrganizationTrialExpiryCandidateRepository,
  options: ListOrganizationTrialExpiryEnforcementCandidatesOptions
): Promise<OrganizationTrialExpiryCandidateRow[]> {
  const hardExpiryBoundary = organizationHardExpiryBoundaryExpression();
  const cursorFilter = organizationTrialExpiryCursorFilter(
    options.cursorSubscriptionId,
    options.cursorHardExpiryBoundary
  );

  return await selectOrganizationTrialExpiryCandidateQuery(database)
    .where(
      and(
        activeLiveOrganizationManagedRowFilter(),
        lt(hardExpiryBoundary, options.cutoffTime),
        cursorFilter
      )
    )
    .orderBy(asc(hardExpiryBoundary), asc(kiloclaw_subscriptions.id))
    .limit(options.limit);
}

export async function listOrganizationTrialExpiryInventoryRows(
  database: OrganizationTrialExpiryCandidateRepository
): Promise<OrganizationTrialExpiryCandidateRow[]> {
  const hardExpiryBoundary = organizationHardExpiryBoundaryExpression();

  return await selectOrganizationTrialExpiryCandidateQuery(database)
    .where(activeLiveOrganizationManagedRowFilter())
    .orderBy(asc(hardExpiryBoundary), asc(kiloclaw_subscriptions.id));
}
