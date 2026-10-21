import type { UserDeletionRequest, UserDeletionStep } from '@kilocode/db/schema';
import { UserDeletionStepKey } from '@kilocode/db/schema-types';
import { getDeletionHandler } from '@/lib/user/deletion-queue/handlers';

describe('deletion handler registry', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('treats legacy CSA support DB work as not applicable without fetching', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected fetch'));
    const handler = getDeletionHandler(UserDeletionStepKey.CsaSupportDb);

    await expect(
      handler({
        request: { id: 'legacy-csa', target_email: 'customer@example.com' } as UserDeletionRequest,
        step: { step_key: UserDeletionStepKey.CsaSupportDb } as UserDeletionStep,
        context: {
          requestId: 'legacy-csa',
          stepKey: UserDeletionStepKey.CsaSupportDb,
          claimToken: 'claim',
          deadlineAt: Date.now() + 60_000,
          remainingMs: () => 60_000,
          signal: new AbortController().signal,
        },
      })
    ).resolves.toEqual({ kind: 'not_applicable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
