import { describe, it, expect } from 'vitest';
import { contentBlockSchema } from '../src/schemas';
import { ulid } from 'ulid';

describe('attachmentBlockSchema', () => {
  const goodBlock = {
    type: 'attachment',
    attachmentId: ulid(),
    mimeType: 'image/png',
    size: 12345,
    filename: 'photo.png',
  };
  it('accepts a well-formed attachment block', () => {
    expect(contentBlockSchema.safeParse(goodBlock).success).toBe(true);
  });
  it('rejects empty mimeType', () => {
    expect(contentBlockSchema.safeParse({ ...goodBlock, mimeType: '' }).success).toBe(false);
  });
  it('rejects negative size', () => {
    expect(contentBlockSchema.safeParse({ ...goodBlock, size: -1 }).success).toBe(false);
  });
  it('rejects non-ulid attachmentId', () => {
    expect(contentBlockSchema.safeParse({ ...goodBlock, attachmentId: 'not-a-ulid' }).success).toBe(
      false
    );
  });
  it('rejects filename over 512 chars', () => {
    expect(contentBlockSchema.safeParse({ ...goodBlock, filename: 'x'.repeat(513) }).success).toBe(
      false
    );
  });
  it('rejects mimeType over 255 chars', () => {
    expect(
      contentBlockSchema.safeParse({ ...goodBlock, mimeType: 'x/' + 'y'.repeat(254) }).success
    ).toBe(false);
  });
  it('rejects empty filename', () => {
    expect(contentBlockSchema.safeParse({ ...goodBlock, filename: '' }).success).toBe(false);
  });
});
