import {
  ManualCodeReviewConfigSchema,
  type ManualCodeReviewConfig,
} from '@kilocode/db/schema-types';

export type ReviewWithManualConfig = {
  manual_config: unknown;
};

export function parseManualCodeReviewConfig(value: unknown): ManualCodeReviewConfig | null {
  if (value === null || value === undefined) return null;
  // Tolerate over-the-wire shapes instead of throwing into every caller that
  // touches a stored review row. Two documented malformed shapes exist:
  // - legacy rows whose `manual_config` predates the strict schema (missing
  //   `agentConfig`, or carrying extra keys the schema now rejects);
  // - partially-written rows. A stored config is data, not a contract: a row
  //   that fails validation means "no usable manual config", the same way the
  //   review-detail screen already reads `gate_threshold` defensively.
  const parsed = ManualCodeReviewConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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
