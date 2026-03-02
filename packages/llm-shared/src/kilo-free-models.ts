import type { KiloFreeModel } from './kilo-free-model.js';

// Anthropic model IDs
export const CLAUDE_SONNET_CURRENT_MODEL_ID = 'anthropic/claude-sonnet-4.6';
export const CLAUDE_OPUS_CURRENT_MODEL_ID = 'anthropic/claude-opus-4.6';

// CoreThink
export const corethink_free_model = {
  public_id: 'corethink:free',
  display_name: 'CoreThink (free)',
  description:
    'CoreThink - AI that reasons through problems instead of guessing. Available free of charge in Kilo for a limited time.',
  context_length: 78_000,
  max_completion_tokens: 8192,
  is_enabled: true,
  flags: [],
  gateway: 'corethink',
  internal_id: 'corethink',
  inference_providers: ['corethink'],
} as KiloFreeModel;

// Giga Potato
export const giga_potato_model = {
  public_id: 'giga-potato',
  display_name: 'Giga Potato (free)',
  description:
    'Giga Potato is a stealth model deeply optimized for agentic programming, with visual understanding capability. ' +
    'It is provided free of charge in Kilo Code for a limited time.\n' +
    '**Note:** Prompts and completions are logged and may be used to improve the model.',
  context_length: 256_000,
  max_completion_tokens: 32_000,
  is_enabled: true,
  flags: ['prompt_cache', 'vision'],
  gateway: 'gigapotato',
  internal_id: 'ep-20260109111813-hztxv',
  inference_providers: ['stealth'],
} as KiloFreeModel;

export const giga_potato_thinking_model = {
  ...giga_potato_model,
  public_id: 'giga-potato-thinking',
  display_name: 'Giga Potato Thinking (free)',
  flags: giga_potato_model.flags.concat(['reasoning']),
} as KiloFreeModel;

// MiniMax
export const minimax_m25_free_model = {
  public_id: 'minimax/minimax-m2.5:free',
  display_name: 'MiniMax: MiniMax M2.5 (free)',
  description:
    'MiniMax-M2.5 is a SOTA large language model designed for real-world productivity. Trained in a diverse range of complex real-world digital working environments, M2.5 builds upon the coding expertise of M2.1 to extend into general office work, reaching fluency in generating and operating Word, Excel, and Powerpoint files, context switching between diverse software environments, and working across different agent and human teams. Scoring 80.2% on SWE-Bench Verified, 51.3% on Multi-SWE-Bench, and 76.3% on BrowseComp, M2.5 is also more token efficient than previous generations, having been trained to optimize its actions and output through planning.',
  context_length: 204800,
  max_completion_tokens: 131072,
  is_enabled: true,
  flags: ['reasoning', 'prompt_cache'],
  gateway: 'openrouter',
  internal_id: 'minimax/minimax-m2.5',
  inference_providers: [],
} as KiloFreeModel;

// MoonshotAI
export const kimi_k25_free_model: KiloFreeModel = {
  public_id: 'moonshotai/kimi-k2.5:free',
  display_name: 'MoonshotAI: Kimi K2.5 (free)',
  description:
    "Kimi K2.5 is Moonshot AI's native multimodal model, delivering state-of-the-art visual coding capability and a self-directed agent swarm paradigm. Built on Kimi K2 with continued pretraining over approximately 15T mixed visual and text tokens, it delivers strong performance in general reasoning, visual coding, and agentic tool-calling.",
  context_length: 262144,
  max_completion_tokens: 65536,
  is_enabled: true,
  flags: ['reasoning', 'prompt_cache', 'vision'],
  gateway: 'openrouter',
  internal_id: 'moonshotai/kimi-k2.5',
  inference_providers: [],
};

// xAI
export const grok_code_fast_1_optimized_free_model = {
  public_id: 'x-ai/grok-code-fast-1:optimized:free',
  display_name: 'xAI: Grok Code Fast 1 Optimized (experimental, free)',
  description:
    'An optimized variant of Grok Code Fast 1, provided free of charge for a limited time. **Note:** All prompts and completions for this model are logged by the provider and may be used to improve their services.',
  context_length: 256_000,
  max_completion_tokens: 10_000,
  is_enabled: false,
  flags: ['reasoning', 'prompt_cache'],
  gateway: 'martian',
  internal_id: 'x-ai/grok-code-fast-1:optimized',
  inference_providers: ['stealth'],
} satisfies KiloFreeModel;

// Z.AI
export const zai_glm5_free_model = {
  public_id: 'z-ai/glm-5:free',
  display_name: 'Z.ai: GLM 5 (free)',
  description:
    "GLM-5 is Z.ai's flagship open-source foundation model engineered for complex systems design and long-horizon agent workflows. Built for expert developers, it delivers production-grade performance on large-scale programming tasks, rivaling leading closed-source models. With advanced agentic planning, deep backend reasoning, and iterative self-correction, GLM-5 moves beyond code generation to full-system construction and autonomous execution.",
  context_length: 202800,
  max_completion_tokens: 131072,
  is_enabled: false,
  flags: ['reasoning', 'prompt_cache'],
  gateway: 'openrouter',
  internal_id: 'z-ai/glm-5',
  inference_providers: [],
} as KiloFreeModel;
