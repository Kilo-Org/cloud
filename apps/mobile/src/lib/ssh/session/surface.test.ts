import { describe, expect, it } from 'vitest';

import { sessionSurface } from './surface';

describe('sessionSurface', () => {
  it('uses the stage only for initial connection or a closed session', () => {
    expect(sessionSurface({ kind: 'connecting', attempt: 1 }, false)).toEqual({
      stage: true,
      terminal: false,
      reconnecting: false,
      inputEnabled: false,
    });
    expect(sessionSurface({ kind: 'closed', reason: 'user', retryable: false }, true)).toEqual({
      stage: true,
      terminal: false,
      reconnecting: false,
      inputEnabled: false,
    });
  });

  it('keeps the terminal and disables input during both retry phases', () => {
    for (const phase of [
      { kind: 'connecting', attempt: 2 },
      { kind: 'reconnecting', attempt: 2, reason: 'Network' },
    ] as const) {
      expect(sessionSurface(phase, true)).toEqual({
        stage: false,
        terminal: true,
        reconnecting: true,
        inputEnabled: false,
      });
    }
  });

  it('enables the existing terminal when the replacement shell connects', () => {
    expect(sessionSurface({ kind: 'connected' }, true)).toEqual({
      stage: false,
      terminal: true,
      reconnecting: false,
      inputEnabled: true,
    });
  });
});
