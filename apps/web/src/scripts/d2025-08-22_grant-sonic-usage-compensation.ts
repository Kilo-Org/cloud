import { microdollar_usage, kilocode_users } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { eq, sql } from 'drizzle-orm';
import { grantCreditForCategory } from '@/lib/promotionalCredits';

type UserUsageData = {
  id: string;
  google_user_email: string;
  total_cost_microdollars: number;
  total_cost_usd: number;
  compensation_amount_usd: number;
};
const dryRun = true;
async function run() {
  console.log('Starting sonic usage compensation script...');

  // Query users who incurred costs for sonic model after 2025-08-18
  const usersWithSonicUsage = await db
    .select({
      id: kilocode_users.id,
      google_user_email: kilocode_users.google_user_email,
      total_cost_microdollars: sql<number>`sum(${microdollar_usage.cost})`,
    })
    .from(microdollar_usage)
    .innerJoin(kilocode_users, eq(kilocode_users.id, microdollar_usage.kilo_user_id))
    .where(
      sql`${microdollar_usage.model} = 'sonic' 
          AND ${microdollar_usage.created_at} > '2025-08-18' 
          AND ${microdollar_usage.cost} > 0`
    )
    .groupBy(kilocode_users.id, kilocode_users.google_user_email)
    .orderBy(sql`sum(${microdollar_usage.cost}) DESC`);

  console.log(`Found ${usersWithSonicUsage.length} users with sonic usage after 2025-08-18`);

  if (usersWithSonicUsage.length === 0) {
    console.log('No users found. Exiting.');
    process.exit(0);
  }

  // Process each user
  const results: UserUsageData[] = [];

  console.log('Processing users...');
  console.log('email,accidentally_incurred_cost_usd,user_id,compensation_amount_usd,status');

  for (const userData of usersWithSonicUsage) {
    const total_cost_usd = userData.total_cost_microdollars / 1000000;
    const compensation_amount_usd = total_cost_usd + 10; // Original cost + $10

    try {
      // Fetch the full user object
      const user = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, userData.id),
      });

      if (!user) {
        console.log(
          `${userData.google_user_email},${total_cost_usd},${userData.id},${compensation_amount_usd},ERROR: User not found`
        );
        continue;
      }

      if (!dryRun) {
        // Grant credit using the usage_issue category
        const result = await grantCreditForCategory(user, {
          credit_category: 'usage_issue',
          counts_as_selfservice: false,
          amount_usd: compensation_amount_usd,
          description:
            'compensation for accidental charges for free stealth sonic aka grok-code model + $10',
        });

        const status = result.success ? 'SUCCESS' : `ERROR: ${result.message}`;
        console.log(
          `${userData.google_user_email},${total_cost_usd},${userData.id},${compensation_amount_usd},${status}`
        );
      } else {
        console.log(
          `${userData.google_user_email},${total_cost_usd},${userData.id},${compensation_amount_usd},dry-run`
        );
      }

      results.push({
        id: userData.id,
        google_user_email: userData.google_user_email,
        total_cost_microdollars: userData.total_cost_microdollars,
        total_cost_usd,
        compensation_amount_usd,
      });
    } catch (error) {
      console.log(
        `${userData.google_user_email},${total_cost_usd},${userData.id},${compensation_amount_usd},ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  console.log('\nScript completed.');
  console.log(`Total users processed: ${results.length}`);
  console.log(
    `Total compensation granted: $${results.reduce((sum, r) => sum + r.compensation_amount_usd, 0).toFixed(2)}`
  );

  process.exit(0);
}

void run();
