import { beforeEach, describe, expect, it, vi } from 'vitest';

// The scrub module is replaced by throwing doubles. The real `scrubEvent` and
// `scrubBreadcrumb` catch their own errors and return the input, so today these
// cases cover only an error that reaches beforeSend from outside the scrub
// module (the breadcrumb parse, the App Attest projection, or a future scrub
// that rethrows). The scrub module change lands with #12856.
const scrub = vi.hoisted(() => ({
  scrubEvent: vi.fn((event: unknown) => event),
  scrubBreadcrumb: vi.fn((breadcrumb: unknown) => breadcrumb),
}));

vi.mock('@/lib/telemetry/sentry-scrub', () => scrub);

const { beforeSendScrubbedEvent } = await import('./sentry-before-send');

const fakeSecret = 'fake-unscrubbed-value-0000';

function capturedEvent() {
  return {
    exception: { values: [{ type: 'Error', value: `request failed with ${fakeSecret}` }] },
    breadcrumbs: [
      { category: 'fetch', data: { url: `https://api.kilo.ai/x?sig=${fakeSecret}` } },
      { category: 'navigation', data: { to: '/home' } },
    ],
  };
}

describe('beforeSendScrubbedEvent when an error reaches it from a scrub step', () => {
  beforeEach(() => {
    scrub.scrubEvent.mockImplementation(event => event);
    scrub.scrubBreadcrumb.mockImplementation(breadcrumb => breadcrumb);
  });

  it('drops the event when a scrub step throws', () => {
    scrub.scrubEvent.mockImplementation(() => {
      throw new Error('scrub failed');
    });

    expect(beforeSendScrubbedEvent(capturedEvent())).toBeNull();
  });

  it('drops a breadcrumb whose scrub throws and keeps the others', () => {
    scrub.scrubBreadcrumb.mockImplementation(breadcrumb => {
      if (JSON.stringify(breadcrumb).includes(fakeSecret)) {
        throw new Error('scrub failed');
      }
      return breadcrumb;
    });

    const result = beforeSendScrubbedEvent(capturedEvent());

    expect(result?.breadcrumbs).toEqual([{ category: 'navigation', data: { to: '/home' } }]);
    expect(JSON.stringify(result?.breadcrumbs)).not.toContain(fakeSecret);
  });
});
