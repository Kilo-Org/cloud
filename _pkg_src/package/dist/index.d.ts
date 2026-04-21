import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
import { Root, List, Content, Blockquote, Code, Emphasis, InlineCode, Delete, Link, ListItem, Paragraph, Strong, TableCell, Table as Table$1, TableRow, Text } from 'mdast';
export { Blockquote, Code, Content, Delete, Emphasis, InlineCode, Link, List, ListItem, Table as MdastTable, Paragraph, Root, Strong, TableCell, TableRow, Text } from 'mdast';
import { C as CardElement, M as ModalElement, a as ChatElement, b as CardChild, A as ActionsComponent, B as ButtonComponent, c as CardComponent, d as cardChildToFallbackText$1, e as CardLinkComponent, T as TextComponent, D as DividerComponent, F as FieldComponent, f as FieldsComponent, g as fromReactElement$1, I as ImageComponent, i as isCardElement$1, h as isJSX$1, L as LinkButtonComponent, S as SectionComponent, j as Table$2, t as toCardElement$1, k as toModalElement$1, l as fromReactModalElement$1, m as isModalElement$1, n as ModalComponent, R as RadioSelectComponent, o as SelectComponent, p as SelectOptionComponent, q as TextInputComponent } from './jsx-runtime-C2ATKxHQ.js';
export { r as ActionsElement, s as ButtonElement, u as ButtonOptions, V as ButtonProps, v as ButtonStyle, W as CardJSXElement, X as CardJSXProps, Y as CardLinkProps, w as CardOptions, Z as CardProps, _ as ContainerProps, x as DividerElement, $ as DividerProps, y as FieldElement, a0 as FieldProps, z as FieldsElement, E as ImageElement, a1 as ImageProps, G as LinkButtonElement, H as LinkButtonOptions, a2 as LinkButtonProps, J as LinkElement, a8 as ModalChild, a9 as ModalOptions, a3 as ModalProps, aa as RadioSelectElement, ab as RadioSelectOptions, K as SectionElement, ac as SelectElement, ad as SelectOptionElement, a4 as SelectOptionProps, ae as SelectOptions, a5 as SelectProps, N as TableAlignment, O as TableElement, P as TableOptions, Q as TextElement, af as TextInputElement, ag as TextInputOptions, a6 as TextInputProps, a7 as TextProps, U as TextStyle } from './jsx-runtime-C2ATKxHQ.js';

/**
 * Logger types and implementations for chat-sdk
 */
type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
interface Logger {
    /** Create a sub-logger with a prefix */
    child(prefix: string): Logger;
    debug(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
}
/**
 * Default console logger implementation.
 */
declare class ConsoleLogger implements Logger {
    private readonly prefix;
    private readonly level;
    constructor(level?: LogLevel, prefix?: string);
    private shouldLog;
    child(prefix: string): Logger;
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

/**
 * Error types for chat-sdk
 */
declare class ChatError extends Error {
    readonly code: string;
    readonly cause?: unknown;
    constructor(message: string, code: string, cause?: unknown);
}
declare class RateLimitError extends ChatError {
    readonly retryAfterMs?: number;
    constructor(message: string, retryAfterMs?: number, cause?: unknown);
}
declare class LockError extends ChatError {
    constructor(message: string, cause?: unknown);
}
declare class NotImplementedError extends ChatError {
    readonly feature?: string;
    constructor(message: string, feature?: string, cause?: unknown);
}

/**
 * Chat configuration with type-safe adapter inference.
 * @template TAdapters - Record of adapter name to adapter instance
 */
interface ChatConfig<TAdapters extends Record<string, Adapter> = Record<string, Adapter>> {
    /** Map of adapter name to adapter instance */
    adapters: TAdapters;
    /**
     * TTL for message deduplication entries in milliseconds.
     * Defaults to 300000 (5 minutes). Increase if your webhook cold starts
     * cause platform retries that arrive after the default TTL expires.
     */
    dedupeTtlMs?: number;
    /**
     * Placeholder text for fallback streaming (post + edit) adapters.
     * Defaults to `"..."`.
     *
     * Set to `null` to avoid posting an initial placeholder message and instead
     * wait until some real text has been streamed before creating the message.
     */
    fallbackStreamingPlaceholderText?: string | null;
    /**
     * Logger instance or log level.
     * Pass "silent" to disable all logging.
     */
    logger?: Logger | LogLevel;
    /**
     * Configuration for persistent message history.
     * Only used by adapters that set `persistMessageHistory: true`.
     */
    messageHistory?: {
        /** Maximum messages to store per thread (default: 100) */
        maxMessages?: number;
        /** TTL for cached history in milliseconds (default: 7 days) */
        ttlMs?: number;
    };
    /**
     * Behavior when a thread lock cannot be acquired (another handler is processing).
     * - `'drop'` (default) — throw `LockError`, preserving current behavior
     * - `'force'` — force-release the existing lock and re-acquire
     * - callback — custom logic receiving `(threadId, message)`, return `'force'` or `'drop'`
     *
     * When `'force'` is used, the previous handler continues executing — only the lock
     * is released, not the handler itself. This means two handlers may run concurrently
     * on the same thread. The old handler's `releaseLock()` call becomes a no-op since
     * the token no longer matches.
     */
    onLockConflict?: "force" | "drop" | ((threadId: string, message: Message) => "force" | "drop" | Promise<"force" | "drop">);
    /** State adapter for subscriptions and locking */
    state: StateAdapter;
    /**
     * Update interval for fallback streaming (post + edit) in milliseconds.
     * Defaults to 500ms. Lower values provide smoother updates but may hit rate limits.
     */
    streamingUpdateIntervalMs?: number;
    /** Default bot username across all adapters */
    userName: string;
}
/**
 * Options for webhook handling.
 */
interface WebhookOptions {
    /**
     * Function to run message handling in the background.
     * Use this to ensure fast webhook responses while processing continues.
     *
     * @example
     * // Next.js App Router
     * import { after } from "next/server";
     * chat.webhooks.slack(request, { waitUntil: (p) => after(() => p) });
     *
     * @example
     * // Vercel Functions
     * import { waitUntil } from "@vercel/functions";
     * chat.webhooks.slack(request, { waitUntil });
     */
    waitUntil?: (task: Promise<unknown>) => void;
}
/**
 * Adapter interface with generics for platform-specific types.
 * @template TThreadId - Platform-specific thread ID data type
 * @template TRawMessage - Platform-specific raw message type
 */
interface Adapter<TThreadId = unknown, TRawMessage = unknown> {
    /** Add a reaction to a message */
    addReaction(threadId: string, messageId: string, emoji: EmojiValue | string): Promise<void>;
    /** Bot user ID for platforms that use IDs in mentions (e.g., Slack's <@U123>) */
    readonly botUserId?: string;
    /**
     * Derive channel ID from a thread ID.
     * Default fallback: first two colon-separated parts (e.g., "slack:C123").
     * Adapters with different structures should override this.
     */
    channelIdFromThreadId(threadId: string): string;
    /** Decode thread ID string back to platform-specific data */
    decodeThreadId(threadId: string): TThreadId;
    /** Delete a message */
    deleteMessage(threadId: string, messageId: string): Promise<void>;
    /** Edit an existing message */
    editMessage(threadId: string, messageId: string, message: AdapterPostableMessage): Promise<RawMessage<TRawMessage>>;
    /** Encode platform-specific data into a thread ID string */
    encodeThreadId(platformData: TThreadId): string;
    /**
     * Fetch channel info/metadata.
     */
    fetchChannelInfo?(channelId: string): Promise<ChannelInfo>;
    /**
     * Fetch channel-level messages (top-level, not thread replies).
     * For example, Slack's conversations.history vs conversations.replies.
     */
    fetchChannelMessages?(channelId: string, options?: FetchOptions): Promise<FetchResult<TRawMessage>>;
    /**
     * Fetch a single message by ID.
     * Optional - adapters that don't implement this will return null.
     *
     * @param threadId - The thread ID containing the message
     * @param messageId - The platform-specific message ID
     * @returns The message, or null if not found/not supported
     */
    fetchMessage?(threadId: string, messageId: string): Promise<Message<TRawMessage> | null>;
    /**
     * Fetch messages from a thread.
     *
     * **Direction behavior:**
     * - `backward` (default): Fetches the most recent messages. Use this for loading
     *   a chat view. The `nextCursor` points to older messages.
     * - `forward`: Fetches the oldest messages first. Use this for iterating through
     *   message history. The `nextCursor` points to newer messages.
     *
     * **Message ordering:**
     * Messages within each page are always returned in chronological order (oldest first),
     * regardless of direction. This is the natural reading order for chat messages.
     *
     * @example
     * ```typescript
     * // Load most recent 50 messages for display
     * const recent = await adapter.fetchMessages(threadId, { limit: 50 });
     * // recent.messages: [older, ..., newest] in chronological order
     *
     * // Paginate backward to load older messages
     * const older = await adapter.fetchMessages(threadId, {
     *   limit: 50,
     *   cursor: recent.nextCursor,
     * });
     *
     * // Iterate through all history from the beginning
     * const history = await adapter.fetchMessages(threadId, {
     *   limit: 100,
     *   direction: 'forward',
     * });
     * ```
     */
    fetchMessages(threadId: string, options?: FetchOptions): Promise<FetchResult<TRawMessage>>;
    /** Fetch thread metadata */
    fetchThread(threadId: string): Promise<ThreadInfo>;
    /** Handle incoming webhook request */
    handleWebhook(request: Request, options?: WebhookOptions): Promise<Response>;
    /** Called when Chat instance is created (internal use) */
    initialize(chat: ChatInstance): Promise<void>;
    /**
     * Check if a thread is a direct message conversation.
     *
     * @param threadId - The thread ID to check
     * @returns True if the thread is a DM, false otherwise
     */
    isDM?(threadId: string): boolean;
    /**
     * List threads in a channel.
     */
    listThreads?(channelId: string, options?: ListThreadsOptions): Promise<ListThreadsResult<TRawMessage>>;
    /** Unique name for this adapter (e.g., "slack", "teams") */
    readonly name: string;
    /**
     * Optional hook called when a thread is subscribed to.
     * Adapters can use this to set up platform-specific subscriptions
     * (e.g., Google Chat Workspace Events).
     */
    onThreadSubscribe?(threadId: string): Promise<void>;
    /**
     * Open a direct message conversation with a user.
     *
     * @param userId - The platform-specific user ID
     * @returns The thread ID for the DM conversation
     *
     * @example
     * ```typescript
     * const dmThreadId = await adapter.openDM("U123456");
     * await adapter.postMessage(dmThreadId, "Hello!");
     * ```
     */
    openDM?(userId: string): Promise<string>;
    /**
     * Open a modal/dialog form.
     *
     * @param triggerId - Platform-specific trigger ID from the action event
     * @param modal - The modal element to display
     * @param contextId - Optional context ID for server-side stored thread/message context
     * @returns The view/dialog ID
     */
    openModal?(triggerId: string, modal: ModalElement, contextId?: string): Promise<{
        viewId: string;
    }>;
    /** Parse platform message format to normalized format */
    parseMessage(raw: TRawMessage): Message<TRawMessage>;
    /**
     * When true, the SDK persists message history in the state adapter for this platform.
     * Use this for platforms that lack server-side message history APIs (e.g., WhatsApp, Telegram).
     */
    readonly persistMessageHistory?: boolean;
    /**
     * Post a message to channel top-level (not in a thread).
     */
    postChannelMessage?(channelId: string, message: AdapterPostableMessage): Promise<RawMessage<TRawMessage>>;
    /**
     * Post an ephemeral message visible only to a specific user.
     *
     * This is optional - if not implemented, Thread.postEphemeral will
     * fall back to openDM + postMessage when fallbackToDM is true.
     *
     * @param threadId - The thread to post in
     * @param userId - The user who should see the message
     * @param message - The message content
     * @returns EphemeralMessage with usedFallback: false
     */
    postEphemeral?(threadId: string, userId: string, message: AdapterPostableMessage): Promise<EphemeralMessage<TRawMessage>>;
    /** Post a message to a thread */
    postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<TRawMessage>>;
    /** Remove a reaction from a message */
    removeReaction(threadId: string, messageId: string, emoji: EmojiValue | string): Promise<void>;
    /** Render formatted content to platform-specific string */
    renderFormatted(content: FormattedContent): string;
    /**
     * Schedule a message for future delivery.
     *
     * Optional — only supported by adapters with native scheduling APIs (e.g., Slack).
     * Thread.schedule() will throw NotImplementedError if this method is absent.
     *
     * @param threadId - The thread to post in
     * @param message - The message content
     * @param options - Scheduling options including the target delivery time
     * @returns A ScheduledMessage with cancel() capability
     */
    scheduleMessage?(threadId: string, message: AdapterPostableMessage, options: {
        postAt: Date;
    }): Promise<ScheduledMessage<TRawMessage>>;
    /** Show typing indicator */
    startTyping(threadId: string, status?: string): Promise<void>;
    /**
     * Stream a message using platform-native streaming APIs.
     *
     * The adapter consumes the async iterable and handles the entire streaming lifecycle.
     * Only available on platforms with native streaming support (e.g., Slack).
     *
     * The stream can yield plain strings (text chunks) or {@link StreamChunk} objects
     * for rich content like task progress cards. Adapters that don't support structured
     * chunks will extract text from `markdown_text` chunks and ignore other types.
     *
     * @param threadId - The thread to stream to
     * @param textStream - Async iterable of text chunks or structured StreamChunk objects
     * @param options - Platform-specific streaming options
     * @returns The raw message after streaming completes
     */
    stream?(threadId: string, textStream: AsyncIterable<string | StreamChunk>, options?: StreamOptions): Promise<RawMessage<TRawMessage>>;
    /** Bot username (can override global userName) */
    readonly userName: string;
}
/**
 * A structured streaming chunk for platform-native rich content.
 *
 * On Slack, these map directly to streaming chunk types:
 * - `markdown_text`: Streamed text content
 * - `task_update`: Tool/step progress cards (pending → in_progress → complete → error)
 * - `plan_update`: Plan title updates
 *
 * Adapters that don't support structured chunks will extract `text` from
 * `markdown_text` chunks and ignore other types gracefully.
 */
type StreamChunk = MarkdownTextChunk | TaskUpdateChunk | PlanUpdateChunk;
interface MarkdownTextChunk {
    text: string;
    type: "markdown_text";
}
interface TaskUpdateChunk {
    id: string;
    output?: string;
    status: "pending" | "in_progress" | "complete" | "error";
    title: string;
    type: "task_update";
}
interface PlanUpdateChunk {
    title: string;
    type: "plan_update";
}
/**
 * Options for streaming messages.
 * Platform-specific options are passed through to the adapter.
 */
interface StreamOptions {
    /** Slack: The team/workspace ID */
    recipientTeamId?: string;
    /** Slack: The user ID to stream to (for AI assistant context) */
    recipientUserId?: string;
    /** Block Kit elements to attach when stopping the stream (Slack only, via chat.stopStream) */
    stopBlocks?: unknown[];
    /**
     * Slack: Controls how task_update chunks are displayed.
     * - `"timeline"` — individual task cards shown inline with text (default)
     * - `"plan"` — all tasks grouped into a single plan block
     */
    taskDisplayMode?: "timeline" | "plan";
    /** Minimum interval between updates in ms (default: 1000). Used for fallback mode (GChat/Teams). */
    updateIntervalMs?: number;
}
/** Internal interface for Chat instance passed to adapters */
interface ChatInstance {
    /** Get the configured logger, optionally with a child prefix */
    getLogger(prefix?: string): Logger;
    getState(): StateAdapter;
    getUserName(): string;
    /**
     * @deprecated Use processMessage instead. This method is for internal use.
     */
    handleIncomingMessage(adapter: Adapter, threadId: string, message: Message): Promise<void>;
    /**
     * Process an incoming action event (button click) from an adapter.
     * Handles waitUntil registration and error catching internally.
     *
     * @param event - The action event (without thread field, will be added)
     * @param options - Webhook options including waitUntil
     */
    processAction(event: Omit<ActionEvent, "thread" | "openModal"> & {
        adapter: Adapter;
    }, options?: WebhookOptions): void;
    processAppHomeOpened(event: AppHomeOpenedEvent, options?: WebhookOptions): void;
    processAssistantContextChanged(event: AssistantContextChangedEvent, options?: WebhookOptions): void;
    processAssistantThreadStarted(event: AssistantThreadStartedEvent, options?: WebhookOptions): void;
    processMemberJoinedChannel(event: MemberJoinedChannelEvent, options?: WebhookOptions): void;
    /**
     * Process an incoming message from an adapter.
     * Handles waitUntil registration and error catching internally.
     *
     * @param adapter - The adapter that received the message
     * @param threadId - The thread ID
     * @param message - Either a parsed message, or a factory function for lazy async parsing
     * @param options - Webhook options including waitUntil
     */
    processMessage(adapter: Adapter, threadId: string, message: Message | (() => Promise<Message>), options?: WebhookOptions): void;
    /**
     * Process a modal close event from an adapter.
     *
     * @param event - The modal close event (without relatedThread/relatedMessage/relatedChannel)
     * @param contextId - Context ID for retrieving stored thread/message/channel context
     * @param options - Webhook options
     */
    processModalClose(event: Omit<ModalCloseEvent, "relatedThread" | "relatedMessage" | "relatedChannel">, contextId?: string, options?: WebhookOptions): void;
    /**
     * Process a modal submit event from an adapter.
     *
     * @param event - The modal submit event (without relatedThread/relatedMessage/relatedChannel)
     * @param contextId - Context ID for retrieving stored thread/message/channel context
     * @param options - Webhook options
     */
    processModalSubmit(event: Omit<ModalSubmitEvent, "relatedThread" | "relatedMessage" | "relatedChannel">, contextId?: string, options?: WebhookOptions): Promise<ModalResponse | undefined>;
    /**
     * Process an incoming reaction event from an adapter.
     * Handles waitUntil registration and error catching internally.
     *
     * @param event - The reaction event (without adapter field, will be added)
     * @param options - Webhook options including waitUntil
     */
    processReaction(event: Omit<ReactionEvent, "adapter" | "thread"> & {
        adapter?: Adapter;
    }, options?: WebhookOptions): void;
    /**
     * Process an incoming slash command from an adapter.
     * Handles waitUntil registration and error catching internally.
     *
     * @param event - The slash command event
     * @param options - Webhook options including waitUntil
     */
    processSlashCommand(event: Omit<SlashCommandEvent, "channel" | "openModal"> & {
        adapter: Adapter;
        channelId: string;
    }, options?: WebhookOptions): void;
}
interface StateAdapter {
    /** Acquire a lock on a thread (returns null if already locked) */
    acquireLock(threadId: string, ttlMs: number): Promise<Lock | null>;
    /** Atomically append a value to a list. Trims to maxLength (keeping newest). Refreshes TTL. */
    appendToList(key: string, value: unknown, options?: {
        maxLength?: number;
        ttlMs?: number;
    }): Promise<void>;
    /** Connect to the state backend */
    connect(): Promise<void>;
    /** Delete a cached value */
    delete(key: string): Promise<void>;
    /** Disconnect from the state backend */
    disconnect(): Promise<void>;
    /** Extend a lock's TTL */
    extendLock(lock: Lock, ttlMs: number): Promise<boolean>;
    /**
     * Force-release a lock on a thread, regardless of ownership token.
     * The previous lock holder's handler continues running — only the lock is released.
     * The old handler's `releaseLock()` becomes a no-op (token mismatch).
     */
    forceReleaseLock(threadId: string): Promise<void>;
    /** Get a cached value by key */
    get<T = unknown>(key: string): Promise<T | null>;
    /** Read all values from a list in insertion order. Returns empty array if key does not exist. */
    getList<T = unknown>(key: string): Promise<T[]>;
    /** Check if subscribed to a thread */
    isSubscribed(threadId: string): Promise<boolean>;
    /** Release a lock */
    releaseLock(lock: Lock): Promise<void>;
    /** Set a cached value with optional TTL in milliseconds */
    set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void>;
    /** Atomically set a value only if the key does not already exist. Returns true if set, false if key existed. */
    setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean>;
    /** Subscribe to a thread (persists across restarts) */
    subscribe(threadId: string): Promise<void>;
    /** Unsubscribe from a thread */
    unsubscribe(threadId: string): Promise<void>;
}
interface Lock {
    expiresAt: number;
    threadId: string;
    token: string;
}
/**
 * Base interface for entities that can receive messages.
 * Both Thread and Channel extend this interface.
 *
 * @template TState - Custom state type stored per entity
 * @template TRawMessage - Platform-specific raw message type
 */
interface Postable<TState = Record<string, unknown>, TRawMessage = unknown> {
    /** The adapter this entity belongs to */
    readonly adapter: Adapter;
    /** Unique ID */
    readonly id: string;
    /** Whether this is a direct message conversation */
    readonly isDM: boolean;
    /**
     * Get a platform-specific mention string for a user.
     */
    mentionUser(userId: string): string;
    /**
     * Iterate messages newest first (backward from most recent).
     * Auto-paginates lazily — only fetches pages as consumed.
     */
    readonly messages: AsyncIterable<Message<TRawMessage>>;
    /**
     * Post a message.
     */
    post(message: string | PostableMessage | ChatElement): Promise<SentMessage<TRawMessage>>;
    /**
     * Post an ephemeral message visible only to a specific user.
     */
    postEphemeral(user: string | Author, message: AdapterPostableMessage | ChatElement, options: PostEphemeralOptions): Promise<EphemeralMessage<TRawMessage> | null>;
    /**
     * Schedule a message for future delivery.
     *
     * Currently only supported by the Slack adapter. Other adapters
     * will throw NotImplementedError.
     *
     * @param message - The message content (streaming not supported)
     * @param options - Scheduling options including the target delivery time
     * @returns A ScheduledMessage with cancel() capability
     *
     * @example
     * ```typescript
     * const scheduled = await thread.schedule("Reminder: standup!", {
     *   postAt: new Date("2026-03-09T09:00:00Z"),
     * });
     *
     * // Cancel before it's sent
     * await scheduled.cancel();
     * ```
     */
    schedule(message: AdapterPostableMessage | ChatElement, options: {
        postAt: Date;
    }): Promise<ScheduledMessage<TRawMessage>>;
    /**
     * Set the state. Merges with existing state by default.
     */
    setState(state: Partial<TState>, options?: {
        replace?: boolean;
    }): Promise<void>;
    /** Show typing indicator */
    startTyping(status?: string): Promise<void>;
    /**
     * Get the current state.
     * Returns null if no state has been set.
     */
    readonly state: Promise<TState | null>;
}
/**
 * Represents a channel/conversation container that holds threads.
 * Extends Postable for message posting capabilities.
 *
 * @template TState - Custom state type stored per channel
 * @template TRawMessage - Platform-specific raw message type
 */
interface Channel<TState = Record<string, unknown>, TRawMessage = unknown> extends Postable<TState, TRawMessage> {
    /** Fetch channel metadata from the platform */
    fetchMetadata(): Promise<ChannelInfo>;
    /** Channel name (e.g., "#general"). Null until fetchInfo() is called. */
    readonly name: string | null;
    /**
     * Iterate threads in this channel, most recently active first.
     * Returns ThreadSummary (lightweight) for efficiency.
     * Empty iterable on threadless platforms.
     */
    threads(): AsyncIterable<ThreadSummary<TRawMessage>>;
}
/**
 * Lightweight summary of a thread within a channel.
 */
interface ThreadSummary<TRawMessage = unknown> {
    /** Full thread ID */
    id: string;
    /** Timestamp of most recent reply */
    lastReplyAt?: Date;
    /** Reply count (if available) */
    replyCount?: number;
    /** Root/first message of the thread */
    rootMessage: Message<TRawMessage>;
}
/**
 * Channel metadata returned by fetchInfo().
 */
interface ChannelInfo {
    id: string;
    isDM?: boolean;
    memberCount?: number;
    metadata: Record<string, unknown>;
    name?: string;
}
/**
 * Options for listing threads in a channel.
 */
interface ListThreadsOptions {
    cursor?: string;
    limit?: number;
}
/**
 * Result of listing threads in a channel.
 */
interface ListThreadsResult<TRawMessage = unknown> {
    nextCursor?: string;
    threads: ThreadSummary<TRawMessage>[];
}
/** Default TTL for thread state (30 days in milliseconds) */
declare const THREAD_STATE_TTL_MS: number;
/**
 * Thread interface with support for custom state.
 * Extends Postable for shared message posting capabilities.
 *
 * @template TState - Custom state type stored per-thread (default: Record<string, unknown>)
 * @template TRawMessage - Platform-specific raw message type
 */
interface Thread<TState = Record<string, unknown>, TRawMessage = unknown> extends Postable<TState, TRawMessage> {
    /**
     * Async iterator for all messages in the thread.
     * Messages are yielded in chronological order (oldest first).
     * Automatically handles pagination.
     */
    allMessages: AsyncIterable<Message<TRawMessage>>;
    /** Get the Channel containing this thread */
    readonly channel: Channel<TState, TRawMessage>;
    /** Channel/conversation ID */
    readonly channelId: string;
    /**
     * Wrap a Message object as a SentMessage with edit/delete capabilities.
     * Used internally for reconstructing messages from serialized data.
     */
    createSentMessageFromMessage(message: Message<TRawMessage>): SentMessage<TRawMessage>;
    /**
     * Check if this thread is currently subscribed.
     *
     * In subscribed message handlers, this is optimized to return true immediately
     * without a state lookup, since we already know we're in a subscribed context.
     *
     * @returns Promise resolving to true if subscribed, false otherwise
     */
    isSubscribed(): Promise<boolean>;
    /**
     * Get a platform-specific mention string for a user.
     * Use this to @-mention a user in a message.
     * @example
     * await thread.post(`Hey ${thread.mentionUser(userId)}, check this out!`);
     */
    mentionUser(userId: string): string;
    /**
     * Post a message to this thread.
     *
     * Supports text, markdown, cards, and streaming from async iterables.
     * When posting a stream (e.g., from AI SDK), uses platform-native streaming
     * APIs when available (Slack), or falls back to post + edit with throttling.
     *
     * @param message - String, PostableMessage, JSX Card, or AsyncIterable<string>
     * @returns A SentMessage with methods to edit, delete, or add reactions
     *
     * @example
     * ```typescript
     * // Simple string
     * await thread.post("Hello!");
     *
     * // Markdown
     * await thread.post({ markdown: "**Bold** and _italic_" });
     *
     * // With emoji
     * await thread.post(`${emoji.thumbs_up} Great job!`);
     *
     * // JSX Card (with @jsxImportSource chat)
     * await thread.post(
     *   <Card title="Welcome!">
     *     <Text>Hello world</Text>
     *   </Card>
     * );
     *
     * // Stream from AI SDK
     * const result = await agent.stream({ prompt: message.text });
     * await thread.post(result.textStream);
     * ```
     */
    post(message: string | PostableMessage | ChatElement): Promise<SentMessage<TRawMessage>>;
    /**
     * Post an ephemeral message visible only to a specific user.
     *
     * **Platform Behavior:**
     * - **Slack**: Native ephemeral (session-dependent, disappears on reload)
     * - **Google Chat**: Native private message (persists, only target user sees it)
     * - **Discord**: No native support - requires fallbackToDM: true
     * - **Teams**: No native support - requires fallbackToDM: true
     *
     * @param user - User ID string or Author object (from message.author or event.user)
     * @param message - Message content (string, markdown, card, etc.). Streaming is not supported.
     * @param options.fallbackToDM - Required. If true, falls back to DM when native
     *   ephemeral is not supported. If false, returns null when unsupported.
     * @returns EphemeralMessage with `usedFallback: true` if DM was used, or null
     *   if native ephemeral not supported and fallbackToDM is false
     *
     * @example
     * ```typescript
     * // Always send (DM fallback on Discord/Teams)
     * await thread.postEphemeral(user, 'Only you can see this!', { fallbackToDM: true })
     *
     * // Only send if native ephemeral supported (Slack/GChat)
     * const result = await thread.postEphemeral(user, 'Secret!', { fallbackToDM: false })
     * if (!result) {
     *   // Platform doesn't support native ephemeral - handle accordingly
     * }
     * ```
     */
    postEphemeral(user: string | Author, message: AdapterPostableMessage | ChatElement, options: PostEphemeralOptions): Promise<EphemeralMessage<TRawMessage> | null>;
    /** Recently fetched messages (cached) */
    recentMessages: Message<TRawMessage>[];
    /**
     * Refresh `recentMessages` from the API.
     *
     * Fetches the latest 50 messages and updates `recentMessages`.
     */
    refresh(): Promise<void>;
    /**
     * Show typing indicator in the thread.
     *
     * Some platforms support persistent typing indicators, others just send once.
     * Optional status (e.g. "Typing...", "Searching documents...") is shown where supported.
     */
    startTyping(status?: string): Promise<void>;
    /**
     * Subscribe to future messages in this thread.
     *
     * Once subscribed, all messages in this thread will trigger `onSubscribedMessage` handlers.
     * The initial message that triggered subscription will NOT fire the handler.
     *
     * @example
     * ```typescript
     * chat.onNewMention(async (thread, message) => {
     *   await thread.subscribe();  // Subscribe to follow-up messages
     *   await thread.post("I'm now watching this thread!");
     * });
     * ```
     */
    subscribe(): Promise<void>;
    /**
     * Unsubscribe from this thread.
     *
     * Future messages will no longer trigger `onSubscribedMessage` handlers.
     */
    unsubscribe(): Promise<void>;
}
interface ThreadInfo {
    channelId: string;
    channelName?: string;
    id: string;
    /** Whether this is a direct message conversation */
    isDM?: boolean;
    /** Platform-specific metadata */
    metadata: Record<string, unknown>;
}
/**
 * Direction for fetching messages.
 *
 * - `backward`: Fetch most recent messages first. Pagination moves toward older messages.
 *   This is the default, suitable for loading a chat view (show latest messages first).
 *
 * - `forward`: Fetch oldest messages first. Pagination moves toward newer messages.
 *   Suitable for iterating through message history from the beginning.
 *
 * In both directions, messages within each page are returned in chronological order
 * (oldest first), which is the natural reading order for chat messages.
 *
 * @example
 * ```typescript
 * // Load most recent 50 messages (default)
 * const recent = await adapter.fetchMessages(threadId, { limit: 50 });
 * // recent.messages: [older, ..., newest] (chronological within page)
 * // recent.nextCursor: points to older messages
 *
 * // Iterate through all history from beginning
 * const history = await adapter.fetchMessages(threadId, {
 *   limit: 50,
 *   direction: 'forward',
 * });
 * // history.messages: [oldest, ..., newer] (chronological within page)
 * // history.nextCursor: points to even newer messages
 * ```
 */
type FetchDirection = "forward" | "backward";
/**
 * Options for fetching messages from a thread.
 */
interface FetchOptions {
    /**
     * Pagination cursor for fetching the next page of messages.
     * Pass the `nextCursor` from a previous `FetchResult`.
     */
    cursor?: string;
    /**
     * Direction to fetch messages.
     *
     * - `backward` (default): Fetch most recent messages. Cursor moves to older messages.
     * - `forward`: Fetch oldest messages. Cursor moves to newer messages.
     *
     * Messages within each page are always returned in chronological order (oldest first).
     */
    direction?: FetchDirection;
    /** Maximum number of messages to fetch. Default varies by adapter (50-100). */
    limit?: number;
}
/**
 * Result of fetching messages from a thread.
 */
interface FetchResult<TRawMessage = unknown> {
    /**
     * Messages in chronological order (oldest first within this page).
     *
     * For `direction: 'backward'` (default): These are the N most recent messages.
     * For `direction: 'forward'`: These are the N oldest messages (or next N after cursor).
     */
    messages: Message<TRawMessage>[];
    /**
     * Cursor for fetching the next page.
     * Pass this as `cursor` in the next `fetchMessages` call.
     *
     * - For `direction: 'backward'`: Points to older messages.
     * - For `direction: 'forward'`: Points to newer messages.
     *
     * Undefined if there are no more messages in that direction.
     */
    nextCursor?: string;
}
/**
 * Formatted content using mdast AST.
 * This is the canonical representation of message formatting.
 */
type FormattedContent = Root;
/** Raw message returned from adapter (before wrapping as SentMessage) */
interface RawMessage<TRawMessage = unknown> {
    id: string;
    raw: TRawMessage;
    threadId: string;
}
interface Author {
    /** Display name */
    fullName: string;
    /** Whether the author is a bot */
    isBot: boolean | "unknown";
    /** Whether the author is this bot */
    isMe: boolean;
    /** Unique user ID */
    userId: string;
    /** Username/handle for @-mentions */
    userName: string;
}
interface MessageMetadata {
    /** When the message was sent */
    dateSent: Date;
    /** Whether the message has been edited */
    edited: boolean;
    /** When the message was last edited */
    editedAt?: Date;
}
interface SentMessage<TRawMessage = unknown> extends Message<TRawMessage> {
    /** Add a reaction to this message */
    addReaction(emoji: EmojiValue | string): Promise<void>;
    /** Delete this message */
    delete(): Promise<void>;
    /** Edit this message with text, a PostableMessage, or a JSX Card element */
    edit(newContent: string | PostableMessage | ChatElement): Promise<SentMessage<TRawMessage>>;
    /** Remove a reaction from this message */
    removeReaction(emoji: EmojiValue | string): Promise<void>;
}
/**
 * Result of posting an ephemeral message.
 *
 * Ephemeral messages are visible only to a specific user and typically
 * cannot be edited or deleted (platform-dependent).
 */
interface EphemeralMessage<TRawMessage = unknown> {
    /** Message ID (may be empty for some platforms) */
    id: string;
    /** Platform-specific raw response */
    raw: TRawMessage;
    /** Thread ID where message was sent (or DM thread if fallback was used) */
    threadId: string;
    /** Whether this used native ephemeral or fell back to DM */
    usedFallback: boolean;
}
/**
 * Options for posting ephemeral messages.
 */
interface PostEphemeralOptions {
    /**
     * Controls behavior when native ephemeral is not supported by the platform.
     *
     * - `true`: Falls back to sending a DM to the user
     * - `false`: Returns `null` if native ephemeral is not supported
     */
    fallbackToDM: boolean;
}
/**
 * Result of scheduling a message for future delivery.
 *
 * Currently only supported by the Slack adapter via `chat.scheduleMessage`.
 * Other adapters will throw `NotImplementedError` when `schedule()` is called.
 */
interface ScheduledMessage<TRawMessage = unknown> {
    /** Cancel the scheduled message before it's sent */
    cancel(): Promise<void>;
    /** Channel ID where the message will be posted */
    channelId: string;
    /** When the message will be sent */
    postAt: Date;
    /** Platform-specific raw response */
    raw: TRawMessage;
    /** Platform-specific scheduled message ID */
    scheduledMessageId: string;
}
/**
 * Input type for adapter postMessage/editMessage methods.
 * This excludes streams since adapters handle content synchronously.
 */
type AdapterPostableMessage = string | PostableRaw | PostableMarkdown | PostableAst | PostableCard | CardElement;
/**
 * A message that can be posted to a thread.
 *
 * - `string` - Raw text, passed through as-is to the platform
 * - `{ raw: string }` - Explicit raw text, passed through as-is
 * - `{ markdown: string }` - Markdown text, converted to platform format
 * - `{ ast: Root }` - mdast AST, converted to platform format
 * - `{ card: CardElement }` - Rich card with buttons (Block Kit / Adaptive Cards / GChat Cards)
 * - `CardElement` - Direct card element
 * - `AsyncIterable<string>` - Streaming text (e.g., from AI SDK's textStream)
 * - `AsyncIterable<string | StreamEvent>` - AI SDK fullStream (auto-detected, extracts text with step separators)
 */
type PostableMessage = AdapterPostableMessage | AsyncIterable<string | StreamChunk | StreamEvent>;
/**
 * Duck-typed stream event compatible with AI SDK's `fullStream`.
 * - `text-delta` events are extracted as text output.
 * - `step-finish` events trigger paragraph separators between steps.
 * - All other event types (tool-call, tool-result, etc.) are silently skipped.
 */
type StreamEvent = {
    textDelta: string;
    type: "text-delta";
} | {
    type: "step-finish";
} | {
    type: string;
};
interface PostableRaw {
    /** File/image attachments */
    attachments?: Attachment[];
    /** Files to upload */
    files?: FileUpload[];
    /** Raw text passed through as-is to the platform */
    raw: string;
}
interface PostableMarkdown {
    /** File/image attachments */
    attachments?: Attachment[];
    /** Files to upload */
    files?: FileUpload[];
    /** Markdown text, converted to platform format */
    markdown: string;
}
interface PostableAst {
    /** mdast AST, converted to platform format */
    ast: Root;
    /** File/image attachments */
    attachments?: Attachment[];
    /** Files to upload */
    files?: FileUpload[];
}
interface PostableCard {
    /** Rich card element */
    card: CardElement;
    /** Fallback text for platforms/clients that can't render cards */
    fallbackText?: string;
    /** Files to upload */
    files?: FileUpload[];
}
interface Attachment {
    /** Binary data (for uploading or if already fetched) */
    data?: Buffer | Blob;
    /**
     * Fetch the attachment data.
     * For platforms that require authentication (like Slack private URLs),
     * this method handles the auth automatically.
     */
    fetchData?: () => Promise<Buffer>;
    /** Image/video height (if applicable) */
    height?: number;
    /** MIME type */
    mimeType?: string;
    /** Filename */
    name?: string;
    /** File size in bytes */
    size?: number;
    /** Type of attachment */
    type: "image" | "file" | "video" | "audio";
    /** URL to the file (for linking/downloading) */
    url?: string;
    /** Image/video width (if applicable) */
    width?: number;
}
/**
 * A link found in a message, with optional unfurl metadata.
 *
 * On the initial message event, only `url` is available (unfurl metadata
 * arrives later via `message_changed`). The `fetchMessage` callback is
 * provided when the URL points to another chat message on the same platform.
 */
interface LinkPreview {
    /** Description from unfurl metadata (if available) */
    description?: string;
    /** If this links to a chat message, fetch the full Message */
    fetchMessage?: () => Promise<Message>;
    /** Preview image URL (if available) */
    imageUrl?: string;
    /** Site name (e.g., "Vercel") */
    siteName?: string;
    /** Title from unfurl metadata (if available) */
    title?: string;
    /** The URL */
    url: string;
}
/**
 * File to upload with a message.
 */
interface FileUpload {
    /** Binary data */
    data: Buffer | Blob | ArrayBuffer;
    /** Filename */
    filename: string;
    /** MIME type (optional, will be inferred from filename if not provided) */
    mimeType?: string;
}
/**
 * Handler for new @-mentions of the bot.
 *
 * **Important**: This handler is ONLY called for mentions in **unsubscribed** threads.
 * Once a thread is subscribed (via `thread.subscribe()`), subsequent messages
 * including @-mentions go to `onSubscribedMessage` handlers instead.
 *
 * To detect mentions in subscribed threads, check `message.isMention`:
 *
 * @example
 * ```typescript
 * // Handle new mentions (unsubscribed threads only)
 * chat.onNewMention(async (thread, message) => {
 *   await thread.subscribe();  // Subscribe to follow-up messages
 *   await thread.post("Hello! I'll be watching this thread.");
 * });
 *
 * // Handle all messages in subscribed threads
 * chat.onSubscribedMessage(async (thread, message) => {
 *   if (message.isMention) {
 *     // User @-mentioned us in a thread we're already watching
 *     await thread.post("You mentioned me again!");
 *   }
 * });
 * ```
 */
type MentionHandler<TState = Record<string, unknown>> = (thread: Thread<TState>, message: Message) => void | Promise<void>;
/**
 * Handler for direct messages (1:1 conversations with the bot).
 *
 * Registered via `chat.onDirectMessage(handler)`. Called when a message
 * is received in a DM thread that is not subscribed. If no `onDirectMessage`
 * handlers are registered, DMs fall through to `onNewMention` for backward
 * compatibility.
 */
type DirectMessageHandler<TState = Record<string, unknown>> = (thread: Thread<TState>, message: Message, channel: Channel<TState>) => void | Promise<void>;
/**
 * Handler for messages matching a regex pattern.
 *
 * Registered via `chat.onNewMessage(pattern, handler)`. Called when a message
 * matches the pattern in an unsubscribed thread.
 */
type MessageHandler<TState = Record<string, unknown>> = (thread: Thread<TState>, message: Message) => void | Promise<void>;
/**
 * Handler for messages in subscribed threads.
 *
 * Called for all messages in threads that have been subscribed via `thread.subscribe()`.
 * This includes:
 * - Follow-up messages from users
 * - Messages that @-mention the bot (check `message.isMention`)
 *
 * Does NOT fire for:
 * - The message that triggered the subscription (e.g., the initial @mention)
 * - Messages sent by the bot itself
 *
 * @example
 * ```typescript
 * chat.onSubscribedMessage(async (thread, message) => {
 *   // Handle all follow-up messages
 *   if (message.isMention) {
 *     // User @-mentioned us in a subscribed thread
 *   }
 *   await thread.post(`Got your message: ${message.text}`);
 * });
 * ```
 */
type SubscribedMessageHandler<TState = Record<string, unknown>> = (thread: Thread<TState>, message: Message) => void | Promise<void>;
/**
 * Well-known emoji that work across platforms (Slack and Google Chat).
 * These are normalized to a common format regardless of platform.
 */
type WellKnownEmoji = "thumbs_up" | "thumbs_down" | "clap" | "wave" | "pray" | "muscle" | "ok_hand" | "point_up" | "point_down" | "point_left" | "point_right" | "raised_hands" | "shrug" | "facepalm" | "heart" | "smile" | "laugh" | "thinking" | "sad" | "cry" | "angry" | "love_eyes" | "cool" | "wink" | "surprised" | "worried" | "confused" | "neutral" | "sleeping" | "sick" | "mind_blown" | "relieved" | "grimace" | "rolling_eyes" | "hug" | "zany" | "check" | "x" | "question" | "exclamation" | "warning" | "stop" | "info" | "100" | "fire" | "star" | "sparkles" | "lightning" | "boom" | "eyes" | "green_circle" | "yellow_circle" | "red_circle" | "blue_circle" | "white_circle" | "black_circle" | "rocket" | "party" | "confetti" | "balloon" | "gift" | "trophy" | "medal" | "lightbulb" | "gear" | "wrench" | "hammer" | "bug" | "link" | "lock" | "unlock" | "key" | "pin" | "memo" | "clipboard" | "calendar" | "clock" | "hourglass" | "bell" | "megaphone" | "speech_bubble" | "email" | "inbox" | "outbox" | "package" | "folder" | "file" | "chart_up" | "chart_down" | "coffee" | "pizza" | "beer" | "arrow_up" | "arrow_down" | "arrow_left" | "arrow_right" | "refresh" | "sun" | "cloud" | "rain" | "snow" | "rainbow";
/**
 * Platform-specific emoji formats for a single emoji.
 */
interface EmojiFormats {
    /** Google Chat unicode emoji, e.g., "👍", "❤️" */
    gchat: string | string[];
    /** Slack emoji name (without colons), e.g., "+1", "heart" */
    slack: string | string[];
}
/**
 * Emoji map type - can be extended by users to add custom emoji.
 *
 * @example
 * ```typescript
 * // Extend with custom emoji
 * declare module "chat" {
 *   interface CustomEmojiMap {
 *     "custom_emoji": EmojiFormats;
 *   }
 * }
 *
 * const myEmojiMap: EmojiMapConfig = {
 *   custom_emoji: { slack: "custom", gchat: "🎯" },
 * };
 * ```
 */
interface CustomEmojiMap {
}
/**
 * Full emoji type including well-known and custom emoji.
 */
type Emoji = WellKnownEmoji | keyof CustomEmojiMap;
/**
 * Configuration for emoji mapping.
 */
type EmojiMapConfig = Partial<Record<Emoji, EmojiFormats>>;
/**
 * Immutable emoji value object with object identity.
 *
 * These objects are singletons - the same emoji name always returns
 * the same frozen object instance, enabling `===` comparison.
 *
 * @example
 * ```typescript
 * // Object identity comparison works
 * if (event.emoji === emoji.thumbs_up) {
 *   console.log("User gave a thumbs up!");
 * }
 *
 * // Works in template strings via toString()
 * await thread.post(`${emoji.thumbs_up} Great job!`);
 * ```
 */
interface EmojiValue {
    /** The normalized emoji name (e.g., "thumbs_up") */
    readonly name: string;
    /** Returns the placeholder string (for JSON.stringify) */
    toJSON(): string;
    /** Returns the placeholder string for message formatting */
    toString(): string;
}
/**
 * Reaction event fired when a user adds or removes a reaction.
 */
interface ReactionEvent<TRawMessage = unknown> {
    /** The adapter that received the event */
    adapter: Adapter;
    /** Whether the reaction was added (true) or removed (false) */
    added: boolean;
    /** The normalized emoji as an EmojiValue singleton (enables `===` comparison) */
    emoji: EmojiValue;
    /** The message that was reacted to (if available) */
    message?: Message<TRawMessage>;
    /** The message ID that was reacted to */
    messageId: string;
    /** Platform-specific raw event data */
    raw: unknown;
    /** The raw platform-specific emoji (e.g., "+1" for Slack, "👍" for GChat) */
    rawEmoji: string;
    /**
     * The thread where the reaction occurred.
     * Use this to post replies or check subscription status.
     *
     * @example
     * ```typescript
     * chat.onReaction([emoji.thumbs_up], async (event) => {
     *   await event.thread.post(`Thanks for the ${event.emoji}!`);
     * });
     * ```
     */
    thread: Thread<TRawMessage>;
    /** The thread ID */
    threadId: string;
    /** The user who added/removed the reaction */
    user: Author;
}
/**
 * Handler for reaction events.
 *
 * @example
 * ```typescript
 * // Handle specific emoji
 * chat.onReaction(["thumbs_up", "heart"], async (event) => {
 *   console.log(`${event.user.userName} ${event.added ? "added" : "removed"} ${event.emoji}`);
 * });
 *
 * // Handle all reactions
 * chat.onReaction(async (event) => {
 *   // ...
 * });
 * ```
 */
type ReactionHandler = (event: ReactionEvent) => void | Promise<void>;
/**
 * Action event fired when a user clicks a button in a card.
 *
 * @example
 * ```typescript
 * chat.onAction("approve", async (event) => {
 *   await event.thread.post(`Order ${event.value} approved by ${event.user.userName}`);
 * });
 * ```
 */
interface ActionEvent<TRawMessage = unknown> {
    /** The action ID from the button (matches Button's `id` prop) */
    actionId: string;
    /** The adapter that received the event */
    adapter: Adapter;
    /** The message ID containing the card */
    messageId: string;
    /**
     * Open a modal/dialog form in response to this action.
     *
     * @param modal - The modal element to display (JSX or ModalElement)
     * @returns The view/dialog ID, or undefined if modals are not supported
     */
    openModal(modal: ModalElement | ChatElement): Promise<{
        viewId: string;
    } | undefined>;
    /** Platform-specific raw event data */
    raw: unknown;
    /** The thread where the action occurred (null for view-based actions like home tab buttons) */
    thread: Thread<TRawMessage> | null;
    /** The thread ID */
    threadId: string;
    /** Trigger ID for opening modals (required by some platforms, may expire quickly) */
    triggerId?: string;
    /** User who clicked the button */
    user: Author;
    /** Optional value/payload from the button */
    value?: string;
}
/**
 * Handler for action events (button clicks in cards).
 *
 * @example
 * ```typescript
 * // Handle specific action
 * chat.onAction("approve", async (event) => {
 *   await event.thread.post("Approved!");
 * });
 *
 * // Handle multiple actions
 * chat.onAction(["approve", "reject"], async (event) => {
 *   if (event.actionId === "approve") {
 *     // ...
 *   }
 * });
 *
 * // Handle all actions (catch-all)
 * chat.onAction(async (event) => {
 *   console.log(`Action: ${event.actionId}`);
 * });
 * ```
 */
type ActionHandler = (event: ActionEvent) => void | Promise<void>;
/**
 * Event emitted when a user submits a modal form.
 */
interface ModalSubmitEvent<TRawMessage = unknown> {
    /** The adapter that received this event */
    adapter: Adapter;
    /** The callback ID specified when creating the modal */
    callbackId: string;
    /**
     * The private metadata string set when the modal was created.
     * Use this to pass arbitrary context (e.g., JSON) through the modal lifecycle.
     */
    privateMetadata?: string;
    /** Raw platform-specific payload */
    raw: unknown;
    /**
     * The channel where the modal was originally triggered from.
     * Available when the modal was opened via SlashCommandEvent.openModal().
     */
    relatedChannel?: Channel<Record<string, unknown>, TRawMessage>;
    /**
     * The message that contained the action which opened the modal.
     * Available when the modal was opened from a message action via ActionEvent.openModal().
     * This is a SentMessage with edit/delete capabilities.
     */
    relatedMessage?: SentMessage<TRawMessage>;
    /**
     * The thread where the modal was originally triggered from.
     * Available when the modal was opened via ActionEvent.openModal().
     */
    relatedThread?: Thread<Record<string, unknown>, TRawMessage>;
    /** The user who submitted the modal */
    user: Author;
    /** Form field values keyed by input ID */
    values: Record<string, string>;
    /** Platform-specific view/dialog ID */
    viewId: string;
}
/**
 * Event emitted when a user closes/cancels a modal (requires notifyOnClose).
 */
interface ModalCloseEvent<TRawMessage = unknown> {
    /** The adapter that received this event */
    adapter: Adapter;
    /** The callback ID specified when creating the modal */
    callbackId: string;
    /**
     * The private metadata string set when the modal was created.
     * Use this to pass arbitrary context (e.g., JSON) through the modal lifecycle.
     */
    privateMetadata?: string;
    /** Raw platform-specific payload */
    raw: unknown;
    /**
     * The channel where the modal was originally triggered from.
     * Available when the modal was opened via SlashCommandEvent.openModal().
     */
    relatedChannel?: Channel<Record<string, unknown>, TRawMessage>;
    /**
     * The message that contained the action which opened the modal.
     * Available when the modal was opened from a message action via ActionEvent.openModal().
     * This is a SentMessage with edit/delete capabilities.
     */
    relatedMessage?: SentMessage<TRawMessage>;
    /**
     * The thread where the modal was originally triggered from.
     * Available when the modal was opened via ActionEvent.openModal().
     */
    relatedThread?: Thread<Record<string, unknown>, TRawMessage>;
    /** The user who closed the modal */
    user: Author;
    /** Platform-specific view/dialog ID */
    viewId: string;
}
interface ModalErrorsResponse {
    action: "errors";
    errors: Record<string, string>;
}
interface ModalUpdateResponse {
    action: "update";
    modal: ModalElement;
}
interface ModalPushResponse {
    action: "push";
    modal: ModalElement;
}
interface ModalCloseResponse {
    action: "close";
}
type ModalResponse = ModalCloseResponse | ModalErrorsResponse | ModalUpdateResponse | ModalPushResponse;
type ModalSubmitHandler = (event: ModalSubmitEvent) => void | Promise<ModalResponse | undefined>;
type ModalCloseHandler = (event: ModalCloseEvent) => void | Promise<void>;
/**
 * Event emitted when a user invokes a slash command.
 *
 * Slash commands are triggered when a user types `/command` in the message composer.
 * The event provides access to the channel where the command was invoked, allowing
 * you to post responses using standard SDK methods.
 *
 * @example
 * ```typescript
 * chat.onSlashCommand("/help", async (event) => {
 *   // Post visible to everyone in the channel
 *   await event.channel.post("Here are the available commands...");
 * });
 *
 * chat.onSlashCommand("/secret", async (event) => {
 *   // Post ephemeral (only the invoking user sees it)
 *   await event.channel.postEphemeral(
 *     event.user,
 *     "This is just for you!",
 *     { fallbackToDM: false }
 *   );
 * });
 *
 * chat.onSlashCommand("/feedback", async (event) => {
 *   // Open a modal
 *   await event.openModal({
 *     type: "modal",
 *     callbackId: "feedback_modal",
 *     title: "Submit Feedback",
 *     children: [{ type: "text_input", id: "feedback", label: "Your feedback" }],
 *   });
 * });
 * ```
 */
interface SlashCommandEvent<TState = Record<string, unknown>> {
    /** The adapter that received this event */
    adapter: Adapter;
    /** The channel where the command was invoked */
    channel: Channel<TState>;
    /** The slash command name (e.g., "/help") */
    command: string;
    /**
     * Open a modal/dialog form in response to this slash command.
     *
     * @param modal - The modal element to display (JSX or ModalElement)
     * @returns The view/dialog ID, or undefined if modals are not supported
     */
    openModal(modal: ModalElement | ChatElement): Promise<{
        viewId: string;
    } | undefined>;
    /** Platform-specific raw payload */
    raw: unknown;
    /** Arguments text after the command (e.g., "topic search" from "/help topic search") */
    text: string;
    /** Trigger ID for opening modals (time-limited, typically ~3 seconds) */
    triggerId?: string;
    /** The user who invoked the command */
    user: Author;
}
/**
 * Handler for slash command events.
 *
 * @example
 * ```typescript
 * // Handle a specific command
 * chat.onSlashCommand("/status", async (event) => {
 *   await event.channel.post("All systems operational!");
 * });
 *
 * // Handle multiple commands
 * chat.onSlashCommand(["/help", "/info"], async (event) => {
 *   await event.channel.post(`You invoked ${event.command}`);
 * });
 *
 * // Catch-all handler
 * chat.onSlashCommand(async (event) => {
 *   console.log(`Command: ${event.command}, Args: ${event.text}`);
 * });
 * ```
 */
type SlashCommandHandler<TState = Record<string, unknown>> = (event: SlashCommandEvent<TState>) => void | Promise<void>;
interface AssistantThreadStartedEvent {
    adapter: Adapter;
    channelId: string;
    context: {
        channelId?: string;
        teamId?: string;
        enterpriseId?: string;
        threadEntryPoint?: string;
        forceSearch?: boolean;
    };
    threadId: string;
    threadTs: string;
    userId: string;
}
type AssistantThreadStartedHandler = (event: AssistantThreadStartedEvent) => void | Promise<void>;
interface AssistantContextChangedEvent {
    adapter: Adapter;
    channelId: string;
    context: {
        channelId?: string;
        teamId?: string;
        enterpriseId?: string;
        threadEntryPoint?: string;
        forceSearch?: boolean;
    };
    threadId: string;
    threadTs: string;
    userId: string;
}
type AssistantContextChangedHandler = (event: AssistantContextChangedEvent) => void | Promise<void>;
interface AppHomeOpenedEvent {
    adapter: Adapter;
    channelId: string;
    userId: string;
}
type AppHomeOpenedHandler = (event: AppHomeOpenedEvent) => void | Promise<void>;
interface MemberJoinedChannelEvent {
    adapter: Adapter;
    channelId: string;
    inviterId?: string;
    userId: string;
}
type MemberJoinedChannelHandler = (event: MemberJoinedChannelEvent) => void | Promise<void>;

/**
 * Message class with serialization support for workflow engines.
 */

/**
 * Input data for creating a Message instance.
 * Use this interface when constructing Message objects.
 */
interface MessageData<TRawMessage = unknown> {
    /** Attachments */
    attachments: Attachment[];
    /** Message author */
    author: Author;
    /** Structured formatting as an AST (mdast Root) */
    formatted: FormattedContent;
    /** Unique message ID */
    id: string;
    /** Whether the bot is @-mentioned in this message */
    isMention?: boolean;
    /** Links found in the message */
    links?: LinkPreview[];
    /** Message metadata */
    metadata: MessageMetadata;
    /** Platform-specific raw payload (escape hatch) */
    raw: TRawMessage;
    /** Plain text content (all formatting stripped) */
    text: string;
    /** Thread this message belongs to */
    threadId: string;
}
/**
 * Serialized message data for passing to external systems (e.g., workflow engines).
 * Dates are converted to ISO strings, and non-serializable fields are omitted.
 */
interface SerializedMessage {
    _type: "chat:Message";
    attachments: Array<{
        type: "image" | "file" | "video" | "audio";
        url?: string;
        name?: string;
        mimeType?: string;
        size?: number;
        width?: number;
        height?: number;
    }>;
    author: {
        userId: string;
        userName: string;
        fullName: string;
        isBot: boolean | "unknown";
        isMe: boolean;
    };
    formatted: Root;
    id: string;
    isMention?: boolean;
    links?: Array<{
        url: string;
        title?: string;
        description?: string;
        imageUrl?: string;
        siteName?: string;
    }>;
    metadata: {
        dateSent: string;
        edited: boolean;
        editedAt?: string;
    };
    raw: unknown;
    text: string;
    threadId: string;
}
/**
 * A chat message with serialization support for workflow engines.
 *
 * @example
 * ```typescript
 * // Create a message
 * const message = new Message({
 *   id: "msg-1",
 *   threadId: "slack:C123:1234.5678",
 *   text: "Hello world",
 *   formatted: parseMarkdown("Hello world"),
 *   raw: {},
 *   author: { userId: "U123", userName: "user", fullName: "User", isBot: false, isMe: false },
 *   metadata: { dateSent: new Date(), edited: false },
 *   attachments: [],
 * });
 *
 * // Serialize for workflow
 * const serialized = message.toJSON();
 * ```
 */
declare class Message<TRawMessage = unknown> {
    /** Unique message ID */
    readonly id: string;
    /** Thread this message belongs to */
    readonly threadId: string;
    /** Plain text content (all formatting stripped) */
    text: string;
    /**
     * Structured formatting as an AST (mdast Root).
     * This is the canonical representation - use this for processing.
     * Use `stringifyMarkdown(message.formatted)` to get markdown string.
     */
    formatted: FormattedContent;
    /** Platform-specific raw payload (escape hatch) */
    raw: TRawMessage;
    /** Message author */
    author: Author;
    /** Message metadata */
    metadata: MessageMetadata;
    /** Attachments */
    attachments: Attachment[];
    /**
     * Whether the bot is @-mentioned in this message.
     *
     * This is set by the Chat SDK before passing the message to handlers.
     * It checks for `@username` in the message text using the adapter's
     * configured `userName` and optional `botUserId`.
     *
     * @example
     * ```typescript
     * chat.onSubscribedMessage(async (thread, message) => {
     *   if (message.isMention) {
     *     await thread.post("You mentioned me!");
     *   }
     * });
     * ```
     */
    isMention?: boolean;
    /** Links found in the message */
    links: LinkPreview[];
    constructor(data: MessageData<TRawMessage>);
    /**
     * Serialize the message to a plain JSON object.
     * Use this to pass message data to external systems like workflow engines.
     *
     * Note: Attachment `data` (Buffer) and `fetchData` (function) are omitted
     * as they're not serializable.
     */
    toJSON(): SerializedMessage;
    /**
     * Reconstruct a Message from serialized JSON data.
     * Converts ISO date strings back to Date objects.
     */
    static fromJSON<TRawMessage = unknown>(json: SerializedMessage): Message<TRawMessage>;
    /**
     * Serialize a Message instance for @workflow/serde.
     * This static method is automatically called by workflow serialization.
     */
    static [WORKFLOW_SERIALIZE](instance: Message): SerializedMessage;
    /**
     * Deserialize a Message from @workflow/serde.
     * This static method is automatically called by workflow deserialization.
     */
    static [WORKFLOW_DESERIALIZE](data: SerializedMessage): Message;
}

/**
 * Content part types structurally identical to AI SDK's TextPart, ImagePart,
 * FilePart so that AiMessage[] is directly assignable to ModelMessage[].
 * @see https://ai-sdk.dev/docs/reference/ai-sdk-core/model-message
 */
/** Matches AI SDK's DataContent */
type DataContent = string | Uint8Array | ArrayBuffer | Buffer;
interface AiTextPart {
    text: string;
    type: "text";
}
interface AiImagePart {
    image: DataContent | URL;
    mediaType?: string;
    type: "image";
}
interface AiFilePart {
    data: DataContent | URL;
    filename?: string;
    mediaType: string;
    type: "file";
}
type AiMessagePart = AiTextPart | AiImagePart | AiFilePart;
/**
 * A message formatted for AI SDK consumption.
 *
 * This is a discriminated union matching AI SDK's ModelMessage type:
 * - User messages can have text, image, and file parts
 * - Assistant messages have string content only
 */
type AiMessage = AiUserMessage | AiAssistantMessage;
interface AiUserMessage {
    content: string | AiMessagePart[];
    role: "user";
}
interface AiAssistantMessage {
    content: string;
    role: "assistant";
}
/**
 * Options for converting messages to AI SDK format.
 */
interface ToAiMessagesOptions {
    /** When true, prefixes user messages with "[username]: " for multi-user context */
    includeNames?: boolean;
    /**
     * Called when an attachment type is not supported (video, audio).
     * Defaults to `console.warn`.
     */
    onUnsupportedAttachment?: (attachment: Attachment, message: Message) => void;
    /**
     * Called for each message after default processing (text, links, attachments).
     * Return the message (modified or as-is) to include it, or `null` to skip it.
     *
     * @param aiMessage - The processed AI message
     * @param source - The original chat Message
     * @returns The message to include, or null to skip
     */
    transformMessage?: (aiMessage: AiMessage, source: Message) => AiMessage | null | Promise<AiMessage | null>;
}
/**
 * Convert chat SDK messages to AI SDK conversation format.
 *
 * - Filters out messages with empty/whitespace-only text
 * - Maps `author.isMe === true` to `"assistant"`, otherwise `"user"`
 * - Uses `message.text` for content
 * - Appends link metadata when available
 * - Includes image attachments and text files as `FilePart`
 * - Uses `fetchData()` when available to include attachment data inline (base64)
 * - Warns on unsupported attachment types (video, audio)
 *
 * Works with `FetchResult.messages`, `thread.recentMessages`, or collected iterables.
 *
 * @example
 * ```typescript
 * const result = await thread.adapter.fetchMessages(thread.id, { limit: 20 });
 * const history = await toAiMessages(result.messages);
 * const response = await agent.stream({ prompt: history });
 * ```
 */
declare function toAiMessages(messages: Message[], options?: ToAiMessagesOptions): Promise<AiMessage[]>;

interface MessageHistoryConfig {
    /** Maximum messages to keep per thread (default: 100) */
    maxMessages?: number;
    /** TTL for cached history in milliseconds (default: 7 days) */
    ttlMs?: number;
}
/**
 * Persistent message history cache backed by the StateAdapter.
 *
 * Used by adapters that lack server-side message history APIs (e.g., WhatsApp, Telegram).
 * Messages are atomically appended via `state.appendToList()`, which is safe
 * without holding a thread lock.
 */
declare class MessageHistoryCache {
    private readonly state;
    private readonly maxMessages;
    private readonly ttlMs;
    constructor(state: StateAdapter, config?: MessageHistoryConfig);
    /**
     * Atomically append a message to the history for a thread.
     * Trims to maxMessages (keeps newest) and refreshes TTL.
     */
    append(threadId: string, message: Message): Promise<void>;
    /**
     * Get messages for a thread in chronological order (oldest first).
     *
     * @param threadId - The thread ID
     * @param limit - Optional limit on number of messages to return (returns newest N)
     */
    getMessages(threadId: string, limit?: number): Promise<Message[]>;
}

/**
 * Serialized channel data for passing to external systems (e.g., workflow engines).
 */
interface SerializedChannel {
    _type: "chat:Channel";
    adapterName: string;
    id: string;
    isDM: boolean;
}
/**
 * Config for creating a ChannelImpl with explicit adapter/state instances.
 */
interface ChannelImplConfigWithAdapter {
    adapter: Adapter;
    id: string;
    isDM?: boolean;
    messageHistory?: MessageHistoryCache;
    stateAdapter: StateAdapter;
}
/**
 * Config for creating a ChannelImpl with lazy adapter resolution.
 */
interface ChannelImplConfigLazy {
    adapterName: string;
    id: string;
    isDM?: boolean;
}
type ChannelImplConfig = ChannelImplConfigWithAdapter | ChannelImplConfigLazy;
declare class ChannelImpl<TState = Record<string, unknown>> implements Channel<TState> {
    readonly id: string;
    readonly isDM: boolean;
    private _adapter?;
    private readonly _adapterName?;
    private _stateAdapterInstance?;
    private _name;
    private readonly _messageHistory?;
    constructor(config: ChannelImplConfig);
    get adapter(): Adapter;
    private get _stateAdapter();
    get name(): string | null;
    get state(): Promise<TState | null>;
    setState(newState: Partial<TState>, options?: {
        replace?: boolean;
    }): Promise<void>;
    /**
     * Iterate messages newest first (backward from most recent).
     * Uses adapter.fetchChannelMessages if available, otherwise falls back
     * to adapter.fetchMessages with the channel ID.
     */
    get messages(): AsyncIterable<Message>;
    /**
     * Iterate threads in this channel, most recently active first.
     */
    threads(): AsyncIterable<ThreadSummary>;
    fetchMetadata(): Promise<ChannelInfo>;
    post(message: string | PostableMessage | ChatElement): Promise<SentMessage>;
    private postSingleMessage;
    postEphemeral(user: string | Author, message: AdapterPostableMessage | ChatElement, options: PostEphemeralOptions): Promise<EphemeralMessage | null>;
    schedule(message: AdapterPostableMessage | ChatElement, options: {
        postAt: Date;
    }): Promise<ScheduledMessage>;
    startTyping(status?: string): Promise<void>;
    mentionUser(userId: string): string;
    toJSON(): SerializedChannel;
    static fromJSON<TState = Record<string, unknown>>(json: SerializedChannel, adapter?: Adapter): ChannelImpl<TState>;
    static [WORKFLOW_SERIALIZE](instance: ChannelImpl): SerializedChannel;
    static [WORKFLOW_DESERIALIZE](data: SerializedChannel): ChannelImpl;
    private createSentMessage;
}
/**
 * Derive the channel ID from a thread ID.
 */
declare function deriveChannelId(adapter: Adapter, threadId: string): string;

/** Filter can be EmojiValue objects, emoji names, or raw emoji formats */
type EmojiFilter = EmojiValue | string;
/**
 * Type-safe webhook handler that is available for each adapter.
 */
type WebhookHandler = (request: Request, options?: WebhookOptions) => Promise<Response>;
/**
 * Creates a type-safe webhooks object based on the adapter names.
 */
type Webhooks<TAdapters extends Record<string, Adapter>> = {
    [K in keyof TAdapters]: WebhookHandler;
};
/**
 * Main Chat class with type-safe adapter inference and custom thread state.
 *
 * @template TAdapters - Map of adapter names to Adapter instances
 * @template TState - Custom state type stored per-thread (default: Record<string, unknown>)
 *
 * @example
 * // Define custom thread state type
 * interface MyThreadState {
 *   aiMode?: boolean;
 *   userName?: string;
 * }
 *
 * const chat = new Chat<typeof adapters, MyThreadState>({
 *   userName: "mybot",
 *   adapters: {
 *     slack: createSlackAdapter({ ... }),
 *     teams: createTeamsAdapter({ ... }),
 *   },
 *   state: createMemoryState(),
 * });
 *
 * // Type-safe thread state
 * chat.onNewMention(async (thread, message) => {
 *   await thread.setState({ aiMode: true });
 *   const state = await thread.state; // Type: MyThreadState | null
 * });
 */
declare class Chat<TAdapters extends Record<string, Adapter> = Record<string, Adapter>, TState = Record<string, unknown>> implements ChatInstance {
    /**
     * Register this Chat instance as the global singleton.
     * Required for Thread deserialization via @workflow/serde.
     *
     * @example
     * ```typescript
     * const chat = new Chat({ ... });
     * chat.registerSingleton();
     *
     * // Now threads can be deserialized without passing chat explicitly
     * const thread = ThreadImpl.fromJSON(serializedThread);
     * ```
     */
    registerSingleton(): this;
    /**
     * Get the registered singleton Chat instance.
     * Throws if no singleton has been registered.
     */
    static getSingleton(): Chat;
    /**
     * Check if a singleton has been registered.
     */
    static hasSingleton(): boolean;
    private readonly adapters;
    private readonly _stateAdapter;
    private readonly userName;
    private readonly logger;
    private readonly _streamingUpdateIntervalMs;
    private readonly _fallbackStreamingPlaceholderText;
    private readonly _dedupeTtlMs;
    private readonly _onLockConflict;
    private readonly _messageHistory;
    private readonly mentionHandlers;
    private readonly directMessageHandlers;
    private readonly messagePatterns;
    private readonly subscribedMessageHandlers;
    private readonly reactionHandlers;
    private readonly actionHandlers;
    private readonly modalSubmitHandlers;
    private readonly modalCloseHandlers;
    private readonly slashCommandHandlers;
    private readonly assistantThreadStartedHandlers;
    private readonly assistantContextChangedHandlers;
    private readonly appHomeOpenedHandlers;
    private readonly memberJoinedChannelHandlers;
    /** Initialization state */
    private initPromise;
    private initialized;
    /**
     * Type-safe webhook handlers keyed by adapter name.
     * @example
     * chat.webhooks.slack(request, { backgroundTask: waitUntil });
     */
    readonly webhooks: Webhooks<TAdapters>;
    constructor(config: ChatConfig<TAdapters>);
    /**
     * Handle a webhook request for a specific adapter.
     * Automatically initializes adapters on first call.
     */
    private handleWebhook;
    /**
     * Ensure the chat instance is initialized.
     * This is called automatically before handling webhooks.
     */
    private ensureInitialized;
    private doInitialize;
    /**
     * Gracefully shut down the chat instance.
     */
    shutdown(): Promise<void>;
    /**
     * Initialize the chat instance and all adapters.
     * This is called automatically when handling webhooks, but can be called
     * manually for non-webhook use cases (e.g., Gateway listeners).
     */
    initialize(): Promise<void>;
    /**
     * Register a handler for new @-mentions of the bot.
     *
     * **Important**: This handler is ONLY called for mentions in **unsubscribed** threads.
     * Once a thread is subscribed (via `thread.subscribe()`), subsequent messages
     * including @-mentions go to `onSubscribedMessage` handlers instead.
     *
     * To detect mentions in subscribed threads, check `message.isMention`:
     *
     * @example
     * ```typescript
     * // Handle new mentions (unsubscribed threads only)
     * chat.onNewMention(async (thread, message) => {
     *   await thread.subscribe();  // Subscribe to follow-up messages
     *   await thread.post("Hello! I'll be watching this thread.");
     * });
     *
     * // Handle all messages in subscribed threads
     * chat.onSubscribedMessage(async (thread, message) => {
     *   if (message.isMention) {
     *     // User @-mentioned us in a thread we're already watching
     *     await thread.post("You mentioned me again!");
     *   }
     * });
     * ```
     */
    onNewMention(handler: MentionHandler<TState>): void;
    /**
     * Register a handler for direct messages.
     *
     * Called when a message is received in a DM thread that is not subscribed.
     * If no `onDirectMessage` handlers are registered, DMs fall through to
     * `onNewMention` for backward compatibility.
     *
     * @param handler - Handler called for DM messages
     *
     * @example
     * ```typescript
     * chat.onDirectMessage(async (thread, message) => {
     *   await thread.subscribe();
     *   await thread.post("Thanks for the DM!");
     * });
     * ```
     */
    onDirectMessage(handler: DirectMessageHandler<TState>): void;
    /**
     * Register a handler for messages matching a regex pattern.
     *
     * @param pattern - Regular expression to match against message text
     * @param handler - Handler called when pattern matches
     *
     * @example
     * ```typescript
     * // Match messages starting with "!help"
     * chat.onNewMessage(/^!help/, async (thread, message) => {
     *   await thread.post("Available commands: !help, !status, !ping");
     * });
     * ```
     */
    onNewMessage(pattern: RegExp, handler: MessageHandler<TState>): void;
    /**
     * Register a handler for messages in subscribed threads.
     *
     * Called for all messages in threads that have been subscribed via `thread.subscribe()`.
     * This includes:
     * - Follow-up messages from users
     * - Messages that @-mention the bot (check `message.isMention`)
     *
     * Does NOT fire for:
     * - The message that triggered the subscription (e.g., the initial @mention)
     * - Messages sent by the bot itself
     *
     * @example
     * ```typescript
     * chat.onSubscribedMessage(async (thread, message) => {
     *   // Handle all follow-up messages
     *   if (message.isMention) {
     *     // User @-mentioned us in a subscribed thread
     *   }
     *   await thread.post(`Got your message: ${message.text}`);
     * });
     * ```
     */
    onSubscribedMessage(handler: SubscribedMessageHandler<TState>): void;
    /**
     * Register a handler for reaction events.
     *
     * @example
     * ```typescript
     * // Handle specific emoji using EmojiValue objects (recommended)
     * chat.onReaction([emoji.thumbs_up, emoji.heart], async (event) => {
     *   if (event.emoji === emoji.thumbs_up) {
     *     console.log("Thumbs up!");
     *   }
     * });
     *
     * // Handle all reactions
     * chat.onReaction(async (event) => {
     *   console.log(`${event.added ? "Added" : "Removed"} ${event.emoji.name}`);
     * });
     * ```
     *
     * @param emojiOrHandler - Either an array of emoji to filter (EmojiValue or string), or the handler
     * @param handler - The handler (if emoji filter is provided)
     */
    onReaction(handler: ReactionHandler): void;
    onReaction(emoji: EmojiFilter[], handler: ReactionHandler): void;
    /**
     * Register a handler for action events (button clicks in cards).
     *
     * @example
     * ```typescript
     * // Handle specific action
     * chat.onAction("approve", async (event) => {
     *   await event.thread.post("Approved!");
     * });
     *
     * // Handle multiple actions
     * chat.onAction(["approve", "reject"], async (event) => {
     *   if (event.actionId === "approve") {
     *     await event.thread.post("Approved!");
     *   } else {
     *     await event.thread.post("Rejected!");
     *   }
     * });
     *
     * // Handle all actions (catch-all)
     * chat.onAction(async (event) => {
     *   console.log(`Action: ${event.actionId}`);
     * });
     * ```
     *
     * @param actionIdOrHandler - Either an action ID, array of action IDs, or the handler
     * @param handler - The handler (if action ID filter is provided)
     */
    onAction(handler: ActionHandler): void;
    onAction(actionIds: string[] | string, handler: ActionHandler): void;
    onModalSubmit(handler: ModalSubmitHandler): void;
    onModalSubmit(callbackIds: string[] | string, handler: ModalSubmitHandler): void;
    onModalClose(handler: ModalCloseHandler): void;
    onModalClose(callbackIds: string[] | string, handler: ModalCloseHandler): void;
    /**
     * Register a handler for slash command events.
     *
     * Slash commands are triggered when a user types `/command` in the message composer.
     * Use `event.channel.post()` or `event.channel.postEphemeral()` to respond.
     *
     * @example
     * ```typescript
     * // Handle a specific command
     * chat.onSlashCommand("/help", async (event) => {
     *   await event.channel.post("Here are the available commands...");
     * });
     *
     * // Handle multiple commands
     * chat.onSlashCommand(["/status", "/health"], async (event) => {
     *   await event.channel.post("All systems operational!");
     * });
     *
     * // Handle all commands (catch-all)
     * chat.onSlashCommand(async (event) => {
     *   console.log(`Received command: ${event.command} ${event.text}`);
     * });
     *
     * // Open a modal from a slash command
     * chat.onSlashCommand("/feedback", async (event) => {
     *   await event.openModal({
     *     callbackId: "feedback_modal",
     *     title: "Submit Feedback",
     *     inputs: [{ id: "feedback", type: "text_input", label: "Your feedback" }],
     *   });
     * });
     * ```
     *
     * @param commandOrHandler - Either a command, array of commands, or the handler
     * @param handler - The handler (if command filter is provided)
     */
    onSlashCommand(handler: SlashCommandHandler<TState>): void;
    onSlashCommand(commands: string[] | string, handler: SlashCommandHandler<TState>): void;
    onAssistantThreadStarted(handler: AssistantThreadStartedHandler): void;
    onAssistantContextChanged(handler: AssistantContextChangedHandler): void;
    onAppHomeOpened(handler: AppHomeOpenedHandler): void;
    onMemberJoinedChannel(handler: MemberJoinedChannelHandler): void;
    /**
     * Get an adapter by name with type safety.
     */
    getAdapter<K extends keyof TAdapters>(name: K): TAdapters[K];
    /**
     * Get a JSON.parse reviver function that automatically deserializes
     * chat:Thread and chat:Message objects.
     *
     * Use this when parsing JSON that contains serialized Thread or Message objects
     * (e.g., from workflow engine payloads).
     *
     * @returns A reviver function for JSON.parse
     *
     * @example
     * ```typescript
     * // Parse workflow payload with automatic deserialization
     * const data = JSON.parse(payload, chat.reviver());
     *
     * // data.thread is now a ThreadImpl instance
     * // data.message is now a Message object with Date fields restored
     * await data.thread.post("Hello from workflow!");
     * ```
     */
    reviver(): (key: string, value: unknown) => unknown;
    /**
     * Process an incoming message from an adapter.
     * Handles waitUntil registration and error catching internally.
     * Adapters should call this instead of handleIncomingMessage directly.
     */
    processMessage(adapter: Adapter, threadId: string, messageOrFactory: Message | (() => Promise<Message>), options?: WebhookOptions): void;
    /**
     * Process an incoming reaction event from an adapter.
     * Handles waitUntil registration and error catching internally.
     */
    processReaction(event: Omit<ReactionEvent, "adapter" | "thread"> & {
        adapter?: Adapter;
    }, options?: WebhookOptions): void;
    /**
     * Process an incoming action event (button click) from an adapter.
     * Handles waitUntil registration and error catching internally.
     */
    processAction(event: Omit<ActionEvent, "thread" | "openModal"> & {
        adapter: Adapter;
    }, options?: WebhookOptions): void;
    processModalSubmit(event: Omit<ModalSubmitEvent, "relatedThread" | "relatedMessage" | "relatedChannel">, contextId?: string, _options?: WebhookOptions): Promise<ModalResponse | undefined>;
    processModalClose(event: Omit<ModalCloseEvent, "relatedThread" | "relatedMessage" | "relatedChannel">, contextId?: string, options?: WebhookOptions): void;
    /**
     * Process an incoming slash command from an adapter.
     * Handles waitUntil registration and error catching internally.
     */
    processSlashCommand(event: Omit<SlashCommandEvent, "channel" | "openModal"> & {
        adapter: Adapter;
        channelId: string;
    }, options?: WebhookOptions): void;
    processAssistantThreadStarted(event: AssistantThreadStartedEvent, options?: WebhookOptions): void;
    processAssistantContextChanged(event: AssistantContextChangedEvent, options?: WebhookOptions): void;
    processAppHomeOpened(event: AppHomeOpenedEvent, options?: WebhookOptions): void;
    processMemberJoinedChannel(event: MemberJoinedChannelEvent, options?: WebhookOptions): void;
    /**
     * Handle a slash command event internally.
     */
    private handleSlashCommandEvent;
    /**
     * Store modal context server-side with a context ID.
     * Called when opening a modal to preserve thread/message/channel for the submit handler.
     */
    private storeModalContext;
    /**
     * Retrieve and delete modal context from server-side storage.
     * Called when processing modal submit/close to reconstruct thread/message/channel.
     */
    private retrieveModalContext;
    /**
     * Handle an action event internally.
     */
    private handleActionEvent;
    /**
     * Handle a reaction event internally.
     */
    private handleReactionEvent;
    getState(): StateAdapter;
    getUserName(): string;
    getLogger(prefix?: string): Logger;
    /**
     * Open a direct message conversation with a user.
     *
     * Accepts either a user ID string or an Author object (from message.author or event.user).
     *
     * The adapter is automatically inferred from the userId format:
     * - Slack: `U...` (e.g., "U00FAKEUSER1")
     * - Teams: `29:...` (e.g., "29:198PbJuw...")
     * - Google Chat: `users/...` (e.g., "users/100000000000000000001")
     * - Discord: numeric snowflake (e.g., "1033044521375764530")
     *
     * @param user - Platform-specific user ID string, or an Author object
     * @returns A Thread that can be used to post messages
     *
     * @example
     * ```ts
     * // Using user ID directly
     * const dmThread = await chat.openDM("U123456");
     * await dmThread.post("Hello via DM!");
     *
     * // Using Author object from a message
     * chat.onSubscribedMessage(async (thread, message) => {
     *   const dmThread = await chat.openDM(message.author);
     *   await dmThread.post("Hello via DM!");
     * });
     * ```
     */
    openDM(user: string | Author): Promise<Thread<TState>>;
    /**
     * Get a Channel by its channel ID.
     *
     * The adapter is automatically inferred from the channel ID prefix.
     *
     * @param channelId - Channel ID (e.g., "slack:C123ABC", "gchat:spaces/ABC123")
     * @returns A Channel that can be used to list threads, post messages, iterate messages, etc.
     *
     * @example
     * ```typescript
     * const channel = chat.channel("slack:C123ABC");
     *
     * // Iterate messages newest first
     * for await (const msg of channel.messages) {
     *   console.log(msg.text);
     * }
     *
     * // List threads
     * for await (const t of channel.threads()) {
     *   console.log(t.rootMessage.text, t.replyCount);
     * }
     *
     * // Post to channel
     * await channel.post("Hello channel!");
     * ```
     */
    channel(channelId: string): Channel<TState>;
    /**
     * Infer which adapter to use based on the userId format.
     */
    private inferAdapterFromUserId;
    /**
     * Handle an incoming message from an adapter.
     * This is called by adapters when they receive a webhook.
     *
     * The Chat class handles common concerns centrally:
     * - Deduplication: Same message may arrive multiple times (e.g., Slack sends
     *   both `message` and `app_mention` events, GChat sends direct webhook + Pub/Sub)
     * - Bot filtering: Messages from the bot itself are skipped
     * - Locking: Only one instance processes a thread at a time
     */
    handleIncomingMessage(adapter: Adapter, threadId: string, message: Message): Promise<void>;
    private createThread;
    /**
     * Detect if the bot was mentioned in the message.
     * All adapters normalize mentions to @name format, so we just check for @username.
     */
    private detectMention;
    private escapeRegex;
    private runHandlers;
}

/**
 * Normalizes an async iterable stream for use with `thread.post()`.
 *
 * Handles three stream types automatically:
 * - **Text streams** (`AsyncIterable<string>`, e.g. AI SDK `textStream`) —
 *   passed through as-is.
 * - **Full streams** (`AsyncIterable<object>`, e.g. AI SDK `fullStream`) —
 *   extracts `text-delta` events and injects `"\n\n"` separators between
 *   steps so that multi-step agent output reads naturally.
 * - **StreamChunk objects** (`task_update`, `plan_update`, `markdown_text`) —
 *   passed through as-is for adapters with native structured chunk support.
 *
 * This is used internally by `thread.post()`, so you can pass either stream
 * directly:
 * ```ts
 * await thread.post(result.fullStream); // auto-detected
 * await thread.post(result.textStream); // still works
 * ```
 */
declare function fromFullStream(stream: AsyncIterable<unknown>): AsyncIterable<string | StreamChunk>;

/**
 * A streaming markdown renderer that buffers potential table headers
 * until confirmed by a separator line, preventing tables from flashing
 * as raw pipe-delimited text during LLM streaming.
 *
 * Outputs markdown (not platform text). Format conversion still happens
 * in the adapter's editMessage → renderPostable → fromAst pipeline.
 */
declare class StreamingMarkdownRenderer {
    private accumulated;
    private dirty;
    private cachedRender;
    private finished;
    /** Number of code fence toggles from completed lines (odd = inside). */
    private fenceToggles;
    /** Incomplete trailing line buffer for incremental fence tracking. */
    private incompleteLine;
    /** Append a chunk from the LLM stream. */
    push(chunk: string): void;
    /** O(1) check if accumulated text is inside an unclosed code fence. */
    private isAccumulatedInsideFence;
    /**
     * Get renderable markdown for an intermediate edit.
     * - Holds back trailing lines that look like a table header (|...|)
     *   until a separator line (|---|---|) confirms or the next line denies.
     * - Applies remend() to close incomplete inline markers.
     * - Idempotent: returns cached result if no push() since last call.
     */
    render(): string;
    /**
     * Get text safe for append-only streaming (e.g. Slack native streaming).
     *
     * - Holds back unconfirmed table headers until separator arrives.
     * - Wraps confirmed tables in code fences so pipes render as literal
     *   text (not broken mrkdwn). The code fence is left OPEN while
     *   the table is still streaming, keeping output monotonic for deltas.
     * - Holds back unclosed inline markers (**, *, ~~, `, [).
     * - The final editMessage replaces everything with properly formatted text.
     */
    getCommittableText(): string;
    /** Raw accumulated text (no remend, no buffering). For the final edit. */
    getText(): string;
    /** Signal stream end. Flushes held-back lines. Returns final render. */
    finish(): string;
}

/**
 * Serialized thread data for passing to external systems (e.g., workflow engines).
 */
interface SerializedThread {
    _type: "chat:Thread";
    adapterName: string;
    channelId: string;
    currentMessage?: SerializedMessage;
    id: string;
    isDM: boolean;
}
/**
 * Config for creating a ThreadImpl with explicit adapter/state instances.
 */
interface ThreadImplConfigWithAdapter {
    adapter: Adapter;
    channelId: string;
    currentMessage?: Message;
    fallbackStreamingPlaceholderText?: string | null;
    id: string;
    initialMessage?: Message;
    isDM?: boolean;
    isSubscribedContext?: boolean;
    logger?: Logger;
    messageHistory?: MessageHistoryCache;
    stateAdapter: StateAdapter;
    streamingUpdateIntervalMs?: number;
}
/**
 * Config for creating a ThreadImpl with lazy adapter resolution.
 * The adapter will be looked up from the Chat singleton on first access.
 */
interface ThreadImplConfigLazy {
    adapterName: string;
    channelId: string;
    currentMessage?: Message;
    fallbackStreamingPlaceholderText?: string | null;
    id: string;
    initialMessage?: Message;
    isDM?: boolean;
    isSubscribedContext?: boolean;
    logger?: Logger;
    streamingUpdateIntervalMs?: number;
}
type ThreadImplConfig = ThreadImplConfigWithAdapter | ThreadImplConfigLazy;
declare class ThreadImpl<TState = Record<string, unknown>> implements Thread<TState> {
    readonly id: string;
    readonly channelId: string;
    readonly isDM: boolean;
    /** Direct adapter instance (if provided) */
    private _adapter?;
    /** Adapter name for lazy resolution */
    private readonly _adapterName?;
    /** Direct state adapter instance (if provided) */
    private _stateAdapterInstance?;
    private _recentMessages;
    private readonly _isSubscribedContext;
    /** Current message context for streaming - provides userId/teamId */
    private readonly _currentMessage?;
    /** Update interval for fallback streaming */
    private readonly _streamingUpdateIntervalMs;
    /** Placeholder text for fallback streaming (post + edit) */
    private readonly _fallbackStreamingPlaceholderText;
    /** Cached channel instance */
    private _channel?;
    /** Message history cache (set only for adapters with persistMessageHistory) */
    private readonly _messageHistory?;
    private readonly _logger?;
    constructor(config: ThreadImplConfig);
    /**
     * Get the adapter for this thread.
     * If created with lazy config, resolves from Chat singleton on first access.
     */
    get adapter(): Adapter;
    /**
     * Get the state adapter for this thread.
     * If created with lazy config, resolves from Chat singleton on first access.
     */
    private get _stateAdapter();
    get recentMessages(): Message[];
    set recentMessages(messages: Message[]);
    /**
     * Get the current thread state.
     * Returns null if no state has been set.
     */
    get state(): Promise<TState | null>;
    /**
     * Set the thread state. Merges with existing state by default.
     * State is persisted for 30 days.
     */
    setState(newState: Partial<TState>, options?: {
        replace?: boolean;
    }): Promise<void>;
    /**
     * Get the Channel containing this thread.
     * Lazy-created and cached.
     */
    get channel(): Channel<TState>;
    /**
     * Iterate messages newest first (backward from most recent).
     * Auto-paginates lazily.
     */
    get messages(): AsyncIterable<Message>;
    get allMessages(): AsyncIterable<Message>;
    isSubscribed(): Promise<boolean>;
    subscribe(): Promise<void>;
    unsubscribe(): Promise<void>;
    post(message: string | PostableMessage | ChatElement): Promise<SentMessage>;
    postEphemeral(user: string | Author, message: AdapterPostableMessage | ChatElement, options: PostEphemeralOptions): Promise<EphemeralMessage | null>;
    schedule(message: AdapterPostableMessage | ChatElement, options: {
        postAt: Date;
    }): Promise<ScheduledMessage>;
    /**
     * Handle streaming from an AsyncIterable.
     * Normalizes the stream (supports both textStream and fullStream from AI SDK),
     * then uses adapter's native streaming if available, otherwise falls back to post+edit.
     */
    private handleStream;
    startTyping(status?: string): Promise<void>;
    /**
     * Fallback streaming implementation using post + edit.
     * Used when adapter doesn't support native streaming.
     * Uses recursive setTimeout to send updates every intervalMs (default 500ms).
     * Schedules next update only after current edit completes to avoid overwhelming slow services.
     */
    private fallbackStream;
    refresh(): Promise<void>;
    mentionUser(userId: string): string;
    /**
     * Serialize the thread to a plain JSON object.
     * Use this to pass thread data to external systems like workflow engines.
     *
     * @example
     * ```typescript
     * // Pass to a workflow
     * await workflow.start("my-workflow", {
     *   thread: thread.toJSON(),
     *   message: serializeMessage(message),
     * });
     * ```
     */
    toJSON(): SerializedThread;
    /**
     * Reconstruct a Thread from serialized JSON data.
     *
     * Reconstructs a ThreadImpl from serialized data.
     * Uses lazy resolution from Chat.getSingleton() for adapter and state.
     *
     * @param json - Serialized thread data
     * @requires Call `chat.registerSingleton()` before deserializing threads
     *
     * @example
     * ```typescript
     * const thread = ThreadImpl.fromJSON(serializedThread);
     * ```
     */
    static fromJSON<TState = Record<string, unknown>>(json: SerializedThread, adapter?: Adapter): ThreadImpl<TState>;
    /**
     * Serialize a ThreadImpl instance for @workflow/serde.
     * This static method is automatically called by workflow serialization.
     */
    static [WORKFLOW_SERIALIZE](instance: ThreadImpl): SerializedThread;
    /**
     * Deserialize a ThreadImpl from @workflow/serde.
     * Uses lazy adapter resolution from Chat.getSingleton().
     * Requires chat.registerSingleton() to have been called.
     */
    static [WORKFLOW_DESERIALIZE](data: SerializedThread): ThreadImpl;
    private createSentMessage;
    createSentMessageFromMessage(message: Message): SentMessage;
}

/**
 * Get or create an immutable singleton EmojiValue.
 *
 * Always returns the same frozen object for the same name,
 * enabling `===` comparison for emoji identity.
 *
 * @example
 * ```typescript
 * const e1 = getEmoji("thumbs_up");
 * const e2 = getEmoji("thumbs_up");
 * console.log(e1 === e2); // true - same object
 * ```
 */
declare function getEmoji(name: string): EmojiValue;
/**
 * Default emoji map for well-known emoji.
 * Maps normalized emoji names to platform-specific formats.
 */
declare const DEFAULT_EMOJI_MAP: Record<string, EmojiFormats>;
/**
 * Emoji resolver that handles conversion between platform formats and normalized names.
 */
declare class EmojiResolver {
    private readonly emojiMap;
    private readonly slackToNormalized;
    private readonly gchatToNormalized;
    constructor(customMap?: EmojiMapConfig);
    private buildReverseMaps;
    /**
     * Convert a Slack emoji name to normalized EmojiValue.
     * Returns an EmojiValue for the raw emoji if no mapping exists.
     */
    fromSlack(slackEmoji: string): EmojiValue;
    /**
     * Convert a Google Chat unicode emoji to normalized EmojiValue.
     * Returns an EmojiValue for the raw emoji if no mapping exists.
     */
    fromGChat(gchatEmoji: string): EmojiValue;
    /**
     * Convert a Teams reaction type to normalized EmojiValue.
     * Teams uses specific names: like, heart, laugh, surprised, sad, angry
     * Returns an EmojiValue for the raw reaction if no mapping exists.
     */
    fromTeams(teamsReaction: string): EmojiValue;
    /**
     * Convert a normalized emoji (or EmojiValue) to Slack format.
     * Returns the first Slack format if multiple exist.
     */
    toSlack(emoji: EmojiValue | string): string;
    /**
     * Convert a normalized emoji (or EmojiValue) to Google Chat format.
     * Returns the first GChat format if multiple exist.
     */
    toGChat(emoji: EmojiValue | string): string;
    /**
     * Convert a normalized emoji (or EmojiValue) to Discord format (unicode).
     * Discord uses unicode emoji, same as Google Chat.
     */
    toDiscord(emoji: EmojiValue | string): string;
    /**
     * Check if an emoji (in any format) matches a normalized emoji name or EmojiValue.
     */
    matches(rawEmoji: string, normalized: EmojiValue | string): boolean;
    /**
     * Add or override emoji mappings.
     */
    extend(customMap: EmojiMapConfig): void;
}
/**
 * Default emoji resolver instance.
 */
declare const defaultEmojiResolver: EmojiResolver;
/**
 * Convert emoji placeholders in text to platform-specific format.
 *
 * @example
 * ```typescript
 * convertEmojiPlaceholders("Thanks! {{emoji:thumbs_up}}", "slack");
 * // Returns: "Thanks! :+1:"
 *
 * convertEmojiPlaceholders("Thanks! {{emoji:thumbs_up}}", "gchat");
 * // Returns: "Thanks! 👍"
 * ```
 */
declare function convertEmojiPlaceholders(text: string, platform: "slack" | "gchat" | "teams" | "discord" | "github" | "linear" | "whatsapp", resolver?: EmojiResolver): string;
/** Base emoji object with well-known emoji as EmojiValue singletons */
type BaseEmojiHelper = {
    [K in WellKnownEmoji]: EmojiValue;
} & {
    /** Create an EmojiValue for a custom emoji name */
    custom: (name: string) => EmojiValue;
};
/** Extended emoji object including custom emoji from module augmentation */
type ExtendedEmojiHelper = BaseEmojiHelper & {
    [K in keyof CustomEmojiMap]: EmojiValue;
};
/**
 * Create a type-safe emoji helper with custom emoji.
 *
 * Returns immutable singleton EmojiValue objects that support:
 * - Object identity comparison (`event.emoji === emoji.thumbs_up`)
 * - Template string interpolation (`${emoji.thumbs_up}` → "{{emoji:thumbs_up}}")
 *
 * Custom emoji are automatically registered with the default resolver,
 * so placeholders will convert correctly in messages.
 *
 * @example
 * ```typescript
 * // First, extend the CustomEmojiMap type (usually in a .d.ts file)
 * declare module "chat" {
 *   interface CustomEmojiMap {
 *     unicorn: EmojiFormats;
 *     company_logo: EmojiFormats;
 *   }
 * }
 *
 * // Then create the emoji helper with your custom emoji
 * const emoji = createEmoji({
 *   unicorn: { slack: "unicorn_face", gchat: "🦄" },
 *   company_logo: { slack: "company", gchat: "🏢" },
 * });
 *
 * // Object identity works for comparisons
 * if (event.emoji === emoji.unicorn) { ... }
 *
 * // Template strings work for messages
 * await thread.post(`${emoji.unicorn} Magic!`);
 * // Slack: ":unicorn_face: Magic!"
 * // GChat: "🦄 Magic!"
 * ```
 */
declare function createEmoji<T extends Record<string, {
    slack: string | string[];
    gchat: string | string[];
}>>(customEmoji?: T): BaseEmojiHelper & {
    [K in keyof T]: EmojiValue;
};
/**
 * Type-safe emoji helper for embedding emoji in messages.
 *
 * @example
 * ```typescript
 * import { emoji } from "chat";
 *
 * await thread.post(`Great job! ${emoji.thumbs_up} ${emoji.fire}`);
 * // Slack: "Great job! :+1: :fire:"
 * // GChat: "Great job! 👍 🔥"
 * ```
 *
 * For custom emoji, use `createEmoji()` with module augmentation:
 * @example
 * ```typescript
 * // types.d.ts
 * declare module "chat" {
 *   interface CustomEmojiMap {
 *     unicorn: EmojiFormats;
 *   }
 * }
 *
 * // bot.ts
 * const emoji = createEmoji({ unicorn: { slack: "unicorn", gchat: "🦄" } });
 * await thread.post(`${emoji.unicorn} Magic!`);
 * ```
 */
declare const emoji: ExtendedEmojiHelper;

/**
 * Markdown parsing and conversion utilities using unified/remark.
 */

type PostableMessageInput = AdapterPostableMessage;

/**
 * Type guard for text nodes.
 */
declare function isTextNode(node: Content): node is Text;
/**
 * Type guard for paragraph nodes.
 */
declare function isParagraphNode(node: Content): node is Paragraph;
/**
 * Type guard for strong (bold) nodes.
 */
declare function isStrongNode(node: Content): node is Strong;
/**
 * Type guard for emphasis (italic) nodes.
 */
declare function isEmphasisNode(node: Content): node is Emphasis;
/**
 * Type guard for delete (strikethrough) nodes.
 */
declare function isDeleteNode(node: Content): node is Delete;
/**
 * Type guard for inline code nodes.
 */
declare function isInlineCodeNode(node: Content): node is InlineCode;
/**
 * Type guard for code block nodes.
 */
declare function isCodeNode(node: Content): node is Code;
/**
 * Type guard for link nodes.
 */
declare function isLinkNode(node: Content): node is Link;
/**
 * Type guard for blockquote nodes.
 */
declare function isBlockquoteNode(node: Content): node is Blockquote;
/**
 * Type guard for list nodes.
 */
declare function isListNode(node: Content): node is List;
/**
 * Type guard for list item nodes.
 */
declare function isListItemNode(node: Content): node is ListItem;
/**
 * Type guard for table nodes.
 */
declare function isTableNode(node: Content): node is Table$1;
/**
 * Type guard for table row nodes.
 */
declare function isTableRowNode(node: Content): node is TableRow;
/**
 * Type guard for table cell nodes.
 */
declare function isTableCellNode(node: Content): node is TableCell;
/**
 * Render an mdast table node as a padded ASCII table string.
 *
 * Produces output like:
 * ```
 * Name  | Age | Role
 * ------|-----|--------
 * Alice | 30  | Engineer
 * Bob   | 25  | Designer
 * ```
 *
 * Shared by adapters that lack native table support (Slack, GChat, Discord, Telegram).
 */
declare function tableToAscii(node: Table$1): string;
/**
 * Render a table from headers and string rows as a padded ASCII table.
 * Used for card TableElement fallback rendering.
 */
declare function tableElementToAscii(headers: string[], rows: string[][]): string;
/**
 * Get children from a content node that has children.
 * Returns empty array for nodes without children.
 * This eliminates the need for `as Content` casts in adapter converters.
 */
declare function getNodeChildren(node: Content): Content[];
/**
 * Get value from a content node that has a value property.
 * Returns empty string for nodes without value.
 */
declare function getNodeValue(node: Content): string;
/**
 * Parse markdown string into an AST.
 * Supports GFM (GitHub Flavored Markdown) for strikethrough, tables, etc.
 */
declare function parseMarkdown(markdown: string): Root;
/**
 * Options for stringifyMarkdown.
 */
interface StringifyOptions {
    /** Bullet character for unordered lists. Default: `'*'` */
    bullet?: "*" | "-" | "+";
    /** Emphasis marker character. Default: `'*'` */
    emphasis?: "*" | "_";
}
/**
 * Stringify an AST back to markdown.
 */
declare function stringifyMarkdown(ast: Root, options?: StringifyOptions): string;
/**
 * Extract plain text from an AST (strips all formatting).
 */
declare function toPlainText(ast: Root): string;
/**
 * Extract plain text from a markdown string.
 */
declare function markdownToPlainText(markdown: string): string;
/**
 * Walk the AST and transform nodes.
 */
declare function walkAst<T extends Content | Root>(node: T, visitor: (node: Content) => Content | null): T;
/**
 * Create a text node.
 */
declare function text(value: string): Text;
/**
 * Create a strong (bold) node.
 */
declare function strong(children: Content[]): Strong;
/**
 * Create an emphasis (italic) node.
 */
declare function emphasis(children: Content[]): Emphasis;
/**
 * Create a delete (strikethrough) node.
 */
declare function strikethrough(children: Content[]): Delete;
/**
 * Create an inline code node.
 */
declare function inlineCode(value: string): InlineCode;
/**
 * Create a code block node.
 */
declare function codeBlock(value: string, lang?: string): Code;
/**
 * Create a link node.
 */
declare function link(url: string, children: Content[], title?: string): Link;
/**
 * Create a blockquote node.
 */
declare function blockquote(children: Content[]): Blockquote;
/**
 * Create a paragraph node.
 */
declare function paragraph(children: Content[]): Paragraph;
/**
 * Create a root node (top-level AST container).
 */
declare function root(children: Content[]): Root;
/**
 * Interface for platform-specific format converters.
 *
 * The AST (mdast Root) is the canonical representation.
 * All conversions go through the AST:
 *
 *   Platform Format <-> AST <-> Markdown String
 *
 * Adapters implement this interface to convert between
 * their platform-specific format and the standard AST.
 */
interface FormatConverter {
    /**
     * Extract plain text from platform format.
     * Convenience method - default implementation uses toAst + toPlainText.
     */
    extractPlainText(platformText: string): string;
    /**
     * Render an AST to the platform's native format.
     * This is the primary method used when sending messages.
     */
    fromAst(ast: Root): string;
    /**
     * Parse platform's native format into an AST.
     * This is the primary method used when receiving messages.
     */
    toAst(platformText: string): Root;
}
/**
 * @deprecated Use FormatConverter instead
 */
interface MarkdownConverter extends FormatConverter {
    fromMarkdown(markdown: string): string;
    toMarkdown(platformText: string): string;
    toPlainText(platformText: string): string;
}
/**
 * Base class for format converters with default implementations.
 */
declare abstract class BaseFormatConverter implements FormatConverter {
    abstract fromAst(ast: Root): string;
    abstract toAst(platformText: string): Root;
    protected renderList(node: List, depth: number, nodeConverter: (node: Content) => string, unorderedBullet?: string): string;
    /**
     * Default fallback for converting an unknown mdast node to text.
     * Recursively converts children if present, otherwise extracts the node value.
     * Adapters should call this in their nodeToX() default case.
     */
    protected defaultNodeToText(node: Content, nodeConverter: (node: Content) => string): string;
    /**
     * Template method for implementing fromAst with a node converter.
     * Iterates through AST children and converts each using the provided function.
     * Joins results with double newlines (standard paragraph separation).
     *
     * @param ast - The AST to convert
     * @param nodeConverter - Function to convert each Content node to string
     * @returns Platform-formatted string
     */
    protected fromAstWithNodeConverter(ast: Root, nodeConverter: (node: Content) => string): string;
    extractPlainText(platformText: string): string;
    fromMarkdown(markdown: string): string;
    toMarkdown(platformText: string): string;
    /** @deprecated Use extractPlainText instead */
    toPlainText(platformText: string): string;
    /**
     * Convert a PostableMessage to platform format (text only).
     * - string: passed through as raw text (no conversion)
     * - { raw: string }: passed through as raw text (no conversion)
     * - { markdown: string }: converted from markdown to platform format
     * - { ast: Root }: converted from AST to platform format
     * - { card: CardElement }: returns fallback text (cards should be handled by adapter)
     * - CardElement: returns fallback text (cards should be handled by adapter)
     *
     * Note: For cards, adapters should check for card content first and render
     * them using platform-specific card APIs, using this method only for fallback.
     */
    renderPostable(message: PostableMessageInput): string;
    /**
     * Generate fallback text from a card element.
     * Override in subclasses for platform-specific formatting.
     */
    protected cardToFallbackText(card: CardElement): string;
    /**
     * Convert card child element to fallback text.
     */
    protected cardChildToFallbackText(child: CardChild): string | null;
}

declare const Actions: ActionsComponent;
declare const Button: ButtonComponent;
declare const Card: CardComponent;
declare const cardChildToFallbackText: typeof cardChildToFallbackText$1;
declare const CardLink: CardLinkComponent;
declare const CardText: TextComponent;
declare const Divider: DividerComponent;
declare const Field: FieldComponent;
declare const Fields: FieldsComponent;
declare const fromReactElement: typeof fromReactElement$1;
declare const Image: ImageComponent;
declare const isCardElement: typeof isCardElement$1;
declare const isJSX: typeof isJSX$1;
declare const LinkButton: LinkButtonComponent;
declare const Section: SectionComponent;
declare const Table: typeof Table$2;
declare const toCardElement: typeof toCardElement$1;
declare const toModalElement: typeof toModalElement$1;

declare const fromReactModalElement: typeof fromReactModalElement$1;
declare const isModalElement: typeof isModalElement$1;
declare const Modal: ModalComponent;
declare const RadioSelect: RadioSelectComponent;
declare const Select: SelectComponent;
declare const SelectOption: SelectOptionComponent;
declare const TextInput: TextInputComponent;

export { type ActionEvent, type ActionHandler, Actions, ActionsComponent, type Adapter, type AdapterPostableMessage, type AiAssistantMessage, type AiFilePart, type AiImagePart, type AiMessage, type AiMessagePart, type AiTextPart, type AiUserMessage, type AppHomeOpenedEvent, type AppHomeOpenedHandler, type AssistantContextChangedEvent, type AssistantContextChangedHandler, type AssistantThreadStartedEvent, type AssistantThreadStartedHandler, type Attachment, type Author, BaseFormatConverter, Button, ButtonComponent, Card, CardChild, CardComponent, CardElement, CardLink, CardLinkComponent, CardText, type Channel, ChannelImpl, type ChannelInfo, Chat, type ChatConfig, ChatElement, ChatError, type ChatInstance, ConsoleLogger, type CustomEmojiMap, DEFAULT_EMOJI_MAP, type DirectMessageHandler, Divider, DividerComponent, type Emoji, type EmojiFormats, type EmojiMapConfig, EmojiResolver, type EmojiValue, type EphemeralMessage, type FetchDirection, type FetchOptions, type FetchResult, Field, FieldComponent, Fields, FieldsComponent, type FileUpload, type FormatConverter, type FormattedContent, Image, ImageComponent, LinkButton, LinkButtonComponent, type LinkPreview, type ListThreadsOptions, type ListThreadsResult, type Lock, LockError, type LogLevel, type Logger, type MarkdownConverter, type MarkdownTextChunk, type MemberJoinedChannelEvent, type MemberJoinedChannelHandler, type MentionHandler, Message, type MessageData, type MessageHandler, MessageHistoryCache, type MessageHistoryConfig, type MessageMetadata, Modal, type ModalCloseEvent, type ModalCloseHandler, type ModalCloseResponse, ModalComponent, ModalElement, type ModalErrorsResponse, type ModalPushResponse, type ModalResponse, type ModalSubmitEvent, type ModalSubmitHandler, type ModalUpdateResponse, NotImplementedError, type PlanUpdateChunk, type PostEphemeralOptions, type Postable, type PostableAst, type PostableCard, type PostableMarkdown, type PostableMessage, type PostableRaw, RadioSelect, RadioSelectComponent, RateLimitError, type RawMessage, type ReactionEvent, type ReactionHandler, type ScheduledMessage, Section, SectionComponent, Select, SelectComponent, SelectOption, SelectOptionComponent, type SentMessage, type SerializedChannel, type SerializedMessage, type SerializedThread, type SlashCommandEvent, type SlashCommandHandler, type StateAdapter, type StreamChunk, type StreamEvent, type StreamOptions, StreamingMarkdownRenderer, type SubscribedMessageHandler, THREAD_STATE_TTL_MS, Table, type TaskUpdateChunk, TextComponent, TextInput, TextInputComponent, type Thread, ThreadImpl, type ThreadInfo, type ThreadSummary, type WebhookOptions, type WellKnownEmoji, blockquote, cardChildToFallbackText, codeBlock, convertEmojiPlaceholders, createEmoji, defaultEmojiResolver, deriveChannelId, emoji, emphasis, fromFullStream, fromReactElement, fromReactModalElement, getEmoji, getNodeChildren, getNodeValue, inlineCode, isBlockquoteNode, isCardElement, isCodeNode, isDeleteNode, isEmphasisNode, isInlineCodeNode, isJSX, isLinkNode, isListItemNode, isListNode, isModalElement, isParagraphNode, isStrongNode, isTableCellNode, isTableNode, isTableRowNode, isTextNode, link, markdownToPlainText, paragraph, parseMarkdown, root, strikethrough, stringifyMarkdown, strong, tableElementToAscii, tableToAscii, text, toAiMessages, toCardElement, toModalElement, toPlainText, walkAst };
