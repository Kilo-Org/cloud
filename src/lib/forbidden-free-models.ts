const forbiddenFreeModelIds: ReadonlySet<string> = new Set([
  'arcee-ai/trinity-mini:free',
  'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
  'deepseek/deepseek-r1-0528:free',
  'giga-potato',
  'giga-potato-thinking',
  'google/gemma-3-12b-it:free',
  'google/gemma-3-27b-it:free',
  'google/gemma-3-4b-it:free',
  'google/gemma-3n-e2b-it:free',
  'google/gemma-3n-e4b-it:free',
  'kilo/auto-free', // discontinued variant of kilo-auto/free
  'liquid/lfm-2.5-1.2b-instruct:free',
  'liquid/lfm-2.5-1.2b-thinking:free',
  'meta-llama/llama-3.2-3b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'minimax/minimax-m2.1:free',
  'minimax/minimax-m2.5:free', // usable through kilo-auto
  'moonshotai/kimi-k2.5:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'openai/gpt-oss-120b:free',
  'openai/gpt-oss-20b:free', // usable through kilo-auto
  'qwen/qwen3-4b:free',
  'qwen/qwen3-coder:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'qwen/qwen3.6-plus-preview:free',
  'upstage/solar-pro-3:free',
  'z-ai/glm-4.5-air:free',
  'z-ai/glm-5:free',
]);

export function isForbiddenFreeModel(modelId: string): boolean {
  return forbiddenFreeModelIds.has(modelId);
}
