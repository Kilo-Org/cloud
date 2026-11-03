import * as z from 'zod';
import { skillNameSchema } from './contracts/skills';

const MAX_SKILLS_SH_SOURCE_LENGTH = 500;
const SKILLS_SH_HOSTS = new Set(['skills.sh', 'www.skills.sh']);

const GITHUB_OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const GITHUB_REPO_PATTERN = /^[a-z0-9._-]{1,100}$/;

/** `ownerRepo` is the session-wire value; `sourceUrl` is the persisted canonical URL. */
export type SkillsShSource = {
  owner: string;
  repo: string;
  skill: string;
  ownerRepo: string;
  sourceUrl: string;
};

function buildSkillsShSource(
  ownerInput: string,
  repoInput: string,
  skill: string
): SkillsShSource | null {
  const owner = ownerInput.toLowerCase();
  const repo = repoInput.toLowerCase();

  if (!GITHUB_OWNER_PATTERN.test(owner)) return null;
  if (!GITHUB_REPO_PATTERN.test(repo)) return null;
  if (repo === '.' || repo === '..' || repo.includes('..') || repo.startsWith('-')) return null;
  if (!skillNameSchema.safeParse(skill).success) return null;

  return {
    owner,
    repo,
    skill,
    ownerRepo: `${owner}/${repo}`,
    sourceUrl: `https://skills.sh/${owner}/${repo}/${skill}`,
  };
}

function parseUrlSource(value: string): SkillsShSource | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  if (!SKILLS_SH_HOSTS.has(url.hostname)) return null;
  if (url.port !== '') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  if (!url.pathname.startsWith('/') || url.pathname.startsWith('//')) return null;

  const segments = url.pathname.split('/').filter(segment => segment.length > 0);
  if (segments.length !== 3) return null;

  const [owner, repo, skill] = segments;
  if (segments.some(segment => segment === '.' || segment === '..')) return null;

  return buildSkillsShSource(owner, repo, skill);
}

/**
 * Normalize a skills.sh reference supplied by a user. Accepts
 * `owner/repo@skill`, `owner/repo/skill`, and canonical skills.sh URLs.
 */
export function parseSkillsShSource(input: string): SkillsShSource | null {
  const value = input.trim();
  if (value.length === 0 || value.length > MAX_SKILLS_SH_SOURCE_LENGTH) return null;
  if (value.startsWith('-')) return null;
  if (
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes('%') ||
    value.includes('..')
  ) {
    return null;
  }

  const lower = value.toLowerCase();
  if (lower.startsWith('https://')) return parseUrlSource(value);
  if (lower.includes('://')) return null;

  if (value.includes('@')) {
    const parts = value.split('@');
    if (parts.length !== 2) return null;
    const [repository, skill] = parts;
    const repositoryParts = repository.split('/');
    if (repositoryParts.length !== 2) return null;
    return buildSkillsShSource(repositoryParts[0], repositoryParts[1], skill);
  }

  const segments = value.split('/');
  if (segments.length !== 3) return null;
  return buildSkillsShSource(segments[0], segments[1], segments[2]);
}

/**
 * Validate a canonical source URL stored on a skills.sh reference and return
 * its parts. Rejects anything that is not exactly canonical.
 */
export function parseSkillsShSourceUrl(sourceUrl: string): SkillsShSource | null {
  const parsed = parseSkillsShSource(sourceUrl);
  if (!parsed || parsed.sourceUrl !== sourceUrl) return null;
  return parsed;
}

export const skillsShInputSchema = z.object({
  source: z
    .string()
    .trim()
    .min(1)
    .max(MAX_SKILLS_SH_SOURCE_LENGTH)
    .transform((value, ctx) => {
      const parsed = parseSkillsShSource(value);
      if (!parsed) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Expected a skills.sh reference such as owner/repo@skill or https://skills.sh/owner/repo/skill',
        });
        return z.NEVER;
      }
      return parsed;
    }),
  enabled: z.boolean().optional(),
});

export type SkillsShInput = z.infer<typeof skillsShInputSchema>;
