export type AccessLevel = 'full' | 'limited' | 'blocked';

export type AccessLevelEligibility = {
  balance: number;
  minBalance: number;
  accessLevel: AccessLevel;
  isEligible: boolean;
};

export function buildAccessLevelEligibility(
  balance: number,
  minBalance: number
): AccessLevelEligibility {
  const accessLevel: AccessLevel = balance >= minBalance ? 'full' : 'limited';
  return {
    balance,
    minBalance,
    accessLevel,
    isEligible: accessLevel === 'full',
  };
}
