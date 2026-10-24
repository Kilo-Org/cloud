import { describe, expect, it } from 'vitest';

import { CATALOG, finish, flush, harness, taskAt } from './gguf-downloads.test-helpers';

describe('pausing one download', () => {
  it('leaves a download that is already stopping alone when Pause arrives', async () => {
    const h = harness();
    h.store.start(CATALOG);
    taskAt(h.tasks, 0).progress({ bytesWritten: 100, totalBytes: 1000 });
    h.store.cancel('small');
    // The task is cancelled but its promise has not rejected yet: this is the window the
    // explorer pressed Pause in, and the task refuses a pause there.
    h.store.pause('small');
    expect(taskAt(h.tasks, 0).paused).not.toHaveBeenCalled();
    await flush();
    expect(h.store.snapshot().download).toBeNull();
    expect(h.files.size).toBe(0);
  });

  it('asks for one pause however often Pause is pressed, and says so until it lands', async () => {
    const h = harness();
    h.store.start(CATALOG);
    h.store.pause('small');
    h.store.pause('small');
    expect(taskAt(h.tasks, 0).paused).toHaveBeenCalledTimes(1);
    expect(h.store.snapshot().download).toMatchObject({ phase: 'downloading', pending: true });
    taskAt(h.tasks, 0).settle(null);
    await flush();
    expect(h.store.snapshot().download).toMatchObject({ phase: 'paused', pending: false });
  });

  it('keeps the download usable when the task refuses the pause', async () => {
    const h = harness({ refusePause: true });
    h.store.start(CATALOG);
    expect(() => {
      h.store.pause('small');
    }).not.toThrow();
    expect(h.store.snapshot().download).toMatchObject({ phase: 'downloading', pending: false });
    await finish(taskAt(h.tasks, 0), 1000);
    expect(h.store.model('small')).toBeDefined();
  });

  it('stops the download when a cancel arrives while the pause is still landing', async () => {
    const h = harness({ cancelRacesPause: true });
    h.store.start(CATALOG);
    taskAt(h.tasks, 0).progress({ bytesWritten: 100, totalBytes: 1000 });
    h.store.pause('small');
    h.store.cancel('small');
    await flush();
    expect(h.store.snapshot()).toMatchObject({ download: null, failure: null });
    expect(h.files.size).toBe(0);
  });

  it('reports the space failure when a stated length arrives while the pause is landing', async () => {
    const h = harness({ freeBytes: 2_000_000_000, cancelRacesPause: true });
    h.store.start({
      kind: 'url',
      fileId: 'linked',
      name: 'Linked',
      url: 'https://example.com/big.gguf',
    });
    h.store.pause('linked');
    // The server states a length that does not fit before the task reports the pause.
    taskAt(h.tasks, 0).progress({ bytesWritten: 0, totalBytes: 3_000_000_000 });
    await flush();
    expect(h.store.snapshot()).toMatchObject({
      download: null,
      failure: { fileId: 'linked', problem: 'space' },
    });
    expect(h.files.size).toBe(0);
  });
});
