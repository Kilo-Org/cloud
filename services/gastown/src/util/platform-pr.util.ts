/**
 * Platform PR/MR creation utilities.
 *
 * Creates GitHub Pull Requests or GitLab Merge Requests via their REST APIs.
 * Used by the deterministic merge path when merge_strategy is 'pr'.
 */

import { z } from 'zod';
import { parseGitUrl } from '@kilocode/worker-utils/git-url';

// Re-export the shared git URL helpers so existing imports
// (`import { parseGitUrl } from '../../util/platform-pr.util'`) continue to
// resolve. New call sites should import directly from `@kilocode/worker-utils/git-url`.
export { parseGitUrl };
export type { RepoCoordinates } from '@kilocode/worker-utils/git-url';

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
  mergeable: z.boolean().nullable().optional(),
  mergeable_state: z.string().optional(), // 'clean', 'dirty', 'blocked', 'unknown', 'unstable'
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

/** Fetch an existing open PR for the same head→base pair (used on 422 duplicate). */
async function fetchExistingGitHubPR(params: {
  owner: string;
  repo: string;
  token: string;
  head: string;
  base: string;
}): Promise<{ pr_url: string; pr_number: number } | null> {
  try {
    const qs = new URLSearchParams({
      head: `${params.owner}:${params.head}`,
      base: params.base,
      state: 'open',
    });
    const response = await fetch(
      `https://api.github.com/repos/${params.owner}/${params.repo}/pulls?${qs}`,
      {
        headers: {
          Authorization: `token ${params.token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Gastown-Refinery/1.0',
        },
      }
    );
    if (!response.ok) return null;
    const data: unknown = await response.json();
    const prs = z.array(GitHubPRResponse).parse(data);
    if (prs.length > 0) {
      return { pr_url: prs[0].html_url, pr_number: prs[0].number };
    }
  } catch {
    // Best-effort — caller will throw the original 422 error
  }
  return null;
}

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
    // HTTP 422 with "A pull request already exists" means a PR for this
    // head→base combination already exists. Fetch the existing PR URL
    // instead of failing the entire merge request flow.
    if (response.status === 422) {
      const errorBody = await response.text().catch(() => '');
      if (errorBody.includes('A pull request already exists')) {
        const existingPR = await fetchExistingGitHubPR(params);
        if (existingPR) return existingPR;
      }
      throw new Error(`GitHub PR creation failed (422): ${errorBody.slice(0, 500)}`);
    }
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
    ).catch(err => {
      console.warn(`[platform-pr] Failed to apply labels to PR #${parsed.number}:`, err);
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
  /** Optional: configured GitLab instance URL for host validation. */
  configuredInstanceUrl?: string;
}): Promise<{ mr_url: string; mr_iid: number }> {
  // Validate the instance URL host to prevent SSRF/token exfiltration.
  // Only send PRIVATE-TOKEN to gitlab.com or the configured instance URL.
  const targetHost = hostnameOf(params.instanceUrl);
  if (targetHost && targetHost !== 'gitlab.com') {
    const configuredHost = params.configuredInstanceUrl
      ? hostnameOf(params.configuredInstanceUrl)
      : null;
    if (targetHost !== configuredHost) {
      throw new Error(
        `GitLab MR creation refused: instance URL host "${targetHost}" does not match configured host "${configuredHost ?? '(none)'}"`
      );
    }
  }

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
