export type BalanceRestrictedModelOption = {
  isFree?: boolean;
  hasUserByokAvailable?: boolean;
};

export type NewSessionBalanceNotice = 'none' | 'zero-credit' | 'low-funds';

export function filterModelsForCloudAgentBalance<T extends BalanceRestrictedModelOption>(
  models: T[],
  hasNoBalance: boolean
): T[] {
  if (!hasNoBalance) return models;
  return models.filter(model => model.isFree === true || model.hasUserByokAvailable === true);
}

export function getNewSessionBalanceNotice(
  hasNoBalance: boolean,
  hasLowBalance: boolean
): NewSessionBalanceNotice {
  if (hasNoBalance) return 'zero-credit';
  return hasLowBalance ? 'low-funds' : 'none';
}
