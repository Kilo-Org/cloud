const VARIANT_LABELS: Record<string, string> = { xhigh: 'Extra High' };

/** Human-readable label for a variant name. */
export function thinkingEffortLabel(variant: string): string {
  return VARIANT_LABELS[variant] ?? variant.charAt(0).toUpperCase() + variant.slice(1);
}
