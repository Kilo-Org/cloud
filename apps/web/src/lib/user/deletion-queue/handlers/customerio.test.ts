import type { UserDeletionRequest, UserDeletionStep } from '@kilocode/db/schema';
import { UserDeletionStepKey } from '@kilocode/db/schema-types';
import { USER_DELETION_CUSTOMERIO_TRACK_BASE } from '@/lib/user/deletion-queue/deletion-constants';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';
import {
  customerioTrackBase,
  handleCustomerio,
} from '@/lib/user/deletion-queue/handlers/customerio';

describe('customerioTrackBase', () => {
  const originalBase = process.env.CUSTOMERIO_TRACK_BASE;

  afterEach(() => {
    if (originalBase === undefined) delete process.env.CUSTOMERIO_TRACK_BASE;
    else process.env.CUSTOMERIO_TRACK_BASE = originalBase;
  });

  it('defaults to the production Track API when CUSTOMERIO_TRACK_BASE is unset', () => {
    delete process.env.CUSTOMERIO_TRACK_BASE;
    expect(customerioTrackBase()).toBe(USER_DELETION_CUSTOMERIO_TRACK_BASE);
  });

  it('uses CUSTOMERIO_TRACK_BASE and strips a trailing slash', () => {
    process.env.CUSTOMERIO_TRACK_BASE = 'http://127.0.0.1:4010/';
    expect(customerioTrackBase()).toBe('http://127.0.0.1:4010');
  });
});

describe('handleCustomerio host override', () => {
  const originalBase = process.env.CUSTOMERIO_TRACK_BASE;
  const originalSiteId = process.env.CUSTOMERIO_SITE_ID;
  const originalApiKey = process.env.CUSTOMERIO_API_KEY;

  beforeEach(() => {
    process.env.CUSTOMERIO_TRACK_BASE = 'http://127.0.0.1:4010';
    process.env.CUSTOMERIO_SITE_ID = 'site';
    process.env.CUSTOMERIO_API_KEY = 'key';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalBase === undefined) delete process.env.CUSTOMERIO_TRACK_BASE;
    else process.env.CUSTOMERIO_TRACK_BASE = originalBase;
    if (originalSiteId === undefined) delete process.env.CUSTOMERIO_SITE_ID;
    else process.env.CUSTOMERIO_SITE_ID = originalSiteId;
    if (originalApiKey === undefined) delete process.env.CUSTOMERIO_API_KEY;
    else process.env.CUSTOMERIO_API_KEY = originalApiKey;
  });

  it('DELETEs the customer on CUSTOMERIO_TRACK_BASE', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    const outcome = await handleCustomerio({
      request: { target_email: 'ok@local.test' } as UserDeletionRequest,
      step: {} as UserDeletionStep,
      context: handlerContext(),
    });

    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:4010/api/v1/customers/ok%40local.test',
      expect.objectContaining({ method: 'DELETE' })
    );
  });
});

function handlerContext(): DeletionHandlerContext {
  return {
    requestId: 'req-cio',
    stepKey: UserDeletionStepKey.Customerio,
    claimToken: 'claim',
    deadlineAt: Date.now() + 60_000,
    remainingMs: () => 60_000,
    signal: new AbortController().signal,
  };
}
