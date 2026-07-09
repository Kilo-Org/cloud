export const CLOUD_AGENT_NEXT_MIN_BALANCE_DOLLARS = 1;

export type CloudAgentNextAccessLevel = 'full' | 'limited';

export type CloudAgentNextEligibility = {
  balance: number;
  minBalance: number;
  accessLevel: CloudAgentNextAccessLevel;
  isEligible: boolean;
  isLowBalance: boolean;
};

export function buildCloudAgentNextEligibility(balance: number): CloudAgentNextEligibility {
  const hasNoBalance = balance <= 0;
  return {
    balance,
    minBalance: CLOUD_AGENT_NEXT_MIN_BALANCE_DOLLARS,
    accessLevel: hasNoBalance ? 'limited' : 'full',
    isEligible: !hasNoBalance,
    isLowBalance: balance < CLOUD_AGENT_NEXT_MIN_BALANCE_DOLLARS,
  };
}
