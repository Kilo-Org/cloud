import { ATTACHMENT_MAX_BYTES } from '@kilocode/kilo-chat';
import { describe, expect, it } from 'vitest';

import {
  addFilesWithinAttachmentCapacity,
  buildAttachmentLimitToast,
  buildAttachmentSizeRejectionToast,
  getAttachmentActionSheetConfig,
  isImageMimeType,
  normalizeAttachmentSelection,
  selectAllowedAttachments,
} from './message-attachment-state';

describe('message attachment state helpers', () => {
  it('builds native action sheet options with cancel metadata', () => {
    expect(getAttachmentActionSheetConfig()).toEqual({
      options: ['Take photo', 'Photo library', 'Files', 'Cancel'],
      cancelButtonIndex: 3,
    });
  });

  it('normalizes image picker and document picker metadata with fallbacks', () => {
    expect(
      normalizeAttachmentSelection({
        uri: 'file:///tmp/camera%20roll/photo.jpg',
        fileName: null,
        mimeType: 'image/jpeg',
        fileSize: 2048,
      })
    ).toEqual({
      uri: 'file:///tmp/camera%20roll/photo.jpg',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: 2048,
      isImage: true,
    });

    expect(
      normalizeAttachmentSelection({
        uri: 'file:///tmp/download',
        name: '',
        mimeType: null,
        size: null,
      })
    ).toEqual({
      uri: 'file:///tmp/download',
      filename: 'Attachment',
      mimeType: 'application/octet-stream',
      size: 0,
      isImage: false,
    });
  });

  it('detects image attachments from MIME type only', () => {
    expect(isImageMimeType('image/png')).toBe(true);
    expect(isImageMimeType('image/svg+xml')).toBe(true);
    expect(isImageMimeType('application/pdf')).toBe(false);
    expect(isImageMimeType(undefined)).toBe(false);
  });

  it('truncates selections to ten attachments and returns toast copy', () => {
    const existing = Array.from({ length: 8 }, (_value, index) =>
      normalizeAttachmentSelection({
        uri: `file:///existing-${index}.txt`,
        name: `existing-${index}.txt`,
        mimeType: 'text/plain',
        size: 1,
      })
    );
    const selected = Array.from({ length: 4 }, (_value, index) => ({
      uri: `file:///selected-${index}.txt`,
      name: `selected-${index}.txt`,
      mimeType: 'text/plain',
      size: 1,
    }));

    expect(selectAllowedAttachments({ existing, selected })).toEqual({
      accepted: [
        normalizeAttachmentSelection({
          uri: 'file:///selected-0.txt',
          name: 'selected-0.txt',
          mimeType: 'text/plain',
          size: 1,
        }),
        normalizeAttachmentSelection({
          uri: 'file:///selected-1.txt',
          name: 'selected-1.txt',
          mimeType: 'text/plain',
          size: 1,
        }),
      ],
      rejected: [],
      truncatedCount: 2,
      toast: 'You can attach up to 10 files.',
    });
  });

  it('rejects oversized files using the shared byte limit in the toast copy', () => {
    const result = selectAllowedAttachments({
      existing: [],
      selected: [
        {
          uri: 'file:///large.mov',
          name: 'large.mov',
          mimeType: 'video/quicktime',
          size: ATTACHMENT_MAX_BYTES + 1,
        },
        {
          uri: 'file:///small.txt',
          name: 'small.txt',
          mimeType: 'text/plain',
          size: 12,
        },
      ],
    });

    expect(result.accepted).toEqual([
      {
        uri: 'file:///small.txt',
        filename: 'small.txt',
        mimeType: 'text/plain',
        size: 12,
        isImage: false,
      },
    ]);
    expect(result.rejected).toEqual([
      {
        attachment: {
          uri: 'file:///large.mov',
          filename: 'large.mov',
          mimeType: 'video/quicktime',
          size: ATTACHMENT_MAX_BYTES + 1,
          isImage: false,
        },
        reason: 'too-large',
        toast: 'large.mov exceeds the 100 MB attachment limit.',
      },
    ]);
    expect(result.truncatedCount).toBe(0);
    expect(result.toast).toBe('large.mov exceeds the 100 MB attachment limit.');
    expect(buildAttachmentSizeRejectionToast('large.mov')).toBe(
      'large.mov exceeds the 100 MB attachment limit.'
    );
    expect(buildAttachmentLimitToast()).toBe('You can attach up to 10 files.');
  });

  it('only consumes attachment capacity when the queue accepts a selected file', () => {
    const addFileCalls: string[] = [];
    const acceptedFiles: { filename: string; tempId: string }[] = [];
    let limitToastCount = 0;

    addFilesWithinAttachmentCapacity({
      inputs: [{ filename: 'large.mov' }, { filename: 'small.txt' }],
      capacity: 1,
      addFile: input => {
        addFileCalls.push(input.filename);
        return input.filename === 'large.mov' ? null : `temp-${input.filename}`;
      },
      onAcceptedFile: (input, tempId) => {
        acceptedFiles.push({ filename: input.filename, tempId });
      },
      onLimitExceeded: () => {
        limitToastCount += 1;
      },
    });

    expect(addFileCalls).toEqual(['large.mov', 'small.txt']);
    expect(acceptedFiles).toEqual([{ filename: 'small.txt', tempId: 'temp-small.txt' }]);
    expect(limitToastCount).toBe(0);
  });
});
