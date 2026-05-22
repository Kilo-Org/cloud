import { createGitLabLinkToken } from '@/lib/bot/gitlab-link-token';
import {
  formatTriggerMessage,
  formatUserMessage,
  sanitizeForDelimiters,
  truncate,
  type ContextTriggerMessage,
} from '@/lib/bot/platforms/shared';
import type { BotPlatform } from '@/lib/bot/platforms/types';
import { APP_URL } from '@/lib/constants';
import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  createMRNote,
  fetchMergeRequest,
  fetchMRDiscussion,
  fetchMRNote,
  fetchMRNotes,
  replyToMRDiscussion,
  type GitLabDiscussion,
  type GitLabNote,
} from '@/lib/integrations/platforms/gitlab/adapter';
import {
  getOrCreateProjectAccessToken,
  getValidGitLabToken,
  type GitLabIntegrationMetadata,
} from '@/lib/integrations/gitlab-service';
import type { NoteEventPayload } from '@/lib/integrations/platforms/gitlab/webhook-schemas';
import type { PlatformIntegration } from '@kilocode/db';
import type { Author, Message, Thread } from 'chat';
import { z } from 'zod';

const GITLAB_LINK_PATH = '/gitlab/link';
const MAX_GITLAB_BODY_LENGTH = 4000;
const MAX_GITLAB_COMMENT_LENGTH = 1200;

const gitLabThreadContextSchema = z.object({
  integrationId: z.string().min(1),
  projectId: z.number(),
  projectPath: z.string().min(1),
  mrIid: z.number(),
  noteId: z.number().optional(),
  discussionId: z.string().min(1).optional(),
});

export type GitLabThreadContext = z.infer<typeof gitLabThreadContextSchema>;

type GitLabSyntheticRawMessage = {
  payload?: NoteEventPayload;
  note?: GitLabNote;
  threadContext: GitLabThreadContext;
};

type PostBody = string | { markdown?: string; text?: string };

export function hasGitLabBotMention(text: string): boolean {
  return /(^|\s)@(kilocode-bot|kilocode-dev)\b/i.test(text);
}

export function createGitLabThreadId(context: GitLabThreadContext): string {
  return `gitlab:${Buffer.from(JSON.stringify(context)).toString('base64url')}`;
}

export function parseGitLabThreadId(threadId: string): GitLabThreadContext | null {
  if (!threadId.startsWith('gitlab:')) return null;

  try {
    return gitLabThreadContextSchema.parse(
      JSON.parse(Buffer.from(threadId.slice('gitlab:'.length), 'base64url').toString('utf8'))
    );
  } catch {
    return null;
  }
}

function getGitLabInstanceUrl(integration: PlatformIntegration): string {
  const metadata = integration.metadata as GitLabIntegrationMetadata | null;
  return metadata?.gitlab_instance_url || 'https://gitlab.com';
}

function isGitLabBotEnabledForIntegration(integration: PlatformIntegration): boolean {
  const metadata = integration.metadata as { bot_enabled?: boolean } | null;
  return metadata?.bot_enabled === true;
}

function isGitLabProjectLinked(
  integration: PlatformIntegration,
  context: Pick<GitLabThreadContext, 'projectId' | 'projectPath'>
): boolean {
  if (integration.repository_access === 'all') return true;
  if (integration.repository_access !== 'selected') return false;

  const projectPath = context.projectPath.toLowerCase();
  return (integration.repositories ?? []).some(repository => {
    return (
      repository.id === context.projectId || repository.full_name.toLowerCase() === projectPath
    );
  });
}

function getMarkdownFromPostBody(body: PostBody): string {
  if (typeof body === 'string') return body;
  return body.markdown ?? body.text ?? '';
}

function createAuthor(params: {
  userId: string;
  userName: string;
  fullName: string;
  isBot?: boolean;
}): Author {
  return {
    userId: params.userId,
    userName: params.userName,
    fullName: params.fullName,
    isBot: params.isBot ?? false,
    isMe: false,
  };
}

function createSyntheticMessage(params: {
  id: string;
  threadId: string;
  text: string;
  author: Author;
  dateSent: Date;
  raw: GitLabSyntheticRawMessage;
}): Message {
  return {
    id: params.id,
    threadId: params.threadId,
    text: params.text,
    formatted: { type: 'root', children: [] },
    raw: params.raw,
    author: params.author,
    metadata: { dateSent: params.dateSent, edited: false },
    attachments: [],
    links: [],
    toJSON: () => {
      throw new Error('GitLab synthetic messages are not serialized by Chat SDK');
    },
  } as Message;
}

function createMessageFromGitLabNote(
  note: GitLabNote,
  threadContext: GitLabThreadContext,
  threadId: string
): Message {
  return createSyntheticMessage({
    id: note.id.toString(),
    threadId,
    text: note.body,
    author: createAuthor({
      userId: note.author.id.toString(),
      userName: note.author.username,
      fullName: note.author.name,
    }),
    dateSent: new Date(note.created_at),
    raw: { note, threadContext },
  });
}

export function createGitLabMessageFromNotePayload(
  payload: NoteEventPayload,
  threadContext: GitLabThreadContext
): Message {
  const threadId = createGitLabThreadId(threadContext);
  return createSyntheticMessage({
    id: payload.object_attributes.id.toString(),
    threadId,
    text: payload.object_attributes.note,
    author: createAuthor({
      userId: payload.user.id.toString(),
      userName: payload.user.username,
      fullName: payload.user.name,
    }),
    dateSent: new Date(payload.object_attributes.created_at),
    raw: { payload, threadContext },
  });
}

async function getPostingToken(
  integration: PlatformIntegration,
  projectId: number
): Promise<string> {
  try {
    return await getOrCreateProjectAccessToken(integration, projectId);
  } catch (error) {
    console.warn('[GitLabBot] Falling back to integration token for MR note posting:', error);
    return await getValidGitLabToken(integration);
  }
}

async function fetchGitLabMessage(
  integration: PlatformIntegration,
  threadId: string,
  messageId: string
): Promise<Message | null> {
  const context = parseGitLabThreadId(threadId);
  const noteId = Number.parseInt(messageId, 10);
  if (!context || Number.isNaN(noteId)) return null;

  const token = await getValidGitLabToken(integration);
  const note = await fetchMRNote(
    token,
    context.projectId,
    context.mrIid,
    noteId,
    getGitLabInstanceUrl(integration)
  );
  return createMessageFromGitLabNote(note, context, threadId);
}

export function createGitLabSyntheticThread(params: {
  context: GitLabThreadContext;
  platformIntegration: PlatformIntegration;
}): Thread {
  const threadId = createGitLabThreadId(params.context);
  const adapter = {
    name: PLATFORM.GITLAB,
    fetchMessage: async (id: string, messageId: string) =>
      await fetchGitLabMessage(params.platformIntegration, id, messageId),
  };

  const thread = {
    id: threadId,
    channelId: `gitlab:${params.context.projectPath}`,
    isDM: false,
    adapter,
    async startTyping() {},
    async post(body: PostBody) {
      const markdown = getMarkdownFromPostBody(body);
      const token = await getPostingToken(params.platformIntegration, params.context.projectId);
      const instanceUrl = getGitLabInstanceUrl(params.platformIntegration);
      let note: GitLabNote;

      if (params.context.discussionId) {
        try {
          note = await replyToMRDiscussion(
            token,
            params.context.projectId,
            params.context.mrIid,
            params.context.discussionId,
            markdown,
            instanceUrl
          );
        } catch (error) {
          console.warn(
            '[GitLabBot] Failed to reply to discussion, posting top-level MR note:',
            error
          );
          note = await createMRNote(
            token,
            params.context.projectId,
            params.context.mrIid,
            markdown,
            instanceUrl
          );
        }
      } else {
        note = await createMRNote(
          token,
          params.context.projectId,
          params.context.mrIid,
          markdown,
          instanceUrl
        );
      }

      return createMessageFromGitLabNote(note, params.context, threadId);
    },
    async postEphemeral(author: Author, body: PostBody) {
      return createSyntheticMessage({
        id: `gitlab-ephemeral-${Date.now()}`,
        threadId,
        text: getMarkdownFromPostBody(body),
        author,
        dateSent: new Date(),
        raw: { threadContext: params.context },
      });
    },
  };

  // Chat SDK has no GitLab adapter. This synthetic thread implements only the
  // methods Kilo Bot uses for mention processing and callback posting.
  return thread as unknown as Thread;
}

function formatGitLabNote(note: GitLabNote): string {
  const author = sanitizeForDelimiters(note.author.username || note.author.name || 'unknown');
  const body = sanitizeForDelimiters(
    truncate(note.body?.trim() || '(empty note)', MAX_GITLAB_COMMENT_LENGTH)
  );
  return `<gitlab_note id="${note.id}" author="${author}" time="${note.created_at}">${body}</gitlab_note>`;
}

function findDiscussionPosition(
  discussion: GitLabDiscussion | null
): GitLabNote['position'] | null {
  if (!discussion) return null;
  return discussion.notes.find(note => note.position)?.position ?? null;
}

function getTriggerRawMessage(
  triggerMessage: ContextTriggerMessage
): GitLabSyntheticRawMessage | null {
  const raw = (triggerMessage as ContextTriggerMessage & { raw?: unknown }).raw;
  const parsed = z
    .object({ threadContext: gitLabThreadContextSchema })
    .passthrough()
    .safeParse(raw);
  return parsed.success ? (raw as GitLabSyntheticRawMessage) : null;
}

async function getGitLabConversationContext(params: {
  thread: Thread;
  triggerMessage: ContextTriggerMessage;
  platformIntegration: PlatformIntegration;
}): Promise<string> {
  const context = parseGitLabThreadId(params.thread.id);
  if (!context) return '';

  const token = await getValidGitLabToken(params.platformIntegration);
  const instanceUrl = getGitLabInstanceUrl(params.platformIntegration);
  const [mergeRequest, notes, discussion] = await Promise.all([
    fetchMergeRequest(token, context.projectId, context.mrIid, instanceUrl),
    fetchMRNotes(token, context.projectId, context.mrIid, instanceUrl),
    context.discussionId
      ? fetchMRDiscussion(
          token,
          context.projectId,
          context.mrIid,
          context.discussionId,
          instanceUrl
        ).catch(() => null)
      : Promise.resolve(null),
  ]);
  const triggerRaw = getTriggerRawMessage(params.triggerMessage);
  const trigger = formatTriggerMessage(params.triggerMessage, MAX_GITLAB_COMMENT_LENGTH);
  const recentNotes = notes
    .filter(note => !note.system && note.id.toString() !== params.triggerMessage.id)
    .map(formatGitLabNote);
  const position =
    findDiscussionPosition(discussion) ?? triggerRaw?.payload?.object_attributes.position;
  const stDiff = triggerRaw?.payload?.object_attributes.st_diff;

  const lines = [
    'GitLab context:',
    'You are responding in a GitLab merge request.',
    `- Project: ${sanitizeForDelimiters(context.projectPath)}`,
    `- Merge request: !${mergeRequest.iid} ${sanitizeForDelimiters(mergeRequest.title)}`,
    `- State: ${sanitizeForDelimiters(mergeRequest.state)}`,
    `- URL: ${mergeRequest.web_url}`,
    `- Source branch: ${sanitizeForDelimiters(mergeRequest.source_branch)}`,
    `- Target branch: ${sanitizeForDelimiters(mergeRequest.target_branch)}`,
    `- Merge request author: ${sanitizeForDelimiters(mergeRequest.author.username)}`,
    '- New MR guidance: if the requester asks for a new or separate MR, create a fresh branch from the MR target branch and avoid pushing to or modifying the current MR source branch unless the requester names a different target.',
    '',
    'Merge request description:',
    `<gitlab_description author="${sanitizeForDelimiters(mergeRequest.author.username)}">${sanitizeForDelimiters(truncate(mergeRequest.description?.trim() || '(No description provided.)', MAX_GITLAB_BODY_LENGTH))}</gitlab_description>`,
  ];

  if (recentNotes.length > 0) {
    lines.push('', 'Recent GitLab MR notes (oldest first):', ...recentNotes);
  }

  if (discussion) {
    lines.push(
      '',
      'GitLab discussion thread:',
      `- Discussion id: ${sanitizeForDelimiters(discussion.id)}`
    );
    const discussionNotes = discussion.notes
      .filter(note => note.id.toString() !== params.triggerMessage.id)
      .map(formatGitLabNote);
    if (discussionNotes.length > 0) {
      lines.push('Discussion notes (oldest first):', ...discussionNotes);
    }
  }

  if (position) {
    lines.push('', 'Inline comment position:');
    const path = position.new_path || position.old_path;
    if (path) lines.push(`- File: ${sanitizeForDelimiters(path)}`);
    const line = position.new_line ?? position.old_line;
    if (line) lines.push(`- Line: ${line}`);
  }

  if (stDiff?.diff) {
    lines.push(
      'Diff hunk:',
      `<gitlab_diff_hunk>${sanitizeForDelimiters(truncate(stDiff.diff, MAX_GITLAB_COMMENT_LENGTH))}</gitlab_diff_hunk>`
    );
  }

  lines.push('', 'Comment that triggered this bot run:', formatUserMessage(trigger));

  return lines.join('\n');
}

export function createGitLabBotPlatform(): BotPlatform {
  return {
    platform: PLATFORM.GITLAB,
    documentationUrl: 'https://kilo.ai/docs/code-with-ai/platforms/slack',
    usesGenericLinkAccountRoute: false,
    async getIdentity({ thread, message }) {
      const context = parseGitLabThreadId(thread.id);
      if (!context) throw new Error(`Could not parse GitLab thread id ${thread.id}`);
      return {
        platform: PLATFORM.GITLAB,
        teamId: context.integrationId,
        userId: message.author.userId,
      };
    },
    isEnabledForBot: isGitLabBotEnabledForIntegration,
    canHandleMessage({ thread, platformIntegration }) {
      const context = parseGitLabThreadId(thread.id);
      return context ? isGitLabProjectLinked(platformIntegration, context) : false;
    },
    async promptLinkAccount({ thread, identity, platformIntegration }) {
      const url = new URL(GITLAB_LINK_PATH, APP_URL);
      url.searchParams.set(
        'token',
        createGitLabLinkToken({
          platformIntegrationId: platformIntegration.id,
          integrationId: identity.teamId,
        })
      );

      await thread.post({
        markdown:
          'To use Kilo from GitLab you first need to link your GitLab account to Kilo. ' +
          `[Link your Kilo account](${url.toString()}) to continue. ` +
          'After linking, mention me again in this merge request.',
      });
    },
    async withAuthContext({ fn }) {
      return await fn();
    },
    getConversationContext: getGitLabConversationContext,
    async getRequesterInfo({ message, displayName }) {
      const raw = (message as Message<GitLabSyntheticRawMessage>).raw;
      return {
        displayName,
        messageLink: raw.payload?.object_attributes.url,
        platform: PLATFORM.GITLAB,
      };
    },
  };
}
