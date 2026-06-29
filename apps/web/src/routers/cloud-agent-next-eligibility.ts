export const CLOUD_AGENT_NEXT_MIN_BALANCE_DOLLARS = 1;

export type CloudAgentNextEligibility = {
  balance: number;
  minBalance: number;
  isEligible: boolean;
};

export function buildCloudAgentNextEligibility(balance: number): CloudAgentNextEligibility {
  return {
    balance,
    minBalance: CLOUD_AGENT_NEXT_MIN_BALANCE_DOLLARS,
    isEligible: balance >= CLOUD_AGENT_NEXT_MIN_BALANCE_DOLLARS,
  };
}
