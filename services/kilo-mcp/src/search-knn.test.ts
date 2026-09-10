import { describe, expect, it, vi } from 'vitest';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from './embedding';
import { createSemanticCandidates, type SearchKnnEnv } from './search-knn';

const VECTOR_768 = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i % 97) / 97);

type RunFn = SearchKnnEnv['AI']['run'];
type QueryFn = SearchKnnEnv['VECTORIZE']['query'];

function fakeEnv(overrides?: { run?: RunFn; query?: QueryFn }): {
  env: SearchKnnEnv;
  run: ReturnType<typeof vi.fn<RunFn>>;
  query: ReturnType<typeof vi.fn<QueryFn>>;
} {
  const run = vi.fn<RunFn>(
    overrides?.run ?? (async () => ({ data: [VECTOR_768], shape: [1, EMBEDDING_DIMENSIONS] }))
  );
  const query = vi.fn<QueryFn>(
    overrides?.query ??
      (async () => ({ matches: [{ id: 'user.getBalance', score: 0.9 }], count: 1 }))
  );
  return { env: { AI: { run }, VECTORIZE: { query } }, run, query };
}

describe('createSemanticCandidates', () => {
  it('embeds the search query with the pinned model and queries the index with that vector', async () => {
    const { env, run, query } = fakeEnv();
    const candidates = createSemanticCandidates(env);
    await candidates('refund the user balance', 10);
    expect(run).toHaveBeenCalledWith(EMBEDDING_MODEL, { text: 'refund the user balance' });
    expect(query).toHaveBeenCalledWith(VECTOR_768, { topK: 20, returnMetadata: 'none' });
  });

  it('maps match ids (procedure paths) to candidates with their kNN scores', async () => {
    const { env } = fakeEnv({
      query: async () => ({
        matches: [
          { id: 'user.getBalance', score: 0.92 },
          { id: 'organizations.list', score: 0.41 },
        ],
      }),
    });
    const candidates = createSemanticCandidates(env);
    expect(await candidates('balance', 10)).toEqual([
      { path: 'user.getBalance', score: 0.92 },
      { path: 'organizations.list', score: 0.41 },
    ]);
  });

  it('requests at least 20 and at most 100 candidates regardless of the caller limit', async () => {
    const low = fakeEnv();
    await createSemanticCandidates(low.env)('q', 3);
    expect(low.query).toHaveBeenCalledWith(expect.anything(), { topK: 20, returnMetadata: 'none' });
    const high = fakeEnv();
    await createSemanticCandidates(high.env)('q', 500);
    expect(high.query).toHaveBeenCalledWith(expect.anything(), {
      topK: 100,
      returnMetadata: 'none',
    });
  });

  it('raises on an embedding failure so the search degrades to token-only', async () => {
    const { env } = fakeEnv({
      run: async () => {
        throw new Error('AI binding unavailable');
      },
    });
    await expect(createSemanticCandidates(env)('q', 10)).rejects.toThrow('AI binding unavailable');
  });

  it('raises on an empty embedding vector', async () => {
    const { env } = fakeEnv({ run: async () => ({ data: [] }) });
    await expect(createSemanticCandidates(env)('q', 10)).rejects.toThrow('empty vector');
  });

  it('raises on a Vectorize failure so the search degrades to token-only', async () => {
    const { env } = fakeEnv({
      query: async () => {
        throw new Error('index unavailable');
      },
    });
    await expect(createSemanticCandidates(env)('q', 10)).rejects.toThrow('index unavailable');
  });

  it('logs a non-fatal note and returns no candidates when the index is empty or unpopulated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { env } = fakeEnv({ query: async () => ({ matches: [] }) });
      await expect(createSemanticCandidates(env)('q', 10)).resolves.toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no candidates'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('token-only results'));
    } finally {
      warn.mockRestore();
    }
  });
});
