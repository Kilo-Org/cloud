import { indicatorForStatus } from './status-indicator';

describe('indicatorForStatus', () => {
  it('maps a plain disconnected status to a terminal error indicator', () => {
    expect(indicatorForStatus({ type: 'disconnected' })).toEqual({
      type: 'error',
      message: 'Agent connection lost',
      timestamp: expect.any(Number),
      code: 'agent-connection-lost',
    });
  });

  it('maps a reconnecting transport drop to a warning indicator', () => {
    expect(indicatorForStatus({ type: 'disconnected', reconnecting: true })).toEqual({
      type: 'warning',
      message: 'Reconnecting…',
      timestamp: expect.any(Number),
      code: 'agent-connection-reconnecting',
    });
  });

  it('keeps the plain error when reconnecting is false', () => {
    expect(indicatorForStatus({ type: 'disconnected', reconnecting: false })).toMatchObject({
      type: 'error',
      code: 'agent-connection-lost',
    });
  });
});
