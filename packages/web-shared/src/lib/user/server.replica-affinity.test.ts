import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { User } from '@kilocode/db/schema';
import { KILO_TOKEN_VERSION } from '@kilocode/worker-utils/kilo-token';
import {
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  issueRuntimeProxyAttestation,
  RUNTIME_PROXY_ATTESTATION_HEADER,
} from '@kilocode/worker-utils/runtime-proxy-attestation';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import type * as Affinity from '@kilocode/web-shared/lib/read-replica-affinity';
import {
  replicaAffinityHash,
  runWithReplicaAffinity,
  setVerifiedReplicaUser,
} from '@kilocode/web-shared/lib/read-replica-affinity';

const mockFindFirst = jest.fn();
const mockGetServerSession = jest.fn();

jest.mock('next/headers', () => ({ headers: jest.fn(), cookies: jest.fn() }));
jest.mock('next-auth', () => ({ getServerSession: () => mockGetServerSession() }));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'fixture-only-replica-affinity-secret',
}));
jest.mock('@kilocode/web-shared/lib/dotenvx', () => ({ getEnvVariable: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/drizzle', () => {
  const client = {
    query: { kilocode_users: { findFirst: (...args: unknown[]) => mockFindFirst(...args) } },
  };
  return { db: client, readDb: client };
});
jest.mock('@kilocode/web-shared/lib/user/domain-gates', () => ({
  isUserBlacklistedByDomain: async () => false,
}));
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  warnExceptInTest: jest.fn(),
  logExceptInTest: jest.fn(),
  sentryLogger: () => jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/read-replica-affinity', () => {
  const actual = jest.requireActual<typeof Affinity>(
    '@kilocode/web-shared/lib/read-replica-affinity'
  );
  return { ...actual, setVerifiedReplicaUser: jest.fn(actual.setVerifiedReplicaUser) };
});

const secret = 'fixture-only-replica-affinity-secret';
const ip = '192.0.2.42';
const user = {
  id: 'oauth/replica-affinity-fixture',
  api_token_pepper: 'fixture-pepper',
  web_session_pepper: 'fixture-session-pepper',
  google_user_email: 'replica-affinity@example.com',
  blocked_at: null,
  blocked_reason: null,
  is_admin: false,
} as User;
const runtimeAuthorization = {
  id: '11111111-1111-4111-8111-111111111111',
  resourceKind: 'cloud-agent-next',
  resourceId: 'fixture-resource',
};

function signToken(overrides: Record<string, unknown> = {}, signingSecret = secret) {
  return jwt.sign(
    {
      version: KILO_TOKEN_VERSION,
      kiloUserId: user.id,
      apiTokenPepper: user.api_token_pepper,
      env: 'test',
      aud: KILO_API_AUDIENCE,
      ...overrides,
    },
    signingSecret,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
}

function hash(key: string) {
  return createHash('sha256').update(key).digest().readUInt32BE(0);
}

function requestHeaders(token: string, attestation?: string) {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (attestation) headers.set(RUNTIME_PROXY_ATTESTATION_HEADER, attestation);
  return headers;
}

async function authenticate(headers: Headers) {
  return runWithReplicaAffinity(ip, async () => {
    const initialHash = replicaAffinityHash();
    const result = await getUserFromAuth({ adminOnly: false, requestHeaders: headers });
    return { initialHash, finalHash: replicaAffinityHash(), result };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockFindFirst.mockImplementation(async () => {
    expect(replicaAffinityHash()).toBe(hash(`user:${user.id}`));
    expect(setVerifiedReplicaUser).toHaveBeenCalledWith(user.id);
    return user;
  });
});

afterEach(() => jest.restoreAllMocks());

describe('verified authentication replica affinity', () => {
  test('binds a signed, audience-valid bearer before the first user query', async () => {
    const { initialHash, finalHash, result } = await authenticate(requestHeaders(signToken()));

    expect(initialHash).toBe(hash(`ip:${ip}`));
    expect(finalHash).toBe(hash(`user:${user.id}`));
    expect(result.user?.id).toBe(user.id);
    expect(mockFindFirst).toHaveBeenCalledTimes(1);
    expect(setVerifiedReplicaUser).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['invalid signature', () => signToken({}, 'wrong-fixture-secret')],
    ['wrong audience', () => signToken({ aud: KILO_GATEWAY_AUDIENCE })],
  ])('does not bind a bearer with %s', async (_reason, token) => {
    const { initialHash, finalHash, result } = await authenticate(requestHeaders(token()));

    expect(result.authFailedResponse?.status).toBe(401);
    expect(result.credentialsRejected).toBe(true);
    expect(initialHash).toBe(hash(`ip:${ip}`));
    expect(finalHash).toBe(initialHash);
    expect(setVerifiedReplicaUser).not.toHaveBeenCalled();
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  test('requires a valid runtime proxy attestation before binding', async () => {
    const token = signToken({ runtimeAuthorization });
    const attestation = await issueRuntimeProxyAttestation({
      secret,
      audience: KILO_API_AUDIENCE,
      userId: user.id,
      authorizationId: runtimeAuthorization.id,
      resourceId: runtimeAuthorization.resourceId,
      bearer: token,
    });
    const forgedAttestation = await issueRuntimeProxyAttestation({
      secret: 'wrong-fixture-secret',
      audience: KILO_API_AUDIENCE,
      userId: user.id,
      authorizationId: runtimeAuthorization.id,
      resourceId: runtimeAuthorization.resourceId,
      bearer: token,
    });
    const otherBearerAttestation = await issueRuntimeProxyAttestation({
      secret,
      audience: KILO_API_AUDIENCE,
      userId: user.id,
      authorizationId: runtimeAuthorization.id,
      resourceId: runtimeAuthorization.resourceId,
      bearer: signToken(),
    });

    for (const invalidAttestation of [undefined, forgedAttestation, otherBearerAttestation]) {
      const rejected = await authenticate(requestHeaders(token, invalidAttestation));
      expect(rejected.result.authFailedResponse?.status).toBe(401);
      expect(rejected.result.credentialsRejected).toBe(true);
      expect(rejected.finalHash).toBe(hash(`ip:${ip}`));
      expect(setVerifiedReplicaUser).not.toHaveBeenCalled();
      expect(mockFindFirst).not.toHaveBeenCalled();
    }

    const accepted = await authenticate(requestHeaders(token, attestation));
    expect(accepted.result.user?.id).toBe(user.id);
    expect(accepted.result.cloudAgentRuntimeProxied).toBe(true);
    expect(accepted.finalHash).toBe(hash(`user:${user.id}`));
    expect(mockFindFirst).toHaveBeenCalledTimes(1);
    expect(setVerifiedReplicaUser).toHaveBeenCalledTimes(1);
  });

  test('binds a NextAuth-resolved session subject before the first user query', async () => {
    mockGetServerSession.mockResolvedValue({
      kiloUserId: user.id,
      webSessionPepper: user.web_session_pepper,
    });

    const { initialHash, finalHash, result } = await authenticate(new Headers());

    expect(initialHash).toBe(hash(`ip:${ip}`));
    expect(finalHash).toBe(hash(`user:${user.id}`));
    expect(result.user?.id).toBe(user.id);
    expect(mockGetServerSession).toHaveBeenCalledTimes(1);
    expect(mockFindFirst).toHaveBeenCalledTimes(1);
    expect(setVerifiedReplicaUser).toHaveBeenCalledTimes(1);
  });
});
