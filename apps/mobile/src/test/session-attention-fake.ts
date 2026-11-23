import { type SessionAttentionHydration } from '@/lib/session-attention';

/**
 * The ack store's two decisions, restated over a caller-supplied phase so a
 * suite can present the store as still loading or as settled.
 *
 * A suite that mounts a surface reading the ack store needs to control that
 * store's phase, and the phase is what the surface's behaviour turns on: held
 * while `loading`, answered from the status and the ack once settled. Keeping
 * the rule in one place means the fake cannot drift from the shipped one in the
 * way that makes a hold assertion pass for the wrong reason.
 *
 * `failed` answers exactly as `ready` does — an ack this run recorded still
 * hides its raise, and with no ack the status alone decides.
 */
function waitsForInput(status: string | null | undefined): boolean {
  return status === 'question' || status === 'permission';
}

export function fakeNeedsInputVisibility(input: {
  status: string | null | undefined;
  hydration: SessionAttentionHydration;
  isAcked: boolean;
}): 'show' | 'hold' | 'hide' {
  if (input.hydration === 'loading') {
    return 'hold';
  }
  if (!waitsForInput(input.status)) {
    return 'hide';
  }
  return input.isAcked ? 'hide' : 'show';
}

export function fakeShouldShowNeedsInput(input: {
  status: string | null | undefined;
  hydration: SessionAttentionHydration;
  isAcked: boolean;
}): boolean {
  return fakeNeedsInputVisibility(input) === 'show';
}

export function fakeSessionNeedsInput(status: string | null | undefined): boolean {
  return waitsForInput(status);
}
