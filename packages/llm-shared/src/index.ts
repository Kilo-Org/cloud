// Provider types
export type { ProviderId } from './provider-id.js';
export type { Provider } from './provider.js';
export type { KiloFreeModel, KiloFreeModelFlag } from './kilo-free-model.js';
export { convertFromKiloModel } from './kilo-free-model.js';

// OpenRouter types
export type {
  OpenRouterChatCompletionRequest,
  OpenRouterProviderConfig,
  OpenRouterReasoningConfig,
  OpenRouterGeneration,
  MessageWithReasoning,
  VercelProviderConfig,
  VercelInferenceProviderConfig,
} from './openrouter-types.js';
export { isFreePromptTrainingAllowed } from './openrouter-types.js';

// Inference provider IDs
export {
  OpenRouterInferenceProviderIdSchema,
  VercelUserByokInferenceProviderIdSchema,
  AutocompleteUserByokProviderIdSchema,
  UserByokProviderIdSchema,
  UserByokTestModels,
  VercelNonUserByokInferenceProviderIdSchema,
  VercelInferenceProviderIdSchema,
  openRouterToVercelInferenceProviderId,
  inferVercelFirstPartyInferenceProviderForModel,
  AwsCredentialsSchema,
} from './inference-provider-id.js';
export type {
  OpenRouterInferenceProviderId,
  VercelUserByokInferenceProviderId,
  UserByokAutocompleteProviderId,
  UserByokProviderId,
  VercelInferenceProviderId,
  AwsCredentials,
} from './inference-provider-id.js';

// Free model definitions
export {
  CLAUDE_SONNET_CURRENT_MODEL_ID,
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  corethink_free_model,
  giga_potato_model,
  giga_potato_thinking_model,
  minimax_m25_free_model,
  kimi_k25_free_model,
  grok_code_fast_1_optimized_free_model,
  zai_glm5_free_model,
} from './kilo-free-models.js';

// Model utilities
export {
  DEFAULT_MODEL_CHOICES,
  PRIMARY_DEFAULT_MODEL,
  preferredModels,
  getFirstFreeModel,
  isFreeModel,
  isKiloFreeModel,
  isDataCollectionRequiredOnKiloCodeOnly,
  kiloFreeModels,
  isKiloStealthModel,
  extraRequiredProviders,
  isDeadFreeModel,
} from './models.js';

export { isRateLimitedToDeath } from './rate-limited-models.js';

export {
  KILO_AUTO_FRONTIER_MODEL,
  KILO_AUTO_FREE_MODEL,
  KILO_AUTO_SMALL_MODEL,
  AUTO_MODELS,
  isKiloAutoModel,
  resolveAutoModel,
} from './kilo-auto-model.js';

export { normalizeModelId } from './model-utils.js';

export { generateProviderSpecificHash } from './provider-hash.js';

// Feature detection
export { FEATURE_VALUES, FEATURE_HEADER, validateFeatureHeader } from './feature-detection.js';
export type { FeatureValue } from './feature-detection.js';

// Tool calling
export {
  ENABLE_TOOL_REPAIR,
  repairTools,
  hasAttemptCompletionTool,
  dropToolStrictProperties,
  normalizeToolCallIds,
} from './tool-calling.js';

// Process usage types
export { extractPromptInfo } from './process-usage-types.js';
export type { MicrodollarUsageContext, PromptInfo } from './process-usage-types.js';

// Anonymous user
export {
  getAnonymousUserId,
  isAnonymousUserId,
  createAnonymousContext,
  isAnonymousContext,
} from './anonymous.js';
export type { AnonymousUserContext } from './anonymous.js';

// Proxy helpers
export { estimateChatTokens, checkOrganizationModelRestrictions } from './llm-proxy-helpers.js';
export type {
  OrganizationRestrictionResult,
  OrganizationSettings,
  OrganizationPlan,
} from './llm-proxy-helpers.js';

// API metrics
export {
  getTokensFromCompletionUsage,
  getToolsAvailable,
  getToolsUsed,
} from './api-metrics-types.js';
export type { ApiMetricsTokens, ApiMetricsParams } from './api-metrics-types.js';

// Provider-specific logic
export {
  applyProviderSpecificLogic,
  isAnthropicModel,
  isHaikuModel,
  isMistralModel,
  isCodestralModel,
  isXaiModel,
  isGeminiModel,
  isGemini3Model,
  isOpenAiModel,
  isMoonshotModel,
  isQwenModel,
  isZaiModel,
  addCacheBreakpoints,
} from './provider-specific-logic.js';
export type { BYOKResult } from './provider-specific-logic.js';

// Promotions
export { isActiveReviewPromo, REVIEW_PROMO_MODEL, REVIEW_PROMO_END } from './code-review-promo.js';
export {
  isActiveCloudAgentPromo,
  applyCloudAgentPromoLabel,
  CLOUD_AGENT_PROMO_MODEL,
  CLOUD_AGENT_PROMO_START,
  CLOUD_AGENT_PROMO_END,
} from './cloud-agent-promo.js';

// Constants
export { PROMOTION_MAX_REQUESTS, PROMOTION_WINDOW_HOURS } from './constants.js';

// Reasoning details
export {
  ReasoningDetailType,
  ReasoningFormat,
  CommonReasoningDetailSchema,
  ReasoningDetailSummarySchema,
  ReasoningDetailEncryptedSchema,
  ReasoningDetailTextSchema,
  ReasoningDetailUnionSchema,
  ReasoningDetailArraySchema,
  OutputUnionToReasoningDetailsSchema,
} from './reasoning-details.js';
export type {
  ReasoningDetailSummary,
  ReasoningDetailEncrypted,
  ReasoningDetailText,
  ReasoningDetailUnion,
} from './reasoning-details.js';
