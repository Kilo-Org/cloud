import { getFallbackModelVariants } from '@/lib/ai-gateway/providers/variants';

type ModelWithVariants = {
  id: string;
  variants?: string[];
};

/** Returns variants discovered through /models, falling back when the model is absent. */
export function getAvailableThinkingEfforts(
  modelSlug: string,
  models: readonly ModelWithVariants[]
): string[] {
  const discoveredVariants = models.find(model => model.id === modelSlug)?.variants;
  if (discoveredVariants) {
    return discoveredVariants;
  }

  const variants = getFallbackModelVariants(modelSlug);
  return variants ? Object.keys(variants) : [];
}

const VARIANT_LABELS: Record<string, string> = { xhigh: 'Extra High' };

/** Human-readable label for a variant name. */
export function thinkingEffortLabel(variant: string): string {
  return VARIANT_LABELS[variant] ?? variant.charAt(0).toUpperCase() + variant.slice(1);
}
