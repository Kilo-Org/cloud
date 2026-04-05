import { WebClient } from '@slack/web-api';
import { captureException } from '@sentry/nextjs';
import { getInstallationByTeamId } from '@/lib/integrations/slack-service';
import { isRecord, replaceSlackUserMentionsWithNames } from '@/lib/slack-bot/slack-utils';

export type SlackEventContext = {
  channelId: string;
  threadTs?: string;
  userId: string;
  /** The timestamp of the message that triggered this event (for building permalinks) */
  messageTs: string;
};

export type SlackChannelInfo = {
  id: string;
  name: string | null;
  isIm: boolean;
  isPrivate: boolean;
  topic: string | null;
  purpose: string | null;
};

export type SlackMessageForPrompt = {
  ts: string;
  userId: string | null;
  text: string;
  subtype: string | null;
};

export type SlackConversationContext = {
  channel: SlackChannelInfo | null;
  recentChannelMessages: SlackMessageForPrompt[];
  recentThreadMessages: SlackMessageForPrompt[];
  errors: string[];
};

type SlackClientResult = { ok: true; client: WebClient } | { ok: false; error: string };

async function getSlackClientByTeamId(teamId: string): Promise<SlackClientResult> {
  const integration = await getInstallationByTeamId(teamId);

  if (!integration) {
    return { ok: false, error: 'No Slack installation found for this workspace' };
  }

  const metadata = integration.metadata as { access_token?: string } | null;
  if (!metadata?.access_token) {
    return { ok: false, error: 'No access token found' };
  }

  return { ok: true, client: new WebClient(metadata.access_token) };
}

function toSlackMessageForPrompt(message: unknown): SlackMessageForPrompt | null {
  if (!isRecord(message)) return null;

  const ts = typeof message.ts === 'string' ? message.ts : null;
  if (!ts) return null;

  const text = typeof message.text === 'string' ? message.text : '';
  const userId = typeof message.user === 'string' ? message.user : null;
  const subtype = typeof message.subtype === 'string' ? message.subtype : null;

  if (!text.trim()) return null;

  return { ts, userId, text, subtype };
}

async function getChannelInfo(
  client: WebClient,
  channelId: string
): Promise<{ ok: true; channel: SlackChannelInfo } | { ok: false; error: string }> {
  try {
    const result = await client.conversations.info({ channel: channelId });

    if (!result.ok) {
      return { ok: false, error: result.error ?? 'Unknown Slack API error' };
    }

    const channel = result.channel;
    if (!channel?.id) {
      return { ok: false, error: 'Missing channel in Slack conversations.info response' };
    }

    const topic = channel.topic?.value ?? null;
    const purpose = channel.purpose?.value ?? null;

    return {
      ok: true,
      channel: {
        id: channel.id,
        name: channel.name ?? null,
        isIm: channel.is_im ?? false,
        isPrivate: channel.is_private ?? false,
        topic,
        purpose,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, error: errorMessage };
  }
}

async function getConversationHistory(
  client: WebClient,
  args: {
    channelId: string;
    limit: number;
    latest?: string;
    inclusive?: boolean;
  }
): Promise<{ ok: true; messages: SlackMessageForPrompt[] } | { ok: false; error: string }> {
  try {
    const result = await client.conversations.history({
      channel: args.channelId,
      limit: args.limit,
      latest: args.latest,
      inclusive: args.inclusive,
    });

    if (!result.ok) {
      return { ok: false, error: result.error ?? 'Unknown Slack API error' };
    }

    const messages = (result.messages ?? [])
      .map(m => toSlackMessageForPrompt(m))
      .filter((m): m is SlackMessageForPrompt => m !== null);

    return { ok: true, messages };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, error: errorMessage };
  }
}

async function getThreadReplies(
  client: WebClient,
  args: {
    channelId: string;
    threadTs: string;
    limit: number;
  }
): Promise<{ ok: true; messages: SlackMessageForPrompt[] } | { ok: false; error: string }> {
  try {
    const result = await client.conversations.replies({
      channel: args.channelId,
      ts: args.threadTs,
      limit: args.limit,
    });

    if (!result.ok) {
      return { ok: false, error: result.error ?? 'Unknown Slack API error' };
    }

    const messages = (result.messages ?? [])
      .map(m => toSlackMessageForPrompt(m))
      .filter((m): m is SlackMessageForPrompt => m !== null);

    return { ok: true, messages };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, error: errorMessage };
  }
}

export async function getSlackConversationContext(
  teamId: string,
  context: SlackEventContext,
  limits?: { channelMessages?: number; threadMessages?: number }
): Promise<SlackConversationContext> {
  const channelMessagesLimit = limits?.channelMessages ?? 12;
  const threadMessagesLimit = limits?.threadMessages ?? 12;

  const errors: string[] = [];

  const clientResult = await getSlackClientByTeamId(teamId);
  if (!clientResult.ok) {
    errors.push(`slack client: ${clientResult.error}`);
    captureException(new Error('Failed to fetch Slack conversation context'), {
      level: 'warning',
      tags: { source: 'slack_conversation_context' },
      extra: {
        teamId,
        channelId: context.channelId,
        threadTs: context.threadTs,
        errors,
      },
    });
    return {
      channel: null,
      recentChannelMessages: [],
      recentThreadMessages: [],
      errors,
    };
  }

  const client = clientResult.client;

  // Parallelize all Slack API calls instead of sequential
  const [channelInfoResult, channelHistoryResult, threadRepliesResult] = await Promise.all([
    getChannelInfo(client, context.channelId),
    getConversationHistory(client, {
      channelId: context.channelId,
      limit: channelMessagesLimit,
      latest: context.threadTs,
      inclusive: context.threadTs ? true : undefined,
    }),
    context.threadTs
      ? getThreadReplies(client, {
          channelId: context.channelId,
          threadTs: context.threadTs,
          limit: threadMessagesLimit,
        })
      : Promise.resolve({ ok: true as const, messages: [] }),
  ]);

  const channel = channelInfoResult.ok ? channelInfoResult.channel : null;
  if (!channelInfoResult.ok) {
    errors.push(`channel info: ${channelInfoResult.error}`);
  }

  const recentChannelMessages = channelHistoryResult.ok ? channelHistoryResult.messages : [];
  if (!channelHistoryResult.ok) {
    errors.push(`channel history: ${channelHistoryResult.error}`);
  }

  const recentThreadMessages: SlackMessageForPrompt[] = [];
  if (threadRepliesResult.ok) {
    recentThreadMessages.push(...threadRepliesResult.messages);
  } else if (context.threadTs) {
    errors.push(`thread replies: ${threadRepliesResult.error}`);
  }

  if (errors.length > 0) {
    captureException(new Error('Failed to fetch Slack conversation context'), {
      level: 'warning',
      tags: { source: 'slack_conversation_context' },
      extra: {
        teamId,
        channelId: context.channelId,
        threadTs: context.threadTs,
        errors,
      },
    });
  }

  return {
    channel,
    recentChannelMessages,
    recentThreadMessages,
    errors,
  };
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

async function formatMessageForPrompt(
  message: SlackMessageForPrompt,
  client: WebClient
): Promise<string> {
  const userPart = message.userId ? `<@${message.userId}>` : 'unknown-user';
  const subtypePart = message.subtype ? ` subtype=${message.subtype}` : '';

  // Resolve user mentions in message text to human-readable names
  const resolvedText = await replaceSlackUserMentionsWithNames(client, message.text);
  const text = truncate(resolvedText.replace(/\s+/g, ' ').trim(), 400);

  return `- [${message.ts}] ${userPart}${subtypePart}: ${text}`;
}

export async function formatSlackConversationContextForPrompt(
  teamId: string,
  context: SlackConversationContext,
  eventContext: SlackEventContext
): Promise<string> {
  // Get client for resolving user mentions - if we can't get a client, give up
  const clientResult = await getSlackClientByTeamId(teamId);
  if (!clientResult.ok) {
    return '';
  }
  const client = clientResult.client;

  const lines: string[] = ['\n\nSlack context for this conversation:'];

  if (context.channel) {
    const channelLabel = context.channel.isIm
      ? 'DM'
      : context.channel.name
        ? `#${context.channel.name}`
        : 'channel';

    lines.push(`- Channel: ${channelLabel} (id: ${context.channel.id})`);
    if (context.channel.isPrivate) {
      lines.push(`- Channel privacy: private`);
    }
    if (context.channel.topic) {
      lines.push(`- Channel topic: ${truncate(context.channel.topic, 400)}`);
    }
    if (context.channel.purpose) {
      lines.push(`- Channel purpose: ${truncate(context.channel.purpose, 400)}`);
    }
  } else {
    lines.push(`- Channel: (id: ${eventContext.channelId})`);
  }

  if (eventContext.threadTs) {
    lines.push(`- Thread ts: ${eventContext.threadTs}`);
  }

  // Parallelize message formatting instead of sequential
  if (context.recentChannelMessages.length > 0) {
    lines.push('\nRecent channel messages (most recent first):');
    const formattedChannelMessages = await Promise.all(
      context.recentChannelMessages.map(msg => formatMessageForPrompt(msg, client))
    );
    lines.push(...formattedChannelMessages);
  }

  if (eventContext.threadTs && context.recentThreadMessages.length > 0) {
    lines.push('\nRecent thread messages (oldest first):');
    const oldestFirst = [...context.recentThreadMessages].sort((a, b) => a.ts.localeCompare(b.ts));
    const formattedThreadMessages = await Promise.all(
      oldestFirst.map(msg => formatMessageForPrompt(msg, client))
    );
    lines.push(...formattedThreadMessages);
  }

  if (context.errors.length > 0) {
    lines.push('\nNote: Some Slack context could not be fetched:');
    lines.push(...context.errors.map(e => `- ${e}`));
  }

  return lines.join('\n');
}
