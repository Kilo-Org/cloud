import 'server-only';

import {
  AUTO_SMALL_TARGET_MODELS,
  KILO_AUTO_SMALL_MODEL,
} from '@kilocode/web-shared/lib/ai-gateway/auto-model';

/** Kilo funds this fallback, so it must never use a user's BYOK key. */
export function isAutoSmallFreeModel(model: string): boolean {
  return model === AUTO_SMALL_TARGET_MODELS.free;
}

export const AUTO_SMALL_FREE_MODEL_UPSTREAM_ID = AUTO_SMALL_TARGET_MODELS.paid;

export const AUTO_SMALL_FREE_MODEL_CONTEXT_LENGTH = KILO_AUTO_SMALL_MODEL.context_length;
