import type { Hono } from 'hono';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getBearerToken } from './gateway';
import { timingSafeTokenEqual } from '../auth';
import { resolveSafePath, verifyCanonicalized, SafePathError } from '../safe-path';
import { atomicWrite } from '../atomic-write';
import { backupFile } from '../backup-file';
import { formatBotIdentityMarkdown } from '../bootstrap';

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

const BOT_IDENTITY_RELATIVE_PATH = 'workspace/IDENTITY.md';
const LEGACY_BOT_IDENTITY_RELATIVE_PATHS = ['workspace/BOOTSTRAP.md'];

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
