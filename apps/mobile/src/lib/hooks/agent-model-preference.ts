import { type ModelOption } from '@/lib/hooks/use-available-models';

export type ModelPreferenceEntry = { model: string; variant: string };
export type StoredModelPreference = Record<string, ModelPreferenceEntry>;

export function contextKey(organizationId?: string): string {
  return organizationId ?? 'personal';
}

export function parseStoredModelPreference(raw: string | null): StoredModelPreference {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    const result: StoredModelPreference = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as ModelPreferenceEntry).model === 'string' &&
        typeof (value as ModelPreferenceEntry).variant === 'string'
      ) {
        result[key] = {
          model: (value as ModelPreferenceEntry).model,
          variant: (value as ModelPreferenceEntry).variant,
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function resolveModelForContext(
  stored: StoredModelPreference,
  context: string,
  options: ModelOption[]
): ModelPreferenceEntry | undefined {
  const entry = stored[context];
  if (!entry) {
    return undefined;
  }
  const match = options.find(o => o.id === entry.model);
  if (!match) {
    return undefined;
  }
  if (entry.variant && !match.variants.includes(entry.variant)) {
    return { model: match.id, variant: match.variants[0] ?? '' };
  }
  return { model: entry.model, variant: entry.variant };
}
