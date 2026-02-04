import type { IngestEvent } from '../../src/shared/protocol.js';
import type { KiloClient } from './kilo-client.js';
import { logToFile } from './utils.js';

/** Default timeout for condense operation (3 minutes) */
const DEFAULT_CONDENSE_TIMEOUT_MS = 3 * 60 * 1000;

export type CondenseResult = {
  /** Whether the operation was aborted (kill signal or fatal error during execution) */
  wasAborted: boolean;
  /** Whether the operation completed successfully */
  success: boolean;
  /** Error message if failed */
  error?: string;
};

export type CondenseOnCompleteOptions = {
  workspacePath: string;
  kiloSessionId: string;
  model?: string;
  onEvent: (event: IngestEvent) => void;
  kiloClient: KiloClient;
  /** Arm the completion waiter before sending a prompt */
  expectCompletion: () => void;
  /** Wait for the completion event (call after sending prompt) */
  waitForCompletion: () => Promise<void>;
  /** Check if the execution was aborted (kill signal or fatal error) */
  wasAborted: () => boolean;
  /** Timeout for the entire operation in ms (default: 3 minutes) */
  timeoutMs?: number;
};

export async function runCondenseOnComplete(
  opts: CondenseOnCompleteOptions
): Promise<CondenseResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONDENSE_TIMEOUT_MS;
  const sendStatus = (msg: string) =>
    opts.onEvent({
      streamEventType: 'status',
      data: { message: msg },
      timestamp: new Date().toISOString(),
    });

  // Check if already aborted before starting
  if (opts.wasAborted()) {
    logToFile('condense: skipped - execution was aborted');
    return { wasAborted: true, success: false };
  }

  try {
    sendStatus('Condensing context...');

    // Arm the completion waiter BEFORE sending the prompt
    opts.expectCompletion();

    // Send /compact command via server API
    logToFile(`condense: sending /compact command to session ${opts.kiloSessionId}`);
    await opts.kiloClient.sendCommand({
      sessionId: opts.kiloSessionId,
      command: 'compact',
    });

    // Wait for completion with timeout
    logToFile('condense: waiting for completion');
    const completionPromise = opts.waitForCompletion();
    const timeoutPromise = new Promise<'timeout'>(resolve =>
      setTimeout(() => resolve('timeout'), timeoutMs)
    );

    const result = await Promise.race([
      completionPromise.then(() => 'done' as const),
      timeoutPromise,
    ]);

    if (result === 'timeout') {
      logToFile('condense: timed out, aborting session');
      // Abort the session to stop the running prompt
      try {
        await opts.kiloClient.abortSession({ sessionId: opts.kiloSessionId });
        logToFile('condense: session aborted after timeout');
      } catch (abortError) {
        logToFile(
          `condense: failed to abort session: ${abortError instanceof Error ? abortError.message : String(abortError)}`
        );
      }
      opts.onEvent({
        streamEventType: 'error',
        data: { error: 'Condense operation timed out', fatal: false },
        timestamp: new Date().toISOString(),
      });
      // Treat timeout as abort to prevent further operations on potentially inconsistent state
      return { wasAborted: true, success: false, error: 'Timed out' };
    }

    // Check if aborted during execution
    if (opts.wasAborted()) {
      logToFile('condense: aborted during execution');
      return { wasAborted: true, success: false };
    }

    logToFile('condense: completed');
    sendStatus('Context condensed successfully');
    return { wasAborted: false, success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logToFile(`condense: error - ${errorMsg}`);
    opts.onEvent({
      streamEventType: 'error',
      data: {
        error: `Condense context failed: ${errorMsg}`,
        fatal: false,
      },
      timestamp: new Date().toISOString(),
    });
    return { wasAborted: false, success: false, error: errorMsg };
  }
}
