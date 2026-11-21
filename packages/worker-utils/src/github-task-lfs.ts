import { z } from 'zod';
import { isGitHubTaskRef } from './github-task-grant.js';

export const GITHUB_LFS_CONTENT_TYPE = 'application/vnd.git-lfs+json';
export const githubLfsObjectSchema = z
  .object({
    oid: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative().safe(),
  })
  .strict();
export type GitHubLfsObject = z.infer<typeof githubLfsObjectSchema>;

export const githubLfsDownloadBatchSchema = z
  .object({
    operation: z.literal('download'),
    transfers: z
      .array(z.string().min(1).max(64))
      .min(1)
      .max(8)
      .refine(value => value.includes('basic'))
      .optional(),
    ref: z
      .object({
        name: z
          .string()
          .min(1)
          .max(1024)
          .refine(value =>
            [...value].every(
              character => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127
            )
          ),
      })
      .strict()
      .nullable()
      .optional(),
    objects: z
      .array(githubLfsObjectSchema)
      .min(1)
      .max(100)
      .refine(value => new Set(value.map(object => object.oid)).size === value.length),
    hash_algo: z.literal('sha256').optional(),
  })
  .strict();
export type GitHubLfsDownloadBatch = z.infer<typeof githubLfsDownloadBatchSchema>;

const publicationRefSchema = z.object({ name: z.string().refine(isGitHubTaskRef) }).strict();
export const githubLfsUploadBatchSchema = githubLfsDownloadBatchSchema.extend({
  operation: z.literal('upload'),
  ref: publicationRefSchema,
});
export const githubLfsBatchSchema = z.discriminatedUnion('operation', [
  githubLfsDownloadBatchSchema,
  githubLfsUploadBatchSchema,
]);
export type GitHubLfsBatch = z.infer<typeof githubLfsBatchSchema>;
export const githubLfsLockVerificationSchema = z
  .object({
    ref: publicationRefSchema,
    cursor: z.string().max(1024).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

type GitHubTaskLfsRoute =
  | { kind: 'batch'; batchUrl: string }
  | { kind: 'locks-verify'; batchUrl: string }
  | { kind: 'download'; batchUrl: string; object: GitHubLfsObject }
  | { kind: 'upload'; batchUrl: string; object: GitHubLfsObject; ref: string };

/** These routes still require the broker's repository, identity, and allocation checks. */
export function getGitHubTaskLfsRoute(url: URL): GitHubTaskLfsRoute | undefined {
  if (url.origin !== 'https://github.com' || url.username || url.password || url.hash) return;
  const match =
    /^(\/[a-z0-9_.-]+\/[a-z0-9_.-]+\.git\/info\/lfs)\/(objects\/batch|locks\/verify|kilo-(download|upload)\/([a-f0-9]{64}))$/i.exec(
      url.pathname
    );
  if (!match) return;
  const batchUrl = `${url.origin}${match[1]}/objects/batch`;
  if (match[2] === 'objects/batch') return url.search ? undefined : { kind: 'batch', batchUrl };
  if (match[2] === 'locks/verify')
    return url.search ? undefined : { kind: 'locks-verify', batchUrl };
  const size = url.searchParams.get('size');
  if (!size || !/^(0|[1-9]\d*)$/.test(size)) return;
  const object = githubLfsObjectSchema.safeParse({ oid: match[4], size: Number(size) });
  if (!object.success) return;
  if (match[3] === 'download') {
    return [...url.searchParams].length === 1
      ? { kind: 'download', batchUrl, object: object.data }
      : undefined;
  }
  const ref = url.searchParams.get('ref');
  return match[3] === 'upload' && [...url.searchParams].length === 2 && ref && isGitHubTaskRef(ref)
    ? { kind: 'upload', batchUrl, object: object.data, ref }
    : undefined;
}

export function githubLfsDownloadUrl(batchUrl: string, object: GitHubLfsObject): string {
  return `${batchUrl.slice(0, -'objects/batch'.length)}kilo-download/${object.oid}?size=${object.size}`;
}

export function githubLfsUploadUrl(batchUrl: string, object: GitHubLfsObject, ref: string): string {
  const query = new URLSearchParams({ size: String(object.size), ref });
  return `${batchUrl.slice(0, -'objects/batch'.length)}kilo-upload/${object.oid}?${query}`;
}
