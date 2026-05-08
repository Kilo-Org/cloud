import { createLinearLinkToken } from '@/lib/bot/linear-link-token';
import { sanitizeForDelimiters, truncate } from '@/lib/bot/platforms/shared';
import type { BotPlatform, RequesterInfo } from '@/lib/bot/platforms/types';
import { BOT_CONTEXT_MESSAGE_LIMIT } from '@/lib/bot/constants';
import { APP_URL } from '@/lib/constants';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { LinearAdapter, LinearRawMessage } from '@chat-adapter/linear';
import type { PlatformIntegration } from '@kilocode/db';
import { LinearClient } from '@linear/sdk';
import type { Message, Thread } from 'chat';

const LINEAR_LINK_PATH = '/linear/link';

const MAX_ISSUE_DESCRIPTION_LENGTH = 4000;
const MAX_COMMENT_BODY_LENGTH = 1200;

type LinearIssueComment = {
  id: string;
  body: string;
  createdAt: string;
  authorName: string;
};

type LinearIssueContext = {
  identifier: string;
  title: string;
  url: string;
  description: string | null;
  stateName: string | null;
  comments: LinearIssueComment[];
};

function getLinearRaw(message: Message): LinearRawMessage | null {
  const raw = (message as Message<Partial<LinearRawMessage>>).raw;
  if (!raw || typeof raw !== 'object' || typeof raw.organizationId !== 'string') {
    return null;
  }
  return raw as LinearRawMessage;
}

async function fetchLinearIssueContext(
  linearAdapter: LinearAdapter,
  organizationId: string,
  issueId: string
): Promise<LinearIssueContext | null> {
  // Run inside a tenant-scoped installation context so the adapter's own
  // internal calls (used elsewhere in the same request) resolve against the
  // right Linear workspace. The `LinearClient` below uses the installation's
  // access token directly because the adapter does not expose its own
  // tenant-scoped client.
  return await linearAdapter.withInstallation(organizationId, async () => {
    const installation = await linearAdapter.getInstallation(organizationId);
    if (!installation) return null;

    const linear = new LinearClient({ accessToken: installation.accessToken });
    const issue = await linear.issue(issueId);
    const [state, commentsConnection] = await Promise.all([
      issue.state ? issue.state : Promise.resolve(null),
      issue.comments({ first: BOT_CONTEXT_MESSAGE_LIMIT }),
    ]);

    const comments = await Promise.all(
      commentsConnection.nodes.map(async comment => {
        const user = await comment.user;
        const authorName = user?.displayName ?? user?.name ?? 'unknown';
        return {
          id: comment.id,
          body: comment.body,
          createdAt: comment.createdAt.toISOString(),
          authorName,
        };
      })
    );

    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return {
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      description: issue.description ?? null,
      stateName: state?.name ?? null,
      comments,
    };
  });
}

function formatLinearComment(comment: LinearIssueComment): string {
  const author = sanitizeForDelimiters(comment.authorName);
  const body = sanitizeForDelimiters(
    truncate(comment.body.trim() || '(empty comment)', MAX_COMMENT_BODY_LENGTH)
  );
  return `<linear_comment id="${comment.id}" author="${author}" time="${comment.createdAt}">${body}</linear_comment>`;
}

async function getLinearConversationContext(
  thread: Thread,
  triggerMessage: Pick<Message, 'id'>,
  platformIntegration: PlatformIntegration,
  linearAdapter: LinearAdapter
): Promise<string> {
  const organizationId = platformIntegration.platform_installation_id;
  const { issueId } = linearAdapter.decodeThreadId(thread.id);

  if (typeof organizationId !== 'string') {
    throw new Error('Linear organization ID is not a string');
  }

  const issueContext = await fetchLinearIssueContext(linearAdapter, organizationId, issueId).catch(
    (error: unknown): null => {
      console.warn('[bot] Failed to fetch Linear issue context', { issueId, error });
      return null;
    }
  );
  if (!issueContext) return '';

  const lines: string[] = ['Linear conversation context:', 'You are responding on a Linear issue.'];

  lines.push(
    `- Issue: ${sanitizeForDelimiters(issueContext.identifier)} ${sanitizeForDelimiters(issueContext.title)}`
  );
  if (issueContext.stateName) {
    lines.push(`- State: ${sanitizeForDelimiters(issueContext.stateName)}`);
  }
  lines.push(`- URL: ${issueContext.url}`);

  if (issueContext.description && issueContext.description.trim().length > 0) {
    lines.push(
      '',
      'Issue description:',
      `<linear_issue_description>${sanitizeForDelimiters(
        truncate(issueContext.description, MAX_ISSUE_DESCRIPTION_LENGTH)
      )}</linear_issue_description>`
    );
  }

  const priorComments = issueContext.comments.filter(comment => comment.id !== triggerMessage.id);
  if (priorComments.length > 0) {
    lines.push('', 'Issue comments (oldest first):');
    for (const comment of priorComments) lines.push(formatLinearComment(comment));
  }

  return lines.join('\n');
}

function getLinearRequesterInfo(message: Message, displayName: string): RequesterInfo {
  const raw = getLinearRaw(message);
  const messageLink = raw?.comment?.url ?? undefined;
  return { displayName, messageLink, platform: PLATFORM.LINEAR };
}

export function createLinearBotPlatform(linearAdapter: LinearAdapter): BotPlatform {
  return {
    platform: PLATFORM.LINEAR,
    // TODO: point at a dedicated Linear docs page once it's published.
    documentationUrl: 'https://kilo.ai/docs/code-with-ai/platforms/linear',
    // Linear comments are visible to every workspace member, so the
    // generic `/api/chat/link-account` flow (which trusts the URL-embedded
    // `identity.userId` as the Linear user to link) cannot be used safely.
    // We bounce through a Linear OAuth identity-proof round-trip instead.
    usesGenericLinkAccountRoute: false,

    async getIdentity({ message }) {
      const raw = getLinearRaw(message);
      if (!raw) {
        throw new Error('Expected LinearRawMessage with organizationId in message.raw');
      }
      return {
        platform: PLATFORM.LINEAR,
        teamId: raw.organizationId,
        userId: message.author.userId,
      };
    },

    isEnabledForBot(integration) {
      const metadata = integration.metadata as { bot_enabled?: boolean } | null;
      return metadata?.bot_enabled === true;
    },

    canHandleMessage: () => true,

    async promptLinkAccount({ thread, identity, platformIntegration }) {
      const url = new URL(LINEAR_LINK_PATH, APP_URL);
      url.searchParams.set(
        'token',
        createLinearLinkToken({
          platformIntegrationId: platformIntegration.id,
          organizationId: identity.teamId,
        })
      );

      // Linear has no ephemeral messages or interactive buttons — post a
      // markdown link directly into the thread. The token does NOT carry
      // a Linear user id; the clicker proves their identity via OAuth.
      await thread.post({
        markdown:
          'To use Kilo from this Linear workspace you first need to link your Linear account to Kilo. ' +
          `[Link your Kilo account](${url.toString()}) to continue. ` +
          'After linking, mention me again on this issue.',
      });
    },

    async withAuthContext({ platformIntegration, fn }) {
      const organizationId = platformIntegration.platform_installation_id;
      if (!organizationId) {
        throw new Error(
          `No Linear organization id for platform integration ${platformIntegration.id}`
        );
      }
      return await linearAdapter.withInstallation(organizationId, fn);
    },

    async getConversationContext({ thread, triggerMessage, platformIntegration }) {
      return await getLinearConversationContext(
        thread,
        triggerMessage,
        platformIntegration,
        linearAdapter
      );
    },

    async getRequesterInfo({ message, displayName }) {
      return getLinearRequesterInfo(message, displayName);
    },
  };
}
