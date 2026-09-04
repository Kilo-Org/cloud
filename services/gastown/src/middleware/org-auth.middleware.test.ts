import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { GastownEnv } from '../gastown.worker';

const mocks = vi.hoisted(() => {
  class UnavailableError extends Error {}
  return { authorizeOrganization: vi.fn(), UnavailableError };
});

vi.mock('../util/town-authorization.util', () => ({
  authorizeOrganization: mocks.authorizeOrganization,
  TownAuthorizationUnavailableError: mocks.UnavailableError,
}));

import { orgAuthMiddleware } from './org-auth.middleware';

function app(values: Record<string, unknown>) {
  const result = new Hono<GastownEnv>();
  result.use('*', async (c, next) => {
    for (const [key, value] of Object.entries(values)) c.set(key as never, value as never);
    await next();
  });
  result.use('/api/orgs/:orgId/*', orgAuthMiddleware);
  result.get('/api/orgs/:orgId/towns', c => c.text(c.get('orgRole') ?? 'missing'));
  return result;
}

describe('orgAuthMiddleware', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    ['removed member', null],
    ['demoted member', null],
    ['missing pepper', null],
    ['mismatched pepper', null],
    ['blocked user', null],
    ['deleted organization', null],
  ])('rejects a modern %s', async (_name, authorization) => {
    mocks.authorizeOrganization.mockResolvedValue(authorization);
    const response = await app({
      kiloUserId: 'user-1',
      kiloUsesModernToken: true,
      kiloApiTokenPepper: 'stale',
      kiloOrgMemberships: [{ orgId: 'org-1', role: 'owner' }],
    }).request('/api/orgs/org-1/towns', {}, {} as Env);

    expect(response.status).toBe(403);
  });

  it('uses the fresh role for a modern request', async () => {
    mocks.authorizeOrganization.mockResolvedValue({ role: 'member' });
    const response = await app({
      kiloUserId: 'user-1',
      kiloUsesModernToken: true,
      kiloApiTokenPepper: 'current',
      kiloOrgMemberships: [{ orgId: 'org-1', role: 'owner' }],
    }).request('/api/orgs/org-1/towns', {}, {} as Env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('member');
  });

  it('fails closed when modern authorization is unavailable', async () => {
    mocks.authorizeOrganization.mockRejectedValue(new mocks.UnavailableError());
    const response = await app({
      kiloUserId: 'user-1',
      kiloUsesModernToken: true,
      kiloApiTokenPepper: 'current',
    }).request('/api/orgs/org-1/towns', {}, {} as Env);

    expect(response.status).toBe(503);
  });

  it('uses current authorization for a legacy request', async () => {
    mocks.authorizeOrganization.mockResolvedValue({ role: 'owner' });
    const response = await app({
      kiloUserId: 'user-1',
      kiloUsesModernToken: false,
      kiloOrgMemberships: [{ orgId: 'org-1', role: 'owner' }],
    }).request('/api/orgs/org-1/towns', {}, {} as Env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('owner');
    expect(mocks.authorizeOrganization).toHaveBeenCalledOnce();
  });
});
