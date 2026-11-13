import { describe, expect, it } from 'vitest';

import {
  classifyTerminalClose,
  classifyTerminalFailure,
  isPtyControlFrame,
  parseTerminalFrame,
  resolveTerminalWsUrl,
  type TerminalFrame,
  terminalReconnectDelayMs,
} from './terminal-protocol';

const SANDBOX_SLEEPING = 'The sandbox is sleeping. Send a message to resume.';

function trpcError(code: string, message: string) {
  return Object.assign(new Error(message), { data: { code, message } });
}

function binary(bytes: number[]): TerminalFrame {
  return { kind: 'binary', data: new Uint8Array(bytes).buffer };
}

function text(value: string): TerminalFrame {
  return { kind: 'text', text: value };
}

describe('resolveTerminalWsUrl', () => {
  it('resolves the ticket path against the Worker and upgrades the scheme', () => {
    expect(resolveTerminalWsUrl('/terminal?ptyId=pty_1', 'https://worker.test')).toBe(
      'wss://worker.test/terminal?ptyId=pty_1'
    );
    expect(resolveTerminalWsUrl('/terminal?ptyId=pty_1', 'http://localhost:8787')).toBe(
      'ws://localhost:8787/terminal?ptyId=pty_1'
    );
  });

  it('keeps an absolute socket url as it is', () => {
    expect(resolveTerminalWsUrl('wss://worker.test/terminal?ptyId=pty_1', 'http://localhost')).toBe(
      'wss://worker.test/terminal?ptyId=pty_1'
    );
  });

  it('refuses an empty url rather than connecting to the base', () => {
    expect(() => resolveTerminalWsUrl('', 'https://worker.test')).toThrow();
  });
});

describe('isPtyControlFrame', () => {
  it('treats a NUL-prefixed binary frame as control', () => {
    expect(isPtyControlFrame(binary([0x00, 0x31]))).toBe(true);
    expect(isPtyControlFrame(binary([27, 91]))).toBe(false);
  });

  it('treats a NUL-prefixed or cursor text frame as control', () => {
    expect(isPtyControlFrame(text('\u0000{"cursor":3}'))).toBe(true);
    expect(isPtyControlFrame(text('{"cursor":"12"}'))).toBe(true);
    expect(isPtyControlFrame(text('{"other":1}'))).toBe(false);
    expect(isPtyControlFrame(text('{"cursor":'))).toBe(false);
  });

  it('lets ordinary output through', () => {
    expect(isPtyControlFrame(text('total 4'))).toBe(false);
    expect(isPtyControlFrame(text(''))).toBe(false);
  });
});

describe('parseTerminalFrame', () => {
  it('separates the text and binary payloads a socket delivers', () => {
    expect(parseTerminalFrame('ok\n')).toEqual({ kind: 'text', text: 'ok\n' });
    expect(parseTerminalFrame(new Uint8Array([0x68, 0x69]).buffer)).toEqual(binary([0x68, 0x69]));
  });

  it('drops a payload that is neither', () => {
    expect(parseTerminalFrame(null)).toBeNull();
    expect(parseTerminalFrame(new Uint8Array([0x68]))).toBeNull();
  });
});

describe('terminalReconnectDelayMs', () => {
  it('backs off one second at a time, capped at five', () => {
    expect([0, 1, 2, 3, 9].map(attempt => terminalReconnectDelayMs(attempt))).toEqual([
      1_000, 2_000, 4_000, 5_000, 5_000,
    ]);
  });
});

describe('classifyTerminalFailure', () => {
  it('reads a sleeping sandbox as retryable by the screen, not by the socket', () => {
    expect(classifyTerminalFailure(trpcError('SERVICE_UNAVAILABLE', SANDBOX_SLEEPING))).toEqual({
      kind: 'stopped',
    });
  });

  it('keeps a missing or interactive-only session final', () => {
    expect(classifyTerminalFailure(trpcError('NOT_FOUND', 'Session not found'))).toEqual({
      kind: 'final',
      reason: 'not-found',
    });
    expect(classifyTerminalFailure(trpcError('FORBIDDEN', 'No access'))).toEqual({
      kind: 'final',
      reason: 'forbidden',
    });
    expect(
      classifyTerminalFailure(new Error('Only interactive Cloud Agent sessions have a terminal'))
    ).toEqual({ kind: 'final', reason: 'forbidden' });
  });

  it('retries a transport failure and a wrapper that is not ready', () => {
    expect(classifyTerminalFailure(new Error('Network request failed'))).toEqual({
      kind: 'retry',
      waitingForWorkspace: false,
    });
    expect(
      classifyTerminalFailure(
        trpcError('PRECONDITION_FAILED', 'Terminal unavailable until the workspace is prepared')
      )
    ).toEqual({ kind: 'retry', waitingForWorkspace: true });
    expect(
      classifyTerminalFailure(
        trpcError(
          'SERVICE_UNAVAILABLE',
          'Terminal is unavailable because the session wrapper is not healthy'
        )
      )
    ).toEqual({ kind: 'retry', waitingForWorkspace: false });
  });

  it('gives up on a refusal it cannot retry', () => {
    expect(classifyTerminalFailure(trpcError('BAD_REQUEST', 'PTY limit reached'))).toEqual({
      kind: 'final',
      reason: 'unavailable',
    });
  });
});

describe('classifyTerminalClose', () => {
  it('separates a shell exit from a server close and a dropped socket', () => {
    expect(classifyTerminalClose({ code: 1000, reason: 'PTY session ended' })).toEqual({
      kind: 'exited',
    });
    expect(classifyTerminalClose({ code: 1000, reason: 'Terminal closed' })).toEqual({
      kind: 'disconnected',
    });
    expect(classifyTerminalClose({ code: 1006, reason: '' })).toEqual({ kind: 'retry' });
  });
});
