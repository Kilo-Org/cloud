import { UserDeletionStepKey } from '@kilocode/db/schema-types';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';
import { providerAbortSignal } from '@/lib/user/deletion-queue/handlers/common';

function context(signal: AbortSignal, remainingMs = 60_000): DeletionHandlerContext {
  return {
    requestId: 'req',
    stepKey: UserDeletionStepKey.Customerio,
    claimToken: 'claim',
    deadlineAt: Date.now() + remainingMs,
    remainingMs: () => remainingMs,
    signal,
  };
}

describe('providerAbortSignal', () => {
  it('aborts when the task signal fires', () => {
    const controller = new AbortController();
    const combined = providerAbortSignal(context(controller.signal));
    expect(combined.aborted).toBe(false);
    controller.abort();
    expect(combined.aborted).toBe(true);
  });

  it('aborts when the provider timeout fires', async () => {
    const combined = providerAbortSignal(context(new AbortController().signal, 5));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(combined.aborted).toBe(true);
  });
});
