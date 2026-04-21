// src/adapter-utils.ts
import { isCardElement } from "chat";
function extractCard(message) {
  if (isCardElement(message)) {
    return message;
  }
  if (typeof message === "object" && message !== null && "card" in message) {
    return message.card;
  }
  return null;
}
function extractFiles(message) {
  if (typeof message === "object" && message !== null && "files" in message) {
    return message.files ?? [];
  }
  return [];
}

// src/errors.ts
var AdapterError = class extends Error {
  adapter;
  code;
  /**
   * @param message - Human-readable error message
   * @param adapter - Name of the adapter (e.g., "slack", "teams", "gchat")
   * @param code - Optional error code for programmatic handling
   */
  constructor(message, adapter, code) {
    super(message);
    this.name = "AdapterError";
    this.adapter = adapter;
    this.code = code;
  }
};
var AdapterRateLimitError = class extends AdapterError {
  retryAfter;
  constructor(adapter, retryAfter) {
    super(
      `Rate limited by ${adapter}${retryAfter ? `, retry after ${retryAfter}s` : ""}`,
      adapter,
      "RATE_LIMITED"
    );
    this.name = "AdapterRateLimitError";
    this.retryAfter = retryAfter;
  }
};
var AuthenticationError = class extends AdapterError {
  constructor(adapter, message) {
    super(
      message || `Authentication failed for ${adapter}`,
      adapter,
      "AUTH_FAILED"
    );
    this.name = "AuthenticationError";
  }
};
var ResourceNotFoundError = class extends AdapterError {
  resourceType;
  resourceId;
  constructor(adapter, resourceType, resourceId) {
    const idPart = resourceId ? ` '${resourceId}'` : "";
    super(
      `${resourceType}${idPart} not found in ${adapter}`,
      adapter,
      "NOT_FOUND"
    );
    this.name = "ResourceNotFoundError";
    this.resourceType = resourceType;
    this.resourceId = resourceId;
  }
};
var PermissionError = class extends AdapterError {
  action;
  requiredScope;
  constructor(adapter, action, requiredScope) {
    const scopePart = requiredScope ? ` (requires: ${requiredScope})` : "";
    super(
      `Permission denied: cannot ${action} in ${adapter}${scopePart}`,
      adapter,
      "PERMISSION_DENIED"
    );
    this.name = "PermissionError";
    this.action = action;
    this.requiredScope = requiredScope;
  }
};
var ValidationError = class extends AdapterError {
  constructor(adapter, message) {
    super(message, adapter, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
};
var NetworkError = class extends AdapterError {
  originalError;
  constructor(adapter, message, originalError) {
    super(
      message || `Network error communicating with ${adapter}`,
      adapter,
      "NETWORK_ERROR"
    );
    this.name = "NetworkError";
    this.originalError = originalError;
  }
};

// src/buffer-utils.ts
async function toBuffer(data, options) {
  const { platform, throwOnUnsupported = true } = options;
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (data instanceof Blob) {
    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  if (throwOnUnsupported) {
    throw new ValidationError(platform, "Unsupported file data type");
  }
  return null;
}
function toBufferSync(data, options) {
  const { platform, throwOnUnsupported = true } = options;
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (data instanceof Blob) {
    if (throwOnUnsupported) {
      throw new ValidationError(
        platform,
        "Cannot convert Blob synchronously. Use toBuffer() for async conversion."
      );
    }
    return null;
  }
  if (throwOnUnsupported) {
    throw new ValidationError(platform, "Unsupported file data type");
  }
  return null;
}
function bufferToDataUri(buffer, mimeType = "application/octet-stream") {
  const base64 = buffer.toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

// src/card-utils.ts
import {
  convertEmojiPlaceholders,
  cardChildToFallbackText as coreCardChildToFallbackText,
  tableElementToAscii
} from "chat";
var BUTTON_STYLE_MAPPINGS = {
  slack: { primary: "primary", danger: "danger" },
  gchat: { primary: "primary", danger: "danger" },
  // Colors handled via buttonColor
  teams: { primary: "positive", danger: "destructive" },
  discord: { primary: "primary", danger: "danger" }
};
function createEmojiConverter(platform) {
  return (text) => convertEmojiPlaceholders(text, platform);
}
function mapButtonStyle(style, platform) {
  if (!style) {
    return void 0;
  }
  return BUTTON_STYLE_MAPPINGS[platform][style];
}
function cardToFallbackText(card, options = {}) {
  const { boldFormat = "*", lineBreak = "\n", platform } = options;
  const convertText = platform ? createEmojiConverter(platform) : (t) => t;
  const parts = [];
  if (card.title) {
    parts.push(`${boldFormat}${convertText(card.title)}${boldFormat}`);
  }
  if (card.subtitle) {
    parts.push(convertText(card.subtitle));
  }
  for (const child of card.children) {
    const text = childToFallbackText(child, convertText);
    if (text) {
      parts.push(text);
    }
  }
  return parts.join(lineBreak);
}
function childToFallbackText(child, convertText) {
  switch (child.type) {
    case "text":
      return convertText(child.content);
    case "link":
      return `${convertText(child.label)} (${child.url})`;
    case "fields":
      return child.children.map((f) => `${convertText(f.label)}: ${convertText(f.value)}`).join("\n");
    case "actions":
      return null;
    case "section":
      return child.children.map((c) => childToFallbackText(c, convertText)).filter(Boolean).join("\n");
    case "table":
      return tableElementToAscii(child.headers, child.rows);
    case "divider":
      return "---";
    default:
      return coreCardChildToFallbackText(child);
  }
}
function escapeTableCell(value) {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
function renderGfmTable(table) {
  const headers = table.headers.map(escapeTableCell);
  const lines = [];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of table.rows) {
    const cells = row.map(escapeTableCell);
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines;
}
export {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  BUTTON_STYLE_MAPPINGS,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
  bufferToDataUri,
  cardToFallbackText,
  createEmojiConverter,
  escapeTableCell,
  extractCard,
  extractFiles,
  mapButtonStyle,
  renderGfmTable,
  toBuffer,
  toBufferSync
};
//# sourceMappingURL=index.js.map