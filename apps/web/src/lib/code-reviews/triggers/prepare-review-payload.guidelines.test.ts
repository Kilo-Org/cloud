import { generateKeyPairSync } from 'node:crypto';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  agent_configs,
  cloud_agent_code_reviews,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { prepareReviewPayload } from './prepare-review-payload';
import type { CodeReviewAgentConfig } from '@kilocode/db/schema-types';

jest.mock('@/lib/integrations/platforms/github/adapter', () =>
  jest.requireActual('../../integrations/platforms/github/adapter')
);

const SOURCE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);

it('prepares the real prompt and persists import metadata with only GitHub HTTP faked', async () => {
  const originalAppId = process.env.GITHUB_APP_ID;
  const originalPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  process.env.GITHUB_APP_ID = '123456';
  process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;

  const requests: URL[] = [];
  const file = (content: string) => ({
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(content).toString('base64'),
  });
  const http = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    requests.push(url);
    if (url.origin !== 'https://api.github.com')
      throw new Error('Unexpected non-GitHub HTTP request');
    if (url.pathname.includes('/contents/') || url.pathname.startsWith('/repos/acme/guidelines')) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    let body: unknown;
    let status = 200;
    switch (url.pathname) {
      case '/app/installations/987654/access_tokens':
        body = {
          token: 'synthetic-installation-token',
          expires_at: '2099-01-01T00:00:00.000Z',
          permissions: { contents: 'read', pull_requests: 'write' },
          repository_selection: 'selected',
        };
        status = 201;
        break;
      case '/repos/acme/app':
        body = { size: 1024 };
        break;
      case '/repos/acme/app/contents/REVIEW.md':
        expect(url.searchParams.get('ref')).toBe('release');
        body = file(
          '---\nextends:\n  - acme/guidelines:frontend.md\n  - acme/guidelines:backend/api.md\n  - acme/guidelines:missing.md\n  - acme/blocked:policy.md\n  - acme/inaccessible:policy.md\n  - "acme/guidelines:bad\\u0000.md"\n---\nRepository-specific rules.'
        );
        break;
      case '/repos/acme/guidelines':
        body = { default_branch: 'policy/main' };
        break;
      case '/repos/acme/guidelines/git/ref/heads/policy%2Fmain':
      case '/repos/acme/guidelines/git/ref/heads/policy/main':
      case '/repos/acme/guidelines/git/ref/heads%2Fpolicy%2Fmain':
        body = { object: { sha: SOURCE_SHA, type: 'commit' } };
        break;
      case '/repos/acme/guidelines/contents/frontend.md':
        expect(url.searchParams.get('ref')).toBe(SOURCE_SHA);
        body = file('---\nextends: [acme/guidelines:nested.md]\n---\nShared frontend rules.');
        break;
      case '/repos/acme/guidelines/contents/backend/api.md':
      case '/repos/acme/guidelines/contents/backend%2Fapi.md':
        expect(url.searchParams.get('ref')).toBe(SOURCE_SHA);
        body = file('Shared API rules.');
        break;
      case '/repos/acme/guidelines/contents/missing.md':
      case '/repos/acme/inaccessible':
        body = { message: 'Not Found' };
        status = 404;
        break;
      case '/repos/acme/app/issues/42/comments':
      case '/repos/acme/app/pulls/42/comments':
        body = [];
        break;
      case '/repos/acme/app/pulls/42':
        body = { head: { sha: HEAD_SHA } };
        break;
      default:
        throw new Error(`Unexpected GitHub HTTP path: ${url.pathname}`);
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });

  try {
    const user = await insertTestUser();
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: '987654',
        platform_account_id: '765432',
        platform_account_login: 'acme',
        repository_access: 'selected',
        integration_status: 'active',
        github_app_type: 'standard',
        github_connection_role: 'workflow',
      })
      .returning();
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        owned_by_user_id: user.id,
        platform_integration_id: integration.id,
        repo_full_name: 'acme/app',
        pr_number: 42,
        pr_url: 'https://github.com/acme/app/pull/42',
        pr_title: 'Synthetic guideline import test',
        pr_author: 'synthetic-author',
        base_ref: 'release',
        head_ref: 'feature',
        head_sha: HEAD_SHA,
        platform: 'github',
        status: 'pending',
      })
      .returning();
    const config = {
      review_style: 'balanced',
      focus_areas: [],
      model_slug: 'test-model',
      disable_review_md: false,
      review_guideline_source_repositories: ['acme/guidelines', 'acme/inaccessible'],
    } satisfies CodeReviewAgentConfig;
    const payload = await prepareReviewPayload({
      reviewId: review.id,
      owner: { type: 'user', id: user.id, userId: user.id },
      agentConfig: { config },
    });
    const prompt = payload.sessionInput.prompt;
    expect(prompt).toContain('## Source: acme/guidelines:frontend.md');
    expect(prompt).toContain('## Source: acme/guidelines:backend/api.md');
    expect(prompt).toContain('## Source: acme/app:REVIEW.md');
    expect(prompt.indexOf('Shared frontend rules.')).toBeLessThan(
      prompt.indexOf('Shared API rules.')
    );
    expect(prompt.indexOf('Shared API rules.')).toBeLessThan(
      prompt.indexOf('Repository-specific rules.')
    );
    expect(prompt).toContain('The repository text wins on conflict.');
    expect(prompt).not.toContain('extends:');
    expect(prompt).not.toContain('nested.md');
    expect(prompt).not.toContain('# WHAT TO REVIEW');
    expect(payload.sessionInput.upstreamBranch).toBe('refs/pull/42/head');
    const [saved] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, review.id));
    expect(saved).toMatchObject({
      repository_review_instructions_used: true,
      repository_review_instructions_ref: 'release',
      repository_review_instructions_truncated: false,
      repository_review_instruction_imports: [
        { source: 'acme/guidelines:frontend.md', sha: SOURCE_SHA, status: 'imported' },
        { source: 'acme/guidelines:backend/api.md', sha: SOURCE_SHA, status: 'imported' },
        { source: 'acme/guidelines:missing.md', sha: SOURCE_SHA, status: 'not_found' },
        { source: 'acme/blocked:policy.md', sha: null, status: 'not_allowed' },
        { source: 'acme/inaccessible:policy.md', sha: null, status: 'not_accessible' },
        { source: 'acme/guidelines:bad\ufffd.md', sha: null, status: 'invalid' },
      ],
    });
    expect(requests.filter(url => url.pathname === '/repos/acme/guidelines')).toHaveLength(1);
    expect(requests.filter(url => url.pathname.includes('/git/ref/'))).toHaveLength(1);
    expect(requests.some(url => url.pathname.includes('/acme/blocked'))).toBe(false);
    expect(requests.some(url => url.pathname.includes('nested.md'))).toBe(false);

    await db.insert(agent_configs).values({
      owned_by_user_id: user.id,
      agent_type: 'code_review',
      platform: 'github',
      created_by: user.id,
      config: { ...config, review_guideline_source_repositories: [] },
    });
    await db
      .update(cloud_agent_code_reviews)
      .set({ status: 'completed' })
      .where(eq(cloud_agent_code_reviews.id, review.id));
    const [manual] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        owned_by_user_id: user.id,
        platform_integration_id: integration.id,
        repo_full_name: 'acme/app',
        pr_number: 42,
        pr_url: 'https://github.com/acme/app/pull/42',
        pr_title: 'Synthetic queued manual review',
        pr_author: 'synthetic-author',
        base_ref: 'release',
        head_ref: 'feature',
        head_sha: HEAD_SHA,
        manual_config: { agentConfig: config, instructions: null, outputMode: 'provider' },
      })
      .returning();
    const manualPayload = await prepareReviewPayload({
      reviewId: manual.id,
      owner: { type: 'user', id: user.id, userId: user.id },
      agentConfig: { config },
    });
    expect(manualPayload.sessionInput.prompt).not.toContain('Shared frontend rules.');
    const [savedManual] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, manual.id));
    expect(
      savedManual.repository_review_instruction_imports?.every(
        entry => entry.status === 'not_allowed' || entry.status === 'invalid'
      )
    ).toBe(true);
    expect(requests.filter(url => url.pathname === '/repos/acme/guidelines')).toHaveLength(1);
  } finally {
    http.mockRestore();
    if (originalAppId === undefined) delete process.env.GITHUB_APP_ID;
    else process.env.GITHUB_APP_ID = originalAppId;
    if (originalPrivateKey === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
    else process.env.GITHUB_APP_PRIVATE_KEY = originalPrivateKey;
  }
});
