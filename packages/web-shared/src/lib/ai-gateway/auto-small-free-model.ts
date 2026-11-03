import 'server-only';

import {
  GEMMA_4_26B_A4B_IT_FREE_ID,
  GEMMA_4_26B_A4B_IT_ID,
} from '@kilocode/web-shared/lib/ai-gateway/providers/google';

/**
 * The model `kilo-auto/small` routes users without balance to. Direct requests
 * for it are rejected as unavailable. Kilo pays to serve it as the paid model,
 * so it stays on Kilo's own accounts and never uses a user's BYOK key.
 */
export function isAutoSmallFreeModel(model: string): boolean {
  return model === GEMMA_4_26B_A4B_IT_FREE_ID;
}

export const AUTO_SMALL_FREE_MODEL_UPSTREAM_ID = GEMMA_4_26B_A4B_IT_ID;

export const AUTO_SMALL_FREE_MODEL_CONTEXT_LENGTH = 262144;
