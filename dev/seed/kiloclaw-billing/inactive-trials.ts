import {
  kilocode_users,
  kiloclaw_admin_audit_logs,
  kiloclaw_email_log,
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
  type KiloClawInstance,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';

type SeedUser = typeof kilocode_users.$inferInsert;
type SeedInstance = typeof kiloclaw_instances.$inferInsert;
type SeedSubscription = typeof kiloclaw_subscriptions.$inferInsert;

type ProvisionResponse = {
  instanceId: string;
  sandboxId: string;
};

const SEED_SCOPE = 'kiloclaw-billing/inactive-trials';
const ELIGIBLE_USER_ID = 'seed-kiloclaw-billing-inactive-eligible';
const RECENT_USER_ID = 'seed-kiloclaw-billing-inactive-recent';
const MARKED_USER_ID = 'seed-kiloclaw-billing-inactive-marked';
const ELIGIBLE_INSTANCE_ID = '89ef7408-11bf-4cc6-b5fc-10e20e85c8e5';
const ELIGIBLE_SUBSCRIPTION_ID = '91067cf1-58db-4425-b0d4-aa750f73060b';
const MARKED_INSTANCE_ID = '7e6dfbd9-fb9d-4e1b-b18d-e4513cc83f40';
const MARKED_SUBSCRIPTION_ID = 'c90dc5ea-bd1e-442e-a16c-5f3d0d6143dd';
const RECENT_INSTANCE_ID = '7bfef6d2-5250-4c73-a470-8bfd21cb9455';
const RECENT_SUBSCRIPTION_ID = '3a2fbd7f-5d44-4fd4-8a5f-0e6d59eaa3f2';

const seedUsers = [
  {
    id: ELIGIBLE_USER_ID,
    google_user_email: 'seed-kiloclaw-billing-inactive-eligible@example.com',
    google_user_name: 'Seed KiloClaw Billing Eligible',
    google_user_image_url: 'https://example.com/seed-kiloclaw-billing-eligible.png',
    stripe_customer_id: 'cus_seed_kiloclaw_billing_eligible',
  },
  {
    id: RECENT_USER_ID,
    google_user_email: 'seed-kiloclaw-billing-inactive-recent@example.com',
    google_user_name: 'Seed KiloClaw Billing Recent',
    google_user_image_url: 'https://example.com/seed-kiloclaw-billing-recent.png',
    stripe_customer_id: 'cus_seed_kiloclaw_billing_recent',
  },
  {
    id: MARKED_USER_ID,
    google_user_email: 'seed-kiloclaw-billing-inactive-marked@example.com',
    google_user_name: 'Seed KiloClaw Billing Marked',
    google_user_image_url: 'https://example.com/seed-kiloclaw-billing-marked.png',
    stripe_customer_id: 'cus_seed_kiloclaw_billing_marked',
  },
] satisfies SeedUser[];

function isoFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function sandboxIdForInstance(instanceId: string): string {
  return `ki_${instanceId.replaceAll('-', '')}`;
}

function parseProvisionResponse(payload: unknown): ProvisionResponse {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Provision response was not an object');
  }

  const maybeInstanceId = Reflect.get(payload, 'instanceId');
  const maybeSandboxId = Reflect.get(payload, 'sandboxId');

  if (typeof maybeInstanceId !== 'string' || maybeInstanceId.length === 0) {
    throw new Error('Provision response did not include a valid instanceId');
  }

  if (typeof maybeSandboxId !== 'string' || maybeSandboxId.length === 0) {
    throw new Error('Provision response did not include a valid sandboxId');
  }

  return {
    instanceId: maybeInstanceId,
    sandboxId: maybeSandboxId,
  };
}

function requireEnv(name: 'KILOCLAW_API_URL' | 'KILOCLAW_INTERNAL_API_SECRET'): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required to seed ${SEED_SCOPE}`);
  }
  return value;
}

async function destroySeedInstancesBestEffort(): Promise<void> {
  const db = getSeedDb();
  const activeInstances = await db
    .select({
      userId: kiloclaw_instances.user_id,
      instanceId: kiloclaw_instances.id,
    })
    .from(kiloclaw_instances)
    .where(
      and(
        inArray(
          kiloclaw_instances.user_id,
          seedUsers.map(user => user.id)
        ),
        isNull(kiloclaw_instances.destroyed_at)
      )
    );

  const apiUrl = process.env.KILOCLAW_API_URL?.trim();
  const apiSecret = process.env.KILOCLAW_INTERNAL_API_SECRET?.trim();
  if (!apiUrl || !apiSecret) {
    if (activeInstances.length > 0) {
      console.warn(
        `[${SEED_SCOPE}] Skipping worker cleanup because KILOCLAW_API_URL or KILOCLAW_INTERNAL_API_SECRET is missing`
      );
    }
    return;
  }

  const instancesToDestroy = new Map<string, { userId: string; instanceId: string }>();
  instancesToDestroy.set(`${ELIGIBLE_USER_ID}:${ELIGIBLE_INSTANCE_ID}`, {
    userId: ELIGIBLE_USER_ID,
    instanceId: ELIGIBLE_INSTANCE_ID,
  });

  for (const instance of activeInstances) {
    instancesToDestroy.set(`${instance.userId}:${instance.instanceId}`, instance);
  }

  for (const instance of instancesToDestroy.values()) {
    const destroyUrl = new URL('/api/platform/destroy', apiUrl);
    destroyUrl.searchParams.set('instanceId', instance.instanceId);

    try {
      const response = await fetch(destroyUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': apiSecret,
        },
        body: JSON.stringify({ userId: instance.userId }),
      });

      if (!response.ok && response.status !== 404) {
        const responseBody = await response.text();
        console.warn(
          `[${SEED_SCOPE}] Worker destroy returned ${response.status} for ${instance.instanceId}: ${responseBody}`
        );
      }
    } catch (error) {
      console.warn(
        `[${SEED_SCOPE}] Worker destroy failed for ${instance.instanceId}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

async function cleanupExistingSeedRows(): Promise<void> {
  const db = getSeedDb();
  const existingSubscriptions = await db
    .select({ id: kiloclaw_subscriptions.id })
    .from(kiloclaw_subscriptions)
    .where(
      inArray(
        kiloclaw_subscriptions.user_id,
        seedUsers.map(user => user.id)
      )
    );

  const subscriptionIds = existingSubscriptions.map(subscription => subscription.id);

  await db.delete(kiloclaw_admin_audit_logs).where(
    inArray(
      kiloclaw_admin_audit_logs.target_user_id,
      seedUsers.map(user => user.id)
    )
  );
  await db.delete(kiloclaw_email_log).where(
    inArray(
      kiloclaw_email_log.user_id,
      seedUsers.map(user => user.id)
    )
  );

  if (subscriptionIds.length > 0) {
    await db
      .delete(kiloclaw_subscription_change_log)
      .where(inArray(kiloclaw_subscription_change_log.subscription_id, subscriptionIds));
    await db
      .delete(kiloclaw_subscriptions)
      .where(inArray(kiloclaw_subscriptions.id, subscriptionIds));
  }

  await db.delete(kiloclaw_instances).where(
    inArray(
      kiloclaw_instances.user_id,
      seedUsers.map(user => user.id)
    )
  );
  await db.delete(kilocode_users).where(
    inArray(
      kilocode_users.id,
      seedUsers.map(user => user.id)
    )
  );
}

async function insertSeedUsers(): Promise<void> {
  const db = getSeedDb();
  await db.insert(kilocode_users).values(seedUsers);
}

async function provisionEligibleTrialFixture(): Promise<ProvisionResponse> {
  const apiUrl = requireEnv('KILOCLAW_API_URL');
  const apiSecret = requireEnv('KILOCLAW_INTERNAL_API_SECRET');

  const response = await fetch(new URL('/api/platform/provision', apiUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-api-key': apiSecret,
    },
    body: JSON.stringify({
      userId: ELIGIBLE_USER_ID,
      instanceId: ELIGIBLE_INSTANCE_ID,
      provider: 'docker-local',
    }),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Failed to provision eligible inactive-trial fixture (${response.status}): ${responseBody}`
    );
  }

  const payload = parseProvisionResponse(await response.json());
  return payload;
}

async function updateEligibleTrialFixture(provisioned: ProvisionResponse): Promise<void> {
  const db = getSeedDb();

  await db.insert(kiloclaw_instances).values({
    id: ELIGIBLE_INSTANCE_ID,
    user_id: ELIGIBLE_USER_ID,
    sandbox_id: provisioned.sandboxId,
    provider: 'docker-local',
    created_at: isoFromNow(-3 * 24 * 60 * 60 * 1000),
    inactive_trial_stopped_at: null,
  });

  await db.insert(kiloclaw_subscriptions).values({
    id: ELIGIBLE_SUBSCRIPTION_ID,
    user_id: ELIGIBLE_USER_ID,
    instance_id: ELIGIBLE_INSTANCE_ID,
    plan: 'trial',
    status: 'trialing',
    trial_started_at: isoFromNow(-3 * 24 * 60 * 60 * 1000),
    trial_ends_at: isoFromNow(4 * 24 * 60 * 60 * 1000),
  });

  const currentInstance = await db.query.kiloclaw_instances.findFirst({
    where: eq(kiloclaw_instances.id, ELIGIBLE_INSTANCE_ID),
  });

  if (!currentInstance || currentInstance.sandbox_id !== provisioned.sandboxId) {
    throw new Error('Provisioned eligible fixture did not persist the expected instance row');
  }
}

function buildAdditionalInstances(): SeedInstance[] {
  return [
    {
      id: RECENT_INSTANCE_ID,
      user_id: RECENT_USER_ID,
      sandbox_id: sandboxIdForInstance(RECENT_INSTANCE_ID),
      provider: 'docker-local',
      created_at: isoFromNow(-12 * 60 * 60 * 1000),
    },
    {
      id: MARKED_INSTANCE_ID,
      user_id: MARKED_USER_ID,
      sandbox_id: sandboxIdForInstance(MARKED_INSTANCE_ID),
      provider: 'docker-local',
      created_at: isoFromNow(-5 * 24 * 60 * 60 * 1000),
      inactive_trial_stopped_at: isoFromNow(-2 * 60 * 60 * 1000),
    },
  ];
}

function buildAdditionalSubscriptions(): SeedSubscription[] {
  return [
    {
      id: RECENT_SUBSCRIPTION_ID,
      user_id: RECENT_USER_ID,
      instance_id: RECENT_INSTANCE_ID,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: isoFromNow(-12 * 60 * 60 * 1000),
      trial_ends_at: isoFromNow(6.5 * 24 * 60 * 60 * 1000),
    },
    {
      id: MARKED_SUBSCRIPTION_ID,
      user_id: MARKED_USER_ID,
      instance_id: MARKED_INSTANCE_ID,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: isoFromNow(-5 * 24 * 60 * 60 * 1000),
      trial_ends_at: isoFromNow(2 * 24 * 60 * 60 * 1000),
    },
  ];
}

async function insertAdditionalSeedRows(): Promise<void> {
  const db = getSeedDb();
  await db.insert(kiloclaw_instances).values(buildAdditionalInstances());
  await db.insert(kiloclaw_subscriptions).values(buildAdditionalSubscriptions());
}

async function loadEligibleFixtureSummary(): Promise<{
  user: SeedUser;
  instance: KiloClawInstance;
  subscriptionId: string;
}> {
  const db = getSeedDb();
  const subscription = await db.query.kiloclaw_subscriptions.findFirst({
    where: eq(kiloclaw_subscriptions.id, ELIGIBLE_SUBSCRIPTION_ID),
  });

  if (!subscription?.instance_id) {
    throw new Error('Eligible fixture summary could not find the provisioned subscription');
  }

  const instance = await db.query.kiloclaw_instances.findFirst({
    where: eq(kiloclaw_instances.id, ELIGIBLE_INSTANCE_ID),
  });

  if (!instance) {
    throw new Error('Eligible fixture summary could not find the provisioned instance');
  }

  const user = seedUsers.find(candidate => candidate.id === ELIGIBLE_USER_ID);
  if (!user) {
    throw new Error('Eligible fixture summary could not find the seeded user');
  }

  return {
    user,
    instance,
    subscriptionId: subscription.id,
  };
}

export async function run(): Promise<void> {
  console.log(`[${SEED_SCOPE}] Resetting existing seed data`);
  await destroySeedInstancesBestEffort();
  await cleanupExistingSeedRows();

  console.log(`[${SEED_SCOPE}] Inserting seed users`);
  await insertSeedUsers();

  console.log(`[${SEED_SCOPE}] Provisioning eligible docker-local trial fixture`);
  const provisioned = await provisionEligibleTrialFixture();
  await updateEligibleTrialFixture(provisioned);

  console.log(`[${SEED_SCOPE}] Inserting additional comparison fixtures`);
  await insertAdditionalSeedRows();

  const eligible = await loadEligibleFixtureSummary();

  console.log('');
  console.log(`[${SEED_SCOPE}] Seed complete`);
  console.log('');
  console.log('Eligible stop candidate (real provisioned local instance):');
  console.log(`  email: ${eligible.user.google_user_email}`);
  console.log(`  userId: ${eligible.user.id}`);
  console.log(`  instanceId: ${eligible.instance.id}`);
  console.log(`  subscriptionId: ${eligible.subscriptionId}`);
  console.log(`  sandboxId: ${eligible.instance.sandbox_id}`);
  console.log(`  createdAt: ${eligible.instance.created_at}`);
  console.log('');
  console.log('Comparison fixtures (DB-only):');
  console.log(
    `  recent trial user: ${seedUsers.find(user => user.id === RECENT_USER_ID)?.google_user_email}`
  );
  console.log(
    `  inactive-trial-stopped user: ${seedUsers.find(user => user.id === MARKED_USER_ID)?.google_user_email}`
  );
  console.log('');
  console.log('You can now run:');
  console.log('  pnpm dev:seed kiloclaw-billing inactive-trials');
  console.log('  curl "http://localhost:8807/__scheduled?cron=0+8+*+*+*"');
}
