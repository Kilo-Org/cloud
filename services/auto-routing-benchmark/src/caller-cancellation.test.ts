import { expect, it } from 'vitest';
import { withCallerCancellation } from './caller-cancellation';

it('aborts the copy at once when the caller is already gone', () => {
  const caller = new AbortController();
  caller.abort(new Error('caller canceled'));
  const copy = withCallerCancellation(
    new Request('http://container/run', { method: 'POST', body: '{}', signal: caller.signal })
  );
  expect(copy.signal.aborted).toBe(true);
  expect(copy.signal.reason).toEqual(new Error('caller canceled'));
});
