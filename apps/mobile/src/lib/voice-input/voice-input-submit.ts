/**
 * Awaits a voice-input settle callback (e.g. waiting for the final transcript
 * of an in-flight listening session) and only invokes `submit` when settle
 * resolves truthy. Returning `false` from settle aborts the submit so the
 * caller can surface controller-reported feedback. The helper intentionally
 * does not swallow rejections: a throw from settle is treated as a programmer
 * or native bridge bug and propagated to the caller, again without invoking
 * submit.
 *
 * This is a domain-agnostic submit race guarantee. Both the Kilo Chat message
 * input and the Cloud Agent chat composer call into `useVoiceInput`'s
 * `settleBeforeSubmit` before their respective submit paths so an in-flight
 * recognition session can deliver its final transcript before the message is
 * flushed.
 */
export async function settleVoiceInputBeforeSubmit({
  settleVoiceInput,
  submit,
}: {
  settleVoiceInput: () => Promise<boolean>;
  submit: () => void;
}): Promise<boolean> {
  const settled = await settleVoiceInput();
  if (!settled) {
    return false;
  }
  submit();
  return true;
}
