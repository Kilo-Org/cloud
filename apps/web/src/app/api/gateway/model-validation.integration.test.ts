import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
const mockFetchSessionMetadata = jest.fn();
const mockGetRuntimeToken = jest.fn();
jest.mock('../../../../../../services/cloud-agent-next/src/session-service', () => ({
  fetchSessionMetadata: (...args: unknown[]) => mockFetchSessionMetadata(...args),
}));
jest.mock('../../../../../../services/cloud-agent-next/src/sandbox-session/session-stub', () => ({
  resolveSessionStub: () => ({ getRuntimeToken: () => mockGetRuntimeToken() }),
}));
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

jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual('@sentry/nextjs'),
  captureException: jest.fn(),
}));
jest.mock('@/lib/redis', () => ({ redisClient: { get: jest.fn(async () => null) } }));
jest.mock('@/lib/ai-gateway/providers/openrouter', () => ({
  getEnhancedOpenRouterModels: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokModelsForUser: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/byok', () => ({
  addUserByokAvailability: jest.fn(),
  getUserByokProviderIds: jest.fn(),
}));
jest.mock('@/lib/organizations/organization-models', () => ({
  getAvailableModelsForOrganization: jest.fn(),
}));

import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { POST as personalValidator } from '@/app/api/openrouter/models/validate/route';
import { POST as organizationValidator } from '@/app/api/organizations/[id]/models/validate/route';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import { RUNTIME_PROXY_ATTESTATION_HEADER } from '@kilocode/worker-utils/runtime-proxy-attestation';

jest.mock('../../../../../../services/cloud-agent-next/src/logger', () => ({
  logger: { withFields: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
}));
import jwt from 'jsonwebtoken';
import { JWT_TOKEN_VERSION } from '@/lib/tokens';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';

const { getEnhancedOpenRouterModels } = jest.requireMock('@/lib/ai-gateway/providers/openrouter');
const { getDirectByokModelsForUser } = jest.requireMock('@/lib/ai-gateway/providers/direct-byok');
const { addUserByokAvailability, getUserByokProviderIds } =
  jest.requireMock('@/lib/ai-gateway/byok');
const { getAvailableModelsForOrganization } = jest.requireMock(
  '@/lib/organizations/organization-models'
);

const publicCatalog = { data: [{ id: 'public/model' }] };

// Load the real Worker implementations at runtime without adding Worker ambient
// types and their transitive service graph to the web TypeScript project.
type ValidationEnv = { KILOCODE_BACKEND_BASE_URL: string; NEXTAUTH_SECRET: string };
type TestSessionMetadata = {
  metadataSchemaVersion: 2;
  identity: { sessionId: string; userId: string };
  auth: { kilocodeToken: string };
  agent: { model: string };
  workspace: Record<string, never>;
  lifecycle: { version: number; timestamp: number };
};
const { assertKiloModelAvailable } = jest.requireActual<{
  assertKiloModelAvailable(input: {
    env: ValidationEnv;
    submittedModel: string;
    originalToken: string;
    originalOrganizationId?: string;
    procedure: string;
  }): Promise<void>;
}>('../../../../../../services/cloud-agent-next/src/model-validation');
const { preflightExistingPromptModel } = jest.requireActual<{
  preflightExistingPromptModel(input: {
    env: ValidationEnv;
    userId: string;
    cloudAgentSessionId: string;
    procedure: string;
  }): Promise<void>;
}>('../../../../../../services/cloud-agent-next/src/session/model-preflight');
const { renewStoredRuntimeAuthorization } = jest.requireActual<{
  renewStoredRuntimeAuthorization(input: {
    metadata: TestSessionMetadata;
    getAuthorization(): Promise<RuntimeAuthorization>;
    putAuthorization(authorization: RuntimeAuthorization): Promise<void>;
    getMetadata(): Promise<TestSessionMetadata>;
    putMetadata(metadata: TestSessionMetadata): Promise<void>;
    renew(authorization: RuntimeAuthorization): Promise<{ token: string }>;
  }): Promise<string | null>;
}>('../../../../../../services/cloud-agent-next/src/session/runtime-authorization-persistence');

const backend = 'https://backend.kilo.test';
const env = { KILOCODE_BACKEND_BASE_URL: backend, NEXTAUTH_SECRET };
const privateModel = 'private/byok';
let proofMode: 'valid' | 'absent' | 'bad' = 'valid';

async function runtimeToken(
  user: { id: string; api_token_pepper: string | null },
  organizationId?: string
) {
  return (
    await signModernKiloToken({
      userId: user.id,
      pepper: user.api_token_pepper,
      secret: NEXTAUTH_SECRET,
      expiresInSeconds: 3600,
      env: process.env.NODE_ENV,
      audience: [KILO_API_AUDIENCE, KILO_GATEWAY_AUDIENCE, 'session-ingest'],
      tokenPurpose: 'delegated-workload',
      credentialExchange: false,
      extra: {
        ...(organizationId ? { organizationId } : {}),
        runtimeAuthorization: {
          id: crypto.randomUUID(),
          resourceKind: 'cloud-agent-next',
          resourceId: 'agent-session',
        },
      },
    })
  ).token;
}

describe('cloud-agent model validation through real web authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    proofMode = 'valid';
    currentHeaders = new Headers();
    mockGetServerSession.mockResolvedValue(null);
    getEnhancedOpenRouterModels.mockResolvedValue(publicCatalog);
    getDirectByokModelsForUser.mockResolvedValue([]);
    getUserByokProviderIds.mockResolvedValue([]);
    addUserByokAvailability.mockImplementation(async (models: unknown[]) => models);
    getAvailableModelsForOrganization.mockResolvedValue({ data: [] });
    jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      currentHeaders = new Headers(init?.headers);
      if (proofMode === 'absent') currentHeaders.delete(RUNTIME_PROXY_ATTESTATION_HEADER);
      if (proofMode === 'bad')
        currentHeaders.set(RUNTIME_PROXY_ATTESTATION_HEADER, 'invalid-proof');
      const request = new NextRequest(String(url), {
        ...init,
        signal: init?.signal ?? undefined,
        headers: currentHeaders,
      });
      const match = new URL(String(url)).pathname.match(
        /^\/api\/organizations\/([^/]+)\/models\/validate$/
      );
      return match
        ? organizationValidator(request, {
            params: Promise.resolve({ id: decodeURIComponent(match[1]) }),
          })
        : personalValidator(request);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  test.each(['runtime_authorized_session_create', 'send'])(
    'personal private model passes %s with a signed runtime credential',
    async procedure => {
      const user = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
      getDirectByokModelsForUser.mockImplementation(async (id: string) =>
        id === user.id ? [{ id: privateModel }] : []
      );
      await expect(
        assertKiloModelAvailable({
          env,
          submittedModel: privateModel,
          originalToken: await runtimeToken(user),
          procedure,
        })
      ).resolves.toBeUndefined();
      expect(getDirectByokModelsForUser).toHaveBeenCalledWith(user.id);
    }
  );

  test.each(['runtime_authorized_session_create', 'send'])(
    'organization private model passes %s with a signed runtime credential',
    async procedure => {
      const user = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
      const org = await createTestOrganization('model-validation', user.id, 0);
      getAvailableModelsForOrganization.mockImplementation(async (id: string) => ({
        data: id === org.id ? [{ id: privateModel }] : [],
      }));
      await expect(
        assertKiloModelAvailable({
          env,
          submittedModel: privateModel,
          originalToken: await runtimeToken(user, org.id),
          originalOrganizationId: org.id,
          procedure,
        })
      ).resolves.toBeUndefined();
      expect(getAvailableModelsForOrganization).toHaveBeenCalledWith(org.id, {
        type: 'member',
        kiloUserId: user.id,
        allowNonMember: true,
      });
    }
  );

  test.each(['active', 'revoked', 'expired'] as const)(
    'expired backing JWT preflight uses the %s delegation',
    async state => {
      const user = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
      const now = Date.now();
      const id = crypto.randomUUID();
      const extra = {
        runtimeAuthorization: {
          id,
          resourceKind: 'cloud-agent-next' as const,
          resourceId: 'agent-session',
        },
      };
      const sign = (issuedAt: Date) =>
        signModernKiloToken({
          userId: user.id,
          pepper: user.api_token_pepper,
          secret: NEXTAUTH_SECRET,
          expiresInSeconds: 3600,
          env: process.env.NODE_ENV,
          audience: [KILO_API_AUDIENCE, KILO_GATEWAY_AUDIENCE],
          tokenPurpose: 'delegated-workload',
          credentialExchange: false,
          extra,
          now: issuedAt,
        });
      let metadata: TestSessionMetadata = {
        metadataSchemaVersion: 2,
        identity: { sessionId: 'agent-session', userId: user.id },
        auth: { kilocodeToken: (await sign(new Date(now - 7200000))).token },
        agent: { model: privateModel },
        workspace: {},
        lifecycle: { version: 1, timestamp: now },
      };
      const record: RuntimeAuthorization = {
        version: 1,
        id,
        resourceKind: 'cloud-agent-next',
        resourceId: 'agent-session',
        userId: user.id,
        authorizationUserId: user.id,
        issuedAt: new Date(now - 10800000).toISOString(),
        delegationExpiresAt: new Date(
          state === 'expired' ? now - 1000 : now + 10800000
        ).toISOString(),
        state: state === 'revoked' ? 'revoked' : 'active',
        bindings: { userPepperDigest: 'a'.repeat(64), authorizationPepperDigest: 'a'.repeat(64) },
        source: { admissionSource: 'user' },
      };
      const renew = jest.fn(async () => sign(new Date()));
      mockFetchSessionMetadata.mockImplementation(async () => metadata);
      // Exercise the same persistence/renewal function used by the owning DO's RPC.
      mockGetRuntimeToken.mockImplementation(() =>
        renewStoredRuntimeAuthorization({
          metadata,
          getAuthorization: async () => record,
          putAuthorization: async () => {},
          getMetadata: async () => metadata,
          putMetadata: async value => {
            metadata = value;
          },
          renew,
        })
      );
      getDirectByokModelsForUser.mockResolvedValue([{ id: privateModel }]);
      const validation = preflightExistingPromptModel({
        env,
        userId: user.id,
        cloudAgentSessionId: 'agent-session',
        procedure: 'send',
      });
      if (state === 'active') {
        await expect(validation).resolves.toBeUndefined();
        expect(renew).toHaveBeenCalledTimes(1);
        expect(getDirectByokModelsForUser).toHaveBeenCalledWith(user.id);
      } else {
        await expect(validation).rejects.toThrow();
        expect(renew).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
      }
      expect(mockGetRuntimeToken).toHaveBeenCalledTimes(1);
    }
  );

  test('legacy personal and organization private catalogs remain available', async () => {
    const user = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
    const org = await createTestOrganization('legacy-model-validation', user.id, 0);
    getDirectByokModelsForUser.mockResolvedValue([{ id: privateModel }]);
    getAvailableModelsForOrganization.mockResolvedValue({ data: [{ id: privateModel }] });
    const bearer = jwt.sign(
      {
        version: JWT_TOKEN_VERSION,
        kiloUserId: user.id,
        apiTokenPepper: user.api_token_pepper,
        env: process.env.NODE_ENV,
      },
      NEXTAUTH_SECRET
    );
    for (const organizationId of [undefined, org.id]) {
      await expect(
        assertKiloModelAvailable({
          env,
          submittedModel: privateModel,
          originalToken: bearer,
          originalOrganizationId: organizationId,
          procedure: 'start',
        })
      ).resolves.toBeUndefined();
    }
  });

  test('organization members cannot select an unavailable private model', async () => {
    const user = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
    const org = await createTestOrganization('unavailable-model-validation', user.id, 0);
    getAvailableModelsForOrganization.mockResolvedValue({
      data: [{ id: 'another/private-model' }],
    });
    await expect(
      assertKiloModelAvailable({
        env,
        submittedModel: privateModel,
        originalToken: await runtimeToken(user, org.id),
        originalOrganizationId: org.id,
        procedure: 'send',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('a foreign user cannot select another personal private model', async () => {
    const owner = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
    const foreign = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
    getDirectByokModelsForUser.mockImplementation(async (id: string) =>
      id === owner.id ? [{ id: privateModel }] : []
    );
    await expect(
      assertKiloModelAvailable({
        env,
        submittedModel: privateModel,
        originalToken: await runtimeToken(foreign),
        procedure: 'send',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('a non-member cannot validate an organization private model', async () => {
    const owner = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
    const foreign = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
    const org = await createTestOrganization('foreign-model-validation', owner.id, 0);
    getAvailableModelsForOrganization.mockResolvedValue({ data: [{ id: privateModel }] });
    await expect(
      assertKiloModelAvailable({
        env,
        submittedModel: privateModel,
        originalToken: await runtimeToken(foreign, org.id),
        originalOrganizationId: org.id,
        procedure: 'send',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(getAvailableModelsForOrganization).not.toHaveBeenCalled();
  });

  test.each(['absent', 'bad'] as const)(
    '%s proof cannot authenticate private catalogs',
    async mode => {
      const user = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
      const org = await createTestOrganization('proof-model-validation', user.id, 0);
      getDirectByokModelsForUser.mockResolvedValue([{ id: privateModel }]);
      getAvailableModelsForOrganization.mockResolvedValue({ data: [{ id: privateModel }] });
      proofMode = mode;
      await expect(
        assertKiloModelAvailable({
          env,
          submittedModel: privateModel,
          originalToken: await runtimeToken(user),
          procedure: 'start',
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        assertKiloModelAvailable({
          env,
          submittedModel: privateModel,
          originalToken: await runtimeToken(user, org.id),
          originalOrganizationId: org.id,
          procedure: 'send',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(getDirectByokModelsForUser).not.toHaveBeenCalled();
      expect(getAvailableModelsForOrganization).not.toHaveBeenCalled();
    }
  );
});
