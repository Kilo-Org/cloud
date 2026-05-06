import { BOT_CONTEXT_MESSAGE_LIMIT } from '@/lib/bot/constants';
import { createGitHubLinkToken } from '@/lib/bot/github-link-token';
import {
  formatTriggerMessage,
  formatUserMessage,
  sanitizeForDelimiters,
  truncate,
} from '@/lib/bot/platforms/shared';
import type { BotPlatform } from '@/lib/bot/platforms/types';
import { APP_URL } from '@/lib/constants';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { GitHubAdapter, GitHubRawMessage } from '@chat-adapter/github';
import { Octokit } from '@octokit/rest';
import type { PlatformIntegration } from '@kilocode/db';
import type { Message, Thread } from 'chat';

type GitHubInstallationLookup = Pick<GitHubAdapter, 'getInstallationId'>;

const GITHUB_LINK_PATH = '/github/link';
const MAX_GITHUB_BODY_LENGTH = 4000;
const MAX_GITHUB_COMMENT_LENGTH = 1200;

type GitHubRepositoryReference = {
  id: number | null;
  fullName: string | null;
};

function parseGitHubRepositoryFullName(id: string | undefined): string | null {
  if (!id) return null;

  const match = id.match(/^github:([^/]+\/[^:]+)(?::|$)/);
  if (!match) return null;

  return match[1] ?? null;
}

export function getGitHubRepositoryReference(
  thread: Thread,
  message: Message
): GitHubRepositoryReference {
  // GitHub adapter messages always carry a GitHubRawMessage.raw, but tests
  // exercise fallback paths with sparse fixtures, so treat raw as partial.
  const { repository } = (message as Message<Partial<GitHubRawMessage>>).raw;

  return {
    id: repository?.id ?? null,
    fullName:
      repository?.full_name ??
      parseGitHubRepositoryFullName(thread.id) ??
      parseGitHubRepositoryFullName(thread.channelId),
  };
}

export function isGitHubRepositoryLinked(
  integration: PlatformIntegration,
  repository: GitHubRepositoryReference
): boolean {
  if (repository.id === null && repository.fullName === null) return false;

  if (integration.repository_access === 'all') return true;
  if (integration.repository_access !== 'selected') return false;

  const repositories = integration.repositories ?? [];
  return repositories.some(linkedRepository => {
    if (repository.id !== null && linkedRepository.id === repository.id) return true;

    return (
      repository.fullName !== null &&
      linkedRepository.full_name.toLowerCase() === repository.fullName.toLowerCase()
    );
  });
}

type GitHubThreadCoordinates = {
  owner: string;
  repo: string;
  number: number;
  reviewCommentId: number | null;
};

type GitHubIssueLike = {
  body?: string | null;
  html_url: string;
  number: number;
  pull_request?: unknown;
  state: string;
  title: string;
  user?: { login?: string } | null;
};

type GitHubIssueComment = {
  body?: string | null;
  created_at?: string | null;
  id: number;
  user?: { login?: string } | null;
};

type GitHubReviewComment = GitHubIssueComment & {
  diff_hunk?: string | null;
  html_url?: string;
  in_reply_to_id?: number | null;
  line?: number | null;
  original_line?: number | null;
  path?: string | null;
};

type GitHubReviewThreadContext = {
  targetComment: GitHubReviewComment | null;
  comments: GitHubReviewComment[];
};

function parseGitHubThreadId(threadId: string): GitHubThreadCoordinates | null {
  if (!threadId.startsWith('github:')) return null;

  const withoutPrefix = threadId.slice('github:'.length);
  const reviewCommentMatch = withoutPrefix.match(/^([^/]+)\/([^:]+):(\d+):rc:(\d+)$/);
  if (reviewCommentMatch) {
    return {
      owner: reviewCommentMatch[1],
      repo: reviewCommentMatch[2],
      number: Number.parseInt(reviewCommentMatch[3], 10),
      reviewCommentId: Number.parseInt(reviewCommentMatch[4], 10),
    };
  }

  const issueMatch = withoutPrefix.match(/^([^/]+)\/([^:]+):issue:(\d+)$/);
  if (issueMatch) {
    return {
      owner: issueMatch[1],
      repo: issueMatch[2],
      number: Number.parseInt(issueMatch[3], 10),
      reviewCommentId: null,
    };
  }

  const pullRequestMatch = withoutPrefix.match(/^([^/]+)\/([^:]+):(\d+)$/);
  if (pullRequestMatch) {
    return {
      owner: pullRequestMatch[1],
      repo: pullRequestMatch[2],
      number: Number.parseInt(pullRequestMatch[3], 10),
      reviewCommentId: null,
    };
  }

  return null;
}

function formatGitHubItemBody(item: GitHubIssueLike): string {
  const body = item.body?.trim();
  if (!body) return '(No description provided.)';
  return sanitizeForDelimiters(truncate(body, MAX_GITHUB_BODY_LENGTH));
}

function formatGitHubComment(comment: GitHubIssueComment): string {
  const author = sanitizeForDelimiters(comment.user?.login ?? 'unknown');
  const time = comment.created_at ?? 'unknown';
  const body = sanitizeForDelimiters(
    truncate(comment.body?.trim() || '(empty comment)', MAX_GITHUB_COMMENT_LENGTH)
  );
  return `<github_comment id="${comment.id}" author="${author}" time="${time}">${body}</github_comment>`;
}

function formatGitHubReviewComment(comment: GitHubReviewComment): string {
  const author = sanitizeForDelimiters(comment.user?.login ?? 'unknown');
  const time = comment.created_at ?? 'unknown';
  const body = sanitizeForDelimiters(
    truncate(comment.body?.trim() || '(empty comment)', MAX_GITHUB_COMMENT_LENGTH)
  );
  return `<github_review_comment id="${comment.id}" author="${author}" time="${time}">${body}</github_review_comment>`;
}

function pageFromLinkHeader(linkHeader: string | undefined, rel: string): number | null {
  if (!linkHeader) return null;

  for (const link of linkHeader.split(',')) {
    if (!link.includes(`rel="${rel}"`)) continue;

    const match = link.match(/[?&]page=(\d+)/);
    if (!match) return null;

    const page = Number.parseInt(match[1], 10);
    return Number.isNaN(page) ? null : page;
  }

  return null;
}

function hasNextPage(linkHeader: string | undefined): boolean {
  return pageFromLinkHeader(linkHeader, 'next') !== null;
}

function sortByCreatedAt<T extends { created_at?: string | null; id: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aTime = a.created_at ? Date.parse(a.created_at) : 0;
    const bTime = b.created_at ? Date.parse(b.created_at) : 0;
    if (aTime !== bTime) return aTime - bTime;
    return a.id - b.id;
  });
}

async function fetchRecentIssueComments(
  octokit: Octokit,
  coordinates: GitHubThreadCoordinates
): Promise<GitHubIssueComment[]> {
  const response = await octokit.issues.listComments({
    owner: coordinates.owner,
    repo: coordinates.repo,
    issue_number: coordinates.number,
    sort: 'created',
    direction: 'desc',
    per_page: BOT_CONTEXT_MESSAGE_LIMIT,
  });
  return sortByCreatedAt(response.data);
}

const MAX_REVIEW_COMMENT_PAGES = 5;
const REVIEW_COMMENT_PAGE_SIZE = 100;

async function fetchPullReviewComments(
  octokit: Octokit,
  coordinates: GitHubThreadCoordinates
): Promise<GitHubReviewComment[]> {
  const comments: GitHubReviewComment[] = [];

  for (let page = 1; page <= MAX_REVIEW_COMMENT_PAGES; page += 1) {
    const response = await octokit.pulls.listReviewComments({
      owner: coordinates.owner,
      repo: coordinates.repo,
      pull_number: coordinates.number,
      per_page: REVIEW_COMMENT_PAGE_SIZE,
      page,
    });

    comments.push(...response.data);

    if (!hasNextPage(response.headers.link)) return comments;
  }

  console.warn('[bot] Hit review comment pagination cap', {
    owner: coordinates.owner,
    repo: coordinates.repo,
    pullNumber: coordinates.number,
    cap: MAX_REVIEW_COMMENT_PAGES * REVIEW_COMMENT_PAGE_SIZE,
  });
  return comments;
}

async function fetchReviewThreadContext(
  octokit: Octokit,
  coordinates: GitHubThreadCoordinates
): Promise<GitHubReviewThreadContext | null> {
  if (coordinates.reviewCommentId === null) return null;

  const comments = await fetchPullReviewComments(octokit, coordinates);
  const targetComment =
    comments.find(comment => comment.id === coordinates.reviewCommentId) ?? null;
  const rootCommentId = targetComment?.in_reply_to_id ?? coordinates.reviewCommentId;
  const threadComments = comments.filter(
    comment => comment.id === rootCommentId || comment.in_reply_to_id === rootCommentId
  );

  return {
    targetComment,
    comments: sortByCreatedAt(threadComments),
  };
}

function isGitHubBotEnabledForIntegration(integration: PlatformIntegration): boolean {
  const metadata = integration.metadata as { bot_enabled?: boolean } | null;
  return metadata?.bot_enabled === true;
}

export function createGitHubBotPlatform(githubAdapter: GitHubInstallationLookup): BotPlatform {
  return {
    platform: PLATFORM.GITHUB,
    // TODO(remon): point at a dedicated GitHub bot docs page once we have one.
    documentationUrl: 'https://kilo.ai/docs/code-with-ai/platforms/slack',
    usesGenericLinkAccountRoute: false,
    async getIdentity({ thread, message }) {
      const teamId = await githubAdapter.getInstallationId(thread);

      if (!teamId) {
        throw new Error(`Could not find GitHub installation ID for thread ${thread.id}`);
      }

      return {
        platform: PLATFORM.GITHUB,
        teamId: teamId.toString(),
        userId: message.author.userId,
      };
    },
    isEnabledForBot: isGitHubBotEnabledForIntegration,
    canHandleMessage({ thread, message, platformIntegration }) {
      return isGitHubRepositoryLinked(
        platformIntegration,
        getGitHubRepositoryReference(thread, message)
      );
    },
    async promptLinkAccount({ thread, identity, platformIntegration }) {
      const url = new URL(GITHUB_LINK_PATH, APP_URL);
      url.searchParams.set(
        'token',
        createGitHubLinkToken({
          platformIntegrationId: platformIntegration.id,
          installationId: identity.teamId,
        })
      );

      await thread.post({
        markdown:
          'To use Kilo from GitHub you first need to link your GitHub account to Kilo. ' +
          `[Link your Kilo account](${url.toString()}) to continue. ` +
          'After linking, mention me again in this issue or pull request.',
      });
    },
    async withAuthContext({ fn }) {
      return await fn();
    },
    async getConversationContext({ thread, triggerMessage, platformIntegration }) {
      const coordinates = parseGitHubThreadId(thread.id);
      if (!coordinates) return '';

      const installationId = platformIntegration.platform_installation_id;
      if (!installationId) return '';

      const tokenData = await generateGitHubInstallationToken(
        installationId,
        platformIntegration.github_app_type ?? 'standard'
      );
      const octokit = new Octokit({ auth: tokenData.token });

      const [issueResponse, issueComments, reviewThreadContext] = await Promise.all([
        octokit.issues.get({
          owner: coordinates.owner,
          repo: coordinates.repo,
          issue_number: coordinates.number,
        }),
        fetchRecentIssueComments(octokit, coordinates),
        fetchReviewThreadContext(octokit, coordinates),
      ]);

      const issue: GitHubIssueLike = issueResponse.data;
      const itemType = issue.pull_request ? 'pull request' : 'issue';
      const itemLabel = issue.pull_request ? 'Pull request' : 'Issue';
      const trigger = formatTriggerMessage(triggerMessage, MAX_GITHUB_COMMENT_LENGTH);
      const comments = issueComments
        .filter(comment => comment.id.toString() !== triggerMessage.id)
        .map(formatGitHubComment);

      const lines = [
        'GitHub context:',
        `You are responding in a GitHub ${itemType}.`,
        `- Repository: ${sanitizeForDelimiters(`${coordinates.owner}/${coordinates.repo}`)}`,
        `- ${itemLabel}: #${issue.number} ${sanitizeForDelimiters(issue.title)}`,
        `- State: ${sanitizeForDelimiters(issue.state)}`,
        `- URL: ${issue.html_url}`,
      ];

      if (coordinates.reviewCommentId !== null) {
        lines.push(`- Review comment thread id: ${coordinates.reviewCommentId}`);
      }

      lines.push(
        '',
        `${itemLabel} description:`,
        `<github_description author="${sanitizeForDelimiters(issue.user?.login ?? 'unknown')}">${formatGitHubItemBody(issue)}</github_description>`
      );

      if (comments.length > 0) {
        lines.push('', 'Existing GitHub conversation comments (oldest first):', ...comments);
      }

      if (reviewThreadContext) {
        const anchor = reviewThreadContext.comments[0] ?? reviewThreadContext.targetComment;
        const reviewComments = reviewThreadContext.comments
          .filter(comment => comment.id.toString() !== triggerMessage.id)
          .map(formatGitHubReviewComment);

        lines.push('', 'Pull request review thread:');

        if (anchor?.path) {
          lines.push(`- File: ${sanitizeForDelimiters(anchor.path)}`);
        }

        const line = anchor?.line ?? anchor?.original_line;
        if (line) {
          lines.push(`- Line: ${line}`);
        }

        if (anchor?.html_url) {
          lines.push(`- Review comment URL: ${anchor.html_url}`);
        }

        if (anchor?.diff_hunk) {
          lines.push(
            'Diff hunk:',
            `<github_diff_hunk>${sanitizeForDelimiters(truncate(anchor.diff_hunk, MAX_GITHUB_COMMENT_LENGTH))}</github_diff_hunk>`
          );
        }

        if (reviewComments.length > 0) {
          lines.push('Review comments in this thread (oldest first):', ...reviewComments);
        }
      }

      lines.push('', 'Comment that triggered this bot run:', formatUserMessage(trigger));

      return lines.join('\n');
    },
    async getRequesterInfo({ displayName }) {
      return { displayName, platform: PLATFORM.GITHUB };
    },
  };
}
