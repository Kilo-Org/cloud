import {
  buildAccessLevelEligibility,
  type AccessLevel,
  type AccessLevelEligibility,
} from '@/lib/access-level-eligibility';

export const CLOUD_AGENT_NEXT_MIN_BALANCE_DOLLARS = 1;

export type CloudAgentNextAccessLevel = AccessLevel;

export type CloudAgentNextEligibility = AccessLevelEligibility;

export function buildCloudAgentNextEligibility(balance: number): CloudAgentNextEligibility {
  return buildAccessLevelEligibility(balance, CLOUD_AGENT_NEXT_MIN_BALANCE_DOLLARS);
}
