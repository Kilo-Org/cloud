import { describe, expect, it } from 'vitest';

import { scrubTransactionEvent } from './sentry-scrub-transaction';

describe('scrubTransactionEvent', () => {
  it('reduces a path target to its path and empties a non-string URL attribute', () => {
    const result = scrubTransactionEvent({
      spans: [{ data: { 'http.target': '/trpc/user.get?input=fake-query-value', url: 42 } }],
    });

    expect(result?.spans).toEqual([{ data: { 'http.target': '/trpc/user.get', url: '' } }]);
  });

  it('drops the transaction when a span scrub fails', () => {
    const spans = [
      {
        data: {
          get 'http.target'() {
            throw new Error('malformed span data');
          },
        },
      },
    ];

    expect(scrubTransactionEvent({ spans })).toBeNull();
  });

  it('keeps malformed spans and trace contexts without throwing', () => {
    const event = {
      contexts: { trace: 'not-an-object' },
      spans: [null, 'span', { data: 'not-an-object' }, { op: 'ui.load' }],
    };

    expect(scrubTransactionEvent(event)).toEqual({
      contexts: { trace: 'not-an-object' },
      spans: [null, 'span', { data: 'not-an-object' }, { op: 'ui.load' }],
    });
  });
});
