import 'server-only';

import {
  kilo_pass_org_agreements,
  kilo_pass_org_notification_deliveries,
  kilo_pass_org_processing_runs,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import { sendKiloPassOrgBlockedEmail } from '@/lib/email';

const DELIVERY_BATCH_SIZE = 100;
const MAX_DELIVERY_ATTEMPTS = 3;

export async function dispatchOrganizationPassBlockedNotifications(
  database: typeof db = db
): Promise<{ examined: number; sent: number; failed: number }> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  const claimedIds = await database.transaction(async tx => {
    const candidates = await tx
      .select({ id: kilo_pass_org_notification_deliveries.id })
      .from(kilo_pass_org_notification_deliveries)
      .where(
        and(
          or(
            eq(kilo_pass_org_notification_deliveries.status, 'pending'),
            and(
              eq(kilo_pass_org_notification_deliveries.status, 'sending'),
              lt(kilo_pass_org_notification_deliveries.lease_expires_at, now.toISOString())
            )
          ),
          isNull(kilo_pass_org_notification_deliveries.sent_at),
          lt(kilo_pass_org_notification_deliveries.attempt_count, MAX_DELIVERY_ATTEMPTS)
        )
      )
      .limit(DELIVERY_BATCH_SIZE)
      .for('update', { skipLocked: true });
    const ids = candidates.map(candidate => candidate.id);
    if (ids.length) {
      await tx
        .update(kilo_pass_org_notification_deliveries)
        .set({
          status: 'sending',
          lease_expires_at: leaseExpiresAt,
          attempt_count: sql`${kilo_pass_org_notification_deliveries.attempt_count} + 1`,
        })
        .where(inArray(kilo_pass_org_notification_deliveries.id, ids));
    }
    return ids;
  });
  if (!claimedIds.length) return { examined: 0, sent: 0, failed: 0 };

  const deliveries = await database
    .select({
      deliveryId: kilo_pass_org_notification_deliveries.id,
      recipientUserId: kilo_pass_org_notification_deliveries.recipient_kilo_user_id,
      email: kilocode_users.google_user_email,
      organizationId: organizations.id,
      organizationName: organizations.name,
    })
    .from(kilo_pass_org_notification_deliveries)
    .innerJoin(
      kilo_pass_org_processing_runs,
      eq(kilo_pass_org_notification_deliveries.processing_run_id, kilo_pass_org_processing_runs.id)
    )
    .innerJoin(
      kilo_pass_org_agreements,
      eq(kilo_pass_org_processing_runs.agreement_id, kilo_pass_org_agreements.id)
    )
    .innerJoin(organizations, eq(kilo_pass_org_agreements.parent_organization_id, organizations.id))
    .innerJoin(
      kilocode_users,
      eq(kilo_pass_org_notification_deliveries.recipient_kilo_user_id, kilocode_users.id)
    )
    .innerJoin(
      organization_memberships,
      and(
        eq(organization_memberships.organization_id, organizations.id),
        eq(
          organization_memberships.kilo_user_id,
          kilo_pass_org_notification_deliveries.recipient_kilo_user_id
        )
      )
    )
    .where(
      and(
        inArray(kilo_pass_org_notification_deliveries.id, claimedIds),
        inArray(organization_memberships.role, ['owner', 'billing_manager'])
      )
    );

  let sent = 0;
  let failed = 0;
  const authorizedDeliveryIds = new Set(deliveries.map(delivery => delivery.deliveryId));
  const unauthorizedIds = claimedIds.filter(id => !authorizedDeliveryIds.has(id));
  if (unauthorizedIds.length) {
    await database
      .delete(kilo_pass_org_notification_deliveries)
      .where(inArray(kilo_pass_org_notification_deliveries.id, unauthorizedIds));
  }

  for (const candidate of deliveries) {
    try {
      const result = await sendKiloPassOrgBlockedEmail(candidate.email, {
        organizationId: candidate.organizationId,
        organizationName: candidate.organizationName,
      });
      if (!result.sent) {
        failed++;
        await resetClaimedDelivery(database, candidate.deliveryId, true);
        continue;
      }
      await database
        .update(kilo_pass_org_notification_deliveries)
        .set({
          status: 'sent',
          sent_at: new Date().toISOString(),
          lease_expires_at: null,
        })
        .where(
          and(
            eq(kilo_pass_org_notification_deliveries.id, candidate.deliveryId),
            eq(kilo_pass_org_notification_deliveries.status, 'sending')
          )
        );
      sent++;
    } catch (error) {
      failed++;
      await resetClaimedDelivery(database, candidate.deliveryId, false);
      captureException(error, {
        tags: { source: 'kilo-pass-org-blocked-notification' },
        extra: {
          deliveryId: candidate.deliveryId,
          organizationId: candidate.organizationId,
          recipientUserId: candidate.recipientUserId,
        },
      });
    }
  }

  return { examined: claimedIds.length, sent, failed };
}

async function resetClaimedDelivery(
  database: typeof db,
  deliveryId: string,
  permanentFailure: boolean
) {
  try {
    await database
      .update(kilo_pass_org_notification_deliveries)
      .set({
        status: permanentFailure ? 'failed' : 'pending',
        lease_expires_at: null,
      })
      .where(
        and(
          eq(kilo_pass_org_notification_deliveries.id, deliveryId),
          eq(kilo_pass_org_notification_deliveries.status, 'sending'),
          isNull(kilo_pass_org_notification_deliveries.sent_at)
        )
      );
  } catch (error) {
    captureException(error, {
      tags: { source: 'kilo-pass-org-blocked-notification', failure: 'claim-reset' },
      extra: { deliveryId },
    });
  }
}
