import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  apiKeyUpstream,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import { cachedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProviderMetaId } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/direct-byok-meta';

/** A Xiaomi token-plan region; each region is one direct BYOK provider. */
export type XiaomiTokenPlanRegion = 'ams' | 'sgp';

/** The registered direct BYOK provider id of each region. */
const XIAOMI_TOKEN_PLAN_PROVIDER_IDS = {
  ams: 'xiaomi-token-plan-ams',
  sgp: 'xiaomi-token-plan-sgp',
} as const satisfies Record<XiaomiTokenPlanRegion, DirectByokProviderMetaId>;

/** The token-plan provider of one region, under the id that names that region. */
type XiaomiTokenPlanProvider<Region extends XiaomiTokenPlanRegion> = DirectByokProvider & {
  id: (typeof XIAOMI_TOKEN_PLAN_PROVIDER_IDS)[Region];
};

/**
 * The Xiaomi token-plan provider of `region`: it serves the models.dev list of that region over
 * Chat Completions, under the id, models.dev key and host that name the region.
 */
export function xiaomiTokenPlan(region: 'ams'): XiaomiTokenPlanProvider<'ams'>;
export function xiaomiTokenPlan(region: 'sgp'): XiaomiTokenPlanProvider<'sgp'>;
export function xiaomiTokenPlan(region: XiaomiTokenPlanRegion): DirectByokProvider {
  const id = XIAOMI_TOKEN_PLAN_PROVIDER_IDS[region];
  return {
    id,
    openrouter_inference_provider_id: 'xiaomi',
    models_dev_id: id,
    ...apiKeyUpstream({
      apiUrl: `https://token-plan-${region}.xiaomimimo.com/v1`,
      supportedChatApis: ['chat_completions'],
      responseTransforms: ReasoningDetailsTransform.ReasoningContent,
    }),
    models: cachedDirectByokModelList(id),
  };
}
