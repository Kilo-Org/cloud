import { TRPCError } from '@trpc/server';
import { stripVTControlCharacters } from 'node:util';
import type { TRPCContext, StreamEvent, SystemErrorEvent } from './types.js';
import { logger } from './logger.js';

/**
 * Attempts to parse a string as JSON, with optional ANSI stripping.
 * Tries both the original line and ANSI-stripped version.
 * @returns Parsed object if successful, null otherwise
 */
export function tryParseJson(line: string): Record<string, unknown> | null {
  // Try both original and ANSI-stripped versions
  for (const candidate of [line, stripVTControlCharacters(line)]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
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
 * Wraps an async generator to catch errors and emit them as streaming error events.
 * Ensures consistent error handling across streaming procedures.
 * @param generator The async generator to wrap
 * @param options Context information for error events
 */
export async function* wrapStreamingErrors(
  generator: AsyncGenerator<StreamEvent>,
  options: { sessionId?: string; ctx: TRPCContext }
): AsyncGenerator<StreamEvent> {
  try {
    yield* generator;
  } catch (error) {
    logger
      .withFields({
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        details:
          error instanceof TRPCError && error.cause
            ? error.cause instanceof Error
              ? error.cause.message
              : String(error.cause)
            : undefined,
      })
      .error('Streaming error caught');

    const errorEvent: SystemErrorEvent = {
      streamEventType: 'error',
      error: error instanceof Error ? error.message : String(error),
      details: error instanceof TRPCError ? error.cause : undefined,
      timestamp: new Date().toISOString(),
      sessionId: options.sessionId,
    };

    yield errorEvent;
  }
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
