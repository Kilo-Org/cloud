/**
 * Client-side skill-bundle extraction: turns an uploaded skill ZIP into a
 * validated bundle. UI-free so the skill-specific archive contract can be
 * tested directly; the shared decoder owns bounded ZIP mechanics.
 */
import { decodeSkillBundleArchive } from '@kilocode/cloud-agent-profile/import';

const SKILL_FILE_PATH_PATTERN = /^[a-zA-Z0-9._\-/]+$/;

// Keep in sync with apps/web/src/lib/agent/profile-skills-service.ts limits.
const MAX_SKILL_MARKDOWN_LENGTH = 100_000;
export const MAX_COMPANION_FILES = 40;
const MAX_COMPANION_FILE_SIZE = 100_000;
const MAX_COMPANION_FILES_TOTAL = 500_000;
const MAX_PATH_LENGTH = 200;
const MAX_SKILL_ZIP_BYTES = 5 * 1024 * 1024;

export type ExtractedSkill = {
  rawMarkdown: string;
  files: Record<string, string>;
  fileCount: number;
  totalBytes: number;
  frontmatterName?: string;
  frontmatterDescription?: string;
};

/** The only parts of a dropped `File` the extractor reads, so it can be unit-tested. */
export type SkillZipFile = {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

/**
 * Parse frontmatter `name` and `description` out of a SKILL.md body.
 * Matches the minimal extension parser (only these two fields).
 */
export function parseSkillFrontmatter(rawMarkdown: string): {
  name?: string;
  description?: string;
} {
  const match = rawMarkdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
  if (!match) return {};
  const strip = (v: string) => {
    const t = v.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  };
  const nameMatch = match[1].match(/^name\s*:\s*(.+)$/m);
  const descMatch = match[1].match(/^description\s*:\s*(.+)$/m);
  return {
    name: nameMatch ? strip(nameMatch[1]) : undefined,
    description: descMatch ? strip(descMatch[1]) : undefined,
  };
}

/**
 * Extract a skill bundle from a zip. The shared config-archive decoder owns the
 * archive mechanics (bounded extraction, root stripping, junk filtering,
 * duplicate detection) in skill-bundle mode, where the sole outer directory is
 * stripped like the marketplace's `tar --strip-components=1`.
 *
 * Every decoder issue is fatal here: skipped or oversized entries would
 * otherwise produce a "successful" import with missing companion files.
 * Throws an Error with a user-facing message on invalid archives.
 */
export async function extractSkillZip(file: SkillZipFile): Promise<ExtractedSkill> {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    throw new Error('Expected a .zip file');
  }
  if (file.size > MAX_SKILL_ZIP_BYTES) {
    throw new Error('Zip file is larger than 5 MB');
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.byteLength > MAX_SKILL_ZIP_BYTES) {
    throw new Error('Zip file is larger than 5 MB');
  }

  let decoded;
  try {
    decoded = decodeSkillBundleArchive(buf);
  } catch (error) {
    throw new Error(`Unable to read zip: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  const rejectableIssue =
    decoded.issues.find(issue => issue.severity === 'error') ?? decoded.issues[0];
  if (rejectableIssue) {
    throw new Error(rejectableIssue.message);
  }
  if (decoded.entries.length === 0) {
    throw new Error('Zip is empty');
  }

  let skillMd: string | null = null;
  const files: Record<string, string> = {};
  let totalBytes = 0;
  let fileCount = 0;

  for (const entry of decoded.entries) {
    const rel = entry.path;
    if (rel.length > MAX_PATH_LENGTH) {
      throw new Error(`Rejected file path "${rel}"`);
    }
    if (rel.toLowerCase() === 'skill.md') {
      if (entry.content.length > MAX_SKILL_MARKDOWN_LENGTH) {
        throw new Error(`SKILL.md exceeds ${MAX_SKILL_MARKDOWN_LENGTH} bytes`);
      }
      skillMd = entry.content;
      continue;
    }
    if (!SKILL_FILE_PATH_PATTERN.test(rel)) {
      throw new Error(`File "${rel}" contains disallowed characters`);
    }

    if (entry.content.length > MAX_COMPANION_FILE_SIZE) {
      throw new Error(`File "${rel}" exceeds ${MAX_COMPANION_FILE_SIZE} bytes`);
    }
    fileCount += 1;
    totalBytes += entry.content.length;
    if (fileCount > MAX_COMPANION_FILES) {
      throw new Error(`Skill may have at most ${MAX_COMPANION_FILES} companion files`);
    }
    if (totalBytes > MAX_COMPANION_FILES_TOTAL) {
      throw new Error(`Companion files exceed ${MAX_COMPANION_FILES_TOTAL} bytes total`);
    }
    files[rel] = entry.content;
  }

  if (!skillMd) {
    throw new Error('Zip must contain SKILL.md at the root');
  }

  const frontmatter = parseSkillFrontmatter(skillMd);
  return {
    rawMarkdown: skillMd,
    files,
    fileCount,
    totalBytes,
    frontmatterName: frontmatter.name,
    frontmatterDescription: frontmatter.description,
  };
}
