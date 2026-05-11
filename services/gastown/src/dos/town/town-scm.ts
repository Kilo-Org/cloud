import { z } from 'zod';
import type { TownConfig } from '../../types';
import type { PRFeedbackCheckResult, ReviewDecision, MergeStateStatus } from './actions';
import {
  GitHubPRStatusSchema,
  GitLabMRStatusSchema,
  parseGitUrl,
} from '../../util/platform-pr.util';
import { writeEvent } from '../../util/analytics.util';

const TOWN_LOG = '[town-scm]';

export type SCMContext = {
  env: Env;
  townId: string;
  getTownConfig: () => Promise<TownConfig>;
  /**
   * Rig-level platform integration ID. When provided, it is tried as a
   * fallback after town-level git_auth so that rigs authenticated solely
   * through a rig-scoped GitHub App installation can still resolve a token.
   */
  platformIntegrationId?: string;
};

export type GitHubTokenResolution =
  | { ok: true; token: string; source: string }
  | { ok: false; tried: string[] };

/**
 * Resolve a GitHub API token from the town config.
 *
 * Priority chain (most to least preferred):
 *   1. `github_cli_pat` — user-supplied long-lived PAT, never expires.
 *   2. Platform integration (GitHub App installation) — minted fresh by
 *      git-token-service with KV-backed caching that auto-invalidates
 *      before each token's 1h TTL elapses. This is the authoritative
 *      live source whenever an integration is configured.
 *   3. `git_auth.github_token` — stored installation token from a past
 *      `refreshGitCredentials()` write. Kept as a fallback for towns that
 *      never had an integration wired up. NOT preferred over the integration
 *      because the stored value is typically stale (1h TTL, never updated
 *      by anything in the request path).
 *
 * Historically this preferred the stored token over the integration,
 * which made every consumer (PR poller, /refresh-git-token, agent
 * dispatch's `GIT_TOKEN`) hand out an expired token whenever the rig
 * had been registered more than ~1 hour ago. See ce15a6fe7 for the fix.
 *
 * Returns a `GitHubTokenResolution`: `ok: true` with the token + source on
 * success, or `ok: false` with the `tried` chain on failure. Used by
 * `checkPRStatus`'s `no_token` failure path to surface a specific message.
 */
export async function resolveGitHubToken(ctx: SCMContext): Promise<GitHubTokenResolution> {
  const tried: string[] = [];
  const townConfig = await ctx.getTownConfig();

  // 1. github_cli_pat — long-lived user PAT
  if (townConfig.github_cli_pat) {
    return { ok: true, token: townConfig.github_cli_pat, source: 'town.github_cli_pat' };
  }
  tried.push('town.github_cli_pat');

  // 2. Platform integration — fresh App installation token
  const integrationId = townConfig.git_auth?.platform_integration_id ?? ctx.platformIntegrationId;
  const sourceLabel = townConfig.git_auth?.platform_integration_id
    ? 'town platform integration'
    : 'rig platform integration';
  if (integrationId && ctx.env.GIT_TOKEN_SERVICE) {
    tried.push(sourceLabel);
    try {
      const fresh = await ctx.env.GIT_TOKEN_SERVICE.getToken(integrationId);
      if (typeof fresh === 'string' && fresh.length > 0) {
        return { ok: true, token: fresh, source: sourceLabel };
      }
      console.warn(
        `${TOWN_LOG} resolveGitHubToken: platform integration ${integrationId} returned empty token; falling back to stored github_token`
      );
    } catch (err) {
      console.warn(
        `${TOWN_LOG} resolveGitHubToken: platform integration token lookup failed for ${integrationId}; falling back to stored github_token`,
        err
      );
    }
  } else if (!integrationId) {
    tried.push('platform integration (none configured)');
  } else {
    tried.push(`${sourceLabel} (GIT_TOKEN_SERVICE not bound)`);
  }

  // 3. Stored git_auth.github_token — last-resort fallback
  if (townConfig.git_auth?.github_token) {
    return {
      ok: true,
      token: townConfig.git_auth.github_token,
      source: 'town.git_auth.github_token',
    };
  }
  tried.push('town.git_auth.github_token');

  return { ok: false, tried };
}

export async function resolveGitHubTokenString(ctx: SCMContext): Promise<string | null> {
  const r = await resolveGitHubToken(ctx);
  return r.ok ? r.token : null;
}

export type PRStatusResult = {
  status: 'open' | 'merged' | 'closed';
  mergeable_state?: string;
};

export type PRStatusError =
  | { kind: 'no_token'; provider: 'github' | 'gitlab'; resolutionChain: string[] }
  | { kind: 'unrecognized_url'; url: string }
  | {
      kind: 'http_error';
      provider: 'github' | 'gitlab';
      status: number;
      statusText: string;
      transient: boolean;
    }
  | {
      kind: 'invalid_response';
      provider: 'github' | 'gitlab';
      reason: 'json_parse' | 'schema_mismatch';
      sampleKeys?: string[];
    }
  | { kind: 'host_mismatch'; provider: 'gitlab'; expected: string; got: string };

export type PRStatusOutcome =
  | { ok: true; result: PRStatusResult }
  | { ok: false; error: PRStatusError };

function isTransientHttpStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * Check the status of a PR/MR via its URL.
 * Returns a PRStatusOutcome discriminated union — { ok: true, result } on success,
 * or { ok: false, error } with a structured PRStatusError describing why.
 */
export async function checkPRStatus(ctx: SCMContext, prUrl: string): Promise<PRStatusOutcome> {
  const townConfig = await ctx.getTownConfig();

  // GitHub PR URL format: https://github.com/{owner}/{repo}/pull/{number}
  const ghMatch = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (ghMatch) {
    const [, owner, repo, numberStr] = ghMatch;
    const resolution = await resolveGitHubToken(ctx);
    if (!resolution.ok) {
      console.warn(`${TOWN_LOG} checkPRStatus: no GitHub token available, cannot poll ${prUrl}`);
      return {
        ok: false,
        error: { kind: 'no_token', provider: 'github', resolutionChain: resolution.tried },
      };
    }

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${numberStr}`,
      {
        headers: {
          Authorization: `token ${resolution.token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Gastown-Refinery/1.0',
        },
      }
    );
    if (!response.ok) {
      console.warn(
        `${TOWN_LOG} checkPRStatus: GitHub API returned ${response.status} for ${prUrl}`
      );
      return {
        ok: false,
        error: {
          kind: 'http_error',
          provider: 'github',
          status: response.status,
          statusText: response.statusText,
          transient: isTransientHttpStatus(response.status),
        },
      };
    }

    const json = await response.json().catch(() => null);
    if (!json) {
      return {
        ok: false,
        error: { kind: 'invalid_response', provider: 'github', reason: 'json_parse' },
      };
    }
    const data = GitHubPRStatusSchema.safeParse(json);
    if (!data.success) {
      return {
        ok: false,
        error: {
          kind: 'invalid_response',
          provider: 'github',
          reason: 'schema_mismatch',
          sampleKeys: Object.keys(json).slice(0, 8),
        },
      };
    }

    if (data.data.merged) return { ok: true, result: { status: 'merged' } };
    if (data.data.state === 'closed') return { ok: true, result: { status: 'closed' } };
    return { ok: true, result: { status: 'open', mergeable_state: data.data.mergeable_state } };
  }

  // GitLab MR URL format: https://{host}/{path}/-/merge_requests/{iid}
  const glMatch = prUrl.match(/^(https:\/\/[^/]+)\/(.+)\/-\/merge_requests\/(\d+)/);
  if (glMatch) {
    const [, instanceUrl, projectPath, iidStr] = glMatch;
    const token = townConfig.git_auth?.gitlab_token;
    if (!token) {
      console.warn(`${TOWN_LOG} checkPRStatus: no gitlab_token configured, cannot poll ${prUrl}`);
      return {
        ok: false,
        error: {
          kind: 'no_token',
          provider: 'gitlab',
          resolutionChain: ['town.git_auth.gitlab_token'],
        },
      };
    }

    // Validate the host against known GitLab hosts to prevent SSRF/token leak.
    const prHost = new URL(instanceUrl).hostname;
    const configuredHost = townConfig.git_auth?.gitlab_instance_url
      ? new URL(townConfig.git_auth.gitlab_instance_url).hostname
      : null;
    if (prHost !== 'gitlab.com' && prHost !== configuredHost) {
      console.warn(
        `${TOWN_LOG} checkPRStatus: refusing to send gitlab_token to unknown host: ${prHost}`
      );
      return {
        ok: false,
        error: {
          kind: 'host_mismatch',
          provider: 'gitlab',
          expected: configuredHost ?? 'gitlab.com',
          got: prHost,
        },
      };
    }

    const encodedPath = encodeURIComponent(projectPath);
    const response = await fetch(
      `${instanceUrl}/api/v4/projects/${encodedPath}/merge_requests/${iidStr}`,
      {
        headers: { 'PRIVATE-TOKEN': token },
      }
    );
    if (!response.ok) {
      console.warn(
        `${TOWN_LOG} checkPRStatus: GitLab API returned ${response.status} for ${prUrl}`
      );
      return {
        ok: false,
        error: {
          kind: 'http_error',
          provider: 'gitlab',
          status: response.status,
          statusText: response.statusText,
          transient: isTransientHttpStatus(response.status),
        },
      };
    }

    const glJson = await response.json().catch(() => null);
    if (!glJson) {
      return {
        ok: false,
        error: { kind: 'invalid_response', provider: 'gitlab', reason: 'json_parse' },
      };
    }
    const data = GitLabMRStatusSchema.safeParse(glJson);
    if (!data.success) {
      return {
        ok: false,
        error: {
          kind: 'invalid_response',
          provider: 'gitlab',
          reason: 'schema_mismatch',
          sampleKeys: Object.keys(glJson).slice(0, 8),
        },
      };
    }

    if (data.data.state === 'merged') return { ok: true, result: { status: 'merged' } };
    if (data.data.state === 'closed') return { ok: true, result: { status: 'closed' } };
    return { ok: true, result: { status: 'open' } };
  }

  console.warn(`${TOWN_LOG} checkPRStatus: unrecognized PR URL format: ${prUrl}`);
  return { ok: false, error: { kind: 'unrecognized_url', url: prUrl } };
}

/**
 * Use Workers AI to determine if unresolved PR review threads contain
 * blocking feedback that should prevent auto-merge.
 */
export async function areThreadsBlocking(
  ctx: SCMContext,
  threads: Array<{
    isResolved: boolean;
    comments?: { nodes: Array<{ body: string; author: { login: string } | null }> };
  }>
): Promise<boolean> {
  try {
    const threadSummaries = threads.map((t, i) => {
      const comments = t.comments?.nodes ?? [];
      const commentText = comments
        .map(c => `  [${c.author?.login ?? 'unknown'}]: ${c.body}`)
        .join('\n');
      return `Thread ${i + 1}:\n${commentText}`;
    });

    const prompt = `You are evaluating unresolved PR review comment threads to decide if a pull request is safe to auto-merge.

Here are the unresolved review threads:

${threadSummaries.join('\n\n')}

For each thread, classify it as BLOCKING or NON-BLOCKING:
- BLOCKING: Requests a code change, identifies a bug, security vulnerability, correctness problem, or raises a warning about the code that should be addressed before merge.
- NON-BLOCKING: Approvals, praise, "LGTM", status summaries (e.g. "Code review passed", "No issues found"), acknowledgements, or comments that express approval of the code without requesting changes.

Important: A comment is only NON-BLOCKING if it expresses approval or is purely a status report. If a comment raises any concern, warning, suggestion, or question about the code — even if phrased softly — it is BLOCKING.

Respond with ONLY a JSON object (no markdown, no explanation): { "blocking": true/false, "reason": "brief one-sentence explanation" }`;

    const startTime = Date.now();
    const response: unknown = await ctx.env.AI.run('@cf/google/gemma-4-26b-a4b-it', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 256,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    });
    const durationMs = Date.now() - startTime;

    // Track the AI call via analytics event
    writeEvent(ctx.env, {
      event: 'api.external_request',
      townId: ctx.townId,
      label: 'workers_ai_review_threads',
      durationMs,
    });

    const openAiResult = z
      .object({
        choices: z.array(z.object({ message: z.object({ content: z.string() }) })),
      })
      .safeParse(response);
    const legacyResult = z.object({ response: z.string() }).safeParse(response);

    const text = openAiResult.success
      ? openAiResult.data.choices[0]?.message.content
      : legacyResult.success
        ? legacyResult.data.response
        : null;
    if (!text) {
      console.warn(
        `${TOWN_LOG} areThreadsBlocking: could not extract text from AI response, defaulting to blocking. Raw: ${JSON.stringify(response)?.slice(0, 500)}`
      );
      return true;
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(
        `${TOWN_LOG} areThreadsBlocking: no JSON in AI response, defaulting to blocking: ${text}`
      );
      return true;
    }

    const parsed = z
      .object({ blocking: z.boolean(), reason: z.string().optional() })
      .safeParse(JSON.parse(jsonMatch[0]));

    if (!parsed.success) {
      console.warn(
        `${TOWN_LOG} areThreadsBlocking: failed to parse AI response, defaulting to blocking: ${text}`
      );
      return true;
    }

    console.log(
      `${TOWN_LOG} areThreadsBlocking: blocking=${parsed.data.blocking} reason=${parsed.data.reason ?? 'none'} threads=${threads.length}`
    );
    return parsed.data.blocking;
  } catch (err) {
    console.warn(`${TOWN_LOG} areThreadsBlocking: AI call failed, defaulting to blocking`, err);
    return true;
  }
}

/**
 * Check a PR for unresolved review comments and failing CI checks.
 * Used by the auto-resolve PR feedback feature.
 */
export async function checkPRFeedback(
  ctx: SCMContext,
  prUrl: string
): Promise<PRFeedbackCheckResult | null> {
  const ghMatch = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!ghMatch) {
    return null;
  }

  const [, owner, repo, numberStr] = ghMatch;
  const resolution = await resolveGitHubToken(ctx);
  if (!resolution.ok) return null;

  const headers = {
    Authorization: `token ${resolution.token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Gastown-Refinery/1.0',
  };

  let hasUnresolvedComments = false;
  let reviewDecision: ReviewDecision = null;
  let mergeStateStatus: MergeStateStatus = null;
  let isDraft = false;
  try {
    const graphqlRes = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewDecision
              mergeStateStatus
              isDraft
              reviewThreads(first: 100) {
                pageInfo { hasNextPage }
                nodes {
                  isResolved
                  comments(first: 5) {
                    nodes {
                      body
                      author { login }
                    }
                  }
                }
              }
            }
          }
        }`,
        variables: { owner, repo, number: parseInt(numberStr, 10) },
      }),
    });
    if (graphqlRes.ok) {
      const gqlRaw: unknown = await graphqlRes.json();
      const gql = z
        .object({
          data: z
            .object({
              repository: z
                .object({
                  pullRequest: z
                    .object({
                      reviewDecision: z
                        .enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'])
                        .nullable()
                        .optional(),
                      mergeStateStatus: z
                        .enum(['CLEAN', 'BLOCKED', 'BEHIND', 'DIRTY', 'HAS_HOOKS', 'UNKNOWN'])
                        .nullable()
                        .optional(),
                      isDraft: z.boolean().optional(),
                      reviewThreads: z
                        .object({
                          pageInfo: z.object({ hasNextPage: z.boolean() }).optional(),
                          nodes: z.array(
                            z.object({
                              isResolved: z.boolean(),
                              comments: z
                                .object({
                                  nodes: z.array(
                                    z.object({
                                      body: z.string(),
                                      author: z.object({ login: z.string() }).nullable(),
                                    })
                                  ),
                                })
                                .optional(),
                            })
                          ),
                        })
                        .optional(),
                    })
                    .optional(),
                })
                .optional(),
            })
            .optional(),
        })
        .safeParse(gqlRaw);
      const pullRequest = gql.success ? gql.data.data?.repository?.pullRequest : undefined;
      reviewDecision = (pullRequest?.reviewDecision ?? null) as ReviewDecision;
      mergeStateStatus = (pullRequest?.mergeStateStatus ?? null) as MergeStateStatus;
      isDraft = pullRequest?.isDraft ?? false;
      const reviewThreads = pullRequest?.reviewThreads;
      const threads = reviewThreads?.nodes ?? [];
      const hasMorePages = reviewThreads?.pageInfo?.hasNextPage === true;

      if (hasMorePages) {
        hasUnresolvedComments = true;
      } else {
        const unresolvedThreads = threads.filter(t => !t.isResolved);
        if (unresolvedThreads.length > 0) {
          hasUnresolvedComments = await areThreadsBlocking(ctx, unresolvedThreads);
        }
      }
    }
  } catch (err) {
    console.warn(`${TOWN_LOG} checkPRFeedback: GraphQL failed for ${prUrl}`, err);
  }

  let hasFailingChecks = false;
  let allChecksPass = false;
  let hasUncheckedRuns = false;
  try {
    const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${numberStr}`, {
      headers,
    });
    if (prRes.ok) {
      const prRaw: unknown = await prRes.json();
      const prData = z.object({ head: z.object({ sha: z.string() }).optional() }).safeParse(prRaw);
      const sha = prData.success ? prData.data.head?.sha : undefined;
      if (sha) {
        const checksRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
          { headers }
        );
        if (checksRes.ok) {
          const checksRaw: unknown = await checksRes.json();
          const checksData = z
            .object({
              total_count: z.number().optional(),
              check_runs: z
                .array(
                  z.object({
                    status: z.string(),
                    conclusion: z.string().nullable(),
                  })
                )
                .optional(),
            })
            .safeParse(checksRaw);
          const runs = checksData.success ? (checksData.data.check_runs ?? []) : [];
          const totalCount = checksData.success
            ? (checksData.data.total_count ?? runs.length)
            : runs.length;
          const hasMorePages = totalCount > runs.length;
          hasUncheckedRuns = hasMorePages;

          hasFailingChecks = runs.some(
            r =>
              r.status === 'completed' && r.conclusion !== 'success' && r.conclusion !== 'skipped'
          );
          allChecksPass =
            runs.length === 0 ||
            (!hasMorePages &&
              runs.every(
                r =>
                  r.status === 'completed' &&
                  (r.conclusion === 'success' || r.conclusion === 'skipped')
              ));
        }

        if (allChecksPass) {
          const statusRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/status`,
            { headers }
          );
          if (statusRes.ok) {
            const statusRaw: unknown = await statusRes.json();
            const statusData = z
              .object({
                state: z.string(),
                total_count: z.number(),
              })
              .safeParse(statusRaw);
            if (statusData.success && statusData.data.total_count > 0) {
              const combinedState = statusData.data.state;
              if (combinedState !== 'success') {
                allChecksPass = false;
                if (combinedState === 'failure' || combinedState === 'error') {
                  hasFailingChecks = true;
                }
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn(`${TOWN_LOG} checkPRFeedback: check-runs failed for ${prUrl}`, err);
  }

  const awaitingApproval = reviewDecision === 'REVIEW_REQUIRED' || mergeStateStatus === 'BLOCKED';
  const changesRequested = reviewDecision === 'CHANGES_REQUESTED';

  return {
    hasUnresolvedComments,
    hasFailingChecks,
    allChecksPass,
    hasUncheckedRuns,
    awaitingApproval,
    changesRequested,
    reviewDecision,
    mergeStateStatus,
    isDraft,
  };
}

/**
 * Merge a PR via GitHub API. Used by the auto-merge feature.
 * Returns true if the merge succeeded.
 */
export async function mergePR(ctx: SCMContext, prUrl: string): Promise<boolean> {
  const ghMatch = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!ghMatch) {
    console.warn(`${TOWN_LOG} mergePR: unsupported PR URL format: ${prUrl}`);
    return false;
  }

  const [, owner, repo, numberStr] = ghMatch;
  const resolution = await resolveGitHubToken(ctx);
  if (!resolution.ok) {
    console.warn(`${TOWN_LOG} mergePR: no GitHub token available`);
    return false;
  }

  const mergeUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${numberStr}/merge`;
  const mergeHeaders = {
    Authorization: `token ${resolution.token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'Gastown-Refinery/1.0',
  };

  const methods = ['squash', 'merge', 'rebase'] as const;
  for (const method of methods) {
    const response = await fetch(mergeUrl, {
      method: 'PUT',
      headers: mergeHeaders,
      body: JSON.stringify({ merge_method: method }),
    });

    if (response.ok) return true;

    const text = await response.text().catch(() => '(unreadable)');
    if (response.status === 405 && text.includes('not allowed')) {
      continue;
    }

    console.warn(
      `${TOWN_LOG} mergePR: GitHub API returned ${response.status} for ${prUrl} (method=${method}): ${text.slice(0, 500)}`
    );
    return false;
  }

  console.warn(`${TOWN_LOG} mergePR: all merge methods rejected for ${prUrl}`);
  return false;
}

/**
 * Create the convoy feature branch on the remote GitHub repository so that it
 * exists before any polecat tries to open a PR targeting it.
 *
 * The branch is created at the current tip of the rig's default branch.
 * If the branch already exists (HTTP 422) the call is treated as a no-op.
 * If no GitHub token is available, the error is logged and the function
 * returns without throwing — convoy creation continues, but branch creation
 * is skipped.
 */
export async function createConvoyBranch(
  ctx: SCMContext,
  opts: {
    gitUrl: string;
    defaultBranch: string;
    featureBranch: string;
  }
): Promise<void> {
  const resolution = await resolveGitHubToken(ctx);
  if (!resolution.ok) {
    console.warn(
      `${TOWN_LOG} createConvoyBranch: no GitHub token available — skipping branch creation for ${opts.featureBranch}`
    );
    return;
  }

  const coords = parseGitUrl(opts.gitUrl);
  if (!coords || coords.platform !== 'github') {
    return;
  }

  const { owner, repo } = coords;
  const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = {
    Authorization: `token ${resolution.token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Gastown/1.0',
    'Content-Type': 'application/json',
  };

  // 1. Resolve the SHA at the tip of the default branch.
  const refRes = await fetch(`${apiBase}/git/ref/heads/${opts.defaultBranch}`, { headers });
  if (!refRes.ok) {
    const text = await refRes.text().catch(() => '(unreadable)');
    console.warn(
      `${TOWN_LOG} createConvoyBranch: failed to resolve default branch SHA (${refRes.status}): ${text.slice(0, 200)}`
    );
    return;
  }

  const refJson = await refRes.json().catch(() => null);
  const shaResult = z.object({ object: z.object({ sha: z.string() }) }).safeParse(refJson);
  if (!shaResult.success) {
    console.warn(`${TOWN_LOG} createConvoyBranch: unexpected ref response shape`);
    return;
  }
  const sha = shaResult.data.object.sha;

  // 2. Create the convoy feature branch pointing at that SHA.
  const createRes = await fetch(`${apiBase}/git/refs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: `refs/heads/${opts.featureBranch}`, sha }),
  });

  if (createRes.ok) {
    console.log(
      `${TOWN_LOG} createConvoyBranch: created ${opts.featureBranch} at ${sha.slice(0, 8)} in ${owner}/${repo}`
    );
    return;
  }

  if (createRes.status === 422) {
    // Branch already exists — idempotent, treat as success.
    console.log(
      `${TOWN_LOG} createConvoyBranch: branch ${opts.featureBranch} already exists in ${owner}/${repo} — skipping`
    );
    return;
  }

  const errText = await createRes.text().catch(() => '(unreadable)');
  console.warn(
    `${TOWN_LOG} createConvoyBranch: GitHub API returned ${createRes.status} when creating ${opts.featureBranch}: ${errText.slice(0, 200)}`
  );
}
