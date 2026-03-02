import { db, sql } from '@/lib/drizzle';
import { generateProviderSpecificHash } from '@/lib/providerHash';
import { PROVIDERS } from '@/lib/providers';
import crypto from 'crypto';

// Usage:
// Run `USE_PRODUCTION_DB=true pnpm script:run openrouter find-user-by-safety-id <openrouter-org-id> <safety-identifier>`
// If you get errors about Abuse Service or Gastown, find the relevant code and comment it out.

async function run() {
  const openrouterOrgId = process.argv[4];
  const safetyIdentifierToFind = process.argv[5];

  if (!openrouterOrgId) {
    throw new Error('Please specify an OpenRouter org as the first argument');
  }

  if (!safetyIdentifierToFind) {
    throw new Error('Please specify a safety identifier to find as the second argument');
  }

  const { rows } = await db.execute(sql`
    select ku.id
    from kilocode_users ku
    where true
      and ku.id in (select mu.kilo_user_id from microdollar_usage mu where mu.created_at > now() - interval '7 days')
    order by ku.created_at desc
  `);

  const userIds = rows.map(row => row.id as string);

  let foundUserId: string | null = null;

  for (const userId of userIds) {
    const hash = crypto
      .createHash('sha256')
      .update(openrouterOrgId + '-' + generateProviderSpecificHash(userId, PROVIDERS.OPENROUTER))
      .digest('hex');
    console.log(`User ID: ${userId} -> Safety Identifier: ${hash}`);
    if (hash === safetyIdentifierToFind) {
      foundUserId = userId;
      break;
    }
  }

  if (foundUserId) {
    console.log(`Found User ID: ${foundUserId}`);
  } else {
    console.log('User ID not found');
  }
}

export { run };
