import type { Catalog, CatalogRow, SearchResult, SemanticCandidates } from './types';

/** Default number of search rows returned when the caller omits `limit`. */
export const DEFAULT_SEARCH_LIMIT = 10;

/** Published upper bound on `search.limit`; the tool schema advertises the same value. */
export const MAX_SEARCH_LIMIT = 50;

/**
 * Hybrid-ready scoring weights. A single-token overlap contributes at most
 * OVERLAP_WEIGHT; a contiguous query-token sequence found in the endpoint's
 * own path scores above that; an exact full-path match scores above the
 * sequence hit. Semantic (Vectorize) scores are blended in additively at
 * SEMANTIC_WEIGHT times the candidate's 0..1 similarity; rows admitted by
 * semantics alone are rescaled below the smallest score a lexical hit can
 * reach (requirement 1: any token/exact hit outranks a semantic-only hit).
 */
const OVERLAP_WEIGHT = 10;
const PATH_SEQUENCE_BONUS = 50;
const EXACT_PATH_BONUS = 100;
const SEMANTIC_WEIGHT = 5;

/** s2 ships without Vectorize: the kNN hook defaults to "no semantic candidates". */
export const noSemanticCandidates: SemanticCandidates = async () => [];

/**
 * Splits identifiers and prose into comparable lowercase tokens: camelCase
 * boundaries ("activeSessions" -> active, sessions), dots, and any other
 * non-alphanumeric separator.
 */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 0);
}

function isContiguousSequence(needles: string[], haystack: string[]): boolean {
  if (needles.length === 0 || needles.length > haystack.length) return false;
  outer: for (let start = 0; start + needles.length <= haystack.length; start += 1) {
    for (let offset = 0; offset < needles.length; offset += 1) {
      if (haystack[start + offset] !== needles[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function lexicalScore(
  queryTokens: string[],
  normalizedQuery: string,
  row: CatalogRow,
  blobTokens: Set<string>
): number {
  const uniqueQuery = new Set(queryTokens);
  let matched = 0;
  for (const token of uniqueQuery) {
    if (blobTokens.has(token)) matched += 1;
  }
  const overlap = uniqueQuery.size === 0 ? 0 : matched / uniqueQuery.size;
  let score = overlap * OVERLAP_WEIGHT;
  // A sequence bonus needs at least two tokens; a lone token is a plain
  // single-token hit and must not outrank a real path-sequence match.
  if (queryTokens.length >= 2 && isContiguousSequence(queryTokens, tokenize(row.path))) {
    score += PATH_SEQUENCE_BONUS;
  }
  if (normalizedQuery.length > 0 && normalizedQuery === row.path.toLowerCase()) {
    score += EXACT_PATH_BONUS;
  }
  return score;
}

/**
 * Token-overlap search over the bundled catalog, deterministic: rows are
 * ordered by score descending, then by path ascending. Rows with a zero score
 * are dropped. The `semanticCandidates` hook is where s3 plugs in Vectorize
 * kNN; its 0..1 scores are blended in additively.
 */
export async function searchCatalog(
  query: string,
  options: {
    catalog: Catalog;
    limit?: number;
    semanticCandidates?: SemanticCandidates;
  }
): Promise<SearchResult[]> {
  const { catalog, semanticCandidates = noSemanticCandidates } = options;
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_SEARCH_LIMIT));
  const queryTokens = tokenize(query);
  const normalizedQuery = query.trim().toLowerCase();
  if (queryTokens.length === 0) return [];

  type ScoredRow = SearchResult & { blobTokens: Set<string> };
  const rows: ScoredRow[] = [];
  const byPath = new Map<string, ScoredRow>();
  for (const row of Object.values(catalog)) {
    const blobTokens = new Set(tokenize(row.searchBlob));
    const score = lexicalScore(queryTokens, normalizedQuery, row, blobTokens);
    if (score <= 0) continue;
    const scored: ScoredRow = {
      path: row.path,
      kind: row.kind,
      summary: row.summary,
      tags: row.tags,
      score,
      blobTokens,
    };
    rows.push(scored);
    byPath.set(row.path, scored);
  }

  // Blend in semantic candidates. A semantic hit on a row the lexical pass
  // missed is admitted at a score strictly below the token band: the smallest
  // lexical score reachable for this query is OVERLAP_WEIGHT / unique tokens
  // (one token matched), so a semantic-only row is scaled to half of that at
  // full similarity and stays below every token/exact hit. An injection or
  // Vectorize failure degrades to token-only results with a logged note —
  // search must keep serving (retryable unhappy state).
  let candidates: Array<{ path: string; score: number }> = [];
  try {
    candidates = await semanticCandidates(query, limit);
  } catch (error) {
    console.warn(
      `[kilo-mcp] semantic search degraded to token-only results: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const minLexicalScore = OVERLAP_WEIGHT / Math.max(1, new Set(queryTokens).size);
  for (const candidate of candidates) {
    const row = catalog[candidate.path];
    if (!row) continue;
    const existing = byPath.get(row.path);
    if (existing) {
      existing.score += candidate.score * SEMANTIC_WEIGHT;
    } else {
      const admitted: ScoredRow = {
        path: row.path,
        kind: row.kind,
        summary: row.summary,
        tags: row.tags,
        score: candidate.score * minLexicalScore * 0.5,
        blobTokens: new Set(),
      };
      if (admitted.score > 0) {
        rows.push(admitted);
        byPath.set(row.path, admitted);
      }
    }
  }

  rows.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.path.localeCompare(b.path)));
  return rows.map(({ blobTokens: _blobTokens, ...result }) => result).slice(0, limit);
}
