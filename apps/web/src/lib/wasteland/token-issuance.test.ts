import { NextResponse } from 'next/server';
import { defineTestUser } from '@/tests/helpers/user.helper';

jest.mock('@/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@/lib/auth/resource-delegation', () => ({
  createControlTokenForRequest: jest.fn(),
  TypedResourceDelegationError: class extends Error {
    constructor(
      public status: number,
      public delegationCode: string,
      message: string
    ) {
      super(message);
    }
  },
}));
jest.mock('@/lib/admin/admin-access-log', () => ({
  recordKiloAdminElevationForRequest: jest.fn(),
  serviceTarget: (service: string) => ({ service }),
}));
jest.mock('@/lib/constants', () => ({ WASTELAND_URL: 'https://wasteland.invalid' }));
jest.mock('@trpc/client', () => ({ createTRPCClient: jest.fn(), httpLink: jest.fn() }));

import { getUserFromAuth } from '@/lib/user/server';
import {
  createControlTokenForRequest,
  TypedResourceDelegationError,
} from '@/lib/auth/resource-delegation';
import { recordKiloAdminElevationForRequest } from '@/lib/admin/admin-access-log';
import { createTRPCClient, httpLink } from '@trpc/client';
import { POST } from '@/app/api/wasteland/token/route';
import { resolveWastelandUpstreamForUser } from './server-resolve';

const user = defineTestUser({ is_admin: true });
const currentUser = { ...user, is_admin: false };
const query = jest.fn();
beforeEach(() => {
  jest.resetAllMocks();
  jest
    .mocked(getUserFromAuth)
    .mockResolvedValue({ user } as Awaited<ReturnType<typeof getUserFromAuth>>);
  jest
    .mocked(createControlTokenForRequest)
    .mockResolvedValue({
      user: currentUser,
      token: 'bounded-token',
      expiresAt: '2026-09-14T12:00:00.000Z',
      tokenSource: 'wasteland',
    });
  jest
    .mocked(createTRPCClient)
    .mockReturnValue({ wasteland: { getWasteland: { query } } } as never);
  query.mockResolvedValue({ dolthub_upstream: 'owner/repo' });
});

test('route delegates one-hour issuance and returns the authoritative expiry', async () => {
  const response = await POST();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    token: 'bounded-token',
    expiresAt: '2026-09-14T12:00:00.000Z',
  });
  expect(createControlTokenForRequest).toHaveBeenCalledWith(user, 'wasteland', {
    tokenSource: 'wasteland',
    expiresIn: 3600,
    legacyExpiresIn: 3600,
    extra: { isAdmin: true },
  });
  expect(recordKiloAdminElevationForRequest).not.toHaveBeenCalled();
});

test('route audits the current signed admin rather than the initial user snapshot', async () => {
  jest
    .mocked(createControlTokenForRequest)
    .mockResolvedValue({ user, token: 'token', expiresAt: 'expiry', tokenSource: 'wasteland' });
  await POST();
  expect(recordKiloAdminElevationForRequest).toHaveBeenCalledWith(
    expect.objectContaining({ user, tokenSource: 'wasteland', reason: 'service_token_mint' })
  );
});

test.each([
  [401, 'UNAUTHORIZED'],
  [403, 'FORBIDDEN'],
  [503, 'MIGRATION_UNAVAILABLE'],
])('route preserves typed issuance denial %i', async (status, code) => {
  jest
    .mocked(createControlTokenForRequest)
    .mockRejectedValue(
      new TypedResourceDelegationError(status as 401 | 403 | 503, code as never, 'denied')
    );
  const response = await POST();
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: 'denied', code });
  expect(recordKiloAdminElevationForRequest).not.toHaveBeenCalled();
});

test('route preserves authentication failure without minting', async () => {
  const denied = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  jest
    .mocked(getUserFromAuth)
    .mockResolvedValue({ authFailedResponse: denied } as Awaited<
      ReturnType<typeof getUserFromAuth>
    >);
  expect(await POST()).toBe(denied);
  expect(createControlTokenForRequest).not.toHaveBeenCalled();
});

test('resolver sends only the five-minute delegated token to Wasteland tRPC', async () => {
  expect(await resolveWastelandUpstreamForUser(user, 'wasteland-id')).toEqual({
    owner: 'owner',
    repo: 'repo',
  });
  expect(createControlTokenForRequest).toHaveBeenCalledWith(user, 'wasteland', {
    expiresIn: 300,
    legacyExpiresIn: 300,
    extra: { isAdmin: true },
  });
  expect(httpLink).toHaveBeenCalledWith({
    url: 'https://wasteland.invalid/trpc',
    headers: { Authorization: 'Bearer bounded-token' },
  });
  expect(query).toHaveBeenCalledWith({ wastelandId: 'wasteland-id' });
  expect(recordKiloAdminElevationForRequest).not.toHaveBeenCalled();
});

test('resolver returns null without a downstream call or fallback when issuance is denied', async () => {
  jest
    .mocked(createControlTokenForRequest)
    .mockRejectedValue(new TypedResourceDelegationError(503, 'MIGRATION_UNAVAILABLE', 'disabled'));
  expect(await resolveWastelandUpstreamForUser(user, 'wasteland-id')).toBeNull();
  expect(createTRPCClient).not.toHaveBeenCalled();
  expect(recordKiloAdminElevationForRequest).not.toHaveBeenCalled();
});
