import { describe, expect, it } from 'vitest';

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
// Tests import pure helpers from their owning module (not the hook barrel).

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

describe('size limits (5 MB / 5 files) — constant parity', () => {
  it('exposes the 5 MB constant for both web and mobile parity', () => {
    expect(AGENT_ATTACHMENT_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});
