import { randomUUID } from 'node:crypto';

import { insertKiloClawSubscriptionChangeLog } from '@kilocode/db';
import { CURRENT_KILOCLAW_PRICE_VERSION } from '@kilocode/db/kiloclaw-pricing-catalog';
import {
  credit_transactions,
  kilocode_users,
  kiloclaw_instances,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import {
  KiloClawPaymentSource,
  KiloClawPlan,
  KiloClawProvider,
  KiloClawSubscriptionChangeAction,
  KiloClawSubscriptionChangeActorType,
  KiloClawSubscriptionStatus,
} from '@kilocode/db/schema-types';
import { and, eq, inArray, isNull, like, sql } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import type { SeedResult } from '../index';

const FAKE_SANDBOX_PREFIX = 'ki_fake_';
const DEFAULT_INSTANCE_NAME = 'Fake local KiloClaw';

export const usage = '<user-id> [options]';

function printUsage(): void {
  console.log('Usage: pnpm dev:seed kiloclaw:fake-instance <user-id> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --plan=standard|trial|commit   Subscription plan to create (default: standard)');
  console.log('  --days=<number>                Days until period/trial end');
  console.log('  --name=<name>                  Instance name (default: Fake local KiloClaw)');
  console.log('');
  console.log(
    'The script retires prior fake instances for the same user (sandbox_id starts with ki_fake_)'
  );
  console.log('and refuses to run if the user already has a non-fake active personal instance.');
}

function parsePlan(value: string): KiloClawPlan {
  switch (value) {
    case KiloClawPlan.Trial:
      return KiloClawPlan.Trial;
    case KiloClawPlan.Standard:
      return KiloClawPlan.Standard;
    case KiloClawPlan.Commit:
      return KiloClawPlan.Commit;
    default:
      throw new Error(`Unsupported --plan value: ${value}`);
  }
}

function defaultDaysForPlan(plan: KiloClawPlan): number {
  switch (plan) {
    case KiloClawPlan.Trial:
      return 7;
    case KiloClawPlan.Standard:
      return 30;
    case KiloClawPlan.Commit:
      return 180;
  }
}

function parsePositiveInteger(value: string, flagName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(args: string[]): {
  userId: string;
  plan: KiloClawPlan;
  days: number;
  name: string;
} {
  const userId = args[0]?.trim();
  if (!userId || userId === '--help' || userId === '-h') {
    printUsage();
    throw new Error('user-id is required');
  }

  let plan = KiloClawPlan.Standard;
  let days: number | null = null;
  let name = DEFAULT_INSTANCE_NAME;

  for (const arg of args.slice(1)) {
    if (arg === '--help' || arg === '-h') {
      printUsage();
      throw new Error('help requested');
    }

    if (arg.startsWith('--plan=')) {
      plan = parsePlan(arg.slice('--plan='.length).trim());
      continue;
    }

    if (arg.startsWith('--days=')) {
      days = parsePositiveInteger(arg.slice('--days='.length).trim(), '--days');
      continue;
    }

    if (arg.startsWith('--name=')) {
      const parsedName = arg.slice('--name='.length).trim();
      if (!parsedName) {
        throw new Error('--name must not be empty');
      }
      name = parsedName;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    userId,
    plan,
    days: days ?? defaultDaysForPlan(plan),
    name,
  };
}

function addDays(date: Date, days: number): string {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString();
}

function sandboxIdForInstance(instanceId: string): string {
  return `${FAKE_SANDBOX_PREFIX}${instanceId.replaceAll('-', '')}`;
}

function statusForPlan(plan: KiloClawPlan): KiloClawSubscriptionStatus {
  return plan === KiloClawPlan.Trial
    ? KiloClawSubscriptionStatus.Trialing
    : KiloClawSubscriptionStatus.Active;
}

function paymentSourceForPlan(plan: KiloClawPlan): KiloClawPaymentSource | null {
  return plan === KiloClawPlan.Trial ? null : KiloClawPaymentSource.Credits;
}

function costMicrodollarsForPlan(plan: KiloClawPlan): number | null {
  switch (plan) {
    case KiloClawPlan.Trial:
      return null;
    case KiloClawPlan.Standard:
      return 9_000_000;
    case KiloClawPlan.Commit:
      return 48_000_000;
  }
}

function periodKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function deductionCategoryForPlan(plan: KiloClawPlan, instanceId: string, date: Date): string {
  const prefix =
    plan === KiloClawPlan.Commit ? 'kiloclaw-subscription-commit' : 'kiloclaw-subscription';
  return `${prefix}:${instanceId}:${periodKey(date)}`;
}

async function assertUserExists(userId: string): Promise<void> {
  const db = getSeedDb();
  const [user] = await db
    .select({ id: kilocode_users.id, email: kilocode_users.google_user_email })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);

  if (!user) {
    throw new Error(`User ${userId} was not found. Sign in locally first or seed/create the user.`);
  }
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const options = parseArgs(args);
  const db = getSeedDb();

  await assertUserExists(options.userId);

  const now = new Date();
  const nowIso = now.toISOString();
  const periodEndIso = addDays(now, options.days);
  const instanceId = randomUUID();
  const sandboxId = sandboxIdForInstance(instanceId);

  const result = await db.transaction(async tx => {
    const priorFakeInstances = await tx
      .select({ id: kiloclaw_instances.id })
      .from(kiloclaw_instances)
      .where(
        and(
          eq(kiloclaw_instances.user_id, options.userId),
          isNull(kiloclaw_instances.organization_id),
          isNull(kiloclaw_instances.destroyed_at),
          like(kiloclaw_instances.sandbox_id, `${FAKE_SANDBOX_PREFIX}%`)
        )
      );
    const priorFakeInstanceIds = priorFakeInstances.map(instance => instance.id);

    if (priorFakeInstanceIds.length > 0) {
      const priorFakeSubscriptions = await tx
        .select()
        .from(kiloclaw_subscriptions)
        .where(inArray(kiloclaw_subscriptions.instance_id, priorFakeInstanceIds));
      const priorFakeSubscriptionIds = priorFakeSubscriptions.map(subscription => subscription.id);

      if (priorFakeSubscriptionIds.length > 0) {
        const retiredSubscriptions = await tx
          .update(kiloclaw_subscriptions)
          .set({
            status: KiloClawSubscriptionStatus.Canceled,
            cancel_at_period_end: false,
            pending_conversion: false,
          })
          .where(inArray(kiloclaw_subscriptions.id, priorFakeSubscriptionIds))
          .returning();

        for (const retiredSubscription of retiredSubscriptions) {
          const priorSubscription = priorFakeSubscriptions.find(
            subscription => subscription.id === retiredSubscription.id
          );
          await insertKiloClawSubscriptionChangeLog(tx, {
            subscriptionId: retiredSubscription.id,
            actor: {
              actorType: KiloClawSubscriptionChangeActorType.System,
              actorId: 'dev-seed:kiloclaw/fake-instance',
            },
            action: KiloClawSubscriptionChangeAction.Canceled,
            reason: 'dev_seed:replace_fake_instance',
            before: priorSubscription ?? null,
            after: retiredSubscription,
          });
        }
      }

      await tx
        .update(kiloclaw_instances)
        .set({ destroyed_at: nowIso })
        .where(
          and(
            inArray(kiloclaw_instances.id, priorFakeInstanceIds),
            isNull(kiloclaw_instances.destroyed_at)
          )
        );
    }

    const activePersonalInstances = await tx
      .select({ id: kiloclaw_instances.id, sandboxId: kiloclaw_instances.sandbox_id })
      .from(kiloclaw_instances)
      .where(
        and(
          eq(kiloclaw_instances.user_id, options.userId),
          isNull(kiloclaw_instances.organization_id),
          isNull(kiloclaw_instances.destroyed_at)
        )
      );

    if (activePersonalInstances.length > 0) {
      const instanceList = activePersonalInstances
        .map(instance => `${instance.id} (${instance.sandboxId})`)
        .join(', ');
      throw new Error(
        `User ${options.userId} already has active personal KiloClaw instance(s): ${instanceList}`
      );
    }

    const [instance] = await tx
      .insert(kiloclaw_instances)
      .values({
        id: instanceId,
        user_id: options.userId,
        sandbox_id: sandboxId,
        provider: KiloClawProvider.DockerLocal,
        organization_id: null,
        name: options.name,
        inbound_email_enabled: true,
        inactive_trial_stopped_at: null,
        created_at: nowIso,
        destroyed_at: null,
        tracked_image_tag: 'fake-local-instance',
      })
      .returning();

    const costMicrodollars = costMicrodollarsForPlan(options.plan);
    if (costMicrodollars !== null) {
      const [user] = await tx
        .select({
          microdollarsUsed: kilocode_users.microdollars_used,
          totalMicrodollarsAcquired: kilocode_users.total_microdollars_acquired,
        })
        .from(kilocode_users)
        .where(eq(kilocode_users.id, options.userId))
        .limit(1);

      if (!user) {
        throw new Error(`User ${options.userId} was not found. Sign in locally first.`);
      }

      const balanceMicrodollars = user.totalMicrodollarsAcquired - user.microdollarsUsed;
      const creditGrantMicrodollars = Math.max(costMicrodollars - balanceMicrodollars, 0);

      if (creditGrantMicrodollars > 0) {
        await tx.insert(credit_transactions).values({
          id: randomUUID(),
          kilo_user_id: options.userId,
          amount_microdollars: creditGrantMicrodollars,
          is_free: true,
          description: `Dev seed credits for KiloClaw ${options.plan} enrollment`,
          credit_category: `dev-seed:kiloclaw-fake-instance-credit:${instance.id}`,
          check_category_uniqueness: true,
          original_baseline_microdollars_used: user.microdollarsUsed,
          created_at: nowIso,
        });

        await tx
          .update(kilocode_users)
          .set({
            total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${creditGrantMicrodollars}`,
          })
          .where(eq(kilocode_users.id, options.userId));
      }

      await tx.insert(credit_transactions).values({
        id: randomUUID(),
        kilo_user_id: options.userId,
        amount_microdollars: -costMicrodollars,
        is_free: false,
        description: `Dev seed KiloClaw ${options.plan} enrollment`,
        credit_category: deductionCategoryForPlan(options.plan, instance.id, now),
        check_category_uniqueness: true,
        original_baseline_microdollars_used: user.microdollarsUsed,
        created_at: nowIso,
      });

      await tx
        .update(kilocode_users)
        .set({
          microdollars_used: sql`${kilocode_users.microdollars_used} + ${costMicrodollars}`,
        })
        .where(eq(kilocode_users.id, options.userId));
    }

    const [subscription] = await tx
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: options.userId,
        instance_id: instance.id,
        kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
        payment_source: paymentSourceForPlan(options.plan),
        plan: options.plan,
        status: statusForPlan(options.plan),
        cancel_at_period_end: false,
        pending_conversion: false,
        trial_started_at: options.plan === KiloClawPlan.Trial ? nowIso : null,
        trial_ends_at: options.plan === KiloClawPlan.Trial ? periodEndIso : null,
        current_period_start: options.plan === KiloClawPlan.Trial ? null : nowIso,
        current_period_end: options.plan === KiloClawPlan.Trial ? null : periodEndIso,
        credit_renewal_at: options.plan === KiloClawPlan.Trial ? null : periodEndIso,
        commit_ends_at: options.plan === KiloClawPlan.Commit ? periodEndIso : null,
      })
      .returning();

    await insertKiloClawSubscriptionChangeLog(tx, {
      subscriptionId: subscription.id,
      actor: {
        actorType: KiloClawSubscriptionChangeActorType.System,
        actorId: 'dev-seed:kiloclaw/fake-instance',
      },
      action: KiloClawSubscriptionChangeAction.Created,
      reason: 'dev_seed:fake_instance',
      before: null,
      after: subscription,
    });

    return { instance, subscription, retiredPriorFakeInstances: priorFakeInstanceIds.length };
  });

  console.log('');
  console.log('Note: this is DB-only. No Durable Object, container, or provider resource exists.');

  return {
    userId: options.userId,
    instanceId: result.instance.id,
    sandboxId: result.instance.sandbox_id,
    subscriptionId: result.subscription.id,
    plan: result.subscription.plan,
    status: result.subscription.status,
    periodEnd: result.subscription.current_period_end ?? result.subscription.trial_ends_at,
    retiredPriorFakeInstances: result.retiredPriorFakeInstances,
  };
}
