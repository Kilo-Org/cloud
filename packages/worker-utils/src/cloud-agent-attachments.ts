import { z } from 'zod';

export const CLOUD_AGENT_ATTACHMENT_DENIED_EXTENSIONS = [
  'exe',
  'dll',
  'msi',
  'com',
  'scr',
  'apk',
  'ipa',
  'dmg',
  'pkg',
] as const;

const deniedExtensions = new Set<string>(CLOUD_AGENT_ATTACHMENT_DENIED_EXTENSIONS);

export const attachmentFilenameSchema = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.[a-z0-9]{1,16}$/,
    'Attachment filename must be a UUID with a 1-16 character lowercase alphanumeric extension'
  )
  .superRefine((filename, ctx) => {
    const suffix = filename.slice(filename.lastIndexOf('.') + 1);
    if (deniedExtensions.has(suffix)) {
      ctx.addIssue({ code: 'custom', message: `Attachment extension "${suffix}" is not allowed` });
    }
  });

export const AttachmentsSchema = z.object({
  path: z.uuid(),
  files: z.array(attachmentFilenameSchema).min(1).max(5),
});
