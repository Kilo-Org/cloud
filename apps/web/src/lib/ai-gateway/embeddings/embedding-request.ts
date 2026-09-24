import { getKiloEmbeddingModel } from './kilo-embedding-models';

export type EmbeddingProxyRequest = {
  model: string;
  input: unknown;
  encoding_format?: string;
  dimensions?: number;
  safety_identifier?: string;
  provider?: Record<string, unknown>;
  input_type?: string;
  // Mistral-specific
  output_dtype?: string;
  output_dimension?: number;
};

export function validateEmbeddingDimensions(
  body: EmbeddingProxyRequest,
  requestedModel = body.model
): string | undefined {
  const model = getKiloEmbeddingModel(requestedModel);
  if (!model || body.dimensions == null) return undefined;

  if (model.dimensionMode === 'fixed') {
    if (body.dimensions === model.dimension) return undefined;
    return `${model.name} returns fixed ${model.dimension}-dimensional embeddings through Kilo. Remove the custom dimensions setting and re-index.`;
  }

  // Models without dimensionMode: 'fixed' support Matryoshka-style output
  // truncation up to their catalog dimension. A stale client-supplied value
  // above that ceiling (e.g. left over from a previously saved model) is
  // invalid for the resolved model and must be rejected rather than forwarded
  // upstream, where behavior would be provider-dependent.
  if (body.dimensions <= 0 || body.dimensions > model.dimension) {
    return `${model.name} supports up to ${model.dimension}-dimensional embeddings through Kilo. Lower the custom dimensions setting and re-index.`;
  }
  return undefined;
}

/**
 * Build the upstream request body for the target provider.
 * Strips the deprecated `user` field (replaced by `safety_identifier`) and
 * native Mistral fields that upstream providers (OpenRouter, Vercel) don't understand.
 * Catalog dimensions for fixed-width models describe local storage shape only.
 */
export function buildUpstreamBody(
  body: EmbeddingProxyRequest & { user?: string },
  requestedModel = body.model
): Record<string, unknown> {
  const { output_dtype: _, output_dimension: __, user: ___, ...upstreamBody } = body;
  if (getKiloEmbeddingModel(requestedModel)?.dimensionMode !== 'fixed') return upstreamBody;
  const { dimensions: ____, ...fixedBody } = upstreamBody;
  return fixedBody;
}
