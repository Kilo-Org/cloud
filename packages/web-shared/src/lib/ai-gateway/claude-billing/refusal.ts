import * as z from 'zod';

// Compatibility responses can omit billing details. Record their status without
// treating an unrelated permission failure as proof that the connection ended.
export const CLAUDE_BILLING_REFUSALS = {
  spendingLimit: 'linked_organization_spend_limit_reached',
  billingUnavailable: 'linked_organization_billing_unavailable',
  notBillable: 'user_profile_not_billable',
  profileRequired: 'user_profile_required',
  forbiddenWithoutCode: 'permission_error',
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

export function readClaudeBillingRefusalCode(body: unknown): string | null {
  const parsed = refusalBodySchema.safeParse(body);
  if (!parsed.success) return null;
  return parsed.data.error.details?.error_code ?? parsed.data.error.code ?? null;
}

// A status-only refusal remains visible without changing the connection state.
export function claudeBillingRefusalCodeFor(status: number, body: unknown): string | null {
  const code = readClaudeBillingRefusalCode(body);
  if (code) return code;
  if (status === 403) return CLAUDE_BILLING_REFUSALS.forbiddenWithoutCode;
  if (status === 402) return CLAUDE_BILLING_REFUSALS.paymentRequiredWithoutCode;
  return null;
}

export function isClaudeBillingConnectionDead(code: string): boolean {
  return (
    code === CLAUDE_BILLING_REFUSALS.notBillable || code === CLAUDE_BILLING_REFUSALS.profileRequired
  );
}

/** True for the responses that are never worth retrying on another payer. */
export function isClaudeBillingRefusedStatus(status: number): boolean {
  return status === 402 || status === 403;
}
