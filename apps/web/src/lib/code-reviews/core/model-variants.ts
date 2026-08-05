type ModelWithVariants = {
  id: string;
  variants?: string[];
};

export function getAvailableThinkingEfforts(
  modelSlug: string,
  models: readonly ModelWithVariants[]
): string[] {
  return models.find(model => model.id === modelSlug)?.variants ?? [];
}

const VARIANT_LABELS: Record<string, string> = { xhigh: 'Extra High' };

/** Human-readable label for a variant name. */
export function thinkingEffortLabel(variant: string): string {
  return VARIANT_LABELS[variant] ?? variant.charAt(0).toUpperCase() + variant.slice(1);
}
