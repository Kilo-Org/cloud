/**
 * Backfill pr_author_github_id for existing code reviews
 *
 * This script fetches GitHub user IDs from the GitHub API using the pr_author username
 * and updates the cloud_agent_code_reviews table.
 *
 * Run with: USE_PRODUCTION_DB=true pnpm script src/scripts/backfill-pr-author-github-ids.ts
 */

import { db, closeAllDrizzleConnections } from '@/lib/drizzle';
import { cloud_agent_code_reviews } from '@kilocode/db/schema';
import { isNull, eq, gt, and, asc } from 'drizzle-orm';
import { Octokit } from '@octokit/rest';

const GITHUB_TOKEN = process.env.GITHUB_ADMIN_STATS_TOKEN;

if (!GITHUB_TOKEN) {
  throw new Error('GITHUB_ADMIN_STATS_TOKEN environment variable is required');
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

async function backfillPrAuthorGithubIds() {
  console.log('Starting backfill of pr_author_github_id...');

  const BATCH_SIZE = 10;
  const DELAY_MS = 1000;
  const PAGE_SIZE = 100;

  let successCount = 0;
  let errorCount = 0;
  let totalProcessed = 0;
  const errors: Array<{ username: string; error: string }> = [];

  let hasMore = true;
  let lastId: string | null = null;

  while (hasMore) {
    let reviewsPage;

    if (lastId) {
      reviewsPage = await db
        .select({
          id: cloud_agent_code_reviews.id,
          pr_author: cloud_agent_code_reviews.pr_author,
        })
        .from(cloud_agent_code_reviews)
        .where(
          and(
            isNull(cloud_agent_code_reviews.pr_author_github_id),
            gt(cloud_agent_code_reviews.id, lastId)
          )
        )
        .orderBy(asc(cloud_agent_code_reviews.id))
        .limit(PAGE_SIZE);
    } else {
      reviewsPage = await db
        .select({
          id: cloud_agent_code_reviews.id,
          pr_author: cloud_agent_code_reviews.pr_author,
        })
        .from(cloud_agent_code_reviews)
        .where(isNull(cloud_agent_code_reviews.pr_author_github_id))
        .orderBy(asc(cloud_agent_code_reviews.id))
        .limit(PAGE_SIZE);
    }

    if (reviewsPage.length === 0) {
      hasMore = false;
      break;
    }

    console.log(`\nFetched ${reviewsPage.length} reviews (starting from id ${lastId})`);

    for (let i = 0; i < reviewsPage.length; i += BATCH_SIZE) {
      const batch = reviewsPage.slice(i, i + BATCH_SIZE);

      console.log(
        `Processing batch ${Math.floor((totalProcessed + i) / BATCH_SIZE) + 1} (${batch.length} reviews)`
      );

      await Promise.all(
        batch.map(async review => {
          try {
            const { data: user } = await octokit.users.getByUsername({
              username: review.pr_author,
            });

            await db
              .update(cloud_agent_code_reviews)
              .set({ pr_author_github_id: String(user.id) })
              .where(eq(cloud_agent_code_reviews.id, review.id));

            successCount++;
            console.log(`✓ Updated ${review.pr_author} -> ${user.id}`);
          } catch (error) {
            errorCount++;
            const errorMessage = error instanceof Error ? error.message : String(error);
            errors.push({ username: review.pr_author, error: errorMessage });
            console.error(`✗ Failed to fetch ${review.pr_author}: ${errorMessage}`);
          }
        })
      );

      if (i + BATCH_SIZE < reviewsPage.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }
    }

    totalProcessed += reviewsPage.length;
    lastId = reviewsPage[reviewsPage.length - 1].id;

    if (reviewsPage.length < PAGE_SIZE) {
      hasMore = false;
    }
  }

  console.log('\n=== Backfill Summary ===');
  console.log(`Total reviews processed: ${totalProcessed}`);
  console.log(`Successfully updated: ${successCount}`);
  console.log(`Errors: ${errorCount}`);

  if (errors.length > 0) {
    console.log('\nFailed usernames:');
    errors.forEach(({ username, error }) => {
      console.log(`  - ${username}: ${error}`);
    });
  }

  await closeAllDrizzleConnections();
}

backfillPrAuthorGithubIds()
  .then(() => {
    console.log('\nBackfill complete!');
    process.exit(0);
  })
  .catch(async error => {
    console.error('Backfill failed:', error);
    await closeAllDrizzleConnections();
    process.exit(1);
  });
