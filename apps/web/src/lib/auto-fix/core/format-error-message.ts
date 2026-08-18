/**
 * User-facing auto-fix error formatting.
 *
 * Raw orchestrator/tRPC failures often include status codes and JSON envelopes.
 * Map known billing failures to a clear credit-minimum explanation.
 */

import { AUTO_FIX_INSUFFICIENT_CREDITS_MESSAGE } from '@kilocode/worker-utils/cloud-agent-next-client';

export { AUTO_FIX_INSUFFICIENT_CREDITS_MESSAGE };

const BILLING_ERROR_PATTERNS = [
  'insufficient credits',
  'payment_required',
  'payment required',
  'credits required',
  'credit balance is too low',
  'insufficient funds',
  'add credits',
  'paid model',
] as const;

export function isAutoFixBillingErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return BILLING_ERROR_PATTERNS.some(pattern => normalized.includes(pattern));
}

/** Map raw auto-fix failure text to a concise user-facing message. */
export function formatAutoFixErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return 'Unknown error';
  }

  if (isAutoFixBillingErrorMessage(trimmed)) {
    return AUTO_FIX_INSUFFICIENT_CREDITS_MESSAGE;
  }

  return trimmed;
}
