/**
 * Hardcoded catalog of embedding models available through the Kilo Gateway.
 * These models are all routed through OpenRouter and known to work with
 * the gateway's /api/gateway/embeddings endpoint.
 */

export type EmbeddingModelOption = {
  id: string;
  name: string;
};

export const EMBEDDING_MODELS: EmbeddingModelOption[] = [
  { id: 'mistralai/mistral-embed-2312', name: 'Mistral Embed' },
  { id: 'openai/text-embedding-3-small', name: 'OpenAI Text Embedding 3 Small' },
  { id: 'openai/text-embedding-3-large', name: 'OpenAI Text Embedding 3 Large' },
  { id: 'google/gemini-embedding-001', name: 'Google Gemini Embedding 001' },
  { id: 'mistralai/codestral-embed-2505', name: 'Codestral Embed' },
];

/**
 * Source of truth: `services/kiloclaw/src/schemas/instance-config.ts` →
 * `DEFAULT_VECTOR_MEMORY_MODEL`. Duplicated here because the web bundle does
 * not import from the worker tree. Keep in sync across worker, controller
 * (`controller/src/config-writer.ts`), and this file.
 */
export const DEFAULT_EMBEDDING_MODEL = 'mistralai/mistral-embed-2312';
