import * as z from 'zod';

/**
 * Anthropic's refusals on a customer-billed request. `/v1/messages` carries the
 * code in `error.details.error_code`; the OpenAI-compatible
 * `/v1/chat/completions` reports the same HTTP status and message and may carry
 * the Anthropic error type in `error.code`, but no `error_code`. A compatibility
 * refusal without a code therefore falls back to a status-derived one, so the
 * connection still records the refusal.
 */
export const CLAUDE_BILLING_REFUSALS = {
  spendingLimit: 'linked_organization_spend_limit_reached',
  billingUnavailable: 'linked_organization_billing_unavailable',
  notBillable: 'user_profile_not_billable',
  profileRequired: 'user_profile_required',
  /** `403` without a code on the OpenAI-compatible endpoint. */
  forbiddenWithoutCode: 'permission_error',
  /** `402` without a code on the OpenAI-compatible endpoint. */
  paymentRequiredWithoutCode: 'billing_error',
} as const;

export type ClaudeBillingRefusal =
  (typeof CLAUDE_BILLING_REFUSALS)[keyof typeof CLAUDE_BILLING_REFUSALS];

const refusalBodySchema = z.object({
  error: z.object({
    code: z.string().optional(),
    details: z.object({ error_code: z.string().optional() }).optional(),
  }),
});

/** The refusal code in a response body, or null when the body names none. */
export function readClaudeBillingRefusalCode(body: unknown): string | null {
  const parsed = refusalBodySchema.safeParse(body);
  if (!parsed.success) return null;
  return parsed.data.error.details?.error_code ?? parsed.data.error.code ?? null;
}

/**
 * The refusal code to record for a refused response: the body's code, or a
 * status-derived one when the body carries none. A 403 means the profile cannot
 * bill, and a 402 means the organization's billing or spend limit applies.
 */
export function claudeBillingRefusalCodeFor(status: number, body: unknown): string | null {
  const code = readClaudeBillingRefusalCode(body);
  if (code) return code;
  if (status === 403) return CLAUDE_BILLING_REFUSALS.forbiddenWithoutCode;
  if (status === 402) return CLAUDE_BILLING_REFUSALS.paymentRequiredWithoutCode;
  return null;
}

/** True for a refusal that means the connection can no longer bill. */
export function isClaudeBillingConnectionDead(code: string): boolean {
  return (
    code === CLAUDE_BILLING_REFUSALS.notBillable ||
    code === CLAUDE_BILLING_REFUSALS.profileRequired ||
    code === CLAUDE_BILLING_REFUSALS.forbiddenWithoutCode
  );
}

/** True for the responses that are never worth retrying on another payer. */
export function isClaudeBillingRefusedStatus(status: number): boolean {
  return status === 402 || status === 403;
}
