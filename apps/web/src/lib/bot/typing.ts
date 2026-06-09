import type { PlatformIntegration } from '@kilocode/db';
import type { Message, Thread } from 'chat';
import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  addReactionToIssueComment,
  addReactionToPR,
  addReactionToPRReviewComment,
  type GitHubReaction,
} from '@/lib/integrations/platforms/github/adapter';

type TypingIndicator = {
  done(): Promise<void>;
};

type GitHubThreadCoordinates = {
  owner: string;
  repo: string;
  number: number;
  reviewCommentId: number | null;
};

type GitHubReactionTarget =
  | {
      kind: 'issue';
      number: number;
    }
  | {
      kind: 'issueComment';
      commentId: number;
    }
  | {
      kind: 'reviewComment';
      commentId: number;
    };

const noopTypingIndicator: TypingIndicator = {
  async done() {},
};

function parseGitHubThreadId(threadId: string): GitHubThreadCoordinates | null {
  if (!threadId.startsWith('github:')) return null;

  const withoutPrefix = threadId.slice('github:'.length);
  const reviewCommentMatch = withoutPrefix.match(/^([^/]+)\/([^:]+):(\d+):rc:(\d+)$/);
  if (reviewCommentMatch) {
    const owner = reviewCommentMatch[1];
    const repo = reviewCommentMatch[2];
    const number = Number.parseInt(reviewCommentMatch[3], 10);
    const reviewCommentId = Number.parseInt(reviewCommentMatch[4], 10);
    if (!owner || !repo || Number.isNaN(number) || Number.isNaN(reviewCommentId)) return null;

    return { owner, repo, number, reviewCommentId };
  }

  const issueMatch = withoutPrefix.match(/^([^/]+)\/([^:]+):issue:(\d+)$/);
  if (issueMatch) {
    const owner = issueMatch[1];
    const repo = issueMatch[2];
    const number = Number.parseInt(issueMatch[3], 10);
    if (!owner || !repo || Number.isNaN(number)) return null;

    return { owner, repo, number, reviewCommentId: null };
  }

  const pullRequestMatch = withoutPrefix.match(/^([^/]+)\/([^:]+):(\d+)$/);
  if (pullRequestMatch) {
    const owner = pullRequestMatch[1];
    const repo = pullRequestMatch[2];
    const number = Number.parseInt(pullRequestMatch[3], 10);
    if (!owner || !repo || Number.isNaN(number)) return null;

    return { owner, repo, number, reviewCommentId: null };
  }

  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getNumericId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;

  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) ? id : null;
}

function getGitHubCommentId(message: Message): number | null {
  const raw = message.raw;
  if (isObject(raw)) {
    const comment = raw.comment;
    if (isObject(comment)) {
      const commentId = getNumericId(comment.id);
      if (commentId !== null) return commentId;
    }
  }

  return getNumericId(message.id);
}

function getGitHubReactionTarget(
  coordinates: GitHubThreadCoordinates,
  message: Message
): GitHubReactionTarget {
  const commentId = getGitHubCommentId(message);

  if (coordinates.reviewCommentId !== null) {
    return {
      kind: 'reviewComment',
      commentId: commentId ?? coordinates.reviewCommentId,
    };
  }

  if (commentId !== null) return { kind: 'issueComment', commentId };

  return { kind: 'issue', number: coordinates.number };
}

async function addGitHubReaction(params: {
  platformIntegration: PlatformIntegration;
  coordinates: GitHubThreadCoordinates;
  target: GitHubReactionTarget;
  reaction: GitHubReaction;
}): Promise<void> {
  const installationId = params.platformIntegration.platform_installation_id;
  if (!installationId) return;

  const appType = params.platformIntegration.github_app_type ?? 'standard';
  const { owner, repo } = params.coordinates;

  switch (params.target.kind) {
    case 'reviewComment':
      await addReactionToPRReviewComment(
        installationId,
        owner,
        repo,
        params.target.commentId,
        params.reaction,
        appType
      );
      return;
    case 'issueComment':
      await addReactionToIssueComment(
        installationId,
        owner,
        repo,
        params.target.commentId,
        params.reaction,
        appType
      );
      return;
    case 'issue':
      await addReactionToPR(
        installationId,
        owner,
        repo,
        params.target.number,
        params.reaction,
        appType
      );
      return;
  }
}

async function addGitHubReactionBestEffort(params: Parameters<typeof addGitHubReaction>[0]) {
  try {
    await addGitHubReaction(params);
  } catch (error) {
    console.warn('[Bot] Failed to add GitHub bot reaction:', error);
  }
}

export async function startTyping(params: {
  thread: Thread;
  message: Message;
  platformIntegration: PlatformIntegration;
  text?: string;
}): Promise<TypingIndicator> {
  if (params.thread.adapter.name !== PLATFORM.GITHUB) {
    await params.thread.startTyping(params.text ?? 'Thinking...');
    return noopTypingIndicator;
  }

  const coordinates = parseGitHubThreadId(params.thread.id);
  if (!coordinates) return noopTypingIndicator;

  const target = getGitHubReactionTarget(coordinates, params.message);

  await addGitHubReactionBestEffort({
    platformIntegration: params.platformIntegration,
    coordinates,
    target,
    reaction: 'eyes',
  });

  return {
    async done() {
      await addGitHubReactionBestEffort({
        platformIntegration: params.platformIntegration,
        coordinates,
        target,
        reaction: '+1',
      });
    },
  };
}
