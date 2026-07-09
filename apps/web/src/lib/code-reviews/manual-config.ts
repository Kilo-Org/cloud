import {
  ManualCodeReviewConfigSchema,
  type ManualCodeReviewConfig,
} from '@kilocode/db/schema-types';

export type ReviewWithManualConfig = {
  manual_config: unknown;
};

export function parseManualCodeReviewConfig(value: unknown): ManualCodeReviewConfig | null {
  if (value === null || value === undefined) return null;
  return ManualCodeReviewConfigSchema.parse(value);
}

export function getManualCodeReviewConfig(
  review: ReviewWithManualConfig
): ManualCodeReviewConfig | null {
  return parseManualCodeReviewConfig(review.manual_config);
}

export function isLocalKiloCodeReview(review: ReviewWithManualConfig): boolean {
  return getManualCodeReviewConfig(review)?.outputMode === 'kilo';
}

export function shouldPublishCodeReviewToProvider(review: ReviewWithManualConfig): boolean {
  const manualConfig = getManualCodeReviewConfig(review);
  return manualConfig === null || manualConfig.outputMode === 'provider';
}
