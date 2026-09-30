import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { kilocode_users, user_auth_provider } from '@kilocode/db/schema';
import type { createOrUpdateUser as CreateOrUpdateUser } from '@/lib/user';
import { inArray } from 'drizzle-orm';

jest.mock('@/lib/stripe-client', () => ({
  createStripeCustomer: jest.fn(async ({ metadata }: { metadata: { kiloUserId: string } }) => ({
    id: `cus_${metadata.kiloUserId}`,
  })),
  deleteStripeCustomer: jest.fn(async () => {}),
}));

jest.mock('@/lib/posthog', () => {
  const mockCapture = jest.fn();
  return {
    __esModule: true,
    default: jest.fn(() => ({
      capture: mockCapture,
      alias: jest.fn(),
      debug: jest.fn(),
      isFeatureEnabled: jest.fn(),
      getFeatureFlag: jest.fn(),
    })),
    mockCapture,
  };
});

jest.mock('@/lib/ai-gateway/abuse-service', () => ({
  reportAuthEvent: jest.fn(),
  reportEvents: jest.fn(),
}));

jest.mock('@/lib/ai-gateway/providerHash', () => ({
  generateOpenRouterUpstreamSafetyIdentifier: jest.fn(() => 'openrouter-upstream-test-id'),
  generateOpenRouterDownstreamSafetyIdentifier: jest.fn(() => 'openrouter-downstream-test-id'),
  generateVercelDownstreamSafetyIdentifier: jest.fn(() => 'vercel-downstream-test-id'),
}));

const { mockCapture } = jest.requireMock('@/lib/posthog') as { mockCapture: jest.Mock };
const createdUserIds: string[] = [];
let createOrUpdateUser: typeof CreateOrUpdateUser;

const anacondaAccount = {
  google_user_email: 'anaconda-auth-test@example.com',
  google_user_name: 'Anaconda Auth Test',
  google_user_image_url: 'https://example.com/anaconda-avatar.png',
  hosted_domain: '@@anaconda@@',
  provider: 'anaconda',
  provider_account_id: 'anaconda-sub-123',
  display_name: null,
} as const;

beforeAll(async () => {
  ({ createOrUpdateUser } = await import('@/lib/user'));
});

beforeEach(() => {
  mockCapture.mockReset();
});

afterEach(async () => {
  if (createdUserIds.length === 0) return;
  await db
    .delete(user_auth_provider)
    .where(inArray(user_auth_provider.kilo_user_id, createdUserIds));
  await db.delete(kilocode_users).where(inArray(kilocode_users.id, createdUserIds));
  createdUserIds.length = 0;
});

describe('Anaconda authentication persistence and tracking', () => {
  test('stores a new Anaconda provider and tracks the signup', async () => {
    const result = await createOrUpdateUser(anacondaAccount, undefined);
    expect(result.success).toBe(true);
    if (!result.success) return;
    createdUserIds.push(result.user.id);

    const provider = await db.query.user_auth_provider.findFirst({
      where: (table, { eq }) => eq(table.kilo_user_id, result.user.id),
    });
    expect(provider).toMatchObject({
      provider: 'anaconda',
      provider_account_id: 'anaconda-sub-123',
    });
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user_created',
        properties: expect.objectContaining({ provider: 'anaconda' }),
      })
    );
  });

  test('tracks a returning Anaconda sign-in', async () => {
    const signupResult = await createOrUpdateUser(anacondaAccount, undefined);
    expect(signupResult.success).toBe(true);
    if (!signupResult.success) return;
    createdUserIds.push(signupResult.user.id);
    mockCapture.mockReset();

    const signInResult = await createOrUpdateUser(anacondaAccount, undefined);
    expect(signInResult).toMatchObject({ success: true, isNew: false });
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user_signed_in',
        properties: expect.objectContaining({ provider: 'anaconda' }),
      })
    );
  });
});
