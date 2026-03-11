import { type KiloFreeModel } from '@/lib/providers/kilo-free-model';

export const nemotron_3_super_free_model: KiloFreeModel = {
  public_id: 'nvidia/nemotron-3-super-120b-a12b:free',
  display_name: 'NVIDIA: Nemotron 3 Super (free)',
  description:
    'NVIDIA Nemotron 3 Super is a 120B-parameter open hybrid MoE model, activating just 12B parameters for maximum compute efficiency and accuracy in complex multi-agent applications. Built on a hybrid Mamba-Transformer Mixture-of-Experts architecture with multi-token prediction (MTP), it delivers over 50% higher token generation compared to leading open models. The model features a 1M token context window for long-term agent coherence, cross-document reasoning, and multi-step task planning.',
  context_length: 1000000,
  max_completion_tokens: 131072,
  is_enabled: true,
  flags: ['reasoning'],
  gateway: 'openrouter',
  internal_id: 'nvidia/nemotron-3-super-120b-a12b',
  inference_provider: null,
};
