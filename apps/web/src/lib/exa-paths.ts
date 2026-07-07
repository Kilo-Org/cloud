export const EXA_ALLOWED_PATHS = [
  '/search',
  '/contents',
  '/findSimilar',
  '/answer',
  '/context',
] as const;

export type ExaAllowedPath = (typeof EXA_ALLOWED_PATHS)[number];

const exaAllowedPathSet: ReadonlySet<string> = new Set(EXA_ALLOWED_PATHS);

export function isExaAllowedPath(path: string): path is ExaAllowedPath {
  return exaAllowedPathSet.has(path);
}

const exaCostInsightFeatureKeyByPath: Record<ExaAllowedPath, string> = {
  '/search': 'search',
  '/contents': 'contents',
  '/findSimilar': 'findSimilar',
  '/answer': 'answer',
  '/context': 'context',
};

export function getExaCostInsightFeatureKey(path: string): string {
  return isExaAllowedPath(path) ? exaCostInsightFeatureKeyByPath[path] : 'other';
}
