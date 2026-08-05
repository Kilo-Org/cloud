import { ReasoningEffortSchema, type OpenCodeSettings } from '@kilocode/db/schema-types';
import * as z from 'zod';
import { REASONING_VARIANTS_BINARY } from '@/lib/ai-gateway/providers/model-settings';

export const ModelsDevModalitySchema = z
  .enum(['text', 'image', 'video', 'pdf', 'audio', 'unknown'])
  .catch('unknown');

const ModelsDevReasoningOptionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('toggle') }),
  z.object({
    type: z.literal('effort'),
    values: z.array(z.union([z.null(), ReasoningEffortSchema, z.literal('default')])),
  }),
]);

const ModelsDevModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z.array(z.unknown()).optional().catch(undefined),
  status: z.enum(['alpha', 'beta', 'deprecated']).optional().catch(undefined),
  limit: z
    .object({
      context: z.number().optional(),
      output: z.number().optional(),
    })
    .optional(),
  modalities: z
    .object({
      input: z.array(ModelsDevModalitySchema).optional(),
      output: z.array(ModelsDevModalitySchema).optional(),
    })
    .optional(),
  tool_call: z.boolean().optional(),
});

const ModelsDevProviderSchema = z.object({
  models: z.record(z.string(), ModelsDevModelSchema),
});

const ModelsDevCatalogSchema = z.record(z.string(), z.unknown());

export type ModelsDevCatalog = z.infer<typeof ModelsDevCatalogSchema>;
export type ModelsDevModality = z.infer<typeof ModelsDevModalitySchema>;

export function parseModelsDevProvider(entry: unknown) {
  return ModelsDevProviderSchema.parse(entry);
}

export function getModelsDevProvider(catalog: ModelsDevCatalog, providerId: string) {
  const entry = catalog[providerId];
  if (!entry) {
    throw new Error(`models.dev catalog missing ${providerId} entry`);
  }
  return parseModelsDevProvider(entry);
}

export function modelsDevReasoningOptionsToVariants(
  options: ReadonlyArray<unknown>
): OpenCodeSettings['variants'] {
  const parsedOptions = options.flatMap(option => {
    const parsed = ModelsDevReasoningOptionSchema.safeParse(option);
    return parsed.success ? [parsed.data] : [];
  });
  const hasToggle = parsedOptions.some(option => option.type === 'toggle');
  const effortVariants: NonNullable<OpenCodeSettings['variants']> = {};
  for (const option of parsedOptions) {
    if (option.type !== 'effort') continue;
    for (const value of option.values) {
      const effort = ReasoningEffortSchema.safeParse(value);
      if (!effort.success) continue;
      effortVariants[effort.data] = {
        reasoning: { enabled: effort.data !== 'none', effort: effort.data },
      };
    }
  }

  if (Object.keys(effortVariants).length > 0) {
    return hasToggle && !effortVariants.none
      ? { none: { reasoning: { enabled: false, effort: 'none' } }, ...effortVariants }
      : effortVariants;
  }
  if (hasToggle) {
    return REASONING_VARIANTS_BINARY;
  }
  return undefined;
}

export async function fetchModelsDevCatalog(): Promise<ModelsDevCatalog> {
  const response = await fetch('https://models.dev/api.json');
  if (!response.ok) {
    throw new Error(
      `Failed to fetch models.dev catalog: ${response.status} ${response.statusText}`
    );
  }
  return ModelsDevCatalogSchema.parse(await response.json());
}
