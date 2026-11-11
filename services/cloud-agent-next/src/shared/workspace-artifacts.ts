import { z } from 'zod';
import {
  WORKSPACE_ARTIFACT_MAX_FILES,
  WORKSPACE_ARTIFACT_MAX_PATH_BYTES,
  WORKSPACE_ARTIFACT_RETENTION_MS,
} from '@kilocode/worker-utils/cloud-agent-workspace-artifacts';

export {
  WORKSPACE_ARTIFACT_MAX_FILES,
  WORKSPACE_ARTIFACT_MAX_PATH_BYTES,
  WORKSPACE_ARTIFACT_RETENTION_MS,
};

export const WORKSPACE_ARTIFACT_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const WORKSPACE_ARTIFACT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
export const WORKSPACE_ARTIFACT_MAX_DEPTH = 16;
export const WORKSPACE_ARTIFACT_SCAN_INTERVAL_MS = 4_000;
export const WORKSPACE_ARTIFACT_TRANSFER_TIMEOUT_MS = 120_000;
export const WORKSPACE_ARTIFACT_RESERVATION_TTL_MS = 10 * 60 * 1_000;
export const WORKSPACE_ARTIFACT_FLUSH_BUDGET_MS = 30_000;
export const WORKSPACE_ARTIFACT_DOWNLOAD_URL_SECONDS = 300;
export const WORKSPACE_ARTIFACT_EXCLUDED_SEGMENTS = [
  'node_modules',
  '__pycache__',
  'venv',
] as const;

export const WORKSPACE_ARTIFACT_SHA256_HEADER = 'X-Content-SHA256';

export type WorkspaceArtifactPathError =
  | 'empty'
  | 'not_nfc'
  | 'too_long'
  | 'too_deep'
  | 'invalid_segment'
  | 'invalid_character'
  | 'excluded_segment';

export type WorkspaceArtifactPathValidation =
  | { ok: true; relativePath: string }
  | { ok: false; reason: WorkspaceArtifactPathError };

const EXCLUDED_SEGMENTS = new Set<string>(WORKSPACE_ARTIFACT_EXCLUDED_SEGMENTS);
const CONTROL_CHARACTERS = /\p{Cc}/u;
const UTF8 = new TextEncoder();

export function validateWorkspaceArtifactPath(
  relativePath: string
): WorkspaceArtifactPathValidation {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (relativePath.normalize('NFC') !== relativePath) {
    return { ok: false, reason: 'not_nfc' };
  }
  if (relativePath.includes('\\') || CONTROL_CHARACTERS.test(relativePath)) {
    return { ok: false, reason: 'invalid_character' };
  }
  if (UTF8.encode(relativePath).byteLength > WORKSPACE_ARTIFACT_MAX_PATH_BYTES) {
    return { ok: false, reason: 'too_long' };
  }
  const segments = relativePath.split('/');
  if (segments.length > WORKSPACE_ARTIFACT_MAX_DEPTH) {
    return { ok: false, reason: 'too_deep' };
  }
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      return { ok: false, reason: 'invalid_segment' };
    }
    if (segment.startsWith('.') || EXCLUDED_SEGMENTS.has(segment)) {
      return { ok: false, reason: 'excluded_segment' };
    }
  }
  return { ok: true, relativePath };
}

export const workspaceArtifactRelativePathSchema = z.string().superRefine((value, context) => {
  const result = validateWorkspaceArtifactPath(value);
  if (!result.ok) {
    context.addIssue({
      code: 'custom',
      message: `Invalid workspace artifact path (${result.reason})`,
    });
  }
});

export const workspaceArtifactContentHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  csv: 'text/csv',
  gif: 'image/gif',
  gz: 'application/gzip',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  md: 'text/markdown',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  tar: 'application/x-tar',
  txt: 'text/plain',
  webm: 'video/webm',
  webp: 'image/webp',
  xml: 'application/xml',
  zip: 'application/zip',
};

export function workspaceArtifactContentType(relativePath: string): string {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

export function workspaceArtifactObjectKey(sandboxId: string, objectId: string): string {
  return `${sandboxId}/${objectId}`;
}

export type WorkspaceArtifactEntry = {
  relativePath: string;
  contentHash: string;
  sizeBytes: number;
  contentType: string;
  updatedAt: number;
  expiresAt: number;
};

export const workspaceArtifactEntrySchema = z
  .object({
    relativePath: z.string(),
    contentHash: workspaceArtifactContentHashSchema,
    sizeBytes: z.number().int().nonnegative(),
    contentType: z.string(),
    updatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();

export type WorkspaceArtifactList = {
  revision: number;
  entries: WorkspaceArtifactEntry[];
};

export const workspaceArtifactListSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    entries: z.array(workspaceArtifactEntrySchema),
  })
  .strict();

export type WorkspaceArtifactEntryLookup = {
  objectKey: string;
  entry: WorkspaceArtifactEntry;
};

export type WorkspaceArtifactIdentity = {
  sandboxId: string;
  allocationId: string;
  wrapperInstanceId: string;
};

export const workspaceArtifactIdentitySchema = z
  .object({
    sandboxId: z.string().min(1).max(256),
    allocationId: z.string().min(1).max(256),
    wrapperInstanceId: z.string().min(1).max(256),
  })
  .strict();

export const workspaceArtifactReserveInputSchema = z
  .object({
    relativePath: workspaceArtifactRelativePathSchema,
    sizeBytes: z.number().int().nonnegative().max(WORKSPACE_ARTIFACT_MAX_FILE_BYTES),
  })
  .strict();

export const workspaceArtifactCommitInputSchema = z
  .object({
    relativePath: workspaceArtifactRelativePathSchema,
    objectKey: z.string().min(1).max(1_024),
    contentHash: workspaceArtifactContentHashSchema,
    sizeBytes: z.number().int().nonnegative().max(WORKSPACE_ARTIFACT_MAX_FILE_BYTES),
    contentType: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[\u0020-\u007e]+$/),
  })
  .strict();

export const workspaceArtifactDeleteInputSchema = z
  .object({
    relativePath: workspaceArtifactRelativePathSchema,
    expectedHash: workspaceArtifactContentHashSchema,
  })
  .strict();

export type WorkspaceArtifactReserveInput = z.infer<typeof workspaceArtifactReserveInputSchema>;
export type WorkspaceArtifactCommitInput = z.infer<typeof workspaceArtifactCommitInputSchema>;
export type WorkspaceArtifactDeleteInput = z.infer<typeof workspaceArtifactDeleteInputSchema>;

export type ReserveWorkspaceArtifactUploadResult =
  | { status: 'ok'; objectKey: string }
  | { status: 'stale' }
  | { status: 'not_connected' }
  | { status: 'quota_exceeded' }
  | { status: 'invalid_path' };

export type CommitWorkspaceArtifactResult =
  | { status: 'committed'; revision: number }
  | { status: 'unchanged'; revision: number }
  | { status: 'stale' }
  | { status: 'not_connected' }
  | { status: 'reservation_missing' }
  | { status: 'reservation_expired' }
  | { status: 'quota_exceeded' }
  | { status: 'invalid_path' };

export type DeleteWorkspaceArtifactResult =
  | { status: 'deleted'; revision: number }
  | { status: 'absent'; revision: number }
  | { status: 'hash_mismatch'; revision: number }
  | { status: 'stale' }
  | { status: 'not_connected' };

export type DeleteWorkspaceArtifactForUserResult =
  | { status: 'deleted'; revision: number }
  | { status: 'absent'; revision: number }
  | { status: 'hash_mismatch'; revision: number };
