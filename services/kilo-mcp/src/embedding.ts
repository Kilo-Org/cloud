/**
 * The ONE pinned embedding model for the Kilo catalog semantic index, shared
 * by the worker (query embedding, src/search-knn.ts) and the embed script
 * (scripts/embed-catalog.ts). Pinning here keeps the index and query
 * embeddings from ever drifting: the Vectorize index is created with exactly
 * these dimensions and metric, and every embedding call uses exactly this
 * model.
 *
 * Embedding happens only at dump/embed time. Nothing embeds catalog content
 * per `call`; per request the ONLY text embedded is the search QUERY inside
 * `search` (via the AI binding below).
 */

/** Workers AI embedding model id (Cloudflare catalog: BAAI bge-base-en-v1.5). */
export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';

/** Output dimensionality of EMBEDDING_MODEL; the Vectorize index is created with it. */
export const EMBEDDING_DIMENSIONS = 768;

/** Similarity metric of the Vectorize index. */
export const EMBEDDING_METRIC = 'cosine' as const;
