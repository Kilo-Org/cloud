type TelegramConfig = Record<string, unknown>;

function hasConfiguredEntries(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some(item => typeof item === 'string' && item.trim() !== '');
}

function hasConcreteTelegramIdentifiers(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some(item => typeof item === 'string' && item.trim() !== '' && item.trim() !== '*');
}

export function shouldDefaultTelegramGroupPolicyOpen(telegram: TelegramConfig): boolean {
  if ('groupPolicy' in telegram) return false;
  if ('groups' in telegram) return false;
  if ('accounts' in telegram) return false;
  if (hasConfiguredEntries(telegram.groupAllowFrom)) return false;
  if (hasConcreteTelegramIdentifiers(telegram.allowFrom)) return false;

  return true;
}
