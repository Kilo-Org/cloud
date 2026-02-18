import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/scripts/lib/local-database';
import {
  microdollar_usage,
  microdollar_usage_metadata,
  organizations,
  organization_memberships,
  kilocode_users,
  type MicrodollarUsage,
} from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { cliConfirm } from '@/scripts/lib/cli-confirm';

// Models and their approximate costs per 1K tokens (in microdollars)
const MODELS = [
  { name: 'claude-3-5-sonnet-20241022', inputCost: 3000, outputCost: 15000 },
  { name: 'claude-3-5-haiku-20241022', inputCost: 250, outputCost: 1250 },
  { name: 'gpt-4o', inputCost: 2500, outputCost: 10000 },
  { name: 'gpt-4o-mini', inputCost: 150, outputCost: 600 },
];

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateRandomUsage(
  userId: string,
  orgId: string,
  date: Date
): {
  core: MicrodollarUsage;
  metadata: typeof microdollar_usage_metadata.$inferInsert;
} {
  const model = MODELS[randomInt(0, MODELS.length - 1)];
  const inputTokens = randomInt(100, 10000);
  const outputTokens = randomInt(50, 5000);
  const cacheWriteTokens = randomInt(0, 1000);
  const cacheHitTokens = randomInt(0, 2000);

  // Calculate cost based on model pricing
  const inputCost = Math.floor((inputTokens / 1000) * model.inputCost);
  const outputCost = Math.floor((outputTokens / 1000) * model.outputCost);
  const totalCost = inputCost + outputCost;

  const id = randomUUID();
  const messageId = randomUUID();

  const core: MicrodollarUsage = {
    id,
    kilo_user_id: userId,
    organization_id: orgId,
    cost: totalCost,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_write_tokens: cacheWriteTokens,
    cache_hit_tokens: cacheHitTokens,
    created_at: date.toISOString(),
    provider: 'anthropic',
    model: model.name,
    requested_model: model.name,
    cache_discount: null,
    abuse_classification: 0,
    has_error: false,
    inference_provider: 'anthropic',
    project_id: null,
    feature: null,
  };

  // For seed data, we keep metadata minimal (no foreign key lookups)
  // In production, processUsage.ts uses CTEs to populate the lookup tables
  const metadata: typeof microdollar_usage_metadata.$inferInsert = {
    id,
    message_id: messageId,
    system_prompt_length: randomInt(100, 1000),
    max_tokens: randomInt(1000, 4000),
    has_middle_out_transform: false,
    vercel_ip_latitude: 40.7128,
    vercel_ip_longitude: -74.006,
  };

  return { core, metadata };
}

export async function run(...args: string[]) {
  const [orgId] = args;
  assert(orgId, 'Organization ID is required');

  console.log(`Seeding fake usage data for organization: ${orgId}`);

  // 1. Verify organization exists
  const org = await localDb.query.organizations.findFirst({
    where: eq(organizations.id, orgId),
  });

  if (!org) {
    throw new Error(`Organization with ID ${orgId} not found`);
  }

  console.log(`Found organization: ${org.name}`);
  await cliConfirm(`This will seed fake usage data for organization ${org.name}. Are you sure?`);

  // 2. Get all users in the organization
  const orgMembers = await localDb
    .select({
      userId: organization_memberships.kilo_user_id,
      userName: kilocode_users.google_user_name,
      userEmail: kilocode_users.google_user_email,
    })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(eq(organization_memberships.organization_id, orgId));

  if (orgMembers.length === 0) {
    throw new Error(`No members found for organization ${orgId}`);
  }

  console.log(`Found ${orgMembers.length} members in organization`);
  orgMembers.forEach(member => {
    console.log(`  - ${member.userName} (${member.userEmail})`);
  });

  // 3. Delete existing microdollar_usage and metadata for this organization
  console.log('Deleting existing usage records for organization...');

  // Delete metadata using IN subquery (single SQL query with database optimizer)
  await localDb.execute(sql`
    DELETE FROM microdollar_usage_metadata
    WHERE id IN (
      SELECT id FROM microdollar_usage WHERE organization_id = ${orgId}
    )
  `);

  // Delete usage records
  await localDb.delete(microdollar_usage).where(eq(microdollar_usage.organization_id, orgId));

  console.log(`Deleted existing usage records`);

  // 4. Generate random usage data for the past 30 days
  const coreRecords: MicrodollarUsage[] = [];
  const metadataRecords: (typeof microdollar_usage_metadata.$inferInsert)[] = [];
  const today = new Date();
  let totalCost = 0;

  for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
    const date = new Date(today);
    date.setDate(today.getDate() - dayOffset);
    date.setHours(randomInt(8, 18), randomInt(0, 59), randomInt(0, 59), 0);

    const rand = Math.random();

    // 35% chance of no usage on any given day (ensures at least 2 days/week with no usage)
    if (rand < 0.35) {
      continue;
    }

    // 25% chance of very low usage (only 5-20% of users active)
    // Combined with no usage days, ensures cohort doesn't use much at least twice a week
    let activeUserPercentage: number;
    if (rand < 0.6) {
      // Very low usage day
      activeUserPercentage = randomInt(5, 20);
    } else {
      // Normal usage day (30-80% of users active)
      activeUserPercentage = randomInt(30, 80);
    }

    const activeUserCount = Math.max(
      1,
      Math.floor((orgMembers.length * activeUserPercentage) / 100)
    );
    const activeUsers = orgMembers
      .sort(() => Math.random() - 0.5) // Shuffle array
      .slice(0, activeUserCount);

    // Generate usage records for active users only
    for (const member of activeUsers) {
      const recordsPerDay = randomInt(1, 10);

      for (let i = 0; i < recordsPerDay; i++) {
        const recordDate = new Date(date);
        recordDate.setMinutes(recordDate.getMinutes() + randomInt(0, 480)); // Spread throughout the day

        const { core, metadata } = generateRandomUsage(member.userId, orgId, recordDate);
        coreRecords.push(core);
        metadataRecords.push(metadata);
        totalCost += core.cost;
      }
    }
  }

  console.log(
    `Generated ${coreRecords.length} usage records with total cost: ${totalCost} microdollars`
  );

  // 5. Update total_microdollars_acquired to cover the new usage plus some buffer
  const currentBalance = Number(org.total_microdollars_acquired) - Number(org.microdollars_used);
  const newBalance = Math.max(currentBalance, totalCost + 1000000); // Add 1M microdollars buffer ($1)

  console.log(`Updating organization balance from ${currentBalance} to ${newBalance} microdollars`);

  await localDb
    .update(organizations)
    .set({
      total_microdollars_acquired: sql`${organizations.microdollars_used} + ${newBalance}`,
      microdollars_balance: newBalance,
    })
    .where(eq(organizations.id, orgId));

  // 6. Insert the usage records in batches
  console.log('Inserting usage records...');
  const batchSize = 100;

  // Insert core records
  for (let i = 0; i < coreRecords.length; i += batchSize) {
    const batch = coreRecords.slice(i, i + batchSize);
    await localDb.insert(microdollar_usage).values(batch);
    console.log(
      `Inserted core batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(coreRecords.length / batchSize)}`
    );
  }

  // Insert metadata records (simplified - not using CTE deduplication for seed data)
  console.log('Inserting metadata records...');
  for (let i = 0; i < metadataRecords.length; i += batchSize) {
    const batch = metadataRecords.slice(i, i + batchSize);
    await localDb.insert(microdollar_usage_metadata).values(batch);
    console.log(
      `Inserted metadata batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(metadataRecords.length / batchSize)}`
    );
  }

  console.log(
    `✅ Successfully seeded ${coreRecords.length} usage records for organization ${org.name}`
  );
  console.log(`💰 Organization balance updated to ${newBalance} microdollars`);
  console.log(
    `📊 Total usage cost: ${totalCost} microdollars (${(totalCost / 1000000).toFixed(4)} USD)`
  );
}
