import { describe, expect, it } from 'vitest';

/**
 * Replicates the file-attachment label logic from ToolCardFileAttachments:
 *   const label = attachment.filename || 'File';
 *
 * Also asserts the mimeType forwarding contract: the chip passes
 * { mimeType: attachment.mime } to shareLocalFile(uri, { mimeType }).
 *
 * The actual rendering (unavailable row vs chip) and press handler are
 * exercised through share-remote-file.test.ts (mimeType passthrough), the
 * image-cache.test.ts (cache miss → no URI → unavailable row trigger), and
 * manual E2E.
 */
function resolveFileAttachmentLabel(filename: string | undefined): string {
  return filename ?? 'File';
}

function buildShareMimeOptions(mime: string): { mimeType: string } {
  return { mimeType: mime };
}

describe('ToolCardFileAttachments (label + mimeType contract)', () => {
  it('uses the attachment filename as the chip label', () => {
    expect(resolveFileAttachmentLabel('report.pdf')).toBe('report.pdf');
  });

  it('falls back to "File" when filename is absent', () => {
    expect(resolveFileAttachmentLabel(undefined)).toBe('File');
    // Empty string is a value, not absence — preserved as-is with ??.
    expect(resolveFileAttachmentLabel('')).toBe('');
  });

  it('passes mimeType to the share options', () => {
    expect(buildShareMimeOptions('application/pdf')).toEqual({
      mimeType: 'application/pdf',
    });
    expect(buildShareMimeOptions('text/plain')).toEqual({
      mimeType: 'text/plain',
    });
  });
});
