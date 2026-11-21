import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATALOG, finish, harness, taskAt } from './gguf-downloads.test-helpers';
import { ggufModelName } from './gguf-records';
import { setTelemetrySink } from '../telemetry/error-sink';

const sink = vi.fn<() => void>();

beforeEach(() => {
  sink.mockClear();
  setTelemetrySink(sink);
});

describe('a listener that throws as a download ends', () => {
  it('keeps the model the saved list names and still notifies the other listeners', async () => {
    const h = harness();
    let finished = 0;
    // The first view renders the finished state and throws once; the second
    // must still hear about the same state.
    h.store.subscribe(() => {
      if (h.store.snapshot().models.length > 0) {
        throw new Error('render failed');
      }
    });
    h.store.subscribe(() => {
      if (h.store.snapshot().models.length > 0) {
        finished += 1;
      }
    });
    h.store.start(CATALOG);
    await finish(taskAt(h.tasks, 0), 1000);

    // The store ends in the published state the saved list names, and the view
    // after the throwing one still hears about it.
    expect(h.store.snapshot().models.map(model => model.fileId)).toEqual(['small']);
    expect(h.files.has(ggufModelName('small'))).toBe(true);
    expect(h.store.snapshot().failure).toBeNull();
    expect(finished).toBeGreaterThan(0);
    // A view that threw is a defect somebody has to see, reported with the tags
    // that place it, not swallowed.
    expect(sink).toHaveBeenCalled();
    expect(sink).toHaveBeenCalledWith({
      error: expect.any(Error),
      level: 'error',
      tags: { 'error.subsystem': 'gguf-downloads', 'error.operation': 'publish_listener' },
    });
  });
});
