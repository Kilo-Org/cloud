/**
 * Platform PR/MR creation utilities.
 *
 * Creates GitHub Pull Requests or GitLab Merge Requests via their REST APIs.
 * Used by the deterministic merge path when merge_strategy is 'pr'.
 */

import { z } from 'zod';

// -- Git URL parsing --

export type RepoCoordinates = {
  platform: 'github' | 'gitlab';
  owner: string;
  repo: string;
};

/**
 * Parse the hostname from a URL string, returning null on failure.
 */
function hostnameOf(urlStr: string): string | null {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return null;
  }
}

/**
 * Check whether a host is a known GitLab host (gitlab.com or matches
 * the configured instance URL by exact hostname comparison).
 */
function isGitLabHost(host: string, gitlabInstanceUrl?: string): boolean {
  if (host === 'gitlab.com') return true;
  if (gitlabInstanceUrl && hostnameOf(gitlabInstanceUrl) === host) return true;
  return false;
}

/**
 * Extract owner/repo from a git URL.
 * Supports https and git@ formats:
 *   https://github.com/org/repo.git
 *   git@github.com:org/repo.git
 *   https://gitlab.example.com/org/repo.git
 *   https://gitlab.com/group/subgroup/project.git  (GitLab subgroups)
 */
export function parseGitUrl(gitUrl: string, gitlabInstanceUrl?: string): RepoCoordinates | null {
  // Normalize: strip trailing .git and embedded credentials (e.g. https://token@github.com/...)
  const url = gitUrl.replace(/\.git$/, '').replace(/\/\/[^@]+@/, '//');

  // HTTPS format: https://host/path...
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+)/);
  if (httpsMatch) {
    const host = httpsMatch[1];
    const fullPath = httpsMatch[2];

    if (host === 'github.com') {
      // GitHub: always owner/repo (two segments)
      const parts = fullPath.split('/');
      if (parts.length >= 2) {
        return { platform: 'github', owner: parts[0], repo: parts[1] };
      }
      return null;
    }

    if (isGitLabHost(host, gitlabInstanceUrl)) {
      // GitLab: supports subgroups — owner is everything except the last
      // segment, repo is the last segment.
      const lastSlash = fullPath.lastIndexOf('/');
      if (lastSlash > 0) {
        return {
          platform: 'gitlab',
          owner: fullPath.slice(0, lastSlash),
          repo: fullPath.slice(lastSlash + 1),
        };
      }
      return null;
    }

    return null;
  }

  // SSH format: git@host:path
  const sshMatch = url.match(/^git@([^:]+):(.+)/);
  if (sshMatch) {
    const host = sshMatch[1];
    const fullPath = sshMatch[2];

    if (host === 'github.com') {
      const parts = fullPath.split('/');
      if (parts.length >= 2) {
        return { platform: 'github', owner: parts[0], repo: parts[1] };
      }
      return null;
    }

    if (isGitLabHost(host, gitlabInstanceUrl)) {
      const lastSlash = fullPath.lastIndexOf('/');
      if (lastSlash > 0) {
        return {
          platform: 'gitlab',
          owner: fullPath.slice(0, lastSlash),
          repo: fullPath.slice(lastSlash + 1),
        };
      }
      return null;
    }

    return null;
  }

  return null;
}

// -- PR body template --

export type QualityGateResult = {
  name: string;
  passed: boolean;
  duration_seconds?: number;
};

export function buildPRBody(params: {
  sourceBeadId: string;
  beadTitle: string;
  polecatName: string;
  model: string;
  convoyId?: string;
  dashboardBaseUrl?: string;
  gateResults: QualityGateResult[];
  diffStat?: string;
}): string {
  const dashboardUrl = params.dashboardBaseUrl ?? '';
  const beadLink = dashboardUrl
    ? `[${params.sourceBeadId.slice(0, 8)}](${dashboardUrl})`
    : params.sourceBeadId.slice(0, 8);

  const convoyLine = params.convoyId ? `**Convoy**: ${params.convoyId.slice(0, 8)}\n` : '';

  const gateRows =
    params.gateResults.length > 0
      ? params.gateResults
          .map(g => {
            const status = g.passed ? 'Passed' : 'Failed';
            const duration = g.duration_seconds !== undefined ? `${g.duration_seconds}s` : '-';
            return `| ${g.name} | ${status} | ${duration} |`;
          })
          .join('\n')
      : '| (no gates configured) | - | - |';

  const diffSection = params.diffStat
    ? `\n### Changes\n\n\`\`\`\n${params.diffStat}\n\`\`\`\n`
    : '';

  return `## Gastown Agent Work

**Source**: ${beadLink} — ${params.beadTitle}
**Agent**: ${params.polecatName} (${params.model})
${convoyLine}
### Quality Gates

| Gate | Status | Duration |
|------|--------|----------|
${gateRows}
${diffSection}
---

*Created by Gastown Refinery.*`;
}

// -- PR/MR status polling schemas --

/** Schema for GitHub PR status responses (used by checkPRStatus). */
export const GitHubPRStatusSchema = z.object({
  state: z.string(),
  merged: z.boolean().optional(),
});

/** Schema for GitLab MR status responses (used by checkPRStatus). */
export const GitLabMRStatusSchema = z.object({
  state: z.string(),
});

// -- GitHub PR creation --

const GitHubPRResponse = z.object({
  html_url: z.string(),
  number: z.number(),
  state: z.string(),
});

export async function createGitHubPR(params: {
  owner: string;
  repo: string;
  token: string;
  title: string;
  body: string;
  head: string;
  base: string;
  labels?: string[];
}): Promise<{ pr_url: string; pr_number: number }> {
  const response = await fetch(
    `https://api.github.com/repos/${params.owner}/${params.repo}/pulls`,
    {
      method: 'POST',
      headers: {
        Authorization: `token ${params.token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Gastown-Refinery/1.0',
      },
      body: JSON.stringify({
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base,
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '(unreadable)');
    throw new Error(`GitHub PR creation failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const data: unknown = await response.json();
  const parsed = GitHubPRResponse.parse(data);

  // Add labels if requested (separate API call, best-effort)
  if (params.labels && params.labels.length > 0) {
    await fetch(
      `https://api.github.com/repos/${params.owner}/${params.repo}/issues/${parsed.number}/labels`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${params.token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'Gastown-Refinery/1.0',
        },
        body: JSON.stringify({ labels: params.labels }),
      }
    ).catch(() => {
      // Best-effort label application
    });
  }

  return { pr_url: parsed.html_url, pr_number: parsed.number };
}

// -- GitLab MR creation --

const GitLabMRResponse = z.object({
  web_url: z.string(),
  iid: z.number(),
  state: z.string(),
});

export async function createGitLabMR(params: {
  instanceUrl: string;
  projectPath: string;
  token: string;
  title: string;
  description: string;
  source_branch: string;
  target_branch: string;
  labels?: string[];
}): Promise<{ mr_url: string; mr_iid: number }> {
  const encodedPath = encodeURIComponent(params.projectPath);
  const baseUrl = params.instanceUrl.replace(/\/$/, '');

  const response = await fetch(`${baseUrl}/api/v4/projects/${encodedPath}/merge_requests`, {
    method: 'POST',
    headers: {
      'PRIVATE-TOKEN': params.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: params.title,
      description: params.description,
      source_branch: params.source_branch,
      target_branch: params.target_branch,
      labels: params.labels?.join(','),
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '(unreadable)');
    throw new Error(`GitLab MR creation failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const data: unknown = await response.json();
  const parsed = GitLabMRResponse.parse(data);
  return { mr_url: parsed.web_url, mr_iid: parsed.iid };
}
