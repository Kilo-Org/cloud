import { REASONING_VARIANTS_BINARY } from '@/lib/ai-gateway/providers/model-settings';
import type { DirectByokModel } from '@/lib/ai-gateway/providers/direct-byok/types';

// Metadata sourced from https://models.dev/api.json (xiaomi-token-plan-ams /
// xiaomi-token-plan-sgp). Both regional Xiaomi Token Plan endpoints expose the
// same MiMo model lineup, so we share the model definitions between them.
//
// The models.dev catalog also lists `mimo-v2-tts`, but it is a text-to-speech
// model (output modality `audio`) which is not usable through chat completions,
// so it is intentionally omitted here.
export const XIAOMI_TOKEN_PLAN_MODELS: ReadonlyArray<DirectByokModel> = [
  {
    id: 'mimo-v2.5-pro',
    name: 'MiMo-V2.5-Pro',
    flags: ['recommended'],
    context_length: 1048576,
    max_completion_tokens: 131072,
    variants: REASONING_VARIANTS_BINARY,
  },
  {
    id: 'mimo-v2.5',
    name: 'MiMo-V2.5',
    flags: ['recommended', 'vision'],
    context_length: 1048576,
    max_completion_tokens: 131072,
    variants: REASONING_VARIANTS_BINARY,
  },
  {
    id: 'mimo-v2-pro',
    name: 'MiMo-V2-Pro',
    context_length: 1048576,
    max_completion_tokens: 131072,
    variants: REASONING_VARIANTS_BINARY,
  },
  {
    id: 'mimo-v2-omni',
    name: 'MiMo-V2-Omni',
    flags: ['vision'],
    context_length: 262144,
    max_completion_tokens: 131072,
    variants: REASONING_VARIANTS_BINARY,
  },
  {
    id: 'mimo-v2-flash',
    name: 'MiMo-V2-Flash',
    context_length: 262144,
    max_completion_tokens: 65536,
    variants: REASONING_VARIANTS_BINARY,
  },
];
