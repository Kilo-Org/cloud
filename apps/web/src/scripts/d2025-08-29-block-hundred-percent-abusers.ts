import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { sql, eq } from 'drizzle-orm';

type AbuseUsers = {
  id: string;
};

const isDryRun = !process.argv.includes('--run-actually');

async function backfillDomainBlockedUsers() {
  console.log('Starting backfill of domain-blocked users...');
  if (isDryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made to the database');
  }

  // Fetch all users who don't have a blocked_reason yet
  const abuseUsers: AbuseUsers[] = (
    await db.execute(sql`
    SELECT DISTINCT(ku.id)
    FROM (
        SELECT
            kilo_user_id,
            CASE WHEN min(abuse_classification) = 200 AND max(abuse_classification) = 200 THEN 'full-abuser'
            WHEN min(abuse_classification) = -100 AND max(abuse_classification) = -100 THEN 'full-user'
            ELSE 'semi-abuser' END AS classification
        FROM microdollar_usage mu
        GROUP BY kilo_user_id
    ) full_abusers
    INNER JOIN kilocode_users ku ON  ku.id = full_abusers.kilo_user_id
    WHERE 1=1
    AND classification = 'full-abuser'
    AND ku.blocked_reason is null
    AND ku.microdollars_used > 1000000
 `)
  ).rows as AbuseUsers[];

  console.log(`Found ${abuseUsers.length} users without blocked_reason and 100% abuse`);

  if (abuseUsers.length === 0) {
    console.log('No users to block. Exiting.');
    process.exit(0);
  }

  // Show sample of users to be blocked
  console.log(`\nUsers ${isDryRun ? 'that would be' : 'to be'} blocked (first 10):`);
  abuseUsers.slice(0, 10).forEach(user => {
    console.log(`  - ${user.id}`);
  });

  if (abuseUsers.length > 10) {
    console.log(`  ... and ${abuseUsers.length - 10} more`);
  }

  await new Promise(resolve => setTimeout(resolve, 5000));

  // Update users in batches to avoid overwhelming the database
  const BATCH_SIZE = 100;
  let blockedCount = 0;

  for (let i = 0; i < abuseUsers.length; i += BATCH_SIZE) {
    const batch = abuseUsers.slice(i, i + BATCH_SIZE);
    const userIds = batch.map(user => user.id);

    try {
      if (!isDryRun) {
        await db
          .update(kilocode_users)
          .set({ blocked_reason: '100% abuse, $1' })
          .where(
            sql`${kilocode_users.id} IN (${sql.join(
              userIds.map(id => sql`${id}`),
              sql`, `
            )})`
          );
      }
      blockedCount += batch.length;
      console.log(`Blocked ${blockedCount}/${abuseUsers.length} users`);
    } catch (error) {
      console.error(`Error blocking batch starting at index ${i}:`, error);
      throw error;
    }
  }

  console.log(`Total users blocked: ${blockedCount}`);

  // Verify the update
  const verificationCheck = await db
    .select({
      count: sql<string>`count(*)`,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.blocked_reason, '100% abuse, $1'));

  console.log(
    `Verification: ${verificationCheck[0].count} users now have blocked_reason='100% abuse, $1'`
  );
}

// Run the script
backfillDomainBlockedUsers()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('Script failed:', error);
    process.exit(1);
  });
