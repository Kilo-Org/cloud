import type { KiloExclusiveModel } from '@/lib/providers/kilo-exclusive-model';

export function isXiaomiModel(model: string) {
  return model.startsWith('xiaomi/');
}

export const mimo_v2_pro_free_model: KiloExclusiveModel = {
  public_id: 'xiaomi/mimo-v2-pro:free',
  display_name: 'Xiaomi: MiMo-V2-Pro (free)',
  description:
    'MiMo V2 Pro is a frontier-scale open-source large language model with over 1 trillion parameters, developed in China and optimized specifically for agentic workflows. It excels in frameworks such as OpenClaw, with native 1M-token context support that enables reliable handling of complex, long-horizon, multi-step tasks. In agentic reasoning, tool use, and multi-step execution benchmarks, its performance sits between Claude 4.6 Sonnet and Claude 4.6 Opus.',
  context_length: 1048576,
  max_completion_tokens: 131072,
  status: 'disabled',
  flags: ['free', 'reasoning', 'prompt_cache', 'vision'],
  gateway: 'openrouter',
  internal_id: 'xiaomi/mimo-v2-pro',
  inference_provider: null,
};

export const mimo_v2_omni_free_model: KiloExclusiveModel = {
  public_id: 'xiaomi/mimo-v2-omni:free',
  display_name: 'Xiaomi: MiMo-V2-Omni (free)',
  description:
    'MiMo-V2-Omni is a frontier omni-modal model that natively processes image, video, and audio inputs within a unified architecture. It combines strong multimodal perception with agentic capability — visual grounding, multi-step planning, tool use, and code execution — making it well-suited for complex real-world tasks that span modalities. 256K context window.',
  context_length: 262144,
  max_completion_tokens: 65536,
  status: 'disabled',
  flags: ['free', 'reasoning', 'prompt_cache', 'vision'],
  gateway: 'openrouter',
  internal_id: 'xiaomi/mimo-v2-omni',
  inference_provider: null,
};
