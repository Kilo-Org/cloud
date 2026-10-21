import { db } from '@kilocode/web-shared/lib/drizzle';
import { POST } from './route';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  APP_BUILDER_AUTH_TOKEN: 'test-app-builder-token',
}));
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({ logExceptInTest: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ db: { select: jest.fn() } }));

const payload = {
  gitUrl: 'https://app-builder.example.com/apps/project.git',
  commitHash: 'a'.repeat(40),
  branch: 'main',
};

function pushRequest(body: string, authorization: string | null = 'Bearer test-app-builder-token') {
  return new Request('https://app.example.com/api/app-builder/push-notification', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body,
  });
}

describe('App Builder push notifications after Deploy EOL', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(['main', 'feature'])(
    'acknowledges %s pushes without looking up deployments',
    async branch => {
      const response = await POST(pushRequest(JSON.stringify({ ...payload, branch })));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(db.select).not.toHaveBeenCalled();
    }
  );

  it.each([null, 'Bearer invalid', 'Basic test-app-builder-token'])(
    'rejects an unauthorized notification with %s authentication',
    async authorization => {
      const response = await POST(pushRequest(JSON.stringify(payload), authorization));

      expect(response.status).toBe(401);
      expect(db.select).not.toHaveBeenCalled();
    }
  );

  it('rejects invalid JSON', async () => {
    const response = await POST(pushRequest('{'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects invalid push payloads', async () => {
    const response = await POST(pushRequest(JSON.stringify({ ...payload, commitHash: 'short' })));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Invalid request body' });
    expect(db.select).not.toHaveBeenCalled();
  });
});
