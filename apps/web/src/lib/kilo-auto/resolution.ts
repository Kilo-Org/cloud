import type { FeatureValue } from '@/lib/feature-detection';
import { minimax_m25_free_model } from '@/lib/providers/minimax';
import { gpt_oss_20b_free_model, GPT_5_NANO_ID } from '@/lib/providers/openai';
import type {
  GatewayRequest,
  OpenRouterChatCompletionRequest,
} from '@/lib/providers/openrouter/types';
import type OpenAI from 'openai';
import type { User } from '@kilocode/db';
import {
  KILO_AUTO_FREE_MODEL,
  KILO_AUTO_SMALL_MODEL,
  KILO_AUTO_BALANCED_MODEL,
  modeSchema,
  BALANCED_CLAW_SETUP_MODEL,
  BALANCED_CODEX_MODEL,
  BALANCED_QWEN_MODEL,
  FRONTIER_MODE_TO_MODEL,
  FRONTIER_CODE_MODEL,
  type ResolvedAutoModel,
} from '@/lib/kilo-auto';
import { userIsWithinFirstKiloClawInstanceWindow } from '@/lib/kiloclaw/setup-promo';

const ENABLE_QWEN_KILOCLAW_MODEL = false;

export async function resolveAutoModel(
  model: string,
  modeHeader: string | null,
  userPromise: Promise<User | null>,
  balancePromise: Promise<number>
): Promise<ResolvedAutoModel> {
  if (model === KILO_AUTO_FREE_MODEL.id) {
    return { model: minimax_m25_free_model.public_id };
  }
  if (model === KILO_AUTO_SMALL_MODEL.id) {
    return {
      model: (await balancePromise) > 0 ? GPT_5_NANO_ID : gpt_oss_20b_free_model.public_id,
    };
  }
  const modeResult = modeSchema.safeParse(modeHeader?.trim() ?? '');
  const mode = modeResult.success ? modeResult.data : null;
  if (model === KILO_AUTO_BALANCED_MODEL.id) {
    if (mode === modeSchema.enum.KiloClaw) {
      const user = await userPromise;
      if (user && (await userIsWithinFirstKiloClawInstanceWindow({ userId: user.id }))) {
        return BALANCED_CLAW_SETUP_MODEL;
      }
      if (ENABLE_QWEN_KILOCLAW_MODEL) {
        return BALANCED_QWEN_MODEL;
      }
    }
    return BALANCED_CODEX_MODEL;
  }
  return (mode !== null ? FRONTIER_MODE_TO_MODEL[mode] : null) ?? FRONTIER_CODE_MODEL;
}

export async function applyResolvedAutoModel(
  model: string,
  request: GatewayRequest,
  modeHeader: string | null,
  featureHeader: FeatureValue | null,
  userPromise: Promise<User | null>,
  balancePromise: Promise<number>
) {
  const resolved = await resolveAutoModel(
    model,
    featureHeader === 'kiloclaw' || featureHeader === 'openclaw' ? 'KiloClaw' : modeHeader,
    userPromise,
    balancePromise
  );
  request.body.model = resolved.model;
  if (resolved.reasoning) {
    if (request.kind === 'messages') {
      request.body.thinking = { type: resolved.reasoning.enabled ? 'adaptive' : 'disabled' };
    } else {
      request.body.reasoning = resolved.reasoning;
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
