import type { SlashCommand } from '@/lib/cloud-agent/slash-commands';

type SubmissionAttachment = {
  id: string;
  status: string;
  r2Key?: string;
};

type SubmissionAttachmentsPayload = {
  files: string[];
};

export function hasSubmissionAttachmentPayload(
  attachments: SubmissionAttachmentsPayload | undefined
): boolean {
  return Boolean(attachments && attachments.files.length > 0);
}

export function acceptedSubmissionAttachmentIdsToRemove(
  submittedAttachments: SubmissionAttachment[],
  accepted: boolean
): string[] {
  if (!accepted) return [];

  return submittedAttachments
    .filter(attachment => attachment.status === 'complete' && Boolean(attachment.r2Key))
    .map(attachment => attachment.id);
}

export function getChatInputPresentationCommands(
  slashCommands: SlashCommand[],
  hasWorktreeAction: boolean
): SlashCommand[] {
  if (!hasWorktreeAction || slashCommands.some(command => command.trigger === 'new')) {
    return slashCommands;
  }

  return [
    ...slashCommands,
    {
      trigger: 'new',
      label: 'New chat',
      description: 'Start a new chat in this worktree',
      expansion: '',
    },
  ];
}

export function isWorktreeNewChatCommand(message: string, hasWorktreeAction: boolean): boolean {
  return hasWorktreeAction && message.trim() === '/new';
}

export function shouldRejectAttachedSlashCommand(
  message: string,
  slashCommands: Pick<SlashCommand, 'trigger'>[],
  hasAttachments: boolean,
  isWorktreeChatCommand = false
): boolean {
  if (!hasAttachments) return false;
  if (isWorktreeChatCommand) return true;

  const slashMatch = /^\s*\/([\w.-]+)(?:\s+([\s\S]*))?\s*$/.exec(message.trim());
  return Boolean(slashMatch && slashCommands.some(command => command.trigger === slashMatch[1]));
}
