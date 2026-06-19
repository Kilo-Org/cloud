import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  agent_configs,
  cloud_agent_code_reviews,
  kilocode_users,
  platform_integrations,
  webhook_events,
} from '@kilocode/db/schema';
import type { CodeReviewAgentConfig } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';

export const usage = '';

const USER_ID = 'dev-review-webhook-user';
const USER_EMAIL = 'dev-review-webhook@example.com';
const USER_NAME = 'Dev Review Webhook';
const GITHUB_INTEGRATION_ID = '51dfe3d0-65d5-4c19-a2d6-cb37df3c11f1';
const GITLAB_INTEGRATION_ID = '86a3b6e5-14b7-4f40-97d2-e00f67e741e2';
const GITHUB_INSTALLATION_ID = '987654321';
const GITHUB_REPOSITORY_ID = 987654;
const GITHUB_REPO_FULL_NAME = 'kilo-dev/review-fixture';
const GITHUB_PR_NUMBER = 123;
const GITHUB_HEAD_SHA = '1111111111111111111111111111111111111111';
const GITHUB_BASE_SHA = '2222222222222222222222222222222222222222';
const GITLAB_PROJECT_ID = 987654;
const GITLAB_REPO_FULL_NAME = 'kilo-dev/gitlab-review-fixture';
const GITLAB_MR_IID = 123;
const GITLAB_HEAD_SHA = '3333333333333333333333333333333333333333';
const GITLAB_WEBHOOK_TOKEN = 'dev-review-gitlab-webhook-secret';
const FIXTURE_DIR = join(process.cwd(), 'dev', 'review', 'fixtures');
const GITHUB_FIXTURE_PATH = join(FIXTURE_DIR, 'github-pull-request-opened.json');
const GITLAB_FIXTURE_PATH = join(FIXTURE_DIR, 'gitlab-merge-request-open.json');

function printUsage(): void {
  console.log('Usage: pnpm dev:seed review:webhook-fixtures');
  console.log('');
  console.log('Creates local fake GitHub/GitLab integrations and gitignored webhook fixtures.');
}

const codeReviewConfig = {
  review_style: 'balanced',
  focus_areas: ['bugs', 'security', 'testing'],
  custom_instructions:
    'Local webhook fixture harness: include __fake__:idle so fake-llm completes without provider CLI calls.',
  model_slug: 'kilo/fake-deterministic',
  repository_selection_mode: 'all',
  disable_review_md: true,
  gate_threshold: 'off',
} satisfies CodeReviewAgentConfig;

const githubFixture = {
  action: 'opened',
  number: GITHUB_PR_NUMBER,
  pull_request: {
    number: GITHUB_PR_NUMBER,
    title: 'Exercise local code review webhook flow',
    body: 'Fixture PR used to test the local Kilo Code review webhook path.',
    state: 'open',
    draft: false,
    html_url: `https://github.com/${GITHUB_REPO_FULL_NAME}/pull/${GITHUB_PR_NUMBER}`,
    user: {
      id: 583231,
      login: 'octocat',
      avatar_url: 'https://github.com/images/error/octocat_happy.gif',
    },
    head: {
      sha: GITHUB_HEAD_SHA,
      ref: 'feature/local-review-fixture',
      repo: {
        full_name: GITHUB_REPO_FULL_NAME,
        clone_url: `https://github.com/${GITHUB_REPO_FULL_NAME}.git`,
      },
    },
    base: {
      sha: GITHUB_BASE_SHA,
      ref: 'main',
    },
  },
  repository: {
    id: GITHUB_REPOSITORY_ID,
    name: 'review-fixture',
    full_name: GITHUB_REPO_FULL_NAME,
    private: false,
    owner: {
      login: 'kilo-dev',
    },
  },
  installation: {
    id: Number(GITHUB_INSTALLATION_ID),
  },
  sender: {
    login: 'octocat',
  },
};

const gitlabFixture = {
  object_kind: 'merge_request',
  event_type: 'merge_request',
  user: {
    id: 583231,
    name: 'Mona Octocat',
    username: 'octocat',
  },
  project: {
    id: GITLAB_PROJECT_ID,
    name: 'gitlab-review-fixture',
    web_url: `https://gitlab.example.com/${GITLAB_REPO_FULL_NAME}`,
    namespace: 'kilo-dev',
    path_with_namespace: GITLAB_REPO_FULL_NAME,
    default_branch: 'main',
  },
  object_attributes: {
    id: 456789,
    iid: GITLAB_MR_IID,
    title: 'Exercise local GitLab review webhook flow',
    state: 'opened',
    action: 'open',
    source_branch: 'feature/local-review-fixture',
    target_branch: 'main',
    source_project_id: GITLAB_PROJECT_ID,
    target_project_id: GITLAB_PROJECT_ID,
    author_id: 583231,
    created_at: '2026-06-19T00:00:00Z',
    updated_at: '2026-06-19T00:00:00Z',
    url: `https://gitlab.example.com/${GITLAB_REPO_FULL_NAME}/-/merge_requests/${GITLAB_MR_IID}`,
    draft: false,
    work_in_progress: false,
    last_commit: {
      id: GITLAB_HEAD_SHA,
      message: 'Add local review fixture change',
    },
  },
};

function writeFixtures(): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(GITHUB_FIXTURE_PATH, `${JSON.stringify(githubFixture, null, 2)}\n`);
  writeFileSync(GITLAB_FIXTURE_PATH, `${JSON.stringify(gitlabFixture, null, 2)}\n`);
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  if (args.length > 0) {
    printUsage();
    throw new Error(`Unexpected arguments: ${args.join(' ')}`);
  }

  const db = getSeedDb();

  await db.delete(webhook_events).where(eq(webhook_events.owned_by_user_id, USER_ID));
  await db
    .delete(cloud_agent_code_reviews)
    .where(eq(cloud_agent_code_reviews.owned_by_user_id, USER_ID));
  await db.delete(agent_configs).where(eq(agent_configs.owned_by_user_id, USER_ID));
  await db.delete(platform_integrations).where(eq(platform_integrations.owned_by_user_id, USER_ID));

  await db
    .insert(kilocode_users)
    .values({
      id: USER_ID,
      google_user_email: USER_EMAIL,
      google_user_name: USER_NAME,
      google_user_image_url: `https://example.com/${USER_ID}.png`,
      stripe_customer_id: 'cus_dev_review_webhook',
      normalized_email: USER_EMAIL,
      email_domain: 'example.com',
      has_validation_stytch: true,
      customer_source: 'dev-seed',
      total_microdollars_acquired: 100_000_000,
    } satisfies typeof kilocode_users.$inferInsert)
    .onConflictDoUpdate({
      target: kilocode_users.id,
      set: {
        google_user_email: USER_EMAIL,
        google_user_name: USER_NAME,
        google_user_image_url: `https://example.com/${USER_ID}.png`,
        normalized_email: USER_EMAIL,
        email_domain: 'example.com',
        has_validation_stytch: true,
        customer_source: 'dev-seed',
        total_microdollars_acquired: 100_000_000,
      },
    });

  await db.insert(platform_integrations).values([
    {
      id: GITHUB_INTEGRATION_ID,
      owned_by_user_id: USER_ID,
      created_by_user_id: USER_ID,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: GITHUB_INSTALLATION_ID,
      platform_account_id: '100001',
      platform_account_login: 'kilo-dev',
      repository_access: 'all',
      repositories: [
        {
          id: GITHUB_REPOSITORY_ID,
          name: 'review-fixture',
          full_name: GITHUB_REPO_FULL_NAME,
          private: false,
        },
      ],
      metadata: { dev_review_fixture: true },
      kilo_requester_user_id: USER_ID,
      platform_requester_account_id: '583231',
      integration_status: 'active',
      github_app_type: 'standard',
    },
    {
      id: GITLAB_INTEGRATION_ID,
      owned_by_user_id: USER_ID,
      created_by_user_id: USER_ID,
      platform: 'gitlab',
      integration_type: 'oauth',
      platform_installation_id: String(GITLAB_PROJECT_ID),
      platform_account_id: '583231',
      platform_account_login: 'octocat',
      repository_access: 'all',
      repositories: [
        {
          id: GITLAB_PROJECT_ID,
          name: 'gitlab-review-fixture',
          full_name: GITLAB_REPO_FULL_NAME,
          private: false,
        },
      ],
      metadata: {
        dev_review_fixture: true,
        webhook_secret: GITLAB_WEBHOOK_TOKEN,
        gitlab_instance_url: 'https://gitlab.example.com',
      },
      kilo_requester_user_id: USER_ID,
      platform_requester_account_id: '583231',
      integration_status: 'active',
    },
  ] satisfies Array<typeof platform_integrations.$inferInsert>);

  await db.insert(agent_configs).values([
    {
      owned_by_user_id: USER_ID,
      agent_type: 'code_review',
      platform: 'github',
      config: codeReviewConfig,
      is_enabled: true,
      created_by: USER_ID,
    },
    {
      owned_by_user_id: USER_ID,
      agent_type: 'code_review',
      platform: 'gitlab',
      config: codeReviewConfig,
      is_enabled: true,
      created_by: USER_ID,
    },
  ] satisfies Array<typeof agent_configs.$inferInsert>);

  writeFixtures();

  console.log('This fixture represents local fake GitHub/GitLab code-review webhook routing.');
  console.log('Use CODE_REVIEW_LOCAL_FAKE_PROVIDER=1 when starting the code-review dev group.');

  return {
    userId: USER_ID,
    githubInstallationId: GITHUB_INSTALLATION_ID,
    githubFixturePath: GITHUB_FIXTURE_PATH,
    gitlabWebhookToken: GITLAB_WEBHOOK_TOKEN,
    gitlabFixturePath: GITLAB_FIXTURE_PATH,
    fakeModel: codeReviewConfig.model_slug,
  };
}
