import type {
  GatewayGenerateContentRequest,
  GeminiFunctionDeclaration,
  GeminiGenerateContentRequest,
  GeminiPart,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

export function geminiParts(body: GeminiGenerateContentRequest): GeminiPart[] {
  return body.contents.flatMap(content =>
    Array.isArray(content?.parts) ? content.parts.filter(part => part != null) : []
  );
}

export function geminiFunctionDeclarations(
  body: GeminiGenerateContentRequest
): GeminiFunctionDeclaration[] {
  return (Array.isArray(body.tools) ? body.tools : []).flatMap(tool =>
    Array.isArray(tool?.functionDeclarations) ? tool.functionDeclarations : []
  );
}

/**
 * `@ai-sdk/google` requests `{baseURL}/models/{model}:{method}`, or
 * `{baseURL}/{model}:{method}` when the model ID already contains a slash, as
 * gateway model IDs do. Google's own SDKs add a `v1beta` version segment.
 */
const GENERATE_CONTENT_PATH =
  /^\/(?:v1beta\/)?(?:models\/)?([^/](?:.*[^/])?):(generateContent|streamGenerateContent)$/;

export type GenerateContentPath = { model: string; stream: boolean };

export function parseGenerateContentPath(pathSuffix: string): GenerateContentPath | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathSuffix);
  } catch {
    return null;
  }
  const match = GENERATE_CONTENT_PATH.exec(decoded);
  const model = match?.[1]?.trim();
  if (!match || !model) {
    return null;
  }
  return { model, stream: match[2] === 'streamGenerateContent' };
}

/**
 * Without `alt=sse`, streamGenerateContent streams one JSON array instead of
 * server-sent events, which the gateway does not proxy.
 */
export function isServerSentEventsStream(searchParams: URLSearchParams) {
  return searchParams.get('alt') === 'sse';
}

/**
 * The upstream path and query are rebuilt from the parsed request instead of
 * forwarding the client's, because Gemini clients may send their API key, which
 * for the gateway is the Kilo token, in the `key` query parameter.
 */
export function generateContentUpstreamTarget(body: GatewayGenerateContentRequest): {
  path: string;
  search: string;
  body: GeminiGenerateContentRequest;
} {
  const upstreamBody: Partial<GatewayGenerateContentRequest> = { ...body };
  delete upstreamBody.model;
  delete upstreamBody.stream;
  delete upstreamBody.provider;
  delete upstreamBody.providerOptions;
  delete upstreamBody.models;
  delete upstreamBody.enable_thinking;
  delete upstreamBody.thinking;
  return {
    path: `/models/${encodeURIComponent(body.model)}:${body.stream ? 'streamGenerateContent' : 'generateContent'}`,
    search: body.stream ? '?alt=sse' : '',
    body: { ...upstreamBody, contents: body.contents },
  };
}
