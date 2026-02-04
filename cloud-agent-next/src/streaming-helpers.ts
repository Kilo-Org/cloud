import { stripVTControlCharacters } from 'node:util';

/**
 * Attempts to parse a string as JSON, with optional ANSI stripping.
 * Tries both the original line and ANSI-stripped version.
 * @returns Parsed object if successful, null otherwise
 */
export function tryParseJson(line: string): Record<string, unknown> | null {
  // Try both original and ANSI-stripped versions
  for (const candidate of [line, stripVTControlCharacters(line)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Continue to next candidate
    }
  }
  return null;
}

/**
 * Result of checking if a Kilocode event is terminal.
 */
export interface TerminalEventCheck {
  isTerminal: boolean;
  reason?: string;
}

/**
 * Checks if a Kilocode event indicates a terminal/unrecoverable state in --auto mode.
 * These events cause the CLI to wait for user input that will never come.
 *
 * @param payload The parsed Kilocode event payload
 * @returns Object indicating if the event is terminal and why
 */
export function isTerminalKilocodeEvent(payload: Record<string, unknown>): TerminalEventCheck {
  // Ask events that indicate unrecoverable errors in --auto mode
  if (payload.type === 'ask') {
    // api_req_failed: Authentication or API errors that can't be resolved by retrying
    if (payload.ask === 'api_req_failed') {
      return {
        isTerminal: true,
        reason: `API request failed: ${typeof payload.content === 'string' ? payload.content : 'Unknown error'}`,
      };
    }

    // payment_required_prompt: User needs to add credits to continue
    if (payload.ask === 'payment_required_prompt') {
      const metadata = payload.metadata as Record<string, unknown> | undefined;
      const message =
        typeof metadata?.message === 'string'
          ? metadata.message
          : typeof metadata?.title === 'string'
            ? metadata.title
            : 'Credits required to continue';
      return {
        isTerminal: true,
        reason: message,
      };
    }
  }
  return { isTerminal: false };
}
