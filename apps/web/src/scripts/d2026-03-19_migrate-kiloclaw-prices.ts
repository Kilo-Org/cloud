import '@/lib/load-env';

import { closeAllDrizzleConnections, db } from '@/lib/drizzle';
import { client as stripe } from '@/lib/stripe-client';
import { kiloclaw_subscriptions } from '@kilocode/db/schema';
import { and, inArray, isNotNull } from 'drizzle-orm';
import { getStripePriceIdForClawPlan } from '@/lib/kiloclaw/stripe-price-ids.server';
import {
  LIVE_KILOCLAW_MIGRATION_STATUSES,
  buildUpdatedSchedulePhases,
  getExpectedSchedulePriceIds,
  getSchedulePhasePriceIds,
} from '@/lib/kiloclaw/price-migration';

const isDryRun = !process.argv.includes('--run-actually');
const SWITCHABLE_PLANS = ['commit', 'standard'] as const;

type LiveSubscriptionRow = {
  userId: string;
  plan: 'commit' | 'standard';
  status: (typeof LIVE_KILOCLAW_MIGRATION_STATUSES)[number];
  stripeSubscriptionId: string;
  stripeScheduleId: string | null;
  scheduledPlan: 'commit' | 'standard' | null;
};

function parsePriceOverrides() {
  const standardPriceArg = process.argv.find(arg => arg.startsWith('--standard-price-id='));
  const commitPriceArg = process.argv.find(arg => arg.startsWith('--commit-price-id='));

  return {
    standard:
      standardPriceArg?.split('=').slice(1).join('=') || getStripePriceIdForClawPlan('standard'),
    commit: commitPriceArg?.split('=').slice(1).join('=') || getStripePriceIdForClawPlan('commit'),
  };
}

async function getLiveSubscriptions(): Promise<LiveSubscriptionRow[]> {
  return db
    .select({
      userId: kiloclaw_subscriptions.user_id,
      plan: kiloclaw_subscriptions.plan,
      status: kiloclaw_subscriptions.status,
      stripeSubscriptionId: kiloclaw_subscriptions.stripe_subscription_id,
      stripeScheduleId: kiloclaw_subscriptions.stripe_schedule_id,
      scheduledPlan: kiloclaw_subscriptions.scheduled_plan,
    })
    .from(kiloclaw_subscriptions)
    .where(
      and(
        inArray(kiloclaw_subscriptions.status, [...LIVE_KILOCLAW_MIGRATION_STATUSES]),
        inArray(kiloclaw_subscriptions.plan, [...SWITCHABLE_PLANS]),
        isNotNull(kiloclaw_subscriptions.stripe_subscription_id)
      )
    ) as Promise<LiveSubscriptionRow[]>;
}

async function run() {
  const newPriceIds = parsePriceOverrides();
  const subscriptions = await getLiveSubscriptions();

  console.log(isDryRun ? 'DRY RUN — no Stripe subscriptions will be updated\n' : 'LIVE RUN\n');
  console.log(`Using standard price: ${newPriceIds.standard}`);
  console.log(`Using commit price: ${newPriceIds.commit}`);
  console.log(`Found ${subscriptions.length} active KiloClaw subscriptions\n`);

  if (subscriptions.length === 0) {
    console.log('Nothing to migrate.');
    return;
  }

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const subscription of subscriptions) {
    const targetPriceId = newPriceIds[subscription.plan];

    try {
      let didUpdateSubscription = false;
      let didUpdateSchedule = false;
      const stripeSubscription = await stripe.subscriptions.retrieve(
        subscription.stripeSubscriptionId
      );
      const item = stripeSubscription.items.data[0];
      const currentPriceId = item?.price?.id ?? null;

      if (!item) {
        failed++;
        console.log(
          `[ERROR] user=${subscription.userId} sub=${subscription.stripeSubscriptionId} status=${subscription.status} plan=${subscription.plan} reason=missing_subscription_item`
        );
        continue;
      }

      const scheduleLogParts: string[] = [];
      if (subscription.stripeScheduleId && subscription.scheduledPlan) {
        const schedule = await stripe.subscriptionSchedules.retrieve(subscription.stripeScheduleId);
        const currentSchedulePriceIds = getSchedulePhasePriceIds(schedule);
        const targetSchedulePriceIds = getExpectedSchedulePriceIds({
          currentPlan: subscription.plan,
          scheduledPlan: subscription.scheduledPlan,
          newPriceIds,
        });

        scheduleLogParts.push(
          `schedule=${schedule.id}`,
          `schedule_status=${schedule.status}`,
          `schedule_old_prices=${currentSchedulePriceIds.join('|')}`,
          `schedule_new_prices=${targetSchedulePriceIds.join('|')}`
        );

        if (
          schedule.status !== 'released' &&
          schedule.status !== 'canceled' &&
          schedule.status !== 'completed'
        ) {
          if (
            currentSchedulePriceIds[0] !== targetSchedulePriceIds[0] ||
            currentSchedulePriceIds[1] !== targetSchedulePriceIds[1]
          ) {
            if (!isDryRun) {
              await stripe.subscriptionSchedules.update(schedule.id, {
                end_behavior: schedule.end_behavior,
                phases: buildUpdatedSchedulePhases({
                  schedule,
                  currentPlan: subscription.plan,
                  scheduledPlan: subscription.scheduledPlan,
                  newPriceIds,
                }),
              });
            }
            didUpdateSchedule = true;
          }
        } else {
          scheduleLogParts.push('schedule_result=skipped_terminal_schedule');
        }
      }

      if (currentPriceId !== targetPriceId) {
        if (!isDryRun) {
          await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
            items: [{ id: item.id, price: targetPriceId }],
            proration_behavior: 'none',
          });
        }
        didUpdateSubscription = true;
      }

      if (!didUpdateSubscription && !didUpdateSchedule) {
        skipped++;
        console.log(
          `[SKIP] user=${subscription.userId} sub=${subscription.stripeSubscriptionId} status=${subscription.status} plan=${subscription.plan} old_price=${currentPriceId} new_price=${targetPriceId}${scheduleLogParts.length > 0 ? ` ${scheduleLogParts.join(' ')}` : ''} reason=already_on_target_price`
        );
        continue;
      }

      migrated++;
      console.log(
        `[${isDryRun ? 'DRY RUN' : 'UPDATED'}] user=${subscription.userId} sub=${subscription.stripeSubscriptionId} status=${subscription.status} plan=${subscription.plan} old_price=${currentPriceId} new_price=${targetPriceId} subscription_result=${didUpdateSubscription ? 'updated' : 'unchanged'} schedule_result=${didUpdateSchedule ? 'updated' : 'unchanged'}${scheduleLogParts.length > 0 ? ` ${scheduleLogParts.join(' ')}` : ''}`
      );
    } catch (error) {
      failed++;
      console.log(
        `[ERROR] user=${subscription.userId} sub=${subscription.stripeSubscriptionId} status=${subscription.status} plan=${subscription.plan} new_price=${targetPriceId} error=${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  console.log(
    `\nSummary: processed=${subscriptions.length} migrated=${migrated} skipped=${skipped} failed=${failed}`
  );
}

void run()
  .then(async () => {
    await closeAllDrizzleConnections();
  })
  .catch(async error => {
    console.error('Script failed:', error);
    await closeAllDrizzleConnections();
    process.exit(1);
  });
