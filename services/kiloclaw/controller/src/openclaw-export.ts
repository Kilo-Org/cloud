import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { pack as tarPack } from 'tar-stream';
import {
  configure as configureZip,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from '@zip.js/zip.js';
import { resolveSafePath, verifyCanonicalized } from './safe-path';

// zip.js spins up Web Workers by default for codec parallelism. The controller
// runs as a single-file Node bundle with no worker entrypoint, so disable them
// and run codecs inline.
configureZip({ useWebWorkers: false });

/** Workspace directory (relative to the controller rootDir, i.e. ~/.openclaw). */
const OPENCLAW_EXPORT_WORKSPACE_DIR = 'workspace';

export const OPENCLAW_EXPORT_FORMATS = ['tar.gz', 'zip'] as const;
export type OpenclawExportFormat = (typeof OPENCLAW_EXPORT_FORMATS)[number];

export const OPENCLAW_EXPORT_MAX_FILES = 5000;
export const OPENCLAW_EXPORT_MAX_FILE_BYTES = 5 * 1024 * 1024; // per file
export const OPENCLAW_EXPORT_MAX_TOTAL_BYTES = 10 * 1024 * 1024; // total uncompressed
// The produced archive must cross the Cloudflare Durable Object RPC boundary,
// which caps serialized return values at 32 MiB. Keep headroom under that.
// (Text-only exports stay far below this; the guard is defense-in-depth.)
export const OPENCLAW_EXPORT_MAX_ARCHIVE_BYTES = 28 * 1024 * 1024;

/** Only text/markdown is exported. Binary skill/canvas payloads are excluded. */
const EXPORTED_FILE_EXTENSION = '.md';
/**
 * Directories never traversed by the markdown walk. `skills/` and `canvas/`
 * hold the unbounded binary payloads we intentionally do not export; the
 * installed-skill names are captured separately as a generated manifest.
 */
const EXCLUDED_DIR_NAMES = new Set(['.git', 'node_modules', 'skills', 'canvas']);

/** Skills live under workspace/skills/<name>/SKILL.md. */
const SKILLS_DIR_NAME = 'skills';
const SKILL_MANIFEST_FILE = 'SKILL.md';
/** Generated inventory file added to the archive (not a real workspace file). */
export const OPENCLAW_EXPORT_SKILL_INVENTORY_PATH = 'INSTALLED_SKILLS.md';
/** Skill descriptions can be paragraph-length; keep the inventory readable. */
const SKILL_DESCRIPTION_MAX_LENGTH = 200;
/** Frontmatter `name` is untrusted single-line text; bound it in the inventory. */
const SKILL_NAME_MAX_LENGTH = 100;
/** Upper bound on a SKILL.md read — only its frontmatter is consumed. */
const SKILL_MANIFEST_MAX_BYTES = 64 * 1024;
/**
 * Cap on skill directories read while building the inventory. Bounds the
 * synchronous I/O and inventory size independent of the archive caps; extra
 * skills are reported in a footer rather than silently dropped.
 */
const SKILL_INVENTORY_MAX_ENTRIES = 1000;

export class OpenclawExportError extends Error {
  readonly code: string;
  readonly status: 400 | 413;
  constructor(message: string, code: string, status: 400 | 413 = 400) {
    super(message);
    this.name = 'OpenclawExportError';
    this.code = code;
    this.status = status;
  }
}

export type OpenclawExportEntry = {
  /** Archive path, relative to the workspace root (e.g. `USER.md`, `memory/x.md`). */
  path: string;
  content: Uint8Array;
};

export type OpenclawExportCollection = {
  entries: OpenclawExportEntry[];
  totalBytes: number;
  /** Count of paths skipped (excluded dirs, non-markdown files, symlinks). */
  skippedCount: number;
};

/**
 * Collect the user's portable, host-independent OpenClaw workspace as text.
 *
 * Includes every markdown file under `~/.openclaw/workspace` (persona,
 * instructions, and the `memory/` tree) plus a generated `INSTALLED_SKILLS.md`
 * inventory of installed skills. Deliberately excludes the `skills/` and
 * `canvas/` payloads (potentially many gigabytes of binaries/deps), VCS/dep
 * metadata, symlinks, and any non-markdown file. Enforces per-file, total-size,
 * and file-count caps. Archive paths are relative to the workspace root.
 *
 * @param rootDir absolute path to the controller root (~/.openclaw)
 */
export function collectOpenclawWorkspaceFiles(rootDir: string): OpenclawExportCollection {
  const entries: OpenclawExportEntry[] = [];
  let totalBytes = 0;
  let skippedCount = 0;

  let workspaceDir: string;
  try {
    workspaceDir = resolveSafePath(OPENCLAW_EXPORT_WORKSPACE_DIR, rootDir);
  } catch {
    return { entries, totalBytes, skippedCount };
  }

  if (!fs.existsSync(workspaceDir)) {
    return { entries, totalBytes, skippedCount };
  }

  // Refuse a symlinked/non-directory root and confirm it canonicalizes inside
  // rootDir (mirrors the import walker's symlink-ancestor defense).
  try {
    const rootStat = fs.lstatSync(workspaceDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { entries, totalBytes, skippedCount };
    }
    verifyCanonicalized(fs.realpathSync(workspaceDir), rootDir);
  } catch {
    return { entries, totalBytes, skippedCount };
  }

  const pendingDirs: string[] = [workspaceDir];
  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (!currentDir) continue;

    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue; // skip unreadable directories
    }

    for (const dirent of dirents) {
      // Never follow symlinks (defends against escaping the workspace root).
      if (dirent.isSymbolicLink()) {
        skippedCount += 1;
        continue;
      }

      const absolutePath = path.join(currentDir, dirent.name);

      if (dirent.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(dirent.name)) {
          skippedCount += 1;
          continue;
        }
        pendingDirs.push(absolutePath);
        continue;
      }

      if (!dirent.isFile()) {
        // sockets / fifos / block / char devices
        skippedCount += 1;
        continue;
      }

      // Text-only export: markdown only. Everything else is intentionally dropped.
      if (!dirent.name.toLowerCase().endsWith(EXPORTED_FILE_EXTENSION)) {
        skippedCount += 1;
        continue;
      }

      const archivePath = path.relative(workspaceDir, absolutePath).split(path.sep).join('/');

      // The inventory path is reserved for the generated skill manifest below.
      if (archivePath === OPENCLAW_EXPORT_SKILL_INVENTORY_PATH) {
        skippedCount += 1;
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(absolutePath);
      } catch {
        skippedCount += 1;
        continue;
      }

      if (stat.size > OPENCLAW_EXPORT_MAX_FILE_BYTES) {
        throw new OpenclawExportError(
          `File exceeds the ${OPENCLAW_EXPORT_MAX_FILE_BYTES}-byte per-file limit: ${archivePath}`,
          'openclaw_export_too_large',
          413
        );
      }

      totalBytes += stat.size;
      if (totalBytes > OPENCLAW_EXPORT_MAX_TOTAL_BYTES) {
        throw new OpenclawExportError(
          `Workspace exceeds the ${OPENCLAW_EXPORT_MAX_TOTAL_BYTES}-byte export limit`,
          'openclaw_export_too_large',
          413
        );
      }

      if (entries.length >= OPENCLAW_EXPORT_MAX_FILES) {
        throw new OpenclawExportError(
          `Workspace exceeds the ${OPENCLAW_EXPORT_MAX_FILES}-file export limit`,
          'openclaw_export_too_many_files'
        );
      }

      let content: Buffer;
      try {
        content = fs.readFileSync(absolutePath);
      } catch {
        skippedCount += 1;
        totalBytes -= stat.size;
        continue;
      }

      entries.push({ path: archivePath, content });
    }
  }

  // Append a generated inventory of installed skills (names/descriptions only —
  // the skill code itself lives in the excluded skills/ tree). The inventory is
  // subject to the same caps as any exported file.
  const skillInventory = buildInstalledSkillInventory(workspaceDir);
  if (skillInventory) {
    const content = Buffer.from(skillInventory, 'utf8');

    if (entries.length >= OPENCLAW_EXPORT_MAX_FILES) {
      throw new OpenclawExportError(
        `Workspace exceeds the ${OPENCLAW_EXPORT_MAX_FILES}-file export limit`,
        'openclaw_export_too_many_files'
      );
    }

    if (totalBytes + content.byteLength > OPENCLAW_EXPORT_MAX_TOTAL_BYTES) {
      throw new OpenclawExportError(
        `Workspace exceeds the ${OPENCLAW_EXPORT_MAX_TOTAL_BYTES}-byte export limit`,
        'openclaw_export_too_large',
        413
      );
    }

    totalBytes += content.byteLength;
    entries.push({ path: OPENCLAW_EXPORT_SKILL_INVENTORY_PATH, content });
  }

  // Stable, deterministic ordering for reproducible archives.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { entries, totalBytes, skippedCount };
}

type InstalledSkill = { name: string; description: string | null };

/**
 * Build a markdown inventory of skills installed under workspace/skills/.
 * Returns null when there are no readable skills. Reads only the top-level
 * skill directories' SKILL.md (never descends into skill internals/node_modules)
 * and skips symlinks.
 */
function buildInstalledSkillInventory(workspaceDir: string): string | null {
  const skillsDir = path.join(workspaceDir, SKILLS_DIR_NAME);

  try {
    const skillsStat = fs.lstatSync(skillsDir);
    if (skillsStat.isSymbolicLink() || !skillsStat.isDirectory()) {
      return null;
    }
  } catch {
    return null; // no skills directory
  }

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const skills: InstalledSkill[] = [];
  let omittedCount = 0;
  let examinedCount = 0;
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink() || !dirent.isDirectory()) continue;

    // Bound the synchronous I/O *before* any lstat/read: cap how many skill
    // directories we examine, not how many yield a skill. Remaining candidates
    // are reported in the footer rather than statted/read.
    if (examinedCount >= SKILL_INVENTORY_MAX_ENTRIES) {
      omittedCount += 1;
      continue;
    }
    examinedCount += 1;

    const skillMdPath = path.join(skillsDir, dirent.name, SKILL_MANIFEST_FILE);
    let skillMd: string;
    try {
      const stat = fs.lstatSync(skillMdPath);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      // Only the frontmatter is needed; cap the read so a large/pathological
      // SKILL.md can't exhaust memory on the way to a tiny inventory line.
      if (stat.size > SKILL_MANIFEST_MAX_BYTES) continue;
      skillMd = fs.readFileSync(skillMdPath, 'utf8');
    } catch {
      continue; // a directory with no readable SKILL.md is not a valid skill
    }

    const { name, description } = parseSkillFrontmatter(skillMd);
    skills.push({ name: truncate(name ?? dirent.name, SKILL_NAME_MAX_LENGTH), description });
  }

  if (skills.length === 0) {
    return null;
  }

  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const lines = [
    '# Installed skills',
    '',
    'These skills were installed in your KiloClaw workspace when it was exported.',
    'This is a reference inventory, not a backup. The skill code itself is not',
    'included in this export. Re-install published skills on the target host, for',
    'example with `openclaw skills install <name>`.',
    '',
  ];
  for (const skill of skills) {
    lines.push(
      skill.description ? `- **${skill.name}** — ${skill.description}` : `- **${skill.name}**`
    );
  }
  if (omittedCount > 0) {
    lines.push('');
    lines.push(`_${omittedCount} additional skill(s) not listed._`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Extract `name` and `description` from a SKILL.md YAML frontmatter block.
 * Intentionally minimal: only these two top-level scalars are needed, and a
 * missing/malformed block degrades to nulls (caller falls back to the folder
 * name).
 */
function parseSkillFrontmatter(source: string): {
  name: string | null;
  description: string | null;
} {
  const normalized = source.replace(/^\uFEFF/, '');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { name: null, description: null };
  }

  let fenceEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      fenceEnd = i;
      break;
    }
  }
  if (fenceEnd === -1) {
    return { name: null, description: null };
  }

  let name: string | null = null;
  let description: string | null = null;
  for (let i = 1; i < fenceEnd; i++) {
    const nameMatch = /^name:\s*(.+)$/.exec(lines[i]);
    if (nameMatch && name === null) {
      name = cleanFrontmatterScalar(nameMatch[1]);
      continue;
    }
    const descriptionMatch = /^description:\s*(.+)$/.exec(lines[i]);
    if (descriptionMatch && description === null) {
      description = cleanFrontmatterScalar(descriptionMatch[1]);
    }
  }

  return {
    name,
    description: description ? truncate(description, SKILL_DESCRIPTION_MAX_LENGTH) : null,
  };
}

function cleanFrontmatterScalar(raw: string): string | null {
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value.length > 0 ? value : null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Build a gzipped tar (.tar.gz) from the collected entries. */
export function buildOpenclawWorkspaceTarGz(entries: OpenclawExportEntry[]): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const pack = tarPack();
    const chunks: Buffer[] = [];
    pack.on('data', (chunk: Buffer) => chunks.push(chunk));
    pack.on('error', reject);
    pack.on('end', () => {
      try {
        resolve(gzipSync(Buffer.concat(chunks)));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    (async () => {
      for (const entry of entries) {
        await new Promise<void>((entryResolve, entryReject) => {
          pack.entry({ name: entry.path }, Buffer.from(entry.content), err =>
            err ? entryReject(err) : entryResolve()
          );
        });
      }
      pack.finalize();
    })().catch(reject);
  });
}

/**
 * Build a .zip from the collected entries. When `password` is supplied the zip is
 * AES-256 encrypted (WinZip AES, encryptionStrength 3).
 */
export async function buildOpenclawWorkspaceZip(
  entries: OpenclawExportEntry[],
  password?: string
): Promise<Uint8Array> {
  const zipWriter = new ZipWriter(
    new Uint8ArrayWriter(),
    password ? { password, encryptionStrength: 3 } : {}
  );
  for (const entry of entries) {
    await zipWriter.add(entry.path, new Uint8ArrayReader(entry.content));
  }
  return zipWriter.close();
}

export function openclawExportContentType(format: OpenclawExportFormat): string {
  return format === 'zip' ? 'application/zip' : 'application/gzip';
}

export function openclawExportFileName(format: OpenclawExportFormat): string {
  return `openclaw-workspace-export.${format}`;
}
