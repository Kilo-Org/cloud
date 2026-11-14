import type { ClaudeBillingOwner } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';

/** The callback registered with the Linked billing with Claude Platform OAuth app. */
export const CLAUDE_BILLING_CALLBACK_PATH = '/claude/billing/callback';

/**
 * The page query that reports the outcome of a link attempt. A page can hold
 * both the person's own connection and the organization's shared-services one,
 * so each reports under its own query.
 */
export function claudeBillingOutcomeParam(owner: { kind: ClaudeBillingOwner['kind'] }): string {
  return owner.kind === 'shared_services' ? 'claude_billing_shared' : 'claude_billing';
}
