import type { ReactNode } from 'react';
import type { User } from '@kilocode/db/schema';

const mockGetUserFromAuthOrRedirect = jest.fn<Promise<User>, []>();

jest.mock('@/lib/user/server', () => ({
  getUserFromAuthOrRedirect: () => mockGetUserFromAuthOrRedirect(),
}));

function makeUser(): User {
  const now = new Date().toISOString();

  return {
    id: 'test-user',
    google_user_email: 'test-user@example.com',
    google_user_name: 'Test User',
    google_user_image_url: 'https://example.com/avatar.png',
    stripe_customer_id: 'cus_test',
    hosted_domain: '@@NON_WORKSPACE_GOOGLE_ACCOUNT@@',
    created_at: now,
    updated_at: now,
    microdollars_used: 0,
    kilo_pass_threshold: null,
    total_microdollars_acquired: 0,
    is_admin: false,
    blocked_reason: null,
    has_validation_novel_card_with_hold: false,
    has_validation_stytch: false,
    api_token_pepper: null,
    web_session_pepper: null,
    auto_top_up_enabled: false,
    default_model: null,
    is_bot: false,
    next_credit_expiration_at: null,
    cohorts: {},
    completed_welcome_form: false,
    linkedin_url: null,
    github_url: null,
    discord_server_membership_verified_at: null,
    openrouter_upstream_safety_identifier: null,
    customer_source: null,
  } as User;
}

describe('SubscriptionsLayout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires authentication before rendering subscription pages', async () => {
    mockGetUserFromAuthOrRedirect.mockResolvedValue(makeUser());

    const { default: SubscriptionsLayout } = await import('@/app/(app)/subscriptions/layout');
    const children = 'subscriptions content' as ReactNode;

    await expect(SubscriptionsLayout({ children })).resolves.toBe(children);
    expect(mockGetUserFromAuthOrRedirect).toHaveBeenCalledTimes(1);
  });
});
