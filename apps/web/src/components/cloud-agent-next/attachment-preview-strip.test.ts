import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const attachmentPreviewStripSource = readFileSync(
  join(__dirname, 'AttachmentPreviewStrip.tsx'),
  'utf8'
);

describe('attachment preview strip accessibility', () => {
  it('announces upload errors without making progress updates live', () => {
    const errorStatusStart = attachmentPreviewStripSource.indexOf(
      "if (attachment.status === 'error')"
    );
    const uploadingStatusStart = attachmentPreviewStripSource.indexOf(
      "if (attachment.status === 'uploading')"
    );
    const uploadingStatusEnd = attachmentPreviewStripSource.indexOf(
      'return null;',
      uploadingStatusStart
    );
    const errorStatusSource = attachmentPreviewStripSource.slice(
      errorStatusStart,
      uploadingStatusStart
    );
    const uploadingStatusSource = attachmentPreviewStripSource.slice(
      uploadingStatusStart,
      uploadingStatusEnd
    );

    expect(attachmentPreviewStripSource).not.toContain('aria-live=');
    expect(uploadingStatusSource).not.toContain('role="status"');
    expect(errorStatusSource).toContain('role="status"');
    expect(errorStatusSource).toContain("Upload failed: {attachment.error ?? 'Try again.'}");
  });

  it('renders documents as thumbnail-sized tiles with full-name tooltips', () => {
    expect(attachmentPreviewStripSource).toContain(
      "'border-border bg-muted/30 relative flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border p-1'"
    );
    expect(attachmentPreviewStripSource).toContain(
      '<TooltipContent side="top" className="max-w-xs break-all text-xs">'
    );
    expect(attachmentPreviewStripSource).toContain('tabIndex={0}');
  });

  it('extends both compact remove controls hit targets', () => {
    expect(
      attachmentPreviewStripSource.match(
        /className="absolute top-1 right-1 h-7 w-7 rounded-md before:absolute before:-inset-2"/g
      )
    ).toHaveLength(2);
  });
});
