const mockSendCodeReviewDisabledEmail = jest.fn();

jest.mock('@/lib/email', () => ({
  sendCodeReviewDisabledEmail: (...args: unknown[]) => mockSendCodeReviewDisabledEmail(...args),
}));

import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { agent_configs, kilocode_users, type User } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  classifyCodeReviewActionRequiredFailure,
  disableCodeReviewForActionRequiredFailure,
  getCodeReviewActionRequiredState,
} from './action-required';

describe('classifyCodeReviewActionRequiredFailure', () => {
  it('classifies GitHub installation, GitHub IP allow-list, and BYOK invalid key failures', () => {
    expect(
      classifyCodeReviewActionRequiredFailure(
        'GitHub token or active app installation required for this repository (no_installation_found)'
      )
    ).toBe('github_installation_required');

    expect(
      classifyCodeReviewActionRequiredFailure(
        'Dispatch failed: GitHub token or active app installation required for this repository (no_installation_found)'
      )
    ).toBe('github_installation_required');

    expect(
      classifyCodeReviewActionRequiredFailure(
        '[BYOK] Your API key is invalid or has been revoked. Please check your API key configuration.'
      )
    ).toBe('byok_invalid_key');

    expect(
      classifyCodeReviewActionRequiredFailure(
        'Although you appear to have the correct authorization credentials, the `acme` organization has an IP allow list enabled, and 192.0.2.1 is not permitted.'
      )
    ).toBe('github_ip_allow_list');
  });

  it('does not classify unrelated auth, rate-limit, or BYOK quota failures', () => {
    expect(classifyCodeReviewActionRequiredFailure('GitHub returned 401 Unauthorized')).toBeNull();
    expect(classifyCodeReviewActionRequiredFailure('GitHub returned 403 Forbidden')).toBeNull();
    expect(classifyCodeReviewActionRequiredFailure('Rate limit exceeded: 429')).toBeNull();
    expect(
      classifyCodeReviewActionRequiredFailure('[BYOK] Your account quota is exhausted.')
    ).toBeNull();
  });
});

describe('disableCodeReviewForActionRequiredFailure', () => {
  let testUser: User;

  beforeAll(async () => {
    testUser = await insertTestUser();
  });

  beforeEach(async () => {
    mockSendCodeReviewDisabledEmail.mockResolvedValue({ sent: true });
    await db.insert(agent_configs).values({
      owned_by_user_id: testUser.id,
      agent_type: 'code_review',
      platform: 'github',
      config: {},
      is_enabled: true,
      created_by: testUser.id,
    });
  });

  afterEach(async () => {
    await db
      .delete(agent_configs)
      .where(
        and(
          eq(agent_configs.owned_by_user_id, testUser.id),
          eq(agent_configs.agent_type, 'code_review')
        )
      );
    mockSendCodeReviewDisabledEmail.mockReset();
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  async function getStoredConfig() {
    const [config] = await db
      .select()
      .from(agent_configs)
      .where(
        and(
          eq(agent_configs.owned_by_user_id, testUser.id),
          eq(agent_configs.agent_type, 'code_review'),
          eq(agent_configs.platform, 'github')
        )
      )
      .limit(1);
    return config;
  }

  it('throws when the agent config is missing', async () => {
    await db
      .delete(agent_configs)
      .where(
        and(
          eq(agent_configs.owned_by_user_id, testUser.id),
          eq(agent_configs.agent_type, 'code_review')
        )
      );

    await expect(
      disableCodeReviewForActionRequiredFailure({
        owner: { type: 'user', id: testUser.id, userId: testUser.id },
        platform: 'github',
        reason: 'github_installation_required',
        errorMessage:
          'GitHub token or active app installation required for this repository (no_installation_found)',
      })
    ).rejects.toThrow('Code Review agent config not found');

    expect(mockSendCodeReviewDisabledEmail).not.toHaveBeenCalled();
  });

  it('stores runtime state without recipient PII and sends one email for a repeated reason', async () => {
    const owner = { type: 'user' as const, id: testUser.id, userId: testUser.id };

    await disableCodeReviewForActionRequiredFailure({
      owner,
      platform: 'github',
      reviewId: 'review-1',
      reason: 'github_installation_required',
      errorMessage:
        'GitHub token or active app installation required for this repository (no_installation_found)',
    });

    await disableCodeReviewForActionRequiredFailure({
      owner,
      platform: 'github',
      reviewId: 'review-2',
      reason: 'github_installation_required',
      errorMessage:
        'Dispatch failed: GitHub token or active app installation required for this repository (no_installation_found)',
    });

    const config = await getStoredConfig();
    const state = getCodeReviewActionRequiredState(config);

    expect(config?.is_enabled).toBe(false);
    expect(state?.reason).toBe('github_installation_required');
    expect(state?.triggeringReviewId).toBe('review-2');
    expect(state?.emailSentAt).toBeTruthy();
    expect(JSON.stringify(config?.runtime_state)).not.toContain(testUser.google_user_email);
    expect(mockSendCodeReviewDisabledEmail).toHaveBeenCalledTimes(1);
  });

  it('retries email when notification delivery fails', async () => {
    const owner = { type: 'user' as const, id: testUser.id, userId: testUser.id };
    mockSendCodeReviewDisabledEmail.mockResolvedValueOnce({ sent: false });

    await disableCodeReviewForActionRequiredFailure({
      owner,
      platform: 'github',
      reviewId: 'review-1',
      reason: 'github_installation_required',
      errorMessage:
        'GitHub token or active app installation required for this repository (no_installation_found)',
    });

    let state = getCodeReviewActionRequiredState(await getStoredConfig());
    expect(state?.emailSentAt).toBeUndefined();

    mockSendCodeReviewDisabledEmail.mockResolvedValueOnce({ sent: true });
    await disableCodeReviewForActionRequiredFailure({
      owner,
      platform: 'github',
      reviewId: 'review-2',
      reason: 'github_installation_required',
      errorMessage:
        'Dispatch failed: GitHub token or active app installation required for this repository (no_installation_found)',
    });

    state = getCodeReviewActionRequiredState(await getStoredConfig());
    expect(state?.emailSentAt).toBeTruthy();
    expect(mockSendCodeReviewDisabledEmail).toHaveBeenCalledTimes(2);
  });

  it('sends a new email when the action-required reason changes', async () => {
    const owner = { type: 'user' as const, id: testUser.id, userId: testUser.id };

    await disableCodeReviewForActionRequiredFailure({
      owner,
      platform: 'github',
      reason: 'github_installation_required',
      errorMessage:
        'GitHub token or active app installation required for this repository (no_installation_found)',
    });
    await disableCodeReviewForActionRequiredFailure({
      owner,
      platform: 'github',
      reason: 'github_ip_allow_list',
      errorMessage:
        'Although you appear to have the correct authorization credentials, the `acme` organization has an IP allow list enabled, and 192.0.2.1 is not permitted.',
    });

    const state = getCodeReviewActionRequiredState(await getStoredConfig());

    expect(state?.reason).toBe('github_ip_allow_list');
    expect(mockSendCodeReviewDisabledEmail).toHaveBeenCalledTimes(2);
  });
});
