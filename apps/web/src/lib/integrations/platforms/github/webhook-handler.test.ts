import { NextRequest } from 'next/server';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  cli_session_pull_requests,
  cli_sessions_v2,
  platform_integrations,
} from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { handleGitHubWebhook } from '@/lib/integrations/platforms/github/webhook-handler';

/**
 * End-to-end test of the `pull_request` webhook dispatch path. Drives the real
 * `handleGitHubWebhook` entry point to catch regressions where the upsert
 * side-effect is short-circuited by `closed` early-returns or dedup.
 *
 * Signature verification is bypassed via the mock at
 * `apps/web/src/tests/setup/__mocks__/lib/integrations/platforms/github/adapter.ts`.
 */
describe('handleGitHubWebhook — pull_request dispatch to upsertCliSessionPullRequestsFromWebhook', () => {
  const REPO = 'acme/widgets';
  const INSTALLATION_ID = '424242';

  let testUserId: string;
  let integrationId: string;
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    const user = await insertTestUser();
    testUserId = user.id;

    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: testUserId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: INSTALLATION_ID,
        github_app_type: 'standard',
      })
      .returning();
    integrationId = integration.id;
  });

  afterAll(async () => {
    if (createdSessionIds.length > 0) {
      await db
        .delete(cli_session_pull_requests)
        .where(inArray(cli_session_pull_requests.session_id, createdSessionIds));
      await db
        .delete(cli_sessions_v2)
        .where(inArray(cli_sessions_v2.session_id, createdSessionIds));
    }
    await db.delete(platform_integrations).where(eq(platform_integrations.id, integrationId));
  });

  async function insertSession(gitUrl: string, gitBranch: string): Promise<string> {
    const sessionId = `ses_${crypto.randomUUID()}`;
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: testUserId,
      git_url: gitUrl,
      git_branch: gitBranch,
    });
    createdSessionIds.push(sessionId);
    return sessionId;
  }

  function buildPullRequestWebhook(opts: {
    action: 'opened' | 'closed' | 'synchronize';
    prNumber: number;
    headRef: string;
    headSha: string;
    state: 'open' | 'closed';
    merged?: boolean;
    deliveryId: string;
  }): NextRequest {
    const payload = {
      action: opts.action,
      pull_request: {
        number: opts.prNumber,
        title: 'test PR',
        state: opts.state,
        merged: opts.merged,
        html_url: `https://github.com/${REPO}/pull/${opts.prNumber}`,
        user: { id: 1, login: 'octocat', avatar_url: 'https://example.com/a.png' },
        head: {
          sha: opts.headSha,
          ref: opts.headRef,
          repo: {
            full_name: REPO,
            clone_url: `https://github.com/${REPO}.git`,
            html_url: `https://github.com/${REPO}`,
          },
        },
        base: { sha: 'base-sha', ref: 'main' },
      },
      repository: {
        id: 1,
        name: 'widgets',
        full_name: REPO,
        owner: { login: 'acme' },
      },
      installation: { id: Number(INSTALLATION_ID) },
    };

    return new NextRequest('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': opts.deliveryId,
        'x-hub-signature-256': 'sha256=mocked',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  it('routes a closed+merged pull_request webhook through to the upsert, setting pr_state=merged', async () => {
    const sessionId = await insertSession(`https://github.com/${REPO}.git`, 'feature/merge-me');

    // Seed by first sending an `opened` webhook.
    const openedResponse = await handleGitHubWebhook(
      buildPullRequestWebhook({
        action: 'opened',
        prNumber: 555,
        headRef: 'feature/merge-me',
        headSha: 'sha-open',
        state: 'open',
        deliveryId: 'delivery-opened-555',
      }),
      'standard'
    );
    expect(openedResponse.status).toBe(200);

    const [afterOpened] = await db
      .select()
      .from(cli_session_pull_requests)
      .where(eq(cli_session_pull_requests.session_id, sessionId));
    expect(afterOpened.pr_state).toBe('open');

    // Now the critical case: `closed` short-circuits before `handlePullRequest`
    // is invoked, but the upsert side-effect must still run.
    const closedResponse = await handleGitHubWebhook(
      buildPullRequestWebhook({
        action: 'closed',
        prNumber: 555,
        headRef: 'feature/merge-me',
        headSha: 'sha-open',
        state: 'closed',
        merged: true,
        deliveryId: 'delivery-closed-555',
      }),
      'standard'
    );
    expect(closedResponse.status).toBe(200);

    const [afterClosed] = await db
      .select()
      .from(cli_session_pull_requests)
      .where(eq(cli_session_pull_requests.session_id, sessionId));
    expect(afterClosed.pr_state).toBe('merged');
    expect(afterClosed.pr_number).toBe(555);
  });

  it('records pr_state=closed when a pull_request is closed without merging', async () => {
    const sessionId = await insertSession(`https://github.com/${REPO}.git`, 'feature/abandon');

    const response = await handleGitHubWebhook(
      buildPullRequestWebhook({
        action: 'closed',
        prNumber: 556,
        headRef: 'feature/abandon',
        headSha: 'sha-abandon',
        state: 'closed',
        merged: false,
        deliveryId: 'delivery-closed-556',
      }),
      'standard'
    );
    expect(response.status).toBe(200);

    const [row] = await db
      .select()
      .from(cli_session_pull_requests)
      .where(eq(cli_session_pull_requests.session_id, sessionId));
    expect(row.pr_state).toBe('closed');
  });
});
