import { describe, expect, it } from 'vitest';

import { canAddAttachments, classifyAttachment } from './validate';

describe('classifyAttachment', () => {
  it('accepts a png by extension', () => {
    expect(classifyAttachment({ name: 'a.PNG', mimeType: 'image/png', size: 10 })).toEqual({
      ok: true,
      kind: 'image',
      extension: 'png',
    });
  });

  it('accepts a markdown file by extension', () => {
    expect(classifyAttachment({ name: 'notes.md', mimeType: 'text/markdown', size: 10 })).toEqual({
      ok: true,
      kind: 'document',
      extension: 'md',
    });
  });

  it('rejects unsupported extension', () => {
    expect(
      classifyAttachment({ name: 'a.exe', mimeType: 'application/octet-stream', size: 10 }).ok
    ).toBe(false);
  });

  it('rejects a file over the size cap', () => {
    expect(
      classifyAttachment({ name: 'a.pdf', mimeType: 'application/pdf', size: 6 * 1024 * 1024 }).ok
    ).toBe(false);
  });
});

describe('canAddAttachments', () => {
  it('allows up to 5 total', () => {
    expect(canAddAttachments(3, 2)).toEqual({ ok: true, acceptedCount: 2 });
  });

  it('truncates past 5 and reports partial', () => {
    expect(canAddAttachments(4, 3)).toEqual({ ok: true, acceptedCount: 1, truncated: true });
  });

  it('rejects when already full', () => {
    expect(canAddAttachments(5, 1)).toEqual({ ok: false, acceptedCount: 0 });
  });
});
