let currentHeaders = new Headers();
const mockHeaders = jest.fn(() => currentHeaders);
const mockGetServerSession = jest.fn();

jest.mock('next/headers', () => ({
  headers: () => mockHeaders(),
  cookies: jest.fn(),
}));

jest.mock('next-auth', () => ({
  __esModule: true,
  ...jest.requireActual('next-auth'),
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/redis', () => ({ redisClient: { get: jest.fn(async () => null) } }));
jest.mock('@/lib/ai-gateway/providers/openrouter', () => ({
  getEnhancedOpenRouterModels: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokModelsForUser: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/experiments/list-available-experiment-models', () => ({
  listAvailableExperimentModels: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/byok', () => ({
  addUserByokAvailability: jest.fn(),
  getUserByokProviderIds: jest.fn(),
}));
jest.mock('@/lib/organizations/organization-models', () => ({
  getAvailableModelsForOrganization: jest.fn(),
}));

import { beforeEach, describe, expect, test } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';
import { GET as gatewayModels } from '@/app/api/gateway/models/route';
import { GET as gatewayV1Models } from '@/app/api/gateway/v1/models/route';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { JWT_TOKEN_VERSION } from '@/lib/tokens';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';

const { getEnhancedOpenRouterModels } = jest.requireMock('@/lib/ai-gateway/providers/openrouter');
const { getDirectByokModelsForUser } = jest.requireMock('@/lib/ai-gateway/providers/direct-byok');
const { listAvailableExperimentModels } = jest.requireMock(
  '@/lib/ai-gateway/experiments/list-available-experiment-models'
);
const { addUserByokAvailability, getUserByokProviderIds } =
  jest.requireMock('@/lib/ai-gateway/byok');
const { getAvailableModelsForOrganization } = jest.requireMock(
  '@/lib/organizations/organization-models'
);

const publicCatalog = { data: [{ id: 'public/model' }] };

function signToken(
  userId: string,
  apiTokenPepper: string | null,
  audience?: string,
  secret = NEXTAUTH_SECRET
) {
  return jwt.sign(
    {
      version: JWT_TOKEN_VERSION,
      kiloUserId: userId,
      apiTokenPepper,
      env: process.env.NODE_ENV,
      ...(audience ? { aud: audience } : {}),
    },
    secret,
    { algorithm: 'HS256' }
  );
}

describe('gateway models audience authentication', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    currentHeaders = new Headers();
    mockHeaders.mockImplementation(() => currentHeaders);
    mockGetServerSession.mockResolvedValue(null);
    getEnhancedOpenRouterModels.mockResolvedValue(publicCatalog);
    getDirectByokModelsForUser.mockResolvedValue([{ id: 'private/byok' }]);
    listAvailableExperimentModels.mockResolvedValue([]);
    getUserByokProviderIds.mockResolvedValue([]);
    addUserByokAvailability.mockImplementation(async (models: unknown[]) => models);
    getAvailableModelsForOrganization.mockResolvedValue({ data: [{ id: 'organization/model' }] });
  });

  test.each([
    ['legacy credential', 'gateway/models', undefined, gatewayModels],
    ['gateway-audience credential', 'gateway/v1/models', KILO_GATEWAY_AUDIENCE, gatewayV1Models],
  ])('%s uses the %s user-specific BYOK path', async (_credential, route, audience, handler) => {
    const user = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
    const token = signToken(user.id, user.api_token_pepper, audience);
    currentHeaders = new Headers({ Authorization: `Bearer ${token}` });

    const response = await handler(
      new NextRequest(`http://localhost/api/${route}`, { headers: currentHeaders })
    );

    expect(await response.json()).toEqual({
      data: [{ id: 'public/model' }, { id: 'private/byok' }],
    });
    expect(getDirectByokModelsForUser).toHaveBeenCalledWith(user.id);
    expect(getUserByokProviderIds).toHaveBeenCalledWith(expect.anything(), user.id);
    expect(getAvailableModelsForOrganization).not.toHaveBeenCalled();
  });

  test.each([
    [
      'API-only audience',
      (user: { id: string; api_token_pepper: string | null }) =>
        signToken(user.id, user.api_token_pepper, KILO_API_AUDIENCE),
    ],
    [
      'worker audience',
      (user: { id: string; api_token_pepper: string | null }) =>
        signToken(user.id, user.api_token_pepper, 'session-ingest'),
    ],
    [
      'wrong signature',
      (user: { id: string; api_token_pepper: string | null }) =>
        signToken(user.id, user.api_token_pepper, KILO_GATEWAY_AUDIENCE, 'wrong-secret'),
    ],
    [
      'wrong audience',
      (user: { id: string; api_token_pepper: string | null }) =>
        signToken(user.id, user.api_token_pepper, 'other-service'),
    ],
  ])('treats %s plus a valid cookie as anonymous', async (_name, createToken) => {
    const user = await insertTestUser({
      api_token_pepper: crypto.randomUUID(),
      web_session_pepper: 'current-web-session-pepper',
    });
    const token = createToken(user);
    currentHeaders = new Headers({
      Authorization: `Bearer ${token}`,
      Cookie: 'next-auth.session-token=valid-cookie',
    });
    mockGetServerSession.mockResolvedValue({
      kiloUserId: user.id,
      webSessionPepper: user.web_session_pepper,
    });

    const response = await gatewayModels(
      new NextRequest('http://localhost/api/gateway/models', { headers: currentHeaders })
    );

    expect(await response.json()).toEqual(publicCatalog);
    expect(mockGetServerSession).not.toHaveBeenCalled();
    expect(getDirectByokModelsForUser).not.toHaveBeenCalled();
    expect(getUserByokProviderIds).not.toHaveBeenCalled();
    expect(getAvailableModelsForOrganization).not.toHaveBeenCalled();
  });
});
