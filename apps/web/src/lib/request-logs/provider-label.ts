import { normalizePublicInferenceProvider } from '@/lib/public-inference-provider';

const GATEWAY_NAMES = new Map([
  ['openrouter', 'OpenRouter'],
  ['vercel', 'Vercel AI Gateway'],
]);

/** The inference provider, prefixed with the gateway that routed to it; null when unknown. */
export function formatRequestLogProvider(
  provider: string | null,
  inferenceProvider: string | null
): string | null {
  const rawInferenceProvider = inferenceProvider?.trim();
  if (!rawInferenceProvider) return null;
  const name = normalizePublicInferenceProvider(rawInferenceProvider).name;
  const gateway = provider ? GATEWAY_NAMES.get(provider) : undefined;
  return gateway ? `${gateway} -> ${name}` : name;
}
