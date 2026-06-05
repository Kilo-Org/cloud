import { z } from 'zod';
import { DEFAULT_GITLAB_INSTANCE_URL } from './gitlab-constants.js';

export const GitLabProjectPathSchema = z
  .string()
  .min(3)
  .refine(path => path.split('/').length >= 2)
  .refine(path => path.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part)))
  .refine(path => path.split('/').every(part => part !== '.' && part !== '..' && part !== '-'));

export type GitLabBaseUrl = {
  instanceUrl: string;
  origin: string;
  host: string;
  basePath: string;
};

export type GitLabCloneUrlFailureReason = 'invalid_gitlab_url' | 'unsupported_gitlab_instance';
export type GitLabCloneUrlResult =
  | {
      success: true;
      instanceOrigin: string;
      instanceHost: string;
      projectPath: string;
    }
  | { success: false; reason: GitLabCloneUrlFailureReason };

function rawPath(value: string): string {
  return /^https:\/\/[^/]*(\/[^?#]*)?/i.exec(value)?.[1] ?? '';
}

function hasUnsafePath(value: string, allowRepeatedSlashes = false): boolean {
  const path = rawPath(value);
  return (
    path.includes('\\') ||
    /%2f|%5c/i.test(path) ||
    (!allowRepeatedSlashes && /\/\//.test(path)) ||
    /\/(?:(?:\.|%2e){1,2})(?:\/|$)/i.test(path)
  );
}

function parseSafeHttpsUrl(
  value: string,
  allowQuery = false,
  allowRepeatedSlashes = false
): URL | null {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      !parsed.hostname ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      (!allowQuery && parsed.search !== '') ||
      parsed.hash !== '' ||
      hasUnsafePath(value, allowRepeatedSlashes)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function normalizeProjectPath(value: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (decodedPath.includes('\\')) return null;
  const parts = decodedPath.split('/');
  const terminal = parts.at(-1);
  if (!terminal) return null;
  if (terminal.endsWith('.git')) parts[parts.length - 1] = terminal.slice(0, -4);
  const projectPath = parts.join('/');
  return GitLabProjectPathSchema.safeParse(projectPath).success ? projectPath : null;
}

export function parseGitLabBaseUrl(instanceUrl: string): GitLabBaseUrl | null {
  const parsed = parseSafeHttpsUrl(instanceUrl);
  if (!parsed) return null;
  const basePath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  return {
    instanceUrl: `${parsed.origin}${basePath}`,
    origin: parsed.origin,
    host: parsed.host,
    basePath,
  };
}

export function normalizeGitLabInstanceUrl(instanceUrl: string): string | null {
  return parseGitLabBaseUrl(instanceUrl)?.instanceUrl ?? null;
}

export function isValidGitLabRepositoryUrl(repositoryUrl: string): boolean {
  const parsed = parseSafeHttpsUrl(repositoryUrl, false, true);
  if (!parsed || parsed.pathname === '/' || parsed.pathname.endsWith('/')) return false;
  return normalizeProjectPath(parsed.pathname.slice(1).replace(/^\/+/, '')) !== null;
}

export function parseGitLabCloneUrl(
  gitUrl: string,
  instanceUrl = DEFAULT_GITLAB_INSTANCE_URL
): GitLabCloneUrlResult {
  const repository = parseSafeHttpsUrl(gitUrl, false, true);
  if (!repository || repository.pathname === '/' || repository.pathname.endsWith('/')) {
    return { success: false, reason: 'invalid_gitlab_url' };
  }
  const instance = parseGitLabBaseUrl(instanceUrl);
  if (!instance || repository.origin !== instance.origin) {
    return { success: false, reason: 'unsupported_gitlab_instance' };
  }
  const repositoryPrefix = instance.basePath === '' ? '/' : `${instance.basePath}/`;
  if (!repository.pathname.startsWith(repositoryPrefix)) {
    return { success: false, reason: 'unsupported_gitlab_instance' };
  }
  const projectPath = normalizeProjectPath(
    repository.pathname.slice(repositoryPrefix.length).replace(/^\/+/, '')
  );
  if (!projectPath) return { success: false, reason: 'invalid_gitlab_url' };
  return {
    success: true,
    instanceOrigin: instance.instanceUrl,
    instanceHost: instance.host,
    projectPath,
  };
}
