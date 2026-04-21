// src/index.ts
import { AsyncLocalStorage } from "async_hooks";
import { createHmac, timingSafeEqual } from "crypto";
import {
  AdapterRateLimitError,
  AuthenticationError,
  extractCard,
  extractFiles,
  NetworkError,
  toBuffer,
  ValidationError
} from "@chat-adapter/shared";
import { WebClient } from "@slack/web-api";
import {
  ConsoleLogger,
  convertEmojiPlaceholders,
  defaultEmojiResolver,
  isJSX,
  Message,
  parseMarkdown as parseMarkdown2,
  StreamingMarkdownRenderer,
  toModalElement
} from "chat";

// src/cards.ts
import {
  createEmojiConverter,
  mapButtonStyle,
  cardToFallbackText as sharedCardToFallbackText
} from "@chat-adapter/shared";
import { cardChildToFallbackText, tableElementToAscii } from "chat";
var convertEmoji = createEmojiConverter("slack");
function cardToBlockKit(card) {
  const blocks = [];
  if (card.title) {
    blocks.push({
      type: "header",
      text: {
        type: "plain_text",
        text: convertEmoji(card.title),
        emoji: true
      }
    });
  }
  if (card.subtitle) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: convertEmoji(card.subtitle)
        }
      ]
    });
  }
  if (card.imageUrl) {
    blocks.push({
      type: "image",
      image_url: card.imageUrl,
      alt_text: card.title || "Card image"
    });
  }
  const state = { usedNativeTable: false };
  for (const child of card.children) {
    const childBlocks = convertChildToBlocks(child, state);
    blocks.push(...childBlocks);
  }
  return blocks;
}
function convertChildToBlocks(child, state) {
  switch (child.type) {
    case "text":
      return [convertTextToBlock(child)];
    case "image":
      return [convertImageToBlock(child)];
    case "divider":
      return [convertDividerToBlock(child)];
    case "actions":
      return [convertActionsToBlock(child)];
    case "section":
      return convertSectionToBlocks(child, state);
    case "fields":
      return [convertFieldsToBlock(child)];
    case "link":
      return [convertLinkToBlock(child)];
    case "table":
      return convertTableToBlocks(child, state);
    default: {
      const text = cardChildToFallbackText(child);
      if (text) {
        return [{ type: "section", text: { type: "mrkdwn", text } }];
      }
      return [];
    }
  }
}
function markdownToMrkdwn(text) {
  return text.replace(/\*\*(.+?)\*\*/g, "*$1*");
}
function convertTextToBlock(element) {
  const text = markdownToMrkdwn(convertEmoji(element.content));
  let formattedText = text;
  if (element.style === "bold") {
    formattedText = `*${text}*`;
  } else if (element.style === "muted") {
    return {
      type: "context",
      elements: [{ type: "mrkdwn", text }]
    };
  }
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: formattedText
    }
  };
}
function convertLinkToBlock(element) {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `<${element.url}|${convertEmoji(element.label)}>`
    }
  };
}
function convertImageToBlock(element) {
  return {
    type: "image",
    image_url: element.url,
    alt_text: element.alt || "Image"
  };
}
function convertDividerToBlock(_element) {
  return { type: "divider" };
}
function convertActionsToBlock(element) {
  const elements = element.children.map((child) => {
    if (child.type === "link-button") {
      return convertLinkButtonToElement(child);
    }
    if (child.type === "select") {
      return convertSelectToElement(child);
    }
    if (child.type === "radio_select") {
      return convertRadioSelectToElement(child);
    }
    return convertButtonToElement(child);
  });
  return {
    type: "actions",
    elements
  };
}
function convertButtonToElement(button) {
  const element = {
    type: "button",
    text: {
      type: "plain_text",
      text: convertEmoji(button.label),
      emoji: true
    },
    action_id: button.id
  };
  if (button.value) {
    element.value = button.value;
  }
  const style = mapButtonStyle(button.style, "slack");
  if (style) {
    element.style = style;
  }
  return element;
}
function convertLinkButtonToElement(button) {
  const element = {
    type: "button",
    text: {
      type: "plain_text",
      text: convertEmoji(button.label),
      emoji: true
    },
    action_id: `link-${button.url.slice(0, 200)}`,
    url: button.url
  };
  const style = mapButtonStyle(button.style, "slack");
  if (style) {
    element.style = style;
  }
  return element;
}
function convertSelectToElement(select) {
  const options = select.options.map((opt) => {
    const option = {
      text: { type: "plain_text", text: convertEmoji(opt.label) },
      value: opt.value
    };
    if (opt.description) {
      option.description = {
        type: "plain_text",
        text: convertEmoji(opt.description)
      };
    }
    return option;
  });
  const element = {
    type: "static_select",
    action_id: select.id,
    options
  };
  if (select.placeholder) {
    element.placeholder = {
      type: "plain_text",
      text: convertEmoji(select.placeholder)
    };
  }
  if (select.initialOption) {
    const initialOpt = options.find((o) => o.value === select.initialOption);
    if (initialOpt) {
      element.initial_option = initialOpt;
    }
  }
  return element;
}
function convertRadioSelectToElement(radioSelect) {
  const limitedOptions = radioSelect.options.slice(0, 10);
  const options = limitedOptions.map((opt) => {
    const option = {
      text: { type: "mrkdwn", text: convertEmoji(opt.label) },
      value: opt.value
    };
    if (opt.description) {
      option.description = {
        type: "mrkdwn",
        text: convertEmoji(opt.description)
      };
    }
    return option;
  });
  const element = {
    type: "radio_buttons",
    action_id: radioSelect.id,
    options
  };
  if (radioSelect.initialOption) {
    const initialOpt = options.find(
      (o) => o.value === radioSelect.initialOption
    );
    if (initialOpt) {
      element.initial_option = initialOpt;
    }
  }
  return element;
}
function convertTableToBlocks(element, state) {
  const MAX_ROWS = 100;
  const MAX_COLS = 20;
  if (state.usedNativeTable || element.rows.length > MAX_ROWS || element.headers.length > MAX_COLS) {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `\`\`\`
${tableElementToAscii(element.headers, element.rows)}
\`\`\``
        }
      }
    ];
  }
  state.usedNativeTable = true;
  const headerRow = element.headers.map((header) => ({
    type: "raw_text",
    text: convertEmoji(header)
  }));
  const dataRows = element.rows.map(
    (row) => row.map((cell) => ({
      type: "raw_text",
      text: convertEmoji(cell)
    }))
  );
  return [
    {
      type: "table",
      rows: [headerRow, ...dataRows]
    }
  ];
}
function convertSectionToBlocks(element, state) {
  const blocks = [];
  for (const child of element.children) {
    blocks.push(...convertChildToBlocks(child, state));
  }
  return blocks;
}
function convertFieldsToBlock(element) {
  const fields = [];
  for (const field of element.children) {
    fields.push({
      type: "mrkdwn",
      text: `*${markdownToMrkdwn(convertEmoji(field.label))}*
${markdownToMrkdwn(convertEmoji(field.value))}`
    });
  }
  return {
    type: "section",
    fields
  };
}
function cardToFallbackText(card) {
  return sharedCardToFallbackText(card, {
    boldFormat: "*",
    lineBreak: "\n",
    platform: "slack"
  });
}

// src/crypto.ts
import crypto from "crypto";
var ALGORITHM = "aes-256-gcm";
var IV_LENGTH = 12;
var AUTH_TAG_LENGTH = 16;
var HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
function encryptToken(plaintext, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH
  });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    data: ciphertext.toString("base64"),
    tag: tag.toString("base64")
  };
}
function decryptToken(encrypted, key) {
  const iv = Buffer.from(encrypted.iv, "base64");
  const ciphertext = Buffer.from(encrypted.data, "base64");
  const tag = Buffer.from(encrypted.tag, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString("utf8");
}
function isEncryptedTokenData(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value;
  return typeof obj.iv === "string" && typeof obj.data === "string" && typeof obj.tag === "string";
}
function decodeKey(rawKey) {
  const trimmed = rawKey.trim();
  const isHex = HEX_KEY_PATTERN.test(trimmed);
  const key = Buffer.from(trimmed, isHex ? "hex" : "base64");
  if (key.length !== 32) {
    throw new Error(
      `Encryption key must decode to exactly 32 bytes (received ${key.length}). Use a 64-char hex string or 44-char base64 string.`
    );
  }
  return key;
}

// src/markdown.ts
import {
  BaseFormatConverter,
  getNodeChildren,
  isBlockquoteNode,
  isCodeNode,
  isDeleteNode,
  isEmphasisNode,
  isInlineCodeNode,
  isLinkNode,
  isListNode,
  isParagraphNode,
  isStrongNode,
  isTableNode,
  isTextNode,
  parseMarkdown,
  tableToAscii
} from "chat";
var SlackFormatConverter = class extends BaseFormatConverter {
  /**
   * Convert @mentions to Slack format in plain text.
   * @name → <@name>
   */
  convertMentionsToSlack(text) {
    return text.replace(/(?<!<)@(\w+)/g, "<@$1>");
  }
  /**
   * Override renderPostable to convert @mentions in plain strings.
   */
  renderPostable(message) {
    if (typeof message === "string") {
      return this.convertMentionsToSlack(message);
    }
    if ("raw" in message) {
      return this.convertMentionsToSlack(message.raw);
    }
    if ("markdown" in message) {
      return this.fromAst(parseMarkdown(message.markdown));
    }
    if ("ast" in message) {
      return this.fromAst(message.ast);
    }
    return "";
  }
  /**
   * Render an AST to Slack mrkdwn format.
   */
  fromAst(ast) {
    return this.fromAstWithNodeConverter(
      ast,
      (node) => this.nodeToMrkdwn(node)
    );
  }
  /**
   * Parse Slack mrkdwn into an AST.
   */
  toAst(mrkdwn) {
    let markdown = mrkdwn;
    markdown = markdown.replace(/<@([A-Z0-9_]+)\|([^>]+)>/g, "@$2");
    markdown = markdown.replace(/<@([A-Z0-9_]+)>/g, "@$1");
    markdown = markdown.replace(/<#[A-Z0-9_]+\|([^>]+)>/g, "#$1");
    markdown = markdown.replace(/<#([A-Z0-9_]+)>/g, "#$1");
    markdown = markdown.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)");
    markdown = markdown.replace(/<(https?:\/\/[^>]+)>/g, "$1");
    markdown = markdown.replace(/(?<![_*\\])\*([^*\n]+)\*(?![_*])/g, "**$1**");
    markdown = markdown.replace(/(?<!~)~([^~\n]+)~(?!~)/g, "~~$1~~");
    return parseMarkdown(markdown);
  }
  /**
   * Convert AST to Slack blocks, using a native table block for the first table.
   * Returns null if the AST contains no tables (caller should use regular text).
   * Slack allows at most one table block per message; additional tables use ASCII.
   */
  toBlocksWithTable(ast) {
    const hasTable = ast.children.some((node) => isTableNode(node));
    if (!hasTable) {
      return null;
    }
    const blocks = [];
    let usedNativeTable = false;
    let textBuffer = [];
    const flushText = () => {
      if (textBuffer.length > 0) {
        const text = textBuffer.join("\n\n");
        if (text.trim()) {
          blocks.push({
            type: "section",
            text: { type: "mrkdwn", text }
          });
        }
        textBuffer = [];
      }
    };
    for (const child of ast.children) {
      const node = child;
      if (isTableNode(node)) {
        flushText();
        if (usedNativeTable) {
          blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `\`\`\`
${tableToAscii(node)}
\`\`\``
            }
          });
        } else {
          blocks.push(
            mdastTableToSlackBlock(node, this.nodeToMrkdwn.bind(this))
          );
          usedNativeTable = true;
        }
      } else {
        textBuffer.push(this.nodeToMrkdwn(node));
      }
    }
    flushText();
    return blocks;
  }
  nodeToMrkdwn(node) {
    if (isParagraphNode(node)) {
      return getNodeChildren(node).map((child) => this.nodeToMrkdwn(child)).join("");
    }
    if (isTextNode(node)) {
      return node.value.replace(/(?<!<)@(\w+)/g, "<@$1>");
    }
    if (isStrongNode(node)) {
      const content = getNodeChildren(node).map((child) => this.nodeToMrkdwn(child)).join("");
      return `*${content}*`;
    }
    if (isEmphasisNode(node)) {
      const content = getNodeChildren(node).map((child) => this.nodeToMrkdwn(child)).join("");
      return `_${content}_`;
    }
    if (isDeleteNode(node)) {
      const content = getNodeChildren(node).map((child) => this.nodeToMrkdwn(child)).join("");
      return `~${content}~`;
    }
    if (isInlineCodeNode(node)) {
      return `\`${node.value}\``;
    }
    if (isCodeNode(node)) {
      return `\`\`\`${node.lang || ""}
${node.value}
\`\`\``;
    }
    if (isLinkNode(node)) {
      const linkText = getNodeChildren(node).map((child) => this.nodeToMrkdwn(child)).join("");
      return `<${node.url}|${linkText}>`;
    }
    if (isBlockquoteNode(node)) {
      return getNodeChildren(node).map((child) => `> ${this.nodeToMrkdwn(child)}`).join("\n");
    }
    if (isListNode(node)) {
      return this.renderList(node, 0, (child) => this.nodeToMrkdwn(child), "\u2022");
    }
    if (node.type === "break") {
      return "\n";
    }
    if (node.type === "thematicBreak") {
      return "---";
    }
    if (isTableNode(node)) {
      return `\`\`\`
${tableToAscii(node)}
\`\`\``;
    }
    return this.defaultNodeToText(node, (child) => this.nodeToMrkdwn(child));
  }
};
function mdastTableToSlackBlock(node, cellConverter) {
  const rows = [];
  for (const row of node.children) {
    const cells = getNodeChildren(row).map((cell) => ({
      type: "raw_text",
      text: getNodeChildren(cell).map(cellConverter).join("")
    }));
    rows.push(cells);
  }
  const block = { type: "table", rows };
  if (node.align) {
    const columnSettings = node.align.map(
      (a) => ({
        align: a || "left"
      })
    );
    block.column_settings = columnSettings;
  }
  return block;
}

// src/modals.ts
function encodeModalMetadata(meta) {
  if (!(meta.contextId || meta.privateMetadata)) {
    return void 0;
  }
  return JSON.stringify({ c: meta.contextId, m: meta.privateMetadata });
}
function decodeModalMetadata(raw) {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && ("c" in parsed || "m" in parsed)) {
      return {
        contextId: parsed.c || void 0,
        privateMetadata: parsed.m || void 0
      };
    }
  } catch {
  }
  return { contextId: raw };
}
function modalToSlackView(modal, contextId) {
  return {
    type: "modal",
    callback_id: modal.callbackId,
    title: { type: "plain_text", text: modal.title.slice(0, 24) },
    submit: modal.submitLabel ? { type: "plain_text", text: modal.submitLabel } : { type: "plain_text", text: "Submit" },
    close: modal.closeLabel ? { type: "plain_text", text: modal.closeLabel } : { type: "plain_text", text: "Cancel" },
    notify_on_close: modal.notifyOnClose,
    private_metadata: contextId,
    blocks: modal.children.map(modalChildToBlock)
  };
}
function modalChildToBlock(child) {
  switch (child.type) {
    case "text_input":
      return textInputToBlock(child);
    case "select":
      return selectToBlock(child);
    case "radio_select":
      return radioSelectToBlock(child);
    case "text":
      return convertTextToBlock(child);
    case "fields":
      return convertFieldsToBlock(child);
    default:
      throw new Error(
        `Unknown modal child type: ${child.type}`
      );
  }
}
function textInputToBlock(input) {
  const element = {
    type: "plain_text_input",
    action_id: input.id,
    multiline: input.multiline ?? false
  };
  if (input.placeholder) {
    element.placeholder = { type: "plain_text", text: input.placeholder };
  }
  if (input.initialValue) {
    element.initial_value = input.initialValue;
  }
  if (input.maxLength) {
    element.max_length = input.maxLength;
  }
  return {
    type: "input",
    block_id: input.id,
    optional: input.optional ?? false,
    label: { type: "plain_text", text: input.label },
    element
  };
}
function selectToBlock(select) {
  const options = select.options.map((opt) => {
    const option = {
      text: { type: "plain_text", text: opt.label },
      value: opt.value
    };
    if (opt.description) {
      option.description = { type: "plain_text", text: opt.description };
    }
    return option;
  });
  const element = {
    type: "static_select",
    action_id: select.id,
    options
  };
  if (select.placeholder) {
    element.placeholder = { type: "plain_text", text: select.placeholder };
  }
  if (select.initialOption) {
    const initialOpt = options.find(
      (o) => o.value === select.initialOption
    );
    if (initialOpt) {
      element.initial_option = initialOpt;
    }
  }
  return {
    type: "input",
    block_id: select.id,
    optional: select.optional ?? false,
    label: { type: "plain_text", text: select.label },
    element
  };
}
function radioSelectToBlock(radioSelect) {
  const limitedOptions = radioSelect.options.slice(0, 10);
  const options = limitedOptions.map((opt) => {
    const option = {
      text: { type: "mrkdwn", text: opt.label },
      value: opt.value
    };
    if (opt.description) {
      option.description = { type: "mrkdwn", text: opt.description };
    }
    return option;
  });
  const element = {
    type: "radio_buttons",
    action_id: radioSelect.id,
    options
  };
  if (radioSelect.initialOption) {
    const initialOpt = options.find(
      (o) => o.value === radioSelect.initialOption
    );
    if (initialOpt) {
      element.initial_option = initialOpt;
    }
  }
  return {
    type: "input",
    block_id: radioSelect.id,
    optional: radioSelect.optional ?? false,
    label: { type: "plain_text", text: radioSelect.label },
    element
  };
}

// src/index.ts
var SLACK_USER_ID_PATTERN = /^[A-Z0-9_]+$/;
function findNextMention(text) {
  const atIdx = text.indexOf("<@");
  const hashIdx = text.indexOf("<#");
  if (atIdx === -1) {
    return hashIdx;
  }
  if (hashIdx === -1) {
    return atIdx;
  }
  return Math.min(atIdx, hashIdx);
}
var SLACK_MESSAGE_URL_PATTERN = /^https?:\/\/[^/]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d+)(?:\?.*)?$/;
var SlackAdapter = class _SlackAdapter {
  name = "slack";
  userName;
  client;
  signingSecret;
  defaultBotToken;
  chat = null;
  logger;
  _botUserId = null;
  _botId = null;
  // Bot app ID (B_xxx) - different from user ID
  formatConverter = new SlackFormatConverter();
  static USER_CACHE_TTL_MS = 60 * 60 * 1e3;
  // 1 hour
  static CHANNEL_CACHE_TTL_MS = 60 * 60 * 1e3;
  // 1 hour
  // Multi-workspace support
  clientId;
  clientSecret;
  encryptionKey;
  installationKeyPrefix;
  requestContext = new AsyncLocalStorage();
  /** Bot user ID (e.g., U_BOT_123) used for mention detection */
  get botUserId() {
    const ctx = this.requestContext.getStore();
    if (ctx?.botUserId) {
      return ctx.botUserId;
    }
    return this._botUserId || void 0;
  }
  constructor(config = {}) {
    const signingSecret = config.signingSecret ?? process.env.SLACK_SIGNING_SECRET;
    if (!signingSecret) {
      throw new ValidationError(
        "slack",
        "signingSecret is required. Set SLACK_SIGNING_SECRET or provide it in config."
      );
    }
    const zeroConfig = !(config.signingSecret || config.botToken || config.clientId || config.clientSecret);
    const botToken = config.botToken ?? (zeroConfig ? process.env.SLACK_BOT_TOKEN : void 0);
    this.client = new WebClient(botToken);
    this.signingSecret = signingSecret;
    this.defaultBotToken = botToken;
    this.logger = config.logger ?? new ConsoleLogger("info").child("slack");
    this.userName = config.userName || "bot";
    this._botUserId = config.botUserId || null;
    this.clientId = config.clientId ?? (zeroConfig ? process.env.SLACK_CLIENT_ID : void 0);
    this.clientSecret = config.clientSecret ?? (zeroConfig ? process.env.SLACK_CLIENT_SECRET : void 0);
    this.installationKeyPrefix = config.installationKeyPrefix ?? "slack:installation";
    const encryptionKey = config.encryptionKey ?? process.env.SLACK_ENCRYPTION_KEY;
    if (encryptionKey) {
      this.encryptionKey = decodeKey(encryptionKey);
    }
  }
  /**
   * Get the current bot token for API calls.
   * Checks request context (multi-workspace) → default token (single-workspace) → throws.
   */
  getToken() {
    const ctx = this.requestContext.getStore();
    if (ctx?.token) {
      return ctx.token;
    }
    if (this.defaultBotToken) {
      return this.defaultBotToken;
    }
    throw new AuthenticationError(
      "slack",
      "No bot token available. In multi-workspace mode, ensure the webhook is being processed."
    );
  }
  /**
   * Add the current token to API call options.
   * Workaround for Slack WebClient types not including `token` in per-method args.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Slack types don't include token in method args
  withToken(options) {
    return { ...options, token: this.getToken() };
  }
  async initialize(chat) {
    this.chat = chat;
    if (this.defaultBotToken && !this._botUserId) {
      try {
        const authResult = await this.client.auth.test(this.withToken({}));
        this._botUserId = authResult.user_id;
        this._botId = authResult.bot_id || null;
        if (authResult.user) {
          this.userName = authResult.user;
        }
        this.logger.info("Slack auth completed", {
          botUserId: this._botUserId,
          botId: this._botId
        });
      } catch (error) {
        this.logger.warn("Could not fetch bot user ID", { error });
      }
    }
    if (!this.defaultBotToken) {
      this.logger.info("Slack adapter initialized in multi-workspace mode");
    }
  }
  // ===========================================================================
  // Multi-workspace installation management
  // ===========================================================================
  installationKey(teamId) {
    return `${this.installationKeyPrefix}:${teamId}`;
  }
  /**
   * Save a Slack workspace installation.
   * Call this from your OAuth callback route after a successful installation.
   */
  async setInstallation(teamId, installation) {
    if (!this.chat) {
      throw new ValidationError(
        "slack",
        "Adapter not initialized. Ensure chat.initialize() has been called first."
      );
    }
    const state = this.chat.getState();
    const key = this.installationKey(teamId);
    const dataToStore = this.encryptionKey ? {
      ...installation,
      botToken: encryptToken(installation.botToken, this.encryptionKey)
    } : installation;
    await state.set(key, dataToStore);
    this.logger.info("Slack installation saved", {
      teamId,
      teamName: installation.teamName
    });
  }
  /**
   * Retrieve a Slack workspace installation.
   */
  async getInstallation(teamId) {
    if (!this.chat) {
      throw new ValidationError(
        "slack",
        "Adapter not initialized. Ensure chat.initialize() has been called first."
      );
    }
    const state = this.chat.getState();
    const key = this.installationKey(teamId);
    const stored = await state.get(key);
    if (!stored) {
      return null;
    }
    if (this.encryptionKey && isEncryptedTokenData(stored.botToken)) {
      return {
        ...stored,
        botToken: decryptToken(
          stored.botToken,
          this.encryptionKey
        )
      };
    }
    return stored;
  }
  /**
   * Handle the Slack OAuth V2 callback.
   * Accepts the incoming request, extracts the authorization code,
   * exchanges it for tokens, and saves the installation.
   */
  async handleOAuthCallback(request) {
    if (!(this.clientId && this.clientSecret)) {
      throw new ValidationError(
        "slack",
        "clientId and clientSecret are required for OAuth. Pass them in createSlackAdapter()."
      );
    }
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    if (!code) {
      throw new ValidationError(
        "slack",
        "Missing 'code' query parameter in OAuth callback request."
      );
    }
    const redirectUri = url.searchParams.get("redirect_uri") ?? void 0;
    const result = await this.client.oauth.v2.access({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: redirectUri
    });
    if (!(result.ok && result.access_token && result.team?.id)) {
      throw new AuthenticationError(
        "slack",
        `Slack OAuth failed: ${result.error || "missing access_token or team.id"}`
      );
    }
    const teamId = result.team.id;
    const installation = {
      botToken: result.access_token,
      botUserId: result.bot_user_id,
      teamName: result.team.name
    };
    await this.setInstallation(teamId, installation);
    return { teamId, installation };
  }
  /**
   * Remove a Slack workspace installation.
   */
  async deleteInstallation(teamId) {
    if (!this.chat) {
      throw new ValidationError(
        "slack",
        "Adapter not initialized. Ensure chat.initialize() has been called first."
      );
    }
    const state = this.chat.getState();
    await state.delete(this.installationKey(teamId));
    this.logger.info("Slack installation deleted", { teamId });
  }
  /**
   * Run a function with a specific bot token in context.
   * Use this for operations outside webhook handling (cron jobs, workflows).
   */
  withBotToken(token, fn) {
    return this.requestContext.run({ token }, fn);
  }
  // ===========================================================================
  // Private helpers
  // ===========================================================================
  /**
   * Resolve the bot token for a team from the state adapter.
   */
  async resolveTokenForTeam(teamId) {
    try {
      const installation = await this.getInstallation(teamId);
      if (installation) {
        return {
          token: installation.botToken,
          botUserId: installation.botUserId
        };
      }
      this.logger.warn("No installation found for team", { teamId });
      return null;
    } catch (error) {
      this.logger.error("Failed to resolve token for team", {
        teamId,
        error
      });
      return null;
    }
  }
  /**
   * Extract team_id from an interactive payload (form-urlencoded).
   */
  extractTeamIdFromInteractive(body) {
    try {
      const params = new URLSearchParams(body);
      const payloadStr = params.get("payload");
      if (!payloadStr) {
        return null;
      }
      const payload = JSON.parse(payloadStr);
      return payload.team?.id || payload.team_id || null;
    } catch {
      return null;
    }
  }
  /**
   * Look up user info from Slack API with caching via state adapter.
   * Returns display name and real name, or falls back to user ID.
   */
  async lookupUser(userId) {
    const cacheKey = `slack:user:${userId}`;
    if (this.chat) {
      const cached = await this.chat.getState().get(cacheKey);
      if (cached) {
        return { displayName: cached.displayName, realName: cached.realName };
      }
    }
    try {
      const result = await this.client.users.info(
        this.withToken({ user: userId })
      );
      const user = result.user;
      const displayName = user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name || userId;
      const realName = user?.real_name || user?.profile?.real_name || displayName;
      if (this.chat) {
        await this.chat.getState().set(
          cacheKey,
          { displayName, realName },
          _SlackAdapter.USER_CACHE_TTL_MS
        );
      }
      this.logger.debug("Fetched user info", {
        userId,
        displayName,
        realName
      });
      return { displayName, realName };
    } catch (error) {
      this.logger.warn("Could not fetch user info", { userId, error });
      return { displayName: userId, realName: userId };
    }
  }
  /**
   * Look up channel name from Slack API with caching via state adapter.
   * Returns channel name, or falls back to channel ID.
   */
  async lookupChannel(channelId) {
    const cacheKey = `slack:channel:${channelId}`;
    if (this.chat) {
      const cached = await this.chat.getState().get(cacheKey);
      if (cached) {
        return cached.name;
      }
    }
    try {
      const result = await this.client.conversations.info(
        this.withToken({ channel: channelId })
      );
      const name = result.channel?.name || channelId;
      if (this.chat) {
        await this.chat.getState().set(
          cacheKey,
          { name },
          _SlackAdapter.CHANNEL_CACHE_TTL_MS
        );
      }
      this.logger.debug("Fetched channel info", { channelId, name });
      return name;
    } catch (error) {
      this.logger.warn("Could not fetch channel info", { channelId, error });
      return channelId;
    }
  }
  async handleWebhook(request, options) {
    const body = await request.text();
    this.logger.debug("Slack webhook raw body", { body });
    const timestamp = request.headers.get("x-slack-request-timestamp");
    const signature = request.headers.get("x-slack-signature");
    if (!this.verifySignature(body, timestamp, signature)) {
      return new Response("Invalid signature", { status: 401 });
    }
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(body);
      if (params.has("command") && !params.has("payload")) {
        const teamId = params.get("team_id");
        if (!this.defaultBotToken && teamId) {
          const ctx = await this.resolveTokenForTeam(teamId);
          if (ctx) {
            return this.requestContext.run(
              ctx,
              () => this.handleSlashCommand(params, options)
            );
          }
          this.logger.warn("Could not resolve token for slash command");
        }
        return this.handleSlashCommand(params, options);
      }
      if (!this.defaultBotToken) {
        const teamId = this.extractTeamIdFromInteractive(body);
        if (teamId) {
          const ctx = await this.resolveTokenForTeam(teamId);
          if (ctx) {
            return this.requestContext.run(
              ctx,
              () => this.handleInteractivePayload(body, options)
            );
          }
        }
        this.logger.warn("Could not resolve token for interactive payload");
      }
      return this.handleInteractivePayload(body, options);
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (payload.type === "url_verification" && payload.challenge) {
      return Response.json({ challenge: payload.challenge });
    }
    if (!this.defaultBotToken && payload.type === "event_callback") {
      const teamId = payload.team_id;
      if (teamId) {
        const ctx = await this.resolveTokenForTeam(teamId);
        if (ctx) {
          return this.requestContext.run(ctx, () => {
            this.processEventPayload(payload, options);
            return new Response("ok", { status: 200 });
          });
        }
        this.logger.warn("Could not resolve token for team", { teamId });
        return new Response("ok", { status: 200 });
      }
    }
    this.processEventPayload(payload, options);
    return new Response("ok", { status: 200 });
  }
  /** Extract and dispatch events from a validated payload */
  processEventPayload(payload, options) {
    if (payload.type === "event_callback" && payload.event) {
      const event = payload.event;
      if (event.type === "message" || event.type === "app_mention") {
        const slackEvent = event;
        if (!(slackEvent.team || slackEvent.team_id) && payload.team_id) {
          slackEvent.team_id = payload.team_id;
        }
        this.handleMessageEvent(slackEvent, options);
      } else if (event.type === "reaction_added" || event.type === "reaction_removed") {
        this.handleReactionEvent(event, options);
      } else if (event.type === "assistant_thread_started") {
        this.handleAssistantThreadStarted(
          event,
          options
        );
      } else if (event.type === "assistant_thread_context_changed") {
        this.handleAssistantContextChanged(
          event,
          options
        );
      } else if (event.type === "app_home_opened" && event.tab === "home") {
        this.handleAppHomeOpened(event, options);
      } else if (event.type === "member_joined_channel") {
        this.handleMemberJoinedChannel(
          event,
          options
        );
      }
    }
  }
  /**
   * Handle Slack interactive payloads (button clicks, view submissions, etc.).
   * These are sent as form-urlencoded with a `payload` JSON field.
   */
  handleInteractivePayload(body, options) {
    const params = new URLSearchParams(body);
    const payloadStr = params.get("payload");
    if (!payloadStr) {
      return new Response("Missing payload", { status: 400 });
    }
    let payload;
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      return new Response("Invalid payload JSON", { status: 400 });
    }
    switch (payload.type) {
      case "block_actions":
        this.handleBlockActions(payload, options);
        return new Response("", { status: 200 });
      case "view_submission":
        return this.handleViewSubmission(payload, options);
      case "view_closed":
        this.handleViewClosed(payload, options);
        return new Response("", { status: 200 });
      default:
        return new Response("", { status: 200 });
    }
  }
  /**
   * Handle Slack slash command payloads.
   * Slash commands are sent as form-urlencoded with command, text, user_id, channel_id, etc.
   */
  async handleSlashCommand(params, options) {
    if (!this.chat) {
      this.logger.warn("Chat instance not initialized, ignoring slash command");
      return new Response("", { status: 200 });
    }
    const command = params.get("command") || "";
    const text = params.get("text") || "";
    const userId = params.get("user_id") || "";
    const channelId = params.get("channel_id") || "";
    const triggerId = params.get("trigger_id") || void 0;
    this.logger.debug("Processing Slack slash command", {
      command,
      text,
      userId,
      channelId,
      triggerId
    });
    const userInfo = await this.lookupUser(userId);
    const event = {
      command,
      text,
      user: {
        userId,
        userName: userInfo.displayName,
        fullName: userInfo.realName,
        isBot: false,
        isMe: false
      },
      adapter: this,
      raw: Object.fromEntries(params),
      triggerId,
      channelId: channelId ? `slack:${channelId}` : ""
    };
    this.chat.processSlashCommand(event, options);
    return new Response("", { status: 200 });
  }
  /**
   * Handle block_actions payload (button clicks in Block Kit).
   */
  handleBlockActions(payload, options) {
    if (!this.chat) {
      this.logger.warn("Chat instance not initialized, ignoring action");
      return;
    }
    const channel = payload.channel?.id || payload.container?.channel_id;
    const messageTs = payload.message?.ts || payload.container?.message_ts;
    const threadTs = payload.message?.thread_ts || payload.container?.thread_ts || messageTs;
    const isViewAction = payload.container?.type === "view";
    if (!(isViewAction || channel)) {
      this.logger.warn("Missing channel in block_actions", { channel });
      return;
    }
    const threadId = channel && (threadTs || messageTs) ? this.encodeThreadId({
      channel,
      threadTs: threadTs || messageTs || ""
    }) : "";
    const isEphemeral = payload.container?.is_ephemeral === true;
    const responseUrl = payload.response_url;
    const messageId = isEphemeral && responseUrl && messageTs ? this.encodeEphemeralMessageId(messageTs, responseUrl, payload.user.id) : messageTs || "";
    for (const action of payload.actions) {
      const actionValue = action.selected_option?.value ?? action.value;
      const actionEvent = {
        actionId: action.action_id,
        value: actionValue,
        user: {
          userId: payload.user.id,
          userName: payload.user.username || payload.user.name || "unknown",
          fullName: payload.user.name || payload.user.username || "unknown",
          isBot: false,
          isMe: false
        },
        messageId,
        threadId,
        adapter: this,
        raw: payload,
        triggerId: payload.trigger_id
      };
      this.logger.debug("Processing Slack block action", {
        actionId: action.action_id,
        value: action.value,
        messageId: messageTs,
        threadId,
        triggerId: payload.trigger_id
      });
      this.chat.processAction(actionEvent, options);
    }
  }
  async handleViewSubmission(payload, options) {
    if (!this.chat) {
      this.logger.warn(
        "Chat instance not initialized, ignoring view submission"
      );
      return new Response("", { status: 200 });
    }
    const values = {};
    for (const blockValues of Object.values(payload.view.state.values)) {
      for (const [actionId, input] of Object.entries(blockValues)) {
        values[actionId] = input.value ?? input.selected_option?.value ?? "";
      }
    }
    const { contextId, privateMetadata } = decodeModalMetadata(
      payload.view.private_metadata || void 0
    );
    const event = {
      callbackId: payload.view.callback_id,
      viewId: payload.view.id,
      values,
      privateMetadata,
      user: {
        userId: payload.user.id,
        userName: payload.user.username || payload.user.name || "unknown",
        fullName: payload.user.name || payload.user.username || "unknown",
        isBot: false,
        isMe: false
      },
      adapter: this,
      raw: payload
    };
    const response = await this.chat.processModalSubmit(
      event,
      contextId,
      options
    );
    if (response) {
      const slackResponse = this.modalResponseToSlack(response, contextId);
      return new Response(JSON.stringify(slackResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("", { status: 200 });
  }
  handleViewClosed(payload, options) {
    if (!this.chat) {
      this.logger.warn("Chat instance not initialized, ignoring view closed");
      return;
    }
    const { contextId, privateMetadata } = decodeModalMetadata(
      payload.view.private_metadata || void 0
    );
    const event = {
      callbackId: payload.view.callback_id,
      viewId: payload.view.id,
      privateMetadata,
      user: {
        userId: payload.user.id,
        userName: payload.user.username || payload.user.name || "unknown",
        fullName: payload.user.name || payload.user.username || "unknown",
        isBot: false,
        isMe: false
      },
      adapter: this,
      raw: payload
    };
    this.chat.processModalClose(event, contextId, options);
  }
  modalResponseToSlack(response, contextId) {
    switch (response.action) {
      case "close":
        return {};
      case "errors":
        return { response_action: "errors", errors: response.errors };
      case "update": {
        const modal = this.convertModalJSX(response.modal);
        const metadata = encodeModalMetadata({
          contextId,
          privateMetadata: modal.privateMetadata
        });
        const view = modalToSlackView(modal, metadata);
        return {
          response_action: "update",
          view
        };
      }
      case "push": {
        const modal = this.convertModalJSX(response.modal);
        const metadata = encodeModalMetadata({
          contextId,
          privateMetadata: modal.privateMetadata
        });
        const view = modalToSlackView(modal, metadata);
        return {
          response_action: "push",
          view
        };
      }
      default:
        return {};
    }
  }
  convertModalJSX(modal) {
    if (isJSX(modal)) {
      const converted = toModalElement(modal);
      if (!converted) {
        throw new ValidationError(
          "slack",
          "Invalid JSX element: must be a Modal element"
        );
      }
      return converted;
    }
    return modal;
  }
  verifySignature(body, timestamp, signature) {
    if (!(timestamp && signature)) {
      return false;
    }
    const now = Math.floor(Date.now() / 1e3);
    if (Math.abs(now - Number.parseInt(timestamp, 10)) > 300) {
      return false;
    }
    const sigBasestring = `v0:${timestamp}:${body}`;
    const expectedSignature = "v0=" + createHmac("sha256", this.signingSecret).update(sigBasestring).digest("hex");
    try {
      return timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );
    } catch {
      return false;
    }
  }
  /**
   * Handle message events from Slack.
   * Bot message filtering (isMe) is handled centrally by the Chat class.
   */
  handleMessageEvent(event, options) {
    if (!this.chat) {
      this.logger.warn("Chat instance not initialized, ignoring event");
      return;
    }
    const ignoredSubtypes = /* @__PURE__ */ new Set([
      "message_changed",
      "message_deleted",
      "message_replied",
      "channel_join",
      "channel_leave",
      "channel_topic",
      "channel_purpose",
      "channel_name",
      "channel_archive",
      "channel_unarchive",
      "group_join",
      "group_leave",
      "group_topic",
      "group_purpose",
      "group_name",
      "group_archive",
      "group_unarchive",
      "ekm_access_denied",
      "tombstone"
    ]);
    if (event.subtype && ignoredSubtypes.has(event.subtype)) {
      this.logger.debug("Ignoring message subtype", {
        subtype: event.subtype
      });
      return;
    }
    if (!(event.channel && event.ts)) {
      this.logger.debug("Ignoring event without channel or ts", {
        channel: event.channel,
        ts: event.ts
      });
      return;
    }
    const isDM = event.channel_type === "im";
    const threadTs = isDM ? event.thread_ts || "" : event.thread_ts || event.ts;
    const threadId = this.encodeThreadId({
      channel: event.channel,
      threadTs
    });
    const isMention = event.type === "app_mention";
    const factory = async () => {
      const msg = await this.parseSlackMessage(event, threadId);
      if (isMention) {
        msg.isMention = true;
      }
      return msg;
    };
    this.chat.processMessage(this, threadId, factory, options);
  }
  /**
   * Handle reaction events from Slack (reaction_added, reaction_removed).
   */
  async handleReactionEvent(event, options) {
    if (!this.chat) {
      this.logger.warn("Chat instance not initialized, ignoring reaction");
      return;
    }
    if (event.item.type !== "message") {
      this.logger.debug("Ignoring reaction to non-message item", {
        itemType: event.item.type
      });
      return;
    }
    let parentTs = event.item.ts;
    try {
      const result = await this.client.conversations.replies(
        this.withToken({
          channel: event.item.channel,
          ts: event.item.ts,
          limit: 1
        })
      );
      const firstMessage = result.messages?.[0];
      if (firstMessage?.thread_ts) {
        parentTs = firstMessage.thread_ts;
      }
    } catch (error) {
      this.logger.warn(
        "Failed to resolve parent thread for reaction, using message ts",
        {
          error: String(error),
          channel: event.item.channel,
          ts: event.item.ts
        }
      );
    }
    const threadId = this.encodeThreadId({
      channel: event.item.channel,
      threadTs: parentTs
    });
    const messageId = event.item.ts;
    const rawEmoji = event.reaction;
    const normalizedEmoji = defaultEmojiResolver.fromSlack(rawEmoji);
    const ctx = this.requestContext.getStore();
    const isMe = ctx?.botUserId && event.user === ctx.botUserId || this._botUserId !== null && event.user === this._botUserId || this._botId !== null && event.user === this._botId;
    const reactionEvent = {
      emoji: normalizedEmoji,
      rawEmoji,
      added: event.type === "reaction_added",
      user: {
        userId: event.user,
        userName: event.user,
        // Will be resolved below if possible
        fullName: event.user,
        isBot: false,
        // Users add reactions, not bots typically
        isMe
      },
      messageId,
      threadId,
      raw: event
    };
    this.chat.processReaction({ ...reactionEvent, adapter: this }, options);
  }
  /**
   * Handle assistant_thread_started events from Slack's Assistants API.
   * Fires when a user opens a new assistant thread (DM with the bot).
   */
  handleAssistantThreadStarted(event, options) {
    if (!this.chat) {
      this.logger.warn(
        "Chat instance not initialized, ignoring assistant_thread_started"
      );
      return;
    }
    if (!event.assistant_thread) {
      this.logger.warn(
        "Malformed assistant_thread_started: missing assistant_thread"
      );
      return;
    }
    const { channel_id, thread_ts, user_id, context } = event.assistant_thread;
    const threadId = this.encodeThreadId({
      channel: channel_id,
      threadTs: thread_ts
    });
    this.chat.processAssistantThreadStarted(
      {
        threadId,
        userId: user_id,
        channelId: channel_id,
        threadTs: thread_ts,
        context: {
          channelId: context.channel_id,
          teamId: context.team_id,
          enterpriseId: context.enterprise_id,
          threadEntryPoint: context.thread_entry_point,
          forceSearch: context.force_search
        },
        adapter: this
      },
      options
    );
  }
  /**
   * Handle assistant_thread_context_changed events from Slack's Assistants API.
   * Fires when a user navigates to a different channel with the assistant panel open.
   */
  handleAssistantContextChanged(event, options) {
    if (!this.chat) {
      this.logger.warn(
        "Chat instance not initialized, ignoring assistant_thread_context_changed"
      );
      return;
    }
    if (!event.assistant_thread) {
      this.logger.warn(
        "Malformed assistant_thread_context_changed: missing assistant_thread"
      );
      return;
    }
    const { channel_id, thread_ts, user_id, context } = event.assistant_thread;
    const threadId = this.encodeThreadId({
      channel: channel_id,
      threadTs: thread_ts
    });
    this.chat.processAssistantContextChanged(
      {
        threadId,
        userId: user_id,
        channelId: channel_id,
        threadTs: thread_ts,
        context: {
          channelId: context.channel_id,
          teamId: context.team_id,
          enterpriseId: context.enterprise_id,
          threadEntryPoint: context.thread_entry_point,
          forceSearch: context.force_search
        },
        adapter: this
      },
      options
    );
  }
  /**
   * Handle app_home_opened events from Slack.
   * Fires when a user opens the bot's Home tab.
   */
  handleAppHomeOpened(event, options) {
    if (!this.chat) {
      this.logger.warn(
        "Chat instance not initialized, ignoring app_home_opened"
      );
      return;
    }
    this.chat.processAppHomeOpened(
      {
        userId: event.user,
        channelId: event.channel,
        adapter: this
      },
      options
    );
  }
  /**
   * Handle member_joined_channel events from Slack.
   * Fires when a user (including the bot) joins a channel.
   */
  handleMemberJoinedChannel(event, options) {
    if (!this.chat) {
      this.logger.warn(
        "Chat instance not initialized, ignoring member_joined_channel"
      );
      return;
    }
    this.chat.processMemberJoinedChannel(
      {
        userId: event.user,
        channelId: this.encodeThreadId({
          channel: event.channel,
          threadTs: ""
        }),
        inviterId: event.inviter,
        adapter: this
      },
      options
    );
  }
  /**
   * Publish a Home tab view for a user.
   * Slack API: views.publish
   */
  async publishHomeView(userId, view) {
    await this.client.views.publish(
      // biome-ignore lint/suspicious/noExplicitAny: view blocks are consumer-defined
      this.withToken({ user_id: userId, view })
    );
  }
  /**
   * Set suggested prompts for an assistant thread.
   * Slack Assistants API: assistant.threads.setSuggestedPrompts
   */
  async setSuggestedPrompts(channelId, threadTs, prompts, title) {
    await this.client.assistant.threads.setSuggestedPrompts(
      this.withToken({
        channel_id: channelId,
        thread_ts: threadTs,
        prompts,
        title
      })
    );
  }
  /**
   * Set status/thinking indicator for an assistant thread.
   * Slack Assistants API: assistant.threads.setStatus
   */
  async setAssistantStatus(channelId, threadTs, status, loadingMessages) {
    await this.client.assistant.threads.setStatus(
      this.withToken({
        channel_id: channelId,
        thread_ts: threadTs,
        status,
        ...loadingMessages && { loading_messages: loadingMessages }
      })
    );
  }
  /**
   * Set title for an assistant thread (shown in History tab).
   * Slack Assistants API: assistant.threads.setTitle
   */
  async setAssistantTitle(channelId, threadTs, title) {
    await this.client.assistant.threads.setTitle(
      this.withToken({
        channel_id: channelId,
        thread_ts: threadTs,
        title
      })
    );
  }
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
  async resolveInlineMentions(text, skipSelfMention) {
    const userIds = /* @__PURE__ */ new Set();
    const channelIds = /* @__PURE__ */ new Set();
    for (const segment of text.split("<")) {
      const end = segment.indexOf(">");
      if (end === -1) {
        continue;
      }
      const inner = segment.slice(0, end);
      if (inner.startsWith("@")) {
        const rest = inner.slice(1);
        const pipeIdx = rest.indexOf("|");
        const uid = pipeIdx >= 0 ? rest.slice(0, pipeIdx) : rest;
        if (SLACK_USER_ID_PATTERN.test(uid)) {
          userIds.add(uid);
        }
      } else if (inner.startsWith("#")) {
        const rest = inner.slice(1);
        const pipeIdx = rest.indexOf("|");
        if (pipeIdx === -1 && SLACK_USER_ID_PATTERN.test(rest)) {
          channelIds.add(rest);
        }
      }
    }
    if (userIds.size === 0 && channelIds.size === 0) {
      return text;
    }
    if (skipSelfMention && this._botUserId) {
      userIds.delete(this._botUserId);
    }
    if (userIds.size === 0 && channelIds.size === 0) {
      return text;
    }
    const [userLookups, channelLookups] = await Promise.all([
      Promise.all(
        [...userIds].map(async (uid) => {
          const info = await this.lookupUser(uid);
          return [uid, info.displayName];
        })
      ),
      Promise.all(
        [...channelIds].map(async (cid) => {
          const name = await this.lookupChannel(cid);
          return [cid, name];
        })
      )
    ]);
    const userNameMap = new Map(userLookups);
    const channelNameMap = new Map(channelLookups);
    let result = "";
    let remaining = text;
    let startIdx = findNextMention(remaining);
    while (startIdx !== -1) {
      result += remaining.slice(0, startIdx);
      remaining = remaining.slice(startIdx);
      const endIdx = remaining.indexOf(">");
      if (endIdx === -1) {
        break;
      }
      const prefix = remaining[1];
      const inner = remaining.slice(2, endIdx);
      const pipeIdx = inner.indexOf("|");
      const id = pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner;
      if (prefix === "@" && SLACK_USER_ID_PATTERN.test(id)) {
        const name = userNameMap.get(id);
        result += name ? `<@${id}|${name}>` : `<@${id}>`;
      } else if (prefix === "#" && pipeIdx === -1 && channelNameMap.has(id)) {
        const name = channelNameMap.get(id);
        result += `<#${id}|${name}>`;
      } else {
        result += remaining.slice(0, endIdx + 1);
      }
      remaining = remaining.slice(endIdx + 1);
      startIdx = findNextMention(remaining);
    }
    return result + remaining;
  }
  /**
   * Extract link URLs from a Slack event.
   * Uses the `blocks` field (rich_text blocks with link elements) when available,
   * falling back to parsing `<url>` patterns from the text field.
   */
  extractLinks(event) {
    const urls = /* @__PURE__ */ new Set();
    if (event.blocks) {
      for (const block of event.blocks) {
        if (block.type === "rich_text" && block.elements) {
          for (const section of block.elements) {
            if (section.elements) {
              for (const element of section.elements) {
                if (element.type === "link" && element.url) {
                  urls.add(element.url);
                }
              }
            }
          }
        }
      }
    }
    if (urls.size === 0 && event.text) {
      const urlPattern = /<(https?:\/\/[^>]+)>/g;
      for (const match of event.text.matchAll(urlPattern)) {
        const raw = match[1];
        const pipeIdx = raw.indexOf("|");
        urls.add(pipeIdx >= 0 ? raw.slice(0, pipeIdx) : raw);
      }
    }
    return [...urls].map((url) => this.createLinkPreview(url));
  }
  /**
   * Create a LinkPreview for a URL. If the URL points to a Slack message,
   * includes a `fetchMessage` callback that fetches and parses the linked message.
   */
  createLinkPreview(url) {
    const match = SLACK_MESSAGE_URL_PATTERN.exec(url);
    if (!match) {
      return { url };
    }
    const channel = match[1];
    const rawTs = match[2];
    const ts = `${rawTs.slice(0, rawTs.length - 6)}.${rawTs.slice(rawTs.length - 6)}`;
    const threadId = this.encodeThreadId({ channel, threadTs: ts });
    return {
      url,
      fetchMessage: async () => {
        const result = await this.client.conversations.history(
          this.withToken({
            channel,
            latest: ts,
            inclusive: true,
            limit: 1
          })
        );
        const messages = result.messages || [];
        const target = messages.find((msg) => msg.ts === ts);
        if (!target) {
          throw new Error(`Message not found: ${url}`);
        }
        return this.parseSlackMessage(target, threadId);
      }
    };
  }
  async parseSlackMessage(event, threadId, options) {
    const isMe = this.isMessageFromSelf(event);
    const skipSelfMention = options?.skipSelfMention ?? true;
    const rawText = event.text || "";
    let userName = event.username || "unknown";
    let fullName = event.username || "unknown";
    if (event.user && !event.username) {
      const userInfo = await this.lookupUser(event.user);
      userName = userInfo.displayName;
      fullName = userInfo.realName;
    }
    const text = await this.resolveInlineMentions(rawText, skipSelfMention);
    return new Message({
      id: event.ts || "",
      threadId,
      text: this.formatConverter.extractPlainText(text),
      formatted: this.formatConverter.toAst(text),
      raw: event,
      author: {
        userId: event.user || event.bot_id || "unknown",
        userName,
        fullName,
        isBot: !!event.bot_id,
        isMe
      },
      metadata: {
        dateSent: new Date(Number.parseFloat(event.ts || "0") * 1e3),
        edited: !!event.edited,
        editedAt: event.edited ? new Date(Number.parseFloat(event.edited.ts) * 1e3) : void 0
      },
      attachments: (event.files || []).map(
        (file) => this.createAttachment(file)
      ),
      links: this.extractLinks(event)
    });
  }
  /**
   * Create an Attachment object from a Slack file.
   * Includes a fetchData method that uses the bot token for auth.
   */
  createAttachment(file) {
    const url = file.url_private;
    const botToken = this.getToken();
    let type = "file";
    if (file.mimetype?.startsWith("image/")) {
      type = "image";
    } else if (file.mimetype?.startsWith("video/")) {
      type = "video";
    } else if (file.mimetype?.startsWith("audio/")) {
      type = "audio";
    }
    return {
      type,
      url,
      name: file.name,
      mimeType: file.mimetype,
      size: file.size,
      width: file.original_w,
      height: file.original_h,
      fetchData: url ? async () => {
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${botToken}`
          }
        });
        if (!response.ok) {
          throw new NetworkError(
            "slack",
            `Failed to fetch file: ${response.status} ${response.statusText}`
          );
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("text/html")) {
          throw new NetworkError(
            "slack",
            `Failed to download file from Slack: received HTML login page instead of file data. Ensure your Slack app has the "files:read" OAuth scope. URL: ${url}`
          );
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      } : void 0
    };
  }
  /**
   * Try to render a message using native Slack table blocks.
   * Returns blocks + fallback text if the message contains tables, null otherwise.
   */
  renderWithTableBlocks(message) {
    let ast = null;
    if (typeof message === "object" && message !== null) {
      if ("ast" in message) {
        ast = message.ast;
      } else if ("markdown" in message) {
        ast = parseMarkdown2(message.markdown);
      }
    }
    if (!ast) {
      return null;
    }
    const blocks = this.formatConverter.toBlocksWithTable(ast);
    if (!blocks) {
      return null;
    }
    const fallbackText = convertEmojiPlaceholders(
      this.formatConverter.renderPostable(message),
      "slack"
    );
    return { text: fallbackText, blocks };
  }
  async postMessage(threadId, message) {
    const { channel, threadTs } = this.decodeThreadId(threadId);
    try {
      const files = extractFiles(message);
      if (files.length > 0) {
        await this.uploadFiles(files, channel, threadTs || void 0);
        const hasText = typeof message === "string" || typeof message === "object" && message !== null && ("raw" in message && message.raw || "markdown" in message && message.markdown || "ast" in message && message.ast);
        const card2 = extractCard(message);
        if (!(hasText || card2)) {
          return {
            id: `file-${Date.now()}`,
            threadId,
            raw: { files }
          };
        }
      }
      const card = extractCard(message);
      if (card) {
        const blocks = cardToBlockKit(card);
        const fallbackText = cardToFallbackText(card);
        this.logger.debug("Slack API: chat.postMessage (blocks)", {
          channel,
          threadTs,
          blockCount: blocks.length
        });
        const result2 = await this.client.chat.postMessage(
          this.withToken({
            channel,
            thread_ts: threadTs,
            text: fallbackText,
            // Fallback for notifications
            blocks,
            unfurl_links: false,
            unfurl_media: false
          })
        );
        this.logger.debug("Slack API: chat.postMessage response", {
          messageId: result2.ts,
          ok: result2.ok
        });
        return {
          id: result2.ts,
          threadId,
          raw: result2
        };
      }
      const tableResult = this.renderWithTableBlocks(message);
      if (tableResult) {
        this.logger.debug("Slack API: chat.postMessage (table blocks)", {
          channel,
          threadTs,
          blockCount: tableResult.blocks.length
        });
        const result2 = await this.client.chat.postMessage(
          this.withToken({
            channel,
            thread_ts: threadTs,
            text: tableResult.text,
            blocks: tableResult.blocks,
            unfurl_links: false,
            unfurl_media: false
          })
        );
        this.logger.debug("Slack API: chat.postMessage response", {
          messageId: result2.ts,
          ok: result2.ok
        });
        return {
          id: result2.ts,
          threadId,
          raw: result2
        };
      }
      const text = convertEmojiPlaceholders(
        this.formatConverter.renderPostable(message),
        "slack"
      );
      this.logger.debug("Slack API: chat.postMessage", {
        channel,
        threadTs,
        textLength: text.length
      });
      const result = await this.client.chat.postMessage(
        this.withToken({
          channel,
          thread_ts: threadTs,
          text,
          unfurl_links: false,
          unfurl_media: false
        })
      );
      this.logger.debug("Slack API: chat.postMessage response", {
        messageId: result.ts,
        ok: result.ok
      });
      return {
        id: result.ts,
        threadId,
        raw: result
      };
    } catch (error) {
      this.handleSlackError(error);
    }
  }
  async postEphemeral(threadId, userId, message) {
    const { channel, threadTs } = this.decodeThreadId(threadId);
    try {
      const card = extractCard(message);
      if (card) {
        const blocks = cardToBlockKit(card);
        const fallbackText = cardToFallbackText(card);
        this.logger.debug("Slack API: chat.postEphemeral (blocks)", {
          channel,
          threadTs,
          userId,
          blockCount: blocks.length
        });
        const result2 = await this.client.chat.postEphemeral(
          this.withToken({
            channel,
            thread_ts: threadTs || void 0,
            user: userId,
            text: fallbackText,
            blocks
          })
        );
        this.logger.debug("Slack API: chat.postEphemeral response", {
          messageTs: result2.message_ts,
          ok: result2.ok
        });
        return {
          id: result2.message_ts || "",
          threadId,
          usedFallback: false,
          raw: result2
        };
      }
      const tableResult = this.renderWithTableBlocks(message);
      if (tableResult) {
        this.logger.debug("Slack API: chat.postEphemeral (table blocks)", {
          channel,
          threadTs,
          userId,
          blockCount: tableResult.blocks.length
        });
        const result2 = await this.client.chat.postEphemeral(
          this.withToken({
            channel,
            thread_ts: threadTs || void 0,
            user: userId,
            text: tableResult.text,
            blocks: tableResult.blocks
          })
        );
        this.logger.debug("Slack API: chat.postEphemeral response", {
          messageTs: result2.message_ts,
          ok: result2.ok
        });
        return {
          id: result2.message_ts || "",
          threadId,
          usedFallback: false,
          raw: result2
        };
      }
      const text = convertEmojiPlaceholders(
        this.formatConverter.renderPostable(message),
        "slack"
      );
      this.logger.debug("Slack API: chat.postEphemeral", {
        channel,
        threadTs,
        userId,
        textLength: text.length
      });
      const result = await this.client.chat.postEphemeral(
        this.withToken({
          channel,
          thread_ts: threadTs || void 0,
          user: userId,
          text
        })
      );
      this.logger.debug("Slack API: chat.postEphemeral response", {
        messageTs: result.message_ts,
        ok: result.ok
      });
      return {
        id: result.message_ts || "",
        threadId,
        usedFallback: false,
        raw: result
      };
    } catch (error) {
      this.handleSlackError(error);
    }
  }
  async scheduleMessage(threadId, message, options) {
    const { channel, threadTs } = this.decodeThreadId(threadId);
    const postAtUnix = Math.floor(options.postAt.getTime() / 1e3);
    if (postAtUnix <= Math.floor(Date.now() / 1e3)) {
      throw new ValidationError("slack", "postAt must be in the future");
    }
    const files = extractFiles(message);
    if (files.length > 0) {
      throw new ValidationError(
        "slack",
        "File uploads are not supported in scheduled messages"
      );
    }
    const token = this.getToken();
    try {
      const card = extractCard(message);
      if (card) {
        const blocks = cardToBlockKit(card);
        const fallbackText = cardToFallbackText(card);
        this.logger.debug("Slack API: chat.scheduleMessage (blocks)", {
          channel,
          threadTs,
          postAt: postAtUnix,
          blockCount: blocks.length
        });
        const result2 = await this.client.chat.scheduleMessage({
          token,
          channel,
          thread_ts: threadTs || void 0,
          post_at: postAtUnix,
          text: fallbackText,
          blocks,
          unfurl_links: false,
          unfurl_media: false
        });
        const scheduledMessageId2 = result2.scheduled_message_id;
        const adapter2 = this;
        return {
          scheduledMessageId: scheduledMessageId2,
          channelId: channel,
          postAt: options.postAt,
          raw: result2,
          async cancel() {
            await adapter2.client.chat.deleteScheduledMessage({
              token,
              channel,
              scheduled_message_id: scheduledMessageId2
            });
          }
        };
      }
      const text = convertEmojiPlaceholders(
        this.formatConverter.renderPostable(message),
        "slack"
      );
      this.logger.debug("Slack API: chat.scheduleMessage", {
        channel,
        threadTs,
        postAt: postAtUnix,
        textLength: text.length
      });
      const result = await this.client.chat.scheduleMessage({
        token,
        channel,
        thread_ts: threadTs || void 0,
        post_at: postAtUnix,
        text,
        unfurl_links: false,
        unfurl_media: false
      });
      const scheduledMessageId = result.scheduled_message_id;
      const adapter = this;
      return {
        scheduledMessageId,
        channelId: channel,
        postAt: options.postAt,
        raw: result,
        async cancel() {
          await adapter.client.chat.deleteScheduledMessage({
            token,
            channel,
            scheduled_message_id: scheduledMessageId
          });
        }
      };
    } catch (error) {
      this.handleSlackError(error);
    }
  }
  async openModal(triggerId, modal, contextId) {
    const metadata = encodeModalMetadata({
      contextId,
      privateMetadata: modal.privateMetadata
    });
    const view = modalToSlackView(modal, metadata);
    this.logger.debug("Slack API: views.open", {
      triggerId,
      callbackId: modal.callbackId
    });
    try {
      const result = await this.client.views.open(
        this.withToken({
          trigger_id: triggerId,
          view
        })
      );
      this.logger.debug("Slack API: views.open response", {
        viewId: result.view?.id,
        ok: result.ok
      });
      return { viewId: result.view?.id };
    } catch (error) {
      this.handleSlackError(error);
    }
  }
  async updateModal(viewId, modal) {
    const view = modalToSlackView(modal);
    this.logger.debug("Slack API: views.update", {
      viewId,
      callbackId: modal.callbackId
    });
    try {
      const result = await this.client.views.update(
        this.withToken({
          view_id: viewId,
          view
        })
      );
      this.logger.debug("Slack API: views.update response", {
        viewId: result.view?.id,
        ok: result.ok
      });
      return { viewId: result.view?.id };
    } catch (error) {
      this.handleSlackError(error);
    }
  }
  /**
   * Upload files to Slack and share them to a channel.
   * Returns the file IDs of uploaded files.
   */
  async uploadFiles(files, channel, threadTs) {
    const bufferResults = await Promise.all(
      files.map(async (file) => {
        try {
          const fileBuffer = await toBuffer(file.data, { platform: "slack" });
          if (!fileBuffer) {
            return null;
          }
          return { file: fileBuffer, filename: file.filename };
        } catch (error) {
          this.logger.error("Failed to convert file to buffer", {
            filename: file.filename,
            error
          });
          return null;
        }
      })
    );
    const fileUploads = bufferResults.filter(
      (result2) => result2 !== null
    );
    if (fileUploads.length === 0) {
      return [];
    }
    this.logger.debug("Slack API: files.uploadV2 (batch)", {
      fileCount: fileUploads.length,
      filenames: fileUploads.map((f) => f.filename)
    });
    const uploadArgs = { channel_id: channel, file_uploads: fileUploads };
    if (threadTs) {
      uploadArgs.thread_ts = threadTs;
    }
    uploadArgs.token = this.getToken();
    const result = await this.client.files.uploadV2(uploadArgs);
    this.logger.debug("Slack API: files.uploadV2 response", { ok: result.ok });
    const fileIds = [];
    if (result.files?.[0]?.files) {
      for (const uploadedFile of result.files[0].files) {
        if (uploadedFile.id) {
          fileIds.push(uploadedFile.id);
        }
      }
    }
    return fileIds;
  }
  async editMessage(threadId, messageId, message) {
    const ephemeral = this.decodeEphemeralMessageId(messageId);
    if (ephemeral) {
      const { threadTs } = this.decodeThreadId(threadId);
      const result = await this.sendToResponseUrl(
        ephemeral.responseUrl,
        "replace",
        {
          message,
          threadTs
        }
      );
      return {
        id: ephemeral.messageTs,
        threadId,
        raw: { ephemeral: true, ...result }
      };
    }
    const { channel } = this.decodeThreadId(threadId);
    try {
      const card = extractCard(message);
      if (card) {
        const blocks = cardToBlockKit(card);
        const fallbackText = cardToFallbackText(card);
        this.logger.debug("Slack API: chat.update (blocks)", {
          channel,
          messageId,
          blockCount: blocks.length
        });
        const result2 = await this.client.chat.update(
          this.withToken({
            channel,
            ts: messageId,
            text: fallbackText,
            blocks
          })
        );
        this.logger.debug("Slack API: chat.update response", {
          messageId: result2.ts,
          ok: result2.ok
        });
        return {
          id: result2.ts,
          threadId,
          raw: result2
        };
      }
      const tableResult = this.renderWithTableBlocks(message);
      if (tableResult) {
        this.logger.debug("Slack API: chat.update (table blocks)", {
          channel,
          messageId,
          blockCount: tableResult.blocks.length
        });
        const result2 = await this.client.chat.update(
          this.withToken({
            channel,
            ts: messageId,
            text: tableResult.text,
            blocks: tableResult.blocks
          })
        );
        this.logger.debug("Slack API: chat.update response", {
          messageId: result2.ts,
          ok: result2.ok
        });
        return {
          id: result2.ts,
          threadId,
          raw: result2
        };
      }
      const text = convertEmojiPlaceholders(
        this.formatConverter.renderPostable(message),
        "slack"
      );
      this.logger.debug("Slack API: chat.update", {
        channel,
        messageId,
        textLength: text.length
      });
      const result = await this.client.chat.update(
        this.withToken({
          channel,
          ts: messageId,
          text
        })
      );
      this.logger.debug("Slack API: chat.update response", {
        messageId: result.ts,
        ok: result.ok
      });
      return {
        id: result.ts,
        threadId,
        raw: result
      };
    } catch (error) {
      this.handleSlackError(error);
    }
  }
  async deleteMessage(threadId, messageId) {
    const ephemeral = this.decodeEphemeralMessageId(messageId);
    if (ephemeral) {
      await this.sendToResponseUrl(ephemeral.responseUrl, "delete");
      return;
    }
    const { channel } = this.decodeThreadId(threadId);
    try {
      this.logger.debug("Slack API: chat.delete", { channel, messageId });
      await this.client.chat.delete(
        this.withToken({
          channel,
          ts: messageId
        })
      );
      this.logger.debug("Slack API: chat.delete response", { ok: true });
    } catch (error) {
      this.handleSlackError(error);
    }
  }
  async addReaction(threadId, messageId, emoji) {
    const { channel } = this.decodeThreadId(threadId);
    const slackEmoji = defaultEmojiResolver.toSlack(emoji);
    const name = slackEmoji.replace(/:/g, "");
    try {
      this.logger.debug("Slack API: reactions.add", {
        channel,
        messageId,
        emoji: name
      });
      await this.client.reactions.add(
        this.withToken({
          channel,
          timestamp: messageId,
          name
        })
      );
      this.logger.debug("Slack API: reactions.add response", { ok: true });
    } catch (error) {
      this.handleSlackError(error);
    }
  }
  async removeReaction(threadId, messageId, emoji) {
    const { channel } = this.decodeThreadId(threadId);
    const slackEmoji = defaultEmojiResolver.toSlack(emoji);
    const name = slackEmoji.replace(/:/g, "");
    try {
      this.logger.debug("Slack API: reactions.remove", {
        channel,
        messageId,
        emoji: name
      });
      await this.client.reactions.remove(
        this.withToken({
          channel,
          timestamp: messageId,
          name
        })
      );
      this.logger.debug("Slack API: reactions.remove response", { ok: true });
    } catch (error) {
      this.handleSlackError(error);
    }
  }
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
  async startTyping(threadId, status) {
    const { channel, threadTs } = this.decodeThreadId(threadId);
    if (!threadTs) {
      this.logger.debug("Slack: startTyping skipped - no thread context");
      return;
    }
    this.logger.debug("Slack API: assistant.threads.setStatus", {
      channel,
      threadTs,
      status
    });
    try {
      await this.client.assistant.threads.setStatus(
        this.withToken({
          channel_id: channel,
          thread_ts: threadTs,
          status: status ?? "Typing...",
          loading_messages: [status ?? "Typing..."]
        })
      );
    } catch (error) {
      this.logger.warn("Slack API: assistant.threads.setStatus failed", {
        channel,
        threadTs,
        error
      });
    }
  }
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
  async stream(threadId, textStream, options) {
    if (!(options?.recipientUserId && options?.recipientTeamId)) {
      throw new ValidationError(
        "slack",
        "Slack streaming requires recipientUserId and recipientTeamId in options"
      );
    }
    const { channel, threadTs } = this.decodeThreadId(threadId);
    this.logger.debug("Slack: starting stream", { channel, threadTs });
    const token = this.getToken();
    const streamer = this.client.chatStream({
      channel,
      thread_ts: threadTs,
      recipient_user_id: options.recipientUserId,
      recipient_team_id: options.recipientTeamId,
      ...options.taskDisplayMode && {
        task_display_mode: options.taskDisplayMode
      }
    });
    let first = true;
    let lastAppended = "";
    const renderer = new StreamingMarkdownRenderer();
    const flushMarkdownDelta = async (delta) => {
      if (delta.length === 0) {
        return;
      }
      if (first) {
        await streamer.append({ markdown_text: delta, token });
        first = false;
      } else {
        await streamer.append({ markdown_text: delta });
      }
    };
    let structuredChunksSupported = true;
    const sendStructuredChunk = async (chunk) => {
      if (!structuredChunksSupported) {
        return;
      }
      const committable = renderer.getCommittableText();
      const delta = committable.slice(lastAppended.length);
      await flushMarkdownDelta(delta);
      lastAppended = committable;
      try {
        if (first) {
          await streamer.append({ chunks: [chunk], token });
          first = false;
        } else {
          await streamer.append({ chunks: [chunk] });
        }
      } catch (error) {
        structuredChunksSupported = false;
        this.logger.warn(
          "Structured streaming chunk failed, falling back to text-only streaming. Ensure your Slack app manifest includes assistant_view, assistant:write scope, and @slack/web-api >= 7.14.0",
          { chunkType: chunk.type, error }
        );
      }
    };
    const pushTextAndFlush = async (text) => {
      renderer.push(text);
      const committable = renderer.getCommittableText();
      const delta = committable.slice(lastAppended.length);
      await flushMarkdownDelta(delta);
      lastAppended = committable;
    };
    for await (const chunk of textStream) {
      if (typeof chunk === "string") {
        await pushTextAndFlush(chunk);
      } else if (chunk.type === "markdown_text") {
        await pushTextAndFlush(chunk.text);
      } else {
        await sendStructuredChunk(chunk);
      }
    }
    renderer.finish();
    const finalCommittable = renderer.getCommittableText();
    const finalDelta = finalCommittable.slice(lastAppended.length);
    await flushMarkdownDelta(finalDelta);
    const result = await streamer.stop(
      // biome-ignore lint/suspicious/noExplicitAny: stopBlocks are platform-specific Block Kit elements
      options?.stopBlocks ? { blocks: options.stopBlocks } : void 0
    );
    const messageTs = result.message?.ts ?? result.ts;
    this.logger.debug("Slack: stream complete", { messageId: messageTs });
    return {
      id: messageTs,
      threadId,
      raw: result
    };
  }
  /**
   * Open a direct message conversation with a user.
   * Returns a thread ID that can be used to post messages.
   */
  async openDM(userId) {
    try {
      this.logger.debug("Slack API: conversations.open", { userId });
      const result = await this.client.conversations.open(
        this.withToken({ users: userId })
      );
      if (!result.channel?.id) {
        throw new NetworkError(
          "slack",
          "Failed to open DM - no channel returned"
        );
      }
      const channelId = result.channel.id;
      this.logger.debug("Slack API: conversations.open response", {
        channelId,
        ok: result.ok
      });
      return this.encodeThreadId({
        channel: channelId,
        threadTs: ""
        // Empty threadTs indicates top-level channel messages
      });
    } catch (error) {
      this.handleSlackError(error);
    }
  }
  async fetchMessages(threadId, options = {}) {
    const { channel, threadTs } = this.decodeThreadId(threadId);
    const direction = options.direction ?? "backward";
    const limit = options.limit || 100;
    try {
      if (direction === "forward") {
        return await this.fetchMessagesForward(
          channel,
          threadTs,
          threadId,
          limit,
          options.cursor
        );
      }
      return await this.fetchMessagesBackward(
        channel,
        threadTs,
        threadId,
        limit,
        options.cursor
      );
    } catch (error) {
      this.handleSlackError(error);
    }
  }
  /**
   * Fetch messages in forward direction (oldest first, efficient).
   * Uses native Slack cursor pagination.
   */
  async fetchMessagesForward(channel, threadTs, threadId, limit, cursor) {
    this.logger.debug("Slack API: conversations.replies (forward)", {
      channel,
      threadTs,
      limit,
      cursor
    });
    const result = await this.client.conversations.replies(
      this.withToken({
        channel,
        ts: threadTs,
        limit,
        cursor
      })
    );
    const slackMessages = result.messages || [];
    const nextCursor = result.response_metadata?.next_cursor;
    this.logger.debug("Slack API: conversations.replies response", {
      messageCount: slackMessages.length,
      ok: result.ok,
      hasNextCursor: !!nextCursor
    });
    const messages = await Promise.all(
      slackMessages.map((msg) => this.parseSlackMessage(msg, threadId))
    );
    return {
      messages,
      nextCursor: nextCursor || void 0
    };
  }
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
  async fetchMessagesBackward(channel, threadTs, threadId, limit, cursor) {
    const latest = cursor || void 0;
    this.logger.debug("Slack API: conversations.replies (backward)", {
      channel,
      threadTs,
      limit,
      latest
    });
    const fetchLimit = Math.min(1e3, Math.max(limit * 2, 200));
    const result = await this.client.conversations.replies(
      this.withToken({
        channel,
        ts: threadTs,
        limit: fetchLimit,
        latest,
        inclusive: false
        // Don't include the cursor message itself
      })
    );
    const slackMessages = result.messages || [];
    this.logger.debug("Slack API: conversations.replies response (backward)", {
      messageCount: slackMessages.length,
      ok: result.ok,
      hasMore: result.has_more
    });
    const startIndex = Math.max(0, slackMessages.length - limit);
    const selectedMessages = slackMessages.slice(startIndex);
    const messages = await Promise.all(
      selectedMessages.map((msg) => this.parseSlackMessage(msg, threadId))
    );
    let nextCursor;
    if (startIndex > 0 || result.has_more) {
      const oldestSelected = selectedMessages[0];
      if (oldestSelected?.ts) {
        nextCursor = oldestSelected.ts;
      }
    }
    return {
      messages,
      nextCursor
    };
  }
  async fetchThread(threadId) {
    const { channel, threadTs } = this.decodeThreadId(threadId);
    try {
      this.logger.debug("Slack API: conversations.info", { channel });
      const result = await this.client.conversations.info(
        this.withToken({ channel })
      );
      const channelInfo = result.channel;
      this.logger.debug("Slack API: conversations.info response", {
        channelName: channelInfo?.name,
        ok: result.ok
      });
      return {
        id: threadId,
        channelId: channel,
        channelName: channelInfo?.name,
        metadata: {
          threadTs,
          channel: result.channel
        }
      };
    } catch (error) {
      this.handleSlackError(error);
    }
  }
  /**
   * Fetch a single message by ID (timestamp).
   */
  async fetchMessage(threadId, messageId) {
    const { channel, threadTs } = this.decodeThreadId(threadId);
    try {
      const result = await this.client.conversations.replies(
        this.withToken({
          channel,
          ts: threadTs,
          oldest: messageId,
          inclusive: true,
          limit: 1
        })
      );
      const messages = result.messages || [];
      const target = messages.find((msg) => msg.ts === messageId);
      if (!target) {
        return null;
      }
      return this.parseSlackMessage(target, threadId);
    } catch (error) {
      this.handleSlackError(error);
    }
  }
  encodeThreadId(platformData) {
    return `slack:${platformData.channel}:${platformData.threadTs}`;
  }
  /**
   * Check if a thread is a direct message conversation.
   * Slack DM channel IDs start with 'D'.
   */
  isDM(threadId) {
    const { channel } = this.decodeThreadId(threadId);
    return channel.startsWith("D");
  }
  decodeThreadId(threadId) {
    const parts = threadId.split(":");
    if (parts.length < 2 || parts.length > 3 || parts[0] !== "slack") {
      throw new ValidationError(
        "slack",
        `Invalid Slack thread ID: ${threadId}`
      );
    }
    return {
      channel: parts[1],
      threadTs: parts.length === 3 ? parts[2] : ""
    };
  }
  parseMessage(raw) {
    const event = raw;
    const threadTs = event.thread_ts || event.ts || "";
    const threadId = this.encodeThreadId({
      channel: event.channel || "",
      threadTs
    });
    return this.parseSlackMessageSync(event, threadId);
  }
  /**
   * Synchronous message parsing without user lookup.
   * Used for parseMessage interface - falls back to user ID for username.
   */
  parseSlackMessageSync(event, threadId) {
    const isMe = this.isMessageFromSelf(event);
    const text = event.text || "";
    const userName = event.username || event.user || "unknown";
    const fullName = event.username || event.user || "unknown";
    return new Message({
      id: event.ts || "",
      threadId,
      text: this.formatConverter.extractPlainText(text),
      formatted: this.formatConverter.toAst(text),
      raw: event,
      author: {
        userId: event.user || event.bot_id || "unknown",
        userName,
        fullName,
        isBot: !!event.bot_id,
        isMe
      },
      metadata: {
        dateSent: new Date(Number.parseFloat(event.ts || "0") * 1e3),
        edited: !!event.edited,
        editedAt: event.edited ? new Date(Number.parseFloat(event.edited.ts) * 1e3) : void 0
      },
      attachments: (event.files || []).map(
        (file) => this.createAttachment(file)
      ),
      links: this.extractLinks(event)
    });
  }
  // =========================================================================
  // Channel-level methods
  // =========================================================================
  /**
   * Derive channel ID from a Slack thread ID.
   * Slack thread IDs are "slack:CHANNEL:THREAD_TS", channel ID is "slack:CHANNEL".
   */
  channelIdFromThreadId(threadId) {
    const { channel } = this.decodeThreadId(threadId);
    return `slack:${channel}`;
  }
  /**
   * Fetch channel-level messages (conversations.history, not thread replies).
   */
  async fetchChannelMessages(channelId, options = {}) {
    const channel = channelId.split(":")[1];
    if (!channel) {
      throw new ValidationError(
        "slack",
        `Invalid Slack channel ID: ${channelId}`
      );
    }
    const direction = options.direction ?? "backward";
    const limit = options.limit || 100;
    try {
      if (direction === "forward") {
        return await this.fetchChannelMessagesForward(
          channel,
          limit,
          options.cursor
        );
      }
      return await this.fetchChannelMessagesBackward(
        channel,
        limit,
        options.cursor
      );
    } catch (error) {
      this.handleSlackError(error);
    }
  }
  async fetchChannelMessagesForward(channel, limit, cursor) {
    this.logger.debug("Slack API: conversations.history (forward)", {
      channel,
      limit,
      cursor
    });
    const result = await this.client.conversations.history(
      this.withToken({
        channel,
        limit,
        oldest: cursor,
        inclusive: cursor ? false : void 0
      })
    );
    const slackMessages = (result.messages || []).reverse();
    const messages = await Promise.all(
      slackMessages.map((msg) => {
        const threadTs = msg.thread_ts || msg.ts || "";
        const threadId = `slack:${channel}:${threadTs}`;
        return this.parseSlackMessage(msg, threadId, {
          skipSelfMention: false
        });
      })
    );
    let nextCursor;
    if (result.has_more && slackMessages.length > 0) {
      const newest = slackMessages.at(-1);
      if (newest?.ts) {
        nextCursor = newest.ts;
      }
    }
    return {
      messages,
      nextCursor
    };
  }
  async fetchChannelMessagesBackward(channel, limit, cursor) {
    this.logger.debug("Slack API: conversations.history (backward)", {
      channel,
      limit,
      cursor
    });
    const result = await this.client.conversations.history(
      this.withToken({
        channel,
        limit,
        latest: cursor,
        inclusive: cursor ? false : void 0
      })
    );
    const slackMessages = result.messages || [];
    const chronological = [...slackMessages].reverse();
    const messages = await Promise.all(
      chronological.map((msg) => {
        const threadTs = msg.thread_ts || msg.ts || "";
        const threadId = `slack:${channel}:${threadTs}`;
        return this.parseSlackMessage(msg, threadId, {
          skipSelfMention: false
        });
      })
    );
    let nextCursor;
    if (result.has_more && chronological.length > 0) {
      const oldest = chronological[0];
      if (oldest?.ts) {
        nextCursor = oldest.ts;
      }
    }
    return {
      messages,
      nextCursor
    };
  }
  /**
   * List threads in a Slack channel.
   * Fetches channel history and filters for messages with replies.
   */
  async listThreads(channelId, options = {}) {
    const channel = channelId.split(":")[1];
    if (!channel) {
      throw new ValidationError(
        "slack",
        `Invalid Slack channel ID: ${channelId}`
      );
    }
    const limit = options.limit || 50;
    try {
      this.logger.debug("Slack API: conversations.history (listThreads)", {
        channel,
        limit,
        cursor: options.cursor
      });
      const result = await this.client.conversations.history(
        this.withToken({
          channel,
          limit: Math.min(limit * 3, 200),
          // Fetch extra since not all have threads
          cursor: options.cursor
        })
      );
      const slackMessages = result.messages || [];
      const threadMessages = slackMessages.filter(
        (msg) => (msg.reply_count ?? 0) > 0
      );
      const selected = threadMessages.slice(0, limit);
      const threads = await Promise.all(
        selected.map(async (msg) => {
          const threadTs = msg.ts || "";
          const threadId = `slack:${channel}:${threadTs}`;
          const rootMessage = await this.parseSlackMessage(msg, threadId, {
            skipSelfMention: false
          });
          return {
            id: threadId,
            rootMessage,
            replyCount: msg.reply_count,
            lastReplyAt: msg.latest_reply ? new Date(Number.parseFloat(msg.latest_reply) * 1e3) : void 0
          };
        })
      );
      const nextCursor = result.response_metadata?.next_cursor;
      return {
        threads,
        nextCursor: nextCursor || void 0
      };
    } catch (error) {
      this.handleSlackError(error);
    }
  }
  /**
   * Fetch Slack channel info/metadata.
   */
  async fetchChannelInfo(channelId) {
    const channel = channelId.split(":")[1];
    if (!channel) {
      throw new ValidationError(
        "slack",
        `Invalid Slack channel ID: ${channelId}`
      );
    }
    try {
      this.logger.debug("Slack API: conversations.info (channel)", { channel });
      const result = await this.client.conversations.info(
        this.withToken({ channel })
      );
      const info = result.channel;
      return {
        id: channelId,
        name: info?.name ? `#${info.name}` : void 0,
        isDM: Boolean(info?.is_im || info?.is_mpim),
        memberCount: info?.num_members,
        metadata: {
          purpose: info?.purpose?.value,
          topic: info?.topic?.value
        }
      };
    } catch (error) {
      this.handleSlackError(error);
    }
  }
  /**
   * Post a top-level message to a channel (not in a thread).
   */
  async postChannelMessage(channelId, message) {
    const channel = channelId.split(":")[1];
    if (!channel) {
      throw new ValidationError(
        "slack",
        `Invalid Slack channel ID: ${channelId}`
      );
    }
    const syntheticThreadId = `slack:${channel}:`;
    return await this.postMessage(syntheticThreadId, message);
  }
  renderFormatted(content) {
    return this.formatConverter.fromAst(content);
  }
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
  isMessageFromSelf(event) {
    const ctx = this.requestContext.getStore();
    if (ctx?.botUserId && event.user === ctx.botUserId) {
      return true;
    }
    if (this._botUserId && event.user === this._botUserId) {
      return true;
    }
    if (this._botId && event.bot_id === this._botId) {
      return true;
    }
    return false;
  }
  handleSlackError(error) {
    const slackError = error;
    if (slackError.code === "slack_webapi_platform_error" && slackError.data?.error === "ratelimited") {
      throw new AdapterRateLimitError("slack");
    }
    throw error;
  }
  /**
   * Encode response_url and userId into messageId for ephemeral messages.
   * This allows edit/delete operations to work via response_url.
   */
  encodeEphemeralMessageId(messageTs, responseUrl, userId) {
    const data = JSON.stringify({ responseUrl, userId });
    return `ephemeral:${messageTs}:${btoa(data)}`;
  }
  /**
   * Decode ephemeral messageId to extract messageTs, responseUrl, and userId.
   * Returns null if the messageId is not an ephemeral encoding.
   */
  decodeEphemeralMessageId(messageId) {
    if (!messageId.startsWith("ephemeral:")) {
      return null;
    }
    const parts = messageId.split(":");
    if (parts.length < 3) {
      return null;
    }
    const messageTs = parts[1];
    const encodedData = parts.slice(2).join(":");
    try {
      const decoded = atob(encodedData);
      try {
        const data = JSON.parse(decoded);
        if (data.responseUrl && data.userId) {
          return {
            messageTs,
            responseUrl: data.responseUrl,
            userId: data.userId
          };
        }
      } catch {
        return { messageTs, responseUrl: decoded, userId: "" };
      }
      return null;
    } catch {
      this.logger.warn("Failed to decode ephemeral messageId", { messageId });
      return null;
    }
  }
  /**
   * Send a request to Slack's response_url to modify an ephemeral message.
   */
  async sendToResponseUrl(responseUrl, action, options) {
    let payload;
    if (action === "delete") {
      payload = { delete_original: true };
    } else {
      const message = options?.message;
      if (!message) {
        throw new ValidationError(
          "slack",
          "Message required for replace action"
        );
      }
      const card = extractCard(message);
      if (card) {
        payload = {
          replace_original: true,
          text: cardToFallbackText(card),
          blocks: cardToBlockKit(card)
        };
      } else {
        const tableResult = this.renderWithTableBlocks(message);
        if (tableResult) {
          payload = {
            replace_original: true,
            text: tableResult.text,
            blocks: tableResult.blocks
          };
        } else {
          payload = {
            replace_original: true,
            text: convertEmojiPlaceholders(
              this.formatConverter.renderPostable(message),
              "slack"
            )
          };
        }
      }
      if (options?.threadTs) {
        payload.thread_ts = options.threadTs;
      }
    }
    this.logger.debug("Slack response_url request", {
      action,
      threadTs: options?.threadTs
    });
    const response = await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error("Slack response_url failed", {
        action,
        status: response.status,
        body: errorText
      });
      throw new NetworkError(
        "slack",
        `Failed to ${action} via response_url: ${errorText}`
      );
    }
    const responseText = await response.text();
    if (responseText) {
      try {
        return JSON.parse(responseText);
      } catch {
        return { raw: responseText };
      }
    }
    return {};
  }
};
function createSlackAdapter(config) {
  return new SlackAdapter(config ?? {});
}
export {
  SlackAdapter,
  SlackFormatConverter,
  SlackFormatConverter as SlackMarkdownConverter,
  cardToBlockKit,
  cardToFallbackText,
  createSlackAdapter,
  decodeKey
};
//# sourceMappingURL=index.js.map