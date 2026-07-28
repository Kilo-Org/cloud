export function isFreeNemotronModel(model: string) {
  return model.includes('nemotron') && model.endsWith(':free');
}

type NvidiaReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'max';

// Models absent here must not receive reasoning controls; NVIDIA returns 400 for
// efforts a model does not accept.
const NVIDIA_REASONING_EFFORTS_BY_MODEL: Readonly<
  Record<string, ReadonlyArray<NvidiaReasoningEffort>>
> = {
  'nvidia/nemotron-3-super-120b-a12b': ['none', 'low', 'high'],
  'nvidia/nemotron-3-ultra-550b-a55b': ['none', 'medium', 'high'],
  'deepseek-ai/deepseek-v4-flash': ['none', 'high', 'max'],
  'deepseek-ai/deepseek-v4-pro': ['none', 'high', 'max'],
  'openai/gpt-oss-20b': ['low', 'medium', 'high'],
  'openai/gpt-oss-120b': ['low', 'medium', 'high'],
};

export function getNvidiaReasoningEfforts(model: string) {
  return NVIDIA_REASONING_EFFORTS_BY_MODEL[model];
}

export const NVIDIA_TRIAL_TOS =
  'For NVIDIA free endpoints (Super/Ultra/etc): Trial use only - do not submit personal or confidential data. Your use is logged for security purposes and to improve NVIDIA products and services. The logged session data for improvement purposes is not linked to your identity or any persistent identifier. For more information about our data processing practices, see our [Privacy Policy](https://www.nvidia.com/en-us/about-nvidia/privacy-policy/). By interacting with this endpoint, you consent to our collection, recording, and use of such information and the [NVIDIA API Trial Terms of Service](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf).';
