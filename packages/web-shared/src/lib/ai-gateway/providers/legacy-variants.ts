import {
  ReasoningEffortSchema,
  VerbositySchema,
  type OpenCodeSettings,
  type OpenCodeVariant,
  type ReasoningEffort,
  type ReasoningOption,
} from '@kilocode/db/schema-types';

type VariantEffort = [name: string, effort: ReasoningEffort];

const ALWAYS_ON_VARIANTS: VariantEffort[] = [['thinking', 'high']];
const TOGGLE_VARIANTS: VariantEffort[] = [
  ['instant', 'none'],
  ['thinking', 'high'],
];

function variantEfforts(options: readonly ReasoningOption[]): VariantEffort[] {
  if (options.length === 0) {
    return ALWAYS_ON_VARIANTS;
  }
  const toggle = options.some(option => option.type === 'toggle');
  const efforts = [
    ...new Set(
      options.flatMap(option =>
        option.type === 'effort'
          ? option.values.flatMap(value => ReasoningEffortSchema.safeParse(value).data ?? [])
          : []
      )
    ),
  ];
  if (efforts.length === 0) {
    return toggle ? TOGGLE_VARIANTS : [];
  }
  if (toggle && !efforts.includes('none')) {
    efforts.unshift('none');
  }
  return efforts.map(effort => [effort, effort]);
}

/**
 * The efforts a client can select from the options, the same set the legacy variants offer: a
 * toggle stands for `none` and, without effort values, `high`. Undefined when the options do not
 * say, which is the case for `[]` (reasoning that is always on) and for effort options without
 * concrete values.
 */
export function getSupportedReasoningEfforts(
  options: readonly ReasoningOption[] | undefined
): ReadonlySet<ReasoningEffort> | undefined {
  if (!options?.length) {
    return undefined;
  }
  const efforts = variantEfforts(options).map(([, effort]) => effort);
  return efforts.length > 0 ? new Set(efforts) : undefined;
}

function legacyVariant(effort: ReasoningEffort, includeVerbosity: boolean): OpenCodeVariant {
  const verbosity = includeVerbosity ? VerbositySchema.safeParse(effort).data : undefined;
  return { reasoning: { enabled: effort !== 'none', effort }, ...(verbosity && { verbosity }) };
}

/**
 * Builds the OpenRouter-shaped `variants` that Kilo CLI v1 clients send verbatim. `[]` (reasoning
 * that is always on) keeps the single `thinking` variant v1 has always offered. Effort variants of
 * Anthropic models also get the matching verbosity, which the gateway maps to Anthropic's `effort`
 * parameter. On/off variants never carried it, e.g. for Claude models older than Opus 4.5.
 */
export function toLegacyVariants(
  options: readonly ReasoningOption[] | undefined,
  aiSdkProvider: OpenCodeSettings['ai_sdk_provider']
): OpenCodeSettings['variants'] {
  const efforts = options ? variantEfforts(options) : [];
  if (efforts.length === 0) {
    return undefined;
  }
  return Object.fromEntries(
    efforts.map(([name, effort]) => [
      name,
      legacyVariant(effort, aiSdkProvider === 'anthropic' && name === effort),
    ])
  );
}

export function withLegacyVariants(settings: OpenCodeSettings): OpenCodeSettings {
  if (settings.variants) {
    return settings;
  }
  const variants = toLegacyVariants(settings.reasoning_options, settings.ai_sdk_provider);
  return variants ? { ...settings, variants } : settings;
}
