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

export function shouldRejectAttachedSlashCommand(
  message: string,
  slashCommands: Pick<SlashCommand, 'trigger'>[],
  hasAttachments: boolean
): boolean {
  if (!hasAttachments) return false;

  const slashMatch = /^\s*\/([\w.-]+)(?:\s+([\s\S]*))?\s*$/.exec(message.trim());
  return Boolean(slashMatch && slashCommands.some(command => command.trigger === slashMatch[1]));
}
