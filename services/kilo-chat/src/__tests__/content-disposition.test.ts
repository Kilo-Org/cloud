import { describe, it, expect } from 'vitest';
import { attachmentContentDisposition } from '../util/content-disposition';

describe('attachmentContentDisposition', () => {
  it('emits ASCII filename= and UTF-8 filename*= for a plain name', () => {
    expect(attachmentContentDisposition('hello.txt')).toBe(
      `attachment; filename="hello.txt"; filename*=UTF-8''hello.txt`
    );
  });

  it('preserves the original via filename*= and substitutes non-ASCII in the fallback', () => {
    const v = attachmentContentDisposition('résumé.pdf');
    expect(v).toContain(`filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`);
    // Fallback ASCII has the non-ASCII chars replaced with `?`
    expect(v).toContain('filename="r?sum?.pdf"');
  });

  it('strips control chars, backslashes, and quotes from the fallback', () => {
    const v = attachmentContentDisposition('he\\llo"\nworld.txt');
    // Backslash, quote, and newline are stripped entirely.
    expect(v).toContain('filename="helloworld.txt"');
    // The encoded form preserves the original; control chars become %xx.
    expect(v).toContain(`filename*=UTF-8''`);
  });

  it('falls back to "download" when the fallback would be empty', () => {
    expect(attachmentContentDisposition('  ')).toContain('filename="download"');
  });
});
