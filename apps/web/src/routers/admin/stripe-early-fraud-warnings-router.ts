import { desc, eq, sql } from 'drizzle-orm';
import * as z from 'zod';

import { db } from '@/lib/drizzle';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  kilocode_users,
  organizations,
  stripe_early_fraud_warning_cases,
} from '@kilocode/db/schema';

const EarlyFraudWarningListInputSchema = z.object({
  page: z.number().int().positive().default(1),
  limit: z.number().int().min(1).max(100).default(25),
});

function normalizeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const adminStripeEarlyFraudWarningsRouter = createTRPCRouter({
  list: adminProcedure.input(EarlyFraudWarningListInputSchema).query(async ({ input }) => {
    const offset = (input.page - 1) * input.limit;
    const rows = await db
      .select({
        id: stripe_early_fraud_warning_cases.id,
        stripeEarlyFraudWarningId: stripe_early_fraud_warning_cases.stripe_early_fraud_warning_id,
        stripeEventId: stripe_early_fraud_warning_cases.stripe_event_id,
        stripeChargeId: stripe_early_fraud_warning_cases.stripe_charge_id,
        stripePaymentIntentId: stripe_early_fraud_warning_cases.stripe_payment_intent_id,
        stripeCustomerId: stripe_early_fraud_warning_cases.stripe_customer_id,
        amountMinorUnits: stripe_early_fraud_warning_cases.amount_minor_units,
        currency: stripe_early_fraud_warning_cases.currency,
        ownerClassification: stripe_early_fraud_warning_cases.owner_classification,
        status: stripe_early_fraud_warning_cases.status,
        reason: stripe_early_fraud_warning_cases.reason,
        failureContext: stripe_early_fraud_warning_cases.failure_context,
        warningCreatedAt: stripe_early_fraud_warning_cases.warning_created_at,
        reviewRequiredAt: stripe_early_fraud_warning_cases.review_required_at,
        createdAt: stripe_early_fraud_warning_cases.created_at,
        userId: kilocode_users.id,
        userEmail: kilocode_users.google_user_email,
        userName: kilocode_users.google_user_name,
        organizationId: organizations.id,
        organizationName: organizations.name,
        total: sql<number>`count(*) OVER()::int`.as('total'),
      })
      .from(stripe_early_fraud_warning_cases)
      .leftJoin(
        kilocode_users,
        eq(kilocode_users.id, stripe_early_fraud_warning_cases.kilo_user_id)
      )
      .leftJoin(
        organizations,
        eq(organizations.id, stripe_early_fraud_warning_cases.organization_id)
      )
      .orderBy(
        sql`${stripe_early_fraud_warning_cases.warning_created_at} DESC NULLS LAST`,
        desc(stripe_early_fraud_warning_cases.created_at),
        desc(stripe_early_fraud_warning_cases.id)
      )
      .limit(input.limit)
      .offset(offset);

    const total = rows[0]?.total ?? 0;
    return {
      rows: rows.map(row => ({
        id: row.id,
        stripeEarlyFraudWarningId: row.stripeEarlyFraudWarningId,
        stripeEventId: row.stripeEventId,
        stripeChargeId: row.stripeChargeId,
        stripePaymentIntentId: row.stripePaymentIntentId,
        stripeCustomerId: row.stripeCustomerId,
        amountMinorUnits: row.amountMinorUnits,
        currency: row.currency,
        ownerClassification: row.ownerClassification,
        status: row.status,
        reason: row.reason,
        failureContext: row.failureContext,
        warningCreatedAt: normalizeTimestamp(row.warningCreatedAt),
        reviewRequiredAt: normalizeTimestamp(row.reviewRequiredAt),
        createdAt: normalizeTimestamp(row.createdAt),
        user: row.userId
          ? {
              id: row.userId,
              email: row.userEmail,
              name: row.userName,
            }
          : null,
        organization: row.organizationId
          ? {
              id: row.organizationId,
              name: row.organizationName,
            }
          : null,
      })),
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        totalPages: Math.ceil(total / input.limit),
      },
    };
  }),
});
