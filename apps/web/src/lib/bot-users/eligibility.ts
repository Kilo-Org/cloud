/**
 * Eligibility rules for internal bot accounts (`bot-internal-<slug>`).
 *
 * More than one internal mint runs as such an account: `/api/internal/bot-token`
 * mints the workload token, and `/api/internal/mcp-catalog/token` mints the
 * catalog dump token for the same kind of account. Both use these helpers so the
 * rules cannot drift apart.
 *
 * The helpers are pure so every mint, and its unit test, sees one rule set.
 */

import type { User } from '@kilocode/db/schema';
import { INTERNAL_BOT_USER_ID_PREFIX } from './types';

/** Organization roles an internal bot may act under. */
export const INTERNAL_BOT_ORGANIZATION_ROLES = ['owner', 'member'] as const;
export type InternalBotOrganizationRole = (typeof INTERNAL_BOT_ORGANIZATION_ROLES)[number];

/** The first eligibility rule an account row fails, or null when it passes. */
export type InternalBotAccountIssue =
  | 'not-an-internal-bot-id'
  | 'not-a-bot'
  | 'blocked'
  | 'missing-api-token-pepper';

export type InternalBotAccountRow = Pick<
  User,
  'id' | 'is_bot' | 'blocked_at' | 'blocked_reason' | 'api_token_pepper'
>;

export function internalBotAccountIssue(
  user: InternalBotAccountRow
): InternalBotAccountIssue | null {
  if (!user.id.startsWith(INTERNAL_BOT_USER_ID_PREFIX)) return 'not-an-internal-bot-id';
  if (user.is_bot !== true) return 'not-a-bot';
  if (user.blocked_at !== null || user.blocked_reason !== null) return 'blocked';
  if (typeof user.api_token_pepper !== 'string' || user.api_token_pepper.trim().length === 0) {
    return 'missing-api-token-pepper';
  }
  return null;
}

export type EligibleInternalBotAccount = InternalBotAccountRow & {
  is_bot: true;
  blocked_at: null;
  blocked_reason: null;
  api_token_pepper: string;
};

/** Narrows an account row the mints can use; the predicate is the rule set above. */
export function isEligibleInternalBotAccount(
  user: InternalBotAccountRow
): user is EligibleInternalBotAccount {
  return internalBotAccountIssue(user) === null;
}

export function isInternalBotOrganizationRole(role: string): role is InternalBotOrganizationRole {
  return (INTERNAL_BOT_ORGANIZATION_ROLES as readonly string[]).includes(role);
}
