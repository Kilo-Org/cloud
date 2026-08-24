import { UserDeletionStepKey } from '@kilocode/db/schema-types';
import { USER_DELETION_PYLON_API_BASE } from '@/lib/user/deletion-queue/deletion-constants';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';
import { pylonHost, pylonRequest } from '@/lib/user/deletion-queue/handlers/pylon-client';

describe('pylonHost', () => {
  const originalHost = process.env.PYLON_HOST;

  afterEach(() => {
    if (originalHost === undefined) delete process.env.PYLON_HOST;
    else process.env.PYLON_HOST = originalHost;
  });

  it('defaults to the production Pylon API when PYLON_HOST is unset', () => {
    delete process.env.PYLON_HOST;
    expect(pylonHost()).toBe(USER_DELETION_PYLON_API_BASE);
  });

  it('uses PYLON_HOST and strips a trailing slash', () => {
    process.env.PYLON_HOST = 'http://127.0.0.1:4010/';
    expect(pylonHost()).toBe('http://127.0.0.1:4010');
  });
});

describe('pylonRequest', () => {
  const originalHost = process.env.PYLON_HOST;
  const originalKey = process.env.PYLON_API_KEY;

  beforeEach(() => {
    process.env.PYLON_API_KEY = 'test-pylon-key';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalHost === undefined) delete process.env.PYLON_HOST;
    else process.env.PYLON_HOST = originalHost;
    if (originalKey === undefined) delete process.env.PYLON_API_KEY;
    else process.env.PYLON_API_KEY = originalKey;
  });

  it('sends worker fetches to PYLON_HOST', async () => {
    process.env.PYLON_HOST = 'http://127.0.0.1:4010';
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const context: DeletionHandlerContext = {
      requestId: 'req',
      stepKey: UserDeletionStepKey.PylonContact,
      claimToken: 'claim',
      deadlineAt: Date.now() + 60_000,
      remainingMs: () => 60_000,
      signal: new AbortController().signal,
    };
    await pylonRequest(context, 'test-pylon-key', '/contacts/search', { method: 'POST' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:4010/contacts/search',
      expect.objectContaining({ method: 'POST' })
    );
  });
});
