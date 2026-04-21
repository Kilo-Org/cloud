import { CardElement, BaseFormatConverter, AdapterPostableMessage, Root, Logger, Adapter, ChatInstance, WebhookOptions, RawMessage, EphemeralMessage, ScheduledMessage, ModalElement, EmojiValue, StreamChunk, StreamOptions, FetchOptions, FetchResult, ThreadInfo, Message, ListThreadsOptions, ListThreadsResult, ChannelInfo, FormattedContent } from 'chat';

/**
 * Slack Block Kit converter for cross-platform cards.
 *
 * Converts CardElement to Slack Block Kit blocks.
 * @see https://api.slack.com/block-kit
 */

interface SlackBlock {
    block_id?: string;
    type: string;
    [key: string]: unknown;
}
/**
 * Convert a CardElement to Slack Block Kit blocks.
 */
declare function cardToBlockKit(card: CardElement): SlackBlock[];
/**
 * Generate fallback text from a card element.
 * Used when blocks aren't supported or for notifications.
 */
declare function cardToFallbackText(card: CardElement): string;

interface EncryptedTokenData {
    data: string;
    iv: string;
    tag: string;
}
declare function decodeKey(rawKey: string): Buffer;

/**
 * Slack-specific format conversion using AST-based parsing.
 *
 * Slack uses "mrkdwn" format which is similar but not identical to markdown:
 * - Bold: *text* (not **text**)
 * - Italic: _text_ (same)
 * - Strikethrough: ~text~ (not ~~text~~)
 * - Links: <url|text> (not [text](url))
 * - User mentions: <@U123>
 * - Channel mentions: <#C123|name>
 */

declare class SlackFormatConverter extends BaseFormatConverter {
    /**
     * Convert @mentions to Slack format in plain text.
     * @name → <@name>
     */
    private convertMentionsToSlack;
    /**
     * Override renderPostable to convert @mentions in plain strings.
     */
    renderPostable(message: AdapterPostableMessage): string;
    /**
     * Render an AST to Slack mrkdwn format.
     */
    fromAst(ast: Root): string;
    /**
     * Parse Slack mrkdwn into an AST.
     */
    toAst(mrkdwn: string): Root;
    /**
     * Convert AST to Slack blocks, using a native table block for the first table.
     * Returns null if the AST contains no tables (caller should use regular text).
     * Slack allows at most one table block per message; additional tables use ASCII.
     */
    toBlocksWithTable(ast: Root): SlackBlock[] | null;
    private nodeToMrkdwn;
}

interface SlackAdapterConfig {
    /** Bot token (xoxb-...). Required for single-workspace mode. Omit for multi-workspace. */
    botToken?: string;
    /** Bot user ID (will be fetched if not provided) */
    botUserId?: string;
    /** Slack app client ID (required for OAuth / multi-workspace) */
    clientId?: string;
    /** Slack app client secret (required for OAuth / multi-workspace) */
    clientSecret?: string;
    /**
     * Base64-encoded 32-byte AES-256-GCM encryption key.
     * If provided, bot tokens stored via setInstallation() will be encrypted at rest.
     */
    encryptionKey?: string;
    /**
     * Prefix for the state key used to store workspace installations.
     * Defaults to `slack:installation`. The full key will be `{prefix}:{teamId}`.
     */
    installationKeyPrefix?: string;
    /** Logger instance for error reporting. Defaults to ConsoleLogger. */
    logger?: Logger;
    /** Signing secret for webhook verification. Defaults to SLACK_SIGNING_SECRET env var. */
    signingSecret?: string;
    /** Override bot username (optional) */
    userName?: string;
}
/** Data stored per Slack workspace installation */
interface SlackInstallation {
    botToken: string;
    botUserId?: string;
    teamName?: string;
}
/** Slack-specific thread ID data */
interface SlackThreadId {
    channel: string;
    threadTs: string;
}
/** Slack event payload (raw message format) */
interface SlackEvent {
    /** Rich text blocks containing structured elements (links, mentions, etc.) */
    blocks?: Array<{
        type: string;
        elements?: Array<{
            type: string;
            elements?: Array<{
                type: string;
                url?: string;
                text?: string;
            }>;
        }>;
    }>;
    bot_id?: string;
    channel?: string;
    /** Channel type: "channel", "group", "mpim", or "im" (DM) */
    channel_type?: string;
    edited?: {
        ts: string;
    };
    files?: Array<{
        id?: string;
        mimetype?: string;
        url_private?: string;
        name?: string;
        size?: number;
        original_w?: number;
        original_h?: number;
    }>;
    /** Timestamp of the latest reply (present on thread parent messages) */
    latest_reply?: string;
    /** Number of replies in the thread (present on thread parent messages) */
    reply_count?: number;
    subtype?: string;
    team?: string;
    team_id?: string;
    text?: string;
    thread_ts?: string;
    ts?: string;
    type: string;
    user?: string;
    username?: string;
}
/** Slack reaction event payload */
interface SlackReactionEvent {
    event_ts: string;
    item: {
        type: string;
        channel: string;
        ts: string;
    };
    item_user?: string;
    reaction: string;
    type: "reaction_added" | "reaction_removed";
    user: string;
}
declare class SlackAdapter implements Adapter<SlackThreadId, unknown> {
    readonly name = "slack";
    readonly userName: string;
    private readonly client;
    private readonly signingSecret;
    private readonly defaultBotToken;
    private chat;
    private readonly logger;
    private _botUserId;
    private _botId;
    private readonly formatConverter;
    private static USER_CACHE_TTL_MS;
    private static CHANNEL_CACHE_TTL_MS;
    private readonly clientId;
    private readonly clientSecret;
    private readonly encryptionKey;
    private readonly installationKeyPrefix;
    private readonly requestContext;
    /** Bot user ID (e.g., U_BOT_123) used for mention detection */
    get botUserId(): string | undefined;
    constructor(config?: SlackAdapterConfig);
    /**
     * Get the current bot token for API calls.
     * Checks request context (multi-workspace) → default token (single-workspace) → throws.
     */
    private getToken;
    /**
     * Add the current token to API call options.
     * Workaround for Slack WebClient types not including `token` in per-method args.
     */
    private withToken;
    initialize(chat: ChatInstance): Promise<void>;
    private installationKey;
    /**
     * Save a Slack workspace installation.
     * Call this from your OAuth callback route after a successful installation.
     */
    setInstallation(teamId: string, installation: SlackInstallation): Promise<void>;
    /**
     * Retrieve a Slack workspace installation.
     */
    getInstallation(teamId: string): Promise<SlackInstallation | null>;
    /**
     * Handle the Slack OAuth V2 callback.
     * Accepts the incoming request, extracts the authorization code,
     * exchanges it for tokens, and saves the installation.
     */
    handleOAuthCallback(request: Request): Promise<{
        teamId: string;
        installation: SlackInstallation;
    }>;
    /**
     * Remove a Slack workspace installation.
     */
    deleteInstallation(teamId: string): Promise<void>;
    /**
     * Run a function with a specific bot token in context.
     * Use this for operations outside webhook handling (cron jobs, workflows).
     */
    withBotToken<T>(token: string, fn: () => T): T;
    /**
     * Resolve the bot token for a team from the state adapter.
     */
    private resolveTokenForTeam;
    /**
     * Extract team_id from an interactive payload (form-urlencoded).
     */
    private extractTeamIdFromInteractive;
    /**
     * Look up user info from Slack API with caching via state adapter.
     * Returns display name and real name, or falls back to user ID.
     */
    private lookupUser;
    /**
     * Look up channel name from Slack API with caching via state adapter.
     * Returns channel name, or falls back to channel ID.
     */
    private lookupChannel;
    handleWebhook(request: Request, options?: WebhookOptions): Promise<Response>;
    /** Extract and dispatch events from a validated payload */
    private processEventPayload;
    /**
     * Handle Slack interactive payloads (button clicks, view submissions, etc.).
     * These are sent as form-urlencoded with a `payload` JSON field.
     */
    private handleInteractivePayload;
    /**
     * Handle Slack slash command payloads.
     * Slash commands are sent as form-urlencoded with command, text, user_id, channel_id, etc.
     */
    private handleSlashCommand;
    /**
     * Handle block_actions payload (button clicks in Block Kit).
     */
    private handleBlockActions;
    private handleViewSubmission;
    private handleViewClosed;
    private modalResponseToSlack;
    private convertModalJSX;
    private verifySignature;
    /**
     * Handle message events from Slack.
     * Bot message filtering (isMe) is handled centrally by the Chat class.
     */
    private handleMessageEvent;
    /**
     * Handle reaction events from Slack (reaction_added, reaction_removed).
     */
    private handleReactionEvent;
    /**
     * Handle assistant_thread_started events from Slack's Assistants API.
     * Fires when a user opens a new assistant thread (DM with the bot).
     */
    private handleAssistantThreadStarted;
    /**
     * Handle assistant_thread_context_changed events from Slack's Assistants API.
     * Fires when a user navigates to a different channel with the assistant panel open.
     */
    private handleAssistantContextChanged;
    /**
     * Handle app_home_opened events from Slack.
     * Fires when a user opens the bot's Home tab.
     */
    private handleAppHomeOpened;
    /**
     * Handle member_joined_channel events from Slack.
     * Fires when a user (including the bot) joins a channel.
     */
    private handleMemberJoinedChannel;
    /**
     * Publish a Home tab view for a user.
     * Slack API: views.publish
     */
    publishHomeView(userId: string, view: Record<string, unknown>): Promise<void>;
    /**
     * Set suggested prompts for an assistant thread.
     * Slack Assistants API: assistant.threads.setSuggestedPrompts
     */
    setSuggestedPrompts(channelId: string, threadTs: string, prompts: Array<{
        title: string;
        message: string;
    }>, title?: string): Promise<void>;
    /**
     * Set status/thinking indicator for an assistant thread.
     * Slack Assistants API: assistant.threads.setStatus
     */
    setAssistantStatus(channelId: string, threadTs: string, status: string, loadingMessages?: string[]): Promise<void>;
    /**
     * Set title for an assistant thread (shown in History tab).
     * Slack Assistants API: assistant.threads.setTitle
     */
    setAssistantTitle(channelId: string, threadTs: string, title: string): Promise<void>;
    /**
     * Resolve inline user mentions in Slack mrkdwn text.
     * Converts <@U123> to <@U123|displayName> so that toAst/extractPlainText
     * renders them as @displayName instead of @U123.
     *
     * @param skipSelfMention - When true, skips the bot's own user ID so that
     *   mention detection (which looks for @botUserId in the text) continues to
     *   work. Set to false when parsing historical/channel messages where mention
     *   detection doesn't apply.
     */
    private resolveInlineMentions;
    /**
     * Extract link URLs from a Slack event.
     * Uses the `blocks` field (rich_text blocks with link elements) when available,
     * falling back to parsing `<url>` patterns from the text field.
     */
    private extractLinks;
    /**
     * Create a LinkPreview for a URL. If the URL points to a Slack message,
     * includes a `fetchMessage` callback that fetches and parses the linked message.
     */
    private createLinkPreview;
    private parseSlackMessage;
    /**
     * Create an Attachment object from a Slack file.
     * Includes a fetchData method that uses the bot token for auth.
     */
    private createAttachment;
    /**
     * Try to render a message using native Slack table blocks.
     * Returns blocks + fallback text if the message contains tables, null otherwise.
     */
    private renderWithTableBlocks;
    postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>>;
    postEphemeral(threadId: string, userId: string, message: AdapterPostableMessage): Promise<EphemeralMessage>;
    scheduleMessage(threadId: string, message: AdapterPostableMessage, options: {
        postAt: Date;
    }): Promise<ScheduledMessage>;
    openModal(triggerId: string, modal: ModalElement, contextId?: string): Promise<{
        viewId: string;
    }>;
    updateModal(viewId: string, modal: ModalElement): Promise<{
        viewId: string;
    }>;
    /**
     * Upload files to Slack and share them to a channel.
     * Returns the file IDs of uploaded files.
     */
    private uploadFiles;
    editMessage(threadId: string, messageId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>>;
    deleteMessage(threadId: string, messageId: string): Promise<void>;
    addReaction(threadId: string, messageId: string, emoji: EmojiValue | string): Promise<void>;
    removeReaction(threadId: string, messageId: string, emoji: EmojiValue | string): Promise<void>;
    /**
     * Show typing indicator with optional custom status.
     *
     * When status is provided, uses Slack's assistant.threads.setStatus API
     * to show custom loading text (requires Agents & AI Apps feature and assistant:write scope).
     * The status auto-clears when a message is posted to the thread.
     *
     * When status is not provided, defaults to "Typing..." with default loading messages.
     *
     * @param threadId - The thread to show the indicator in
     * @param status - Optional custom status message (e.g., "Searching documents...")
     */
    startTyping(threadId: string, status?: string): Promise<void>;
    /**
     * Stream a message using Slack's native streaming API.
     *
     * Consumes an async iterable of text chunks and/or structured StreamChunk
     * objects (task_update, plan_update, markdown_text) and streams them to Slack.
     *
     * Plain strings are rendered through StreamingMarkdownRenderer for safe
     * incremental markdown. StreamChunk objects are passed directly to Slack's
     * streaming API as chunk payloads, enabling native task progress cards
     * and plan displays in the Slack AI Assistant UI.
     *
     * Requires `recipientUserId` and `recipientTeamId` in options.
     */
    stream(threadId: string, textStream: AsyncIterable<string | StreamChunk>, options?: StreamOptions): Promise<RawMessage<unknown>>;
    /**
     * Open a direct message conversation with a user.
     * Returns a thread ID that can be used to post messages.
     */
    openDM(userId: string): Promise<string>;
    fetchMessages(threadId: string, options?: FetchOptions): Promise<FetchResult<unknown>>;
    /**
     * Fetch messages in forward direction (oldest first, efficient).
     * Uses native Slack cursor pagination.
     */
    private fetchMessagesForward;
    /**
     * Fetch messages in backward direction (most recent first).
     *
     * Slack's API returns oldest-first, so for backward direction we:
     * 1. Use `latest` parameter to fetch messages before a timestamp (cursor)
     * 2. Fetch up to 1000 messages (API limit) and take the last N
     * 3. Return messages in chronological order (oldest first within the page)
     *
     * Note: For very large threads (>1000 messages), the first backward call
     * may not return the absolute most recent messages. This is a Slack API limitation.
     */
    private fetchMessagesBackward;
    fetchThread(threadId: string): Promise<ThreadInfo>;
    /**
     * Fetch a single message by ID (timestamp).
     */
    fetchMessage(threadId: string, messageId: string): Promise<Message<unknown> | null>;
    encodeThreadId(platformData: SlackThreadId): string;
    /**
     * Check if a thread is a direct message conversation.
     * Slack DM channel IDs start with 'D'.
     */
    isDM(threadId: string): boolean;
    decodeThreadId(threadId: string): SlackThreadId;
    parseMessage(raw: SlackEvent): Message<unknown>;
    /**
     * Synchronous message parsing without user lookup.
     * Used for parseMessage interface - falls back to user ID for username.
     */
    private parseSlackMessageSync;
    /**
     * Derive channel ID from a Slack thread ID.
     * Slack thread IDs are "slack:CHANNEL:THREAD_TS", channel ID is "slack:CHANNEL".
     */
    channelIdFromThreadId(threadId: string): string;
    /**
     * Fetch channel-level messages (conversations.history, not thread replies).
     */
    fetchChannelMessages(channelId: string, options?: FetchOptions): Promise<FetchResult<unknown>>;
    private fetchChannelMessagesForward;
    private fetchChannelMessagesBackward;
    /**
     * List threads in a Slack channel.
     * Fetches channel history and filters for messages with replies.
     */
    listThreads(channelId: string, options?: ListThreadsOptions): Promise<ListThreadsResult<unknown>>;
    /**
     * Fetch Slack channel info/metadata.
     */
    fetchChannelInfo(channelId: string): Promise<ChannelInfo>;
    /**
     * Post a top-level message to a channel (not in a thread).
     */
    postChannelMessage(channelId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>>;
    renderFormatted(content: FormattedContent): string;
    /**
     * Check if a Slack event is from this bot.
     *
     * Slack messages can come from:
     * - User messages: have `user` field (U_xxx format)
     * - Bot messages: have `bot_id` field (B_xxx format)
     *
     * We check both because:
     * - _botUserId is the user ID (U_xxx) - matches event.user
     * - _botId is the bot ID (B_xxx) - matches event.bot_id
     */
    private isMessageFromSelf;
    private handleSlackError;
    /**
     * Encode response_url and userId into messageId for ephemeral messages.
     * This allows edit/delete operations to work via response_url.
     */
    private encodeEphemeralMessageId;
    /**
     * Decode ephemeral messageId to extract messageTs, responseUrl, and userId.
     * Returns null if the messageId is not an ephemeral encoding.
     */
    private decodeEphemeralMessageId;
    /**
     * Send a request to Slack's response_url to modify an ephemeral message.
     */
    private sendToResponseUrl;
}
declare function createSlackAdapter(config?: SlackAdapterConfig): SlackAdapter;

export { type EncryptedTokenData, SlackAdapter, type SlackAdapterConfig, type SlackEvent, SlackFormatConverter, type SlackInstallation, SlackFormatConverter as SlackMarkdownConverter, type SlackReactionEvent, type SlackThreadId, cardToBlockKit, cardToFallbackText, createSlackAdapter, decodeKey };
