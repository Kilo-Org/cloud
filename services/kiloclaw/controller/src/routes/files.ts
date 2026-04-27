import type { Hono } from 'hono';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  OPENCLAW_IMPORT_MAX_EXTRACTED_UTF8_BYTES,
  OPENCLAW_IMPORT_MAX_FILES,
  OPENCLAW_IMPORT_MEMORY_PREFIX,
  isOpenclawImportPathAllowed,
  isOpenclawMarkdownContent,
  normalizeOpenclawImportPath,
} from '../openclaw-import';
import { getBearerToken } from './gateway';
import { timingSafeTokenEqual } from '../auth';
import { resolveSafePath, verifyCanonicalized, SafePathError } from '../safe-path';
import { atomicWrite } from '../atomic-write';
import { backupFile } from '../backup-file';
import {
  ensureWeatherSkillInstalled,
  formatBotIdentityMarkdown,
  formatUserProfileMarkdown,
  removeUserMdLocation,
  removeUserMdTimezone,
  setUserMdLocation,
  setUserMdTimezone,
} from '../bootstrap';

const OpenclawWorkspaceImportFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const OpenclawWorkspaceImportBodySchema = z.object({
  files: z.array(OpenclawWorkspaceImportFileSchema).min(1).max(OPENCLAW_IMPORT_MAX_FILES),
});

const OpenclawWorkspaceImportFailureSchema = z.object({
  path: z.string(),
  operation: z.enum(['write', 'delete']),
  error: z.string(),
  code: z.string().optional(),
});

const OpenclawWorkspaceImportResponseSchema = z.object({
  ok: z.boolean(),
  attemptedWriteCount: z.number().int().min(0),
  writtenCount: z.number().int().min(0),
  attemptedDeleteCount: z.number().int().min(0),
  deletedCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  totalUtf8Bytes: z.number().int().min(0),
  failures: z.array(OpenclawWorkspaceImportFailureSchema),
});

type OpenclawWorkspaceImportFile = z.infer<typeof OpenclawWorkspaceImportFileSchema>;

type OpenclawWorkspacePreparedFile = {
  path: string;
  content: string;
  utf8Bytes: number;
};

type OpenclawImportFailure = z.infer<typeof OpenclawWorkspaceImportFailureSchema>;

type OpenclawWorkspaceImportValidation =
  | {
      ok: true;
      files: OpenclawWorkspacePreparedFile[];
      hasMemoryMd: boolean;
      importedMemoryPaths: Set<string>;
      totalUtf8Bytes: number;
    }
  | {
      ok: false;
      error: string;
      code: string;
      status: 400;
    };

function validateOpenclawWorkspaceImport(
  files: OpenclawWorkspaceImportFile[]
): OpenclawWorkspaceImportValidation {
  const preparedFiles: OpenclawWorkspacePreparedFile[] = [];
  const importedMemoryPaths = new Set<string>();
  const seenCaseInsensitivePaths = new Map<string, string>();
  let totalUtf8Bytes = 0;

  for (const file of files) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeOpenclawImportPath(file.path);
    } catch {
      return {
        ok: false,
        error: `Unsupported import path: ${file.path}`,
        code: 'openclaw_import_invalid_path',
        status: 400,
      };
    }

    if (!isOpenclawImportPathAllowed(normalizedPath)) {
      return {
        ok: false,
        error: `Unsupported import path: ${file.path}`,
        code: 'openclaw_import_invalid_path',
        status: 400,
      };
    }

    const caseInsensitivePath = normalizedPath.toLowerCase();
    const existing = seenCaseInsensitivePaths.get(caseInsensitivePath);
    if (existing) {
      return {
        ok: false,
        error: `Import contains conflicting paths: ${existing} and ${normalizedPath}`,
        code: 'openclaw_import_path_case_conflict',
        status: 400,
      };
    }
    seenCaseInsensitivePaths.set(caseInsensitivePath, normalizedPath);

    if (!isOpenclawMarkdownContent(file.content)) {
      return {
        ok: false,
        error: `File content appears to be non-text markdown: ${normalizedPath}`,
        code: 'openclaw_import_invalid_markdown',
        status: 400,
      };
    }

    const utf8Bytes = Buffer.byteLength(file.content, 'utf8');
    totalUtf8Bytes += utf8Bytes;
    if (totalUtf8Bytes > OPENCLAW_IMPORT_MAX_EXTRACTED_UTF8_BYTES) {
      return {
        ok: false,
        error: `Import exceeds ${OPENCLAW_IMPORT_MAX_EXTRACTED_UTF8_BYTES} UTF-8 bytes`,
        code: 'openclaw_import_too_large',
        status: 400,
      };
    }

    preparedFiles.push({ path: normalizedPath, content: file.content, utf8Bytes });

    if (normalizedPath.startsWith(OPENCLAW_IMPORT_MEMORY_PREFIX)) {
      importedMemoryPaths.add(normalizedPath);
    }
  }

  if (preparedFiles.length === 0) {
    return {
      ok: false,
      error: 'ZIP contains no valid OpenClaw import files',
      code: 'openclaw_import_no_files',
      status: 400,
    };
  }

  return {
    ok: true,
    files: preparedFiles,
    hasMemoryMd: preparedFiles.some(file => file.path === 'workspace/MEMORY.md'),
    importedMemoryPaths,
    totalUtf8Bytes,
  };
}

function assertNoSymlinkAncestors(targetPath: string, rootDir: string): void {
  let currentPath = path.dirname(targetPath);

  while (currentPath !== rootDir) {
    if (fs.existsSync(currentPath)) {
      const stat = fs.lstatSync(currentPath);
      if (stat.isSymbolicLink()) {
        throw new SafePathError('Import target contains symbolic-link ancestor');
      }
    }

    currentPath = path.dirname(currentPath);
  }
}

function collectWorkspaceMemoryFiles(rootDir: string): string[] {
  let workspaceMemoryDir: string;
  try {
    workspaceMemoryDir = resolveSafePath(OPENCLAW_IMPORT_MEMORY_PREFIX.slice(0, -1), rootDir);
  } catch {
    return [];
  }

  if (!fs.existsSync(workspaceMemoryDir)) {
    return [];
  }

  try {
    const memoryDirStat = fs.lstatSync(workspaceMemoryDir);
    if (memoryDirStat.isSymbolicLink() || !memoryDirStat.isDirectory()) {
      return [];
    }
    verifyCanonicalized(fs.realpathSync(workspaceMemoryDir), rootDir);
  } catch {
    return [];
  }

  const files: string[] = [];
  const pendingDirs = [workspaceMemoryDir];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (!currentDir) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pendingDirs.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;

      const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join('/');
      files.push(relativePath);
    }
  }

  return files;
}

function resolveAndValidateImportTarget(
  relativePath: string,
  rootDir: string
): { ok: true; resolvedPath: string } | { ok: false; error: string; code: string } {
  let resolvedPath: string;
  try {
    resolvedPath = resolveSafePath(relativePath, rootDir);
  } catch (error) {
    if (error instanceof SafePathError) {
      return { ok: false, error: error.message, code: 'openclaw_import_invalid_path' };
    }
    throw error;
  }

  try {
    assertNoSymlinkAncestors(resolvedPath, rootDir);
  } catch {
    return {
      ok: false,
      error: 'Import target contains symbolic-link ancestor',
      code: 'openclaw_import_symlink_ancestor',
    };
  }

  if (!fs.existsSync(resolvedPath)) {
    return { ok: true, resolvedPath };
  }

  try {
    verifyCanonicalized(fs.realpathSync(resolvedPath), rootDir);
  } catch {
    return {
      ok: false,
      error: 'Import target escapes workspace root via symlink',
      code: 'openclaw_import_symlink_escape',
    };
  }

  const targetStat = fs.lstatSync(resolvedPath);
  if (targetStat.isSymbolicLink()) {
    return {
      ok: false,
      error: 'Import target is a symbolic link',
      code: 'openclaw_import_symlink_target',
    };
  }
  if (!targetStat.isFile()) {
    return {
      ok: false,
      error: 'Import target is not a regular file',
      code: 'openclaw_import_target_not_file',
    };
  }

  return { ok: true, resolvedPath };
}

function computeEtag(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/** Keep in sync with: kiloclaw/src/.../gateway.ts (Zod), src/lib/kiloclaw/kiloclaw-internal-client.ts */
interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

function buildTree(dir: string, rootDir: string): FileNode[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // skip unreadable directories
  }
  const nodes: FileNode[] = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;

    const relativePath = path.relative(rootDir, path.join(dir, entry.name));

    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: 'directory',
        children: buildTree(path.join(dir, entry.name), rootDir),
      });
    } else {
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: 'file',
      });
    }
  }

  return nodes;
}

type FileValidationError = { error: string; code?: string; status: 400 | 404 };

/**
 * Resolve a relative file path within the root directory and validate it:
 * safe-path resolution, existence check, canonicalization, symlink rejection, regular file check.
 * Returns the resolved absolute path on success, or a validation error.
 */
function resolveAndValidateFile(
  relativePath: string,
  rootDir: string
): string | FileValidationError {
  let resolved: string;
  try {
    resolved = resolveSafePath(relativePath, rootDir);
  } catch (e) {
    if (e instanceof SafePathError) {
      return { error: e.message, status: 400 };
    }
    throw e;
  }

  if (!fs.existsSync(resolved)) {
    return { code: 'file_not_found', error: 'File does not exist', status: 404 };
  }

  // Canonicalize to catch symlinked ancestors escaping the root
  try {
    verifyCanonicalized(fs.realpathSync(resolved), rootDir);
  } catch (e) {
    if (e instanceof SafePathError) {
      return { error: e.message, status: 400 };
    }
    throw e;
  }

  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    return { error: 'Symlinks are not allowed', status: 400 };
  }
  if (!stat.isFile()) {
    return { error: 'Not a regular file', status: 400 };
  }

  return resolved;
}

const BotIdentityBodySchema = z.object({
  botName: z.string().trim().min(1).max(80).nullable().optional(),
  botNature: z.string().trim().min(1).max(120).nullable().optional(),
  botVibe: z.string().trim().min(1).max(120).nullable().optional(),
  botEmoji: z.string().trim().min(1).max(16).nullable().optional(),
});

const UserProfileBodySchema = z.object({
  userTimezone: z.string().trim().min(1).max(100).nullable().optional(),
  userLocation: z.string().trim().min(1).max(200).nullable().optional(),
});

const BOT_IDENTITY_RELATIVE_PATH = 'workspace/IDENTITY.md';
const LEGACY_BOT_IDENTITY_RELATIVE_PATHS = ['workspace/BOOTSTRAP.md'];
const USER_PROFILE_RELATIVE_PATH = 'workspace/USER.md';

export function registerFileRoutes(app: Hono, expectedToken: string, rootDir: string): void {
  app.use('/_kilo/files/*', async (c, next) => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  app.use('/_kilo/bot-identity', async (c, next) => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  app.use('/_kilo/user-profile', async (c, next) => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  app.post('/_kilo/bot-identity', async c => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = BotIdentityBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: 'Missing or invalid bot identity fields' }, 400);
    }

    let targetPath: string;
    try {
      targetPath = resolveSafePath(BOT_IDENTITY_RELATIVE_PATH, rootDir);
    } catch (err) {
      if (err instanceof SafePathError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    try {
      atomicWrite(
        targetPath,
        formatBotIdentityMarkdown({
          KILOCLAW_BOT_NAME: parsed.data.botName ?? undefined,
          KILOCLAW_BOT_NATURE: parsed.data.botNature ?? undefined,
          KILOCLAW_BOT_VIBE: parsed.data.botVibe ?? undefined,
          KILOCLAW_BOT_EMOJI: parsed.data.botEmoji ?? undefined,
        })
      );

      for (const legacyPath of LEGACY_BOT_IDENTITY_RELATIVE_PATHS) {
        try {
          const resolvedLegacyPath = resolveSafePath(legacyPath, rootDir);
          if (fs.existsSync(resolvedLegacyPath)) {
            fs.unlinkSync(resolvedLegacyPath);
          }
        } catch (error) {
          console.warn('[files] Failed to remove legacy bot identity file:', legacyPath, error);
        }
      }

      return c.json({ ok: true, path: BOT_IDENTITY_RELATIVE_PATH });
    } catch (err) {
      console.error('[files] Failed to write bot identity:', err);
      return c.json({ error: 'Failed to write bot identity' }, 500);
    }
  });

  app.post('/_kilo/user-profile', async c => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = UserProfileBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: 'Missing or invalid user profile fields' }, 400);
    }

    const hasUserTimezone = parsed.data.userTimezone !== undefined;
    const hasUserLocation = parsed.data.userLocation !== undefined;
    const userTimezone = parsed.data.userTimezone;
    const userLocation = parsed.data.userLocation;
    if (!hasUserTimezone && !hasUserLocation) {
      return c.json({ error: 'Missing or invalid user profile fields' }, 400);
    }

    let targetPath: string;
    try {
      targetPath = resolveSafePath(USER_PROFILE_RELATIVE_PATH, rootDir);
    } catch (err) {
      if (err instanceof SafePathError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    try {
      const userProfileExists = fs.existsSync(targetPath);
      const hasProfileValue = Boolean(userTimezone || userLocation);
      let content = '';
      if (userProfileExists) {
        content = fs.readFileSync(targetPath, 'utf8');
      } else if (hasProfileValue) {
        content = formatUserProfileMarkdown({
          ...(userTimezone ? { timezone: userTimezone } : undefined),
          ...(userLocation ? { location: userLocation } : undefined),
        });
      }
      let nextContent = content;
      if (userTimezone) nextContent = setUserMdTimezone(nextContent, userTimezone);
      if (userTimezone === null) nextContent = removeUserMdTimezone(nextContent);
      if (userLocation) nextContent = setUserMdLocation(nextContent, userLocation);
      if (userLocation === null) nextContent = removeUserMdLocation(nextContent);

      if ((userProfileExists || nextContent) && nextContent !== content) {
        atomicWrite(targetPath, nextContent);
      }
      if (userLocation) {
        ensureWeatherSkillInstalled({ KILOCLAW_USER_LOCATION: userLocation });
      }

      return c.json({ ok: true, path: USER_PROFILE_RELATIVE_PATH });
    } catch (err) {
      console.error('[files] Failed to write user profile:', err);
      return c.json({ error: 'Failed to write user profile' }, 500);
    }
  });

  app.get('/_kilo/files/tree', c => {
    const tree = buildTree(rootDir, rootDir);
    return c.json({ tree });
  });

  app.get('/_kilo/files/read', c => {
    const relativePath = c.req.query('path');
    if (!relativePath) {
      return c.json({ error: 'Missing path parameter' }, 400);
    }

    const result = resolveAndValidateFile(relativePath, rootDir);
    if (typeof result !== 'string') {
      return c.json(
        { error: result.error, ...(result.code && { code: result.code }) },
        result.status
      );
    }

    const content = fs.readFileSync(result, 'utf-8');
    return c.json({ content, etag: computeEtag(content) });
  });

  app.post('/_kilo/files/import-openclaw-workspace', async c => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body', code: 'invalid_json_body' }, 400);
    }

    const parsed = OpenclawWorkspaceImportBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          error: 'Missing or invalid import files',
          code: 'invalid_request_body',
          details: parsed.error.flatten().fieldErrors,
        },
        400
      );
    }

    const validation = validateOpenclawWorkspaceImport(parsed.data.files);
    if (!validation.ok) {
      return c.json({ error: validation.error, code: validation.code }, validation.status);
    }

    const resolvedFiles: Array<OpenclawWorkspacePreparedFile & { resolvedPath: string }> = [];
    for (const file of validation.files) {
      const target = resolveAndValidateImportTarget(file.path, rootDir);
      if (!target.ok) {
        return c.json({ error: target.error, code: target.code }, 400);
      }
      resolvedFiles.push({ ...file, resolvedPath: target.resolvedPath });
    }

    const failures: OpenclawImportFailure[] = [];
    let writtenCount = 0;

    for (const file of resolvedFiles) {
      try {
        fs.mkdirSync(path.dirname(file.resolvedPath), { recursive: true });
        if (fs.existsSync(file.resolvedPath)) {
          try {
            backupFile(file.resolvedPath, rootDir);
          } catch (error) {
            console.warn('[files] Failed to backup import file, proceeding with write:', {
              path: file.path,
              error,
            });
          }
        }
        atomicWrite(file.resolvedPath, file.content);
        writtenCount += 1;
      } catch (error) {
        failures.push({
          path: file.path,
          operation: 'write',
          error: error instanceof Error ? error.message : 'Failed to write file',
        });
      }
    }

    const deletedPaths: string[] = [];
    let attemptedDeleteCount = 0;
    const hasWriteFailure = failures.some(failure => failure.operation === 'write');
    if (validation.hasMemoryMd && !hasWriteFailure) {
      const existingMemoryFiles = collectWorkspaceMemoryFiles(rootDir);
      for (const existingPath of existingMemoryFiles) {
        if (validation.importedMemoryPaths.has(existingPath)) {
          continue;
        }

        attemptedDeleteCount += 1;

        const deletionTarget = resolveAndValidateImportTarget(existingPath, rootDir);
        if (!deletionTarget.ok) {
          failures.push({
            path: existingPath,
            operation: 'delete',
            error: deletionTarget.error,
            code: deletionTarget.code,
          });
          continue;
        }

        try {
          fs.unlinkSync(deletionTarget.resolvedPath);
          deletedPaths.push(existingPath);
        } catch (error) {
          failures.push({
            path: existingPath,
            operation: 'delete',
            error: error instanceof Error ? error.message : 'Failed to delete file',
          });
        }
      }
    }

    const response = {
      ok: failures.length === 0,
      attemptedWriteCount: resolvedFiles.length,
      writtenCount,
      attemptedDeleteCount,
      deletedCount: deletedPaths.length,
      failedCount: failures.length,
      totalUtf8Bytes: validation.totalUtf8Bytes,
      failures,
    };

    const validatedResponse = OpenclawWorkspaceImportResponseSchema.parse(response);
    return c.json(validatedResponse);
  });

  const WriteBodySchema = z.object({
    path: z.string().min(1),
    content: z.string(),
    etag: z.string().optional(),
  });

  app.post('/_kilo/files/write', async c => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = WriteBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: 'Missing or invalid path/content' }, 400);
    }
    const body = parsed.data;

    const result = resolveAndValidateFile(body.path, rootDir);
    if (typeof result !== 'string') {
      return c.json(
        { error: result.error, ...(result.code && { code: result.code }) },
        result.status
      );
    }

    if (body.etag) {
      const currentContent = fs.readFileSync(result, 'utf-8');
      const currentEtag = computeEtag(currentContent);
      if (body.etag !== currentEtag) {
        return c.json({ code: 'file_etag_conflict', error: 'File was modified externally' }, 409);
      }
    }

    try {
      backupFile(result, rootDir);
    } catch (err) {
      console.warn('[files] Failed to create backup, proceeding with write:', err);
    }
    try {
      atomicWrite(result, body.content);
    } catch (err) {
      console.error('[files] atomicWrite failed:', err);
      return c.json({ error: 'Failed to write file' }, 500);
    }

    const newEtag = computeEtag(body.content);
    return c.json({ etag: newEtag });
  });
}
