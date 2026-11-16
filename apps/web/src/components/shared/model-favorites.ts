import type { ModelOption } from './model-combobox-options';

export type FavoriteToggleAction =
  | { type: 'add'; model: string }
  | { type: 'remove'; models: string[] };

function cliCatalogModelRef(model: ModelOption) {
  if (!model.modelRef || model.overrideSource === 'legacy-gateway') return undefined;
  return model.modelRef;
}

// Favorite ids are shared with the mobile app through user_model_preferences,
// so the identity scheme must match it: CLI catalog options are stored by CLI
// model identity (their selection ids are opaque and order-based), Kilo CLI
// options share the Gateway model id, and Gateway options keep their id.
export function canonicalFavoriteId(model: ModelOption): string {
  const modelRef = cliCatalogModelRef(model);
  if (modelRef) {
    return modelRef.providerID === 'kilo'
      ? modelRef.modelID
      : `remote:${modelRef.providerID}:${modelRef.modelID}`;
  }
  return model.id;
}

export function favoriteKeysForOption(model: ModelOption): string[] {
  const modelRef = cliCatalogModelRef(model);
  if (modelRef) {
    if (modelRef.providerID === 'kilo') {
      return [modelRef.modelID, `remote:kilo:${modelRef.modelID}`];
    }
    return [`remote:${modelRef.providerID}:${modelRef.modelID}`];
  }
  return [model.id, `remote:kilo:${model.id}`];
}

export function isFavoriteOption(model: ModelOption, favoriteIds: ReadonlySet<string>): boolean {
  return favoriteKeysForOption(model).some(key => favoriteIds.has(key));
}

export function favoriteToggleAction(
  model: ModelOption,
  storedFavorites: readonly string[]
): FavoriteToggleAction {
  const stored = new Set(storedFavorites);
  const matching = favoriteKeysForOption(model).filter(key => stored.has(key));
  if (matching.length > 0) {
    return { type: 'remove', models: matching };
  }
  return { type: 'add', model: canonicalFavoriteId(model) };
}
