import {
  classifyTerminalCreateError,
  classifyTerminalSocketClose,
  getTerminalReconnectDelayMs,
  isPtyControlFrame,
  resolveCloudAgentTerminalWsUrl,
} from './terminal-utils';

describe('resolveCloudAgentTerminalWsUrl', () => {
  it('resolves relative terminal paths against the WebSocket base URL', () => {
    expect(
      resolveCloudAgentTerminalWsUrl(
        '/terminal?cloudAgentSessionId=agent_1&ptyId=pty_1',
        'https://cloud-agent.example.com'
      )
    ).toBe('wss://cloud-agent.example.com/terminal?cloudAgentSessionId=agent_1&ptyId=pty_1');
  });

  it('upgrades absolute HTTP URLs to WebSocket URLs', () => {
    expect(resolveCloudAgentTerminalWsUrl('http://worker.example.com/terminal', '')).toBe(
      'ws://worker.example.com/terminal'
    );
  });
});

describe('isPtyControlFrame', () => {
  it('filters NUL-prefixed binary control frames', () => {
    expect(isPtyControlFrame(new Uint8Array([0x00, 0x7b, 0x7d]).buffer)).toBe(true);
  });

  it('filters JSON cursor control frames', () => {
    expect(isPtyControlFrame('{"cursor":12}')).toBe(true);
  });

  it('keeps normal terminal output', () => {
    expect(isPtyControlFrame('echo {"ok":true}')).toBe(false);
    expect(isPtyControlFrame('{"ok":true}')).toBe(false);
    expect(isPtyControlFrame('{"scripts":{"test":"jest"}}\r\n')).toBe(false);
  });
});

describe('getTerminalReconnectDelayMs', () => {
  it('backs off and caps retries so the terminal can keep waiting for the wrapper', () => {
    expect(getTerminalReconnectDelayMs(0)).toBe(1_000);
    expect(getTerminalReconnectDelayMs(1)).toBe(2_000);
    expect(getTerminalReconnectDelayMs(2)).toBe(4_000);
    expect(getTerminalReconnectDelayMs(3)).toBe(5_000);
    expect(getTerminalReconnectDelayMs(20)).toBe(5_000);
  });
});

describe('classifyTerminalCreateError', () => {
  it('retries wrapper and workspace availability failures', () => {
    expect(
      classifyTerminalCreateError({
        data: { code: 'SERVICE_UNAVAILABLE' },
        message: 'Terminal is unavailable because the session wrapper is not healthy',
      })
    ).toEqual({ kind: 'retry', statusText: 'Waiting for terminal' });

    expect(
      classifyTerminalCreateError({
        data: { code: 'PRECONDITION_FAILED' },
        message: 'Terminal is only available after the workspace is prepared',
      })
    ).toEqual({ kind: 'retry', statusText: 'Waiting for workspace' });
  });

  it('stops retrying for permanent access and session errors', () => {
    expect(
      classifyTerminalCreateError({
        data: { code: 'FORBIDDEN' },
        message: 'Terminal is only available for interactive Cloud Agent sessions',
      })
    ).toEqual({
      kind: 'final-error',
      statusText: 'Terminal is only available for interactive Cloud Agent sessions',
    });

    expect(
      classifyTerminalCreateError({
        data: { code: 'NOT_FOUND' },
        message: 'Session not found',
      })
    ).toEqual({
      kind: 'final-error',
      statusText: 'Terminal session was not found',
    });
  });
});

describe('classifyTerminalSocketClose', () => {
  it('treats normal PTY completion as shell exit', () => {
    expect(classifyTerminalSocketClose({ code: 1000, reason: 'PTY session ended' })).toEqual({
      kind: 'exited',
      statusText: 'Terminal exited',
    });
  });

  it('retries abnormal network and upstream failures', () => {
    expect(classifyTerminalSocketClose({ code: 1006, reason: '' })).toEqual({
      kind: 'retry',
      statusText: 'Reconnecting',
    });

    expect(classifyTerminalSocketClose({ code: 1011, reason: 'PTY upstream error' })).toEqual({
      kind: 'retry',
      statusText: 'Reconnecting',
    });
  });
});
