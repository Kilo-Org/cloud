import { getEnvVariable } from '@/lib/dotenvx';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { sql, eq, isNull, or } from 'drizzle-orm';
import { isEmailBlacklistedByDomain } from '@/lib/user.server';

type UnblockedUser = {
  id: string;
  google_user_email: string;
  blocked_reason: string | null;
};

const blacklistDomainsEnv = getEnvVariable('BLACKLIST_DOMAINS');
const BLACKLIST_DOMAINS = blacklistDomainsEnv
  ? blacklistDomainsEnv.split('|').map((domain: string) => domain.trim())
  : [];

const isDryRun = !process.argv.includes('--run-actually');

async function backfillDomainBlockedUsers() {
  console.log('Starting backfill of domain-blocked users...');
  if (isDryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made to the database');
  }
  console.log(`Blacklisted domains: ${BLACKLIST_DOMAINS.join(', ')}`);

  if (BLACKLIST_DOMAINS.length === 0) {
    console.log('No blacklisted domains found in environment. Exiting.');
    process.exit(0);
  }

  // Fetch all users who don't have a blocked_reason yet
  const unblockedUsers: UnblockedUser[] = await db
    .select({
      id: kilocode_users.id,
      google_user_email: kilocode_users.google_user_email,
      blocked_reason: kilocode_users.blocked_reason,
    })
    .from(kilocode_users)
    .where(or(isNull(kilocode_users.blocked_reason), eq(kilocode_users.blocked_reason, '')));

  console.log(`Found ${unblockedUsers.length} users without blocked_reason`);

  // Filter users whose emails match blacklisted domains
  const usersToBlock = unblockedUsers.filter(user =>
    isEmailBlacklistedByDomain(user.google_user_email, BLACKLIST_DOMAINS)
  );

  console.log(`Found ${usersToBlock.length} users matching blacklisted domains`);

  if (usersToBlock.length === 0) {
    console.log('No users to block. Exiting.');
    process.exit(0);
  }

  // Show sample of users to be blocked
  console.log(`\nUsers ${isDryRun ? 'that would be' : 'to be'} blocked (first 10):`);
  usersToBlock.slice(0, 10).forEach(user => {
    const domain = user.google_user_email.split('@')[1];
    console.log(`  - ${user.google_user_email} (domain: ${domain})`);
  });

  if (usersToBlock.length > 10) {
    console.log(`  ... and ${usersToBlock.length - 10} more`);
  }

  await new Promise(resolve => setTimeout(resolve, 5000));

  // Update users in batches to avoid overwhelming the database
  const BATCH_SIZE = 100;
  let blockedCount = 0;

  for (let i = 0; i < usersToBlock.length; i += BATCH_SIZE) {
    const batch = usersToBlock.slice(i, i + BATCH_SIZE);
    const userIds = batch.map(user => user.id);

    try {
      if (!isDryRun) {
        await db
          .update(kilocode_users)
          .set({ blocked_reason: 'domainblocked' })
          .where(
            sql`${kilocode_users.id} IN (${sql.join(
              userIds.map(id => sql`${id}`),
              sql`, `
            )})`
          );
      }
      blockedCount += batch.length;
      console.log(`Blocked ${blockedCount}/${usersToBlock.length} users`);
    } catch (error) {
      console.error(`Error blocking batch starting at index ${i}:`, error);
      throw error;
    }
  }

  console.log('\n✅ Backfill completed successfully!');
  console.log(`Total users blocked: ${blockedCount}`);

  // Verify the update
  const verificationCheck = await db
    .select({
      count: sql<string>`count(*)`,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.blocked_reason, 'domainblocked'));

  console.log(
    `Verification: ${verificationCheck[0].count} users now have blocked_reason='domainblocked'`
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
