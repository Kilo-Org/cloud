import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const messageBubbleSource = readFileSync(join(__dirname, 'MessageBubble.tsx'), 'utf8');
const messageAttachmentSource = readFileSync(join(__dirname, 'MessageAttachment.tsx'), 'utf8');

describe('message bubble edit layout', () => {
  const editBranchStart = messageBubbleSource.indexOf(') : isEditing ? (');
  const editBranchEnd = messageBubbleSource.indexOf(') : isDeleting ? (', editBranchStart);
  const editBranchSource = messageBubbleSource.slice(editBranchStart, editBranchEnd);

  it('renders editable attachments before the edit action toolbar', () => {
    const attachmentList = messageBubbleSource.indexOf('{renderAttachmentList', editBranchStart);
    const saveButton = messageBubbleSource.indexOf('Save (Enter)', editBranchStart);

    expect(editBranchStart).toBeGreaterThanOrEqual(0);
    expect(attachmentList).toBeGreaterThan(editBranchStart);
    expect(saveButton).toBeGreaterThan(attachmentList);
  });

  it('aligns edit actions to the end of the message bubble', () => {
    expect(editBranchSource).toContain('justify-end');
    expect(editBranchSource).not.toContain('mt-1 flex items-center gap-1');
  });
});

describe('message attachment remove buttons', () => {
  it('uses explicit foreground color instead of inheriting from the message bubble', () => {
    expect(messageAttachmentSource).toContain('text-foreground');
  });

  it('uses icon remove affordances instead of unstyled text glyphs', () => {
    const multiplicationSign = String.fromCharCode(215);
    expect(messageAttachmentSource).not.toContain(`>${multiplicationSign}</button>`);
  });
});

describe('message attachment download URLs', () => {
  it('does not fetch file attachment URLs before click', () => {
    expect(messageAttachmentSource).toContain('{ enabled: isImage && !imageLoaded }');
    expect(messageAttachmentSource).not.toContain('url={data?.url}');
  });

  it('opens and downloads attachments through explicit refetches', () => {
    expect(messageAttachmentSource).toContain('const result = await refetch();');
    expect(messageAttachmentSource).toContain('onOpen={handleImageOpen}');
    expect(messageAttachmentSource).toContain('onDownload={handleFileDownload}');
  });

  it('reuses cached download URLs until they expire', () => {
    expect(messageAttachmentSource).toContain('isAttachmentUrlValid(data.expiresAt, Date.now())');
    expect(messageAttachmentSource).toContain('return data.url;');
  });
});
