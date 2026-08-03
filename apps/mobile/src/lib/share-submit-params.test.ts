import { describe, expect, it } from 'vitest';

import { type AgentAttachment } from '@/lib/agent-attachments/agent-attachment-types';
import { buildComposerSharePayload } from '@/lib/share-submit-params';

function attachment(overrides: Partial<AgentAttachment> = {}): AgentAttachment {
  return {
    id: 'att-1',
    filename: 'report.pdf',
    localUri: 'file:///tmp/report.pdf',
    mimeType: 'application/pdf',
    size: 1024,
    status: 'uploaded',
    kind: 'document',
    extension: 'pdf',
    progress: null,
    ...overrides,
  };
}

describe('buildComposerSharePayload', () => {
  it('returns null for empty text and zero attachments', () => {
    expect(buildComposerSharePayload({ text: '', attachments: [] })).toBeNull();
  });

  it('returns null for whitespace-only text and zero attachments', () => {
    expect(buildComposerSharePayload({ text: '   ', attachments: [] })).toBeNull();
  });

  it('returns the trimmed text', () => {
    const result = buildComposerSharePayload({ text: '  hello  ', attachments: [] });
    expect(result?.text).toBe('hello');
    expect(result?.files).toHaveLength(0);
  });

  it('maps filename, localUri, mimeType and size onto the candidate', () => {
    const result = buildComposerSharePayload({
      text: 'check this',
      attachments: [attachment()],
    });
    expect(result?.files).toHaveLength(1);
    expect(result?.files[0]?.name).toBe('report.pdf');
    expect(result?.files[0]?.uri).toBe('file:///tmp/report.pdf');
    expect(result?.files[0]?.mimeType).toBe('application/pdf');
    expect(result?.files[0]?.size).toBe(1024);
  });

  it('keeps an attachment whose status is error', () => {
    const result = buildComposerSharePayload({
      text: 'x',
      attachments: [attachment({ status: 'error', id: 'bad' })],
    });
    expect(result?.files).toHaveLength(1);
  });

  it('returns a payload for attachments-only input', () => {
    const result = buildComposerSharePayload({
      text: '',
      attachments: [attachment()],
    });
    expect(result?.text).toBe('');
    expect(result?.files).toHaveLength(1);
  });

  it('includes failedFiles as an empty array', () => {
    const result = buildComposerSharePayload({
      text: 'ok',
      attachments: [attachment()],
    });
    expect(result?.failedFiles).toEqual([]);
  });

  it('returns null when text trims to empty and attachments list is empty', () => {
    expect(buildComposerSharePayload({ text: '  \n\t ', attachments: [] })).toBeNull();
  });
});
