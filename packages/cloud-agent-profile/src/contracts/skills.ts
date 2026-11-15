import * as z from 'zod';
import { locateFrontmatterBlock } from '../frontmatter-block';
import { overLimitMessage, overTotalMessage } from './limit-copy';
import { skillCompanionFileIssues } from './skill-companion-files';

export const MAX_PROFILE_SKILLS = 50;
export const MAX_SKILL_NAME_LENGTH = 100;
export const MAX_SKILL_MARKDOWN_LENGTH = 100_000;
export const MAX_SKILL_DESCRIPTION_LENGTH = 2000;
/** Companion-file limits for multi-file skills (SKILL.md itself is stored in raw_markdown). */
export const MAX_SKILL_COMPANION_FILES = 40;
export const MAX_SKILL_COMPANION_FILE_SIZE = 100_000;
export const MAX_SKILL_COMPANION_FILES_TOTAL = 500_000;
export const MAX_SKILL_COMPANION_PATH_LENGTH = 200;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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
export const skillFilesSchema = z.record(z.string(), z.string()).superRefine((files, ctx) => {
  skillCompanionFileIssues(
    files,
    {
      maxFiles: MAX_SKILL_COMPANION_FILES,
      maxFileSize: MAX_SKILL_COMPANION_FILE_SIZE,
      maxTotalSize: MAX_SKILL_COMPANION_FILES_TOTAL,
      pathLength: {
        max: MAX_SKILL_COMPANION_PATH_LENGTH,
        tooLong: path => `Invalid skill file path length: ${path.slice(0, 80)}`,
      },
      tooManyFiles: `Skill may have at most ${MAX_SKILL_COMPANION_FILES} companion files`,
      pathInvalidCharacters: path => `Skill file path contains invalid characters: ${path}`,
      pathRejected: path => `Skill file path rejected: ${path}`,
      manifestInFiles: 'SKILL.md must be supplied as rawMarkdown, not in files',
      fileTooLarge: path =>
        overLimitMessage(`Skill companion file ${path}`, MAX_SKILL_COMPANION_FILE_SIZE),
      totalTooLarge: total =>
        overTotalMessage('Skill companion files', total, MAX_SKILL_COMPANION_FILES_TOTAL),
    },
    message => ctx.addIssue({ code: 'custom', message })
  );
});

/** Input for creating a custom skill by pasting SKILL.md directly. */
export const skillCustomInputSchema = z.object({
  name: skillNameSchema,
  description: z.string().max(MAX_SKILL_DESCRIPTION_LENGTH).optional(),
  rawMarkdown: z
    .string()
    .min(1)
    .max(MAX_SKILL_MARKDOWN_LENGTH, overLimitMessage('Skill markdown', MAX_SKILL_MARKDOWN_LENGTH)),
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
    .max(MAX_SKILL_MARKDOWN_LENGTH, overLimitMessage('Skill markdown', MAX_SKILL_MARKDOWN_LENGTH))
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

/**
 * Extract YAML frontmatter `name` and `description` from SKILL.md.
 * Supports both --- and +++ delimiters. Returns `null` if no frontmatter.
 */
export function parseSkillFrontmatter(rawMarkdown: string): {
  name: string | null;
  description: string | null;
} {
  const located = locateFrontmatterBlock(rawMarkdown);
  if (located.status !== 'ok') {
    return { name: null, description: null };
  }

  const block = located.block;
  const name = getFrontmatterValue(block, 'name');
  const description = getFrontmatterValue(block, 'description');
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
