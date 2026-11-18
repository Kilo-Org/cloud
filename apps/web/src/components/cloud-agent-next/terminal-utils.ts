import { SANDBOX_STATUS_DETAIL_MESSAGES } from '@/routers/cloud-agent-next-schemas';

export function resolveCloudAgentTerminalWsUrl(wsUrl: string, baseUrl: string): string {
  if (!wsUrl) {
    throw new Error('Terminal WebSocket URL is missing');
  }

  const url = /^(wss?|https?):\/\//i.test(wsUrl) ? new URL(wsUrl) : new URL(wsUrl, baseUrl);

  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';

  return url.toString();
}

function isPtyCursorControlPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'cursor') return false;
  const cursor = (value as { cursor: unknown }).cursor;
  return typeof cursor === 'number' || typeof cursor === 'string';
}

export function isPtyControlFrame(data: string | ArrayBuffer): boolean {
  if (data instanceof ArrayBuffer) {
    const bytes = new Uint8Array(data);
    return bytes.length > 0 && bytes[0] === 0x00;
  }

  if (data.length > 0 && data.charCodeAt(0) === 0) return true;
  if (!data.startsWith('{')) return false;

  try {
    return isPtyCursorControlPayload(JSON.parse(data));
  } catch {
    return false;
  }
}

export function getTerminalReconnectDelayMs(
  attempt: number,
  options: { baseDelayMs?: number; maxDelayMs?: number } = {}
): number {
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const normalizedAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(baseDelayMs * Math.pow(2, normalizedAttempt), maxDelayMs);
}

export type TerminalConnectionDecision =
  | { kind: 'retry'; statusText: string }
  | { kind: 'final-error'; statusText: string }
  | { kind: 'sleeping'; statusText: string }
  | { kind: 'exited'; statusText: string };

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const data = 'data' in error ? (error as { data?: unknown }).data : undefined;
  if (data && typeof data === 'object' && 'code' in data) {
    const code = (data as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : '';
  }
  return '';
}

const RETRYABLE_TERMINAL_MESSAGES = [
  'Terminal unavailable until the workspace is prepared',
  'Terminal is only available after the workspace is prepared',
  'Terminal is unavailable because the session wrapper is not healthy',
  'Terminal is unavailable',
  'Sandbox is not available',
  'Wrapper is not connected',
  'Wrapper socket write failed',
  'Wrapper request timed out',
] as const;

function isRetryableTerminalMessage(message: string): boolean {
  return (
    RETRYABLE_TERMINAL_MESSAGES.some(candidate => message === candidate) ||
    message.includes('session wrapper is not running')
  );
}

export function classifyTerminalCreateError(error: unknown): TerminalConnectionDecision {
  const code = readErrorCode(error);
  const message = readErrorMessage(error);

  if (message === SANDBOX_STATUS_DETAIL_MESSAGES.sandbox_stopped) {
    return { kind: 'sleeping', statusText: message };
  }

  if (code === 'NOT_FOUND' || message === 'Session not found') {
    return { kind: 'final-error', statusText: 'Terminal session was not found' };
  }

  if (code === 'FORBIDDEN' || message.includes('interactive Cloud Agent')) {
    return {
      kind: 'final-error',
      statusText: message || 'Terminal is not available for this session',
    };
  }

  if (code === undefined) {
    return { kind: 'retry', statusText: 'Waiting for terminal' };
  }

  if (isRetryableTerminalMessage(message)) {
    return {
      kind: 'retry',
      statusText: message.includes('workspace is prepared')
        ? 'Waiting for workspace'
        : 'Waiting for terminal',
    };
  }

  return { kind: 'final-error', statusText: message || 'Terminal is unavailable' };
}

export function classifyTerminalSocketClose(event: {
  code: number;
  reason: string;
}): TerminalConnectionDecision {
  if (event.code === 1000 && event.reason.includes('PTY session ended')) {
    return { kind: 'exited', statusText: 'Terminal exited' };
  }

  if (event.code === 1000) {
    return { kind: 'final-error', statusText: 'Terminal disconnected' };
  }

  return { kind: 'retry', statusText: 'Reconnecting' };
}
