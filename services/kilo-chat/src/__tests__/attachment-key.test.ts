import { describe, it, expect } from 'vitest';
import { buildAttachmentR2Key } from '../util/attachment-key';

describe('buildAttachmentR2Key', () => {
  it('builds prod key without prefix', () => {
    expect(
      buildAttachmentR2Key({
        keyPrefix: '',
        conversationId: 'CONV',
        uploaderId: 'U',
        attachmentId: 'A',
      })
    ).toBe('attachments/CONV/U/A');
  });

  it('applies dev prefix', () => {
    expect(
      buildAttachmentR2Key({
        keyPrefix: 'dev/',
        conversationId: 'CONV',
        uploaderId: 'U',
        attachmentId: 'A',
      })
    ).toBe('dev/attachments/CONV/U/A');
  });

  it('does not double-slash if prefix ends with /', () => {
    expect(
      buildAttachmentR2Key({
        keyPrefix: 'dev/',
        conversationId: 'C',
        uploaderId: 'U',
        attachmentId: 'A',
      })
    ).not.toMatch(/\/\//);
  });

  it('throws on empty conversationId', () => {
    expect(() =>
      buildAttachmentR2Key({
        keyPrefix: '',
        conversationId: '',
        uploaderId: 'U',
        attachmentId: 'A',
      })
    ).toThrow();
  });

  it('sanitizes slashes in an id segment so it cannot escape its slot', () => {
    const key = buildAttachmentR2Key({
      keyPrefix: '',
      conversationId: 'CONV',
      uploaderId: '../other-user',
      attachmentId: 'A',
    });
    // `/` is percent-encoded; the key still has exactly three segments after
    // `attachments/`.
    expect(key).toBe('attachments/CONV/..%2Fother-user/A');
    expect(key.split('/').length).toBe(4);
  });

  it('percent-encodes backslashes, control characters, and whitespace', () => {
    const key = buildAttachmentR2Key({
      keyPrefix: '',
      conversationId: 'CONV',
      uploaderId: 'a\\b\nc d',
      attachmentId: 'A',
    });
    expect(key).toBe('attachments/CONV/a%5Cb%0Ac%20d/A');
  });

  it('leaves ULID-shaped ids unchanged', () => {
    const ulid = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const key = buildAttachmentR2Key({
      keyPrefix: '',
      conversationId: ulid,
      uploaderId: ulid,
      attachmentId: ulid,
    });
    expect(key).toBe(`attachments/${ulid}/${ulid}/${ulid}`);
  });
});
