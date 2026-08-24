import type { UserDeletionRequest, UserDeletionStep } from '@kilocode/db/schema';
import { UserDeletionStepKey } from '@kilocode/db/schema-types';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';
import { handleCsaSupportDb } from '@/lib/user/deletion-queue/handlers/csa-support-db';

describe('handleCsaSupportDb', () => {
  const originalSecret = process.env.SUPPORT_API_SECRET;
  const originalBase = process.env.CSA_APP_BASE_URL;

  beforeEach(() => {
    process.env.SUPPORT_API_SECRET = 'shared-support-secret';
    process.env.CSA_APP_BASE_URL = 'https://csa.example.test';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalSecret === undefined) delete process.env.SUPPORT_API_SECRET;
    else process.env.SUPPORT_API_SECRET = originalSecret;
    if (originalBase === undefined) delete process.env.CSA_APP_BASE_URL;
    else process.env.CSA_APP_BASE_URL = originalBase;
  });

  it('succeeds when CSA returns updated', async () => {
    const fetchSpy = mockCsa({ status: 200, body: { status: 'updated' } });
    const outcome = await handleCsaSupportDb(handlerArgs());
    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://csa.example.test/api/internal/cloud/users/gdpr-scrub',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer shared-support-secret',
          'X-Request-Id': 'req-csa',
          'X-Actor-Email': 'customer@example.com',
        }),
      })
    );
  });

  it('treats not_found as not_applicable', async () => {
    mockCsa({ status: 200, body: { status: 'not_found' } });
    await expect(handleCsaSupportDb(handlerArgs())).resolves.toEqual({ kind: 'not_applicable' });
  });

  it('retries a 503', async () => {
    mockCsa({ status: 503, body: { error: 'unavailable' } });
    await expect(handleCsaSupportDb(handlerArgs())).resolves.toMatchObject({
      kind: 'retry',
      errorCode: 'http_503',
    });
  });

  it('retries when CSA_APP_BASE_URL is missing', async () => {
    delete process.env.CSA_APP_BASE_URL;
    await expect(handleCsaSupportDb(handlerArgs())).resolves.toEqual({
      kind: 'retry',
      errorCode: 'csa_base_url_missing',
      httpStatusClass: 'error',
    });
  });

  it('sends a non-kilo actor email and does not block', async () => {
    const fetchSpy = mockCsa({ status: 200, body: { status: 'updated' } });
    const outcome = await handleCsaSupportDb(
      handlerArgs({ requested_by_email: 'customer@example.com' })
    );
    expect(outcome).toEqual({ kind: 'succeeded' });
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Actor-Email']).toBe('customer@example.com');
  });

  it('omits X-Actor-Email when the requester email is missing', async () => {
    const fetchSpy = mockCsa({ status: 200, body: { status: 'updated' } });
    const outcome = await handleCsaSupportDb(handlerArgs({ requested_by_email: null }));
    expect(outcome).toEqual({ kind: 'succeeded' });
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Actor-Email']).toBeUndefined();
  });
});

function handlerArgs(request: Partial<UserDeletionRequest> = {}): {
  request: UserDeletionRequest;
  step: UserDeletionStep;
  context: DeletionHandlerContext;
} {
  return {
    request: {
      id: 'req-csa',
      target_email: 'customer@example.com',
      requested_by_email: 'customer@example.com',
      ...request,
    } as UserDeletionRequest,
    step: {} as UserDeletionStep,
    context: {
      requestId: 'req-csa',
      stepKey: UserDeletionStepKey.CsaSupportDb,
      claimToken: 'claim',
      deadlineAt: Date.now() + 60_000,
      remainingMs: () => 60_000,
      signal: new AbortController().signal,
    },
  };
}

function mockCsa(params: { status: number; body: unknown }) {
  return jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(params.body), { status: params.status }));
}
