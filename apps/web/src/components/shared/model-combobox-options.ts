import { preferredModels } from '@/lib/ai-gateway/models';

export type ModelOption = {
  id: string; // e.g., "anthropic/claude-sonnet-4.5"
  name: string; // e.g., "Claude Sonnet 4.5"
  /** Exact user-facing ID when `id` is an opaque selection value. */
  displayId?: string;
  /** Optional provider group for provider-aware catalogs. */
  providerGroup?: { id: string; label: string };
  /** Additional user-facing search terms. Opaque selection values stay excluded. */
  searchTerms?: string[];
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  isFree?: boolean;
  mayTrainOnYourPrompts?: boolean;
  hasUserByokAvailable?: boolean;
  showGatewayMetadata?: boolean;
  unavailable?: boolean;
  /** Ordered list of variant key names (e.g., ["none","low","medium","high","max"]) */
  variants?: string[];
};

export type ModelOptionGroup = {
  id: string;
  heading: string;
  models: ModelOption[];
};

export function buildModelOptionGroups(models: ModelOption[]): ModelOptionGroup[] {
  const groups: ModelOptionGroup[] = [];
  const groupIndexes = new Map<string, number>();
  const ungrouped: ModelOption[] = [];

  for (const model of models) {
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
