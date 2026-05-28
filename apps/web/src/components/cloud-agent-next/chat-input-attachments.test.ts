import {
  acceptedSubmissionAttachmentIdsToRemove,
  hasSubmissionAttachmentPayload,
  shouldRejectAttachedSlashCommand,
} from './chat-input-attachments';

const slashCommands = [{ trigger: 'compact' }, { trigger: 'review' }];
describe('shouldRejectAttachedSlashCommand', () => {
  it('rejects recognized slash commands before dispatch when displayed files are attached', () => {
    expect(shouldRejectAttachedSlashCommand('/compact now', slashCommands, true)).toBe(true);
  });

  it('allows normal prompts, unknown slash text, and commands without files', () => {
    expect(shouldRejectAttachedSlashCommand('summarize this', slashCommands, true)).toBe(false);
    expect(shouldRejectAttachedSlashCommand('/unknown', slashCommands, true)).toBe(false);
    expect(shouldRejectAttachedSlashCommand('/review', slashCommands, false)).toBe(false);
  });
});

describe('acceptedSubmissionAttachmentIdsToRemove', () => {
  const submittedAttachment = {
    id: 'submitted-pdf',
    status: 'complete',
    r2Key: 'prompts/file.pdf',
  };
  const failedAttachment = { id: 'failed-image', status: 'error' };

  it('preserves submitted files when delivery is not accepted', () => {
    expect(acceptedSubmissionAttachmentIdsToRemove([submittedAttachment], false)).toEqual([]);
  });

  it('removes only complete keyed files represented in an accepted submission', () => {
    const attachmentsAtSubmission = [submittedAttachment, failedAttachment];
    const filesVisibleAfterSendStarts = [...attachmentsAtSubmission, { id: 'added-during-send' }];
    const removalIds = acceptedSubmissionAttachmentIdsToRemove(attachmentsAtSubmission, true);

    expect(filesVisibleAfterSendStarts.filter(file => !removalIds.includes(file.id))).toEqual([
      failedAttachment,
      { id: 'added-during-send' },
    ]);
  });
});

describe('hasSubmissionAttachmentPayload', () => {
  it('requires an admission lock while a send includes an attachment payload', () => {
    expect(hasSubmissionAttachmentPayload({ files: ['file.pdf'] })).toBe(true);
  });

  it('does not lock sends without an attachment payload', () => {
    expect(hasSubmissionAttachmentPayload(undefined)).toBe(false);
    expect(hasSubmissionAttachmentPayload({ files: [] })).toBe(false);
  });
});
