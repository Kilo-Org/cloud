import {
  hasUserByokAvailable,
  isFreeModelOption,
  mayTrainOnYourPrompts,
  type ModelDataDisclosure,
} from '@/lib/free-model-data-disclosure';

type ModelBadgeOption = ModelDataDisclosure & {
  showGatewayMetadata: boolean;
};

/**
 * Badge predicates for the model selector pill and picker rows.
 * Input contract: a post-normalization SessionModelOption (both call sites
 * pass one: ModelSelector maps options through toSessionModelOption in
 * model-selector.tsx, and the picker bridge carries SessionModelOption).
 * BYOK is per-user account state, not gateway metadata: the CLI passes the
 * backend's hasUserByokAvailable through the v1 wire catalog, so the badge
 * must render for CLI-catalog options too. Free/data-collection stay gated
 * on showGatewayMetadata because CLI-catalog options do not carry Kilo
 * gateway pricing or data-policy semantics.
 */
export function modelSelectorBadges(option: ModelBadgeOption | undefined) {
  const showGatewayMetadata = option?.showGatewayMetadata === true;
  return {
    byok: hasUserByokAvailable(option),
    free: showGatewayMetadata && isFreeModelOption(option),
    collectsData: showGatewayMetadata && mayTrainOnYourPrompts(option),
  };
}
