export type EmbeddingProxyRequest = {
  model: string;
  input: unknown;
  encoding_format?: string;
  dimensions?: number;
  safety_identifier?: string;
  provider?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
  input_type?: string;
  // Mistral-specific
  output_dtype?: string;
  output_dimension?: number;
};

/**
 * Build the upstream request body for the target provider.
 * Strips the deprecated `user` field (replaced by `safety_identifier`) and
 * Mistral-specific fields that upstream providers (OpenRouter, Vercel) don't understand.
 */
export function buildUpstreamBody(
  body: EmbeddingProxyRequest & { user?: string }
): Record<string, unknown> {
  const {
    dimensions: _,
    encoding_format: __,
    output_dtype: ___,
    output_dimension: ____,
    user: _____,
    ...upstreamBody
  } = body;
  return upstreamBody;
}
