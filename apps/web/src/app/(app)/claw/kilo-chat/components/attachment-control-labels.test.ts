import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const messageInputSource = readFileSync(join(__dirname, 'MessageInput.tsx'), 'utf8');
const attachmentPreviewChipSource = readFileSync(
  join(__dirname, 'AttachmentPreviewChip.tsx'),
  'utf8'
);

describe('attachment icon controls', () => {
  it('labels the attach files button', () => {
    expect(messageInputSource).toContain('aria-label="Attach files"');
  });

  it('labels retry and remove controls with the filename', () => {
    expect(attachmentPreviewChipSource).toContain(
      'aria-label={`Retry upload for ${row.filename}`}'
    );
    expect(attachmentPreviewChipSource).toContain('aria-label={`Remove ${row.filename}`}');
  });
});
