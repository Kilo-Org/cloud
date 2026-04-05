import { captureMessage } from '@sentry/nextjs';
import { sentryLogger } from './utils.server';

jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/config.server', () => ({
  IS_IN_AUTOMATED_TEST: false,
}));

const mockCaptureMessage = jest.mocked(captureMessage);

describe('sentryLogger', () => {
  const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    debugSpy.mockRestore();
    logSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('logs debug messages without creating a Sentry event', () => {
    sentryLogger('test-source', 'debug')('debug message', { foo: 'bar' });

    expect(debugSpy).toHaveBeenCalledWith('debug message', { foo: 'bar' });
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('logs info messages without creating a Sentry event', () => {
    sentryLogger('test-source', 'info')('informational message', { foo: 'bar' });

    expect(infoSpy).toHaveBeenCalledWith('informational message', { foo: 'bar' });
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('logs default messages without creating a Sentry event', () => {
    sentryLogger('test-source')('default message', { foo: 'bar' });

    expect(logSpy).toHaveBeenCalledWith('default message', { foo: 'bar' });
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('captures warning messages in Sentry', () => {
    sentryLogger('test-source', 'warning')('warning message', { foo: 'bar' });

    expect(warnSpy).toHaveBeenCalledWith('warning message', { foo: 'bar' });
    expect(mockCaptureMessage).toHaveBeenCalledWith('warning message', {
      level: 'warning',
      tags: { source: 'test-source' },
      extra: { args: [{ foo: 'bar' }] },
    });
  });

  it('captures error messages in Sentry', () => {
    sentryLogger('test-source', 'error')('error message', { foo: 'bar' });

    expect(errorSpy).toHaveBeenCalledWith('error message', { foo: 'bar' });
    expect(mockCaptureMessage).toHaveBeenCalledWith('error message', {
      level: 'error',
      tags: { source: 'test-source' },
      extra: { args: [{ foo: 'bar' }] },
    });
  });

  it('routes fatal messages to console.error and captures them in Sentry', () => {
    sentryLogger('test-source', 'fatal')('fatal message');

    expect(errorSpy).toHaveBeenCalledWith('fatal message');
    expect(mockCaptureMessage).toHaveBeenCalledWith('fatal message', {
      level: 'fatal',
      tags: { source: 'test-source' },
      extra: undefined,
    });
  });
});
