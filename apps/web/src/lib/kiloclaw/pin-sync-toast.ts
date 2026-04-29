import { toast } from 'sonner';

type PinMutationResult = {
  worker_sync?: { ok: boolean; error?: string };
};

/**
 * Show the right toast for a pin set/remove mutation result.
 *
 * The DB write has already succeeded by the time we get here. But the
 * follow-up push to the instance's Durable Object may have failed — in
 * which case the pin won't take effect on the next redeploy until the
 * admin retries. Surface that as a warning, not a success.
 */
export function toastPinMutationResult(
  result: PinMutationResult | null | undefined,
  successMessage: string
): void {
  const sync = result?.worker_sync;
  if (sync && sync.ok === false) {
    toast.warning(`${successMessage} — but failed to sync to instance. Retry to apply.`, {
      description: sync.error,
      duration: 10000,
    });
    return;
  }
  toast.success(successMessage);
}
