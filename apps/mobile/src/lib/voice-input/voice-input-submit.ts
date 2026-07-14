/**
 * Awaits a voice-input settle callback (e.g. waiting for the final transcript
 * of an in-flight listening session) and only invokes `submit` when settle
 * resolves truthy. Returning `false` from settle aborts the submit so the
 * caller can surface controller-reported feedback. The helper intentionally
 * does not swallow rejections: a throw from settle is treated as a programmer
 * or native bridge bug and propagated to the caller, again without invoking
 * submit.
 *
 * The caller-owned lock rejects repeated submissions until both voice input
 * and an asynchronous submit have settled. This keeps the lock synchronous
 * across React renders while `onPendingChange` drives disabled UI state.
 */
export async function settleVoiceInputBeforeSubmit({
  lock,
  onPendingChange,
  settleVoiceInput,
  submit,
}: {
  lock: { current: boolean };
  onPendingChange?: (pending: boolean) => void;
  settleVoiceInput: () => Promise<boolean>;
  submit: () => void | Promise<void>;
}): Promise<boolean> {
  if (lock.current) {
    return false;
  }
  lock.current = true;
  onPendingChange?.(true);
  try {
    const settled = await settleVoiceInput();
    if (!settled) {
      return false;
    }
    await submit();
    return true;
  } finally {
    lock.current = false;
    onPendingChange?.(false);
  }
}
