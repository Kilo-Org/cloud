/**
 * The Cloud Agent terminal's wire contract.
 *
 * The Worker and the web client already define what a terminal socket sends and
 * how its failures read; this module is the mobile port of those rules
 * (`apps/web/src/components/cloud-agent-next/terminal-utils.ts`) so the two
 * clients agree. Nothing here renders copy: a failure names what happened and
 * the screen chooses its own words.
 */
import { z } from 'zod';

/** Server copy for a sandbox that went to sleep; the pty is gone with it. */
const SANDBOX_SLEEPING_MESSAGE = 'The sandbox is sleeping. Send a message to resume.';

/**
 * The control-plane refusals that mean "try again shortly": the wrapper is
 * still coming up or busy, so the same call succeeds once it is ready.
 */
const RETRYABLE_MESSAGES = [
  'Terminal unavailable until the workspace is prepared',
  'Terminal is only available after the workspace is prepared',
  'Terminal is unavailable because the session wrapper is not healthy',
  'Terminal is unavailable',
  'Sandbox is not available',
  'Wrapper is not connected',
  'Wrapper socket write failed',
  'Wrapper request timed out',
] as const;

/** A socket payload: the shell's bytes, or the text of a Worker control frame. */
export type TerminalFrame = { kind: 'binary'; data: ArrayBuffer } | { kind: 'text'; text: string };

/** What a failed create or ticket refresh means for the screen. */
type TerminalFailure =
  | { kind: 'stopped' }
  | { kind: 'retry'; waitingForWorkspace: boolean }
  | { kind: 'final'; reason: 'not-found' | 'forbidden' | 'unavailable' };

/** What a closed terminal socket means for the screen. */
type TerminalCloseOutcome = { kind: 'exited' } | { kind: 'disconnected' } | { kind: 'retry' };

const frameSchema = z.union([z.string(), z.instanceof(ArrayBuffer)]);

/** The Worker's cursor update: a JSON object with `cursor` as its one key. */
const cursorControlSchema = z.object({ cursor: z.union([z.number(), z.string()]) }).strict();

/** A tRPC failure's machine-readable reason, when the call carried one. */
const errorCodeSchema = z.object({ data: z.object({ code: z.string() }) });

const errorMessageSchema = z.object({ message: z.string() });

/**
 * The socket URL the control plane hands back is a path on the Worker, so it is
 * resolved against the Worker base and its HTTP scheme becomes the WebSocket
 * one.
 */
export function resolveTerminalWsUrl(wsUrl: string, baseUrl: string): string {
  if (wsUrl.length === 0) {
    throw new Error('Terminal WebSocket URL is missing');
  }

  const url = /^(wss?|https?):\/\//i.test(wsUrl) ? new URL(wsUrl) : new URL(wsUrl, baseUrl);

  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  }

  return url.toString();
}

/**
 * The socket delivers text or binary frames, and a binary frame is what a pty
 * printed. Anything else the platform hands over is dropped rather than guessed
 * at.
 */
export function parseTerminalFrame(raw: unknown): TerminalFrame | null {
  const parsed = frameSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  if (parsed.data instanceof ArrayBuffer) {
    return { kind: 'binary', data: parsed.data };
  }
  return { kind: 'text', text: parsed.data };
}

/**
 * A frame that carries terminal state rather than bytes: the Worker prefixes
 * its control payloads with a NUL byte, and a cursor update arrives as JSON.
 * Writing one into the terminal would paint it.
 */
export function isPtyControlFrame(frame: TerminalFrame): boolean {
  if (frame.kind === 'binary') {
    const bytes = new Uint8Array(frame.data);
    return bytes.length > 0 && bytes[0] === 0x00;
  }

  const { text } = frame;
  if (text.length > 0 && text.codePointAt(0) === 0) {
    return true;
  }
  if (!text.startsWith('{')) {
    return false;
  }

  try {
    return cursorControlSchema.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}

/** Backoff for a lost terminal socket: one second, doubling, capped at five. */
export function terminalReconnectDelayMs(
  attempt: number,
  options: { baseDelayMs?: number; maxDelayMs?: number } = {}
): number {
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const normalizedAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(baseDelayMs * 2 ** normalizedAttempt, maxDelayMs);
}

function readErrorCode(error: unknown): string | undefined {
  const parsed = errorCodeSchema.safeParse(error);
  return parsed.success ? parsed.data.data.code : undefined;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  const parsed = errorMessageSchema.safeParse(error);
  return parsed.success ? parsed.data.message : '';
}

function isRetryableMessage(message: string): boolean {
  return (
    RETRYABLE_MESSAGES.some(candidate => message === candidate) ||
    message.includes('session wrapper is not running')
  );
}

/**
 * A create or refresh that failed. A missing session or an interactive-only one
 * can never succeed here, so those two are final; a sandbox that is asleep and
 * a wrapper that is not ready are both worth another attempt.
 */
export function classifyTerminalFailure(error: unknown): TerminalFailure {
  const code = readErrorCode(error);
  const message = readErrorMessage(error);

  if (message === SANDBOX_SLEEPING_MESSAGE) {
    return { kind: 'stopped' };
  }

  if (code === 'NOT_FOUND' || message === 'Session not found') {
    return { kind: 'final', reason: 'not-found' };
  }

  if (code === 'FORBIDDEN' || message.includes('interactive Cloud Agent')) {
    return { kind: 'final', reason: 'forbidden' };
  }

  if (code === undefined) {
    return { kind: 'retry', waitingForWorkspace: false };
  }

  if (isRetryableMessage(message)) {
    return { kind: 'retry', waitingForWorkspace: message.includes('workspace is prepared') };
  }

  return { kind: 'final', reason: 'unavailable' };
}

/** A clean close with a pty exit was the shell ending; anything else is not. */
export function classifyTerminalClose(event: {
  code: number;
  reason: string;
}): TerminalCloseOutcome {
  if (event.code === 1000 && event.reason.includes('PTY session ended')) {
    return { kind: 'exited' };
  }

  if (event.code === 1000) {
    return { kind: 'disconnected' };
  }

  return { kind: 'retry' };
}
