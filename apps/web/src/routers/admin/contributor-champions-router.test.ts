import { db } from '@kilocode/web-shared/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  contributor_champion_contributors,
  contributor_champion_events,
  credit_transactions,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

const DAY_MS = 24 * 60 * 60 * 1000;
let nextPullRequestNumber = 90_000;

async function insertContributorWithEmail(input: { login: string; email: string }) {
  nextPullRequestNumber += 1;
  const pullRequestNumber = nextPullRequestNumber;
  const [contributor] = await db
    .insert(contributor_champion_contributors)
    .values({
      github_login: input.login,
      github_profile_url: `https://github.com/${input.login}`,
      all_time_contributions: 20,
      first_contribution_at: new Date(Date.now() - 200 * DAY_MS).toISOString(),
      last_contribution_at: new Date(Date.now() - DAY_MS).toISOString(),
    })
    .returning({ id: contributor_champion_contributors.id });

  await db.insert(contributor_champion_events).values({
    contributor_id: contributor.id,
    repo_full_name: 'Kilo-Org/kilocode',
    github_pr_number: pullRequestNumber,
    github_pr_url: `https://github.com/Kilo-Org/kilocode/pull/${pullRequestNumber}`,
    github_pr_title: `PR ${pullRequestNumber}`,
    github_author_login: input.login,
    github_author_email: input.email,
    merged_at: new Date(Date.now() - DAY_MS).toISOString(),
  });

  return contributor.id;
}

describe('contributor champions router', () => {
  it('requires credit management access for the credit-granting mutations', async () => {
    const plainAdmin = await insertTestUser({ is_admin: true });
    const contributorId = await insertContributorWithEmail({
      login: 'gate-admin',
      email: 'gate-admin@example.com',
    });
    const caller = await createCallerForUser(plainAdmin.id);

    await expect(
      caller.admin.contributorChampions.enroll({ contributorId, tier: 'ambassador' })
    ).rejects.toThrow('Credit management access required');
    await expect(
      caller.admin.contributorChampions.upgradeTier({ contributorId, newTier: 'champion' })
    ).rejects.toThrow('Credit management access required');
    await expect(
      caller.admin.contributorChampions.manualEnroll({
        email: 'gate-admin@example.com',
        githubLogin: null,
        tier: 'ambassador',
        kiloUserId: null,
      })
    ).rejects.toThrow('Credit management access required');

    await expect(caller.admin.contributorChampions.reviewQueue()).resolves.toBeDefined();
  });

  it('applies the credit window through the router', async () => {
    const creditManager = await insertTestUser({ is_admin: true, can_manage_credits: true });
    const linkedUser = await insertTestUser({
      google_user_email: 'router-window@example.com',
    });
    const contributorId = await insertContributorWithEmail({
      login: 'router-window',
      email: 'router-window@example.com',
    });
    const caller = await createCallerForUser(creditManager.id);

    const first = await caller.admin.contributorChampions.enroll({
      contributorId,
      tier: 'ambassador',
    });
    const repeat = await caller.admin.contributorChampions.enroll({
      contributorId,
      tier: 'ambassador',
    });

    expect(first.creditGranted).toBe(true);
    expect(repeat.creditGranted).toBe(false);

    const grants = await db
      .select({
        amount_microdollars: credit_transactions.amount_microdollars,
        credit_category: credit_transactions.credit_category,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, linkedUser.id));

    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      amount_microdollars: 50_000_000,
      credit_category: 'contributor-champion-credits',
    });
  });
});
