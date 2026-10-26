import { NextRequest } from 'next/server';
import { TRPCError } from '@trpc/server';
import jwt from 'jsonwebtoken';

import { buildGlanceableDeliveryForUser } from '@/lib/glanceable-agents-snapshot-server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { signGlanceableSnapshotCredential } from '@kilocode/worker-utils/glanceable-snapshot-credential';
import { GLANCEABLE_SNAPSHOT_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';

const TEST_SECRET = 'glanceable-snapshot-signing-secret';
const mockConfig: { signingSecret: string; legacyEnabled: string | undefined } = {
  signingSecret: TEST_SECRET,
  legacyEnabled: 'false',
};

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  get GLANCEABLE_SNAPSHOT_SIGNING_SECRET() {
    return mockConfig.signingSecret;
  },
  INTERNAL_API_SECRET: 'internal-secret',
  get INTERNAL_SESSION_AUTH_LEGACY_ENABLED() {
    return mockConfig.legacyEnabled;
  },
}));
jest.mock('@/lib/glanceable-agents-snapshot-server', () => ({
  buildGlanceableDeliveryForUser: jest.fn(),
}));
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));

import { POST } from './route';

const mockedAccess = jest.mocked(ensureOrganizationAccess);
const mockedBuild = jest.mocked(buildGlanceableDeliveryForUser);

const USER_ID = 'oauth/user-1';
const ORG_ID = '9d278969-0000-4000-8000-000000000001';

function successBuild() {
  return {
    response: {
      snapshot: { type: 'active_agents_glanceable' },
      details: { followedSessionCount: 0 },
    },
    liveActivitySnapshot: {},
    sessionCards: [
      {
        sessionId: 'ses_1',
        permissionCommand: 'kilo approve ses_1',
        approvalKey: 'approval-key-1',
      },
    ],
  };
}

function abnormalToken(
  options: {
    userId?: string;
    audience?: string;
    expiresIn?: number;
    secret?: string;
  } = {}
): string {
  return jwt.sign(
    { version: 3, kiloUserId: options.userId ?? USER_ID },
    options.secret ?? TEST_SECRET,
    {
      algorithm: 'HS256',
      audience: options.audience ?? GLANCEABLE_SNAPSHOT_AUDIENCE,
      expiresIn: options.expiresIn ?? 5 * 60,
    }
  );
}

async function request(
  options: {
    userId?: string;
    organizationId?: string | null;
    token?: string | null;
    headers?: Record<string, string>;
    body?: unknown;
  } = {}
): Promise<NextRequest> {
  const token =
    options.token === null
      ? null
      : (options.token ??
        (await signGlanceableSnapshotCredential({
          userId: options.userId ?? USER_ID,
          secret: TEST_SECRET,
        })));

  return new NextRequest('https://app.example.test/api/internal/glanceable-agents-snapshot', {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    body: JSON.stringify(
      options.body ?? {
        userId: options.userId ?? USER_ID,
        organizationId: options.organizationId === undefined ? ORG_ID : options.organizationId,
      }
    ),
  });
}

describe('POST /api/internal/glanceable-agents-snapshot', () => {
  beforeEach(() => {
    mockConfig.signingSecret = TEST_SECRET;
    mockConfig.legacyEnabled = 'false';
    mockedAccess.mockReset();
    mockedAccess.mockResolvedValue('member' as never);
    mockedBuild.mockReset();
    mockedBuild.mockResolvedValue(successBuild() as never);
  });

  it('returns the snapshot to the intended sender with no-store', async () => {
    const response = await POST(await request());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mockedAccess).toHaveBeenCalledWith(expect.anything(), ORG_ID);
    expect(mockedBuild).toHaveBeenCalledWith({ userId: USER_ID, organizationId: ORG_ID });
    await expect(response.json()).resolves.toMatchObject({
      type: 'active_agents_glanceable',
      homeWidgetDetails: { followedSessionCount: 0 },
      liveActivitySnapshot: {},
      sessionCards: [
        {
          sessionId: 'ses_1',
          permissionCommand: 'kilo approve ses_1',
          approvalKey: 'approval-key-1',
        },
      ],
    });
  });

  it('rejects the general internal secret when compatibility is disabled', async () => {
    const response = await POST(
      await request({
        token: null,
        headers: { 'x-internal-secret': 'internal-secret' },
      })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'true'])(
    'accepts a legacy caller while compatibility is %s',
    async value => {
      mockConfig.legacyEnabled = value;
      mockConfig.signingSecret = '';
      const response = await POST(
        await request({ token: null, headers: { 'X-Internal-Secret': 'internal-secret' } })
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(mockedAccess).toHaveBeenCalledWith(expect.anything(), ORG_ID);
      expect(mockedBuild).toHaveBeenCalledWith({ userId: USER_ID, organizationId: ORG_ID });
    }
  );

  it.each(['false', 'FALSE', 'invalid'])('rejects legacy auth with flag %s', async value => {
    mockConfig.legacyEnabled = value;
    const response = await POST(
      await request({ token: null, headers: { 'X-Internal-Secret': 'internal-secret' } })
    );
    expect(response.status).toBe(401);
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it('rejects an incorrect legacy secret during compatibility', async () => {
    mockConfig.legacyEnabled = 'true';
    const response = await POST(
      await request({ token: null, headers: { 'X-Internal-Secret': 'incorrect-secret' } })
    );
    expect(response.status).toBe(401);
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it.each<{ headers: Record<string, string>; authMethod: 'legacy' | 'bearer' }>([
    { headers: {}, authMethod: 'legacy' },
    { headers: { 'X-Internal-Secret': 'incorrect-secret' }, authMethod: 'legacy' },
    {
      headers: { authorization: 'Bearer not-a-jwt', 'X-Internal-Secret': 'internal-secret' },
      authMethod: 'bearer',
    },
  ])('audits rejected $authMethod authentication', async ({ headers, authMethod }) => {
    mockConfig.legacyEnabled = 'true';
    const audit = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const response = await POST(await request({ token: null, headers }));

      expect(response.status).toBe(401);
      expect(audit).toHaveBeenCalledTimes(1);
      expect(JSON.parse(audit.mock.calls[0][0])).toMatchObject({
        type: 'glanceable_agents_snapshot',
        outcome: 'unauthorized',
        status: 401,
        authMethod,
      });
    } finally {
      audit.mockRestore();
    }
  });

  it.each(['', 'Basic malformed', 'Bearer ', 'Bearer not-a-jwt'])(
    'does not replace Authorization %j with a valid legacy credential',
    async authorization => {
      mockConfig.legacyEnabled = 'true';
      const response = await POST(
        await request({
          token: null,
          headers: { authorization, 'X-Internal-Secret': 'internal-secret' },
        })
      );
      expect(response.status).toBe(401);
      expect(mockedBuild).not.toHaveBeenCalled();
    }
  );

  it.each([
    { claims: { expiresIn: -1 }, status: 401 },
    { claims: { audience: 'another-service' }, status: 401 },
    { claims: { secret: 'internal-secret' }, status: 401 },
    { claims: { userId: 'oauth/another-user' }, status: 403 },
  ])('preserves bearer checks with a legacy header: %j', async ({ claims, status }) => {
    mockConfig.legacyEnabled = 'true';
    const response = await POST(
      await request({
        token: abnormalToken(claims),
        headers: { 'X-Internal-Secret': 'internal-secret' },
      })
    );
    expect(response.status).toBe(status);
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it('still checks organization access for legacy callers', async () => {
    mockConfig.legacyEnabled = 'true';
    mockedAccess.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    const response = await POST(
      await request({ token: null, headers: { 'X-Internal-Secret': 'internal-secret' } })
    );
    expect(response.status).toBe(403);
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it('uses the bearer when both credentials are present', async () => {
    mockConfig.legacyEnabled = 'true';
    const audit = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const response = await POST(
        await request({ headers: { 'X-Internal-Secret': 'incorrect-secret' } })
      );
      expect(response.status).toBe(200);
      expect(audit).toHaveBeenCalledWith(expect.stringContaining('"authMethod":"bearer"'));
    } finally {
      audit.mockRestore();
    }
  });

  it('rejects a credential signed with the general internal secret', async () => {
    const response = await POST(
      await request({ token: abnormalToken({ secret: 'internal-secret' }) })
    );

    expect(response.status).toBe(401);
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it('rejects a request without a credential', async () => {
    const response = await POST(await request({ token: null }));

    expect(response.status).toBe(401);
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it('rejects a malformed credential', async () => {
    const response = await POST(await request({ token: 'not-a-jwt' }));

    expect(response.status).toBe(401);
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it('rejects an expired credential', async () => {
    const response = await POST(await request({ token: abnormalToken({ expiresIn: -1 }) }));

    expect(response.status).toBe(401);
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it('rejects a credential for another audience', async () => {
    const response = await POST(
      await request({ token: abnormalToken({ audience: 'another-service' }) })
    );

    expect(response.status).toBe(401);
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it('rejects a credential whose subject is a different user', async () => {
    const response = await POST(
      await request({ token: abnormalToken({ userId: 'oauth/user-2' }) })
    );

    expect(response.status).toBe(403);
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it('rejects an invalid body before any data read', async () => {
    const response = await POST(await request({ body: { userId: USER_ID } }));

    expect(response.status).toBe(400);
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it('returns 503 when the dedicated signing secret is missing', async () => {
    mockConfig.signingSecret = '';

    const response = await POST(await request());

    expect(response.status).toBe(503);
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it.each(['UNAUTHORIZED', 'FORBIDDEN'] as const)(
    'answers 403 for a %s access denial',
    async code => {
      mockedAccess.mockRejectedValue(new TRPCError({ code }));
      const response = await POST(await request());
      expect(response.status).toBe(403);
      expect(mockedBuild).not.toHaveBeenCalled();
    }
  );

  it('answers 500 when the access check itself fails', async () => {
    // The worker ends every session card on a 403, so a database failure must
    // not look like a lost scope.
    mockedAccess.mockRejectedValue(new Error('connection reset'));
    const response = await POST(await request());
    expect(response.status).toBe(500);
    expect(mockedBuild).not.toHaveBeenCalled();
  });
});
