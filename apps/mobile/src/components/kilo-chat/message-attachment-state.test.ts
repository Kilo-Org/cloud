import { describe, expect, it } from 'vitest';

import {
  buildAttachmentLimitToast,
  buildAttachmentSizeRejectionToast,
  getAttachmentActionSheetConfig,
  isImageMimeType,
  MOBILE_ATTACHMENT_MAX_BYTES,
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

  it('accepts a file at the mobile byte boundary', () => {
    const attachment = normalizeAttachmentSelection({
      uri: 'file:///boundary.bin',
      name: 'boundary.bin',
      mimeType: 'application/octet-stream',
      size: MOBILE_ATTACHMENT_MAX_BYTES,
    });

    const result = selectAllowedAttachments({
      existingCount: 0,
      selected: [attachment],
    });

    expect(result.accepted).toEqual([attachment]);
    expect(result.rejected).toEqual([]);
    expect(result.truncatedCount).toBe(0);
    expect(result.toast).toBeUndefined();
  });

  it('rejects a file above the mobile byte boundary with exact toast copy', () => {
    const attachment = normalizeAttachmentSelection({
      uri: 'file:///huge.bin',
      name: 'huge.bin',
      mimeType: 'application/octet-stream',
      size: MOBILE_ATTACHMENT_MAX_BYTES + 1,
    });

    const result = selectAllowedAttachments({
      existingCount: 0,
      selected: [attachment],
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      {
        attachment,
        reason: 'too-large',
        toast: 'huge.bin exceeds the 10 MB attachment limit.',
      },
    ]);
    expect(result.truncatedCount).toBe(0);
    expect(result.toast).toBe('huge.bin exceeds the 10 MB attachment limit.');
    expect(buildAttachmentSizeRejectionToast('huge.bin')).toBe(
      'huge.bin exceeds the 10 MB attachment limit.'
    );
    expect(buildAttachmentLimitToast()).toBe('You can attach up to 10 files.');
  });

  it('accepts small files and rejects oversized files in the same selection', () => {
    const small = normalizeAttachmentSelection({
      uri: 'file:///small.txt',
      name: 'small.txt',
      mimeType: 'text/plain',
      size: 12,
    });
    const huge = normalizeAttachmentSelection({
      uri: 'file:///huge.bin',
      name: 'huge.bin',
      mimeType: 'application/octet-stream',
      size: MOBILE_ATTACHMENT_MAX_BYTES + 1,
    });

    const result = selectAllowedAttachments({
      existingCount: 0,
      selected: [small, huge],
    });

    expect(result.accepted).toEqual([small]);
    expect(result.rejected).toEqual([
      {
        attachment: huge,
        reason: 'too-large',
        toast: 'huge.bin exceeds the 10 MB attachment limit.',
      },
    ]);
    expect(result.truncatedCount).toBe(0);
    expect(result.toast).toBe('huge.bin exceeds the 10 MB attachment limit.');
  });

  it('truncates selections to ten attachments and returns toast copy', () => {
    const selected = [
      normalizeAttachmentSelection({
        uri: 'file:///a.txt',
        name: 'a.txt',
        mimeType: 'text/plain',
        size: 12,
      }),
      normalizeAttachmentSelection({
        uri: 'file:///b.txt',
        name: 'b.txt',
        mimeType: 'text/plain',
        size: 12,
      }),
    ];

    const result = selectAllowedAttachments({
      existingCount: 9,
      selected,
    });

    expect(result.accepted).toEqual([selected[0]]);
    expect(result.rejected).toEqual([]);
    expect(result.truncatedCount).toBe(1);
    expect(result.toast).toBe('You can attach up to 10 files.');
  });

  it('prefers size rejection toast over capacity toast when both apply', () => {
    const huge = normalizeAttachmentSelection({
      uri: 'file:///huge.bin',
      name: 'huge.bin',
      mimeType: 'application/octet-stream',
      size: MOBILE_ATTACHMENT_MAX_BYTES + 1,
    });
    const a = normalizeAttachmentSelection({
      uri: 'file:///a.txt',
      name: 'a.txt',
      mimeType: 'text/plain',
      size: 12,
    });
    const b = normalizeAttachmentSelection({
      uri: 'file:///b.txt',
      name: 'b.txt',
      mimeType: 'text/plain',
      size: 12,
    });

    const result = selectAllowedAttachments({
      existingCount: 9,
      selected: [huge, a, b],
    });

    expect(result.accepted).toEqual([a]);
    expect(result.rejected).toEqual([
      {
        attachment: huge,
        reason: 'too-large',
        toast: 'huge.bin exceeds the 10 MB attachment limit.',
      },
    ]);
    expect(result.truncatedCount).toBe(1);
    expect(result.toast).toBe('huge.bin exceeds the 10 MB attachment limit.');
  });

  it('rejects unknown or zero size as unreadable', () => {
    const unknownSize = normalizeAttachmentSelection({
      uri: 'file:///mystery.bin',
      name: 'mystery.bin',
      mimeType: 'application/octet-stream',
    });
    const nullSize = normalizeAttachmentSelection({
      uri: 'file:///mystery.bin',
      name: 'mystery.bin',
      mimeType: 'application/octet-stream',
      size: null,
    });
    const zeroSize = normalizeAttachmentSelection({
      uri: 'file:///mystery.bin',
      name: 'mystery.bin',
      mimeType: 'application/octet-stream',
      size: 0,
    });

    for (const attachment of [unknownSize, nullSize, zeroSize]) {
      const result = selectAllowedAttachments({
        existingCount: 0,
        selected: [attachment],
      });

      expect(result.accepted).toEqual([]);
      expect(result.rejected).toEqual([
        {
          attachment,
          reason: 'unreadable',
          toast: "Couldn't read mystery.bin.",
        },
      ]);
      expect(result.truncatedCount).toBe(0);
      expect(result.toast).toBe("Couldn't read mystery.bin.");
    }
  });
});
