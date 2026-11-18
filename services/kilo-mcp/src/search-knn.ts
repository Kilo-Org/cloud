import { EMBEDDING_MODEL } from './embedding';
import type { SemanticCandidates } from './types';

/** Minimum kNN candidates fetched regardless of the caller's limit. */
const MIN_TOP_K = 20;

/** Vectorize caps a single query at 100 results. */
const MAX_TOP_K = 100;

/**
 * The slice of the worker Env that semantic search needs: Workers AI for the
 * query embedding, Vectorize for the kNN lookup. Structural so tests can
 * inject fakes; the worker passes the real `Env`.
 */
export type SearchKnnEnv = {
  AI: {
    run(model: string, input: { text: string }): Promise<{ data: number[][]; shape?: number[] }>;
  };
  VECTORIZE: {
    query(
      vector: number[],
      options: { topK: number; returnMetadata: 'none' }
    ): Promise<{ matches: Array<{ id: string; score: number }>; count?: number }>;
  };
};

/**
 * Vectorize-backed semantic candidates for hybrid search. The search QUERY is
 * the only text embedded per request; the index itself was embedded offline by
 * scripts/embed-catalog.ts, whose vector ids are the procedure paths, so each
 * match id is the catalog path (requirement 9).
 *
 * Raises on any failure (binding missing, embedding error, index error): the
 * caller — searchCatalog — degrades to token-only results with a logged note
 * instead of failing the search.
 */
export function createSemanticCandidates(env: SearchKnnEnv): SemanticCandidates {
  return async (query: string, limit: number) => {
    const embedding = await env.AI.run(EMBEDDING_MODEL, { text: query });
    const vector = embedding.data[0];
    if (!vector || vector.length === 0) {
      throw new Error(`embedding model ${EMBEDDING_MODEL} returned an empty vector`);
    }
    const topK = Math.min(Math.max(limit, MIN_TOP_K), MAX_TOP_K);
    const result = await env.VECTORIZE.query(vector, { topK, returnMetadata: 'none' });
    if (result.matches.length === 0) {
      // Empty index (embed job not yet run) or no similar rows: not an error,
      // but say so — the results the caller sees are token-only.
      console.warn(
        '[kilo-mcp] semantic index returned no candidates (index may be empty or unpopulated); continuing with token-only results'
      );
    }
    return result.matches.map(match => ({ path: match.id, score: match.score }));
  };
}
