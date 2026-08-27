/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/lib/auth/auth-context.test.tsx) */
/* eslint-disable max-lines -- the Row 3.3 hook FSM suite shares this single owned test file with the pure upload-contract helpers */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as ImageManipulator from 'expo-image-manipulator';

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
    releasePendingUploads: vi.fn(() => undefined),
    announceForA11y: vi.fn(),
    announcingToastError: vi.fn(),
    measureLocalSize: vi.fn(),
    cancelAsync: vi.fn(),
    fileDelete: vi.fn(),
    captureException: vi.fn(),
    deletedUris: new Set<string>(),
  };
});

vi.mock('expo-crypto', () => ({ randomUUID: hoisted.randomUUID }));
vi.mock('@sentry/react-native', () => ({ captureException: hoisted.captureException }));
vi.mock('expo-file-system/legacy', () => ({ deleteAsync: vi.fn() }));
vi.mock('expo-image-manipulator', () => ({
  SaveFormat: { PNG: 'png', WEBP: 'webp', JPEG: 'jpeg' },
  manipulateAsync: vi.fn(),
}));
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
  releasePendingUploads: hoisted.releasePendingUploads,
}));
vi.mock('expo-file-system', () => {
  class FileMock {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get exists() {
      return !hoisted.deletedUris.has(this.uri);
    }
    delete() {
      if (hoisted.deletedUris.has(this.uri)) {
        // already deleted — idempotent, matching production
        return;
      }
      hoisted.deletedUris.add(this.uri);
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

  it('reports uploading=false for a pending chip (not yet started)', () => {
    const list = [makeAttachment({ status: 'pending', progress: 0 })];
    expect(isAnyAttachmentUploading(list)).toBe(false);
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
      { list: [makeAttachment({ status: 'pending', progress: 0 })], shouldBlock: false },
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

/** Runs `uploadPending` inside `act` and returns the settled, non-undefined result. */
async function uploadPendingResult(): Promise<Awaited<ReturnType<HookApi['uploadPending']>>> {
  let result: Awaited<ReturnType<HookApi['uploadPending']>> | undefined = undefined;
  await act(async () => {
    result = await hookApi().uploadPending();
  });
  return result as unknown as Awaited<ReturnType<HookApi['uploadPending']>>;
}

describe('addCandidates uploads documents at selection (Step 2)', () => {
  beforeEach(() => {
    hoisted.uploadOne.mockReset();
    hoisted.releasePendingUploads.mockClear();
    hoisted.measureLocalSize.mockReset();
    hoisted.measureLocalSize.mockResolvedValue(1024);
    resolveUpload = undefined;
    rejectUpload = undefined;
    const controlled = new Promise<{ key: string }>((resolve, reject) => {
      resolveUpload = resolve;
      rejectUpload = reject;
    });
    hoisted.uploadOne.mockReturnValue(controlled);
  });

  it('starts the upload for a document at selection time and flips the chip to uploading', async () => {
    const renderer = await mountHook();
    await addDocument();
    expect(hoisted.uploadOne).toHaveBeenCalledTimes(1);
    expect(hookApi().attachments[0]?.status).toBe('uploading');
    renderer.unmount();
  });

  it('never uploads a strip-failed image and marks it a terminal chip', async () => {
    vi.mocked(ImageManipulator.manipulateAsync).mockReset();
    // A strip failure returns the original URI, which the hook reads as
    // metadataStripFailed.
    vi.mocked(ImageManipulator.manipulateAsync).mockResolvedValue({
      uri: 'file:///cache/IMG_0001.HEIC',
      width: 100,
      height: 100,
    });
    const renderer = await mountHook();
    await act(async () => {
      await hookApi().addCandidates([
        { name: 'IMG_0001.HEIC', uri: 'file:///cache/IMG_0001.HEIC' },
      ]);
    });
    const chip = hookApi().attachments[0];
    expect(chip?.status).toBe('error');
    expect(chip?.terminal).toBe(true);
    expect(chip?.metadataStripFailed).toBe(true);
    expect(hoisted.uploadOne).not.toHaveBeenCalled();
    renderer.unmount();
  });
});

describe('uploadPending', () => {
  beforeEach(() => {
    hoisted.uploadOne.mockReset();
    hoisted.releasePendingUploads.mockClear();
    hoisted.announceForA11y.mockReset();
    hoisted.announcingToastError.mockReset();
    hoisted.measureLocalSize.mockReset();
    hoisted.measureLocalSize.mockResolvedValue(1024);
    resolveUpload = undefined;
    rejectUpload = undefined;
    const controlled = new Promise<{ key: string }>((resolve, reject) => {
      resolveUpload = resolve;
      rejectUpload = reject;
    });
    hoisted.uploadOne.mockReturnValue(controlled);
  });

  it('resolves { ok: false } while a selection-time upload is still in flight', async () => {
    const renderer = await mountHook();
    // Starts the upload; the chip is 'uploading'.
    await addDocument();

    let result: Awaited<ReturnType<HookApi['uploadPending']>> | undefined = undefined;
    await act(async () => {
      result = await hookApi().uploadPending();
    });
    expect(result).toEqual({ ok: false });
    // The in-flight upload is not re-triggered by uploadPending.
    expect(hoisted.uploadOne).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('resolves { ok: false } after a terminal upload failure and short-circuits a later call', async () => {
    const renderer = await mountHook();
    await addDocument();

    await act(async () => {
      rejectUpload?.({ data: { code: 'BAD_REQUEST', message: 'extension not allowed' } });
      await settle();
    });
    expect(hookApi().attachments[0]?.terminal).toBe(true);

    await act(async () => {
      const result = await hookApi().uploadPending();
      expect(result).toEqual({ ok: false });
    });
    expect(hoisted.uploadOne).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('resolves { ok: true, wire, submission } once the select-time upload settles', async () => {
    const renderer = await mountHook();
    await addDocument();

    await act(async () => {
      resolveUpload?.({ key: 'org/2026/08/uuid/doc.pdf' });
      await settle();
    });

    let result: Awaited<ReturnType<HookApi['uploadPending']>> | undefined = undefined;
    await act(async () => {
      result = await hookApi().uploadPending();
    });

    expect(result).toEqual({
      ok: true,
      wire: { path: expect.any(String), files: ['doc.pdf'] },
      submission: {
        wire: { path: expect.any(String), files: ['doc.pdf'] },
        messageUuid: expect.any(String),
        files: [{ remoteName: 'doc.pdf', originalName: 'doc.pdf', size: 1024 }],
      },
    });
    renderer.unmount();
  });

  it('retries restored chips under the original upload path after a failed optimistic send', async () => {
    const renderer = await mountHook();
    await addDocument();
    await act(async () => {
      resolveUpload?.({ key: 'org/2026/08/uuid/doc.pdf' });
      await settle();
    });
    expect(hookApi().attachments[0]?.status).toBe('uploaded');

    const original = await uploadPendingResult();
    expect(original).toEqual(expect.objectContaining({ ok: true }));
    expect(original.ok).toBe(true);
    if (!original.ok) {
      throw new Error('expected upload to succeed');
    }
    const originalPath = original.wire?.path;
    expect(originalPath).toBeDefined();

    // The optimistic clear must keep the path; a transport failure then
    // restores the same chips so the retry reuses the original upload path.
    const chips = hookApi().attachments;
    await act(async () => {
      hookApi().clearOptimistic();
      await settle();
    });
    expect(hookApi().attachments).toHaveLength(0);
    await act(async () => {
      hookApi().restoreChips(chips);
      await settle();
    });

    const retry = await uploadPendingResult();
    expect(retry).toEqual(expect.objectContaining({ ok: true }));
    expect(retry.ok).toBe(true);
    if (!retry.ok) {
      throw new Error('expected retry upload to succeed');
    }
    expect(retry.wire?.path).toBe(originalPath);
    expect(retry.wire?.files).toEqual(['doc.pdf']);
    renderer.unmount();
  });

  it('rotates the upload path and submission messageUuid after commitSent', async () => {
    const renderer = await mountHook();
    await addDocument();
    await act(async () => {
      resolveUpload?.({ key: 'org/2026/08/uuid/doc.pdf' });
      await settle();
    });
    expect(hookApi().attachments[0]?.status).toBe('uploaded');

    const first = await uploadPendingResult();
    expect(first).toEqual(expect.objectContaining({ ok: true }));
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error('expected first upload to succeed');
    }
    const firstPath = first.wire?.path;
    const firstUuid = first.submission?.messageUuid;
    expect(firstPath).toBeDefined();
    expect(firstUuid).toBeDefined();

    // A successful send rotates both refs: the next message must presign and
    // submit under fresh UUIDs instead of reusing the previous message's.
    await act(async () => {
      hookApi().commitSent();
      await settle();
    });

    const second = await uploadPendingResult();
    expect(second).toEqual(expect.objectContaining({ ok: true }));
    expect(second.ok).toBe(true);
    if (!second.ok) {
      throw new Error('expected second upload to succeed');
    }
    expect(second.wire?.path).toBeDefined();
    expect(second.wire?.path).not.toBe(firstPath);
    expect(second.submission?.messageUuid).not.toBe(firstUuid);
    renderer.unmount();
  });
});

describe('restoreFileParts — cancel/restore re-send admission', () => {
  beforeEach(() => {
    hoisted.uploadOne.mockReset();
    hoisted.releasePendingUploads.mockClear();
    hoisted.announceForA11y.mockReset();
    hoisted.announcingToastError.mockReset();
    hoisted.measureLocalSize.mockReset();
    hoisted.measureLocalSize.mockResolvedValue(1024);
    resolveUpload = undefined;
    rejectUpload = undefined;
  });

  it('re-admits a restored file chip on the next send with its remote key', async () => {
    const renderer = await mountHook();
    const remoteName = '8f14e45f-ceea-4b2a-8c6d-1a2b3c4d5e6f.pdf';
    await act(async () => {
      hookApi().restoreFileParts([
        {
          filename: remoteName,
          mime: 'application/pdf',
          url: `file:///tmp/attachments/session-1/user-1/msg-uuid-1/${remoteName}`,
        },
      ]);
      await settle();
    });

    const chip = hookApi().attachments[0];
    expect(chip?.status).toBe('uploaded');
    expect(chip?.remoteKey).toBe(`user-1/cloud-agent/msg-uuid-1/${remoteName}`);
    expect(chip?.remoteFilename).toBe(remoteName);

    const result = await uploadPendingResult();

    // The restored chip must appear in the wire and submission, not be
    // silently dropped as a "ready" chip that sends nothing.
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected restored-chip upload to succeed');
    }
    expect(result.wire?.files).toEqual([remoteName]);
    // The restored chip's objects live under the canceled message's UUID, so
    // the wire path must be that UUID, not the rotated current path.
    expect(result.wire?.path).toBe('msg-uuid-1');
    expect(result.submission?.files.map(file => file.remoteName)).toEqual([remoteName]);
    renderer.unmount();
  });

  it('re-admits an optimistic cloud-agent file part on the next send', async () => {
    const renderer = await mountHook();
    const remoteName = '87654321-4321-4321-8321-cba987654321.md';
    await act(async () => {
      hookApi().restoreFileParts([
        {
          filename: remoteName,
          mime: '',
          url: `cloud-agent://12345678-1234-4234-9234-123456789abc/${remoteName}`,
        },
      ]);
      await settle();
    });

    const chip = hookApi().attachments[0];
    expect(chip?.status).toBe('uploaded');
    expect(chip?.remoteFilename).toBe(remoteName);

    const result = await uploadPendingResult();
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected restored-chip upload to succeed');
    }
    expect(result.wire?.files).toEqual([remoteName]);
    // The wire path is the original upload messageUuid the optimistic part encoded.
    expect(result.wire?.path).toBe('12345678-1234-4234-9234-123456789abc');
    expect(result.submission?.files.map(file => file.remoteName)).toEqual([remoteName]);
    renderer.unmount();
  });

  it('skips a part with no URL (not recoverable)', async () => {
    const renderer = await mountHook();
    await act(async () => {
      hookApi().restoreFileParts([{ filename: 'ghost.pdf', mime: 'application/pdf', url: '' }]);
      await settle();
    });
    expect(hookApi().attachments).toHaveLength(0);
    renderer.unmount();
  });
});

describe('useAgentAttachmentUpload — attachment reorder (attachment reorder)', () => {
  beforeEach(() => {
    hoisted.uploadOne.mockReset();
    hoisted.releasePendingUploads.mockClear();
    hoisted.announceForA11y.mockReset();
    hoisted.announcingToastError.mockReset();
    hoisted.measureLocalSize.mockReset();
    hoisted.measureLocalSize.mockResolvedValue(1024);
    resolveUpload = undefined;
    rejectUpload = undefined;
    const controlled = new Promise<{ key: string }>((resolve, reject) => {
      resolveUpload = resolve;
      rejectUpload = reject;
    });
    hoisted.uploadOne.mockReturnValue(controlled);
  });

  async function addThreeDocuments(): Promise<void> {
    await act(async () => {
      await hookApi().addCandidates([
        { name: 'a.pdf', uri: 'file:///cache/a.pdf' },
        { name: 'b.pdf', uri: 'file:///cache/b.pdf' },
        { name: 'c.pdf', uri: 'file:///cache/c.pdf' },
      ]);
    });
    await act(async () => {
      resolveUpload?.({ key: 'org/2026/08/uuid/doc.pdf' });
      await settle();
    });
  }

  async function pendingResult(): Promise<Awaited<ReturnType<HookApi['uploadPending']>>> {
    const resultRef: { current: Awaited<ReturnType<HookApi['uploadPending']>> | undefined } = {
      current: undefined,
    };
    await act(async () => {
      resultRef.current = await hookApi().uploadPending();
    });
    const result = resultRef.current;
    if (result === undefined) {
      throw new Error('uploadPending did not resolve');
    }
    return result;
  }

  it('moves a chip one slot and keeps submission order in sync', async () => {
    const renderer = await mountHook();
    await addThreeDocuments();

    const b = hookApi().attachments[1];
    if (!b) {
      throw new Error('attachment missing');
    }
    // Move b left: [a, b, c] -> [b, a, c].
    await act(async () => {
      hookApi().moveAttachment(b.id, 'left');
      await settle();
    });
    expect(hookApi().attachments.map(item => item.filename)).toEqual(['b.pdf', 'a.pdf', 'c.pdf']);

    const result = await pendingResult();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.submission?.files.map(file => file.originalName)).toEqual([
        'b.pdf',
        'a.pdf',
        'c.pdf',
      ]);
    }
    renderer.unmount();
  });

  it('clamps moveAttachment at both strip edges', async () => {
    const renderer = await mountHook();
    await addThreeDocuments();

    const a = hookApi().attachments[0];
    const c = hookApi().attachments[2];
    if (!a || !c) {
      throw new Error('attachment missing');
    }
    await act(async () => {
      hookApi().moveAttachment(a.id, 'left');
      hookApi().moveAttachment(c.id, 'right');
      await settle();
    });
    expect(hookApi().attachments.map(item => item.filename)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    renderer.unmount();
  });

  it('reorders by index and keeps wire/submission order in sync', async () => {
    const renderer = await mountHook();
    await addThreeDocuments();

    // Move the last chip to the front: [a, b, c] -> [c, a, b].
    await act(async () => {
      hookApi().reorderAttachments(2, 0);
      await settle();
    });
    expect(hookApi().attachments.map(item => item.filename)).toEqual(['c.pdf', 'a.pdf', 'b.pdf']);

    const result = await pendingResult();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.submission?.files.map(file => file.originalName)).toEqual([
        'c.pdf',
        'a.pdf',
        'b.pdf',
      ]);
      // The wire path carries the same slot order as the submission files.
      expect(result.wire?.files).toHaveLength(3);
    }
    renderer.unmount();
  });

  it('no-ops an out-of-range reorder', async () => {
    const renderer = await mountHook();
    await addThreeDocuments();

    await act(async () => {
      hookApi().reorderAttachments(0, 3);
      hookApi().reorderAttachments(-1, 0);
      hookApi().reorderAttachments(1, 1);
      await settle();
    });
    expect(hookApi().attachments.map(item => item.filename)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    renderer.unmount();
  });
});

describe('selection-time image upload (Step 2)', () => {
  beforeEach(() => {
    hoisted.uploadOne.mockReset();
    hoisted.announceForA11y.mockReset();
    hoisted.announcingToastError.mockReset();
    hoisted.measureLocalSize.mockReset();
    hoisted.measureLocalSize.mockResolvedValue(1024);
    vi.mocked(ImageManipulator.manipulateAsync).mockReset();
    vi.mocked(ImageManipulator.manipulateAsync).mockResolvedValue({
      uri: 'file:///cache/stripped.jpg',
      width: 100,
      height: 100,
    });
    resolveUpload = undefined;
    rejectUpload = undefined;
    const controlled = new Promise<{ key: string }>((resolve, reject) => {
      resolveUpload = resolve;
      rejectUpload = reject;
    });
    hoisted.uploadOne.mockReturnValue(controlled);
  });

  it('starts the upload for an image at selection time and flips the chip to uploaded', async () => {
    const renderer = await mountHook();
    await act(async () => {
      await hookApi().addCandidates([
        { name: 'IMG_0001.HEIC', uri: 'file:///cache/IMG_0001.HEIC' },
      ]);
    });

    expect(hoisted.uploadOne).toHaveBeenCalledTimes(1);
    const chip = hookApi().attachments[0];
    expect(chip?.status).toBe('uploading');
    // The strip mock re-encodes HEIC to JPEG, proving the Step 1 pipeline.
    expect(chip?.extension).toBe('jpg');
    expect(chip?.mimeType).toBe('image/jpeg');

    await act(async () => {
      resolveUpload?.({ key: 'org/2026/08/uuid/img.jpg' });
      await settle();
    });

    const uploaded = hookApi().attachments[0];
    expect(uploaded?.status).toBe('uploaded');
    expect(uploaded?.progress).toBe(1);
    expect(uploaded?.remoteFilename).toBe('img.jpg');
    renderer.unmount();
  });

  it('marks a selection-time upload rejection as a retryable error', async () => {
    const renderer = await mountHook();
    await act(async () => {
      await hookApi().addCandidates([
        { name: 'IMG_0001.HEIC', uri: 'file:///cache/IMG_0001.HEIC' },
      ]);
    });

    await act(async () => {
      rejectUpload?.(new TypeError('Network request failed'));
      await settle();
    });

    const chip = hookApi().attachments[0];
    expect(chip?.status).toBe('error');
    expect(chip?.terminal).toBe(false);
    renderer.unmount();
  });

  it('returns ok from uploadPending after the image pre-uploaded without a second uploadOne call', async () => {
    const renderer = await mountHook();
    await act(async () => {
      await hookApi().addCandidates([
        { name: 'IMG_0001.HEIC', uri: 'file:///cache/IMG_0001.HEIC' },
      ]);
    });
    await act(async () => {
      resolveUpload?.({ key: 'org/2026/08/uuid/img.jpg' });
      await settle();
    });
    expect(hoisted.uploadOne).toHaveBeenCalledTimes(1);

    let result: Awaited<ReturnType<HookApi['uploadPending']>> | undefined = undefined;
    await act(async () => {
      result = await hookApi().uploadPending();
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(hoisted.uploadOne).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });
});

describe('useAgentAttachmentUpload — announcement ownership (Row 3.3)', () => {
  beforeEach(() => {
    hoisted.uploadOne.mockReset();
    hoisted.releasePendingUploads.mockClear();
    hoisted.announceForA11y.mockReset();
    hoisted.announcingToastError.mockReset();
    hoisted.measureLocalSize.mockReset();
    hoisted.cancelAsync.mockReset();
    hoisted.fileDelete.mockReset();
    hoisted.captureException.mockReset();
    hoisted.deletedUris.clear();
    hoisted.measureLocalSize.mockResolvedValue(1024);
    resolveUpload = undefined;
    rejectUpload = undefined;
    // Every test controls a fresh pending `uploadOne` promise and settles it
    // explicitly, so remove/reset can run while the upload is still in flight.
    const controlled = new Promise<{ key: string }>((resolve, reject) => {
      resolveUpload = resolve;
      rejectUpload = reject;
    });
    // The mock mirrors `uploadOne`'s real contract: it admits the key through
    // `onAdmitted` and hands the created task's `cancelAsync` back through
    // `onTask` before the upload settles.
    hoisted.uploadOne.mockImplementation(
      async (args: {
        onTask?: (task: { cancelAsync: () => Promise<void> }) => void;
        onAdmitted?: (key: string) => void;
      }) => {
        args.onAdmitted?.('org/2026/08/uuid/doc.pdf');
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

    // The upload is already in flight; remove the chip before it settles.
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

  it('reports a cache file delete failure with safe context', async () => {
    const renderer = await mountHook();
    await addDocument();
    const id = hookApi().attachments[0]?.id;
    if (!id) {
      throw new Error('attachment id missing');
    }
    hoisted.fileDelete.mockImplementationOnce(() => {
      throw new Error('delete failed');
    });

    await act(async () => {
      hookApi().removeAttachment(id);
      await settle();
    });

    expect(hoisted.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        'error.subsystem': 'agent-attachments',
        'error.operation': 'delete-cache-file',
      },
      extra: { cacheOwned: true },
      fingerprint: ['agent-attachments-delete-cache-file'],
    });
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

  it('deletes the cache-owned file when removed during the presign window (onTask not yet called)', async () => {
    // Simulate the presign window: `uploadOne` captures `onTask` but does not
    // hand the task back before the upload settles, so `task` stays undefined.
    let capturedOnTask: ((task: { cancelAsync: () => Promise<void> }) => void) | undefined =
      undefined;
    hoisted.uploadOne.mockImplementation(
      async (args: { onTask?: (task: { cancelAsync: () => Promise<void> }) => void }) => {
        capturedOnTask = args.onTask;
        // Never resolves: the upload stays in the presign window, so the task
        // is never handed back through `onTask`.
        const result = await new Promise<{ key: string }>(resolve => {
          resolveUpload = resolve;
        });
        return result;
      }
    );
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

    // The task was never handed back, so no cancelAsync; the finally cleanup
    // must still delete the cache-owned file.
    expect(capturedOnTask).toBeDefined();
    expect(hoisted.cancelAsync).not.toHaveBeenCalled();
    expect(hoisted.fileDelete).toHaveBeenCalledTimes(1);
    expect(hoisted.fileDelete).toHaveBeenCalledWith('file:///cache/doc.pdf');
    renderer.unmount();
  });

  it('does not start an upload task when removed during the presign window', async () => {
    let createTaskAfterPresign = 0;
    let cancelledAfterPresign = false;
    hoisted.uploadOne.mockImplementation(
      async (args: {
        onTask?: (task: { cancelAsync: () => Promise<void> }) => void;
        isCancelled?: () => boolean;
      }) => {
        const result = await new Promise<{ key: string }>(resolve => {
          resolveUpload = resolve;
        });
        if (args.isCancelled?.()) {
          cancelledAfterPresign = true;
          throw new Error('Upload cancelled');
        }
        createTaskAfterPresign += 1;
        args.onTask?.({ cancelAsync: hoisted.cancelAsync });
        return result;
      }
    );
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

    await act(async () => {
      resolveUpload?.({ key: 'org/2026/08/uuid/doc.pdf' });
      await settle();
    });

    expect(cancelledAfterPresign).toBe(true);
    expect(createTaskAfterPresign).toBe(0);
    expect(hoisted.cancelAsync).not.toHaveBeenCalled();
    expect(hookApi().attachments).toHaveLength(0);
    renderer.unmount();
  });

  it('deletes the cache-owned file even when cancelAsync rejects', async () => {
    hoisted.cancelAsync.mockRejectedValue(new Error('cancel failed'));
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

describe('useAgentAttachmentUpload — release of admitted keys (Steps 4/5)', () => {
  beforeEach(() => {
    hoisted.uploadOne.mockReset();
    hoisted.releasePendingUploads.mockClear();
    hoisted.announceForA11y.mockReset();
    hoisted.announcingToastError.mockReset();
    hoisted.measureLocalSize.mockReset();
    hoisted.cancelAsync.mockReset();
    hoisted.fileDelete.mockReset();
    hoisted.deletedUris.clear();
    hoisted.measureLocalSize.mockResolvedValue(1024);
    resolveUpload = undefined;
    rejectUpload = undefined;
    const controlled = new Promise<{ key: string }>((resolve, reject) => {
      resolveUpload = resolve;
      rejectUpload = reject;
    });
    hoisted.uploadOne.mockImplementation(
      async (args: {
        onTask?: (task: { cancelAsync: () => Promise<void> }) => void;
        onAdmitted?: (key: string) => void;
      }) => {
        args.onAdmitted?.('org/2026/08/uuid/doc.pdf');
        args.onTask?.({ cancelAsync: hoisted.cancelAsync });
        const result = await controlled;
        return result;
      }
    );
  });

  it('releases the admitted key when the chip is removed', async () => {
    const renderer = await mountHook();
    await addDocument();
    await act(async () => {
      resolveUpload?.({ key: 'org/2026/08/uuid/doc.pdf' });
      await settle();
    });
    expect(hookApi().attachments[0]?.status).toBe('uploaded');
    const id = hookApi().attachments[0]?.id;
    if (!id) {
      throw new Error('attachment id missing');
    }

    await act(async () => {
      hookApi().removeAttachment(id);
      await settle();
    });

    expect(hoisted.releasePendingUploads).toHaveBeenCalledTimes(1);
    expect(hoisted.releasePendingUploads).toHaveBeenCalledWith({
      organizationId: undefined,
      objectKeys: ['org/2026/08/uuid/doc.pdf'],
    });
    renderer.unmount();
  });

  it('does not release after a retryable failure (the chip stays recoverable)', async () => {
    const renderer = await mountHook();
    await addDocument();
    await act(async () => {
      rejectUpload?.(new TypeError('Network request failed'));
      await settle();
    });

    const chip = hookApi().attachments[0];
    expect(chip?.status).toBe('error');
    expect(chip?.terminal).toBe(false);
    // The admitted key is retained for the retry, and nothing was released.
    expect(chip?.remoteKey).toBe('org/2026/08/uuid/doc.pdf');
    expect(hoisted.releasePendingUploads).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('releases the prior admitted key before re-presigning on Retry', async () => {
    const renderer = await mountHook();
    await addDocument();
    await act(async () => {
      rejectUpload?.(new TypeError('Network request failed'));
      await settle();
    });
    const chip = hookApi().attachments[0];
    const id = chip?.id;
    if (!id) {
      throw new Error('attachment id missing');
    }
    expect(chip.remoteKey).toBe('org/2026/08/uuid/doc.pdf');
    expect(hoisted.releasePendingUploads).not.toHaveBeenCalled();

    // The retried attempt gets a fresh pending promise to resolve.
    const retried = new Promise<{ key: string }>((resolve, reject) => {
      resolveUpload = resolve;
      rejectUpload = reject;
    });
    hoisted.uploadOne.mockReturnValueOnce(retried);

    // Record how many presigns had already run when the release fires: the
    // release must precede the retry's re-presign, or the stale row is still
    // pending when the replacement row is admitted and the cap can trip.
    let presignsBeforeRelease = -1;
    hoisted.releasePendingUploads.mockImplementation(() => {
      presignsBeforeRelease = hoisted.uploadOne.mock.calls.length;
    });

    await act(async () => {
      hookApi().retryAttachment(id);
      await settle();
    });

    // One released row (the prior key) plus one fresh presign: the pending
    // count stays the same instead of growing one row per retry.
    expect(hoisted.releasePendingUploads).toHaveBeenCalledTimes(1);
    expect(hoisted.releasePendingUploads).toHaveBeenCalledWith({
      organizationId: undefined,
      objectKeys: ['org/2026/08/uuid/doc.pdf'],
    });
    expect(hoisted.uploadOne).toHaveBeenCalledTimes(2);
    expect(presignsBeforeRelease).toBe(1);

    await act(async () => {
      resolveUpload?.({ key: 'org/2026/08/uuid/doc.pdf' });
      await settle();
    });
    expect(hookApi().attachments[0]?.status).toBe('uploaded');
    expect(hookApi().attachments[0]?.remoteKey).toBe('org/2026/08/uuid/doc.pdf');
    renderer.unmount();
  });

  it('ignores a Retry tap when the chip is not in the error state', async () => {
    const renderer = await mountHook();
    await addDocument();
    await act(async () => {
      resolveUpload?.({ key: 'org/2026/08/uuid/doc.pdf' });
      await settle();
    });
    const id = hookApi().attachments[0]?.id;
    if (!id) {
      throw new Error('attachment id missing');
    }
    const presigns = hoisted.uploadOne.mock.calls.length;

    await act(async () => {
      hookApi().retryAttachment(id);
      await settle();
    });

    // A successful chip is not retryable: Retry must not presign again.
    expect(hoisted.uploadOne.mock.calls.length).toBe(presigns);
    renderer.unmount();
  });

  it('releases every admitted key on leave via releaseUnclaimedUploads', async () => {
    const renderer = await mountHook();
    await addDocument();
    await act(async () => {
      resolveUpload?.({ key: 'org/2026/08/uuid/doc.pdf' });
      await settle();
    });

    await act(async () => {
      hookApi().releaseUnclaimedUploads();
      await settle();
    });

    expect(hoisted.releasePendingUploads).toHaveBeenCalledTimes(1);
    expect(hoisted.releasePendingUploads).toHaveBeenCalledWith({
      organizationId: undefined,
      objectKeys: ['org/2026/08/uuid/doc.pdf'],
    });
    renderer.unmount();
  });
});
