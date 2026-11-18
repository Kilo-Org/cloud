import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

/** The provider id Kilo's own gateway catalog rows are matched and named by. */
const KILO_PROVIDER_ID = 'kilo';

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
  return providerID === KILO_PROVIDER_ID ? 'Kilo' : providerID;
}

/**
 * Resolve the display name and provider of a model *selection*: the
 * `SessionModelOption.id` the composer's model chip shows. The context sheet
 * uses it before the session reports context usage, so it names the same model
 * the chip already names instead of two placeholders.
 *
 * Empty strings when no option carries the selection, so the caller keeps its
 * placeholder for a model the app cannot name.
 */
export function resolveSelectionModelDisplay(selectionId: string, options: SessionModelOption[]) {
  const option = selectionId ? options.find(candidate => candidate.id === selectionId) : undefined;
  if (!option) {
    return { model: '', provider: '' };
  }
  // A row the chip would show by name (`remote-session-model`, a model no
  // catalog carries) must reach the sheet by that name, not re-derived from a
  // raw id; the chip resolves these through the option row it renders. A row
  // that records no provider leaves the sheet's placeholder in place: the
  // session's provider is unknown, not Kilo.
  if (option.unavailable) {
    return {
      model: option.name || option.displayId,
      provider: option.provider?.name ?? option.modelRef?.providerID ?? '',
    };
  }
  // A gateway row carries no `modelRef`: its model is a Kilo catalog id, which
  // the lookup matches through `showGatewayMetadata` and names 'Kilo'.
  const providerID = option.modelRef?.providerID ?? KILO_PROVIDER_ID;
  const modelID = option.modelRef?.modelID ?? option.id;
  return {
    model: friendlyModelName(providerID, modelID, options) || option.displayId,
    provider: resolveModelProviderName(providerID, modelID, options),
  };
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
      (providerID === KILO_PROVIDER_ID && option.showGatewayMetadata && option.id === modelID)
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
