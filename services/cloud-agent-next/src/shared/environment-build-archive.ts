import { z } from 'zod';
import { rootfsArchiveDescriptorSchema } from './rootfs-archive.js';

export const environmentBuildArchiveUploadSchema = z
  .object({
    url: z.url().max(16_384),
    headers: z
      .object({
        'content-type': z.literal('application/x-tar'),
        'if-none-match': z.literal('*'),
        'x-amz-checksum-sha256': z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
      })
      .strict(),
  })
  .strict();
export type EnvironmentBuildArchiveUpload = z.infer<typeof environmentBuildArchiveUploadSchema>;
export const environmentBuildArchiveRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prepare'), descriptor: rootfsArchiveDescriptorSchema }).strict(),
  z.object({ action: z.literal('complete') }).strict(),
]);
export type EnvironmentBuildArchiveRequest = z.infer<typeof environmentBuildArchiveRequestSchema>;
