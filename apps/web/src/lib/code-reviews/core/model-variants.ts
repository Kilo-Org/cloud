import { getModelVariants } from '@/lib/providers/model-settings';

/** Returns the ordered list of thinking-effort variant names available for a model, or [] if the model has no variants. */
export function getAvailableThinkingEfforts(modelSlug: string): string[] {
  const variants = getModelVariants(modelSlug);
  return variants ? Object.keys(variants) : [];
}

const VARIANT_LABELS: Record<string, string> = { xhigh: 'Extra High' };

/** Human-readable label for a variant name. */
export function thinkingEffortLabel(variant: string): string {
  return VARIANT_LABELS[variant] ?? variant.charAt(0).toUpperCase() + variant.slice(1);
}
