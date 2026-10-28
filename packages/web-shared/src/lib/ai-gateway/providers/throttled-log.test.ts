import { describe, expect, it } from '@jest/globals';
import { throttledLog } from '@kilocode/web-shared/lib/ai-gateway/providers/throttled-log';

describe('throttledLog', () => {
  it('logs at most once per interval and reports suppressed calls', () => {
    const logged: Record<string, unknown>[] = [];
    let time = 0;
    const log = throttledLog(
      details => logged.push(details),
      1000,
      () => time
    );

    log({ call: 1 });
    time = 500;
    log({ call: 2 });
    time = 999;
    log({ call: 3 });
    time = 1000;
    log({ call: 4 });
    time = 1500;
    log({ call: 5 });

    expect(logged).toEqual([
      { call: 1, suppressedSinceLastLog: 0 },
      { call: 4, suppressedSinceLastLog: 2 },
    ]);
  });
});
