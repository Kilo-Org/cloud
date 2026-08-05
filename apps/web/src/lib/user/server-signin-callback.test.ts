import { beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';

const cookieStore = new Map<string, { name: string; value: string }>();
jest.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.7' }),
  cookies: async () => ({
    get: (name: string) => cookieStore.get(name),
    set: (name: string, value: string) => cookieStore.set(name, { name, value }),
    delete: (name: string) => cookieStore.delete(name),
    getAll: () => [...cookieStore.values()],
  }),
}));
jest.mock('@/lib/user', () => ({
  ...(jest.requireActual('@/lib/user') as object),
  createOrUpdateUser: jest.fn(),
}));
jest.mock('@/lib/stripe-client', () => ({
  createStripeCustomer: jest.fn(async () => ({ id: 'cus_test' })),
  deleteStripeCustomer: jest.fn(async () => {}),
}));

import jwt from 'jsonwebtoken';
import { authOptions } from '@/lib/user/server';
import { createOrUpdateUser } from '@/lib/user';
import { NEXTAUTH_SECRET } from '@/lib/config.server';

const mockCreateOrUpdateUser = jest.mocked(createOrUpdateUser);

const signIn = authOptions.callbacks!.signIn!;

function setValidTurnstileCookie() {
  cookieStore.set('turnstile_jwt', {
    name: 'turnstile_jwt',
    value: jwt.sign({ guid: randomUUID(), ip: '203.0.113.7' }, NEXTAUTH_SECRET, {
      algorithm: 'HS256',
      expiresIn: '5m',
    }),
  });
}

describe('authOptions.callbacks.signIn auto-link wiring', () => {
  beforeEach(() => {
    cookieStore.clear();
    mockCreateOrUpdateUser
      .mockReset()
      .mockResolvedValue({ success: true, user: { blocked_reason: null } as never, isNew: false });
  });

  it('passes autoLink=true for a Google profile that asserts email_verified', async () => {
    setValidTurnstileCookie();

    const result = await signIn({
      user: { id: 'x', email: 'cb-google@example.com', name: 'CB Google', image: '' },
      account: { provider: 'google', providerAccountId: 'cb-google-sub', type: 'oauth' },
      profile: { email_verified: true, email: 'cb-google@example.com' },
    } as never);

    expect(result).toBe(true);
    expect(mockCreateOrUpdateUser.mock.calls[0]?.[2]).toBe(true);
  });

  it('passes autoLink=false for a GitHub profile without an email_verified claim', async () => {
    setValidTurnstileCookie();

    const result = await signIn({
      user: { id: 'x', email: 'cb-github@example.com', name: 'CB GitHub', image: '' },
      account: { provider: 'github', providerAccountId: 'cb-github-id', type: 'oauth' },
      profile: { login: 'cbgithub' },
    } as never);

    expect(result).toBe(true);
    expect(mockCreateOrUpdateUser.mock.calls[0]?.[2]).toBe(false);
  });

  it('passes autoLink=true for an email (magic link) sign-in', async () => {
    const result = await signIn({
      user: {
        id: 'email-cb-email@example.com',
        email: 'cb-email@example.com',
        name: 'cb-email',
        image: '',
      },
      account: {
        provider: 'email',
        providerAccountId: 'cb-email@example.com',
        type: 'credentials',
      },
      profile: undefined,
    } as never);

    expect(result).toBe(true);
    expect(mockCreateOrUpdateUser.mock.calls[0]?.[2]).toBe(true);
  });

  it('passes autoLink=true for an Apple profile with the string "true" email_verified claim', async () => {
    setValidTurnstileCookie();

    const result = await signIn({
      user: { id: 'x', email: 'cb-apple@example.com', name: 'CB Apple', image: '' },
      account: { provider: 'apple', providerAccountId: 'cb-apple-sub', type: 'oauth' },
      profile: { email_verified: 'true', email: 'cb-apple@example.com' },
    } as never);

    expect(result).toBe(true);
    expect(mockCreateOrUpdateUser.mock.calls[0]?.[2]).toBe(true);
  });
});
