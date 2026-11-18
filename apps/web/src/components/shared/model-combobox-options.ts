import { isFavoriteOption } from './model-favorites';
import type { ModelOption } from './model-option';

export type { ModelOption };

export type ModelOptionGroup = {
  id: string;
  heading: string;
  models: ModelOption[];
};

export const NO_FAVORITES: ReadonlySet<string> = new Set();

export function buildModelOptionGroups(
  models: ModelOption[],
  preferredModels: ReadonlyArray<string>,
  favoriteIds: ReadonlySet<string> = NO_FAVORITES
): ModelOptionGroup[] {
  const groups: ModelOptionGroup[] = [];
  const favorites: ModelOption[] = [];
  const rest: ModelOption[] = [];
  for (const model of models) {
    if (isFavoriteOption(model, favoriteIds)) favorites.push(model);
    else rest.push(model);
  }
  if (favorites.length > 0) {
    groups.push({ id: 'favorites', heading: 'Favorites', models: favorites });
  }

  const groupIndexes = new Map<string, number>();
  const ungrouped: ModelOption[] = [];

  for (const model of rest) {
    if (!model.providerGroup) {
      ungrouped.push(model);
      continue;
    }

    const groupId = `provider:${model.providerGroup.id}`;
    const existingIndex = groupIndexes.get(groupId);
    if (existingIndex !== undefined) {
      groups[existingIndex].models.push(model);
      continue;
    }

    groupIndexes.set(groupId, groups.length);
    groups.push({ id: groupId, heading: model.providerGroup.label, models: [model] });
  }

  if (ungrouped.length === 0) return groups;

  const preferred: ModelOption[] = [];
  const others: ModelOption[] = [];
  for (const model of ungrouped) {
    if (preferredModels.includes(model.id)) preferred.push(model);
    else others.push(model);
  }
  preferred.sort(
    (left, right) => preferredModels.indexOf(left.id) - preferredModels.indexOf(right.id)
  );
  others.sort((left, right) => left.name.localeCompare(right.name));

  if (preferred.length > 0) {
    groups.push({ id: 'recommended', heading: 'Recommended', models: preferred });
  }
  if (others.length > 0) {
    groups.push({ id: 'all-models', heading: 'All Models', models: others });
  }
  return groups;
}

export function getModelOptionKeywords(model: ModelOption): string[] {
  return Array.from(
    new Set(
      [
        model.name,
        model.displayId ?? (model.providerGroup ? undefined : model.id),
        model.providerGroup?.id,
        model.providerGroup?.label,
        ...(model.searchTerms ?? []),
      ].filter((term): term is string => Boolean(term))
    )
  );
}
