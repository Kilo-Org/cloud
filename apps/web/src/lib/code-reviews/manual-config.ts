import {
  ManualCodeReviewConfigSchema,
  type ManualCodeReviewConfig,
} from '@kilocode/db/schema-types';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

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

/**
 * Detail-read tolerance: legacy rows can carry a `manual_config` that fails the
 * strict schema, and the review detail screen must open for them. A parse
 * failure here is logged and read as "no manual config", matching how the
 * screen already treats a review whose config is absent. Read paths that drive
 * publish or dispatch decisions keep the strict `getManualCodeReviewConfig` —
 * a silent reclassification there can disable Code Reviewer at the owner level
 * or dispatch with different config.
 */
export function getManualCodeReviewConfigForDetail(
  review: ReviewWithManualConfig
): ManualCodeReviewConfig | null {
  try {
    return parseManualCodeReviewConfig(review.manual_config);
  } catch (error) {
    warnExceptInTest('[codeReviews.get] Stored manual_config failed the strict schema', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function isLocalKiloCodeReview(review: ReviewWithManualConfig): boolean {
  return getManualCodeReviewConfig(review)?.outputMode === 'kilo';
}

export function shouldPublishCodeReviewToProvider(review: ReviewWithManualConfig): boolean {
  const manualConfig = getManualCodeReviewConfig(review);
  return manualConfig === null || manualConfig.outputMode === 'provider';
}
