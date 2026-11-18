import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import {
  baseProcedure,
  createTRPCRouter,
  createTRPCContext,
} from '@kilocode/web-shared/lib/trpc/init';
import { generateApiToken } from '@kilocode/web-shared/lib/tokens';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';

const mockGetServerSession = jest.fn<(options: unknown) => Promise<unknown>>();
jest.mock('next-auth', () => ({
  __esModule: true,
  getServerSession: (options: unknown) => mockGetServerSession(options),
}));

const provenanceRouter = createTRPCRouter({
  provenance: baseProcedure.query(({ ctx }) => ({
    authViaToken: ctx.authViaToken,
    credential: ctx.credential,
    tokenSource: ctx.tokenSource,
  })),
  provenanceMutation: baseProcedure.mutation(({ ctx }) => ({
    authViaToken: ctx.authViaToken,
    credential: ctx.credential,
    tokenSource: ctx.tokenSource,
  })),
});

let user: User;
let token: string;

beforeAll(async () => {
  user = await insertTestUser({
    google_user_email: `trpc-provenance-${crypto.randomUUID()}@example.com`,
    api_token_pepper: `trpc-provenance-pepper-${crypto.randomUUID()}`,
    web_session_pepper: 'current-web-session-pepper',
  });
  token = generateApiToken(user);
});

function callProvenance(request: Request) {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req: request,
    router: provenanceRouter,
    createContext: createTRPCContext,
  });
}

describe('tRPC credential provenance', () => {
  test('a GET query with Authorization is classified as bearer, never as session', async () => {
    const url = new URL('http://localhost/api/trpc/provenance');
    url.searchParams.set('input', JSON.stringify({}));

    const response = await callProvenance(
      new Request(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { data: unknown } };
    expect(body.result.data).toMatchObject({
      authViaToken: true,
      credential: 'human_bearer',
    });
  });

  test('a batched GET request is classified as bearer for every call', async () => {
    const url = new URL('http://localhost/api/trpc/provenance,provenance');
    url.searchParams.set('batch', '1');
    url.searchParams.set('input', JSON.stringify({ 0: {}, 1: {} }));

    const response = await callProvenance(
      new Request(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ result: { data: unknown } }>;
    expect(body).toHaveLength(2);
    for (const call of body) {
      expect(call.result.data).toMatchObject({
        authViaToken: true,
        credential: 'human_bearer',
      });
    }
  });

  test('a batched POST request is classified as bearer for every call', async () => {
    const response = await callProvenance(
      new Request('http://localhost/api/trpc/provenanceMutation,provenanceMutation?batch=1', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ 0: {}, 1: {} }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ result: { data: unknown } }>;
    expect(body).toHaveLength(2);
    for (const call of body) {
      expect(call.result.data).toMatchObject({
        authViaToken: true,
        credential: 'human_bearer',
      });
    }
  });

  test('an empty Authorization header never falls back to a valid session', async () => {
    const url = new URL('http://localhost/api/trpc/provenance');
    url.searchParams.set('input', JSON.stringify({}));
    mockGetServerSession.mockResolvedValue({
      kiloUserId: user.id,
      webSessionPepper: 'current-web-session-pepper',
      isNewUser: false,
    });

    const response = await callProvenance(
      new Request(url, {
        method: 'GET',
        headers: {
          authorization: '',
          cookie: 'next-auth.session-token=valid-session',
        },
      })
    );

    expect(response.status).toBe(401);
  });
});
