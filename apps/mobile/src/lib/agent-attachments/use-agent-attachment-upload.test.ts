/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/lib/auth/auth-context.test.tsx) */
/* eslint-disable max-lines -- the Row 3.3 hook FSM suite shares this single owned test file with the pure upload-contract helpers */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_ATTACHMENT_MAX_BYTES } from './constants';
import {
  type AgentAttachment,
  type AgentAttachmentSubmissionPayload,
  type AgentAttachmentWire,
  buildSubmissionPayload,
  buildWirePayload,
  classifyUploadFailure,
  hasAnyFailedAttachment,
  isAnyAttachmentUploading,
} from './agent-attachment-types';
import { useAgentAttachmentUpload } from './use-agent-attachment-upload';
// Tests import pure helpers from their owning module (not the hook barrel).

// ---- Row 3.3 hook-test mocks ----
//
// The hook tests below drive the upload FSM through `useAgentAttachmentUpload`
// with `uploadOne` as a manually-resolved promise. `uploadOne` is mocked so
// `expo-file-system/legacy` and the tRPC client never load in the node env.

const hoisted = vi.hoisted(() => {
  let idCounter = 0;
  return {
    randomUUID: vi.fn(() => `uuid-${(idCounter += 1)}`),
    uploadOne: vi.fn(),
    announceForA11y: vi.fn(),
    announcingToastError: vi.fn(),
    measureLocalSize: vi.fn(),
    cancelAsync: vi.fn(),
    fileDelete: vi.fn(),
  };
});

vi.mock('expo-crypto', () => ({ randomUUID: hoisted.randomUUID }));
vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/lib/a11y/announce', () => ({ announceForA11y: hoisted.announceForA11y }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: hoisted.announcingToastError, success: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/lib/agent-attachments/upload-task', () => ({
  normalizeFilename: (name: string) => name,
  measureLocalSize: hoisted.measureLocalSize,
  describeTerminalReason: () => "This file can't be uploaded.",
  uploadOne: hoisted.uploadOne,
}));
vi.mock('expo-file-system', () => {
  class FileMock {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    delete() {
      hoisted.fileDelete(this.uri);
    }
  }
  return {
    File: FileMock,
    Paths: { cache: { uri: 'file:///cache' } },
  };
});

function makeAttachment(overrides: Partial<AgentAttachment>): AgentAttachment {
  return {
    id: 'a1',
    filename: 'doc.pdf',
    kind: 'document',
    extension: 'pdf',
    mimeType: 'application/pdf',
    size: 1024,
    localUri: 'file:///cache/doc.pdf',
    status: 'uploaded',
    progress: 1,
    remoteFilename: 'org/2026/07/uuid/doc.pdf',
    ...overrides,
  };
}

describe('classifyUploadFailure — terminal (presign policy rejections)', () => {
  it('marks BAD_REQUEST as terminal', () => {
    expect(
      classifyUploadFailure({ data: { code: 'BAD_REQUEST', message: 'extension not allowed' } })
    ).toEqual({ retryable: false, reason: 'extension not allowed' });
  });

  it('marks FORBIDDEN as terminal', () => {
    expect(classifyUploadFailure({ data: { code: 'FORBIDDEN', message: 'org policy' } })).toEqual({
      retryable: false,
      reason: 'org policy',
    });
  });

  it('marks UNPROCESSABLE_CONTENT as terminal', () => {
    expect(
      classifyUploadFailure({ data: { code: 'UNPROCESSABLE_CONTENT', message: 'bad extension' } })
    ).toEqual({ retryable: false, reason: 'bad extension' });
  });

  it('marks UNAUTHORIZED as terminal', () => {
    expect(classifyUploadFailure({ data: { code: 'UNAUTHORIZED', message: 'expired' } })).toEqual({
      retryable: false,
      reason: 'expired',
    });
  });

  it('marks NOT_FOUND as terminal', () => {
    expect(classifyUploadFailure({ data: { code: 'NOT_FOUND', message: 'gone' } })).toEqual({
      retryable: false,
      reason: 'gone',
    });
  });
});

describe('classifyUploadFailure — retryable (network/timeout/408/429/5xx/PUT)', () => {
  it('marks a TypeError as retryable (network failure)', () => {
    expect(classifyUploadFailure(new TypeError('Network request failed'))).toEqual({
      retryable: true,
      reason: 'Network error',
    });
  });

  it('marks an abort/cancel/expiry message as retryable', () => {
    expect(classifyUploadFailure(new Error('request aborted'))).toEqual({
      retryable: true,
      reason: 'Upload failed',
    });
    expect(classifyUploadFailure(new Error('Upload was canceled'))).toEqual({
      retryable: true,
      reason: 'Upload failed',
    });
    expect(classifyUploadFailure(new Error('URL expired'))).toEqual({
      retryable: true,
      reason: 'Upload failed',
    });
  });

  it('marks HTTP 408 / 429 / 5xx PUT failures as retryable', () => {
    expect(classifyUploadFailure(new Error('Upload failed with status 408'))).toEqual({
      retryable: true,
      reason: 'Upload failed',
    });
    expect(classifyUploadFailure(new Error('Upload failed with status 429'))).toEqual({
      retryable: true,
      reason: 'Upload failed',
    });
    expect(classifyUploadFailure(new Error('Upload failed with status 500'))).toEqual({
      retryable: true,
      reason: 'Upload failed',
    });
    expect(classifyUploadFailure(new Error('Upload failed with status 503'))).toEqual({
      retryable: true,
      reason: 'Upload failed',
    });
  });

  it('marks any other HTTP error as retryable (the plan pins PUT failures as retryable)', () => {
    expect(classifyUploadFailure(new Error('Upload failed with status 418'))).toEqual({
      retryable: true,
      reason: 'Upload failed',
    });
  });

  it('marks an unknown thrown value as retryable with a generic reason', () => {
    expect(classifyUploadFailure('something weird')).toEqual({
      retryable: true,
      reason: 'Upload failed',
    });
    expect(classifyUploadFailure(undefined)).toEqual({
      retryable: true,
      reason: 'Upload failed',
    });
  });

  it('never collapses retryable and terminal into a single bucket', () => {
    const retryable = classifyUploadFailure(new TypeError('Network request failed'));
    const terminal = classifyUploadFailure({ data: { code: 'BAD_REQUEST', message: 'x' } });
    expect(retryable.retryable).toBe(true);
    expect(terminal.retryable).toBe(false);
  });
});

describe('buildWirePayload', () => {
  it('returns undefined when no chips are uploaded', () => {
    expect(buildWirePayload([], 'path-1')).toBeUndefined();
  });

  it('returns undefined when chips are still uploading', () => {
    const list = [
      makeAttachment({ status: 'uploading', progress: 0.5 }),
      makeAttachment({ status: 'pending', progress: 0 }),
    ];
    expect(buildWirePayload(list, 'path-1')).toBeUndefined();
  });

  it('returns {path, files} for uploaded chips only', () => {
    const list = [
      makeAttachment({ id: 'a', remoteFilename: 'org/uuid/a.pdf' }),
      makeAttachment({ id: 'b', status: 'uploading', progress: 0.2 }),
      makeAttachment({ id: 'c', status: 'error', terminal: false }),
    ];
    const payload: AgentAttachmentWire | undefined = buildWirePayload(list, 'path-1');
    expect(payload).toEqual({ path: 'path-1', files: ['org/uuid/a.pdf'] });
  });
});

describe('buildSubmissionPayload', () => {
  it('returns undefined when no chips are uploaded', () => {
    expect(buildSubmissionPayload([], 'path-1', 'uuid-1')).toBeUndefined();
  });

  it('builds the S2 contract: wire + messageUuid + per-file descriptor with NO mime field', () => {
    const list = [
      makeAttachment({
        id: 'a',
        filename: 'a.pdf',
        size: 1024,
        remoteFilename: 'org/uuid/a.pdf',
      }),
    ];
    const payload: AgentAttachmentSubmissionPayload | undefined = buildSubmissionPayload(
      list,
      'path-1',
      'uuid-1'
    );
    expect(payload).toEqual({
      wire: { path: 'path-1', files: ['org/uuid/a.pdf'] },
      messageUuid: 'uuid-1',
      files: [
        {
          remoteName: 'org/uuid/a.pdf',
          originalName: 'a.pdf',
          size: 1024,
        },
      ],
    });
    // No `mime` field on the descriptor — every consumer derives MIME from
    // the validated `remoteName` extension.
    expect(payload).toBeDefined();
    const firstFile = payload?.files[0];
    expect(firstFile).toBeDefined();
    expect(Object.keys(firstFile ?? {})).toEqual(['remoteName', 'originalName', 'size']);
  });

  it('omits in-flight and failed chips from the payload', () => {
    const list = [
      makeAttachment({ id: 'a', remoteFilename: 'org/uuid/a.pdf' }),
      makeAttachment({ id: 'b', status: 'uploading', progress: 0.5 }),
      makeAttachment({ id: 'c', status: 'error', terminal: false }),
    ];
    const payload = buildSubmissionPayload(list, 'path-1', 'uuid-1');
    expect(payload?.files).toHaveLength(1);
    expect(payload?.files[0]?.remoteName).toBe('org/uuid/a.pdf');
  });
});

describe('isAnyAttachmentUploading / hasAnyFailedAttachment (send-admission signals)', () => {
  it('reports uploading=true while a chip is in flight', () => {
    const list = [makeAttachment({ status: 'uploading', progress: 0.5 })];
    expect(isAnyAttachmentUploading(list)).toBe(true);
    expect(hasAnyFailedAttachment(list)).toBe(false);
  });

  it('reports uploading=true for a pending chip (not yet started)', () => {
    const list = [makeAttachment({ status: 'pending', progress: 0 })];
    expect(isAnyAttachmentUploading(list)).toBe(true);
  });

  it('reports hasFailed=true after a chip errors (retryable OR terminal)', () => {
    const retryable = [makeAttachment({ status: 'error', terminal: false, progress: null })];
    const terminal = [makeAttachment({ status: 'error', terminal: true, progress: null })];
    expect(hasAnyFailedAttachment(retryable)).toBe(true);
    expect(hasAnyFailedAttachment(terminal)).toBe(true);
  });

  it('reports both signals false once every chip is uploaded', () => {
    const list = [makeAttachment({ status: 'uploaded', progress: 1 })];
    expect(isAnyAttachmentUploading(list)).toBe(false);
    expect(hasAnyFailedAttachment(list)).toBe(false);
  });

  it('reports both signals false on an empty list (send can proceed)', () => {
    expect(isAnyAttachmentUploading([])).toBe(false);
    expect(hasAnyFailedAttachment([])).toBe(false);
  });
});

describe('feature-state matrix — send-admission behavior', () => {
  it('blocks send while ANY chip is uploading OR failed', () => {
    const cases: { list: AgentAttachment[]; shouldBlock: boolean }[] = [
      { list: [], shouldBlock: false },
      { list: [makeAttachment({ status: 'uploaded', progress: 1 })], shouldBlock: false },
      { list: [makeAttachment({ status: 'uploading', progress: 0.5 })], shouldBlock: true },
      { list: [makeAttachment({ status: 'pending', progress: 0 })], shouldBlock: true },
      {
        list: [makeAttachment({ status: 'error', terminal: false, progress: null })],
        shouldBlock: true,
      },
      {
        list: [makeAttachment({ status: 'error', terminal: true, progress: null })],
        shouldBlock: true,
      },
      // Mixed: one uploaded + one uploading still blocks.
      {
        list: [
          makeAttachment({ id: 'a', status: 'uploaded', progress: 1 }),
          makeAttachment({ id: 'b', status: 'uploading', progress: 0.3 }),
        ],
        shouldBlock: true,
      },
      // Mixed: one uploaded + one terminal still blocks until the terminal chip is removed.
      {
        list: [
          makeAttachment({ id: 'a', status: 'uploaded', progress: 1 }),
          makeAttachment({ id: 'b', status: 'error', terminal: true, progress: null }),
        ],
        shouldBlock: true,
      },
    ];
    for (const { list, shouldBlock } of cases) {
      const blocked = isAnyAttachmentUploading(list) || hasAnyFailedAttachment(list);
      expect(blocked, `unexpected admission for ${JSON.stringify(list.map(a => a.status))}`).toBe(
        shouldBlock
      );
    }
  });
});

describe('size limits (20 MB / 5 files) — constant parity', () => {
  it('exposes the 20 MB constant for both web and mobile parity', () => {
    expect(AGENT_ATTACHMENT_MAX_BYTES).toBe(20 * 1024 * 1024);
  });
});

// ---- Row 3.3: announcement ownership + stale-outcome guard ----
//
// These tests drive the hook FSM through a controlled `uploadOne` promise and
// assert that success/failure announcements belong ONLY to the current
// attachment in the current generation: a removed or reset upload must not
// update state or announce. `measureLocalSize` resolves 1024 so a `doc.pdf`
// candidate always classifies as a valid document chip.

let resolveUpload: ((value: { key: string }) => void) | undefined = undefined;
let rejectUpload: ((reason?: unknown) => void) | undefined = undefined;

type HookApi = ReturnType<typeof useAgentAttachmentUpload>;

const hookRef: { current: HookApi | undefined } = { current: undefined };

function Harness() {
  hookRef.current = useAgentAttachmentUpload();
  return null;
}

function hookApi(): HookApi {
  const current = hookRef.current;
  if (!current) {
    throw new Error('hook was not mounted');
  }
  return current;
}

async function mountHook(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(Harness));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function addDocument(): Promise<void> {
  await act(async () => {
    await hookApi().addCandidates([{ name: 'doc.pdf', uri: 'file:///cache/doc.pdf' }]);
  });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('useAgentAttachmentUpload — announcement ownership (Row 3.3)', () => {
  beforeEach(() => {
    hoisted.uploadOne.mockReset();
    hoisted.announceForA11y.mockReset();
    hoisted.announcingToastError.mockReset();
    hoisted.measureLocalSize.mockReset();
    hoisted.cancelAsync.mockReset();
    hoisted.fileDelete.mockReset();
    hoisted.measureLocalSize.mockResolvedValue(1024);
    resolveUpload = undefined;
    rejectUpload = undefined;
    // Every test controls a fresh pending `uploadOne` promise and settles it
    // explicitly, so remove/reset can run while the upload is still in flight.
    const controlled = new Promise<{ key: string }>((resolve, reject) => {
      resolveUpload = resolve;
      rejectUpload = reject;
    });
    // The mock mirrors `uploadOne`'s real contract: it hands the created
    // task's `cancelAsync` back through `onTask` before the upload settles.
    hoisted.uploadOne.mockImplementation(
      async (args: { onTask?: (task: { cancelAsync: () => Promise<void> }) => void }) => {
        args.onTask?.({ cancelAsync: hoisted.cancelAsync });
        const result = await controlled;
        return result;
      }
    );
  });

  it('announces success exactly once when the upload resolves', async () => {
    const renderer = await mountHook();
    await addDocument();
    expect(hookApi().attachments[0]?.status).toBe('uploading');

    await act(async () => {
      resolveUpload?.({ key: 'org/2026/08/uuid/doc.pdf' });
      await settle();
    });

    expect(hoisted.announceForA11y).toHaveBeenCalledTimes(1);
    expect(hoisted.announceForA11y).toHaveBeenCalledWith('Attachment uploaded');
    const attachment = hookApi().attachments[0];
    expect(attachment?.status).toBe('uploaded');
    expect(attachment?.remoteFilename).toBe('doc.pdf');
    renderer.unmount();
  });

  it('owns retryable failure announcements: one announcingToast.error, no success announce', async () => {
    const renderer = await mountHook();
    await addDocument();

    await act(async () => {
      rejectUpload?.(new TypeError('Network request failed'));
      await settle();
    });

    expect(hoisted.announcingToastError).toHaveBeenCalledTimes(1);
    expect(hoisted.announcingToastError).toHaveBeenCalledWith(
      'Failed to upload file: Network error'
    );
    expect(hoisted.announceForA11y).not.toHaveBeenCalled();
    const attachment = hookApi().attachments[0];
    expect(attachment?.status).toBe('error');
    expect(attachment?.terminal).toBe(false);
    expect(attachment?.error).toBe('Network error');
    renderer.unmount();
  });

  it('owns terminal failure announcements: one announcingToast.error with terminal copy', async () => {
    const renderer = await mountHook();
    await addDocument();

    await act(async () => {
      rejectUpload?.({ data: { code: 'BAD_REQUEST', message: 'extension not allowed' } });
      await settle();
    });

    expect(hoisted.announcingToastError).toHaveBeenCalledTimes(1);
    expect(hoisted.announcingToastError).toHaveBeenCalledWith("This file can't be uploaded.");
    const attachment = hookApi().attachments[0];
    expect(attachment?.status).toBe('error');
    expect(attachment?.terminal).toBe(true);
    expect(attachment?.error).toBe("This file can't be uploaded.");
    renderer.unmount();
  });

  it('restarts the upload when retry is pressed after a retryable failure', async () => {
    const renderer = await mountHook();
    await addDocument();
    await act(async () => {
      rejectUpload?.(new TypeError('Network request failed'));
      await settle();
    });
    expect(hoisted.uploadOne).toHaveBeenCalledTimes(1);
    const id = hookApi().attachments[0]?.id;
    if (!id) {
      throw new Error('attachment id missing');
    }

    // The retried attempt gets a fresh pending promise to resolve.
    const retried = new Promise<{ key: string }>((resolve, reject) => {
      resolveUpload = resolve;
      rejectUpload = reject;
    });
    hoisted.uploadOne.mockReturnValueOnce(retried);
    await act(async () => {
      hookApi().retryAttachment(id);
      await settle();
    });
    expect(hoisted.uploadOne).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveUpload?.({ key: 'org/2026/08/uuid/doc.pdf' });
      await settle();
    });
    expect(hookApi().attachments[0]?.status).toBe('uploaded');
    expect(hoisted.announcingToastError).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('never announces or updates state when the chip is removed before success', async () => {
    const renderer = await mountHook();
    await addDocument();
    const id = hookApi().attachments[0]?.id;
    if (!id) {
      throw new Error('attachment id missing');
    }

    await act(async () => {
      hookApi().removeAttachment(id);
      await settle();
    });
    expect(hookApi().attachments).toHaveLength(0);

    await act(async () => {
      resolveUpload?.({ key: 'org/2026/08/uuid/doc.pdf' });
      await settle();
    });

    expect(hoisted.announceForA11y).not.toHaveBeenCalled();
    expect(hookApi().attachments).toHaveLength(0);
    renderer.unmount();
  });

  it('never announces or updates state when the composer is reset before the outcome', async () => {
    const renderer = await mountHook();
    await addDocument();

    await act(async () => {
      hookApi().reset();
      await settle();
    });
    expect(hookApi().attachments).toHaveLength(0);

    await act(async () => {
      resolveUpload?.({ key: 'org/2026/08/uuid/doc.pdf' });
      await settle();
    });

    expect(hoisted.announceForA11y).not.toHaveBeenCalled();
    expect(hoisted.announcingToastError).not.toHaveBeenCalled();
    expect(hookApi().attachments).toHaveLength(0);
    renderer.unmount();
  });

  it('adds no stale candidates or uploads when reset runs during measurement', async () => {
    let resolveMeasure: ((size: number) => void) | undefined = undefined;
    hoisted.measureLocalSize.mockReturnValueOnce(
      new Promise<number>(resolve => {
        resolveMeasure = resolve;
      })
    );
    const renderer = await mountHook();

    let addPromise: Promise<void> | undefined = undefined;
    await act(async () => {
      // The continuation suspends on the pending measurement below.
      addPromise = hookApi().addCandidates([{ name: 'doc.pdf', uri: 'file:///cache/doc.pdf' }]);
      await Promise.resolve();
    });

    await act(async () => {
      hookApi().reset();
      await settle();
    });
    expect(hookApi().attachments).toHaveLength(0);

    await act(async () => {
      resolveMeasure?.(1024);
      await addPromise;
      await settle();
    });

    // The post-reset generation guard drops the measured candidates: no
    // chips, no uploads, no announcements, and no failure toasts.
    expect(hookApi().attachments).toHaveLength(0);
    expect(hoisted.uploadOne).not.toHaveBeenCalled();
    expect(hoisted.announceForA11y).not.toHaveBeenCalled();
    expect(hoisted.announcingToastError).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('cancels the in-flight upload and deletes a cache-owned file on remove', async () => {
    const renderer = await mountHook();
    await addDocument();
    const id = hookApi().attachments[0]?.id;
    if (!id) {
      throw new Error('attachment id missing');
    }

    await act(async () => {
      hookApi().removeAttachment(id);
      await settle();
    });

    expect(hoisted.cancelAsync).toHaveBeenCalledTimes(1);
    expect(hoisted.fileDelete).toHaveBeenCalledTimes(1);
    expect(hoisted.fileDelete).toHaveBeenCalledWith('file:///cache/doc.pdf');
    renderer.unmount();
  });

  it('does not delete a picker-provided URI on remove', async () => {
    const renderer = await mountHook();
    await act(async () => {
      await hookApi().addCandidates([{ name: 'doc.pdf', uri: 'file:///documents/picked.pdf' }]);
    });
    const id = hookApi().attachments[0]?.id;
    if (!id) {
      throw new Error('attachment id missing');
    }

    await act(async () => {
      hookApi().removeAttachment(id);
      await settle();
    });

    expect(hoisted.cancelAsync).toHaveBeenCalledTimes(1);
    expect(hoisted.fileDelete).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('cancels every in-flight upload and deletes cache-owned files on reset', async () => {
    const renderer = await mountHook();
    await addDocument();

    await act(async () => {
      hookApi().reset();
      await settle();
    });

    expect(hoisted.cancelAsync).toHaveBeenCalledTimes(1);
    expect(hoisted.fileDelete).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('cancels every in-flight upload on unmount with no toast and no state flip', async () => {
    const renderer = await mountHook();
    await addDocument();

    await act(async () => {
      renderer.unmount();
      await settle();
    });

    expect(hoisted.cancelAsync).toHaveBeenCalledTimes(1);
    expect(hoisted.fileDelete).toHaveBeenCalledTimes(1);

    // The cancelled upload later rejects: unmount invalidated the live id, so
    // the catch emits no toast and flips no state.
    await act(async () => {
      rejectUpload?.(new TypeError('Network request failed'));
      await settle();
    });

    expect(hoisted.announcingToastError).not.toHaveBeenCalled();
    expect(hoisted.announceForA11y).not.toHaveBeenCalled();
  });

  it('a cancelled upload emits no toast and no state flip when it later rejects', async () => {
    const renderer = await mountHook();
    await addDocument();
    const id = hookApi().attachments[0]?.id;
    if (!id) {
      throw new Error('attachment id missing');
    }

    await act(async () => {
      hookApi().removeAttachment(id);
      await settle();
    });
    expect(hookApi().attachments).toHaveLength(0);

    await act(async () => {
      rejectUpload?.(new TypeError('Network request failed'));
      await settle();
    });

    expect(hoisted.announcingToastError).not.toHaveBeenCalled();
    expect(hoisted.announceForA11y).not.toHaveBeenCalled();
    expect(hookApi().attachments).toHaveLength(0);
    renderer.unmount();
  });
});
