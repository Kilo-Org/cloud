export function isFreeNemotronModel(model: string) {
  return model.includes('nemotron') && model.endsWith(':free');
}

export const NVIDIA_NEMOTRON_3_SUPER_MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b';
export const NVIDIA_NEMOTRON_3_ULTRA_MODEL_ID = 'nvidia/nemotron-3-ultra-550b-a55b';

export type NvidiaReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'max';

// Models absent here must not receive reasoning controls; NVIDIA returns 400 for
// efforts a model does not accept.
const NVIDIA_REASONING_EFFORTS_BY_MODEL: Readonly<
  Record<string, ReadonlyArray<NvidiaReasoningEffort>>
> = {
  [NVIDIA_NEMOTRON_3_SUPER_MODEL_ID]: ['none', 'low', 'high'],
  [NVIDIA_NEMOTRON_3_ULTRA_MODEL_ID]: ['none', 'medium', 'high'],
  'deepseek-ai/deepseek-v4-flash': ['none', 'high', 'max'],
  'deepseek-ai/deepseek-v4-pro': ['none', 'high', 'max'],
  'openai/gpt-oss-20b': ['low', 'medium', 'high'],
  'openai/gpt-oss-120b': ['low', 'medium', 'high'],
};

// Listed as tool-capable, but these endpoints reject requests containing tools.
const NVIDIA_UNSUPPORTED_MODEL_IDS: ReadonlySet<string> = new Set([
  'google/gemma-2-2b-it',
  'google/gemma-3n-e2b-it',
  'google/gemma-3n-e4b-it',
  'qwen/qwen3.5-397b-a17b',
  'sarvamai/sarvam-m',
]);

// NVIDIA serves these with a smaller context window than the catalog advertises.
const NVIDIA_CONTEXT_LENGTH_OVERRIDES: Readonly<Record<string, number>> = {
  'nvidia/nemotron-mini-4b-instruct': 4096,
  'meta/llama-3.2-90b-vision-instruct': 32768,
};

export function isNvidiaSupportedModel(model: string) {
  return !NVIDIA_UNSUPPORTED_MODEL_IDS.has(model);
}

export function getNvidiaContextLengthOverride(model: string) {
  return NVIDIA_CONTEXT_LENGTH_OVERRIDES[model];
}

export function getNvidiaReasoningEfforts(model: string) {
  const upstreamModel = model.startsWith('nvidia-byok/')
    ? model.slice('nvidia-byok/'.length)
    : model;
  return NVIDIA_REASONING_EFFORTS_BY_MODEL[upstreamModel];
}

export function isNvidiaReasoningEffort(
  model: string,
  effort: unknown
): effort is NvidiaReasoningEffort {
  return (
    typeof effort === 'string' &&
    getNvidiaReasoningEfforts(model)?.some(candidate => candidate === effort) === true
  );
}

export const NVIDIA_TRIAL_TOS =
  'For NVIDIA free endpoints (Super/Ultra/etc): Trial use only - do not submit personal or confidential data. Your use is logged for security purposes and to improve NVIDIA products and services. The logged session data for improvement purposes is not linked to your identity or any persistent identifier. For more information about our data processing practices, see our [Privacy Policy](https://www.nvidia.com/en-us/about-nvidia/privacy-policy/). By interacting with this endpoint, you consent to our collection, recording, and use of such information and the [NVIDIA API Trial Terms of Service](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf).';
