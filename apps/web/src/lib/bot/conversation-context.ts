import { Octokit } from '@octokit/rest';
import { BOT_CONTEXT_MESSAGE_LIMIT } from '@/lib/bot/constants';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { PlatformIntegration } from '@kilocode/db';
import type { Thread, Message, ChannelInfo } from 'chat';

const MAX_MESSAGE_TEXT_LENGTH = 400;
const MAX_GITHUB_BODY_LENGTH = 4000;
const MAX_GITHUB_COMMENT_LENGTH = 1200;

type ContextTriggerMessage = Pick<Message, 'author' | 'id' | 'text'> & {
  metadata?: Pick<Message['metadata'], 'dateSent'>;
};

type FormattedMessage = {
  authorName: string;
  text: string;
  time: string;
};

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

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

function sanitizeForDelimiters(text: string): string {
  return text.replace(/[<>"]/g, '').replace(/\r\n|\r/g, '\n');
}

function formatMessage(
  msg: Message,
  maxLength: number = MAX_MESSAGE_TEXT_LENGTH
): FormattedMessage {
  const collapsed = msg.text.replace(/\s+/g, ' ').trim();
  return {
    authorName: sanitizeForDelimiters(
      msg.author.fullName || msg.author.userName || msg.author.userId
    ),
    text: sanitizeForDelimiters(truncate(collapsed, maxLength)),
    time: msg.metadata.dateSent.toISOString(),
  };
}

function formatTriggerMessage(
  msg: ContextTriggerMessage,
  maxLength: number = MAX_MESSAGE_TEXT_LENGTH
): FormattedMessage {
  const collapsed = msg.text.replace(/\s+/g, ' ').trim();
  return {
    authorName: sanitizeForDelimiters(
      msg.author.fullName || msg.author.userName || msg.author.userId
    ),
    text: sanitizeForDelimiters(truncate(collapsed, maxLength)),
    time: msg.metadata?.dateSent.toISOString() ?? 'unknown',
  };
}

async function collectMessages(
  iterable: AsyncIterable<Message>,
  limit: number
): Promise<Message[]> {
  const collected: Message[] = [];
  for await (const msg of iterable) {
    if (collected.length >= limit) break;
    collected.push(msg);
  }
  return collected;
}

function formatUserMessage(msg: FormattedMessage): string {
  return `<user_message author="${msg.authorName}" time="${msg.time}">${msg.text}</user_message>`;
}

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

async function getGitHubConversationContext(
  thread: Thread,
  triggerMessage: ContextTriggerMessage,
  platformIntegration: PlatformIntegration
): Promise<string> {
  const coordinates = parseGitHubThreadId(thread.id);
  if (!coordinates) return '';

  const installationId = platformIntegration.platform_installation_id;
  if (!installationId) return '';

  const tokenData = await generateGitHubInstallationToken(
    installationId,
    platformIntegration.github_app_type ?? 'standard'
  );
  const octokit = new Octokit({ auth: tokenData.token });

  const [issueResponse, commentsResponse] = await Promise.all([
    octokit.issues.get({
      owner: coordinates.owner,
      repo: coordinates.repo,
      issue_number: coordinates.number,
    }),
    octokit.issues.listComments({
      owner: coordinates.owner,
      repo: coordinates.repo,
      issue_number: coordinates.number,
      per_page: BOT_CONTEXT_MESSAGE_LIMIT,
    }),
  ]);

  const issue: GitHubIssueLike = issueResponse.data;
  const itemType = issue.pull_request ? 'pull request' : 'issue';
  const itemLabel = issue.pull_request ? 'Pull request' : 'Issue';
  const trigger = formatTriggerMessage(triggerMessage, MAX_GITHUB_COMMENT_LENGTH);
  const comments = commentsResponse.data
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

  lines.push('', 'Comment that triggered this bot run:', formatUserMessage(trigger));

  return lines.join('\n');
}

async function getSlackConversationContext(
  thread: Thread,
  triggerMessage: ContextTriggerMessage
): Promise<string> {
  const [channelInfo, threadMessagesRaw, channelMessagesRaw] = await Promise.all([
    thread.channel.fetchMetadata().catch((): ChannelInfo | null => null),
    collectMessages(thread.messages, BOT_CONTEXT_MESSAGE_LIMIT).catch((): Message[] => []),
    collectMessages(thread.channel.messages, BOT_CONTEXT_MESSAGE_LIMIT).catch((): Message[] => []),
  ]);

  const threadMessages = threadMessagesRaw
    .filter(m => m.id !== triggerMessage.id)
    .map(m => formatMessage(m))
    .reverse();

  const channelMessages = channelMessagesRaw
    .filter(m => m.id !== triggerMessage.id)
    .map(m => formatMessage(m))
    .reverse();

  const metadata = channelInfo?.metadata ?? {};
  const channelTopic = typeof metadata.topic === 'string' ? metadata.topic : null;
  const channelPurpose = typeof metadata.purpose === 'string' ? metadata.purpose : null;

  const lines: string[] = ['Slack conversation context:'];
  const name = channelInfo?.name?.replace(/^#/, '');
  const channelLabel = (channelInfo?.isDM ?? thread.isDM) ? 'DM' : name ? `#${name}` : 'channel';
  lines.push(`- Channel: ${channelLabel}`);

  if (channelTopic) {
    lines.push(
      `- Channel topic: ${sanitizeForDelimiters(truncate(channelTopic, MAX_MESSAGE_TEXT_LENGTH))}`
    );
  }
  if (channelPurpose) {
    lines.push(
      `- Channel purpose: ${sanitizeForDelimiters(truncate(channelPurpose, MAX_MESSAGE_TEXT_LENGTH))}`
    );
  }

  if (channelMessages.length > 0) {
    lines.push('', 'Recent channel messages (oldest first):');
    for (const msg of channelMessages) lines.push(formatUserMessage(msg));
  }

  if (threadMessages.length > 0) {
    lines.push('', 'Thread messages (oldest first):');
    for (const msg of threadMessages) lines.push(formatUserMessage(msg));
  }

  if (lines.length <= 2 && channelMessages.length === 0) return '';
  return lines.join('\n');
}

async function getGenericConversationContext(
  thread: Thread,
  triggerMessage: ContextTriggerMessage
): Promise<string> {
  const threadMessages = (
    await collectMessages(thread.messages, BOT_CONTEXT_MESSAGE_LIMIT).catch((): Message[] => [])
  )
    .filter(m => m.id !== triggerMessage.id)
    .map(m => formatMessage(m))
    .reverse();

  if (threadMessages.length === 0) return '';

  const lines = ['Conversation context:', 'Thread messages (oldest first):'];
  for (const msg of threadMessages) lines.push(formatUserMessage(msg));
  return lines.join('\n');
}

export async function getPlatformContext(
  thread: Thread,
  triggerMessage: ContextTriggerMessage,
  platformIntegration: PlatformIntegration
): Promise<string> {
  switch (thread.adapter.name) {
    case PLATFORM.GITHUB:
      return getGitHubConversationContext(thread, triggerMessage, platformIntegration);
    case PLATFORM.SLACK:
      return getSlackConversationContext(thread, triggerMessage);
    default:
      return getGenericConversationContext(thread, triggerMessage);
  }
}
