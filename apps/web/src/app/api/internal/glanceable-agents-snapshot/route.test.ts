import { NextRequest } from 'next/server';
import { TRPCError } from '@trpc/server';

import { buildGlanceableDeliveryForUser } from '@/lib/glanceable-agents-snapshot-server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'glanceable-snapshot-secret',
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

function request(): NextRequest {
  return new NextRequest('https://app.example.test/api/internal/glanceable-agents-snapshot', {
    method: 'POST',
    headers: { 'x-internal-secret': 'glanceable-snapshot-secret' },
    body: JSON.stringify({ userId: 'oauth/user-1', organizationId: 'org-1' }),
  });
}

describe('POST /api/internal/glanceable-agents-snapshot', () => {
  beforeEach(() => {
    mockedAccess.mockReset();
    mockedBuild.mockReset();
  });

  it.each(['UNAUTHORIZED', 'FORBIDDEN'] as const)(
    'answers 403 for a %s access denial',
    async code => {
      mockedAccess.mockRejectedValue(new TRPCError({ code }));
      const response = await POST(request());
      expect(response.status).toBe(403);
      expect(mockedBuild).not.toHaveBeenCalled();
    }
  );

  it('answers 500 when the access check itself fails', async () => {
    // The worker ends every session card on a 403, so a database failure must
    // not look like a lost scope.
    mockedAccess.mockRejectedValue(new Error('connection reset'));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(mockedBuild).not.toHaveBeenCalled();
  });
});
