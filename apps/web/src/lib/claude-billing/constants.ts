import type { ClaudeBillingOwner } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';

/** The callback registered with the Linked billing with Claude Platform OAuth app. */
export const CLAUDE_BILLING_CALLBACK_PATH = '/claude/billing/callback';

/**
 * The page query that reports the outcome of a link attempt. The personal page
 * and the organization BYOK page each report under their own query.
 */
export function claudeBillingOutcomeParam(owner: { kind: ClaudeBillingOwner['kind'] }): string {
  return owner.kind === 'organization' ? 'claude_billing_organization' : 'claude_billing';
}
