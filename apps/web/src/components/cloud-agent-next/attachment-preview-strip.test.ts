import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CloudAgentAttachmentFile } from '@/hooks/useCloudAgentAttachmentUpload';
import { AttachmentPreviewStrip } from './AttachmentPreviewStrip';

function createFile(name: string, type: string) {
  return new File(['attachment'], name, { type });
}

function renderStrip(attachments: CloudAgentAttachmentFile[]) {
  return renderToStaticMarkup(
    React.createElement(AttachmentPreviewStrip, {
      attachments,
      onRemove: () => undefined,
    })
  );
}

describe('attachment preview strip accessibility', () => {
  it('renders a labelled document preview with a focusable filename and named remove control', () => {
    const html = renderStrip([
      {
        id: 'notes',
        file: createFile('meeting-notes-for-launch.md', 'text/markdown'),
        contentType: 'text/markdown',
        kind: 'document',
        status: 'complete',
        progress: 100,
      },
    ]);

    expect(html).toContain('aria-label="Attached files"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('meeting-notes-for-launch.md');
    expect(html).toContain('aria-label="Remove meeting-notes-for-launch.md"');
  });

  it('renders an image preview with filename alternative text and a named remove control', () => {
    const html = renderStrip([
      {
        id: 'diagram',
        file: createFile('architecture-diagram.png', 'image/png'),
        contentType: 'image/png',
        kind: 'image',
        previewUrl: 'blob:architecture-diagram',
        status: 'complete',
        progress: 100,
      },
    ]);

    expect(html).toContain('alt="architecture-diagram.png"');
    expect(html).toContain('aria-label="Remove architecture-diagram.png"');
  });

  it('presents upload errors as status announcements', () => {
    const html = renderStrip([
      {
        id: 'failed',
        file: createFile('failed-report.pdf', 'application/pdf'),
        contentType: 'application/pdf',
        kind: 'document',
        status: 'error',
        progress: 0,
        error: 'Upload interrupted.',
      },
    ]);

    expect(html).toContain('role="status"');
    expect(html).toContain('Upload failed: Upload interrupted.');
  });

  it('labels upload progress without announcing each progress update as status', () => {
    const html = renderStrip([
      {
        id: 'uploading',
        file: createFile('uploading-report.pdf', 'application/pdf'),
        contentType: 'application/pdf',
        kind: 'document',
        status: 'uploading',
        progress: 42,
      },
    ]);

    expect(html).toContain('Uploading 42%');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Uploading uploading-report.pdf"');
    expect(html).not.toContain('role="status"');
  });
});
