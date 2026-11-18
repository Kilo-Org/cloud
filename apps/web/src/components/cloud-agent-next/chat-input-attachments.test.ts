import type { SlashCommand } from '@/lib/cloud-agent/slash-commands';
import {
  acceptedSubmissionAttachmentIdsToRemove,
  getChatInputPresentationCommands,
  hasSubmissionAttachmentPayload,
  isWorktreeNewChatCommand,
  shouldRejectAttachedSlashCommand,
} from './chat-input-attachments';

const slashCommands: SlashCommand[] = [
  { trigger: 'compact', label: 'Compact', description: 'Compact the conversation', expansion: '' },
  { trigger: 'review', label: 'Review', description: 'Review changes', expansion: '' },
];

describe('getChatInputPresentationCommands', () => {
  const newChatCommand: SlashCommand = {
    trigger: 'new',
    label: 'New chat',
    description: 'Start a new chat in this worktree',
    expansion: '',
  };

  it.each([
    { name: 'populated', commands: slashCommands },
    { name: 'empty', commands: [] },
  ])('adds /new to a $name catalog when a worktree action is available', ({ commands }) => {
    expect(getChatInputPresentationCommands(commands, true)).toEqual([...commands, newChatCommand]);
  });

  it.each([
    { name: 'populated', commands: slashCommands },
    { name: 'empty', commands: [] },
  ])('preserves a $name catalog without a worktree action', ({ commands }) => {
    const originalCommands = commands.map(command => ({ ...command }));

    expect(getChatInputPresentationCommands(commands, false)).toEqual(originalCommands);
    expect(commands).toEqual(originalCommands);
  });

  it('preserves an existing /new command without duplicating or replacing it', () => {
    const existingNewCommand: SlashCommand = {
      trigger: 'new',
      label: 'Existing new',
      description: 'Existing command',
      expansion: 'Keep me',
    };
    const commands = [...slashCommands, existingNewCommand];

    expect(getChatInputPresentationCommands(commands, true)).toEqual([
      ...slashCommands,
      existingNewCommand,
    ]);
  });

  it('leaves the backend catalog unchanged for recognition and attachment checks', () => {
    const commands = slashCommands.map(command => ({ ...command }));
    const presentationCommands = getChatInputPresentationCommands(commands, true);

    expect(presentationCommands).not.toBe(commands);
    expect(commands).toEqual(slashCommands);
    for (const message of ['/new extra', '/newer', '/NEW']) {
      expect(shouldRejectAttachedSlashCommand(message, commands, true)).toBe(false);
    }
  });
});

describe('isWorktreeNewChatCommand', () => {
  it('intercepts only exact trimmed lowercase /new for a grouped web session', () => {
    expect(isWorktreeNewChatCommand('/new', true)).toBe(true);
    expect(isWorktreeNewChatCommand('  /new\n', true)).toBe(true);
    expect(isWorktreeNewChatCommand('/new extra', true)).toBe(false);
    expect(isWorktreeNewChatCommand('/newer', true)).toBe(false);
    expect(isWorktreeNewChatCommand('/NEW', true)).toBe(false);
  });

  it('preserves ordinary slash dispatch for sessions without a worktree action', () => {
    expect(isWorktreeNewChatCommand('/new', false)).toBe(false);
  });
});

describe('shouldRejectAttachedSlashCommand', () => {
  it('rejects recognized slash commands before dispatch when displayed files are attached', () => {
    expect(shouldRejectAttachedSlashCommand('/compact now', slashCommands, true)).toBe(true);
  });

  it('rejects worktree creation with attachments even when /new is absent from the command catalog', () => {
    expect(shouldRejectAttachedSlashCommand('/new', slashCommands, true, true)).toBe(true);
    expect(shouldRejectAttachedSlashCommand('/new', slashCommands, false, true)).toBe(false);
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
