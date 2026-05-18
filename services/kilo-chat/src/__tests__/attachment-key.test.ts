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
});
