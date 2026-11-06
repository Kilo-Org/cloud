import { NextRequest } from 'next/server';
import {
  GASTOWN_ADMIN_AUDIENCE,
  workerAdminBindingDigest,
} from '@kilocode/worker-utils/worker-admin-capability';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'internal-secret',
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: { query: { kilocode_users: { findFirst: jest.fn() } } },
}));

import { db } from '@kilocode/web-shared/lib/drizzle';
import { POST } from './route';

const findFirst = jest.mocked(db.query.kilocode_users.findFirst);

async function body(overrides: Record<string, unknown> = {}) {
  return {
    jti: 'jti-1',
    sub: 'user-1',
    aud: GASTOWN_ADMIN_AUDIENCE,
    action: 'trpc:gastown.getTown',
    target: { kind: 'town', id: 'town-1' },
    bnd: {
      pep: await workerAdminBindingDigest('pepper-1'),
      wsp: await workerAdminBindingDigest(''),
    },
    ...overrides,
  };
}

function request(payload: unknown, secret = 'internal-secret'): NextRequest {
  return new NextRequest(
    'https://app.example.test/api/internal/worker-admin-capabilities/introspect',
    {
      method: 'POST',
      headers: { 'x-internal-api-key': secret },
      body: JSON.stringify(payload),
    }
  );
}

describe('POST /api/internal/worker-admin-capabilities/introspect', () => {
  beforeEach(() => findFirst.mockReset());

  it('requires the internal secret', async () => {
    const response = await POST(request(await body(), 'wrong'));
    expect(response.status).toBe(401);
  });

  it('rejects a malformed body', async () => {
    const response = await POST(request({ nope: true }));
    expect(response.status).toBe(400);
  });

  it('marks a live admin with a matching pepper active', async () => {
    findFirst.mockResolvedValue({
      id: 'user-1',
      is_admin: true,
      blocked_at: null,
      blocked_reason: null,
      api_token_pepper: 'pepper-1',
    } as never);
    const response = await POST(request(await body()));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ active: true });
  });

  it('marks a blocked admin inactive', async () => {
    findFirst.mockResolvedValue({
      id: 'user-1',
      is_admin: true,
      blocked_at: new Date(),
      blocked_reason: null,
      api_token_pepper: 'pepper-1',
    } as never);
    const response = await POST(request(await body()));
    await expect(response.json()).resolves.toEqual({ active: false, reason: 'blocked' });
  });

  it('marks a demoted admin inactive', async () => {
    findFirst.mockResolvedValue({
      id: 'user-1',
      is_admin: false,
      blocked_at: null,
      blocked_reason: null,
      api_token_pepper: 'pepper-1',
    } as never);
    await expect((await POST(request(await body()))).json()).resolves.toEqual({
      active: false,
      reason: 'role_revoked',
    });
  });

  it('marks a rotated pepper inactive', async () => {
    findFirst.mockResolvedValue({
      id: 'user-1',
      is_admin: true,
      blocked_at: null,
      blocked_reason: null,
      api_token_pepper: 'pepper-2',
    } as never);
    await expect((await POST(request(await body()))).json()).resolves.toEqual({
      active: false,
      reason: 'session_revoked',
    });
  });

  it('rejects an action that does not exist for the audience', async () => {
    const response = await POST(request(await body({ action: 'trpc:gastown.notARealAction' })));
    await expect(response.json()).resolves.toEqual({ active: false, reason: 'role_revoked' });
    expect(findFirst).not.toHaveBeenCalled();
  });
});
