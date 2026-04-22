import type { FeatureValue } from '@/lib/feature-detection';
import { minimax_m25_free_model } from '@/lib/ai-gateway/providers/minimax';
import {
  gemma_4_26b_a4b_it_free_model,
  GEMMA_4_31B_IT_ID,
} from '@/lib/ai-gateway/providers/google';
import type {
  GatewayRequest,
  OpenRouterChatCompletionRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import type OpenAI from 'openai';
import type { User } from '@kilocode/db';
import {
  KILO_AUTO_FREE_MODEL,
  KILO_AUTO_SMALL_MODEL,
  KILO_AUTO_BALANCED_MODEL,
  modeSchema,
  BALANCED_CLAW_SETUP_MODEL,
  BALANCED_QWEN_MODEL,
  BALANCED_CODEX_MODEL,
  FRONTIER_MODE_TO_MODEL,
  FRONTIER_CODE_MODEL,
  type ResolvedAutoModel,
  KILO_AUTO_LEGACY_MODEL,
  BALANCED_HAIKU_MODEL,
} from '@/lib/kilo-auto';
import { userIsWithinFirstKiloClawInstanceWindow } from '@/lib/kiloclaw/setup-promo';
import { stepfun_35_flash_free_model } from '@/lib/ai-gateway/providers/stepfun';
import { getRandomNumberLessThan100 } from '@/lib/ai-gateway/getRandomNumberLessThan100';

const STEP_FLASH_ROUTING_PERCENTAGE = 20;

type ResolveAutoModelParams = {
  model: string;
  modeHeader: string | null;
  featureHeader: FeatureValue | null;
  sessionId: string | null;
  apiKind: GatewayRequest['kind'] | null;
};

function resolveMode(modeHeader: string | null, featureHeader: FeatureValue | null) {
  const parsedMode = modeSchema.safeParse(modeHeader?.trim() ?? '');
  if (parsedMode.success) return parsedMode.data;
  if (featureHeader === 'kiloclaw' || featureHeader === 'openclaw') return 'claw' as const;
  return null;
}

export async function resolveAutoModel(
  params: ResolveAutoModelParams,
  userPromise: Promise<User | null>,
  balancePromise: Promise<number>
): Promise<ResolvedAutoModel> {
  const { model, modeHeader, featureHeader, sessionId, apiKind } = params;
  if (model === KILO_AUTO_FREE_MODEL.id) {
    if (
      sessionId &&
      stepfun_35_flash_free_model.status === 'public' &&
      getRandomNumberLessThan100('step_routing_' + sessionId) < STEP_FLASH_ROUTING_PERCENTAGE
    ) {
      return { model: stepfun_35_flash_free_model.public_id };
    }
    return { model: minimax_m25_free_model.public_id };
  }
  if (model === KILO_AUTO_SMALL_MODEL.id) {
    return {
      model:
        (await balancePromise) > 0 ? GEMMA_4_31B_IT_ID : gemma_4_26b_a4b_it_free_model.public_id,
    };
  }
  const mode = resolveMode(modeHeader, featureHeader);
  if (model === KILO_AUTO_BALANCED_MODEL.id || model === KILO_AUTO_LEGACY_MODEL) {
    if (mode === 'claw' && featureHeader === 'kiloclaw') {
      const user = await userPromise;
      if (user && (await userIsWithinFirstKiloClawInstanceWindow({ userId: user.id }))) {
        return BALANCED_CLAW_SETUP_MODEL;
      }
    }

    // Alibaba doesn't expose a messages endpoint
    // and does not support prompt caching on the responses endpoint
    // so we use a fallback in those cases.
    if (apiKind === 'responses') {
      return BALANCED_CODEX_MODEL;
    } else if (apiKind === 'messages') {
      return BALANCED_HAIKU_MODEL;
    } else {
      return BALANCED_QWEN_MODEL;
    }
  }
  return (mode !== null ? FRONTIER_MODE_TO_MODEL[mode] : null) ?? FRONTIER_CODE_MODEL;
}

export async function applyResolvedAutoModel(
  params: ResolveAutoModelParams,
  request: GatewayRequest,
  userPromise: Promise<User | null>,
  balancePromise: Promise<number>
) {
  const resolved = await resolveAutoModel(params, userPromise, balancePromise);
  request.body.model = resolved.model;
  if (resolved.reasoning) {
    if (request.kind === 'messages') {
      request.body.thinking = { type: resolved.reasoning.enabled ? 'adaptive' : 'disabled' };
    } else {
      request.body.reasoning = { ...resolved.reasoning };
    }
  }
  if (resolved.verbosity) {
    if (request.kind === 'messages') {
      request.body.output_config = {
        ...request.body.output_config,
        effort: resolved.verbosity,
      };
    } else if (request.kind === 'responses') {
      request.body.text = {
        ...request.body.text,
        verbosity: resolved.verbosity as OpenAI.Responses.ResponseTextConfig['verbosity'],
      };
    } else {
      request.body.verbosity = resolved.verbosity as OpenRouterChatCompletionRequest['verbosity'];
    }
  }
}
