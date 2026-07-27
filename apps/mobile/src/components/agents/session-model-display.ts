import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

/**
 * Resolve a human-friendly model name for a (providerID, modelID) pair using
 * the session's catalog options. Falls back to the raw modelID with trailing
 * date suffixes stripped (a port of kilocode `KiloRoutedModel.display`).
 */
export function friendlyModelName(
  providerID: string,
  modelID: string,
  options: SessionModelOption[]
): string {
  const match = findMatchingOption(providerID, modelID, options);
  if (match) {
    return match.name;
  }
  return stripDateSuffix(modelID);
}

/**
 * Resolve the provider display name for a (providerID, modelID) pair using
 * the session's catalog options. Falls back to the providerID (or 'Kilo'
 * for the kilo provider).
 */
export function resolveModelProviderName(
  providerID: string,
  modelID: string,
  options: SessionModelOption[]
): string {
  const match = findMatchingOption(providerID, modelID, options);
  if (match?.provider?.name) {
    return match.provider.name;
  }
  return providerID === 'kilo' ? 'Kilo' : providerID;
}

/**
 * Find the catalog option matching a (providerID, modelID) pair. Matches via
 * the modelRef when present, or via the kilo-auto gateway metadata path.
 */
function findMatchingOption(
  providerID: string,
  modelID: string,
  options: SessionModelOption[]
): SessionModelOption | undefined {
  return options.find(
    option =>
      (option.modelRef?.providerID === providerID && option.modelRef.modelID === modelID) ||
      (providerID === 'kilo' && option.showGatewayMetadata && option.id === modelID)
  );
}

/**
 * Strip a trailing date suffix from a modelID. Matches the kilocode
 * `KiloRoutedModel.display` logic (NOT `displayName`): removes a trailing
 * `-YYYYMMDD` or `-YYYY-MM-DD` suffix. Returns the original if the cleaned
 * result is empty.
 */
function stripDateSuffix(modelID: string): string {
  const trimmed = modelID.trim();
  if (trimmed.length === 0) {
    return modelID;
  }
  const cleaned = trimmed.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  return cleaned.length > 0 ? cleaned : trimmed;
}
