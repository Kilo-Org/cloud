/**
 * Shared utilities for App Builder message transformation.
 *
 * Centralizes logic for:
 * - Stripping system context from user messages
 * - Determining message type (user/assistant/system)
 * - Parsing text as metadata for tool messages
 */

import { APP_BUILDER_SYSTEM_CONTEXT_FIRST_LINE } from '@/lib/app-builder/constants';

/**
 * Cutoff date for messages that need system context stripping.
 * Messages before this date had system context embedded in the user prompt.
 * Messages after this date use a separate system context field.
 */
export const SYSTEM_CONTEXT_CUTOFF_DATE = new Date('2026-02-01').getTime();

/**
 * The marker used to separate system context from user request in old prompts.
 */
const USER_REQUEST_MARKER = '\n\nUser Request:\n\n---';

/**
 * Strip system context prefix from a message text.
 *
 * For messages before the cutoff date, user prompts had system context
 * prepended. This function strips that context to show only the
 * original user request.
 *
 * @param text - The message text to process
 * @param timestamp - The message timestamp (Unix ms). If before cutoff date, context is stripped.
 * @returns The text with system context stripped if applicable
 */
export function stripSystemContext(text: string, timestamp?: number): string {
  // Only strip for messages before the cutoff date
  if (timestamp !== undefined && timestamp >= SYSTEM_CONTEXT_CUTOFF_DATE) {
    return text;
  }

  // Check if text starts with system context
  if (!text.startsWith(APP_BUILDER_SYSTEM_CONTEXT_FIRST_LINE)) {
    return text;
  }

  // Find and extract just the user request
  const userRequestIndex = text.indexOf(USER_REQUEST_MARKER);
  if (userRequestIndex === -1) {
    return text;
  }

  return text.slice(userRequestIndex + USER_REQUEST_MARKER.length).trimStart();
}

/**
 * Determines if a message text contains embedded system context (legacy format).
 *
 * @param text - The message text to check
 * @returns True if the text contains embedded system context
 */
export function hasSystemContext(text: string): boolean {
  return text.startsWith(APP_BUILDER_SYSTEM_CONTEXT_FIRST_LINE);
}

/**
 * Determine the display message type from raw message fields.
 *
 * Maps the internal message representation to the three display types:
 * - 'user': Messages from the user
 * - 'assistant': AI responses
 * - 'system': Status/info messages
 *
 * @param rawType - The raw type field (e.g., 'say', 'ask', 'user')
 * @param rawRole - The raw role field (e.g., 'user', 'assistant')
 * @param say - The say subtype (e.g., 'text', 'user_feedback')
 * @param text - The message text (used for legacy detection)
 * @returns The display message type
 */
export function determineMessageType(
  rawType: string | undefined,
  rawRole: string | undefined,
  say: string | undefined,
  text: string
): 'user' | 'assistant' | 'system' {
  if (rawType === 'say') {
    // user_feedback or messages starting with system context are user messages
    if (say === 'user_feedback' || hasSystemContext(text)) {
      return 'user';
    }
    return 'assistant';
  }
  if (rawType === 'ask') return 'assistant';
  if (rawType === 'user' || rawRole === 'user') return 'user';
  if (rawType === 'assistant' || rawRole === 'assistant') return 'assistant';
  if (rawType === 'system' || rawRole === 'system') return 'system';
  return 'assistant';
}

/**
 * Checks if a message's text should be parsed as JSON metadata.
 *
 * Certain ask/say types encode their metadata as JSON in the text field.
 * This function identifies those types.
 *
 * @param ask - The ask subtype
 * @param say - The say subtype
 * @returns True if text should be parsed as metadata
 */
export function shouldParseTextAsMetadata(ask?: string, say?: string): boolean {
  return (
    ask === 'tool' ||
    ask === 'use_mcp_tool' ||
    ask === 'command' ||
    say === 'api_req_started' ||
    say === 'tool'
  );
}

/**
 * Strip the `<available_images>...</available_images>` XML block appended to
 * user messages that have image attachments.  The block is only meaningful
 * to the AI agent; it should not be shown in the UI.
 */
export function stripImageContext(text: string): string {
  return text.replace(/\n*<available_images>[\s\S]*?<\/available_images>\s*$/, '');
}

/**
 * Attempts to parse text as JSON metadata.
 *
 * @param text - The text to parse
 * @returns The parsed object, or undefined if not valid JSON or not an object
 */
export function parseTextAsJson(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
