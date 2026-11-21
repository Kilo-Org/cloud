import { JSON_SCHEMA, load } from 'js-yaml';
import pLimit from 'p-limit';
import type { ReviewGuidelineImport } from '@kilocode/db/schema-types';
import { fetchGitHubRepositoryDefaultBranchSha } from '@/lib/integrations/platforms/github/adapter';
import { fetchGitHubRegularFileAtCommit } from '@/lib/integrations/platforms/github/regular-file-at-commit';
import {
  cleanReviewInstructions,
  MAX_REVIEW_INSTRUCTIONS_CHARS,
  normalizeRepositoryReviewInstructions,
  REVIEW_INSTRUCTIONS_FILE,
} from './prompts/repository-review-instructions';
import type { CodeReviewPlatform } from './core/schemas';

export const MAX_REVIEW_GUIDELINE_IMPORTS = 10;
const CONFLICT_RULE =
  'Apply these guideline blocks in order. The repository text wins on conflict.';

export type RepositoryReviewInstructionsLookup = {
  content: string | null;
  used: boolean;
  ref: string | null;
  truncated: boolean;
  imports: ReviewGuidelineImport[];
};

export function unusedRepositoryReviewInstructionsLookup(): RepositoryReviewInstructionsLookup {
  return { content: null, used: false, ref: null, truncated: false, imports: [] };
}

function parseFrontMatter(raw: string): { body: string; entries: unknown[] } {
  const text = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  const match = /^---\n((?:[^\n]*\n)*?)(?:---|\.\.\.)[\t ]*(?:\n|$)/.exec(text);
  if (!match) return { body: cleanReviewInstructions(text), entries: [] };
  const body = cleanReviewInstructions(text.slice(match[0].length));
  try {
    const metadata: unknown = load(match[1], { schema: JSON_SCHEMA });
    if (metadata === undefined || metadata === null) return { body, entries: [] };
    if (typeof metadata !== 'object' || Array.isArray(metadata)) {
      return { body: cleanReviewInstructions(text), entries: [] };
    }
    if (!('extends' in metadata)) return { body, entries: [] };
    return {
      body,
      entries: Array.isArray(metadata.extends) ? metadata.extends : ['[extends must be a list]'],
    };
  } catch {
    return { body, entries: ['[invalid front matter]'] };
  }
}

function parseEntry(entry: unknown): { repository: string; path: string } | null {
  if (typeof entry !== 'string') return null;
  const separator = entry.indexOf(':');
  if (separator < 0) return null;
  const repository = entry.slice(0, separator);
  const path = entry.slice(separator + 1);
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null;
  if (
    !path.endsWith('.md') ||
    !path.isWellFormed() ||
    path.startsWith('/') ||
    /[\\\p{Cc}\p{Zl}\p{Zp}]/u.test(path) ||
    path.includes('://') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some(segment => segment === '..')
  )
    return null;
  return { repository, path };
}

function fetchFailureStatus(error: unknown): 'not_accessible' | 'fetch_error' {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    if ([401, 403, 404].includes(Number(error.status))) return 'not_accessible';
  }
  return 'fetch_error';
}

export async function resolveReviewGuidelines(params: {
  rawContent: string | null;
  platform: CodeReviewPlatform;
  repository: string;
  baseRef: string;
  allowedRepositories: readonly string[];
  githubToken?: string;
}): Promise<RepositoryReviewInstructionsLookup> {
  if (params.rawContent === null) return unusedRepositoryReviewInstructionsLookup();
  const { body, entries } = parseFrontMatter(params.rawContent);
  const allowed = new Set(params.allowedRepositories.map(repository => repository.toLowerCase()));
  const limit = pLimit(3);
  const sourceShas = new Map<string, Promise<string>>();
  const resolved = await Promise.all(
    entries.map(async (entry, index) => {
      const metadata: ReviewGuidelineImport = {
        source: typeof entry === 'string' ? entry : '[invalid entry]',
        sha: null,
        status: 'invalid',
      };
      const result = { metadata, content: '' };
      if (index >= MAX_REVIEW_GUIDELINE_IMPORTS) {
        metadata.status = 'entry_limit';
        return result;
      }
      if (params.platform !== 'github') {
        metadata.status = 'unsupported_platform';
        return result;
      }
      const parsed = parseEntry(entry);
      if (!parsed) return result;
      const repository = parsed.repository.toLowerCase();
      if (repository === params.repository.toLowerCase()) {
        metadata.status = 'self_import';
        return result;
      }
      if (!allowed.has(repository)) {
        metadata.status = 'not_allowed';
        return result;
      }
      const token = params.githubToken;
      if (!token || repository.split('/')[0] !== params.repository.toLowerCase().split('/')[0]) {
        metadata.status = 'not_accessible';
        return result;
      }
      const [owner, repo] = parsed.repository.split('/');
      try {
        let sha = sourceShas.get(repository);
        if (!sha) {
          sha = limit(() => fetchGitHubRepositoryDefaultBranchSha({ token, owner, repo }));
          sourceShas.set(repository, sha);
        }
        metadata.sha = await sha;
        const commitSha = metadata.sha;
        const raw = await limit(() =>
          fetchGitHubRegularFileAtCommit({ token, owner, repo, path: parsed.path, commitSha })
        );
        metadata.status = raw === null ? 'not_found' : 'imported';
        result.content = raw === null ? '' : parseFrontMatter(raw).body;
      } catch (error) {
        metadata.status = fetchFailureStatus(error);
      }
      return result;
    })
  );

  const imports = resolved.map(result => result.metadata);
  const formatBlock = (source: string, content: string) => `## Source: ${source}\n\n${content}`;
  const repositoryText =
    entries.length > 0 && body
      ? `${CONFLICT_RULE}\n\n${formatBlock(`${params.repository}:${REVIEW_INSTRUCTIONS_FILE}`, body)}`
      : body;
  const normalized = normalizeRepositoryReviewInstructions(repositoryText);
  let content = normalized?.content ?? '';
  const truncated = normalized?.truncated ?? false;
  const blocks = resolved.filter(result => result.metadata.status === 'imported' && result.content);
  const combined = () =>
    [
      CONFLICT_RULE,
      ...blocks.map(result => formatBlock(result.metadata.source, result.content)),
      formatBlock(`${params.repository}:${REVIEW_INSTRUCTIONS_FILE}`, body),
    ].join('\n\n');
  while (blocks.length > 0 && combined().length > MAX_REVIEW_INSTRUCTIONS_CHARS) {
    const dropped = blocks.pop();
    if (dropped) dropped.metadata.status = 'dropped_budget';
  }
  if (blocks.length > 0) content = combined();
  return {
    content: content || null,
    used: !!content,
    ref: content ? params.baseRef : null,
    truncated,
    imports,
  };
}
