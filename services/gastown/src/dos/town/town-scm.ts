import { z } from 'zod';
import type { TownConfig } from '../../types';
import type { PRFeedbackCheckResult } from './actions';
import { GitHubPRStatusSchema, GitLabMRStatusSchema } from '../../util/platform-pr.util';
import { writeEvent } from '../../util/analytics.util';

const TOWN_LOG = '[town-scm]';

export type SCMContext = {
  env: Env;
  townId: string;
  getTownConfig: () => Promise<TownConfig>;
};

/**
 * Resolve a GitHub API token from the town config.
 * Fallback chain: github_token → github_cli_pat → platform integration (GitHub App).
 */
export async function resolveGitHubToken(ctx: SCMContext): Promise<string | null> {
  const townConfig = await ctx.getTownConfig();
  let token = townConfig.git_auth?.github_token ?? townConfig.github_cli_pat;
  if (!token) {
    const integrationId = townConfig.git_auth?.platform_integration_id;
    if (integrationId && ctx.env.GIT_TOKEN_SERVICE) {
      try {
        token = await ctx.env.GIT_TOKEN_SERVICE.getToken(integrationId);
      } catch (err) {
        console.warn(
          `${TOWN_LOG} resolveGitHubToken: platform integration token lookup failed for ${integrationId}`,
          err
        );
      }
    }
  }
  return token ?? null;
}

/**
 * Check the status of a PR/MR via its URL.
 * Returns 'open', 'merged', or 'closed' (null if cannot determine).
 */
export async function checkPRStatus(
  ctx: SCMContext,
  prUrl: string
): Promise<'open' | 'merged' | 'closed' | null> {
  const townConfig = await ctx.getTownConfig();

  // GitHub PR URL format: https://github.com/{owner}/{repo}/pull/{number}
  const ghMatch = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (ghMatch) {
    const [, owner, repo, numberStr] = ghMatch;
    const token = await resolveGitHubToken(ctx);
    if (!token) {
      console.warn(`${TOWN_LOG} checkPRStatus: no GitHub token available, cannot poll ${prUrl}`);
      return null;
    }

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${numberStr}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Gastown-Refinery/1.0',
        },
      }
    );
    if (!response.ok) {
      console.warn(
        `${TOWN_LOG} checkPRStatus: GitHub API returned ${response.status} for ${prUrl}`
      );
      return null;
    }

    const json = await response.json().catch(() => null);
    if (!json) return null;
    const data = GitHubPRStatusSchema.safeParse(json);
    if (!data.success) return null;

    if (data.data.merged) return 'merged';
    if (data.data.state === 'closed') return 'closed';
    return 'open';
  }

  // GitLab MR URL format: https://{host}/{path}/-/merge_requests/{iid}
  const glMatch = prUrl.match(/^(https:\/\/[^/]+)\/(.+)\/-\/merge_requests\/(\d+)/);
  if (glMatch) {
    const [, instanceUrl, projectPath, iidStr] = glMatch;
    const token = townConfig.git_auth?.gitlab_token;
    if (!token) {
      console.warn(`${TOWN_LOG} checkPRStatus: no gitlab_token configured, cannot poll ${prUrl}`);
      return null;
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
      return null;
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
      return null;
    }

    const glJson = await response.json().catch(() => null);
    if (!glJson) return null;
    const data = GitLabMRStatusSchema.safeParse(glJson);
    if (!data.success) return null;

    if (data.data.state === 'merged') return 'merged';
    if (data.data.state === 'closed') return 'closed';
    return 'open';
  }

  console.warn(`${TOWN_LOG} checkPRStatus: unrecognized PR URL format: ${prUrl}`);
  return null;
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
    const response: unknown = await ctx.env.AI.run(
      // @ts-expect-error Model may not be in the AiModels type map yet — cast to access it.
      '@cf/google/gemma-4-26b-a4b-it',
      {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 256,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
      }
    );
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
  const token = await resolveGitHubToken(ctx);
  if (!token) return null;

  const headers = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Gastown-Refinery/1.0',
  };

  let hasUnresolvedComments = false;
  try {
    const graphqlRes = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
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
      const reviewThreads = gql.success
        ? gql.data.data?.repository?.pullRequest?.reviewThreads
        : undefined;
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

  return { hasUnresolvedComments, hasFailingChecks, allChecksPass, hasUncheckedRuns };
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
  const token = await resolveGitHubToken(ctx);
  if (!token) {
    console.warn(`${TOWN_LOG} mergePR: no GitHub token available`);
    return false;
  }

  const mergeUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${numberStr}/merge`;
  const mergeHeaders = {
    Authorization: `token ${token}`,
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
