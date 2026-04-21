import {
  Actions,
  BaseFormatConverter,
  Button,
  Card,
  CardLink,
  CardText,
  Divider,
  Field,
  Fields,
  Image,
  LinkButton,
  Modal,
  RadioSelect,
  Section,
  Select,
  SelectOption,
  Table,
  TextInput,
  blockquote,
  cardChildToFallbackText,
  cardToFallbackText,
  codeBlock,
  emphasis,
  fromReactElement,
  fromReactModalElement,
  getNodeChildren,
  getNodeValue,
  inlineCode,
  isBlockquoteNode,
  isCardElement,
  isCodeNode,
  isDeleteNode,
  isEmphasisNode,
  isInlineCodeNode,
  isJSX,
  isLinkNode,
  isListItemNode,
  isListNode,
  isModalElement,
  isParagraphNode,
  isStrongNode,
  isTableCellNode,
  isTableNode,
  isTableRowNode,
  isTextNode,
  link,
  markdownToPlainText,
  paragraph,
  parseMarkdown,
  root,
  strikethrough,
  stringifyMarkdown,
  strong,
  tableElementToAscii,
  tableToAscii,
  text,
  toCardElement,
  toModalElement,
  toPlainText,
  walkAst
} from "./chunk-JW7GYSMH.js";

// src/ai.ts
var TEXT_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/yaml",
  "application/x-yaml",
  "application/toml"
];
function isTextMimeType(mimeType) {
  return TEXT_MIME_PREFIXES.some(
    (prefix) => mimeType === prefix || mimeType.startsWith(prefix)
  );
}
async function attachmentToPart(att) {
  if (att.type === "image") {
    if (att.fetchData) {
      try {
        const buffer = await att.fetchData();
        const mimeType = att.mimeType ?? "image/png";
        return {
          type: "file",
          data: `data:${mimeType};base64,${buffer.toString("base64")}`,
          mediaType: mimeType,
          filename: att.name
        };
      } catch (error) {
        console.error("toAiMessages: failed to fetch image data", error);
        return null;
      }
    }
    return null;
  }
  if (att.type === "file" && att.mimeType && isTextMimeType(att.mimeType)) {
    if (att.fetchData) {
      try {
        const buffer = await att.fetchData();
        return {
          type: "file",
          data: `data:${att.mimeType};base64,${buffer.toString("base64")}`,
          filename: att.name,
          mediaType: att.mimeType
        };
      } catch (error) {
        console.error("toAiMessages: failed to fetch file data", error);
        return null;
      }
    }
    return null;
  }
  return null;
}
async function toAiMessages(messages, options) {
  const includeNames = options?.includeNames ?? false;
  const transformMessage = options?.transformMessage;
  const onUnsupported = options?.onUnsupportedAttachment ?? ((att) => {
    console.warn(
      `toAiMessages: unsupported attachment type "${att.type}"${att.name ? ` (${att.name})` : ""} \u2014 skipped`
    );
  });
  const sorted = [...messages].sort(
    (a, b) => (a.metadata.dateSent?.getTime() ?? 0) - (b.metadata.dateSent?.getTime() ?? 0)
  );
  const filtered = sorted.filter((msg) => msg.text.trim());
  const results = await Promise.all(
    filtered.map(async (msg) => {
      const role = msg.author.isMe ? "assistant" : "user";
      let textContent = includeNames && role === "user" ? `[${msg.author.userName}]: ${msg.text}` : msg.text;
      if (msg.links.length > 0) {
        const linkParts = msg.links.map((link2) => {
          const parts = link2.fetchMessage ? [`[Embedded message: ${link2.url}]`] : [link2.url];
          if (link2.title) {
            parts.push(`Title: ${link2.title}`);
          }
          if (link2.description) {
            parts.push(`Description: ${link2.description}`);
          }
          if (link2.siteName) {
            parts.push(`Site: ${link2.siteName}`);
          }
          return parts.join("\n");
        }).join("\n\n");
        textContent += `

Links:
${linkParts}`;
      }
      let aiMessage;
      if (role === "user") {
        const attachmentParts = [];
        for (const att of msg.attachments) {
          const part = await attachmentToPart(att);
          if (part) {
            attachmentParts.push(part);
          } else if (att.type === "video" || att.type === "audio") {
            onUnsupported(att, msg);
          }
        }
        if (attachmentParts.length > 0) {
          aiMessage = {
            role,
            content: [
              { type: "text", text: textContent },
              ...attachmentParts
            ]
          };
        } else {
          aiMessage = { role, content: textContent };
        }
      } else {
        aiMessage = { role, content: textContent };
      }
      if (transformMessage) {
        return { result: await transformMessage(aiMessage, msg), source: msg };
      }
      return { result: aiMessage, source: msg };
    })
  );
  return results.filter(
    (r) => r.result != null
  ).map((r) => r.result);
}

// src/channel.ts
import { WORKFLOW_DESERIALIZE as WORKFLOW_DESERIALIZE2, WORKFLOW_SERIALIZE as WORKFLOW_SERIALIZE2 } from "@workflow/serde";

// src/chat-singleton.ts
var _singleton = null;
function setChatSingleton(chat) {
  _singleton = chat;
}
function getChatSingleton() {
  if (!_singleton) {
    throw new Error(
      "No Chat singleton registered. Call chat.registerSingleton() first."
    );
  }
  return _singleton;
}
function hasChatSingleton() {
  return _singleton !== null;
}

// src/from-full-stream.ts
var STREAM_CHUNK_TYPES = /* @__PURE__ */ new Set([
  "markdown_text",
  "task_update",
  "plan_update"
]);
async function* fromFullStream(stream) {
  let needsSeparator = false;
  let hasEmittedText = false;
  for await (const event of stream) {
    if (typeof event === "string") {
      yield event;
      continue;
    }
    if (event === null || typeof event !== "object" || !("type" in event)) {
      continue;
    }
    const typed = event;
    if (STREAM_CHUNK_TYPES.has(typed.type)) {
      yield event;
      continue;
    }
    const textContent = typed.text ?? typed.delta ?? typed.textDelta;
    if (typed.type === "text-delta" && typeof textContent === "string") {
      if (needsSeparator && hasEmittedText) {
        yield "\n\n";
      }
      needsSeparator = false;
      hasEmittedText = true;
      yield textContent;
    } else if (typed.type === "step-finish") {
      needsSeparator = true;
    }
  }
}

// src/message.ts
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
var Message = class _Message {
  /** Unique message ID */
  id;
  /** Thread this message belongs to */
  threadId;
  /** Plain text content (all formatting stripped) */
  text;
  /**
   * Structured formatting as an AST (mdast Root).
   * This is the canonical representation - use this for processing.
   * Use `stringifyMarkdown(message.formatted)` to get markdown string.
   */
  formatted;
  /** Platform-specific raw payload (escape hatch) */
  raw;
  /** Message author */
  author;
  /** Message metadata */
  metadata;
  /** Attachments */
  attachments;
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
  isMention;
  /** Links found in the message */
  links;
  constructor(data) {
    this.id = data.id;
    this.threadId = data.threadId;
    this.text = data.text;
    this.formatted = data.formatted;
    this.raw = data.raw;
    this.author = data.author;
    this.metadata = data.metadata;
    this.attachments = data.attachments;
    this.isMention = data.isMention;
    this.links = data.links ?? [];
  }
  /**
   * Serialize the message to a plain JSON object.
   * Use this to pass message data to external systems like workflow engines.
   *
   * Note: Attachment `data` (Buffer) and `fetchData` (function) are omitted
   * as they're not serializable.
   */
  toJSON() {
    return {
      _type: "chat:Message",
      id: this.id,
      threadId: this.threadId,
      text: this.text,
      formatted: this.formatted,
      raw: this.raw,
      author: {
        userId: this.author.userId,
        userName: this.author.userName,
        fullName: this.author.fullName,
        isBot: this.author.isBot,
        isMe: this.author.isMe
      },
      metadata: {
        dateSent: this.metadata.dateSent.toISOString(),
        edited: this.metadata.edited,
        editedAt: this.metadata.editedAt?.toISOString()
      },
      attachments: this.attachments.map((att) => ({
        type: att.type,
        url: att.url,
        name: att.name,
        mimeType: att.mimeType,
        size: att.size,
        width: att.width,
        height: att.height
      })),
      isMention: this.isMention,
      links: this.links.length > 0 ? this.links.map((link2) => ({
        url: link2.url,
        title: link2.title,
        description: link2.description,
        imageUrl: link2.imageUrl,
        siteName: link2.siteName
      })) : void 0
    };
  }
  /**
   * Reconstruct a Message from serialized JSON data.
   * Converts ISO date strings back to Date objects.
   */
  static fromJSON(json) {
    return new _Message({
      id: json.id,
      threadId: json.threadId,
      text: json.text,
      formatted: json.formatted,
      raw: json.raw,
      author: json.author,
      metadata: {
        dateSent: new Date(json.metadata.dateSent),
        edited: json.metadata.edited,
        editedAt: json.metadata.editedAt ? new Date(json.metadata.editedAt) : void 0
      },
      attachments: json.attachments,
      isMention: json.isMention,
      links: json.links
    });
  }
  /**
   * Serialize a Message instance for @workflow/serde.
   * This static method is automatically called by workflow serialization.
   */
  static [WORKFLOW_SERIALIZE](instance) {
    return instance.toJSON();
  }
  /**
   * Deserialize a Message from @workflow/serde.
   * This static method is automatically called by workflow deserialization.
   */
  static [WORKFLOW_DESERIALIZE](data) {
    return _Message.fromJSON(data);
  }
};

// src/errors.ts
var ChatError = class extends Error {
  code;
  cause;
  constructor(message, code, cause) {
    super(message);
    this.name = "ChatError";
    this.code = code;
    this.cause = cause;
  }
};
var RateLimitError = class extends ChatError {
  retryAfterMs;
  constructor(message, retryAfterMs, cause) {
    super(message, "RATE_LIMITED", cause);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
};
var LockError = class extends ChatError {
  constructor(message, cause) {
    super(message, "LOCK_FAILED", cause);
    this.name = "LockError";
  }
};
var NotImplementedError = class extends ChatError {
  feature;
  constructor(message, feature, cause) {
    super(message, "NOT_IMPLEMENTED", cause);
    this.name = "NotImplementedError";
    this.feature = feature;
  }
};

// src/logger.ts
var ConsoleLogger = class _ConsoleLogger {
  prefix;
  level;
  constructor(level = "info", prefix = "chat-sdk") {
    this.level = level;
    this.prefix = prefix;
  }
  shouldLog(level) {
    const levels = ["debug", "info", "warn", "error", "silent"];
    return levels.indexOf(level) >= levels.indexOf(this.level);
  }
  child(prefix) {
    return new _ConsoleLogger(this.level, `${this.prefix}:${prefix}`);
  }
  // eslint-disable-next-line no-console
  debug(message, ...args) {
    if (this.shouldLog("debug")) {
      console.debug(`[${this.prefix}] ${message}`, ...args);
    }
  }
  // eslint-disable-next-line no-console
  info(message, ...args) {
    if (this.shouldLog("info")) {
      console.info(`[${this.prefix}] ${message}`, ...args);
    }
  }
  // eslint-disable-next-line no-console
  warn(message, ...args) {
    if (this.shouldLog("warn")) {
      console.warn(`[${this.prefix}] ${message}`, ...args);
    }
  }
  // eslint-disable-next-line no-console
  error(message, ...args) {
    if (this.shouldLog("error")) {
      console.error(`[${this.prefix}] ${message}`, ...args);
    }
  }
};

// src/types.ts
var THREAD_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1e3;

// src/channel.ts
var CHANNEL_STATE_KEY_PREFIX = "channel-state:";
function isLazyConfig(config) {
  return "adapterName" in config && !("adapter" in config);
}
function isAsyncIterable(value) {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}
var ChannelImpl = class _ChannelImpl {
  id;
  isDM;
  _adapter;
  _adapterName;
  _stateAdapterInstance;
  _name = null;
  _messageHistory;
  constructor(config) {
    this.id = config.id;
    this.isDM = config.isDM ?? false;
    if (isLazyConfig(config)) {
      this._adapterName = config.adapterName;
    } else {
      this._adapter = config.adapter;
      this._stateAdapterInstance = config.stateAdapter;
      this._messageHistory = config.messageHistory;
    }
  }
  get adapter() {
    if (this._adapter) {
      return this._adapter;
    }
    if (!this._adapterName) {
      throw new Error("Channel has no adapter configured");
    }
    const chat = getChatSingleton();
    const adapter = chat.getAdapter(this._adapterName);
    if (!adapter) {
      throw new Error(
        `Adapter "${this._adapterName}" not found in Chat singleton`
      );
    }
    this._adapter = adapter;
    return adapter;
  }
  get _stateAdapter() {
    if (this._stateAdapterInstance) {
      return this._stateAdapterInstance;
    }
    const chat = getChatSingleton();
    this._stateAdapterInstance = chat.getState();
    return this._stateAdapterInstance;
  }
  get name() {
    return this._name;
  }
  get state() {
    return this._stateAdapter.get(
      `${CHANNEL_STATE_KEY_PREFIX}${this.id}`
    );
  }
  async setState(newState, options) {
    const key = `${CHANNEL_STATE_KEY_PREFIX}${this.id}`;
    if (options?.replace) {
      await this._stateAdapter.set(key, newState, THREAD_STATE_TTL_MS);
    } else {
      const existing = await this._stateAdapter.get(key);
      const merged = { ...existing, ...newState };
      await this._stateAdapter.set(key, merged, THREAD_STATE_TTL_MS);
    }
  }
  /**
   * Iterate messages newest first (backward from most recent).
   * Uses adapter.fetchChannelMessages if available, otherwise falls back
   * to adapter.fetchMessages with the channel ID.
   */
  get messages() {
    const adapter = this.adapter;
    const channelId = this.id;
    const messageHistory = this._messageHistory;
    return {
      async *[Symbol.asyncIterator]() {
        let cursor;
        let yieldedAny = false;
        while (true) {
          const fetchOptions = { cursor, direction: "backward" };
          const result = adapter.fetchChannelMessages ? await adapter.fetchChannelMessages(channelId, fetchOptions) : await adapter.fetchMessages(channelId, fetchOptions);
          const reversed = [...result.messages].reverse();
          for (const message of reversed) {
            yieldedAny = true;
            yield message;
          }
          if (!result.nextCursor || result.messages.length === 0) {
            break;
          }
          cursor = result.nextCursor;
        }
        if (!yieldedAny && messageHistory) {
          const cached = await messageHistory.getMessages(channelId);
          for (let i = cached.length - 1; i >= 0; i--) {
            yield cached[i];
          }
        }
      }
    };
  }
  /**
   * Iterate threads in this channel, most recently active first.
   */
  threads() {
    const adapter = this.adapter;
    const channelId = this.id;
    return {
      async *[Symbol.asyncIterator]() {
        if (!adapter.listThreads) {
          return;
        }
        let cursor;
        while (true) {
          const result = await adapter.listThreads(channelId, {
            cursor
          });
          for (const thread of result.threads) {
            yield thread;
          }
          if (!result.nextCursor || result.threads.length === 0) {
            break;
          }
          cursor = result.nextCursor;
        }
      }
    };
  }
  async fetchMetadata() {
    if (this.adapter.fetchChannelInfo) {
      const info = await this.adapter.fetchChannelInfo(this.id);
      this._name = info.name ?? null;
      return info;
    }
    return {
      id: this.id,
      isDM: this.isDM,
      metadata: {}
    };
  }
  async post(message) {
    if (isAsyncIterable(message)) {
      let accumulated = "";
      for await (const chunk of fromFullStream(message)) {
        if (typeof chunk === "string") {
          accumulated += chunk;
        }
      }
      return this.postSingleMessage({ markdown: accumulated });
    }
    let postable = message;
    if (isJSX(message)) {
      const card = toCardElement(message);
      if (!card) {
        throw new Error("Invalid JSX element: must be a Card element");
      }
      postable = card;
    }
    return this.postSingleMessage(postable);
  }
  async postSingleMessage(postable) {
    const rawMessage = this.adapter.postChannelMessage ? await this.adapter.postChannelMessage(this.id, postable) : await this.adapter.postMessage(this.id, postable);
    const sent = this.createSentMessage(
      rawMessage.id,
      postable,
      rawMessage.threadId
    );
    if (this._messageHistory) {
      await this._messageHistory.append(this.id, new Message(sent));
    }
    return sent;
  }
  async postEphemeral(user, message, options) {
    const { fallbackToDM } = options;
    const userId = typeof user === "string" ? user : user.userId;
    let postable;
    if (isJSX(message)) {
      const card = toCardElement(message);
      if (!card) {
        throw new Error("Invalid JSX element: must be a Card element");
      }
      postable = card;
    } else {
      postable = message;
    }
    if (this.adapter.postEphemeral) {
      return this.adapter.postEphemeral(this.id, userId, postable);
    }
    if (!fallbackToDM) {
      return null;
    }
    if (this.adapter.openDM) {
      const dmThreadId = await this.adapter.openDM(userId);
      const result = await this.adapter.postMessage(dmThreadId, postable);
      return {
        id: result.id,
        threadId: dmThreadId,
        usedFallback: true,
        raw: result.raw
      };
    }
    return null;
  }
  async schedule(message, options) {
    let postable;
    if (isJSX(message)) {
      const card = toCardElement(message);
      if (!card) {
        throw new Error("Invalid JSX element: must be a Card element");
      }
      postable = card;
    } else {
      postable = message;
    }
    if (!this.adapter.scheduleMessage) {
      throw new NotImplementedError(
        "Scheduled messages are not supported by this adapter",
        "scheduling"
      );
    }
    return this.adapter.scheduleMessage(this.id, postable, options);
  }
  async startTyping(status) {
    await this.adapter.startTyping(this.id, status);
  }
  mentionUser(userId) {
    return `<@${userId}>`;
  }
  toJSON() {
    return {
      _type: "chat:Channel",
      id: this.id,
      adapterName: this.adapter.name,
      isDM: this.isDM
    };
  }
  static fromJSON(json, adapter) {
    const channel = new _ChannelImpl({
      id: json.id,
      adapterName: json.adapterName,
      isDM: json.isDM
    });
    if (adapter) {
      channel._adapter = adapter;
    }
    return channel;
  }
  static [WORKFLOW_SERIALIZE2](instance) {
    return instance.toJSON();
  }
  static [WORKFLOW_DESERIALIZE2](data) {
    return _ChannelImpl.fromJSON(data);
  }
  createSentMessage(messageId, postable, threadIdOverride) {
    const adapter = this.adapter;
    const threadId = threadIdOverride || this.id;
    const self = this;
    const { plainText, formatted, attachments } = extractMessageContent(postable);
    const sentMessage = {
      id: messageId,
      threadId,
      text: plainText,
      formatted,
      raw: null,
      author: {
        userId: "self",
        userName: adapter.userName,
        fullName: adapter.userName,
        isBot: true,
        isMe: true
      },
      metadata: {
        dateSent: /* @__PURE__ */ new Date(),
        edited: false
      },
      attachments,
      links: [],
      toJSON() {
        return new Message(this).toJSON();
      },
      async edit(newContent) {
        let editPostable = newContent;
        if (isJSX(newContent)) {
          const card = toCardElement(newContent);
          if (!card) {
            throw new Error("Invalid JSX element: must be a Card element");
          }
          editPostable = card;
        }
        await adapter.editMessage(threadId, messageId, editPostable);
        return self.createSentMessage(messageId, editPostable);
      },
      async delete() {
        await adapter.deleteMessage(threadId, messageId);
      },
      async addReaction(emoji2) {
        await adapter.addReaction(threadId, messageId, emoji2);
      },
      async removeReaction(emoji2) {
        await adapter.removeReaction(threadId, messageId, emoji2);
      }
    };
    return sentMessage;
  }
};
function deriveChannelId(adapter, threadId) {
  return adapter.channelIdFromThreadId(threadId);
}
function extractMessageContent(message) {
  if (typeof message === "string") {
    return {
      plainText: message,
      formatted: root([paragraph([text(message)])]),
      attachments: []
    };
  }
  if ("raw" in message) {
    return {
      plainText: message.raw,
      formatted: root([paragraph([text(message.raw)])]),
      attachments: message.attachments || []
    };
  }
  if ("markdown" in message) {
    const ast = parseMarkdown(message.markdown);
    return {
      plainText: toPlainText(ast),
      formatted: ast,
      attachments: message.attachments || []
    };
  }
  if ("ast" in message) {
    return {
      plainText: toPlainText(message.ast),
      formatted: message.ast,
      attachments: message.attachments || []
    };
  }
  if ("card" in message) {
    const fallbackText = message.fallbackText || cardToFallbackText(message.card);
    return {
      plainText: fallbackText,
      formatted: root([paragraph([text(fallbackText)])]),
      attachments: []
    };
  }
  if ("type" in message && message.type === "card") {
    const fallbackText = cardToFallbackText(message);
    return {
      plainText: fallbackText,
      formatted: root([paragraph([text(fallbackText)])]),
      attachments: []
    };
  }
  throw new Error("Invalid PostableMessage format");
}

// src/message-history.ts
var DEFAULT_MAX_MESSAGES = 100;
var DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var KEY_PREFIX = "msg-history:";
var MessageHistoryCache = class {
  state;
  maxMessages;
  ttlMs;
  constructor(state, config) {
    this.state = state;
    this.maxMessages = config?.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;
  }
  /**
   * Atomically append a message to the history for a thread.
   * Trims to maxMessages (keeps newest) and refreshes TTL.
   */
  async append(threadId, message) {
    const key = `${KEY_PREFIX}${threadId}`;
    const serialized = message.toJSON();
    serialized.raw = null;
    await this.state.appendToList(key, serialized, {
      maxLength: this.maxMessages,
      ttlMs: this.ttlMs
    });
  }
  /**
   * Get messages for a thread in chronological order (oldest first).
   *
   * @param threadId - The thread ID
   * @param limit - Optional limit on number of messages to return (returns newest N)
   */
  async getMessages(threadId, limit) {
    const key = `${KEY_PREFIX}${threadId}`;
    const stored = await this.state.getList(key);
    const sliced = limit && stored.length > limit ? stored.slice(stored.length - limit) : stored;
    return sliced.map((s) => Message.fromJSON(s));
  }
};

// src/thread.ts
import { WORKFLOW_DESERIALIZE as WORKFLOW_DESERIALIZE3, WORKFLOW_SERIALIZE as WORKFLOW_SERIALIZE3 } from "@workflow/serde";

// src/streaming-markdown.ts
import remend from "remend";
var StreamingMarkdownRenderer = class {
  accumulated = "";
  dirty = true;
  cachedRender = "";
  finished = false;
  /** Number of code fence toggles from completed lines (odd = inside). */
  fenceToggles = 0;
  /** Incomplete trailing line buffer for incremental fence tracking. */
  incompleteLine = "";
  /** Append a chunk from the LLM stream. */
  push(chunk) {
    this.accumulated += chunk;
    this.dirty = true;
    this.incompleteLine += chunk;
    const parts = this.incompleteLine.split("\n");
    this.incompleteLine = parts.pop() ?? "";
    for (const line of parts) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        this.fenceToggles++;
      }
    }
  }
  /** O(1) check if accumulated text is inside an unclosed code fence. */
  isAccumulatedInsideFence() {
    let inside = this.fenceToggles % 2 === 1;
    const trimmed = this.incompleteLine.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inside = !inside;
    }
    return inside;
  }
  /**
   * Get renderable markdown for an intermediate edit.
   * - Holds back trailing lines that look like a table header (|...|)
   *   until a separator line (|---|---|) confirms or the next line denies.
   * - Applies remend() to close incomplete inline markers.
   * - Idempotent: returns cached result if no push() since last call.
   */
  render() {
    if (!this.dirty) {
      return this.cachedRender;
    }
    this.dirty = false;
    if (this.finished) {
      this.cachedRender = remend(this.accumulated);
      return this.cachedRender;
    }
    if (this.isAccumulatedInsideFence()) {
      this.cachedRender = remend(this.accumulated);
      return this.cachedRender;
    }
    const committable = getCommittablePrefix(this.accumulated);
    this.cachedRender = remend(committable);
    return this.cachedRender;
  }
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
  getCommittableText() {
    if (this.finished) {
      return wrapTablesForAppend(this.accumulated, true);
    }
    let text2 = this.accumulated;
    if (text2.length > 0 && !text2.endsWith("\n")) {
      const lastNewline = text2.lastIndexOf("\n");
      const withoutIncompleteLine = lastNewline >= 0 ? text2.slice(0, lastNewline + 1) : "";
      if (isInsideCodeFence(withoutIncompleteLine)) {
        return wrapTablesForAppend(text2);
      }
      text2 = withoutIncompleteLine;
    }
    if (isInsideCodeFence(text2)) {
      return wrapTablesForAppend(text2);
    }
    const committed = getCommittablePrefix(text2);
    const wrapped = wrapTablesForAppend(committed);
    if (isInsideCodeFence(wrapped)) {
      return wrapped;
    }
    return findCleanPrefix(wrapped);
  }
  /** Raw accumulated text (no remend, no buffering). For the final edit. */
  getText() {
    return this.accumulated;
  }
  /** Signal stream end. Flushes held-back lines. Returns final render. */
  finish() {
    this.finished = true;
    this.dirty = true;
    return this.render();
  }
};
var INLINE_MARKER_CHARS = /* @__PURE__ */ new Set(["*", "~", "`", "["]);
function isClean(text2) {
  return remend(text2).length <= text2.length;
}
function findCleanPrefix(text2) {
  if (text2.length === 0 || isClean(text2)) {
    return text2;
  }
  for (let i = text2.length - 1; i >= 0; i--) {
    if (INLINE_MARKER_CHARS.has(text2[i])) {
      while (i > 0 && text2[i - 1] === text2[i]) {
        i--;
      }
      const candidate = text2.slice(0, i);
      if (isClean(candidate)) {
        return candidate;
      }
    }
  }
  return "";
}
var TABLE_ROW_RE = /^\|.*\|$/;
var TABLE_SEPARATOR_RE = /^\|[\s:]*-{1,}[\s:]*(\|[\s:]*-{1,}[\s:]*)*\|$/;
function isInsideCodeFence(text2) {
  let inside = false;
  for (const line of text2.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inside = !inside;
    }
  }
  return inside;
}
function getCommittablePrefix(text2) {
  const endsWithNewline = text2.endsWith("\n");
  const lines = text2.split("\n");
  if (!endsWithNewline && lines.length > 0) {
    lines.pop();
  }
  if (endsWithNewline && lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  let heldCount = 0;
  let separatorFound = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === "") {
      break;
    }
    if (TABLE_SEPARATOR_RE.test(trimmed)) {
      separatorFound = true;
      break;
    }
    if (TABLE_ROW_RE.test(trimmed)) {
      heldCount++;
    } else {
      break;
    }
  }
  if (separatorFound || heldCount === 0) {
    return text2;
  }
  const commitLineCount = lines.length - heldCount;
  const committedLines = lines.slice(0, commitLineCount);
  let result = committedLines.join("\n");
  if (committedLines.length > 0) {
    result += "\n";
  }
  return result;
}
function wrapTablesForAppend(text2, closeFences = false) {
  const hadTrailingNewline = text2.endsWith("\n");
  const lines = text2.split("\n");
  if (hadTrailingNewline && lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  const result = [];
  let inTable = false;
  let inUserCodeFence = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!inTable && (trimmed.startsWith("```") || trimmed.startsWith("~~~"))) {
      inUserCodeFence = !inUserCodeFence;
      result.push(lines[i]);
      continue;
    }
    if (inUserCodeFence) {
      result.push(lines[i]);
      continue;
    }
    const isTableLine = trimmed !== "" && (TABLE_ROW_RE.test(trimmed) || TABLE_SEPARATOR_RE.test(trimmed));
    if (isTableLine && !inTable) {
      let hasSeparator = false;
      for (let j = i; j < lines.length; j++) {
        const t = lines[j].trim();
        if (TABLE_SEPARATOR_RE.test(t)) {
          hasSeparator = true;
          break;
        }
        if (t === "" || !TABLE_ROW_RE.test(t)) {
          break;
        }
      }
      if (hasSeparator) {
        result.push("```");
        inTable = true;
      }
    } else if (!isTableLine && inTable) {
      result.push("```");
      inTable = false;
    }
    result.push(lines[i]);
  }
  if (inTable && closeFences) {
    result.push("```");
  }
  let output = result.join("\n");
  if (hadTrailingNewline) {
    output += "\n";
  }
  return output;
}

// src/thread.ts
function isLazyConfig2(config) {
  return "adapterName" in config && !("adapter" in config);
}
var THREAD_STATE_KEY_PREFIX = "thread-state:";
function isAsyncIterable2(value) {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}
var ThreadImpl = class _ThreadImpl {
  id;
  channelId;
  isDM;
  /** Direct adapter instance (if provided) */
  _adapter;
  /** Adapter name for lazy resolution */
  _adapterName;
  /** Direct state adapter instance (if provided) */
  _stateAdapterInstance;
  _recentMessages = [];
  _isSubscribedContext;
  /** Current message context for streaming - provides userId/teamId */
  _currentMessage;
  /** Update interval for fallback streaming */
  _streamingUpdateIntervalMs;
  /** Placeholder text for fallback streaming (post + edit) */
  _fallbackStreamingPlaceholderText;
  /** Cached channel instance */
  _channel;
  /** Message history cache (set only for adapters with persistMessageHistory) */
  _messageHistory;
  _logger;
  constructor(config) {
    this.id = config.id;
    this.channelId = config.channelId;
    this.isDM = config.isDM ?? false;
    this._isSubscribedContext = config.isSubscribedContext ?? false;
    this._currentMessage = config.currentMessage;
    this._logger = config.logger;
    this._streamingUpdateIntervalMs = config.streamingUpdateIntervalMs ?? 500;
    this._fallbackStreamingPlaceholderText = config.fallbackStreamingPlaceholderText !== void 0 ? config.fallbackStreamingPlaceholderText : "...";
    if (isLazyConfig2(config)) {
      this._adapterName = config.adapterName;
    } else {
      this._adapter = config.adapter;
      this._stateAdapterInstance = config.stateAdapter;
      this._messageHistory = config.messageHistory;
    }
    if (config.initialMessage) {
      this._recentMessages = [config.initialMessage];
    }
  }
  /**
   * Get the adapter for this thread.
   * If created with lazy config, resolves from Chat singleton on first access.
   */
  get adapter() {
    if (this._adapter) {
      return this._adapter;
    }
    if (!this._adapterName) {
      throw new Error("Thread has no adapter configured");
    }
    const chat = getChatSingleton();
    const adapter = chat.getAdapter(this._adapterName);
    if (!adapter) {
      throw new Error(
        `Adapter "${this._adapterName}" not found in Chat singleton`
      );
    }
    this._adapter = adapter;
    return adapter;
  }
  /**
   * Get the state adapter for this thread.
   * If created with lazy config, resolves from Chat singleton on first access.
   */
  get _stateAdapter() {
    if (this._stateAdapterInstance) {
      return this._stateAdapterInstance;
    }
    const chat = getChatSingleton();
    this._stateAdapterInstance = chat.getState();
    return this._stateAdapterInstance;
  }
  get recentMessages() {
    return this._recentMessages;
  }
  set recentMessages(messages) {
    this._recentMessages = messages;
  }
  /**
   * Get the current thread state.
   * Returns null if no state has been set.
   */
  get state() {
    return this._stateAdapter.get(
      `${THREAD_STATE_KEY_PREFIX}${this.id}`
    );
  }
  /**
   * Set the thread state. Merges with existing state by default.
   * State is persisted for 30 days.
   */
  async setState(newState, options) {
    const key = `${THREAD_STATE_KEY_PREFIX}${this.id}`;
    if (options?.replace) {
      await this._stateAdapter.set(key, newState, THREAD_STATE_TTL_MS);
    } else {
      const existing = await this._stateAdapter.get(key);
      const merged = { ...existing, ...newState };
      await this._stateAdapter.set(key, merged, THREAD_STATE_TTL_MS);
    }
  }
  /**
   * Get the Channel containing this thread.
   * Lazy-created and cached.
   */
  get channel() {
    if (!this._channel) {
      const channelId = deriveChannelId(this.adapter, this.id);
      this._channel = new ChannelImpl({
        id: channelId,
        adapter: this.adapter,
        stateAdapter: this._stateAdapter,
        isDM: this.isDM,
        messageHistory: this._messageHistory
      });
    }
    return this._channel;
  }
  /**
   * Iterate messages newest first (backward from most recent).
   * Auto-paginates lazily.
   */
  get messages() {
    const adapter = this.adapter;
    const threadId = this.id;
    const messageHistory = this._messageHistory;
    return {
      async *[Symbol.asyncIterator]() {
        let cursor;
        let yieldedAny = false;
        while (true) {
          const result = await adapter.fetchMessages(threadId, {
            cursor,
            direction: "backward"
          });
          const reversed = [...result.messages].reverse();
          for (const message of reversed) {
            yieldedAny = true;
            yield message;
          }
          if (!result.nextCursor || result.messages.length === 0) {
            break;
          }
          cursor = result.nextCursor;
        }
        if (!yieldedAny && messageHistory) {
          const cached = await messageHistory.getMessages(threadId);
          for (let i = cached.length - 1; i >= 0; i--) {
            yield cached[i];
          }
        }
      }
    };
  }
  get allMessages() {
    const adapter = this.adapter;
    const threadId = this.id;
    const messageHistory = this._messageHistory;
    return {
      async *[Symbol.asyncIterator]() {
        let cursor;
        let yieldedAny = false;
        while (true) {
          const result = await adapter.fetchMessages(threadId, {
            limit: 100,
            cursor,
            direction: "forward"
          });
          for (const message of result.messages) {
            yieldedAny = true;
            yield message;
          }
          if (!result.nextCursor || result.messages.length === 0) {
            break;
          }
          cursor = result.nextCursor;
        }
        if (!yieldedAny && messageHistory) {
          const cached = await messageHistory.getMessages(threadId);
          for (const message of cached) {
            yield message;
          }
        }
      }
    };
  }
  async isSubscribed() {
    if (this._isSubscribedContext) {
      return true;
    }
    return this._stateAdapter.isSubscribed(this.id);
  }
  async subscribe() {
    await this._stateAdapter.subscribe(this.id);
    if (this.adapter.onThreadSubscribe) {
      await this.adapter.onThreadSubscribe(this.id);
    }
  }
  async unsubscribe() {
    await this._stateAdapter.unsubscribe(this.id);
  }
  async post(message) {
    if (isAsyncIterable2(message)) {
      return this.handleStream(message);
    }
    let postable = message;
    if (isJSX(message)) {
      const card = toCardElement(message);
      if (!card) {
        throw new Error("Invalid JSX element: must be a Card element");
      }
      postable = card;
    }
    const rawMessage = await this.adapter.postMessage(this.id, postable);
    const result = this.createSentMessage(
      rawMessage.id,
      postable,
      rawMessage.threadId
    );
    if (this._messageHistory) {
      await this._messageHistory.append(this.id, new Message(result));
    }
    return result;
  }
  async postEphemeral(user, message, options) {
    const { fallbackToDM } = options;
    const userId = typeof user === "string" ? user : user.userId;
    let postable;
    if (isJSX(message)) {
      const card = toCardElement(message);
      if (!card) {
        throw new Error("Invalid JSX element: must be a Card element");
      }
      postable = card;
    } else {
      postable = message;
    }
    if (this.adapter.postEphemeral) {
      return this.adapter.postEphemeral(this.id, userId, postable);
    }
    if (!fallbackToDM) {
      return null;
    }
    if (this.adapter.openDM) {
      const dmThreadId = await this.adapter.openDM(userId);
      const result = await this.adapter.postMessage(dmThreadId, postable);
      return {
        id: result.id,
        threadId: dmThreadId,
        usedFallback: true,
        raw: result.raw
      };
    }
    return null;
  }
  async schedule(message, options) {
    let postable;
    if (isJSX(message)) {
      const card = toCardElement(message);
      if (!card) {
        throw new Error("Invalid JSX element: must be a Card element");
      }
      postable = card;
    } else {
      postable = message;
    }
    if (!this.adapter.scheduleMessage) {
      throw new NotImplementedError(
        "Scheduled messages are not supported by this adapter",
        "scheduling"
      );
    }
    return this.adapter.scheduleMessage(this.id, postable, options);
  }
  /**
   * Handle streaming from an AsyncIterable.
   * Normalizes the stream (supports both textStream and fullStream from AI SDK),
   * then uses adapter's native streaming if available, otherwise falls back to post+edit.
   */
  async handleStream(rawStream) {
    const textStream = fromFullStream(rawStream);
    const options = {};
    if (this._currentMessage) {
      options.recipientUserId = this._currentMessage.author.userId;
      const raw = this._currentMessage.raw;
      options.recipientTeamId = raw?.team_id ?? raw?.team;
    }
    if (this.adapter.stream) {
      let accumulated = "";
      const wrappedStream = {
        [Symbol.asyncIterator]: () => {
          const iterator = textStream[Symbol.asyncIterator]();
          return {
            async next() {
              const result = await iterator.next();
              if (!result.done) {
                const value = result.value;
                if (typeof value === "string") {
                  accumulated += value;
                } else if (value.type === "markdown_text") {
                  accumulated += value.text;
                }
              }
              return result;
            }
          };
        }
      };
      const raw = await this.adapter.stream(this.id, wrappedStream, options);
      const sent = this.createSentMessage(
        raw.id,
        { markdown: accumulated },
        raw.threadId
      );
      if (this._messageHistory) {
        await this._messageHistory.append(this.id, new Message(sent));
      }
      return sent;
    }
    const textOnlyStream = {
      [Symbol.asyncIterator]: () => {
        const iterator = textStream[Symbol.asyncIterator]();
        return {
          async next() {
            while (true) {
              const result = await iterator.next();
              if (result.done) {
                return { value: void 0, done: true };
              }
              const value = result.value;
              if (typeof value === "string") {
                return { value, done: false };
              }
              if (value.type === "markdown_text") {
                return { value: value.text, done: false };
              }
            }
          }
        };
      }
    };
    return this.fallbackStream(textOnlyStream, options);
  }
  async startTyping(status) {
    await this.adapter.startTyping(this.id, status);
  }
  /**
   * Fallback streaming implementation using post + edit.
   * Used when adapter doesn't support native streaming.
   * Uses recursive setTimeout to send updates every intervalMs (default 500ms).
   * Schedules next update only after current edit completes to avoid overwhelming slow services.
   */
  async fallbackStream(textStream, options) {
    const intervalMs = options?.updateIntervalMs ?? this._streamingUpdateIntervalMs;
    const placeholderText = this._fallbackStreamingPlaceholderText;
    let msg = placeholderText === null ? null : await this.adapter.postMessage(this.id, placeholderText);
    let threadIdForEdits = this.id;
    const renderer = new StreamingMarkdownRenderer();
    let lastEditContent = "";
    let stopped = false;
    let pendingEdit = null;
    let timerId = null;
    if (msg) {
      threadIdForEdits = msg.threadId || this.id;
      lastEditContent = placeholderText ?? "";
    }
    const scheduleNextEdit = () => {
      timerId = setTimeout(() => {
        pendingEdit = doEditAndReschedule();
      }, intervalMs);
    };
    const doEditAndReschedule = async () => {
      if (stopped || !msg) {
        return;
      }
      const content = renderer.render();
      if (content !== lastEditContent) {
        try {
          await this.adapter.editMessage(threadIdForEdits, msg.id, {
            markdown: content
          });
          lastEditContent = content;
        } catch (error) {
          this._logger?.warn("fallbackStream edit failed", error);
        }
      }
      if (!stopped) {
        scheduleNextEdit();
      }
    };
    if (msg) {
      scheduleNextEdit();
    }
    try {
      for await (const chunk of textStream) {
        renderer.push(chunk);
        if (!msg) {
          const content = renderer.render();
          msg = await this.adapter.postMessage(this.id, {
            markdown: content
          });
          threadIdForEdits = msg.threadId || this.id;
          lastEditContent = content;
          scheduleNextEdit();
        }
      }
    } finally {
      stopped = true;
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
    }
    if (pendingEdit) {
      await pendingEdit;
    }
    const accumulated = renderer.getText();
    const finalContent = renderer.finish();
    if (!msg) {
      msg = await this.adapter.postMessage(this.id, {
        markdown: accumulated
      });
      threadIdForEdits = msg.threadId || this.id;
      lastEditContent = accumulated;
    }
    if (finalContent !== lastEditContent) {
      await this.adapter.editMessage(threadIdForEdits, msg.id, {
        markdown: accumulated
      });
    }
    const sent = this.createSentMessage(
      msg.id,
      { markdown: accumulated },
      threadIdForEdits
    );
    if (this._messageHistory) {
      await this._messageHistory.append(this.id, new Message(sent));
    }
    return sent;
  }
  async refresh() {
    const result = await this.adapter.fetchMessages(this.id, { limit: 50 });
    if (result.messages.length > 0) {
      this._recentMessages = result.messages;
    } else if (this._messageHistory) {
      this._recentMessages = await this._messageHistory.getMessages(
        this.id,
        50
      );
    } else {
      this._recentMessages = [];
    }
  }
  mentionUser(userId) {
    return `<@${userId}>`;
  }
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
  toJSON() {
    return {
      _type: "chat:Thread",
      id: this.id,
      channelId: this.channelId,
      currentMessage: this._currentMessage?.toJSON(),
      isDM: this.isDM,
      adapterName: this.adapter.name
    };
  }
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
  static fromJSON(json, adapter) {
    const thread = new _ThreadImpl({
      id: json.id,
      adapterName: json.adapterName,
      channelId: json.channelId,
      currentMessage: json.currentMessage ? Message.fromJSON(json.currentMessage) : void 0,
      isDM: json.isDM
    });
    if (adapter) {
      thread._adapter = adapter;
    }
    return thread;
  }
  /**
   * Serialize a ThreadImpl instance for @workflow/serde.
   * This static method is automatically called by workflow serialization.
   */
  static [WORKFLOW_SERIALIZE3](instance) {
    return instance.toJSON();
  }
  /**
   * Deserialize a ThreadImpl from @workflow/serde.
   * Uses lazy adapter resolution from Chat.getSingleton().
   * Requires chat.registerSingleton() to have been called.
   */
  static [WORKFLOW_DESERIALIZE3](data) {
    return _ThreadImpl.fromJSON(data);
  }
  createSentMessage(messageId, postable, threadIdOverride) {
    const adapter = this.adapter;
    const threadId = threadIdOverride || this.id;
    const self = this;
    const { plainText, formatted, attachments } = extractMessageContent2(postable);
    const sentMessage = {
      id: messageId,
      threadId,
      text: plainText,
      formatted,
      raw: null,
      // Will be populated if needed
      links: [],
      author: {
        userId: "self",
        userName: adapter.userName,
        fullName: adapter.userName,
        isBot: true,
        isMe: true
      },
      metadata: {
        dateSent: /* @__PURE__ */ new Date(),
        edited: false
      },
      attachments,
      toJSON() {
        return new Message(this).toJSON();
      },
      async edit(newContent) {
        let postable2 = newContent;
        if (isJSX(newContent)) {
          const card = toCardElement(newContent);
          if (!card) {
            throw new Error("Invalid JSX element: must be a Card element");
          }
          postable2 = card;
        }
        await adapter.editMessage(threadId, messageId, postable2);
        return self.createSentMessage(messageId, postable2);
      },
      async delete() {
        await adapter.deleteMessage(threadId, messageId);
      },
      async addReaction(emoji2) {
        await adapter.addReaction(threadId, messageId, emoji2);
      },
      async removeReaction(emoji2) {
        await adapter.removeReaction(threadId, messageId, emoji2);
      }
    };
    return sentMessage;
  }
  createSentMessageFromMessage(message) {
    const adapter = this.adapter;
    const threadId = this.id;
    const messageId = message.id;
    const self = this;
    return {
      id: message.id,
      threadId: message.threadId,
      text: message.text,
      formatted: message.formatted,
      raw: message.raw,
      author: message.author,
      metadata: message.metadata,
      attachments: message.attachments,
      links: message.links,
      isMention: message.isMention,
      toJSON() {
        return message.toJSON();
      },
      async edit(newContent) {
        let postable = newContent;
        if (isJSX(newContent)) {
          const card = toCardElement(newContent);
          if (!card) {
            throw new Error("Invalid JSX element: must be a Card element");
          }
          postable = card;
        }
        await adapter.editMessage(threadId, messageId, postable);
        return self.createSentMessage(messageId, postable, threadId);
      },
      async delete() {
        await adapter.deleteMessage(threadId, messageId);
      },
      async addReaction(emoji2) {
        await adapter.addReaction(threadId, messageId, emoji2);
      },
      async removeReaction(emoji2) {
        await adapter.removeReaction(threadId, messageId, emoji2);
      }
    };
  }
};
function extractMessageContent2(message) {
  if (typeof message === "string") {
    return {
      plainText: message,
      formatted: root([paragraph([text(message)])]),
      attachments: []
    };
  }
  if ("raw" in message) {
    return {
      plainText: message.raw,
      formatted: root([paragraph([text(message.raw)])]),
      attachments: message.attachments || []
    };
  }
  if ("markdown" in message) {
    const ast = parseMarkdown(message.markdown);
    return {
      plainText: toPlainText(ast),
      formatted: ast,
      attachments: message.attachments || []
    };
  }
  if ("ast" in message) {
    return {
      plainText: toPlainText(message.ast),
      formatted: message.ast,
      attachments: message.attachments || []
    };
  }
  if ("card" in message) {
    const fallbackText = message.fallbackText || cardToFallbackText(message.card);
    return {
      plainText: fallbackText,
      formatted: root([paragraph([text(fallbackText)])]),
      attachments: []
    };
  }
  if ("type" in message && message.type === "card") {
    const fallbackText = cardToFallbackText(message);
    return {
      plainText: fallbackText,
      formatted: root([paragraph([text(fallbackText)])]),
      attachments: []
    };
  }
  throw new Error("Invalid PostableMessage format");
}

// src/chat.ts
var DEFAULT_LOCK_TTL_MS = 3e4;
var SLACK_USER_ID_REGEX = /^U[A-Z0-9]+$/i;
var DISCORD_SNOWFLAKE_REGEX = /^\d{17,19}$/;
var DEDUPE_TTL_MS = 5 * 60 * 1e3;
var MODAL_CONTEXT_TTL_MS = 24 * 60 * 60 * 1e3;
var Chat = class {
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
  registerSingleton() {
    setChatSingleton(this);
    return this;
  }
  /**
   * Get the registered singleton Chat instance.
   * Throws if no singleton has been registered.
   */
  static getSingleton() {
    return getChatSingleton();
  }
  /**
   * Check if a singleton has been registered.
   */
  static hasSingleton() {
    return hasChatSingleton();
  }
  adapters;
  _stateAdapter;
  userName;
  logger;
  _streamingUpdateIntervalMs;
  _fallbackStreamingPlaceholderText;
  _dedupeTtlMs;
  _onLockConflict;
  _messageHistory;
  mentionHandlers = [];
  directMessageHandlers = [];
  messagePatterns = [];
  subscribedMessageHandlers = [];
  reactionHandlers = [];
  actionHandlers = [];
  modalSubmitHandlers = [];
  modalCloseHandlers = [];
  slashCommandHandlers = [];
  assistantThreadStartedHandlers = [];
  assistantContextChangedHandlers = [];
  appHomeOpenedHandlers = [];
  memberJoinedChannelHandlers = [];
  /** Initialization state */
  initPromise = null;
  initialized = false;
  /**
   * Type-safe webhook handlers keyed by adapter name.
   * @example
   * chat.webhooks.slack(request, { backgroundTask: waitUntil });
   */
  webhooks;
  constructor(config) {
    this.userName = config.userName;
    this._stateAdapter = config.state;
    this.adapters = /* @__PURE__ */ new Map();
    this._streamingUpdateIntervalMs = config.streamingUpdateIntervalMs ?? 500;
    this._fallbackStreamingPlaceholderText = config.fallbackStreamingPlaceholderText !== void 0 ? config.fallbackStreamingPlaceholderText : "...";
    this._dedupeTtlMs = config.dedupeTtlMs ?? DEDUPE_TTL_MS;
    this._onLockConflict = config.onLockConflict;
    this._messageHistory = new MessageHistoryCache(
      this._stateAdapter,
      config.messageHistory
    );
    if (typeof config.logger === "string") {
      this.logger = new ConsoleLogger(config.logger);
    } else {
      this.logger = config.logger || new ConsoleLogger("info");
    }
    const webhooks = {};
    for (const [name, adapter] of Object.entries(config.adapters)) {
      this.adapters.set(name, adapter);
      webhooks[name] = (request, options) => this.handleWebhook(name, request, options);
    }
    this.webhooks = webhooks;
    this.logger.debug("Chat instance created", {
      adapters: Object.keys(config.adapters)
    });
  }
  /**
   * Handle a webhook request for a specific adapter.
   * Automatically initializes adapters on first call.
   */
  async handleWebhook(adapterName, request, options) {
    await this.ensureInitialized();
    const adapter = this.adapters.get(adapterName);
    if (!adapter) {
      return new Response(`Unknown adapter: ${adapterName}`, { status: 404 });
    }
    return adapter.handleWebhook(request, options);
  }
  /**
   * Ensure the chat instance is initialized.
   * This is called automatically before handling webhooks.
   */
  async ensureInitialized() {
    if (this.initialized) {
      return;
    }
    if (!this.initPromise) {
      this.initPromise = this.doInitialize();
    }
    await this.initPromise;
  }
  async doInitialize() {
    this.logger.info("Initializing chat instance...");
    await this._stateAdapter.connect();
    this.logger.debug("State connected");
    const initPromises = Array.from(this.adapters.values()).map(
      async (adapter) => {
        this.logger.debug("Initializing adapter", adapter.name);
        const result = await adapter.initialize(this);
        this.logger.debug("Adapter initialized", adapter.name);
        return result;
      }
    );
    await Promise.all(initPromises);
    this.initialized = true;
    this.logger.info("Chat instance initialized", {
      adapters: Array.from(this.adapters.keys())
    });
  }
  /**
   * Gracefully shut down the chat instance.
   */
  async shutdown() {
    this.logger.info("Shutting down chat instance...");
    await this._stateAdapter.disconnect();
    this.initialized = false;
    this.initPromise = null;
    this.logger.info("Chat instance shut down");
  }
  /**
   * Initialize the chat instance and all adapters.
   * This is called automatically when handling webhooks, but can be called
   * manually for non-webhook use cases (e.g., Gateway listeners).
   */
  async initialize() {
    await this.ensureInitialized();
  }
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
  onNewMention(handler) {
    this.mentionHandlers.push(handler);
    this.logger.debug("Registered mention handler");
  }
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
  onDirectMessage(handler) {
    this.directMessageHandlers.push(handler);
    this.logger.debug("Registered direct message handler");
  }
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
  onNewMessage(pattern, handler) {
    this.messagePatterns.push({ pattern, handler });
    this.logger.debug("Registered message pattern handler", {
      pattern: pattern.toString()
    });
  }
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
  onSubscribedMessage(handler) {
    this.subscribedMessageHandlers.push(handler);
    this.logger.debug("Registered subscribed message handler");
  }
  onReaction(emojiOrHandler, handler) {
    if (typeof emojiOrHandler === "function") {
      this.reactionHandlers.push({ emoji: [], handler: emojiOrHandler });
      this.logger.debug("Registered reaction handler for all emoji");
    } else if (handler) {
      this.reactionHandlers.push({ emoji: emojiOrHandler, handler });
      this.logger.debug("Registered reaction handler", {
        emoji: emojiOrHandler.map((e) => typeof e === "string" ? e : e.name)
      });
    }
  }
  onAction(actionIdOrHandler, handler) {
    if (typeof actionIdOrHandler === "function") {
      this.actionHandlers.push({ actionIds: [], handler: actionIdOrHandler });
      this.logger.debug("Registered action handler for all actions");
    } else if (handler) {
      const actionIds = Array.isArray(actionIdOrHandler) ? actionIdOrHandler : [actionIdOrHandler];
      this.actionHandlers.push({ actionIds, handler });
      this.logger.debug("Registered action handler", { actionIds });
    }
  }
  onModalSubmit(callbackIdOrHandler, handler) {
    if (typeof callbackIdOrHandler === "function") {
      this.modalSubmitHandlers.push({
        callbackIds: [],
        handler: callbackIdOrHandler
      });
      this.logger.debug("Registered modal submit handler for all modals");
    } else if (handler) {
      const callbackIds = Array.isArray(callbackIdOrHandler) ? callbackIdOrHandler : [callbackIdOrHandler];
      this.modalSubmitHandlers.push({ callbackIds, handler });
      this.logger.debug("Registered modal submit handler", { callbackIds });
    }
  }
  onModalClose(callbackIdOrHandler, handler) {
    if (typeof callbackIdOrHandler === "function") {
      this.modalCloseHandlers.push({
        callbackIds: [],
        handler: callbackIdOrHandler
      });
      this.logger.debug("Registered modal close handler for all modals");
    } else if (handler) {
      const callbackIds = Array.isArray(callbackIdOrHandler) ? callbackIdOrHandler : [callbackIdOrHandler];
      this.modalCloseHandlers.push({ callbackIds, handler });
      this.logger.debug("Registered modal close handler", { callbackIds });
    }
  }
  onSlashCommand(commandOrHandler, handler) {
    if (typeof commandOrHandler === "function") {
      this.slashCommandHandlers.push({
        commands: [],
        handler: commandOrHandler
      });
      this.logger.debug("Registered slash command handler for all commands");
    } else if (handler) {
      const commands = Array.isArray(commandOrHandler) ? commandOrHandler : [commandOrHandler];
      const normalizedCommands = commands.map(
        (cmd) => cmd.startsWith("/") ? cmd : `/${cmd}`
      );
      this.slashCommandHandlers.push({ commands: normalizedCommands, handler });
      this.logger.debug("Registered slash command handler", {
        commands: normalizedCommands
      });
    }
  }
  onAssistantThreadStarted(handler) {
    this.assistantThreadStartedHandlers.push(handler);
    this.logger.debug("Registered assistant thread started handler");
  }
  onAssistantContextChanged(handler) {
    this.assistantContextChangedHandlers.push(handler);
    this.logger.debug("Registered assistant context changed handler");
  }
  onAppHomeOpened(handler) {
    this.appHomeOpenedHandlers.push(handler);
    this.logger.debug("Registered app home opened handler");
  }
  onMemberJoinedChannel(handler) {
    this.memberJoinedChannelHandlers.push(handler);
    this.logger.debug("Registered member joined channel handler");
  }
  /**
   * Get an adapter by name with type safety.
   */
  getAdapter(name) {
    return this.adapters.get(name);
  }
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
  reviver() {
    this.registerSingleton();
    return function reviver(_key, value) {
      if (value && typeof value === "object" && "_type" in value) {
        const typed = value;
        if (typed._type === "chat:Thread") {
          return ThreadImpl.fromJSON(value);
        }
        if (typed._type === "chat:Channel") {
          return ChannelImpl.fromJSON(value);
        }
        if (typed._type === "chat:Message") {
          return Message.fromJSON(value);
        }
      }
      return value;
    };
  }
  // ChatInstance interface implementations
  /**
   * Process an incoming message from an adapter.
   * Handles waitUntil registration and error catching internally.
   * Adapters should call this instead of handleIncomingMessage directly.
   */
  processMessage(adapter, threadId, messageOrFactory, options) {
    const task = (async () => {
      const message = typeof messageOrFactory === "function" ? await messageOrFactory() : messageOrFactory;
      await this.handleIncomingMessage(adapter, threadId, message);
    })().catch((err) => {
      this.logger.error("Message processing error", { error: err, threadId });
    });
    if (options?.waitUntil) {
      options.waitUntil(task);
    }
  }
  /**
   * Process an incoming reaction event from an adapter.
   * Handles waitUntil registration and error catching internally.
   */
  processReaction(event, options) {
    const task = this.handleReactionEvent(event).catch((err) => {
      this.logger.error("Reaction processing error", {
        error: err,
        emoji: event.emoji,
        messageId: event.messageId
      });
    });
    if (options?.waitUntil) {
      options.waitUntil(task);
    }
  }
  /**
   * Process an incoming action event (button click) from an adapter.
   * Handles waitUntil registration and error catching internally.
   */
  processAction(event, options) {
    const task = this.handleActionEvent(event).catch((err) => {
      this.logger.error("Action processing error", {
        error: err,
        actionId: event.actionId,
        messageId: event.messageId
      });
    });
    if (options?.waitUntil) {
      options.waitUntil(task);
    }
  }
  async processModalSubmit(event, contextId, _options) {
    const { relatedThread, relatedMessage, relatedChannel } = await this.retrieveModalContext(event.adapter.name, contextId);
    const fullEvent = {
      ...event,
      relatedThread,
      relatedMessage,
      relatedChannel
    };
    for (const { callbackIds, handler } of this.modalSubmitHandlers) {
      if (callbackIds.length === 0 || callbackIds.includes(event.callbackId)) {
        try {
          const response = await handler(fullEvent);
          if (response) {
            return response;
          }
        } catch (err) {
          this.logger.error("Modal submit handler error", {
            error: err,
            callbackId: event.callbackId
          });
        }
      }
    }
  }
  processModalClose(event, contextId, options) {
    const task = (async () => {
      const { relatedThread, relatedMessage, relatedChannel } = await this.retrieveModalContext(event.adapter.name, contextId);
      const fullEvent = {
        ...event,
        relatedThread,
        relatedMessage,
        relatedChannel
      };
      for (const { callbackIds, handler } of this.modalCloseHandlers) {
        if (callbackIds.length === 0 || callbackIds.includes(event.callbackId)) {
          await handler(fullEvent);
        }
      }
    })().catch((err) => {
      this.logger.error("Modal close handler error", {
        error: err,
        callbackId: event.callbackId
      });
    });
    if (options?.waitUntil) {
      options.waitUntil(task);
    }
  }
  /**
   * Process an incoming slash command from an adapter.
   * Handles waitUntil registration and error catching internally.
   */
  processSlashCommand(event, options) {
    const task = this.handleSlashCommandEvent(event).catch((err) => {
      this.logger.error("Slash command processing error", {
        error: err,
        command: event.command,
        text: event.text
      });
    });
    if (options?.waitUntil) {
      options.waitUntil(task);
    }
  }
  processAssistantThreadStarted(event, options) {
    const task = (async () => {
      for (const handler of this.assistantThreadStartedHandlers) {
        await handler(event);
      }
    })().catch((err) => {
      this.logger.error("Assistant thread started handler error", {
        error: err,
        threadId: event.threadId
      });
    });
    if (options?.waitUntil) {
      options.waitUntil(task);
    }
  }
  processAssistantContextChanged(event, options) {
    const task = (async () => {
      for (const handler of this.assistantContextChangedHandlers) {
        await handler(event);
      }
    })().catch((err) => {
      this.logger.error("Assistant context changed handler error", {
        error: err,
        threadId: event.threadId
      });
    });
    if (options?.waitUntil) {
      options.waitUntil(task);
    }
  }
  processAppHomeOpened(event, options) {
    const task = (async () => {
      for (const handler of this.appHomeOpenedHandlers) {
        await handler(event);
      }
    })().catch((err) => {
      this.logger.error("App home opened handler error", {
        error: err,
        userId: event.userId
      });
    });
    if (options?.waitUntil) {
      options.waitUntil(task);
    }
  }
  processMemberJoinedChannel(event, options) {
    const task = (async () => {
      for (const handler of this.memberJoinedChannelHandlers) {
        await handler(event);
      }
    })().catch((err) => {
      this.logger.error("Member joined channel handler error", {
        error: err,
        channelId: event.channelId,
        userId: event.userId
      });
    });
    if (options?.waitUntil) {
      options.waitUntil(task);
    }
  }
  /**
   * Handle a slash command event internally.
   */
  async handleSlashCommandEvent(event) {
    this.logger.debug("Incoming slash command", {
      adapter: event.adapter.name,
      command: event.command,
      text: event.text,
      user: event.user.userName
    });
    if (event.user.isMe) {
      this.logger.debug("Skipping slash command from self", {
        command: event.command
      });
      return;
    }
    const channel = new ChannelImpl({
      id: event.channelId,
      adapter: event.adapter,
      stateAdapter: this._stateAdapter
    });
    const fullEvent = {
      ...event,
      channel,
      openModal: async (modal) => {
        if (!event.triggerId) {
          this.logger.warn("Cannot open modal: no triggerId available");
          return void 0;
        }
        if (!event.adapter.openModal) {
          this.logger.warn(
            `Cannot open modal: ${event.adapter.name} does not support modals`
          );
          return void 0;
        }
        let modalElement = modal;
        if (isJSX(modal)) {
          const converted = toModalElement(modal);
          if (!converted) {
            throw new Error("Invalid JSX element: must be a Modal element");
          }
          modalElement = converted;
        }
        const contextId = crypto.randomUUID();
        this.storeModalContext(
          event.adapter.name,
          contextId,
          void 0,
          void 0,
          channel
        );
        return event.adapter.openModal(
          event.triggerId,
          modalElement,
          contextId
        );
      }
    };
    this.logger.debug("Checking slash command handlers", {
      handlerCount: this.slashCommandHandlers.length,
      command: event.command
    });
    for (const { commands, handler } of this.slashCommandHandlers) {
      if (commands.length === 0) {
        this.logger.debug("Running catch-all slash command handler");
        await handler(fullEvent);
        continue;
      }
      if (commands.includes(event.command)) {
        this.logger.debug("Running matched slash command handler", {
          command: event.command
        });
        await handler(fullEvent);
      }
    }
  }
  /**
   * Store modal context server-side with a context ID.
   * Called when opening a modal to preserve thread/message/channel for the submit handler.
   */
  storeModalContext(adapterName, contextId, thread, message, channel) {
    const key = `modal-context:${adapterName}:${contextId}`;
    const context = {
      thread: thread?.toJSON(),
      message: message?.toJSON(),
      channel: channel?.toJSON()
    };
    this._stateAdapter.set(key, context, MODAL_CONTEXT_TTL_MS).catch((err) => {
      this.logger.error("Failed to store modal context", {
        contextId,
        error: err
      });
    });
  }
  /**
   * Retrieve and delete modal context from server-side storage.
   * Called when processing modal submit/close to reconstruct thread/message/channel.
   */
  async retrieveModalContext(adapterName, contextId) {
    if (!contextId) {
      return {
        relatedThread: void 0,
        relatedMessage: void 0,
        relatedChannel: void 0
      };
    }
    const key = `modal-context:${adapterName}:${contextId}`;
    const stored = await this._stateAdapter.get(key);
    if (!stored) {
      return {
        relatedThread: void 0,
        relatedMessage: void 0,
        relatedChannel: void 0
      };
    }
    const adapter = this.adapters.get(adapterName);
    let relatedThread;
    if (stored.thread) {
      relatedThread = ThreadImpl.fromJSON(stored.thread, adapter);
    }
    let relatedMessage;
    if (stored.message && relatedThread) {
      const message = Message.fromJSON(stored.message);
      relatedMessage = relatedThread.createSentMessageFromMessage(message);
    }
    let relatedChannel;
    if (stored.channel) {
      relatedChannel = ChannelImpl.fromJSON(stored.channel, adapter);
    }
    return { relatedThread, relatedMessage, relatedChannel };
  }
  /**
   * Handle an action event internally.
   */
  async handleActionEvent(event) {
    this.logger.debug("Incoming action", {
      adapter: event.adapter.name,
      actionId: event.actionId,
      value: event.value,
      user: event.user.userName,
      messageId: event.messageId,
      threadId: event.threadId
    });
    if (event.user.isMe) {
      this.logger.debug("Skipping action from self", {
        actionId: event.actionId
      });
      return;
    }
    const isSubscribed = false;
    const messageForThread = event.messageId ? new Message({
      id: event.messageId,
      threadId: event.threadId,
      text: "",
      formatted: { type: "root", children: [] },
      raw: event.raw,
      author: event.user,
      metadata: { dateSent: /* @__PURE__ */ new Date(), edited: false },
      attachments: []
    }) : {};
    const thread = event.threadId ? await this.createThread(
      event.adapter,
      event.threadId,
      messageForThread,
      isSubscribed
    ) : null;
    const fullEvent = {
      ...event,
      thread,
      openModal: async (modal) => {
        if (!event.triggerId) {
          this.logger.warn("Cannot open modal: no triggerId available");
          return void 0;
        }
        if (!event.adapter.openModal) {
          this.logger.warn(
            `Cannot open modal: ${event.adapter.name} does not support modals`
          );
          return void 0;
        }
        let modalElement = modal;
        if (isJSX(modal)) {
          const converted = toModalElement(modal);
          if (!converted) {
            throw new Error("Invalid JSX element: must be a Modal element");
          }
          modalElement = converted;
        }
        let message;
        if (thread) {
          const isEphemeralMessage = event.messageId?.startsWith("ephemeral:");
          if (isEphemeralMessage) {
            const recentMessage = thread.recentMessages[0];
            if (recentMessage && typeof recentMessage.toJSON === "function") {
              message = recentMessage;
            }
          } else if (event.messageId && event.adapter.fetchMessage) {
            const fetched = await event.adapter.fetchMessage(event.threadId, event.messageId).catch(() => null);
            if (fetched) {
              message = new Message(fetched);
            } else {
              const recentMessage = thread.recentMessages[0];
              if (recentMessage && typeof recentMessage.toJSON === "function") {
                message = recentMessage;
              }
            }
          }
        }
        const contextId = crypto.randomUUID();
        const channel = thread ? thread.channel : void 0;
        this.storeModalContext(
          event.adapter.name,
          contextId,
          thread ? thread : void 0,
          message,
          channel
        );
        return event.adapter.openModal(
          event.triggerId,
          modalElement,
          contextId
        );
      }
    };
    this.logger.debug("Checking action handlers", {
      handlerCount: this.actionHandlers.length,
      actionId: event.actionId
    });
    for (const { actionIds, handler } of this.actionHandlers) {
      if (actionIds.length === 0) {
        this.logger.debug("Running catch-all action handler");
        await handler(fullEvent);
        continue;
      }
      if (actionIds.includes(event.actionId)) {
        this.logger.debug("Running matched action handler", {
          actionId: event.actionId
        });
        await handler(fullEvent);
      }
    }
  }
  /**
   * Handle a reaction event internally.
   */
  async handleReactionEvent(event) {
    this.logger.debug("Incoming reaction", {
      adapter: event.adapter?.name,
      emoji: event.emoji,
      rawEmoji: event.rawEmoji,
      added: event.added,
      user: event.user.userName,
      messageId: event.messageId,
      threadId: event.threadId
    });
    if (event.user.isMe) {
      this.logger.debug("Skipping reaction from self", {
        emoji: event.emoji
      });
      return;
    }
    if (!event.adapter) {
      this.logger.error("Reaction event missing adapter");
      return;
    }
    const isSubscribed = await this._stateAdapter.isSubscribed(event.threadId);
    const thread = await this.createThread(
      event.adapter,
      event.threadId,
      event.message ?? {},
      isSubscribed
    );
    const fullEvent = {
      ...event,
      adapter: event.adapter,
      thread
    };
    this.logger.debug("Checking reaction handlers", {
      handlerCount: this.reactionHandlers.length,
      emoji: event.emoji.name,
      rawEmoji: event.rawEmoji
    });
    for (const { emoji: emojiFilter, handler } of this.reactionHandlers) {
      if (emojiFilter.length === 0) {
        this.logger.debug("Running catch-all reaction handler");
        await handler(fullEvent);
        continue;
      }
      const matches = emojiFilter.some((filter) => {
        if (filter === fullEvent.emoji) {
          return true;
        }
        const filterName = typeof filter === "string" ? filter : filter.name;
        return filterName === fullEvent.emoji.name || filterName === fullEvent.rawEmoji;
      });
      this.logger.debug("Reaction filter check", {
        filterEmoji: emojiFilter.map(
          (e) => typeof e === "string" ? e : e.name
        ),
        eventEmoji: fullEvent.emoji.name,
        matches
      });
      if (matches) {
        this.logger.debug("Running matched reaction handler");
        await handler(fullEvent);
      }
    }
  }
  getState() {
    return this._stateAdapter;
  }
  getUserName() {
    return this.userName;
  }
  getLogger(prefix) {
    if (prefix) {
      return this.logger.child(prefix);
    }
    return this.logger;
  }
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
  async openDM(user) {
    const userId = typeof user === "string" ? user : user.userId;
    const adapter = this.inferAdapterFromUserId(userId);
    if (!adapter.openDM) {
      throw new ChatError(
        `Adapter "${adapter.name}" does not support openDM`,
        "NOT_SUPPORTED"
      );
    }
    const threadId = await adapter.openDM(userId);
    return this.createThread(adapter, threadId, {}, false);
  }
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
  channel(channelId) {
    const adapterName = channelId.split(":")[0];
    if (!adapterName) {
      throw new ChatError(
        `Invalid channel ID: ${channelId}`,
        "INVALID_CHANNEL_ID"
      );
    }
    const adapter = this.adapters.get(adapterName);
    if (!adapter) {
      throw new ChatError(
        `Adapter "${adapterName}" not found for channel ID "${channelId}"`,
        "ADAPTER_NOT_FOUND"
      );
    }
    return new ChannelImpl({
      id: channelId,
      adapter,
      stateAdapter: this._stateAdapter
    });
  }
  /**
   * Infer which adapter to use based on the userId format.
   */
  inferAdapterFromUserId(userId) {
    if (userId.startsWith("users/")) {
      const adapter = this.adapters.get("gchat");
      if (adapter) {
        return adapter;
      }
    }
    if (userId.startsWith("29:")) {
      const adapter = this.adapters.get("teams");
      if (adapter) {
        return adapter;
      }
    }
    if (SLACK_USER_ID_REGEX.test(userId)) {
      const adapter = this.adapters.get("slack");
      if (adapter) {
        return adapter;
      }
    }
    if (DISCORD_SNOWFLAKE_REGEX.test(userId)) {
      const adapter = this.adapters.get("discord");
      if (adapter) {
        return adapter;
      }
    }
    throw new ChatError(
      `Cannot infer adapter from userId "${userId}". Expected format: Slack (U...), Teams (29:...), Google Chat (users/...), or Discord (numeric snowflake).`,
      "UNKNOWN_USER_ID_FORMAT"
    );
  }
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
  async handleIncomingMessage(adapter, threadId, message) {
    this.logger.debug("Incoming message", {
      adapter: adapter.name,
      threadId,
      messageId: message.id,
      text: message.text,
      author: message.author.userName,
      authorUserId: message.author.userId,
      isBot: message.author.isBot,
      isMe: message.author.isMe
    });
    if (message.author.isMe) {
      this.logger.debug("Skipping message from self (isMe=true)", {
        adapter: adapter.name,
        threadId,
        author: message.author.userName
      });
      return;
    }
    const dedupeKey = `dedupe:${adapter.name}:${message.id}`;
    const isFirstProcess = await this._stateAdapter.setIfNotExists(
      dedupeKey,
      true,
      this._dedupeTtlMs
    );
    if (!isFirstProcess) {
      this.logger.debug("Skipping duplicate message", {
        adapter: adapter.name,
        messageId: message.id
      });
      return;
    }
    if (adapter.persistMessageHistory) {
      const channelId = adapter.channelIdFromThreadId(threadId);
      const appends = [this._messageHistory.append(threadId, message)];
      if (channelId !== threadId) {
        appends.push(this._messageHistory.append(channelId, message));
      }
      await Promise.all(appends);
    }
    let lock = await this._stateAdapter.acquireLock(
      threadId,
      DEFAULT_LOCK_TTL_MS
    );
    if (!lock) {
      const resolution = typeof this._onLockConflict === "function" ? await this._onLockConflict(threadId, message) : this._onLockConflict ?? "drop";
      if (resolution === "force") {
        this.logger.info("Force-releasing lock on thread", { threadId });
        await this._stateAdapter.forceReleaseLock(threadId);
        lock = await this._stateAdapter.acquireLock(
          threadId,
          DEFAULT_LOCK_TTL_MS
        );
      }
      if (!lock) {
        this.logger.warn("Could not acquire lock on thread", { threadId });
        throw new LockError(
          `Could not acquire lock on thread ${threadId}. Another instance may be processing.`
        );
      }
    }
    this.logger.debug("Lock acquired", { threadId, token: lock.token });
    try {
      message.isMention = message.isMention || this.detectMention(adapter, message);
      const isSubscribed = await this._stateAdapter.isSubscribed(threadId);
      this.logger.debug("Subscription check", {
        threadId,
        isSubscribed,
        subscribedHandlerCount: this.subscribedMessageHandlers.length
      });
      const thread = await this.createThread(
        adapter,
        threadId,
        message,
        isSubscribed
      );
      const isDM = adapter.isDM?.(threadId) ?? false;
      if (isDM && this.directMessageHandlers.length > 0) {
        this.logger.debug("Direct message received - calling handlers", {
          threadId,
          handlerCount: this.directMessageHandlers.length
        });
        const channel = thread.channel;
        for (const handler of this.directMessageHandlers) {
          await handler(thread, message, channel);
        }
        return;
      }
      if (isDM) {
        message.isMention = true;
      }
      if (isSubscribed) {
        this.logger.debug("Message in subscribed thread - calling handlers", {
          threadId,
          handlerCount: this.subscribedMessageHandlers.length
        });
        await this.runHandlers(this.subscribedMessageHandlers, thread, message);
        return;
      }
      if (message.isMention) {
        this.logger.debug("Bot mentioned", {
          threadId,
          text: message.text.slice(0, 100)
        });
        await this.runHandlers(this.mentionHandlers, thread, message);
        return;
      }
      this.logger.debug("Checking message patterns", {
        patternCount: this.messagePatterns.length,
        patterns: this.messagePatterns.map((p) => p.pattern.toString()),
        messageText: message.text
      });
      let matchedPattern = false;
      for (const { pattern, handler } of this.messagePatterns) {
        const matches = pattern.test(message.text);
        this.logger.debug("Pattern test", {
          pattern: pattern.toString(),
          text: message.text,
          matches
        });
        if (matches) {
          this.logger.debug("Message matched pattern - calling handler", {
            pattern: pattern.toString()
          });
          matchedPattern = true;
          await handler(thread, message);
        }
      }
      if (!matchedPattern) {
        this.logger.debug("No handlers matched message", {
          threadId,
          text: message.text.slice(0, 100)
        });
      }
    } finally {
      await this._stateAdapter.releaseLock(lock);
      this.logger.debug("Lock released", { threadId });
    }
  }
  createThread(adapter, threadId, initialMessage, isSubscribedContext = false) {
    const parts = threadId.split(":");
    const channelId = parts[1] || "";
    const isDM = adapter.isDM?.(threadId) ?? false;
    return new ThreadImpl({
      id: threadId,
      adapter,
      channelId,
      stateAdapter: this._stateAdapter,
      initialMessage,
      isSubscribedContext,
      isDM,
      currentMessage: initialMessage,
      logger: this.logger,
      streamingUpdateIntervalMs: this._streamingUpdateIntervalMs,
      fallbackStreamingPlaceholderText: this._fallbackStreamingPlaceholderText,
      messageHistory: adapter.persistMessageHistory ? this._messageHistory : void 0
    });
  }
  /**
   * Detect if the bot was mentioned in the message.
   * All adapters normalize mentions to @name format, so we just check for @username.
   */
  detectMention(adapter, message) {
    const botUserName = adapter.userName || this.userName;
    const botUserId = adapter.botUserId;
    const usernamePattern = new RegExp(
      `@${this.escapeRegex(botUserName)}\\b`,
      "i"
    );
    if (usernamePattern.test(message.text)) {
      return true;
    }
    if (botUserId) {
      const userIdPattern = new RegExp(
        `@${this.escapeRegex(botUserId)}\\b`,
        "i"
      );
      if (userIdPattern.test(message.text)) {
        return true;
      }
      const discordPattern = new RegExp(
        `<@!?${this.escapeRegex(botUserId)}>`,
        "i"
      );
      if (discordPattern.test(message.text)) {
        return true;
      }
    }
    return false;
  }
  escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  async runHandlers(handlers, thread, message) {
    for (const handler of handlers) {
      await handler(thread, message);
    }
  }
};

// src/emoji.ts
var emojiRegistry = /* @__PURE__ */ new Map();
function getEmoji(name) {
  let emojiValue = emojiRegistry.get(name);
  if (!emojiValue) {
    emojiValue = Object.freeze({
      name,
      toString: () => `{{emoji:${name}}}`,
      toJSON: () => `{{emoji:${name}}}`
    });
    emojiRegistry.set(name, emojiValue);
  }
  return emojiValue;
}
var DEFAULT_EMOJI_MAP = {
  // Reactions & Gestures
  thumbs_up: { slack: ["+1", "thumbsup"], gchat: "\u{1F44D}" },
  thumbs_down: { slack: ["-1", "thumbsdown"], gchat: "\u{1F44E}" },
  clap: { slack: "clap", gchat: "\u{1F44F}" },
  wave: { slack: "wave", gchat: "\u{1F44B}" },
  pray: { slack: "pray", gchat: "\u{1F64F}" },
  muscle: { slack: "muscle", gchat: "\u{1F4AA}" },
  ok_hand: { slack: "ok_hand", gchat: "\u{1F44C}" },
  point_up: { slack: "point_up", gchat: "\u{1F446}" },
  point_down: { slack: "point_down", gchat: "\u{1F447}" },
  point_left: { slack: "point_left", gchat: "\u{1F448}" },
  point_right: { slack: "point_right", gchat: "\u{1F449}" },
  raised_hands: { slack: "raised_hands", gchat: "\u{1F64C}" },
  shrug: { slack: "shrug", gchat: "\u{1F937}" },
  facepalm: { slack: "facepalm", gchat: "\u{1F926}" },
  // Emotions & Faces
  heart: { slack: "heart", gchat: ["\u2764\uFE0F", "\u2764"] },
  smile: { slack: ["smile", "slightly_smiling_face"], gchat: "\u{1F60A}" },
  laugh: { slack: ["laughing", "satisfied", "joy"], gchat: ["\u{1F602}", "\u{1F606}"] },
  thinking: { slack: "thinking_face", gchat: "\u{1F914}" },
  sad: { slack: ["cry", "sad", "white_frowning_face"], gchat: "\u{1F622}" },
  cry: { slack: "sob", gchat: "\u{1F62D}" },
  angry: { slack: "angry", gchat: "\u{1F620}" },
  love_eyes: { slack: "heart_eyes", gchat: "\u{1F60D}" },
  cool: { slack: "sunglasses", gchat: "\u{1F60E}" },
  wink: { slack: "wink", gchat: "\u{1F609}" },
  surprised: { slack: "open_mouth", gchat: "\u{1F62E}" },
  worried: { slack: "worried", gchat: "\u{1F61F}" },
  confused: { slack: "confused", gchat: "\u{1F615}" },
  neutral: { slack: "neutral_face", gchat: "\u{1F610}" },
  sleeping: { slack: "sleeping", gchat: "\u{1F634}" },
  sick: { slack: "nauseated_face", gchat: "\u{1F922}" },
  mind_blown: { slack: "exploding_head", gchat: "\u{1F92F}" },
  relieved: { slack: "relieved", gchat: "\u{1F60C}" },
  grimace: { slack: "grimacing", gchat: "\u{1F62C}" },
  rolling_eyes: { slack: "rolling_eyes", gchat: "\u{1F644}" },
  hug: { slack: "hugging_face", gchat: "\u{1F917}" },
  zany: { slack: "zany_face", gchat: "\u{1F92A}" },
  // Status & Symbols
  check: {
    slack: ["white_check_mark", "heavy_check_mark"],
    gchat: ["\u2705", "\u2714\uFE0F"]
  },
  x: { slack: ["x", "heavy_multiplication_x"], gchat: ["\u274C", "\u2716\uFE0F"] },
  question: { slack: "question", gchat: ["\u2753", "?"] },
  exclamation: { slack: "exclamation", gchat: "\u2757" },
  warning: { slack: "warning", gchat: "\u26A0\uFE0F" },
  stop: { slack: "octagonal_sign", gchat: "\u{1F6D1}" },
  info: { slack: "information_source", gchat: "\u2139\uFE0F" },
  "100": { slack: "100", gchat: "\u{1F4AF}" },
  fire: { slack: "fire", gchat: "\u{1F525}" },
  star: { slack: "star", gchat: "\u2B50" },
  sparkles: { slack: "sparkles", gchat: "\u2728" },
  lightning: { slack: "zap", gchat: "\u26A1" },
  boom: { slack: "boom", gchat: "\u{1F4A5}" },
  eyes: { slack: "eyes", gchat: "\u{1F440}" },
  // Status Indicators (colored circles)
  green_circle: { slack: "large_green_circle", gchat: "\u{1F7E2}" },
  yellow_circle: { slack: "large_yellow_circle", gchat: "\u{1F7E1}" },
  red_circle: { slack: "red_circle", gchat: "\u{1F534}" },
  blue_circle: { slack: "large_blue_circle", gchat: "\u{1F535}" },
  white_circle: { slack: "white_circle", gchat: "\u26AA" },
  black_circle: { slack: "black_circle", gchat: "\u26AB" },
  // Objects & Tools
  rocket: { slack: "rocket", gchat: "\u{1F680}" },
  party: { slack: ["tada", "partying_face"], gchat: ["\u{1F389}", "\u{1F973}"] },
  confetti: { slack: "confetti_ball", gchat: "\u{1F38A}" },
  balloon: { slack: "balloon", gchat: "\u{1F388}" },
  gift: { slack: "gift", gchat: "\u{1F381}" },
  trophy: { slack: "trophy", gchat: "\u{1F3C6}" },
  medal: { slack: "first_place_medal", gchat: "\u{1F947}" },
  lightbulb: { slack: "bulb", gchat: "\u{1F4A1}" },
  gear: { slack: "gear", gchat: "\u2699\uFE0F" },
  wrench: { slack: "wrench", gchat: "\u{1F527}" },
  hammer: { slack: "hammer", gchat: "\u{1F528}" },
  bug: { slack: "bug", gchat: "\u{1F41B}" },
  link: { slack: "link", gchat: "\u{1F517}" },
  lock: { slack: "lock", gchat: "\u{1F512}" },
  unlock: { slack: "unlock", gchat: "\u{1F513}" },
  key: { slack: "key", gchat: "\u{1F511}" },
  pin: { slack: "pushpin", gchat: "\u{1F4CC}" },
  memo: { slack: "memo", gchat: "\u{1F4DD}" },
  clipboard: { slack: "clipboard", gchat: "\u{1F4CB}" },
  calendar: { slack: "calendar", gchat: "\u{1F4C5}" },
  clock: { slack: "clock1", gchat: "\u{1F550}" },
  hourglass: { slack: "hourglass", gchat: "\u23F3" },
  bell: { slack: "bell", gchat: "\u{1F514}" },
  megaphone: { slack: "mega", gchat: "\u{1F4E2}" },
  speech_bubble: { slack: "speech_balloon", gchat: "\u{1F4AC}" },
  email: { slack: "email", gchat: "\u{1F4E7}" },
  inbox: { slack: "inbox_tray", gchat: "\u{1F4E5}" },
  outbox: { slack: "outbox_tray", gchat: "\u{1F4E4}" },
  package: { slack: "package", gchat: "\u{1F4E6}" },
  folder: { slack: "file_folder", gchat: "\u{1F4C1}" },
  file: { slack: "page_facing_up", gchat: "\u{1F4C4}" },
  chart_up: { slack: "chart_with_upwards_trend", gchat: "\u{1F4C8}" },
  chart_down: { slack: "chart_with_downwards_trend", gchat: "\u{1F4C9}" },
  coffee: { slack: "coffee", gchat: "\u2615" },
  pizza: { slack: "pizza", gchat: "\u{1F355}" },
  beer: { slack: "beer", gchat: "\u{1F37A}" },
  // Arrows & Directions
  arrow_up: { slack: "arrow_up", gchat: "\u2B06\uFE0F" },
  arrow_down: { slack: "arrow_down", gchat: "\u2B07\uFE0F" },
  arrow_left: { slack: "arrow_left", gchat: "\u2B05\uFE0F" },
  arrow_right: { slack: "arrow_right", gchat: "\u27A1\uFE0F" },
  refresh: { slack: "arrows_counterclockwise", gchat: "\u{1F504}" },
  // Nature & Weather
  sun: { slack: "sunny", gchat: "\u2600\uFE0F" },
  cloud: { slack: "cloud", gchat: "\u2601\uFE0F" },
  rain: { slack: "rain_cloud", gchat: "\u{1F327}\uFE0F" },
  snow: { slack: "snowflake", gchat: "\u2744\uFE0F" },
  rainbow: { slack: "rainbow", gchat: "\u{1F308}" }
};
var EmojiResolver = class {
  emojiMap;
  slackToNormalized;
  gchatToNormalized;
  constructor(customMap) {
    this.emojiMap = { ...DEFAULT_EMOJI_MAP, ...customMap };
    this.slackToNormalized = /* @__PURE__ */ new Map();
    this.gchatToNormalized = /* @__PURE__ */ new Map();
    this.buildReverseMaps();
  }
  buildReverseMaps() {
    for (const [normalized, formats] of Object.entries(this.emojiMap)) {
      const slackFormats = Array.isArray(formats.slack) ? formats.slack : [formats.slack];
      for (const slack of slackFormats) {
        this.slackToNormalized.set(slack.toLowerCase(), normalized);
      }
      const gchatFormats = Array.isArray(formats.gchat) ? formats.gchat : [formats.gchat];
      for (const gchat of gchatFormats) {
        this.gchatToNormalized.set(gchat, normalized);
      }
    }
  }
  /**
   * Convert a Slack emoji name to normalized EmojiValue.
   * Returns an EmojiValue for the raw emoji if no mapping exists.
   */
  fromSlack(slackEmoji) {
    const cleaned = slackEmoji.replace(/^:|:$/g, "").toLowerCase();
    const normalized = this.slackToNormalized.get(cleaned) ?? slackEmoji;
    return getEmoji(normalized);
  }
  /**
   * Convert a Google Chat unicode emoji to normalized EmojiValue.
   * Returns an EmojiValue for the raw emoji if no mapping exists.
   */
  fromGChat(gchatEmoji) {
    const normalized = this.gchatToNormalized.get(gchatEmoji) ?? gchatEmoji;
    return getEmoji(normalized);
  }
  /**
   * Convert a Teams reaction type to normalized EmojiValue.
   * Teams uses specific names: like, heart, laugh, surprised, sad, angry
   * Returns an EmojiValue for the raw reaction if no mapping exists.
   */
  fromTeams(teamsReaction) {
    const teamsMap = {
      like: "thumbs_up",
      heart: "heart",
      laugh: "laugh",
      surprised: "surprised",
      sad: "sad",
      angry: "angry"
    };
    const normalized = teamsMap[teamsReaction] ?? teamsReaction;
    return getEmoji(normalized);
  }
  /**
   * Convert a normalized emoji (or EmojiValue) to Slack format.
   * Returns the first Slack format if multiple exist.
   */
  toSlack(emoji2) {
    const name = typeof emoji2 === "string" ? emoji2 : emoji2.name;
    const formats = this.emojiMap[name];
    if (!formats) {
      return name;
    }
    return Array.isArray(formats.slack) ? formats.slack[0] : formats.slack;
  }
  /**
   * Convert a normalized emoji (or EmojiValue) to Google Chat format.
   * Returns the first GChat format if multiple exist.
   */
  toGChat(emoji2) {
    const name = typeof emoji2 === "string" ? emoji2 : emoji2.name;
    const formats = this.emojiMap[name];
    if (!formats) {
      return name;
    }
    return Array.isArray(formats.gchat) ? formats.gchat[0] : formats.gchat;
  }
  /**
   * Convert a normalized emoji (or EmojiValue) to Discord format (unicode).
   * Discord uses unicode emoji, same as Google Chat.
   */
  toDiscord(emoji2) {
    return this.toGChat(emoji2);
  }
  /**
   * Check if an emoji (in any format) matches a normalized emoji name or EmojiValue.
   */
  matches(rawEmoji, normalized) {
    const name = typeof normalized === "string" ? normalized : normalized.name;
    const formats = this.emojiMap[name];
    if (!formats) {
      return rawEmoji === name;
    }
    const slackFormats = Array.isArray(formats.slack) ? formats.slack : [formats.slack];
    const gchatFormats = Array.isArray(formats.gchat) ? formats.gchat : [formats.gchat];
    const cleanedRaw = rawEmoji.replace(/^:|:$/g, "").toLowerCase();
    return slackFormats.some((s) => s.toLowerCase() === cleanedRaw) || gchatFormats.includes(rawEmoji);
  }
  /**
   * Add or override emoji mappings.
   */
  extend(customMap) {
    Object.assign(this.emojiMap, customMap);
    this.buildReverseMaps();
  }
};
var defaultEmojiResolver = new EmojiResolver();
var EMOJI_PLACEHOLDER_REGEX = /\{\{emoji:([a-z0-9_]+)\}\}/gi;
function convertEmojiPlaceholders(text2, platform, resolver = defaultEmojiResolver) {
  return text2.replace(EMOJI_PLACEHOLDER_REGEX, (_, emojiName) => {
    switch (platform) {
      case "slack":
        return `:${resolver.toSlack(emojiName)}:`;
      case "gchat":
        return resolver.toGChat(emojiName);
      case "teams":
        return resolver.toGChat(emojiName);
      case "discord":
        return resolver.toDiscord(emojiName);
      case "github":
        return resolver.toGChat(emojiName);
      case "linear":
        return resolver.toGChat(emojiName);
      case "whatsapp":
        return resolver.toGChat(emojiName);
      default:
        return resolver.toGChat(emojiName);
    }
  });
}
function createEmoji(customEmoji) {
  const wellKnownEmoji = [
    // Reactions & Gestures
    "thumbs_up",
    "thumbs_down",
    "clap",
    "wave",
    "pray",
    "muscle",
    "ok_hand",
    "point_up",
    "point_down",
    "point_left",
    "point_right",
    "raised_hands",
    "shrug",
    "facepalm",
    // Emotions & Faces
    "heart",
    "smile",
    "laugh",
    "thinking",
    "sad",
    "cry",
    "angry",
    "love_eyes",
    "cool",
    "wink",
    "surprised",
    "worried",
    "confused",
    "neutral",
    "sleeping",
    "sick",
    "mind_blown",
    "relieved",
    "grimace",
    "rolling_eyes",
    "hug",
    "zany",
    // Status & Symbols
    "check",
    "x",
    "question",
    "exclamation",
    "warning",
    "stop",
    "info",
    "100",
    "fire",
    "star",
    "sparkles",
    "lightning",
    "boom",
    "eyes",
    // Status Indicators
    "green_circle",
    "yellow_circle",
    "red_circle",
    "blue_circle",
    "white_circle",
    "black_circle",
    // Objects & Tools
    "rocket",
    "party",
    "confetti",
    "balloon",
    "gift",
    "trophy",
    "medal",
    "lightbulb",
    "gear",
    "wrench",
    "hammer",
    "bug",
    "link",
    "lock",
    "unlock",
    "key",
    "pin",
    "memo",
    "clipboard",
    "calendar",
    "clock",
    "hourglass",
    "bell",
    "megaphone",
    "speech_bubble",
    "email",
    "inbox",
    "outbox",
    "package",
    "folder",
    "file",
    "chart_up",
    "chart_down",
    "coffee",
    "pizza",
    "beer",
    // Arrows & Directions
    "arrow_up",
    "arrow_down",
    "arrow_left",
    "arrow_right",
    "refresh",
    // Nature & Weather
    "sun",
    "cloud",
    "rain",
    "snow",
    "rainbow"
  ];
  const helper = {
    custom: (name) => getEmoji(name)
  };
  for (const name of wellKnownEmoji) {
    helper[name] = getEmoji(name);
  }
  if (customEmoji) {
    for (const key of Object.keys(customEmoji)) {
      helper[key] = getEmoji(key);
    }
    defaultEmojiResolver.extend(customEmoji);
  }
  return helper;
}
var emoji = createEmoji();

// src/index.ts
var Actions2 = Actions;
var Button2 = Button;
var Card2 = Card;
var cardChildToFallbackText2 = cardChildToFallbackText;
var CardLink2 = CardLink;
var CardText2 = CardText;
var Divider2 = Divider;
var Field2 = Field;
var Fields2 = Fields;
var fromReactElement2 = fromReactElement;
var Image2 = Image;
var isCardElement2 = isCardElement;
var isJSX2 = isJSX;
var LinkButton2 = LinkButton;
var Section2 = Section;
var Table2 = Table;
var toCardElement2 = toCardElement;
var toModalElement2 = toModalElement;
var fromReactModalElement2 = fromReactModalElement;
var isModalElement2 = isModalElement;
var Modal2 = Modal;
var RadioSelect2 = RadioSelect;
var Select2 = Select;
var SelectOption2 = SelectOption;
var TextInput2 = TextInput;
export {
  Actions2 as Actions,
  BaseFormatConverter,
  Button2 as Button,
  Card2 as Card,
  CardLink2 as CardLink,
  CardText2 as CardText,
  ChannelImpl,
  Chat,
  ChatError,
  ConsoleLogger,
  DEFAULT_EMOJI_MAP,
  Divider2 as Divider,
  EmojiResolver,
  Field2 as Field,
  Fields2 as Fields,
  Image2 as Image,
  LinkButton2 as LinkButton,
  LockError,
  Message,
  MessageHistoryCache,
  Modal2 as Modal,
  NotImplementedError,
  RadioSelect2 as RadioSelect,
  RateLimitError,
  Section2 as Section,
  Select2 as Select,
  SelectOption2 as SelectOption,
  StreamingMarkdownRenderer,
  THREAD_STATE_TTL_MS,
  Table2 as Table,
  TextInput2 as TextInput,
  ThreadImpl,
  blockquote,
  cardChildToFallbackText2 as cardChildToFallbackText,
  codeBlock,
  convertEmojiPlaceholders,
  createEmoji,
  defaultEmojiResolver,
  deriveChannelId,
  emoji,
  emphasis,
  fromFullStream,
  fromReactElement2 as fromReactElement,
  fromReactModalElement2 as fromReactModalElement,
  getEmoji,
  getNodeChildren,
  getNodeValue,
  inlineCode,
  isBlockquoteNode,
  isCardElement2 as isCardElement,
  isCodeNode,
  isDeleteNode,
  isEmphasisNode,
  isInlineCodeNode,
  isJSX2 as isJSX,
  isLinkNode,
  isListItemNode,
  isListNode,
  isModalElement2 as isModalElement,
  isParagraphNode,
  isStrongNode,
  isTableCellNode,
  isTableNode,
  isTableRowNode,
  isTextNode,
  link,
  markdownToPlainText,
  paragraph,
  parseMarkdown,
  root,
  strikethrough,
  stringifyMarkdown,
  strong,
  tableElementToAscii,
  tableToAscii,
  text,
  toAiMessages,
  toCardElement2 as toCardElement,
  toModalElement2 as toModalElement,
  toPlainText,
  walkAst
};
//# sourceMappingURL=index.js.map