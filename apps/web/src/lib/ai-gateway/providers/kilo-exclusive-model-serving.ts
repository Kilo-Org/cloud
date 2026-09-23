import 'server-only';

import {
  claude_opus_4_8_stealth_model,
  claude_opus_4_7_stealth_model,
  claude_sonnet_4_6_stealth_model,
  claude_opus_4_6_stealth_model,
  gemma_4_26b_a4b_it_free_model,
  qwen36_plus_stealth_model,
  stepfun_37_flash_free_model,
} from '@/lib/ai-gateway/kilo-exclusive-models';
import { MARTIAN } from '@/lib/ai-gateway/providers/definitions/martian';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import type { Provider } from '@/lib/ai-gateway/providers/types';

type KiloExclusiveModelServing = {
  model: KiloExclusiveModel;
  provider: Provider;
};

export const kiloExclusiveModelServing: ReadonlyArray<KiloExclusiveModelServing> = [
  { model: gemma_4_26b_a4b_it_free_model, provider: OPENROUTER },
  { model: qwen36_plus_stealth_model, provider: MARTIAN },
  { model: claude_opus_4_8_stealth_model, provider: MARTIAN },
  { model: claude_opus_4_7_stealth_model, provider: MARTIAN },
  { model: claude_sonnet_4_6_stealth_model, provider: MARTIAN },
  { model: claude_opus_4_6_stealth_model, provider: MARTIAN },
  { model: stepfun_37_flash_free_model, provider: OPENROUTER },
];

export function findKiloExclusiveModelServing(modelId: string): KiloExclusiveModelServing | null {
  return (
    kiloExclusiveModelServing.find(
      ({ model }) => model.public_id === modelId && model.status !== 'disabled'
    ) ?? null
  );
}
