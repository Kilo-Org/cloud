import { CustomPricingModelSchema, type CustomPricingModelConfig } from '@kilocode/db/schema-types';
import { formatZodError } from '@/lib/zod/format-zod-error';

/** Prices are dollars per 1M tokens. Blank cache prices bill at the prompt price. */
export type CustomPricingForm = {
  model: string;
  prompt: string;
  completion: string;
  cacheRead: string;
  cacheWrite: string;
  discountPercentage: string;
  fallbackOnly: boolean;
};

export const EMPTY_CUSTOM_PRICING_FORM: CustomPricingForm = {
  model: '',
  prompt: '',
  completion: '',
  cacheRead: '',
  cacheWrite: '',
  discountPercentage: '',
  fallbackOnly: false,
};

function formatOptionalNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

export function customPricingToForm(config: CustomPricingModelConfig): CustomPricingForm {
  return {
    model: config.model,
    prompt: String(config.pricing.prompt_per_million),
    completion: String(config.pricing.completion_per_million),
    cacheRead: formatOptionalNumber(config.pricing.input_cache_read_per_million),
    cacheWrite: formatOptionalNumber(config.pricing.input_cache_write_per_million),
    discountPercentage: formatOptionalNumber(config.discountPercentage),
    fallbackOnly: config.fallbackOnly,
  };
}

function parseNumber(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

function parseOptionalNumber(value: string): number | null {
  return value.trim() === '' ? null : Number(value);
}

export function parseCustomPricingForm(
  form: CustomPricingForm
): { config: CustomPricingModelConfig } | { error: string } {
  const discountPercentage = parseOptionalNumber(form.discountPercentage);
  const parsed = CustomPricingModelSchema.safeParse({
    model: form.model,
    pricing: {
      prompt_per_million: parseNumber(form.prompt),
      completion_per_million: parseNumber(form.completion),
      input_cache_read_per_million: parseOptionalNumber(form.cacheRead),
      input_cache_write_per_million: parseOptionalNumber(form.cacheWrite),
    },
    ...(discountPercentage !== null && { discountPercentage }),
    fallbackOnly: form.fallbackOnly,
  });
  return parsed.success ? { config: parsed.data } : { error: formatZodError(parsed.error) };
}

export function upsertCustomPricing(
  models: readonly CustomPricingModelConfig[],
  config: CustomPricingModelConfig
): CustomPricingModelConfig[] {
  const index = models.findIndex(model => model.model === config.model);
  if (index === -1) return [...models, config];
  return models.map((model, i) => (i === index ? config : model));
}
