import { describe, expect, it, vi } from 'vitest';

import { createTaskCoalescer } from './task-coalescer';

describe('createTaskCoalescer', () => {
  it('runs the correction once for every request in one task', async () => {
    const coalescer = createTaskCoalescer();
    const run = vi.fn();
    const correction = () => {
      run();
    };

    coalescer.schedule(correction);
    coalescer.schedule(correction);
    coalescer.schedule(correction);
    expect(coalescer.isPending()).toBe(true);

    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(coalescer.isPending()).toBe(false);
  });

  it('runs the next correction after the first has landed', async () => {
    const coalescer = createTaskCoalescer();
    const run = vi.fn();
    const correction = () => {
      run();
    };

    coalescer.schedule(correction);
    await Promise.resolve();
    coalescer.schedule(correction);
    await Promise.resolve();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reports a queued correction so a second event can skip the hard scroll', async () => {
    const coalescer = createTaskCoalescer();

    coalescer.schedule(() => undefined);
    expect(coalescer.isPending()).toBe(true);

    await Promise.resolve();
    expect(coalescer.isPending()).toBe(false);
  });
});
