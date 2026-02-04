/**
 * App Builder Message Filtering and Pagination
 *
 * Filters verbose agent messages to show only important, user-facing content.
 * Also provides session-based pagination to avoid overwhelming the UI with long histories.
 * Designed for a clean "vibe" app builder experience.
 */

import type { CloudMessage } from '@/components/cloud-agent/types';

/**
 * Default number of "sessions" to show initially.
 * A session is a user message plus all assistant/system messages that follow.
 */
export const DEFAULT_VISIBLE_SESSIONS = 2;

/**
 * Result type for paginated messages
 */
export type PaginatedMessagesResult = {
  visibleMessages: CloudMessage[];
  hasOlderMessages: boolean;
};

/**
 * Determine the display role of a message.
 * user_feedback messages should display as user messages.
 */
export function getMessageRole(msg: CloudMessage): 'user' | 'assistant' | 'system' {
  if (msg.say === 'user_feedback') return 'user';
  return msg.type;
}

/**
 * Say types to completely hide from the chat
 */
const HIDDEN_SAY_TYPES = [
  'reasoning', // Internal AI thinking
  'checkpoint_saved', // Git checkpoint hashes
  'api_req_started', // API token/cost tracking
  'api_req_finished', // API completion (redundant info)
  'error', // Internal errors (should be handled differently)
  'shell_integration_warning', // Shell integration messages
];

/**
 * Ask types to completely hide from the chat
 */
const HIDDEN_ASK_TYPES = [
  'resume_task', // Internal task resumption
  'resume_completed_task', // Internal task resumption
  'command_output', // Usually duplicates say:command_output
];

/**
 * Check if a message is an empty text message
 */
function isEmptyTextMessage(msg: CloudMessage): boolean {
  if (msg.say !== 'text' && msg.say !== undefined) return false;

  const content = msg.text || msg.content || '';
  return content.trim() === '';
}

/**
 * Check if a message should be shown based on its type
 */
function shouldShowMessage(msg: CloudMessage): boolean {
  // Hide based on say type
  if (msg.say && HIDDEN_SAY_TYPES.includes(msg.say)) return false;

  // Hide based on ask type
  if (msg.ask && HIDDEN_ASK_TYPES.includes(msg.ask)) return false;

  // Hide empty text messages
  if (isEmptyTextMessage(msg)) return false;

  // Show completion results prominently
  if (msg.say === 'completion_result') return true;

  // Show status messages
  if (msg.say === 'status') return true;

  // Show command output
  if (msg.say === 'command_output') return true;

  // Show commands being executed
  if (msg.ask === 'command') return true;

  // Show tool usage with meaningful metadata
  if (msg.ask === 'tool' || msg.ask === 'use_mcp_tool') {
    // Only show if there's meaningful tool info
    return Boolean(msg.metadata?.tool || msg.content || msg.text);
  }

  // Show text messages with actual content
  if ((msg.say === 'text' || !msg.say) && (msg.text || msg.content)) {
    return true;
  }

  if (msg.say === 'user_feedback') {
    return true;
  }

  // Show system messages with content (check type separately to avoid TS error)
  if (msg.type === 'system' && (msg.text || msg.content)) {
    return true;
  }

  // Default: hide unknown/unhandled types for cleaner UI
  return false;
}

/**
 * Deduplicate ask messages that have both answered and unanswered versions
 * Also removes ask:command_output that duplicates say:command_output
 */
function deduplicateMessages(messages: CloudMessage[]): CloudMessage[] {
  const result: CloudMessage[] = [];
  const seenCommandOutputs = new Set<string>();

  // First pass: collect all command outputs
  for (const msg of messages) {
    if (msg.say === 'command_output') {
      const content = msg.text || msg.content || '';
      if (content) {
        seenCommandOutputs.add(content.substring(0, 100)); // Use first 100 chars as key
      }
    }
  }

  // Second pass: filter out duplicate command outputs from ask messages
  for (const msg of messages) {
    if (msg.ask === 'command_output') {
      const content = msg.text || msg.content || '';
      // Skip if we have a say:command_output with same content
      if (content && seenCommandOutputs.has(content.substring(0, 100))) {
        continue;
      }
    }
    result.push(msg);
  }

  return result;
}

/**
 * Main filter function for App Builder messages
 *
 * Filters out verbose/internal messages to create a clean chat view showing:
 * - Commands being executed (brief)
 * - Command results (collapsible)
 * - Status updates (badges)
 * - Final completion result (prominent)
 *
 * @param messages - Array of CloudMessages from the stream
 * @returns Filtered array of messages for display
 */
export function filterAppBuilderMessages(messages: CloudMessage[]): CloudMessage[] {
  const visibleMessages = messages.filter(shouldShowMessage);
  const deduplicated = deduplicateMessages(visibleMessages);
  return deduplicated;
}

/**
 * Paginate messages by "sessions" - each session is a user message
 * plus all assistant/system messages that follow until the next user message.
 *
 * This ensures we never cut a conversation turn in the middle.
 *
 * @param messages - Array of filtered CloudMessages
 * @param visibleSessionCount - Number of user sessions to show (default: DEFAULT_VISIBLE_SESSIONS)
 * @returns Visible messages and whether there are older messages to load
 */
export function paginateMessages(
  messages: CloudMessage[],
  visibleSessionCount = DEFAULT_VISIBLE_SESSIONS
): PaginatedMessagesResult {
  // Find indices of all user messages (session boundaries)
  const userMessageIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (getMessageRole(messages[i]) === 'user') {
      userMessageIndices.push(i);
    }
  }

  // If we have fewer sessions than threshold, show all
  if (userMessageIndices.length <= visibleSessionCount) {
    return {
      visibleMessages: messages,
      hasOlderMessages: false,
    };
  }

  // Find cutoff: start from the Nth-to-last user message
  const cutoffIndex = userMessageIndices[userMessageIndices.length - visibleSessionCount];

  return {
    visibleMessages: messages.slice(cutoffIndex),
    hasOlderMessages: true,
  };
}
