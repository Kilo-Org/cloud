import { describe, expect, it } from 'vitest';

import { createFrameCoalescer } from './coalesce-frame';

/** A scheduler that queues callbacks and runs them on demand, like a frame. */
function makeScheduler() {
  const queued: (() => void)[] = [];
  return {
    schedule: (frame: () => void) => {
      queued.push(frame);
    },
    run: () => {
      const pending = queued.splice(0);
      for (const frame of pending) {
        frame();
      }
    },
    pendingCount: () => queued.length,
  };
}

describe('createFrameCoalescer', () => {
  it('publishes the latest value once per frame', () => {
    const published: string[] = [];
    const scheduler = makeScheduler();
    const coalescer = createFrameCoalescer<string>(value => {
      published.push(value);
    }, scheduler.schedule);

    coalescer.push('a');
    coalescer.push('b');
    coalescer.push('c');

    expect(published).toEqual([]);
    expect(scheduler.pendingCount()).toBe(1);

    scheduler.run();

    expect(published).toEqual(['c']);
  });

  it('publishes immediately on flush and does not re-publish on the frame', () => {
    const published: string[] = [];
    const scheduler = makeScheduler();
    const coalescer = createFrameCoalescer<string>(value => {
      published.push(value);
    }, scheduler.schedule);

    coalescer.push('a');
    coalescer.flush();

    expect(published).toEqual(['a']);

    scheduler.run();

    expect(published).toEqual(['a']);
  });

  it('drops the pending value on cancel so no publication happens', () => {
    const published: string[] = [];
    const scheduler = makeScheduler();
    const coalescer = createFrameCoalescer<string>(value => {
      published.push(value);
    }, scheduler.schedule);

    coalescer.push('a');
    coalescer.cancel();
    scheduler.run();

    expect(published).toEqual([]);
  });

  it('publishes nothing from a later push or flush after cancel', () => {
    const published: string[] = [];
    const scheduler = makeScheduler();
    const coalescer = createFrameCoalescer<string>(value => {
      published.push(value);
    }, scheduler.schedule);

    coalescer.cancel();
    coalescer.push('a');
    coalescer.flush();
    scheduler.run();

    expect(published).toEqual([]);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('schedules again after a flush so later pushes still coalesce', () => {
    const published: string[] = [];
    const scheduler = makeScheduler();
    const coalescer = createFrameCoalescer<string>(value => {
      published.push(value);
    }, scheduler.schedule);

    coalescer.push('a');
    coalescer.flush();
    coalescer.push('b');
    scheduler.run();

    expect(published).toEqual(['a', 'b']);
  });
});
