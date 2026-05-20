import { describe, expect, it } from 'vitest';

import {
  buildReplyToMessageSnapshot,
  contentBlocksPreviewText,
  decodeConversationCursor,
  encodeConversationCursor,
} from '../src/utils';

const VALID_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('conversation cursor helpers', () => {
  it('round-trips a valid conversation cursor', () => {
    const cursor = { t: 1_700_000_000_000, c: VALID_ULID };

    expect(decodeConversationCursor(encodeConversationCursor(cursor))).toEqual(cursor);
  });

  it('rejects cursors with negative timestamps', () => {
    const encoded = encodeConversationCursor({ t: -1, c: VALID_ULID });

    expect(decodeConversationCursor(encoded)).toBeNull();
  });

  it('rejects cursors with non-ULID tie-breakers', () => {
    const encoded = encodeConversationCursor({ t: 1_700_000_000_000, c: 'not-a-ulid' });

    expect(decodeConversationCursor(encoded)).toBeNull();
  });
});

describe('contentBlocksPreviewText', () => {
  it('returns joined text when present', () => {
    expect(contentBlocksPreviewText([{ type: 'text', text: 'hello world' }])).toBe('hello world');
  });

  it('falls back to attachment filenames when no text', () => {
    expect(
      contentBlocksPreviewText([
        { type: 'attachment', filename: 'a.png', mimeType: 'image/png' },
        { type: 'attachment', filename: 'doc.pdf', mimeType: 'application/pdf' },
      ])
    ).toBe('a.png, doc.pdf');
  });

  it('uses mime-typed descriptor when filename missing', () => {
    expect(contentBlocksPreviewText([{ type: 'attachment', mimeType: 'image/png' }])).toBe('Image');
    expect(contentBlocksPreviewText([{ type: 'attachment', mimeType: 'application/pdf' }])).toBe(
      'Attachment'
    );
  });

  it('returns empty string when no text or attachments', () => {
    expect(contentBlocksPreviewText([])).toBe('');
  });
});

describe('buildReplyToMessageSnapshot', () => {
  const messageId = '01ARZ3NDEKTSV4RRFFQ69G5FB1';

  it('uses attachment filenames as previewText for an attachment-only parent', () => {
    const snap = buildReplyToMessageSnapshot(messageId, {
      senderId: 'user-1',
      deleted: false,
      content: [{ type: 'attachment', filename: 'photo.png', mimeType: 'image/png' }],
    });
    expect(snap.previewText).toBe('photo.png');
  });

  it('preserves text previewText when text is present', () => {
    const snap = buildReplyToMessageSnapshot(messageId, {
      senderId: 'user-1',
      deleted: false,
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(snap.previewText).toBe('hello');
  });
});
