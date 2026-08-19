import { z } from 'zod';

import { type ModelOption } from '@/lib/hooks/use-available-models';

export type ModelPreferenceEntry = { model: string; variant: string };
export type StoredModelPreference = Record<string, ModelPreferenceEntry>;

const modelPreferenceEntrySchema = z.object({ model: z.string(), variant: z.string() });
const rawStoredModelPreferenceSchema = z.record(z.string(), z.unknown());

export function contextKey(organizationId?: string): string {
  return organizationId ?? 'personal';
}

export function parseStoredModelPreference(raw: string | null): StoredModelPreference {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const shape = rawStoredModelPreferenceSchema.safeParse(parsed);
    if (!shape.success) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(shape.data).flatMap<[string, ModelPreferenceEntry]>(([key, value]) => {
        const entry = modelPreferenceEntrySchema.safeParse(value);
        return entry.success ? [[key, entry.data]] : [];
      })
    );
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
