import * as z from 'zod';

export const MAX_PROFILE_SKILLS = 50;
export const MAX_SKILL_NAME_LENGTH = 100;
export const MAX_SKILL_MARKDOWN_LENGTH = 100_000; // ~100 KB
export const MAX_SKILL_DESCRIPTION_LENGTH = 2000;
/** Companion-file limits for multi-file skills (SKILL.md itself is stored in raw_markdown). */
export const MAX_SKILL_COMPANION_FILES = 40;
export const MAX_SKILL_COMPANION_FILE_SIZE = 100_000; // ~100 KB per file
export const MAX_SKILL_COMPANION_FILES_TOTAL = 500_000; // ~500 KB across all companion files
export const MAX_SKILL_COMPANION_PATH_LENGTH = 200;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SKILL_FILE_PATH_PATTERN = /^[a-zA-Z0-9._\-/]+$/;

export const skillNameSchema = z
  .string()
  .min(1)
  .max(MAX_SKILL_NAME_LENGTH)
  .regex(
    SKILL_NAME_PATTERN,
    'Skill name must be lowercase, start with a letter or digit, and contain only letters, digits, and dashes'
  );

/**
 * Validate a map of companion files. Keys are relative paths inside the skill
 * directory, values are the file contents. `SKILL.md` itself is stored in
 * `raw_markdown` and must not appear here.
 */
export const skillFilesSchema = z
  .record(z.string(), z.string())
  .refine(
    files => Object.keys(files).length <= MAX_SKILL_COMPANION_FILES,
    `Skill may have at most ${MAX_SKILL_COMPANION_FILES} companion files`
  )
  .superRefine((files, ctx) => {
    let total = 0;
    for (const [path, content] of Object.entries(files)) {
      if (path.length === 0 || path.length > MAX_SKILL_COMPANION_PATH_LENGTH) {
        ctx.addIssue({
          code: 'custom',
          message: `Invalid skill file path length: ${path.slice(0, 80)}`,
        });
        return;
      }
      if (!SKILL_FILE_PATH_PATTERN.test(path)) {
        ctx.addIssue({
          code: 'custom',
          message: `Skill file path contains invalid characters: ${path}`,
        });
        return;
      }
      if (path.startsWith('/') || path.includes('..') || path.includes('//')) {
        ctx.addIssue({ code: 'custom', message: `Skill file path rejected: ${path}` });
        return;
      }
      if (path === 'SKILL.md' || path.toLowerCase() === 'skill.md') {
        ctx.addIssue({
          code: 'custom',
          message: 'SKILL.md must be supplied as rawMarkdown, not in files',
        });
        return;
      }
      if (content.length > MAX_SKILL_COMPANION_FILE_SIZE) {
        ctx.addIssue({
          code: 'custom',
          message: `Skill companion file ${path} exceeds ${MAX_SKILL_COMPANION_FILE_SIZE} bytes`,
        });
        return;
      }
      total += content.length;
    }
    if (total > MAX_SKILL_COMPANION_FILES_TOTAL) {
      ctx.addIssue({
        code: 'custom',
        message: `Skill companion files total ${total} bytes, exceeds ${MAX_SKILL_COMPANION_FILES_TOTAL}`,
      });
    }
  });

/** Input for creating a custom skill by pasting SKILL.md directly. */
export const skillCustomInputSchema = z.object({
  name: skillNameSchema,
  description: z.string().max(MAX_SKILL_DESCRIPTION_LENGTH).optional(),
  rawMarkdown: z
    .string()
    .min(1)
    .max(MAX_SKILL_MARKDOWN_LENGTH, `Skill markdown exceeds ${MAX_SKILL_MARKDOWN_LENGTH} bytes`),
  files: skillFilesSchema.optional(),
  enabled: z.boolean().optional(),
});

/** Input for updating a skill. */
export const skillUpdateInputSchema = z.object({
  name: skillNameSchema.optional(),
  description: z.string().max(MAX_SKILL_DESCRIPTION_LENGTH).nullable().optional(),
  rawMarkdown: z
    .string()
    .min(1)
    .max(MAX_SKILL_MARKDOWN_LENGTH, `Skill markdown exceeds ${MAX_SKILL_MARKDOWN_LENGTH} bytes`)
    .optional(),
  files: skillFilesSchema.optional(),
  enabled: z.boolean().optional(),
});

export type SkillCustomInput = z.infer<typeof skillCustomInputSchema>;
export type SkillUpdateInput = z.infer<typeof skillUpdateInputSchema>;

function getFrontmatterValue(frontmatter: string, key: string): string | null {
  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith(key)) {
      continue;
    }

    let index = key.length;
    while (line[index] === ' ' || line[index] === '\t') {
      index += 1;
    }
    if (line[index] !== ':') {
      continue;
    }

    index += 1;
    const valueStart = index;
    while (line[index] === ' ' || line[index] === '\t') {
      index += 1;
    }
    if (index >= line.length) {
      if (valueStart < line.length) {
        return '';
      }
      continue;
    }

    return line.slice(index);
  }

  return null;
}

function isFrontmatterDelimiterLine(line: string): boolean {
  if (!line.startsWith('---')) {
    return false;
  }

  for (let index = 3; index < line.length; index += 1) {
    const char = line[index];
    if (char !== ' ' && char !== '\t') {
      return false;
    }
  }

  return true;
}

/**
 * Extract YAML frontmatter `name` and `description` from SKILL.md.
 * Supports both --- and +++ delimiters. Returns `null` if no frontmatter.
 */
export function parseSkillFrontmatter(rawMarkdown: string): {
  name: string | null;
  description: string | null;
} {
  const firstLineEnd = rawMarkdown.indexOf('\n');
  if (firstLineEnd === -1) {
    return { name: null, description: null };
  }

  const firstRawLine = rawMarkdown.slice(0, firstLineEnd);
  const firstLine = firstRawLine.endsWith('\r') ? firstRawLine.slice(0, -1) : firstRawLine;
  if (!isFrontmatterDelimiterLine(firstLine)) {
    return { name: null, description: null };
  }

  let lineStart = firstLineEnd + 1;
  let frontmatterEnd: number | null = null;
  while (lineStart < rawMarkdown.length) {
    const lineEnd = rawMarkdown.indexOf('\n', lineStart);
    if (lineEnd === -1) {
      break;
    }

    const rawLine = rawMarkdown.slice(lineStart, lineEnd);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (isFrontmatterDelimiterLine(line)) {
      frontmatterEnd =
        lineStart > 0 && rawMarkdown[lineStart - 1] === '\r' ? lineStart - 1 : lineStart;
      break;
    }

    lineStart = lineEnd + 1;
  }

  if (frontmatterEnd === null) {
    return { name: null, description: null };
  }

  const frontmatter = rawMarkdown.slice(firstLineEnd + 1, frontmatterEnd);
  const name = getFrontmatterValue(frontmatter, 'name');
  const description = getFrontmatterValue(frontmatter, 'description');
  const stripQuotes = (v: string): string => {
    const trimmed = v.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  };
  return {
    name: name === null ? null : stripQuotes(name),
    description: description === null ? null : stripQuotes(description),
  };
}
