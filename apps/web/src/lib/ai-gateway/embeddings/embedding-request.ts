import { Buffer } from 'node:buffer';

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

function floatEmbeddingToBase64(embedding: number[]): string {
  return Buffer.from(new Float32Array(embedding).buffer).toString('base64');
}

export async function buildDownstreamResponse(
  response: Response,
  encodingFormat: EmbeddingProxyRequest['encoding_format']
): Promise<Response> {
  if (!response.ok || encodingFormat !== 'base64') return response;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return response;

  const body = await response.clone().json();
  if (!body || typeof body !== 'object' || !Array.isArray(body.data)) return response;

  const data = body.data.map((item: unknown) => {
    if (
      !item ||
      typeof item !== 'object' ||
      !Array.isArray((item as { embedding?: unknown }).embedding)
    ) {
      return item;
    }
    return {
      ...item,
      embedding: floatEmbeddingToBase64((item as { embedding: number[] }).embedding),
    };
  });

  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');

  return new Response(JSON.stringify({ ...body, data }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
