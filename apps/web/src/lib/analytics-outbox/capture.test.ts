import { captureException } from '@sentry/nextjs';
import { after } from 'next/server';

import { captureCatalogEvent, runAfterResponse } from '@/lib/analytics-outbox/capture';

const mockCapture = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/posthog', () => ({
  __esModule: true,
  default: jest.fn(() => ({ capture: mockCapture })),
}));

// IS_IN_AUTOMATED_TEST makes runAfterResponse run its work inline so the
// tests can assert on the capture without waiting on `after()`. The getter
// lets the scheduling-failure tests below exercise the real post-response
// path with `after()` mocked from next/server.
const automatedTestState = { enabled: true };
jest.mock('@/lib/config.server', () => ({
  get IS_IN_AUTOMATED_TEST() {
    return automatedTestState.enabled;
  },
}));

jest.mock('next/server', () => ({
  after: jest.fn(),
}));

describe('captureCatalogEvent', () => {
  beforeEach(() => {
    automatedTestState.enabled = true;
    mockCapture.mockReset();
    jest.mocked(captureException).mockReset();
    jest.mocked(after).mockReset();
  });

  it('captures an accepted-phase event with distinctId, event, and properties', async () => {
    captureCatalogEvent({
      distinctId: 'user@example.com',
      event: 'session_created',
      properties: { surface: 'cloud-agent' },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'user@example.com',
      event: 'session_created',
      properties: { surface: 'cloud-agent' },
    });
  });

  it('passes the record-shaped app_startup payload through unchanged', async () => {
    captureCatalogEvent({
      distinctId: 'user@example.com',
      event: 'app_startup',
      properties: { outcome: 'app', auth_ready: 0, consent_ready: 60 },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'user@example.com',
      event: 'app_startup',
      properties: { outcome: 'app', auth_ready: 0, consent_ready: 60 },
    });
  });

  it('never throws to the caller when PostHog capture fails', async () => {
    mockCapture.mockImplementation(() => {
      throw new Error('posthog unavailable');
    });

    expect(() => {
      captureCatalogEvent({
        distinctId: 'user@example.com',
        event: 'session_created',
        properties: { surface: 'cloud-agent' },
      });
    }).not.toThrow();

    // A macrotask flush drains the full microtask chain: capture call → bounded
    // rejection → best-effort catch in captureAcceptedEvent.
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(jest.mocked(captureException)).toHaveBeenCalledTimes(1);
    const [error, tags] = jest.mocked(captureException).mock.calls[0] ?? [];
    expect((error as Error).message).toBe('posthog unavailable');
    expect(tags).toMatchObject({ tags: { source: 'analytics_capture_catalog_event' } });
  });

  it('reports a rejected capture attempt as best-effort too', async () => {
    mockCapture.mockImplementation(() => {
      throw new Error('capture rejected');
    });

    captureCatalogEvent({
      distinctId: 'user@example.com',
      event: 'session_created',
      properties: { surface: 'cloud-agent' },
    });
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(jest.mocked(captureException)).toHaveBeenCalledTimes(1);
  });
});

describe('runAfterResponse', () => {
  it('runs the work inline when IS_IN_AUTOMATED_TEST is set', async () => {
    let ran = false;
    await runAfterResponse(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe('runAfterResponse outside automated tests', () => {
  beforeEach(() => {
    automatedTestState.enabled = false;
    jest.mocked(captureException).mockReset();
    jest.mocked(after).mockReset();
  });

  afterEach(() => {
    automatedTestState.enabled = true;
  });

  it('reports a synchronous after() scheduling failure without an unhandled rejection', async () => {
    jest.mocked(after).mockImplementation(() => {
      throw new Error('after unavailable outside request scope');
    });

    captureCatalogEvent({
      distinctId: 'user@example.com',
      event: 'session_created',
      properties: { surface: 'cloud-agent' },
    });
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(jest.mocked(captureException)).toHaveBeenCalledTimes(1);
    const [error] = jest.mocked(captureException).mock.calls[0] ?? [];
    expect((error as Error).message).toBe('after unavailable outside request scope');
  });

  it('reports a rejected scheduled work promise without propagating or leaking it', async () => {
    jest.mocked(after).mockImplementation(task => {
      // next/server owns the callback promise; invoke it like the runtime.
      if (typeof task === 'function') {
        void Promise.resolve(task()).catch(() => undefined);
      }
    });

    await expect(
      runAfterResponse(() => Promise.reject(new Error('scheduled work rejected')))
    ).resolves.toBeUndefined();
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(jest.mocked(captureException)).toHaveBeenCalledTimes(1);
    const [error] = jest.mocked(captureException).mock.calls[0] ?? [];
    expect((error as Error).message).toBe('scheduled work rejected');
  });
});
