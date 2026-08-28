import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KiloChatClient } from '@kilocode/kilo-chat';
import { EventServiceClient } from '@kilocode/event-service';
import { useAttachmentQueue, type PerformUpload } from './use-attachment-queue';

const queueHarness = vi.hoisted(() => ({
  state: { rows: [] } as AttachmentQueueState,
  refs: [] as { current: unknown }[],
  cursor: 0,
}));
vi.mock('react', () => ({
  useCallback: <T>(fn: T) => fn,
  useMemo: <T>(fn: () => T) => fn(),
  useEffect: () => {},
  useRef: <T>(initial: T) => {
    const index = queueHarness.cursor++;
    queueHarness.refs[index] ??= { current: initial };
    return queueHarness.refs[index] as { current: T };
  },
  useReducer: (reducer: typeof attachmentQueueReducer) => [
    queueHarness.state,
    (action: AttachmentQueueAction) => {
      queueHarness.state = reducer(queueHarness.state, action);
    },
  ],
}));
function uploadDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
const initializedUpload = {
  attachmentId: '01HV0000000000000000000001',
  putUrl: 'https://upload.test/a',
  putHeaders: {},
  putUrlExpiresAt: 4_000_000_000,
};
function uploadOwner(fetch: typeof globalThis.fetch) {
  const state = { current: true, generation: 0 };
  const client = new KiloChatClient({
    eventService: new EventServiceClient({ url: 'https://events.test', getToken: async () => 'a' }),
    baseUrl: 'https://chat.test',
    getToken: async () => 'a',
    fetch,
    canPublish: () => state.current,
    captureOperationAdmission: () => {
      const generation = state.generation;
      return () => {
        if (generation !== state.generation) throw new Error('stale admission');
      };
    },
  });
  return { client, state };
}
function renderQueue(client: KiloChatClient, performUpload: PerformUpload) {
  queueHarness.cursor = 0;
  return useAttachmentQueue(client, 'c', {
    performUpload,
    maxBytes: 1000,
    generateTempId: () => 'tmp-1',
  });
}

describe('attachment queue operation ownership', () => {
  beforeEach(() => {
    queueHarness.state = { rows: [] };
    queueHarness.refs = [];
    queueHarness.cursor = 0;
  });

  it('retains bytes and rejects an initialized upload after lock/unlock', async () => {
    const response = uploadDeferred<Response>();
    const entered = uploadDeferred<void>();
    const { client, state } = uploadOwner(async () => {
      entered.resolve();
      return response.promise;
    });
    const uploads: string[] = [];
    const queue = renderQueue(client, async blob => {
      uploads.push(await blob.text());
    });
    queue.addFile({ blob: new Blob(['photo']), filename: 'a.png', mimeType: 'image/png' });
    await entered.promise;
    state.generation++;
    response.resolve(Response.json(initializedUpload));
    await vi.waitFor(() => expect(queueHarness.state.rows[0]?.status).toBe('failed'));
    expect(queueHarness.state.rows[0]).toMatchObject({
      attachmentId: initializedUpload.attachmentId,
      error: 'stale admission',
    });
    expect(await queue.getBlob('tmp-1')?.text()).toBe('photo');
    await Promise.resolve();
    expect(uploads).toEqual([]);
  });

  it('keeps the explicit retry admission through renewed initialization', async () => {
    const second = uploadDeferred<Response>();
    let initializations = 0;
    const { client, state } = uploadOwner(async () => {
      initializations++;
      return initializations === 1
        ? Response.json({ ...initializedUpload, putUrlExpiresAt: 1 })
        : second.promise;
    });
    const uploads: string[] = [];
    const upload: PerformUpload = async blob => {
      uploads.push(await blob.text());
      throw new Error('network');
    };
    renderQueue(client, upload).addFile({
      blob: new Blob(['photo']),
      filename: 'a.png',
      mimeType: 'image/png',
    });
    await vi.waitFor(() => expect(queueHarness.state.rows[0]?.status).toBe('failed'));
    const queue = renderQueue(client, upload);
    queue.retryFile('tmp-1');
    await vi.waitFor(() => expect(initializations).toBe(2));
    state.generation++;
    second.resolve(Response.json(initializedUpload));
    await vi.waitFor(() => expect(queueHarness.state.rows[0]?.error).toBe('stale admission'));
    expect(uploads).toEqual(['photo']);
    expect(await queue.getBlob('tmp-1')?.text()).toBe('photo');
  });

  it('does not publish A initialization after the owner becomes B', async () => {
    const response = uploadDeferred<Response>();
    const entered = uploadDeferred<void>();
    const { client, state } = uploadOwner(async () => {
      entered.resolve();
      return response.promise;
    });
    const uploads: string[] = [];
    const queue = renderQueue(client, async blob => {
      uploads.push(await blob.text());
    });
    queue.addFile({ blob: new Blob(['A']), filename: 'a.png', mimeType: 'image/png' });
    await entered.promise;
    state.current = false;
    response.resolve(Response.json(initializedUpload));
    await vi.waitFor(() => expect(client.canPublish()).toBe(false));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(queueHarness.state.rows[0]).toMatchObject({ status: 'uploading' });
    expect(queueHarness.state.rows[0]?.attachmentId).toBeUndefined();
    expect(uploads).toEqual([]);
  });

  it('stores accepted upload completion for the original owner while locked', async () => {
    const accepted = uploadDeferred<void>();
    const entered = uploadDeferred<void>();
    const { client, state } = uploadOwner(async () => Response.json(initializedUpload));
    const queue = renderQueue(client, async (_blob, _url, _headers, options) => {
      options.operation?.assertDispatch();
      entered.resolve();
      await accepted.promise;
    });
    queue.addFile({ blob: new Blob(['photo']), filename: 'a.png', mimeType: 'image/png' });
    await entered.promise;
    state.generation++;
    accepted.resolve();
    await vi.waitFor(() => expect(queueHarness.state.rows[0]?.status).toBe('ready'));
    expect(selectReadyBlocks(queueHarness.state.rows)[0]?.attachmentId).toBe(
      initializedUpload.attachmentId
    );
    expect(await queue.getBlob('tmp-1')?.text()).toBe('photo');
  });

  it('preserves a legacy producer without client or queue admission hooks', async () => {
    const client = new KiloChatClient({
      eventService: new EventServiceClient({
        url: 'https://events.test',
        getToken: async () => 'a',
      }),
      baseUrl: 'https://chat.test',
      getToken: async () => 'legacy',
      fetch: async () => Response.json(initializedUpload),
    });
    const uploads: string[] = [];
    renderQueue(client, async blob => {
      uploads.push(await blob.text());
    }).addFile({ blob: new Blob(['legacy']), filename: 'a', mimeType: 'image/png' });
    await vi.waitFor(() => expect(queueHarness.state.rows[0]?.status).toBe('ready'));
    expect(uploads).toEqual(['legacy']);
  });
});

import {
  attachmentQueueReducer,
  selectHasFailed,
  selectIsUploading,
  selectReadyBlocks,
  type AttachmentQueueAction,
  type AttachmentQueueState,
  type QueuedAttachment,
} from './use-attachment-queue';

function row(overrides: Partial<QueuedAttachment> = {}): QueuedAttachment {
  return {
    tempId: 'tmp-1',
    filename: 'a.png',
    mimeType: 'image/png',
    size: 100,
    status: 'uploading',
    progress: 0,
    attachmentId: undefined,
    error: undefined,
    ...overrides,
  };
}

function state(rows: QueuedAttachment[]): AttachmentQueueState {
  return { rows };
}

function reduce(s: AttachmentQueueState, a: AttachmentQueueAction): AttachmentQueueState {
  return attachmentQueueReducer(s, a);
}

describe('attachmentQueueReducer', () => {
  it('add appends a new row in uploading status', () => {
    const next = reduce(state([]), {
      type: 'add',
      row: row({ tempId: 'tmp-1' }),
    });
    expect(next.rows.map(r => r.tempId)).toEqual(['tmp-1']);
    expect(next.rows[0]?.status).toBe('uploading');
  });

  it('setInited stores the attachmentId on the matching row', () => {
    const s = state([row({ tempId: 'tmp-1' })]);
    const next = reduce(s, {
      type: 'setInited',
      tempId: 'tmp-1',
      attachmentId: '01HV0000000000000000000001',
    });
    expect(next.rows[0]?.attachmentId).toBe('01HV0000000000000000000001');
  });

  it('setProgress clamps to [0, 1] and updates the right row', () => {
    const s = state([row({ tempId: 'tmp-1' }), row({ tempId: 'tmp-2' })]);
    const next = reduce(s, { type: 'setProgress', tempId: 'tmp-2', progress: 1.5 });
    expect(next.rows[0]?.progress).toBe(0);
    expect(next.rows[1]?.progress).toBe(1);
  });

  it('setReady transitions row to ready and pins progress to 1', () => {
    const s = state([row({ tempId: 'tmp-1', progress: 0.7 })]);
    const next = reduce(s, { type: 'setReady', tempId: 'tmp-1' });
    expect(next.rows[0]?.status).toBe('ready');
    expect(next.rows[0]?.progress).toBe(1);
  });

  it('setFailed records the error and marks failed', () => {
    const s = state([row({ tempId: 'tmp-1' })]);
    const next = reduce(s, { type: 'setFailed', tempId: 'tmp-1', error: 'boom' });
    expect(next.rows[0]?.status).toBe('failed');
    expect(next.rows[0]?.error).toBe('boom');
  });

  it('retry resets progress and status to uploading, clears error', () => {
    const s = state([row({ tempId: 'tmp-1', status: 'failed', error: 'boom', progress: 0.4 })]);
    const next = reduce(s, { type: 'retry', tempId: 'tmp-1' });
    expect(next.rows[0]?.status).toBe('uploading');
    expect(next.rows[0]?.progress).toBe(0);
    expect(next.rows[0]?.error).toBeUndefined();
  });

  it('remove drops the row', () => {
    const s = state([row({ tempId: 'tmp-1' }), row({ tempId: 'tmp-2' })]);
    const next = reduce(s, { type: 'remove', tempId: 'tmp-1' });
    expect(next.rows.map(r => r.tempId)).toEqual(['tmp-2']);
  });

  it('clear empties the queue', () => {
    const s = state([row({ tempId: 'tmp-1' }), row({ tempId: 'tmp-2' })]);
    const next = reduce(s, { type: 'clear' });
    expect(next.rows).toEqual([]);
  });

  it('clearFiles removes only submitted attachment rows', () => {
    const s = state([row({ tempId: 'submitted' }), row({ tempId: 'next-message' })]);
    const next = reduce(s, { type: 'clearFiles', tempIds: ['submitted'] });
    expect(next.rows.map(r => r.tempId)).toEqual(['next-message']);
  });
});

describe('queue selectors', () => {
  it('selectReadyBlocks returns only ready rows with attachmentId, mapped to AttachmentBlock', () => {
    const rows: QueuedAttachment[] = [
      row({ tempId: 'a', status: 'ready', attachmentId: '01HV0000000000000000000001' }),
      row({ tempId: 'b', status: 'uploading' }),
      row({ tempId: 'c', status: 'ready', attachmentId: undefined }),
      row({
        tempId: 'd',
        status: 'ready',
        attachmentId: '01HV0000000000000000000002',
        filename: 'x.bin',
        mimeType: 'application/octet-stream',
        size: 1234,
      }),
    ];
    expect(selectReadyBlocks(rows)).toEqual([
      {
        type: 'attachment',
        attachmentId: '01HV0000000000000000000001',
        mimeType: 'image/png',
        size: 100,
        filename: 'a.png',
      },
      {
        type: 'attachment',
        attachmentId: '01HV0000000000000000000002',
        mimeType: 'application/octet-stream',
        size: 1234,
        filename: 'x.bin',
      },
    ]);
  });

  it('selectIsUploading is true when any row is uploading', () => {
    expect(selectIsUploading([row({ status: 'ready' }), row({ status: 'uploading' })])).toBe(true);
    expect(selectIsUploading([row({ status: 'ready' }), row({ status: 'failed' })])).toBe(false);
    expect(selectIsUploading([])).toBe(false);
  });

  it('selectHasFailed is true when any row is failed', () => {
    expect(selectHasFailed([row({ status: 'ready' }), row({ status: 'failed' })])).toBe(true);
    expect(selectHasFailed([row({ status: 'ready' }), row({ status: 'uploading' })])).toBe(false);
  });
});
