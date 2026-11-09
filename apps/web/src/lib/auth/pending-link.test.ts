import { eq, inArray } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, pending_auth_links, user_auth_provider } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { sendNewSignInMethodEmail } from '@kilocode/web-shared/lib/email';
import {
  accountHasVerifiedPrimaryAddress,
  linkAccountToExistingUser,
  type CreateOrUpdateUserArgs,
} from '@/lib/user';
import {
  completePendingLink,
  createPendingLink,
  createPendingLinkForDifferentOAuth,
  getPendingLinkMethods,
} from './pending-link';

jest.mock('@kilocode/web-shared/lib/email', () => ({
  sendNewSignInMethodEmail: jest.fn(async () => ({ sent: true })),
}));

const mockSendNotice = jest.mocked(sendNewSignInMethodEmail);
const createdUserIds: string[] = [];

async function makeUser(email: string) {
  const user = await insertTestUser({ google_user_email: email });
  createdUserIds.push(user.id);
  return user;
}

async function addProvider(
  userId: string,
  provider: CreateOrUpdateUserArgs['provider'],
  providerAccountId: string,
  email: string
) {
  await db.insert(user_auth_provider).values({
    kilo_user_id: userId,
    provider,
    provider_account_id: providerAccountId,
    email,
    avatar_url: '',
    display_name: null,
    hosted_domain: null,
  });
}

function githubIdentity(email: string, accountId = 'github-pending-1'): CreateOrUpdateUserArgs {
  return {
    google_user_email: email,
    google_user_name: 'Pending User',
    google_user_image_url: '',
    hosted_domain: '@@github@@',
    provider: 'github',
    provider_account_id: accountId,
    display_name: null,
  };
}

beforeEach(() => {
  mockSendNotice.mockClear();
});

afterEach(async () => {
  if (createdUserIds.length === 0) return;
  await db
    .delete(pending_auth_links)
    .where(inArray(pending_auth_links.kilo_user_id, createdUserIds));
  await db
    .delete(user_auth_provider)
    .where(inArray(user_auth_provider.kilo_user_id, createdUserIds));
  await db.delete(kilocode_users).where(inArray(kilocode_users.id, createdUserIds));
  createdUserIds.length = 0;
});

describe('pending auth link attach rule', () => {
  it('reports EXPIRED for an unknown secret', async () => {
    await expect(completePendingLink('not-a-real-secret', 'any-user')).resolves.toEqual({
      status: 'failed',
      reason: 'EXPIRED',
    });
  });

  it('reports EXPIRED after the expiry time', async () => {
    const user = await makeUser('pending-expired@example.com');
    const { secret, pendingLink } = await createPendingLink({
      kiloUserId: user.id,
      kind: 'existing_account',
      identity: githubIdentity(user.google_user_email),
      emailCodeAllowed: true,
    });
    await db
      .update(pending_auth_links)
      .set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(pending_auth_links.id, pendingLink.id));

    await expect(completePendingLink(secret, user.id)).resolves.toEqual({
      status: 'failed',
      reason: 'EXPIRED',
    });
  });

  it('does not consume the link on WRONG_ACCOUNT, then links for the right account', async () => {
    const user = await makeUser('pending-wrong@example.com');
    const other = await makeUser('pending-other@example.com');
    const { secret, pendingLink } = await createPendingLink({
      kiloUserId: user.id,
      kind: 'existing_account',
      identity: githubIdentity(user.google_user_email),
      emailCodeAllowed: true,
    });

    await expect(completePendingLink(secret, other.id)).resolves.toEqual({
      status: 'failed',
      reason: 'WRONG_ACCOUNT',
    });
    const [row] = await db
      .select()
      .from(pending_auth_links)
      .where(eq(pending_auth_links.id, pendingLink.id));
    expect(row.consumed_at).toBeNull();

    await expect(completePendingLink(secret, user.id)).resolves.toEqual({
      status: 'linked',
      provider: 'github',
    });
  });

  it('maps PROVIDER-ALREADY-LINKED when the account has another account of that provider', async () => {
    const user = await makeUser('pending-provider@example.com');
    await addProvider(user.id, 'github', 'github-existing', user.google_user_email);
    const { secret } = await createPendingLink({
      kiloUserId: user.id,
      kind: 'existing_account',
      identity: githubIdentity(user.google_user_email, 'github-different'),
      emailCodeAllowed: true,
    });

    await expect(completePendingLink(secret, user.id)).resolves.toEqual({
      status: 'failed',
      reason: 'PROVIDER-ALREADY-LINKED',
    });
  });

  it('consumes the link once on success and sends the security notice', async () => {
    const user = await makeUser('pending-success@example.com');
    const { secret } = await createPendingLink({
      kiloUserId: user.id,
      kind: 'existing_account',
      identity: githubIdentity(user.google_user_email),
      emailCodeAllowed: true,
    });

    await expect(completePendingLink(secret, user.id)).resolves.toEqual({
      status: 'linked',
      provider: 'github',
    });
    await expect(completePendingLink(secret, user.id)).resolves.toEqual({
      status: 'failed',
      reason: 'EXPIRED',
    });
    expect(mockSendNotice).toHaveBeenCalledTimes(1);
    expect(mockSendNotice).toHaveBeenCalledWith(user.google_user_email, 'GitHub');
  });

  it('links exactly once under concurrent completion', async () => {
    const user = await makeUser('pending-concurrent@example.com');
    const { secret } = await createPendingLink({
      kiloUserId: user.id,
      kind: 'existing_account',
      identity: githubIdentity(user.google_user_email),
      emailCodeAllowed: true,
    });

    const results = await Promise.all([
      completePendingLink(secret, user.id),
      completePendingLink(secret, user.id),
    ]);
    expect(results.filter(r => r.status === 'linked')).toHaveLength(1);
    expect(results.filter(r => r.status === 'failed')).toHaveLength(1);
  });
});

describe('pending auth link email code eligibility', () => {
  it('allows the code for an account with a verified primary address', async () => {
    const user = await makeUser('pending-verified@example.com');
    await addProvider(user.id, 'google', 'google-1', user.google_user_email);
    await expect(accountHasVerifiedPrimaryAddress(user.id)).resolves.toBe(true);
  });

  it('allows the code for an account with no provider rows', async () => {
    const user = await makeUser('pending-noproviders@example.com');
    await expect(accountHasVerifiedPrimaryAddress(user.id)).resolves.toBe(true);
  });

  it('refuses the code for a GitHub-only account', async () => {
    const user = await makeUser('pending-github-only@example.com');
    await addProvider(user.id, 'github', 'github-only-1', user.google_user_email);
    await expect(accountHasVerifiedPrimaryAddress(user.id)).resolves.toBe(false);
  });

  it('creates no link when the provider type is already present', async () => {
    const user = await makeUser('pending-present@example.com');
    const created = await createPendingLinkForDifferentOAuth(
      githubIdentity(user.google_user_email),
      {
        success: false,
        error: 'DIFFERENT-OAUTH',
        targetUserId: user.id,
        accountHasVerifiedPrimaryAddress: true,
        providerAlreadyPresent: true,
      }
    );
    expect(created).toBeNull();
  });

  it('stores the eligibility decided at creation and lists existing methods', async () => {
    const user = await makeUser('pending-methods@example.com');
    await addProvider(user.id, 'google', 'google-1', user.google_user_email);
    await addProvider(user.id, 'workos', 'workos-1', user.google_user_email);
    const created = await createPendingLinkForDifferentOAuth(
      githubIdentity(user.google_user_email),
      {
        success: false,
        error: 'DIFFERENT-OAUTH',
        targetUserId: user.id,
        accountHasVerifiedPrimaryAddress: false,
        providerAlreadyPresent: false,
      }
    );
    expect(created?.pendingLink.email_code_allowed).toBe(false);
    await expect(getPendingLinkMethods(user.id, 'github')).resolves.toEqual(['google']);
  });
});

describe('new sign-in method notice', () => {
  it('skips a no-op re-link and the test login', async () => {
    const user = await makeUser('pending-notice@example.com');
    const identity = githubIdentity(user.google_user_email);

    const first = await linkAccountToExistingUser(user.id, identity);
    expect(first.success).toBe(true);
    expect(mockSendNotice).toHaveBeenCalledTimes(1);

    const again = await linkAccountToExistingUser(user.id, identity);
    expect(again.success).toBe(true);
    expect(mockSendNotice).toHaveBeenCalledTimes(1);

    const fake = await linkAccountToExistingUser(user.id, {
      ...identity,
      provider: 'fake-login',
      provider_account_id: 'fake-pending-notice@example.com',
      hosted_domain: '@@fake@@',
    });
    expect(fake.success).toBe(true);
    expect(mockSendNotice).toHaveBeenCalledTimes(1);
  });

  it('keeps the link when the notice send fails', async () => {
    mockSendNotice.mockRejectedValueOnce(new Error('mail down'));
    const user = await makeUser('pending-notice-fails@example.com');
    const result = await linkAccountToExistingUser(user.id, githubIdentity(user.google_user_email));
    expect(result.success).toBe(true);
  });
});
