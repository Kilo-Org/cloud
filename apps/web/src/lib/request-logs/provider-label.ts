import { normalizePublicInferenceProvider } from '@/lib/public-inference-provider';

export function formatRequestLogProvider(inferenceProvider: string | null): string | null {
  const rawInferenceProvider = inferenceProvider?.trim();
  if (!rawInferenceProvider) return null;
  return normalizePublicInferenceProvider(rawInferenceProvider).name;
}
