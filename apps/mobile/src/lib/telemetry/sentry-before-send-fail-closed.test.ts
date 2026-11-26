import { describe, expect, it } from 'vitest';

import { beforeSendScrubbedEvent } from './sentry-before-send';
import { scrubBreadcrumb } from './sentry-scrub';

// These cases run the real scrub module. Each input holds a throwing getter at a
// place only the scrub reads, so the scrub itself fails and nothing unscrubbed
// may come back.
const fakeSecret = 'fake-unscrubbed-value-0000';

describe('Sentry scrubbing fails closed', () => {
  it('drops the event when the event scrub throws', () => {
    const event = {
      message: `request failed with ${fakeSecret}`,
      exception: { values: [{ type: 'Error', value: `request failed with ${fakeSecret}` }] },
      get request(): unknown {
        throw new Error('unreadable request');
      },
    };

    expect(beforeSendScrubbedEvent(event)).toBeNull();
  });

  it('drops a breadcrumb when the breadcrumb scrub throws', () => {
    const breadcrumb = {
      category: 'fetch',
      message: `GET with ${fakeSecret}`,
      data: {
        get url(): unknown {
          throw new Error('unreadable url');
        },
      },
    };

    expect(scrubBreadcrumb(breadcrumb)).toBeNull();
  });

  it('drops merged breadcrumbs that cannot be read and keeps the others', () => {
    const event = {
      exception: { values: [{ type: 'Error', value: 'request failed' }] },
      breadcrumbs: [
        {
          category: 'fetch',
          data: {
            get url(): unknown {
              throw new Error('unreadable url');
            },
          },
        },
        { category: 'navigation', data: { to: '/home' } },
      ],
    };

    const result = beforeSendScrubbedEvent(event);

    expect(result?.breadcrumbs).toEqual([{ category: 'navigation', data: { to: '/home' } }]);
  });
});
