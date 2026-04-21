import { AdapterPostableMessage, CardElement, FileUpload, ButtonElement, TableElement } from 'chat';

/**
 * Shared utility functions for chat adapters.
 *
 * These utilities are used across all adapter implementations (Slack, Teams, GChat)
 * to reduce code duplication and ensure consistent behavior.
 */

/**
 * Extract CardElement from an AdapterPostableMessage if present.
 *
 * Handles two cases:
 * 1. The message IS a CardElement (type: "card")
 * 2. The message is a PostableCard with a `card` property
 *
 * @param message - The message to extract the card from
 * @returns The CardElement if found, null otherwise
 *
 * @example
 * ```typescript
 * // Case 1: Direct CardElement
 * const card = Card({ title: "Test" });
 * extractCard(card); // returns the card
 *
 * // Case 2: PostableCard wrapper
 * const message = { card, fallbackText: "..." };
 * extractCard(message); // returns the card
 *
 * // Case 3: Non-card message
 * extractCard("Hello"); // returns null
 * extractCard({ markdown: "**bold**" }); // returns null
 * ```
 */
declare function extractCard(message: AdapterPostableMessage): CardElement | null;
/**
 * Extract FileUpload array from an AdapterPostableMessage if present.
 *
 * Files can be attached to PostableRaw, PostableMarkdown, PostableAst,
 * or PostableCard messages via the `files` property.
 *
 * @param message - The message to extract files from
 * @returns Array of FileUpload objects, or empty array if none
 *
 * @example
 * ```typescript
 * // With files
 * const message = {
 *   markdown: "**Text**",
 *   files: [{ data: Buffer.from("..."), filename: "doc.pdf" }]
 * };
 * extractFiles(message); // returns the files array
 *
 * // Without files
 * extractFiles("Hello"); // returns []
 * extractFiles({ raw: "text" }); // returns []
 * ```
 */
declare function extractFiles(message: AdapterPostableMessage): FileUpload[];

/**
 * Shared card conversion utilities for adapters.
 *
 * These utilities reduce duplication across adapter implementations
 * for card-to-platform-format conversions.
 */

/**
 * Supported platform names for adapter utilities.
 */
type PlatformName = "slack" | "gchat" | "teams" | "discord";
/**
 * Button style mappings per platform.
 *
 * Maps our standard button styles ("primary", "danger") to
 * platform-specific values.
 */
declare const BUTTON_STYLE_MAPPINGS: Record<PlatformName, Record<string, string>>;
/**
 * Create a platform-specific emoji converter function.
 *
 * Returns a function that converts emoji placeholders (e.g., `{{emoji:wave}}`)
 * to the platform's native format.
 *
 * @example
 * ```typescript
 * const convertEmoji = createEmojiConverter("slack");
 * convertEmoji("{{emoji:wave}} Hello"); // ":wave: Hello"
 * ```
 */
declare function createEmojiConverter(platform: PlatformName): (text: string) => string;
/**
 * Map a button style to the platform-specific value.
 *
 * @example
 * ```typescript
 * mapButtonStyle("primary", "teams"); // "positive"
 * mapButtonStyle("danger", "slack");  // "danger"
 * mapButtonStyle(undefined, "teams"); // undefined
 * ```
 */
declare function mapButtonStyle(style: ButtonElement["style"], platform: PlatformName): string | undefined;
/**
 * Options for fallback text generation.
 */
interface FallbackTextOptions {
    /** Bold format string (default: "*" for mrkdwn, "**" for markdown) */
    boldFormat?: "*" | "**";
    /** Line break between sections (default: "\n") */
    lineBreak?: "\n" | "\n\n";
    /** Platform for emoji conversion (optional) */
    platform?: PlatformName;
}
/**
 * Generate fallback plain text from a card element.
 *
 * Used when the platform can't render rich cards or for notification previews.
 * Consolidates duplicate implementations from individual adapters.
 *
 * @example
 * ```typescript
 * // Slack-style (mrkdwn)
 * cardToFallbackText(card, { boldFormat: "*", platform: "slack" });
 *
 * // Teams-style (markdown with double line breaks)
 * cardToFallbackText(card, { boldFormat: "**", lineBreak: "\n\n", platform: "teams" });
 * ```
 */
declare function cardToFallbackText(card: CardElement, options?: FallbackTextOptions): string;
/**
 * Escape a cell value for use in a GFM pipe table.
 * Escapes `|` to `\|` and replaces newlines with spaces.
 */
declare function escapeTableCell(value: string): string;
/**
 * Render a TableElement as a GFM markdown table with properly escaped cells.
 * Shared by adapters that support native GFM table rendering (GitHub, Linear, Discord).
 */
declare function renderGfmTable(table: TableElement): string[];

/**
 * Buffer conversion utilities for handling file uploads.
 *
 * These utilities handle the conversion of various data types
 * (Buffer, ArrayBuffer, Blob) to Node.js Buffer for file uploads.
 */

/**
 * The supported input types for file data.
 */
type FileDataInput = Buffer | ArrayBuffer | Blob;
/**
 * Options for buffer conversion.
 */
interface ToBufferOptions {
    /**
     * The platform name for error messages.
     */
    platform: PlatformName;
    /**
     * If true, throws ValidationError for unsupported types.
     * If false, returns null for unsupported types.
     * Default: true
     */
    throwOnUnsupported?: boolean;
}
/**
 * Convert various data types to a Node.js Buffer.
 *
 * Handles:
 * - Buffer: returned as-is
 * - ArrayBuffer: converted using Buffer.from()
 * - Blob: converted via arrayBuffer() then Buffer.from()
 *
 * @param data - The file data to convert
 * @param options - Conversion options
 * @returns Buffer or null if conversion fails and throwOnUnsupported is false
 * @throws ValidationError if data type is unsupported and throwOnUnsupported is true
 *
 * @example
 * ```typescript
 * // Throw on unsupported (default behavior)
 * const buffer = await toBuffer(file.data, { platform: "slack" });
 *
 * // Return null on unsupported
 * const buffer = await toBuffer(file.data, { platform: "teams", throwOnUnsupported: false });
 * if (!buffer) continue; // Skip unsupported files
 * ```
 */
declare function toBuffer(data: FileDataInput | unknown, options: ToBufferOptions): Promise<Buffer | null>;
/**
 * Synchronous version of toBuffer for non-Blob data.
 *
 * Use this when you know the data is not a Blob (e.g., already validated).
 *
 * @param data - The file data to convert (Buffer or ArrayBuffer only)
 * @param options - Conversion options
 * @returns Buffer or null if conversion fails
 * @throws ValidationError if data is a Blob or unsupported type and throwOnUnsupported is true
 */
declare function toBufferSync(data: Buffer | ArrayBuffer | unknown, options: ToBufferOptions): Buffer | null;
/**
 * Convert a Buffer to a data URI string.
 *
 * @param buffer - The buffer to convert
 * @param mimeType - The MIME type (default: application/octet-stream)
 * @returns Data URI string in format `data:{mimeType};base64,{base64Data}`
 *
 * @example
 * ```typescript
 * const dataUri = bufferToDataUri(buffer, "image/png");
 * // "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgA..."
 * ```
 */
declare function bufferToDataUri(buffer: Buffer, mimeType?: string): string;

/**
 * Standardized error types for chat adapters.
 *
 * These error classes provide consistent error handling across all
 * adapter implementations.
 */
/**
 * Base error class for adapter operations.
 *
 * All adapter-specific errors should extend this class.
 */
declare class AdapterError extends Error {
    readonly adapter: string;
    readonly code?: string;
    /**
     * @param message - Human-readable error message
     * @param adapter - Name of the adapter (e.g., "slack", "teams", "gchat")
     * @param code - Optional error code for programmatic handling
     */
    constructor(message: string, adapter: string, code?: string);
}
/**
 * Rate limit error - thrown when platform API rate limits are hit.
 *
 * @example
 * ```typescript
 * throw new AdapterRateLimitError("slack", 30);
 * // message: "Rate limited by slack, retry after 30s"
 * ```
 */
declare class AdapterRateLimitError extends AdapterError {
    readonly retryAfter?: number;
    constructor(adapter: string, retryAfter?: number);
}
/**
 * Authentication error - thrown when credentials are invalid or expired.
 *
 * @example
 * ```typescript
 * throw new AuthenticationError("teams", "Token expired");
 * ```
 */
declare class AuthenticationError extends AdapterError {
    constructor(adapter: string, message?: string);
}
/**
 * Not found error - thrown when a requested resource doesn't exist.
 *
 * @example
 * ```typescript
 * throw new ResourceNotFoundError("slack", "channel", "C123456");
 * // message: "channel 'C123456' not found in slack"
 * ```
 */
declare class ResourceNotFoundError extends AdapterError {
    readonly resourceType: string;
    readonly resourceId?: string;
    constructor(adapter: string, resourceType: string, resourceId?: string);
}
/**
 * Permission error - thrown when the bot lacks required permissions.
 *
 * @example
 * ```typescript
 * throw new PermissionError("teams", "send messages", "channels:write");
 * ```
 */
declare class PermissionError extends AdapterError {
    readonly action: string;
    readonly requiredScope?: string;
    constructor(adapter: string, action: string, requiredScope?: string);
}
/**
 * Validation error - thrown when input data is invalid.
 *
 * @example
 * ```typescript
 * throw new ValidationError("slack", "Message text exceeds 40000 characters");
 * ```
 */
declare class ValidationError extends AdapterError {
    constructor(adapter: string, message: string);
}
/**
 * Network error - thrown when there's a network/connectivity issue.
 *
 * @example
 * ```typescript
 * throw new NetworkError("gchat", "Connection timeout after 30s");
 * ```
 */
declare class NetworkError extends AdapterError {
    readonly originalError?: Error;
    constructor(adapter: string, message?: string, originalError?: Error);
}

export { AdapterError, AdapterRateLimitError, AuthenticationError, BUTTON_STYLE_MAPPINGS, type FallbackTextOptions, type FileDataInput, NetworkError, PermissionError, type PlatformName, ResourceNotFoundError, type ToBufferOptions, ValidationError, bufferToDataUri, cardToFallbackText, createEmojiConverter, escapeTableCell, extractCard, extractFiles, mapButtonStyle, renderGfmTable, toBuffer, toBufferSync };
