import type { DirectUserByokInferenceProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';

// Client-safe display names for direct BYOK providers.
export const DIRECT_BYOK_PROVIDERS_META = {
  'alibaba-token-plan': 'Alibaba Token Plan (Singapore)',
  'aws-bedrock': 'Amazon Bedrock (direct)',
  'byteplus-coding': 'BytePlus Coding Plan',
  'chutes-byok': 'Chutes BYOK',
  edenai: 'Eden AI',
  'gcp-vertex': 'Google Vertex AI (direct)',
  'kimi-coding': 'Kimi Code',
  'inceptron-byok': 'Inceptron BYOK',
  martian: 'Martian',
  'morph-byok': 'Morph BYOK',
  neuralwatt: 'Neuralwatt',
  'nvidia-byok': 'NVIDIA BYOK',
  'ollama-cloud': 'Ollama Cloud',
  'opencode-go': 'OpenCode Go',
  orcarouter: 'OrcaRouter',
  synthetic: 'Synthetic',
  'xiaomi-token-plan-ams': 'Xiaomi Token Plan (Europe)',
  'xiaomi-token-plan-sgp': 'Xiaomi Token Plan (Singapore)',
  'zai-coding': 'Z.ai Coding Plan',
} as const satisfies Record<Exclude<DirectUserByokInferenceProviderId, 'codestral'>, string>;

export type DirectByokProviderMetaId = keyof typeof DIRECT_BYOK_PROVIDERS_META;

/**
 * Direct cloud providers in proof of concept. Keys for them can only be added
 * outside production, or by the Kilo organization.
 */
export const DIRECT_CLOUD_BYOK_PROVIDER_IDS: ReadonlyArray<DirectByokProviderMetaId> = [
  'aws-bedrock',
  'gcp-vertex',
];

export function isDirectCloudByokProviderId(providerId: string): boolean {
  return (DIRECT_CLOUD_BYOK_PROVIDER_IDS as ReadonlyArray<string>).includes(providerId);
}
