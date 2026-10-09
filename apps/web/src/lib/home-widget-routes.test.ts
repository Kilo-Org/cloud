import { NextRequest } from 'next/server';
import { TRPCError } from '@trpc/server';
import {
  buildHomeWidgetData,
  buildHomeWidgetPresentation,
  homeWidgetRefreshAt,
} from '@kilocode/app-shared/home-widget';
import { authenticateHomeWidget } from '@/lib/auth/home-widget-credential';
import { buildHomeWidgetResponseForUser } from '@/lib/glanceable-agents-snapshot-server';
import { GET } from '@/app/api/mobile/widgets/route';
import { POST } from '@/app/api/mobile/widgets/push-token/route';
import { db } from '@kilocode/web-shared/lib/drizzle';

jest.mock('@/lib/auth/home-widget-credential', () => ({ authenticateHomeWidget: jest.fn() }));
jest.mock('@/lib/glanceable-agents-snapshot-server', () => ({
  buildHomeWidgetResponseForUser: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: { insert: jest.fn(), delete: jest.fn() },
}));

type MockDb = { insert: jest.Mock; delete: jest.Mock };
const mockDb = db as unknown as MockDb;

const token = 'ab'.repeat(32);
const principal = {
  userId: 'oauth/widget-user',
  organizationId: '11111111-1111-4111-8111-111111111111',
};
const auth = jest.mocked(authenticateHomeWidget);
const source = jest.mocked(buildHomeWidgetResponseForUser);
const values = jest.fn();
const conflict = jest.fn();
const returning = jest.fn();
const where = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  auth.mockResolvedValue(principal);
  const data = buildHomeWidgetData({ ...principal, now: Date.now(), sessions: [] });
  source.mockResolvedValue({
    ...data,
    home: buildHomeWidgetPresentation(data, Date.now()),
    refreshAt: homeWidgetRefreshAt(data, Date.now()),
  });
  returning.mockResolvedValue([{ id: 'widget-row' }]);
  conflict.mockReturnValue({ returning });
  values.mockReturnValue({ onConflictDoUpdate: conflict });
  mockDb.insert.mockReturnValue({ values });
  where.mockResolvedValue(undefined);
  mockDb.delete.mockReturnValue({ where });
});

function post(body: unknown): NextRequest {
  return new NextRequest('https://example.test/api/mobile/widgets/push-token', {
    method: 'POST',
    headers: { Authorization: 'Bearer dedicated-widget-token' },
    body: JSON.stringify(body),
  });
}

describe('dedicated native widget routes', () => {
  it('reads only the credential scope and returns uncached HomeWidgetResponse JSON', async () => {
    const request = new NextRequest(
      'https://example.test/api/mobile/widgets?organizationId=foreign',
      {
        headers: { Authorization: 'Bearer dedicated-widget-token' },
      }
    );
    const response = await GET(request);
    expect(auth).toHaveBeenCalledWith(request.headers);
    expect(source).toHaveBeenCalledWith(principal, expect.any(AbortSignal));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toMatchObject({
      snapshot: { status: 'empty' },
      home: { status: 'empty' },
    });
  });

  it('fails closed before a source read or registration when authentication is revoked', async () => {
    auth.mockRejectedValue(new TRPCError({ code: 'UNAUTHORIZED' }));
    expect((await GET(new NextRequest('https://example.test/api/mobile/widgets'))).status).toBe(
      401
    );
    expect((await POST(post({ token, enabled: true }))).status).toBe(401);
    expect(source).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('binds the installation token to the current credential without changing Live Activity rows', async () => {
    const response = await POST(post({ token, enabled: true }));
    expect(response.status).toBe(200);
    expect(values).toHaveBeenCalledWith({
      token,
      user_id: principal.userId,
      organization_id: principal.organizationId,
      kind: 'ios_widget',
      platform: 'ios',
    });
    expect(conflict.mock.calls[0]?.[0]).toMatchObject({ set: { user_id: principal.userId } });
    expect((await response.json()).success).toBe(true);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    returning.mockResolvedValue([]);
    expect((await POST(post({ token, enabled: true }))).status).toBe(409);
  });

  it('unregisters idempotently without touching Live Activity registration', async () => {
    expect((await POST(post({ token, enabled: false }))).status).toBe(200);
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('refuses client-controlled org/kind changes and malformed token payloads', async () => {
    for (const body of [
      { token, enabled: true, organizationId: 'foreign' },
      { token, enabled: true, kind: 'ios_activity' },
      { token: 'not-an-apns-token', enabled: true },
    ]) {
      expect((await POST(post(body))).status).toBe(400);
    }
    expect(db.insert).not.toHaveBeenCalled();
  });
});
