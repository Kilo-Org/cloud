import 'server-only';

import { organization_alerts } from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { cancelPendingDeliveriesForAlerts } from './alert-deliveries';

/**
 * Organization lifecycle effects on alerts. This lives apart from the alert
 * service so plan-change and deletion paths can apply it without importing the
 * service's organization lookups, which import those paths in turn.
 */

/**
 * Disables every enabled alert of an organization that is no longer entitled to
 * them and cancels delivery work already claimed. Configuration and recipients
 * are preserved, and a later upgrade deliberately does not re-enable anything:
 * resuming notifications is an explicit customer decision.
 */
export async function disableOrganizationAlertsForDowngrade(
  tx: DrizzleTransaction,
  organizationId: string
): Promise<void> {
  const disabled = await tx
    .update(organization_alerts)
    .set({
      status: 'disabled',
      configuration_version: sql`${organization_alerts.configuration_version} + 1`,
    })
    .where(
      and(
        eq(organization_alerts.organization_id, organizationId),
        eq(organization_alerts.status, 'enabled')
      )
    )
    .returning({ id: organization_alerts.id });

  await cancelPendingDeliveriesForAlerts(
    tx,
    disabled.map(alert => alert.id)
  );
}

/**
 * Removes recipient addresses from every one of an organization's alerts when the
 * organization is deleted, archived alerts included: deletion is a soft delete,
 * so the foreign-key cascade never fires and the disclosure has to be dropped
 * explicitly. Delivery rows hold only keyed recipient digests, so they need no
 * scrubbing. An archived alert keeps that terminal status, because `archived_at`
 * and `status` must agree; anything else is left unable to notify anyone.
 */
export async function removeOrganizationAlertRecipients(
  tx: DrizzleTransaction,
  organizationId: string
): Promise<void> {
  const scrubbed = await tx
    .update(organization_alerts)
    .set({
      status: sql`CASE WHEN ${organization_alerts.status} = 'archived' THEN 'archived' ELSE 'disabled' END`,
      configuration: sql`jsonb_set(${organization_alerts.configuration}, '{recipients}', '[]'::jsonb)`,
      configuration_version: sql`${organization_alerts.configuration_version} + 1`,
    })
    .where(eq(organization_alerts.organization_id, organizationId))
    .returning({ id: organization_alerts.id });

  await cancelPendingDeliveriesForAlerts(
    tx,
    scrubbed.map(alert => alert.id)
  );
}
